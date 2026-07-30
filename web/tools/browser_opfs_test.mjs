/**
 * P8-6 GATE — the REAL FileBrowserPanel, in REAL Chrome, on REAL OPFS.
 *
 * The unit tests under `src/store/` prove our logic against an in-memory OPFS fake. They cannot
 * prove the thing this row actually claims, which is that **the panel does not know who is answering
 * it** — that a React component written against Swift's `fileBrowser` topic renders, sorts, selects,
 * draws a waveform and auditions a sample when an OPFS handle tree is underneath instead. That is a
 * statement about a browser, and only a browser can settle it.
 *
 * This migration has been bitten by exactly this gap three times (context-menu items that opened and
 * did nothing; a DJ panel frozen on the wrong link; a launchQuantize picker wired to defaults) — each
 * time with a full green test suite. So this gate does not inspect state: it CLICKS THE PANEL, with a
 * trusted pointer, and reads the DOM the user would be looking at.
 *
 * It also runs the P8-10 round-trip in the browser: a real Swift-written `.scoopySession` is imported,
 * its samples land in the library, the panel lists them, and the session is re-packaged and compared.
 *
 *   node tools/browser_opfs_test.mjs
 *
 * NOT COVERED, and nothing can cover it: the native folder-picker dialog `chooseFolder` opens. No
 * automation may drive an OS file dialog. The import path BEHIND the picker is tested (importFiles);
 * the dialog itself is a human's job.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openEngine } from "./lib/engines.mjs";
import { createServer } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

// ── the app, served by vite (which also transforms TS on demand, so the page can import our
//    modules by source path for the session round-trip) ────────────────────────────────────────
const server = await createServer({
  configFile: resolve(webRoot, "vite.config.ts"),
  root: webRoot,
  logLevel: "warn",
  server: { port: 5199, strictPort: false },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
console.log(`vite: ${base}`);

const { browser, cleanup } = await openEngine()
const page = await browser.newPage();
// Chrome asks for /favicon.ico on its own and the dev server has none. It is a browser-internal
// request, so it never reaches the `response` hook — it only shows up as a console error, where it
// looks exactly like a real one. Answer it, so an unexplained 404 never sits in this gate's output.
await page.route("**/favicon.ico", (route) => route.fulfill({ status: 204, body: "" }));

page.on("console", (m) => {
  if (m.type() === "error") console.log("  [browser error]", m.text());
});
page.on("pageerror", (err) => {
  console.log("  [page error]", err.message);
  failures++;
});
page.on("response", (r) => {
  if (r.status() >= 400) console.log("  [http]", r.status(), r.url());
});

// ── seed OPFS through the RAW browser API, not our store ──────────────────────────────────────
// Deliberate: if the bytes go in through the same code that reads them out, a shared misunderstanding
// of OPFS would cancel itself out and the test would pass while the panel showed nothing.
await page.goto(`${base}/?host=browser&panel=filebrowser`);
await page.evaluate(async () => {
  /** A real, decodable 16-bit PCM WAV — a 220 Hz sine, so the audition has something to meter. */
  function wav(seconds, freq, sampleRate = 44100) {
    const frames = Math.floor(seconds * sampleRate);
    const buffer = new ArrayBuffer(44 + frames * 2);
    const view = new DataView(buffer);
    const ascii = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };
    ascii(0, "RIFF");
    view.setUint32(4, 36 + frames * 2, true);
    ascii(8, "WAVEfmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    ascii(36, "data");
    view.setUint32(40, frames * 2, true);
    for (let i = 0; i < frames; i++) {
      const s = Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.8;
      view.setInt16(44 + i * 2, s * 32767, true);
    }
    return new Uint8Array(buffer);
  }

  const root = await navigator.storage.getDirectory();
  const samples = await root.getDirectoryHandle("samples", { create: true });

  const write = async (dir, name, bytes) => {
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
  };

  await write(samples, "sine.wav", wav(1.0, 220));
  await write(samples, "readme.txt", new TextEncoder().encode("not audio"));
  const kicks = await samples.getDirectoryHandle("Kicks", { create: true });
  await write(kicks, "808.wav", wav(0.5, 60));
});

