/**
 * THE SHIP GATE — the companion, from the PRODUCTION BUILD, in a real browser.
 *
 * Every other browser gate here runs against the **vite dev server**. That is not a detail, it is a
 * blind spot, and it hid a bug that would have shipped a mute app:
 *
 *   `companionEngine.ts` asks for the worklet with `new URL("../audio/scoopy-worklet.js",
 *   import.meta.url)`. Vite honours that by copying the file into `assets/` VERBATIM — it does not
 *   follow its imports. And the worklet's first line is
 *
 *       import createScoopyEngine from "./scoopy-engine.js";
 *
 *   …the 369 KB generated WASM module, which vite therefore never emitted. In production
 *   `addModule()` rejects, the engine never boots, and the companion is silently mute. In DEV it all
 *   works, because the dev server happily serves `/src/audio/scoopy-engine.js` on request.
 *
 * Same shape as the ABI bug, one layer up: **the thing you ship was never the thing you tested.**
 * So this gate builds the app the way a release does, serves the output as a dumb static directory
 * (no vite, no transforms, no module graph — exactly what a CDN would do), and drives it.
 *
 * It also refuses to run against a stale `dist/`: it builds into a fresh temp dir every time. A gate
 * that can pass against yesterday's artefact is not a gate.
 *
 * CROSS-BROWSER, because the companion ships to a browser and not to Chrome. Safari and Firefox are
 * where the interesting failures live: OPFS, `AudioWorklet`, WASM compilation in a worklet scope and
 * `decodeAudioData` all have real differences there. Chrome-only evidence is not shipping evidence.
 *
 *   node tools/browser_prod_test.mjs            # all three
 *   node tools/browser_prod_test.mjs chromium   # one
 */
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { zipSync } from "fflate";
import { chromium, firefox, webkit } from "playwright";
import { build } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── build it, the way a release does ──────────────────────────────────────────────────────────
const outDir = await mkdtemp(join(tmpdir(), "scoopy-prod-"));
console.log(`building → ${outDir}`);
await build({
  root: webRoot,
  configFile: resolve(webRoot, "vite.config.ts"),
  logLevel: "warn",
  build: { outDir, emptyOutDir: true, sourcemap: false },
});

