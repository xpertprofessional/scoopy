/**
 * P8-2 gate — does the AudioWorklet SHELL actually work in a real browser?
 *
 * Everything up to now was proven outside a browser: the engine renders identically in WASM
 * (null test, −153 dBFS) and JavaScript drives it across the C ABI and makes sound (wasm_smoke,
 * under node). What that could NOT prove is the worklet itself — whether the module loads in
 * worklet scope, whether `process()` is called correctly, whether the heap-growth view-detach trap
 * bites. Those only exist inside a browser.
 *
 * So: headless Chromium + `OfflineAudioContext`, which runs a real AudioWorklet and renders to a
 * buffer faster than realtime. No speakers, no clicking, no hand-waving.
 *
 * And it does not merely check for sound — it renders the SAME scene the node harness did and
 * NULL-TESTS the two. Same engine, same C ABI calls, same 128-frame quantum. If they diverge, the
 * AudioWorklet shell is the only thing that can be at fault.
 *
 *   node tools/browser_worklet_test.mjs
 */
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openEngine } from "./lib/engines.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const audioDir = resolve(here, "../src/audio");
const SR = 48000;
const SECONDS = 4;

// ── serve web/src/audio over http (ES module imports do not work from file://) ────────────────
const TYPES = { ".js": "text/javascript", ".mjs": "text/javascript", ".html": "text/html" };
const server = createServer(async (req, res) => {
  try {
    const url = (req.url ?? "/").split("?")[0];
    if (url === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><meta charset=utf-8><title>scoopy worklet</title>");
      return;
    }
    const body = await readFile(join(audioDir, url));
    res.writeHead(200, { "content-type": TYPES[extname(url)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    console.log("  [server] 404:", req.url);
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

// Use the SYSTEM Chrome rather than downloading a browser: it is already here, and testing the
// worklet in the browser people actually use is more honest than testing it in a pinned build.
const { browser, cleanup } = await openEngine()
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (!t.startsWith("[verbose]")) console.log("  [browser]", t);
});
page.on("pageerror", (e) => console.log("  [browser error]", e.message));

await page.goto(base);

const result = await page.evaluate(async ({ base, SR, SECONDS }) => {
  const QUANTUM = 128;
  const frames = SR * SECONDS;

  // OfflineAudioContext runs a REAL AudioWorklet — same code path as playback, no device.
  const ctx = new OfflineAudioContext({ numberOfChannels: 2, length: frames, sampleRate: SR });
  await ctx.audioWorklet.addModule(`${base}/scoopy-worklet.js`);

  const node = new AudioWorkletNode(ctx, "scoopy-engine", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { sampleRate: SR },
  });

  // Track acks: an OfflineAudioContext renders FASTER than postMessage delivers, so the render
  // would otherwise finish before the engine ever heard about the kit — four seconds of confident
  // silence, and a test that "passes" nothing.
  const dbg = [];
  const acked = new Set();
  let onAck = () => {};
  const ready = new Promise((res, rej) => {
    node.port.onmessage = (e) => {
      const d = e.data;
      if (d?.type === "ready") res();
      else if (d?.type === "error") rej(new Error(d.error));
      else if (d?.type === "ack") { acked.add(d.for); onAck(); }
      else if (d?.type === "dbg") dbg.push(d);
    };
  });
  const waitFor = (what) => new Promise((res) => {
    if (acked.has(what)) return res();
    onAck = () => { if (acked.has(what)) res(); };
  });
  // ⚠️ A throw inside `process()` does NOT surface as a console error or a page error: Chrome kills
  // the processor SILENTLY and the node outputs zeros forever. `onprocessorerror` is the only place
  // it appears, and without hooking it a broken worklet is indistinguishable from a silent one.
  const procErrors = [];
  node.onprocessorerror = (e) => procErrors.push(String(e?.message ?? e ?? "processor error"));

  node.connect(ctx.destination);
  await ready;

  // EXACTLY the scene wasm_smoke.mjs rendered — same PRNG, same envelope, same world.
  const burst = new Float32Array(SR);
  let x = 0x12345678 >>> 0;
  for (let i = 0; i < burst.length; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    burst[i] = ((x | 0) / 2147483648) * Math.exp(-6 * (i / SR)) * 0.6;
  }
  node.port.postMessage({ type: "sample", id: "burst", left: burst, sampleRate: SR });

  const steps = new Uint8Array(16);
  steps[0] = 1; steps[4] = 1; steps[8] = 1; steps[12] = 1;
  node.port.postMessage({
    type: "world",
    bpm: 120, isPlaying: true, startStep: 0,
    tracks: [{
      sampleId: "burst", steps,
      volume: 0.9, pan: 0, tone: -30, toneQ: 0.8,
      send1Level: 0.3, send2Level: 0, muted: false, reversed: false, polyphonic: false,
    }],
  });

  await waitFor("sample");
  await waitFor("world");

  const rendered = await ctx.startRendering();
  const L = rendered.getChannelData(0);
  const R = rendered.getChannelData(1);

  const inter = new Float32Array(frames * 2);
  let peak = 0, energy = 0, nonSilentBlocks = 0;
  for (let i = 0; i < frames; i++) {
    inter[i * 2] = L[i];
    inter[i * 2 + 1] = R[i];
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
    energy += L[i] * L[i] + R[i] * R[i];
  }
  for (let b = 0; b < frames / QUANTUM; b++) {
    let bp = 0;
    for (let i = 0; i < QUANTUM; i++) {
      const j = b * QUANTUM + i;
      bp = Math.max(bp, Math.abs(L[j]), Math.abs(R[j]));
    }
    if (bp > 1e-4) nonSilentBlocks++;
  }

  return {
    procErrors,
    dbg,
    peak,
    rms: Math.sqrt(energy / (frames * 2)),
    nonSilentBlocks,
    totalBlocks: frames / QUANTUM,
    samples: Array.from(inter),
  };
}, { base, SR, SECONDS });

await cleanup();
server.close();

if (result.procErrors?.length) console.log("PROCESSOR ERRORS:", result.procErrors);
console.log("worklet debug:", JSON.stringify(result.dbg, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
console.log(`\nbrowser: peak=${result.peak.toFixed(6)} rms=${result.rms.toFixed(6)}`);
console.log(`non-silent blocks: ${result.nonSilentBlocks}/${result.totalBlocks}`);

// The one way this could lie: a silent render nulls perfectly against anything.
if (result.peak < 1e-3) {
  console.error("\nFAIL: the AudioWorklet rendered SILENCE in the browser.");
  process.exit(1);
}

await writeFile("/tmp/browser.f32", Buffer.from(new Float32Array(result.samples).buffer));
console.log("wrote /tmp/browser.f32  ->  null-test it against /tmp/node_wasm.f32");
console.log("\nPASS — a real AudioWorklet, in a real browser, played the engine.");
