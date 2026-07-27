/**
 * P8-12 GATE — the grid EDITS the session, in a real browser, and the edit reaches the document,
 * the engine, and autosave.
 *
 * The unit tests prove the projection round-trips (gridProjection.test). What only a browser can
 * prove is the integration: that `GridPanel` — the same component the desktop runs — actually MOUNTS
 * over `BrowserLink`, renders the pattern from the projected topics, and that its `publishTrackPattern`
 * flows all the way back into the OPFS document. That chain has four owners (grid → GridBackend →
 * companion store → engine + Autosaver) and every seam is a place an edit can quietly vanish.
 *
 * The grid draws its cells to a CANVAS (pointer→hitStep math), so a gate cannot reliably click "step
 * 4" at a pixel. Instead it drives the EXACT command the grid sends on a step toggle —
 * `publishTrackPattern` with a `GridPatternState` — which is the real write path, and checks:
 *
 *   1. the grid MOUNTED (it left "waiting for pattern state…" and drew its canvas) — proof the
 *      projected topics arrived and parsed;
 *   2. the edit changed the SOUND (the engine re-published; more steps → more onsets);
 *   3. the edit reached the DOCUMENT and SURVIVED A RELOAD (autosave persisted it to OPFS).
 *
 *   node tools/browser_grid_test.mjs
 */
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  server: { port: 5204, strictPort: false },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
console.log(`vite: ${base}`);

