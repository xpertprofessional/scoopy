/**
 * P8-2 — does the JS → WASM audio path actually make sound?
 *
 * The null test (P8-3b) proved the ENGINE renders identically in WASM. It did that by calling C++
 * from C++. This proves the other half: that JavaScript can drive it across the C ABI — create,
 * configure, register a sample, publish a world, and pull audio out a 128-frame quantum at a time,
 * exactly as an AudioWorklet will.
 *
 * If this makes sound, the only thing between here and a browser playing the session is the
 * AudioWorklet shell — no engine work left.
 *
 *   node tools/wasm_smoke.mjs
 */
import createScoopyEngine from "../build-wasm/scoopy-engine.js";

const SR = 48000;
const QUANTUM = 128; // the AudioWorklet's fixed block — render as the browser will, not "close to"

const M = await createScoopyEngine();

// ── the ABI ───────────────────────────────────────────────────────────────────────────────────
const abi = M.ccall("sl_engine_abi_version", "number", [], []);
if (abi !== 1) throw new Error(`ABI mismatch: got ${abi}`);

const create = M.cwrap("sl_engine_create", "number", []);
const configure = M.cwrap("sl_engine_configure", "number", ["number", "number", "number"]);
const start = M.cwrap("sl_engine_start", "number", ["number"]);
const registerSample = M.cwrap("sl_engine_register_sample", "number",
  ["number", "string", "number", "number", "number", "number"]);
const snapBegin = M.cwrap("sl_snapshot_begin", null, ["number", "number", "number", "number"]);
const snapAddTrack = M.cwrap("sl_snapshot_add_track", null,
  ["number", "string", "number", "number", "number",
   "number", "number", "number", "number", "number", "number",
   "number", "number", "number"]);
const snapCommit = M.cwrap("sl_snapshot_commit", "number", ["number"]);
const render = M.cwrap("sl_render", null, ["number", "number", "number", "number"]);

const eng = create();
if (!eng) throw new Error("sl_engine_create failed");
if (!configure(eng, SR, QUANTUM)) throw new Error("configure failed");
if (!start(eng)) throw new Error("start failed");

// ── a sample: a short decaying noise burst (something with actual energy to hear) ─────────────
const burstFrames = SR; // 1 s
const burstPtr = M._malloc(burstFrames * 4);
{
  const view = new Float32Array(M.HEAPF32.buffer, burstPtr, burstFrames);
  let x = 0x12345678 >>> 0;
  for (let i = 0; i < burstFrames; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    const rnd = ((x | 0) / 2147483648);
    view[i] = rnd * Math.exp(-6 * (i / SR)) * 0.6;
  }
}
if (!registerSample(eng, "burst", burstPtr, 0, burstFrames, SR)) throw new Error("registerSample failed");
M._free(burstPtr); // the engine COPIES — releasing here is the point of that contract

// ── a world: one track, four-on-the-floor ─────────────────────────────────────────────────────
const STEPS = 16;
const stepsPtr = M._malloc(STEPS);
{
  const s = new Uint8Array(M.HEAPU8.buffer, stepsPtr, STEPS);
  s.fill(0);
  s[0] = 1; s[4] = 1; s[8] = 1; s[12] = 1;
}
snapBegin(eng, 120.0, 1 /* playing */, 0);
snapAddTrack(eng, "burst", stepsPtr, STEPS, 0 /* pitchOffsets = NULL */,
  0.9 /* volume */, 0.0 /* pan */, -30.0 /* tone */, 0.8 /* toneQ */,
  0.3 /* send1 */, 0.0 /* send2 */, 0 /* muted */, 0 /* reversed */, 0 /* poly */);
snapCommit(eng);
M._free(stepsPtr);

// ── render 4 seconds, a quantum at a time, exactly as the worklet will ────────────────────────
const lPtr = M._malloc(QUANTUM * 4);
const rPtr = M._malloc(QUANTUM * 4);
const blocks = Math.floor((SR * 4) / QUANTUM);

// Dumped so the BROWSER's render can be null-tested against this one (browser_worklet_test.mjs).
// Same engine, same API calls, same quantum — if the two diverge, the AudioWorklet SHELL is at
// fault, and nothing else can be.
const dump = new Float32Array(blocks * QUANTUM * 2);

let peak = 0;
let energy = 0;
let nonSilentBlocks = 0;
for (let b = 0; b < blocks; b++) {
  render(eng, lPtr, rPtr, QUANTUM);
  const L = new Float32Array(M.HEAPF32.buffer, lPtr, QUANTUM);
  const R = new Float32Array(M.HEAPF32.buffer, rPtr, QUANTUM);
  for (let i = 0; i < QUANTUM; i++) {
    dump[(b * QUANTUM + i) * 2] = L[i];
    dump[(b * QUANTUM + i) * 2 + 1] = R[i];
  }
  let blockPeak = 0;
  for (let i = 0; i < QUANTUM; i++) {
    const a = Math.abs(L[i]), c = Math.abs(R[i]);
    if (a > blockPeak) blockPeak = a;
    if (c > blockPeak) blockPeak = c;
    energy += L[i] * L[i] + R[i] * R[i];
  }
  if (blockPeak > 1e-4) nonSilentBlocks++;
  if (blockPeak > peak) peak = blockPeak;
}
M._free(lPtr); M._free(rPtr);

const { writeFileSync } = await import("node:fs");
writeFileSync("/tmp/node_wasm.f32", Buffer.from(dump.buffer));

const rms = Math.sqrt(energy / (blocks * QUANTUM * 2));
console.log(`blocks=${blocks} (${QUANTUM} frames each)  peak=${peak.toFixed(6)}  rms=${rms.toFixed(6)}`);
console.log(`non-silent blocks: ${nonSilentBlocks}/${blocks}`);

// A silent render would "pass" any check that only looks for absence of errors. Demand SOUND.
if (peak < 1e-3) {
  console.error("FAIL: the engine rendered silence — JS drove it, but nothing came out");
  process.exit(1);
}
// Four-on-the-floor at 120 BPM over 4 s = 8 hits. If only a couple of blocks have energy, the
// sequencer is not actually running — it just leaked one buffer of the sample.
if (nonSilentBlocks < blocks / 4) {
  console.error(`FAIL: only ${nonSilentBlocks} blocks had energy — the sequencer is not running`);
  process.exit(1);
}
console.log("\nPASS — JavaScript drove the C++ engine across the C ABI and it made sound.");
