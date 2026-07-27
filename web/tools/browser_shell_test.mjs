/**
 * P8-7 GATE — the COMPANION SHELL, clicked by a real pointer in a real browser.
 *
 * The audio gate (`browser_companion_audio_test.mjs`) proved the chain makes sound. It proved it
 * PROGRAMMATICALLY — by importing the modules and calling them. What it could not prove is that any
 * of it is reachable by a human, and this migration has now been bitten three times by exactly that
 * gap: the context-menu items that opened and did nothing, the DJ panel frozen on the wrong link,
 * the launchQuantize picker wired to defaults. Every one of them had green tests.
 *
 * So this drives the UI: it clicks the session, clicks START ENGINE, clicks play — and then watches
 * the OUTPUT METER, which is fed by an AnalyserNode tapped off the engine's own graph in a LIVE
 * AudioContext. A meter that moves is the difference between "the engine says it is running" and
 * "the engine is making sound", and those two are otherwise indistinguishable: a dead AudioWorklet
 * outputs zeros forever and reports nothing.
 *
 *   node tools/browser_shell_test.mjs
 *
 * NOT COVERED: Export…, because it opens `showSaveFilePicker` — an OS dialog, which no automation
 * may drive. The packaging behind it is covered by the sessionStore unit tests and the OPFS gate.
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
  server: { port: 5202, strictPort: false },
});
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, "");
console.log(`vite: ${base}`);

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.route("**/favicon.ico", (r) => r.fulfill({ status: 204, body: "" }));
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [browser error]", m.text());
});
page.on("pageerror", (err) => {
  console.log("  [page error]", err.message);
  failures++;
});

// `?host=browser` with NO panel — the companion must be what the browser opens on.
await page.goto(`${base}/?host=browser`);
await page.waitForSelector(".cmp-root", { timeout: 8000 });

console.log("\nTHE SHELL OPENS");
check("`?host=browser` lands on the companion, with no panel named", true);
{
  const empty = await page.textContent(".cmp-sessions ~ * , .cmp-empty").catch(() => "");
  check("an empty library says so", /no sessions yet/.test(empty ?? ""), (empty ?? "").trim());
}

// ── seed a PLAYABLE session into OPFS (the fixture session has no track↔sample binding) ───────
const patternText = await readFile(resolve(webRoot, "fixtures/session/session-pattern.json"), "utf8");
const kitText = await readFile(resolve(webRoot, "fixtures/session/session-kit.json"), "utf8");

await page.evaluate(
  async ({ patternText, kitText }) => {
    const SR = 48000;
    const opfs = await import("/src/store/opfs.ts");
    const sessions = await import("/src/store/sessionStore.ts");
    const { decodeKit } = await import("/src/persist/kit.ts");
    const { decodePatternFileAnyVersion } = await import("/src/persist/migrations.ts");

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

    const pattern = decodePatternFileAnyVersion(patternText);
    const kit = decodeKit(kitText);

    await opfs.ensureDir("/samples/PlaneSession");
    await opfs.writeFile("/samples/PlaneSession/blip.wav", wav(0.4, 220));

    const sampleId = kit.samples[0].id;
    const first = pattern.sectionA[0];

    await sessions.saveSession({
      name: "PlaneSession",
      pattern: {
        ...pattern,
        sectionA: [
          {
            ...first,
            sampleId,
            steps: first.steps.map((_, i) => i % 4 === 0),
            isMuted: false,
            isStopped: false,
            volume: 1,
          },
          ...pattern.sectionA.slice(1),
        ],
      },
      kit: {
        ...kit,
        samples: [
          { id: sampleId, name: "blip", filePath: "/samples/PlaneSession/blip.wav",
            defaultVolume: 1, defaultPan: 0 },
        ],
      },
      extras: new Map(),
    });
  },
  { patternText, kitText },
);

// A reload is the honest test: this is what "you closed the lid and came back" looks like.
await page.reload();
await page.waitForSelector(".cmp-session", { timeout: 8000 });

console.log("\nTHE SESSION LIBRARY SURVIVES A RELOAD");
{
  const names = await page.$$eval(".cmp-session", (els) => els.map((e) => e.textContent));
  check("the OPFS session is listed", names.includes("PlaneSession"), names.join(", "));
}

// ── open it, with a real click ────────────────────────────────────────────────────────────────
await page.click(".cmp-session:has-text('PlaneSession')");
await page.waitForTimeout(400);

console.log("\nOPENING IT");
{
  const meta = await page.textContent(".cmp-meta").catch(() => "");
  check("the session opens and reports its tempo + kit", /120\.0 BPM · 1 sample/.test(meta ?? ""), (meta ?? "").trim());

  // P8-12: the kit list was replaced by the editable GRID (which shows the tracks). A mounted grid
  // is the stronger claim — it means the projected topics arrived and parsed.
  const gridMounted = await page
    .waitForSelector(".cmp-grid .grid-canvas-stack", { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("the editable grid mounted", gridMounted);

  const warn = await page.$$eval(".cmp-warn", (els) => els.map((e) => e.textContent));
  check("no missing samples, no decode failures", warn.length === 0, warn.join(" | "));
}

// ── the engine. A BUTTON, because an AudioContext needs a gesture. ────────────────────────────
console.log("\nSTARTING THE ENGINE (a real click — a browser demands one)");
await page.click(".cmp-transport button");
await page.waitForSelector(".cmp-play", { timeout: 15000 });
{
  const status = await page.textContent(".cmp-status");
  check("the WASM engine came up", /running/.test(status ?? ""), (status ?? "").trim());
}

// ── PLAY. And then watch the meter, which is the only honest witness. ─────────────────────────
console.log("\nDOES IT ACTUALLY MAKE SOUND?");
await page.click(".cmp-play");
await page.waitForTimeout(300);
{
  const playing = await page.getAttribute(".cmp-play", "aria-label");
  check("play engages", playing === "Stop", String(playing));

  let width = 0;
  for (let i = 0; i < 40; i++) {
    width = await page.evaluate(() =>
      parseFloat(document.querySelector(".cmp-meter-fill")?.style.width || "0"),
    );
    if (width > 0) break;
    await page.waitForTimeout(100);
  }
  // The meter is an AnalyserNode on the engine's own output, in a LIVE AudioContext. If the worklet
  // died, or the kit never reached it, or the world named a sample the engine does not have, this
  // stays at 0 and everything else above still passes.
  check("THE OUTPUT METER MOVES — the engine is making sound", width > 0, `${width}% fill`);

  await page.click(".cmp-play");
  await page.waitForTimeout(200);
  const stopped = await page.getAttribute(".cmp-play", "aria-label");
  check("stop disengages", stopped === "Play", String(stopped));
}

// ── import a real .scoopySession through the REAL file input ──────────────────────────────────
console.log("\nIMPORT (the real <input type=file>, not a mocked call)");
{
  await page.setInputFiles(".cmp-import input", resolve(webRoot, "fixtures/session/session.zip"));
  await page.waitForTimeout(800);

  const names = await page.$$eval(".cmp-session", (els) => els.map((e) => e.textContent));
  check("the imported session joins the library", names.includes("session"), names.join(", "));
  check("the original is still there", names.includes("PlaneSession"));
}

console.log(`\n${failures === 0 ? "P8-7 SHELL GATE PASSED" : `FAILED — ${failures} check(s)`}`);

await browser.close();
await server.close();
process.exit(failures === 0 ? 0 : 1);