// Re-scan: a real click on the panel's own ↻ button.
await page.reload();
await page.waitForSelector(".br-row", { timeout: 5000 }).catch(() => {});
await page.click('button[title="Re-scan this folder"]');
await page.waitForTimeout(300);

console.log("\nTHE PANEL, OVER OPFS");
{
  const rows = await page.$$eval(".br-row .br-name", (els) => els.map((e) => e.textContent));
  check("lists the OPFS library", rows.includes("sine.wav") && rows.includes("Kicks"), rows.join(", "));
  check("hides non-audio", !rows.includes("readme.txt"));

  // ⚠️ THIS USED TO BE `rows[0] === "Kicks"`, which asserted the ORDERING by
  // asserting one name — true only while exactly one directory existed. H4 gave
  // every walk a persistent profile (WebKit needs one for OPFS at all), the app
  // then had somewhere to keep its `Demo` folder, and a correct listing of
  // "Demo, Kicks, sine.wav" failed a check about sorting. The claim is that
  // DIRECTORIES PRECEDE FILES, so assert that, off the row icons the panel
  // actually renders (▸ directory, ~ file — FileBrowserPanel.tsx:320) rather
  // than off a name that happened to be first.
  const kinds = await page.$$eval(".br-row .br-icon", (els) =>
    els.map((e) => (e.textContent?.trim() === "▸" ? "dir" : "file")),
  );
  const firstFile = kinds.indexOf("file");
  const lastDir = kinds.lastIndexOf("dir");
  check(
    "directories sort first",
    kinds.length > 0 && (firstFile === -1 || lastDir === -1 || lastDir < firstFile),
    `${rows.join(", ")}  [${kinds.join(", ")}]`,
  );
}

// ── selection → the waveform. A real click on a real row. ─────────────────────────────────────
await page.click(".br-row:has-text('sine.wav')");
await page.waitForTimeout(600); // decode + peaks

console.log("\nSELECTION → PEAKS → WAVEFORM");
{
  const name = await page.textContent(".fb-preview-name").catch(() => null);
  check("the footer opens on the selected sample", name === "sine.wav", String(name));

  const duration = await page.textContent(".fb-preview-time").catch(() => null);
  check("the sample was DECODED (a duration, not a dash)", duration === "1.0s", String(duration));

  // The waveform is drawn to a canvas by the SAME drawWave the grid cells use. Read the pixels: an
  // empty canvas here is the exact failure mode a DOM-only assertion would sail straight past.
  const inked = await page.evaluate(() => {
    const canvas = document.querySelector(".fb-wave canvas");
    if (!canvas) return -1;
    const ctx = canvas.getContext("2d");
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
    return n;
  });
  check("the waveform is actually PAINTED", inked > 100, `${inked} non-transparent pixels`);
}

// ── audition. Space, on the focused list — the panel's own keybinding. ────────────────────────
console.log("\nAUDITION (the point of the panel)");
{
  await page.click(".br-list");
  await page.keyboard.press("Space");
  await page.waitForTimeout(400);

  const stopping = await page.getAttribute(".fb-play", "title");
  check("space starts the audition", stopping === "Stop", String(stopping));

  // The level meter rides the HotFrame at 30 Hz — the same slot the desktop fills. If the pump is
  // dead, or the analyser never sees audio, this stays at 0% and the meter is a decoration.
  let width = "0%";
  for (let i = 0; i < 20 && parseFloat(width) === 0; i++) {
    width = await page.evaluate(() => document.querySelector(".fb-meter-fill")?.style.width || "0%");
    if (parseFloat(width) > 0) break;
    await page.waitForTimeout(100);
  }
  check("the HotFrame level meter MOVES (audio is really flowing)", parseFloat(width) > 0, `width ${width}`);

  const head = await page.evaluate(
    () => document.querySelector(".fb-wave-head")?.style.opacity ?? "0",
  );
  check("the playhead is showing", head === "1", `opacity ${head}`);

  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  const playing = await page.getAttribute(".fb-play", "title");
  check("space stops it again", playing === "Audition", String(playing));
}

