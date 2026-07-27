/**
 * THE COMPANION MAKES A SOUND — the gate for the browser's audio path, end to end.
 *
 * Every piece of this existed and none of them touched. P8-1/P8-2 put the engine in WASM behind a
 * real AudioWorklet, bit-identical to native. P8-0/P8-6 put sessions and their samples in OPFS. And
 * in between: **nothing had ever instantiated `ScoopyAudio`**, and no code anywhere turned a session
 * document into the engine's `World`. The companion could open a session, browse its samples and
 * audition them one by one — and could not play the session.
 *
 * This drives the whole chain, in a real browser, with no Swift anywhere:
 *
 *   OPFS session (.scoopySession round-trip)
 *     → openSession()            → { pattern: PatternFileJson, kit: KitJson }
 *     → SampleStore.registerKit  → decode from OPFS → registerSample(uuid) over the C ABI
 *     → worldFromSession()       → sectionA + kit    → World
 *     → ScoopyAudio.publish()    → the AudioWorklet  → the WASM engine
 *     → OfflineAudioContext      → REAL SAMPLES, asserted
 *
 * Offline rather than live: an OfflineAudioContext runs a REAL AudioWorklet (same code path, same
 * 128-frame quantum) faster than realtime and renders to a buffer you can actually assert on. A live
 * context in a headless browser is a timing race, and "did it make a sound" deserves a hard answer.
 *
 * ⚠️ The scene is built here rather than taken from the fixture, and that is not laziness: the P8-0
 * fixture session is NOT PLAYABLE. Its 8 `sectionA` tracks carry no `sampleId` at all and its kit's
 * two samples are referenced by nothing — it was built to prove byte-identity, where the
 * track↔sample binding never mattered. So we take its real document (real field names, real shape,
 * written by Swift) and bind it to a real, decodable WAV.
 *
 *   node tools/browser_companion_audio_test.mjs
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  root: webRoot,
  logLevel: "warn",
  server: { port: 5201, strictPort: false },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
console.log(`vite: ${base}`);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
await page.route("**/favicon.ico", (r) => r.fulfill({ status: 204, body: "" }));
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [browser error]", m.text());
});
page.on("pageerror", (err) => {
  console.log("  [page error]", err.message);
  failures++;
});

await page.goto(`${base}/?host=browser&panel=filebrowser`);

const patternText = await readFile(resolve(webRoot, "fixtures/session/session-pattern.json"), "utf8");
const kitText = await readFile(resolve(webRoot, "fixtures/session/session-kit.json"), "utf8");