// ── serve it as a dumb static directory. No bundler in the loop. ──────────────────────────────
const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".map": "application/json",
};
// Every 404 is recorded, not just logged. A missing asset is THE failure this gate exists for, and
// the first version of this file only watched the page console — where the worklet's 404 never
// appears, because it happens inside `addModule()`. That check passed green while the engine was
// failing to load, which is the same species of false comfort as the bug it was hunting.
const notFound = [];
const server = createServer(async (req, res) => {
  try {
    const url = (req.url ?? "/").split("?")[0];
    const file = url === "/" ? "index.html" : decodeURIComponent(url.replace(/^\//, ""));
    const body = await readFile(join(outDir, file));
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    notFound.push(req.url ?? "?");
    console.log("  [404]", req.url);
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`serving: ${base}\n`);

/**
 * ⚠️ EVERY ENGINE GETS A PERSISTENT PROFILE, and that is not incidental.
 *
 * With an ephemeral context, WebKit's OPFS throws `UnknownError: The operation failed for an unknown
 * transient reason` on the very FIRST `getDirectoryHandle` — before any of our code runs. Read
 * casually, that says "Safari cannot do OPFS" and would have had us building a fallback store for a
 * problem that does not exist. Given a real profile to write into, WebKit supports OPFSfully,
 * `createWritable` included. The origin private file system needs an origin with somewhere to put
 * itself; a throwaway context has nowhere.
 *
 * Chromium and Firefox happen to tolerate the ephemeral case. That is exactly why this was worth
 * pinning down rather than concluding from the one engine that complained.
 */
const ENGINES = {
  chromium: (dir) =>
    chromium.launchPersistentContext(dir, {
      channel: "chrome",
      args: ["--autoplay-policy=no-user-gesture-required"],
    }),
  webkit: (dir) => webkit.launchPersistentContext(dir, {}),
  firefox: (dir) =>
    // Firefox blocks an AudioContext that was not born in a gesture. Our clicks ARE gestures, but
    // headless Firefox is stricter about it than it needs to be.
    firefox.launchPersistentContext(dir, {
      firefoxUserPrefs: {
        "media.autoplay.default": 0,
        "media.autoplay.blocking_policy": 0,
      },
    }),
};

const only = process.argv[2];
const names = only ? [only] : Object.keys(ENGINES);
const results = {};

for (const name of names) {
  failures = 0;
  console.log(`\n${"═".repeat(70)}\n  ${name.toUpperCase()}\n${"═".repeat(70)}`);
  notFound.length = 0;
  await runIn(name);
  results[name] = failures;
}

console.log(`\n${"─".repeat(70)}`);
let bad = 0;
for (const [name, f] of Object.entries(results)) {
  console.log(`  ${f === 0 ? "✓" : "✗"} ${name.padEnd(10)} ${f === 0 ? "the built bundle plays" : `${f} failure(s)`}`);
  bad += f;
}
console.log(bad === 0 ? "\nSHIP GATE PASSED — every browser plays the built bundle" : `\nSHIP GATE FAILED`);

await new Promise((r) => server.close(r));
await rm(outDir, { recursive: true, force: true });
process.exit(bad === 0 ? 0 : 1);

async function runIn(engineName) {
const profile = await mkdtemp(join(tmpdir(), `scoopy-${engineName}-`));
const context = await ENGINES[engineName](profile);
const page = await context.newPage();
await page.route("**/favicon.ico", (r) => r.fulfill({ status: 204, body: "" }));

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (err) => {
  console.log("  [page error]", err.message);
  failures++;
});

await page.goto(`${base}/?host=browser`);
await page.waitForSelector(".cmp-root", { timeout: 10000 });

console.log("THE BUILT APP LOADS");
check("the companion shell renders from dist/", true);

// ── seed a playable session ───────────────────────────────────────────────────────────────────
// Through the raw OPFS API, not our modules: the built bundle has no importable source paths, which
// is itself a useful constraint — it forces this gate to touch only what a USER can touch.
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
    const mkdir = async (parent, name) => parent.getDirectoryHandle(name, { create: true });
    const write = async (dir, name, bytes) => {
      const h = await dir.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(bytes);
      await w.close();
    };

    const samples = await mkdir(root, "samples");
    const sampleDir = await mkdir(samples, "ShipSession");
    await write(sampleDir, "blip.wav", wav(0.4, 220));

    const pattern = JSON.parse(patternText);
    const kit = JSON.parse(kitText);
    const sampleId = kit.samples[0].id;
    const first = pattern.sectionA[0];
    pattern.sectionA[0] = {
      ...first,
      sampleId,
      steps: first.steps.map((_, i) => i % 4 === 0),
      isMuted: false,
      isStopped: false,
      volume: 1,
    };
    kit.samples = [
      { id: sampleId, name: "blip", filePath: "/samples/ShipSession/blip.wav",
        defaultVolume: 1, defaultPan: 0 },
    ];

    const sessions = await mkdir(root, "sessions");
    const dir = await mkdir(sessions, "ShipSession");
    const enc = new TextEncoder();
    await write(dir, "pattern.json", enc.encode(JSON.stringify(pattern)));
    await write(dir, "kit.json", enc.encode(JSON.stringify(kit)));
  },
  { patternText, kitText },
);

await page.reload();
await page.waitForSelector(".cmp-session", { timeout: 10000 });

console.log("\nTHE SESSION OPENS");
await page.click(".cmp-session:has-text('ShipSession')");
await page.waitForTimeout(500);
{
  const meta = await page.textContent(".cmp-meta").catch(() => "");
  check("session opens from OPFS", /BPM/.test(meta ?? ""), (meta ?? "").trim());
  const warn = await page.$$eval(".cmp-warn", (els) => els.map((e) => e.textContent));
  check("no missing samples / decode failures", warn.length === 0, warn.join(" | "));
}

// ── the GRID mounts from the BUILT bundle (P8-12's blind spot: its gate is dev-server-only) ────
console.log("\nTHE GRID MOUNTS");
{
  const drew = await page
    .waitForSelector(".cmp-grid .grid-canvas-stack", { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("GridPanel drew its canvas from the built bundle", drew);
  const waiting = await page.$(".cmp-grid .grid-panel.dim");
  check("not stuck on 'waiting for pattern state'", waiting === null);
}

// ── THE ONE THAT MATTERS: does the SHIPPED worklet boot? ──────────────────────────────────────
console.log("\nTHE SHIPPED AUDIOWORKLET");
await page.click(".cmp-transport button");
await page.waitForSelector(".cmp-play", { timeout: 20000 }).catch(() => {});
{
  const status = await page.textContent(".cmp-status").catch(() => "");
  check("the engine boots from the BUILT worklet", /running/.test(status ?? ""), (status ?? "").trim());

  const err = await page.textContent(".cmp-error").catch(() => null);
  check("no engine error", err === null, String(err));
}

await page.click(".cmp-play").catch(() => {});
await page.waitForTimeout(300);
{
  let width = 0;
  for (let i = 0; i < 40; i++) {
    width = await page.evaluate(() =>
      parseFloat(document.querySelector(".cmp-meter-fill")?.style.width || "0"),
    );
    if (width > 0) break;
    await page.waitForTimeout(100);
  }
  check("THE PRODUCTION BUILD MAKES SOUND", width > 0, `${width}% meter fill`);
}

// ── a REAL user's session: legacy schema, Finder-zipped, through the Import button ─────────────
// Every check above seeds a CURRENT-schema fixture straight into OPFS — which is exactly how the
// import path (strict decode, __MACOSX junk, the silent-error race) stayed broken while every gate
// was green. This drives the only door a user actually has: an old session, zipped the way Finder
// zips it, through the file input.
console.log("\nA LEGACY SESSION IMPORTS (migrations + Finder junk, via the real Import input)");
{
  const legacyPattern = await readFile(
    resolve(webRoot, "fixtures/patternfile/legacy/legacy-minimal.json"),
  );
  const legacyKit = await readFile(resolve(webRoot, "fixtures/session/session-kit.json"));
  const zipped = zipSync({
    // Finder shape: package-named root folder + __MACOSX shadows + .DS_Store.
    "LegacyTrip.scoopySession/pattern.json": [new Uint8Array(legacyPattern), { level: 0 }],
    "LegacyTrip.scoopySession/kit.json": [new Uint8Array(legacyKit), { level: 0 }],
    "LegacyTrip.scoopySession/.DS_Store": [new Uint8Array([0]), { level: 0 }],
    "__MACOSX/LegacyTrip.scoopySession/._pattern.json": [new Uint8Array([0]), { level: 0 }],
  });
  await page.setInputFiles(".cmp-import input", {
    name: "LegacyTrip.scoopySession.zip",
    mimeType: "application/zip",
    buffer: Buffer.from(zipped),
  });
  const listed = await page
    .waitForSelector(".cmp-session:has-text('LegacyTrip')", { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  const err = await page.textContent(".cmp-error", { timeout: 500 }).catch(() => null);
  check("the legacy Finder zip imported (migrated, junk ignored)", listed && !err, err ?? "");
  const name = listed
    ? await page.textContent(".cmp-session:has-text('LegacyTrip')")
    : "";
  check("named without the double extension", name === "LegacyTrip", name ?? "");
  // importFile auto-opens what it imported — the migrated document must also PROJECT (grid mounts).
  const gridAgain = await page
    .waitForSelector(".cmp-grid .grid-canvas-stack", { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("the migrated session projects into the grid", gridAgain);
}

// ── the FOLDER door: the desktop's .scoopySession as it sits on disk, via the Folder… picker ───
// A plain file input silently refuses a directory (no event, no error) — which read as "import
// does not react" to the first real user. The webkitdirectory picker and the drop walker are the
// two doors that take the folder itself; this drives the picker (the one a gate CAN drive).
console.log("\nA SESSION FOLDER IMPORTS (the webkitdirectory picker)");
{
  const dir = join(await mkdtemp(join(tmpdir(), "scoopy-folder-")), "FolderTrip.scoopySession");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "pattern.json"),
    await readFile(resolve(webRoot, "fixtures/patternfile/legacy/legacy-minimal.json")),
  );
  await writeFile(
    join(dir, "kit.json"),
    await readFile(resolve(webRoot, "fixtures/session/session-kit.json")),
  );
  await page.setInputFiles("input[webkitdirectory]", dir);
  const listed = await page
    .waitForSelector(".cmp-session:has-text('FolderTrip')", { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  const err = await page.textContent(".cmp-error", { timeout: 500 }).catch(() => null);
  check("the .scoopySession folder imported as-is", listed && !err, err ?? "");
  await rm(dirname(dir), { recursive: true, force: true });
}

// The build asked the server for something it did not emit. `/assets/scoopy-engine.js` is the exact
// one this gate was born for — but ANY 404 means the bundle is incomplete, so none are tolerated.
check("the build requested nothing it did not ship", notFound.length === 0, notFound.join(" | "));

const engineErrors = consoleErrors.filter((t) => /scoopy-engine|worklet|addModule/i.test(t));
check("no worklet errors in the console", engineErrors.length === 0, engineErrors.join(" | "));

await context.close();
await rm(profile, { recursive: true, force: true });
}