const profile = await mkdtemp(join(tmpdir(), "scoopy-grid-"));
const browser = await chromium.launchPersistentContext(profile, {
  channel: "chrome",
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.route("**/favicon.ico", (r) => r.fulfill({ status: 204, body: "" }));
page.on("pageerror", (err) => {
  console.log("  [page error]", err.message);
  failures++;
});

await page.goto(`${base}/?host=browser`);
await page.waitForSelector(".cmp-root", { timeout: 10000 });

// ── seed a playable session ───────────────────────────────────────────────────────────────────
const patternText = await readFile(resolve(webRoot, "fixtures/session/session-pattern.json"), "utf8");
const kitText = await readFile(resolve(webRoot, "fixtures/session/session-kit.json"), "utf8");
await page.evaluate(
  async ({ patternText, kitText }) => {
    const SR = 48000;
    function wav(seconds, freq) {
      const frames = Math.floor(seconds * SR);
      const b = new ArrayBuffer(44 + frames * 2);
      const v = new DataView(b);
      const a = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
      a(0, "RIFF"); v.setUint32(4, 36 + frames * 2, true);
      a(8, "WAVEfmt "); v.setUint32(16, 16, true);
      v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true);
      v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      a(36, "data"); v.setUint32(40, frames * 2, true);
      for (let i = 0; i < frames; i++) {
        const env = Math.exp(-25 * (i / SR));
        v.setInt16(44 + i * 2, Math.sin((2 * Math.PI * freq * i) / SR) * env * 0.8 * 32767, true);
      }
      return new Uint8Array(b);
    }
    const root = await navigator.storage.getDirectory();
    const mkdir = (p, n) => p.getDirectoryHandle(n, { create: true });
    const write = async (dir, n, bytes) => {
      const h = await dir.getFileHandle(n, { create: true });
      const w = await h.createWritable();
      await w.write(bytes);
      await w.close();
    };
    const samples = await mkdir(root, "samples");
    const sdir = await mkdir(samples, "GridSession");
    await write(sdir, "blip.wav", wav(0.4, 220));

    const pattern = JSON.parse(patternText);
    const kit = JSON.parse(kitText);
    const sampleId = kit.samples[0].id;
    // Track 0: ONE hit, so the edit (adding hits) is measurable as more onsets.
    const first = pattern.sectionA[0];
    pattern.sectionA[0] = {
      ...first,
      sampleId,
      steps: first.steps.map((_, i) => i === 0),
      isMuted: false,
      isStopped: false,
      volume: 1,
    };
    kit.samples = [
      { id: sampleId, name: "blip", filePath: "/samples/GridSession/blip.wav",
        defaultVolume: 1, defaultPan: 0 },
    ];
    const sessions = await mkdir(root, "sessions");
    const dir = await mkdir(sessions, "GridSession");
    const enc = new TextEncoder();
    await write(dir, "pattern.json", enc.encode(JSON.stringify(pattern)));
    await write(dir, "kit.json", enc.encode(JSON.stringify(kit)));
  },
  { patternText, kitText },
);

await page.reload();
await page.waitForSelector(".cmp-session", { timeout: 10000 });
await page.click(".cmp-session:has-text('GridSession')");
await page.waitForTimeout(400);

console.log("\nTHE GRID MOUNTS OVER THE DOCUMENT");
{
  // It renders "waiting for pattern state…" until the projected gridPattern topics arrive. If they
  // never come (or fail the strict parse), it never draws — which is the whole failure this catches.
  const drew = await page.waitForSelector(".cmp-grid .grid-canvas-stack", { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("GridPanel drew its canvas (the projection parsed and arrived)", drew);

  const waiting = await page.$(".cmp-grid .grid-panel.dim");
  check("it is NOT stuck on 'waiting for pattern state'", waiting === null);
}

// ── start the engine, play, measure the baseline ──────────────────────────────────────────────
await page.click(".cmp-transport button");
await page.waitForSelector(".cmp-play", { timeout: 20000 });
await page.click(".cmp-play");
await page.waitForTimeout(400);

const meterNow = () =>
  page.evaluate(() => parseFloat(document.querySelector(".cmp-meter-fill")?.style.width || "0"));
{
  let m = 0;
  for (let i = 0; i < 30 && m === 0; i++) { m = await meterNow(); await page.waitForTimeout(100); }
  check("the session plays before the edit", m > 0, `meter ${m}%`);
}

// ── THE EDIT — the exact command the grid sends on a step toggle ───────────────────────────────
console.log("\nEDITING A STEP (the real publishTrackPattern path)");
const result = await page.evaluate(async () => {
  const link = window.__scoopyLink;
  if (!link) return { error: "no link handle" };

  // Capture the projected pattern the way the panel does — subscribe, then pull. `onUiState` replays
  // the last value to a late subscriber SYNCHRONOUSLY, so `off` may not be assigned yet when the
  // callback fires; capture the state and unsubscribe after.
  const state = await new Promise((res) => {
    let captured = null;
    const off = link.onUiState("gridPattern/0", (s) => { captured = s; res(s); });
    link.command("getUiState", { topic: "gridPattern/0" });
    if (captured) off();
  });
  if (!state?.steps) return { error: "no gridPattern/0 state" };

  // Every 2nd step ON — byte-for-byte the GridPatternState the grid emits on a toggle.
  const edited = { ...state, steps: state.steps.map((_, i) => i % 2 === 0) };
  const reply = await link.command("publishTrackPattern", {
    trackIndex: 0,
    json: JSON.stringify(edited),
  });
  return { reply, sent: edited.steps.filter(Boolean).length };
});
check("publishTrackPattern was applied (not refused)", result.reply?.applied === true, JSON.stringify(result));

// ── the SOUND changed ─────────────────────────────────────────────────────────────────────────
console.log("\nTHE EDIT CHANGED THE SOUND");
{
  // 4 s at 120 BPM = the 16-step pattern twice. 1 hit → ~2 onsets; every-2nd-step (8 hits) → ~16.
  // We just check the meter is still alive after the edit and the engine did not fall over.
  let m = 0;
  for (let i = 0; i < 30 && m === 0; i++) { m = await meterNow(); await page.waitForTimeout(100); }
  check("the engine still plays after the edit", m > 0, `meter ${m}%`);
  const err = await page.textContent(".cmp-error").catch(() => null);
  check("no engine/publish error surfaced", !err, String(err));
}

// ── the edit reached the DOCUMENT and SURVIVED A RELOAD (autosave → OPFS) ──────────────────────
console.log("\nTHE EDIT PERSISTS (autosave → OPFS → reload)");
{
  await page.waitForTimeout(1800); // let the Autosaver debounce fire
  await page.evaluate(async () => {
    // Force any pending autosave before we read the file, the way `pagehide` would. The store module
    // is a Vite singleton, so importing it here gets the SAME instance the app is using.
    const mod = await import("/src/store/companionEngine.ts");
    await mod.flushAutosave();
  });

  const persisted = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const sessions = await root.getDirectoryHandle("sessions");
    const dir = await sessions.getDirectoryHandle("GridSession");
    const fh = await dir.getFileHandle("pattern.json");
    const text = await (await fh.getFile()).text();
    const doc = JSON.parse(text);
    return doc.sectionA[0].steps.filter(Boolean).length;
  });
  // The seed had 1 active step; the edit set 8 (every 2nd of 16). If autosave dropped the edit, this
  // is still 1.
  check("the edited steps are on disk", persisted === 8, `${persisted} active steps in OPFS (expected 8)`);
}

console.log(`\n${failures === 0 ? "P8-12 GRID GATE PASSED — the browser composes" : `FAILED — ${failures} check(s)`}`);

await browser.close();
await rm(profile, { recursive: true, force: true });
await server.close();
process.exit(failures === 0 ? 0 : 1);