const result = await page.evaluate(
  async ({ patternText, kitText }) => {
    const SR = 48000;
    const SECONDS = 4;

    const opfs = await import("/src/store/opfs.ts");
    const { SampleStore } = await import("/src/store/sampleStore.ts");
    const sessions = await import("/src/store/sessionStore.ts");
    const { decodeKit } = await import("/src/persist/kit.ts");
    const { decodePatternFileAnyVersion } = await import("/src/persist/migrations.ts");
    const { worldFromSession } = await import("/src/audio/worldFromSession.ts");
    const { ScoopyAudio } = await import("/src/audio/scoopyAudio.ts");

    /** A real, decodable 16-bit PCM WAV — a 220 Hz sine. */
    function wav(seconds, freq, sampleRate = SR) {
      const frames = Math.floor(seconds * sampleRate);
      const buffer = new ArrayBuffer(44 + frames * 2);
      const view = new DataView(buffer);
      const ascii = (o, t) => { for (let i = 0; i < t.length; i++) view.setUint8(o + i, t.charCodeAt(i)); };
      ascii(0, "RIFF"); view.setUint32(4, 36 + frames * 2, true);
      ascii(8, "WAVEfmt "); view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      ascii(36, "data"); view.setUint32(40, frames * 2, true);
      for (let i = 0; i < frames; i++) {
        // A SHARPLY decaying blip. The decay rate is load-bearing: at 120 BPM a 16th step is 125 ms
        // and the hits land every 4 steps (500 ms), so the tail must be well dead by then or the
        // hits smear into a drone and "did the sequencer run" becomes unanswerable.
        const env = Math.exp(-25 * (i / sampleRate));
        view.setInt16(44 + i * 2, Math.sin((2 * Math.PI * freq * i) / sampleRate) * env * 0.8 * 32767, true);
      }
      return new Uint8Array(buffer);
    }

    // ── build a PLAYABLE session in OPFS, out of Swift's real document ──────────────────────────
    const pattern = decodePatternFileAnyVersion(patternText);
    const kit = decodeKit(kitText);

    await opfs.ensureDir("/samples/AudioDemo");
    await opfs.writeFile("/samples/AudioDemo/blip.wav", wav(0.4, 220));

    const sampleId = kit.samples[0].id;
    const boundKit = {
      ...kit,
      samples: [
        { id: sampleId, name: "blip", filePath: "/samples/AudioDemo/blip.wav",
          defaultVolume: 1, defaultPan: 0 },
      ],
    };

    const first = pattern.sectionA[0];
    const steps = first.steps.map((_, i) => i % 4 === 0); // a hit every 4 steps
    const boundPattern = {
      ...pattern,
      sectionA: [
        { ...first, sampleId, steps, isMuted: false, isStopped: false, volume: 1 },
        ...pattern.sectionA.slice(1),
      ],
    };

    await sessions.saveSession({
      name: "AudioDemo", pattern: boundPattern, kit: boundKit, extras: new Map(),
    });

    // ── and now open it back out of OPFS, exactly as a reload would ─────────────────────────────
    const session = await sessions.openSession("AudioDemo");

    const store = new SampleStore();
    const audio = new ScoopyAudio();

    const ctx = new OfflineAudioContext({
      numberOfChannels: 2, length: SR * SECONDS, sampleRate: SR,
    });
    await audio.start("/src/audio/scoopy-worklet.js", ctx);

    const { registered, failures: sampleFailures } = await store.registerKit(session.kit, audio);
    const { world, missingSamples } = worldFromSession(session.pattern, session.kit);
    audio.publish(world);

    // Without this the offline render finishes before postMessage delivers, and the result is four
    // seconds of confident silence that looks exactly like a broken engine.
    await audio.flush();

    const rendered = await ctx.startRendering();
    const L = rendered.getChannelData(0);
    const R = rendered.getChannelData(1);

    let peak = 0;
    let sum = 0;
    let nonZero = 0;
    for (let i = 0; i < L.length; i++) {
      peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      sum += L[i] * L[i] + R[i] * R[i];
      if (L[i] !== 0 || R[i] !== 0) nonZero++;
    }
    const rms = Math.sqrt(sum / (L.length * 2));

    // Count the ONSETS — a drone would sail through a peak check; a SEQUENCER must produce distinct
    // hits, and that is the claim under test.
    //
    // ⚠️ ON AN ENVELOPE, NOT ON RAW SAMPLES. The first version of this thresholded |L[i]| directly
    // and reported 1000 onsets: a 220 Hz sine crosses any threshold twice per cycle, so it was
    // faithfully counting ZERO CROSSINGS — 220 × 4 s ≈ 880 — and calling them notes. The waveform
    // must be rectified and smoothed into an envelope first; only then does "a hit" exist as a
    // thing you can count.
    const WINDOW = 256; // ~5 ms at 48k — well below a 125 ms step, well above a 220 Hz period
    const envelope = [];
    for (let i = 0; i < L.length; i += WINDOW) {
      let m = 0;
      for (let j = i; j < Math.min(i + WINDOW, L.length); j++) m = Math.max(m, Math.abs(L[j]));
      envelope.push(m);
    }
    let onsets = 0;
    let quiet = true;
    for (const e of envelope) {
      if (quiet && e > 0.1) { onsets++; quiet = false; }
      else if (!quiet && e < 0.03) quiet = true;
    }

    return {
      registered,
      sampleFailures,
      missingSamples,
      worldTracks: world.tracks.length,
      bpm: world.bpm,
      stepCount: world.tracks[0]?.steps.length ?? 0,
      engineError: audio.error,
      sampleRate: audio.sampleRate,
      peak, rms, nonZero, onsets,
      totalFrames: L.length,
    };
  },
  { patternText, kitText },
);

console.log("\nSESSION → ENGINE");
check("the kit's sample decoded out of OPFS and reached the engine",
  result.registered === 1, `registered=${result.registered}, failures=${JSON.stringify(result.sampleFailures)}`);
check("the document converted to a World (sectionA, bound to the kit)",
  result.worldTracks === 1 && result.missingSamples.length === 0,
  `tracks=${result.worldTracks} bpm=${result.bpm} steps=${result.stepCount}`);
check("the AudioWorklet processor survived", result.engineError === null, String(result.engineError));
check("the engine ran at the context's rate", result.sampleRate === 48000, String(result.sampleRate));

console.log("\nDID IT MAKE A SOUND?");
check("the render is NOT silent", result.peak > 0.01,
  `peak=${result.peak.toFixed(4)} rms=${result.rms.toFixed(5)}`);
check("audio actually fills the buffer", result.nonZero > result.totalFrames * 0.1,
  `${result.nonZero}/${result.totalFrames} non-zero frames`);
// 4 s at 120 BPM = 8 bars of 16ths = 32 steps; a hit every 4th step = 8 onsets. A drone, a click or
// one stuck voice would all fail this — it is the difference between "makes noise" and "sequences".
check("the SEQUENCER ran — distinct hits, not a drone", result.onsets >= 6 && result.onsets <= 10,
  `${result.onsets} onsets (expected ~8)`);

console.log(`\n${failures === 0 ? "COMPANION AUDIO GATE PASSED" : `FAILED — ${failures} check(s)`}`);

await browser.close();
await server.close();
process.exit(failures === 0 ? 0 : 1);