// ── navigation: double-click into a folder, crumbs, back up ───────────────────────────────────
console.log("\nNAVIGATION");
{
  await page.dblclick(".br-row:has-text('Kicks')");
  await page.waitForTimeout(300);

  const rows = await page.$$eval(".br-row .br-name", (els) => els.map((e) => e.textContent));
  check("double-click enters the folder", rows.includes("808.wav"), rows.join(", "));

  const crumbs = await page.$$eval(".br-crumbs button", (els) => els.map((e) => e.textContent));
  check("crumbs track the path", crumbs.join("/") === "Library/Kicks", crumbs.join("/"));

  await page.click(".br-crumbs button:has-text('Library')");
  await page.waitForTimeout(300);
  const back = await page.$$eval(".br-row .br-name", (els) => els.map((e) => e.textContent));
  check("a crumb navigates back", back.includes("sine.wav"));
}

// ── load: the honest boundary. It must SAY so, in the UI. ─────────────────────────────────────
console.log("\nTHE LOAD BOUNDARY");
{
  await page.click(".br-row:has-text('sine.wav')");
  await page.waitForTimeout(200);
  await page.click(".fb-load");
  await page.waitForTimeout(200);
  const notice = await page.textContent(".br-notice").catch(() => null);
  check("LOAD tells the user why it cannot (no silent no-op)", /FLIP/.test(notice ?? ""), String(notice));
}

// ── the P8-10 round-trip, in the browser ──────────────────────────────────────────────────────
console.log("\nSESSION ROUND-TRIP (a real Swift-written package)");
{
  const zip = await readFile(resolve(webRoot, "fixtures/session/session.zip"));
  // base64, NOT a number[]: the fixture is 540 KB, and handing playwright half a million array
  // elements serializes to ~3 MB of JSON and takes the execution context down with it.
  const result = await page.evaluate(async (b64) => {
    const store = await import("/src/store/sessionStore.ts");
    const pkg = await import("/src/persist/sessionPackage.ts");

    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const file = new File([bytes], "Demo.scoopySession");
    const session = await store.importSessionFile(file);

    const reopened = await store.openSession("Demo"); // as a page reload would
    const repacked = await store.packageSession(reopened);
    const unpacked = pkg.unpackSession(repacked.bytes);
    const original = pkg.unpackSession(new Uint8Array(bytes));

    const sameSample = (name) => {
      const a = original.samples.get(name);
      const b = unpacked.samples.get(name);
      return !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
    };

    return {
      sessions: (await store.listSessions()).map((s) => s.name),
      kitPaths: session.kit.samples.map((s) => s.filePath),
      packagedPaths: unpacked.kit.samples.map((s) => s.filePath),
      keptNotes: unpacked.extras.has("notes.txt"),
      samplesIntact: sameSample("Samples/kick.wav") && sameSample("Samples/snare.wav"),
      missing: repacked.missing,
    };
  }, zip.toString("base64"));

  check("the session is in the OPFS library", result.sessions.includes("Demo"));
  check(
    "its samples became LIBRARY files",
    result.kitPaths.every((p) => p.startsWith("/samples/Demo/")),
    result.kitPaths.join(", "),
  );
  check(
    "export rewrites them package-relative — never absolute",
    result.packagedPaths.every((p) => p.startsWith("Samples/")),
    result.packagedPaths.join(", "),
  );
  check("sample bytes survive the round-trip", result.samplesIntact);
  check("preserve-don't-drop: notes.txt is still there", result.keptNotes);
  check("nothing went missing", result.missing.length === 0);
}

// ── and the library the session brought is BROWSABLE — the payoff for OPFS-as-library ─────────
console.log("\nTHE IMPORTED SESSION'S SAMPLES ARE BROWSABLE");
{
  await page.click('button[title="Re-scan this folder"]');
  await page.waitForTimeout(300);
  const rows = await page.$$eval(".br-row .br-name", (els) => els.map((e) => e.textContent));
  check("the session's sample folder appears in the browser", rows.includes("Demo"), rows.join(", "));
}

console.log(`\n${failures === 0 ? "P8-6 GATE PASSED" : `P8-6 GATE FAILED — ${failures} check(s)`}`);

await cleanup();
await server.close();
process.exit(failures === 0 ? 0 : 1);
