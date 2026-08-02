/**
 * THE WALK MATRIX — every browser walk, in every engine that matters (H4).
 *
 *   node tools/walks.mjs                 # all walks × webkit, chromium
 *   node tools/walks.mjs webkit          # all walks, one engine
 *   node tools/walks.mjs webkit plane    # one engine, walks matching "plane"
 *
 * WHY IT EXISTS. Seven of the eight walks hardcoded `chromium` while the app
 * ships WebKit — WKWebView on macOS, WebKitGTK on Linux. Seven eighths of the
 * browser gate measured an engine the product does not use. Running them one at
 * a time in one engine is how that went unnoticed, so the matrix is a thing you
 * can run in one command.
 *
 * ⚠️ WEBKIT IS LISTED FIRST DELIBERATELY. When a walk fails in both engines the
 * WebKit line is the one that matters; when it fails in only one, the order makes
 * which engine is authoritative obvious without reading the code.
 *
 * `browser_prod_test` is not here: it runs its own three-engine sweep internally
 * (it is the release ship gate) and builds the bundle as part of the run, so it
 * would be minutes of duplicated work.
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const WALKS = [
  "browser_shell_test",
  "browser_opfs_test",
  "browser_plane_test",
  "browser_grid_test",
  "browser_session_walk_test",
  "browser_worklet_test",
  "browser_companion_audio_test",
  // ScoopyDeck's layout (D-SL-DECKPLUGIN-01). The plugin face borrows plane
  // components that assume a strip's geometry; mounted without it they resolve
  // their `height: 100%` against whatever ancestor is there and silently
  // swallow the UI. Three regressions shipped that way, each caught only by a
  // person opening the plugin in a DAW.
  "browser_plugindeck_test",
  // ScoopyTape's layout. The brief for that plugin is "the UI centered around
  // the display", which is a LAYOUT claim — so it needs a layout gate or it is
  // only an intention. Asserts the wave field is the one flexible box, that it
  // is a majority of the window, and that its canvas backing store is at device
  // resolution rather than CSS pixels.
  "browser_plugintape_test",
];

const ENGINE_ORDER = ["webkit", "chromium"];

const engineArg = process.argv[2];
const filter = process.argv[3];
const engines = engineArg ? [engineArg] : ENGINE_ORDER;
const walks = filter ? WALKS.filter((w) => w.includes(filter)) : WALKS;

if (walks.length === 0) {
  console.error(`no walk matches "${filter}". Known:\n  ${WALKS.join("\n  ")}`);
  process.exit(1);
}

// ⚠️ THE WALKS SERVE `webdist/`, NOT `src/` — so a walk run before `npm run
// bundle` measures the COMMITTED bundle and says nothing about your edits.
//
// This is not hypothetical and it is not obvious from a failing walk. On
// 2026-08-02 it produced two false results in a row while a new control was
// being built: first "the element does not exist" (it did, in source), then a
// pass that proved nothing. It is the same shape as the stale MergedWalk
// artefact fixed the same day — a green gate measuring yesterday's build.
//
// `webdistFresh --check` already knows the exact input closure, so the guard is
// to ask it. It REFUSES rather than bundling: `npm run bundle` also stamps
// `.buildhash`, and a gate that silently rebuilds what it is about to measure
// is a gate you can no longer reason about.
const fresh = spawnSync(
  process.execPath,
  ["--experimental-strip-types", resolve(here, "../scripts/webdistFresh.ts"), "--check"],
  { cwd: resolve(here, ".."), encoding: "utf8" },
);
if (fresh.status !== 0) {
  console.error("──────────────────────────────────────────────────────────────");
  console.error("REFUSING TO WALK: webdist/ is stale — it does not contain your");
  console.error("edits, so every result below would describe the last bundle.");
  console.error("");
  console.error("  npm run bundle    then run the walks again");
  console.error("──────────────────────────────────────────────────────────────");
  process.stderr.write(fresh.stdout ?? "");
  process.exit(1);
}

function run(walk, engine) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve(here, `${walk}.mjs`)], {
      cwd: resolve(here, ".."),
      env: { ...process.env, SL_WALK_ENGINE: engine },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
  });
}

const failed = [];
for (const engine of engines) {
  console.log(`\n${"=".repeat(72)}\n  ${engine.toUpperCase()}\n${"=".repeat(72)}`);
  for (const walk of walks) {
    process.stdout.write(`  ${walk.padEnd(32)}`);
    const { code, out } = await run(walk, engine);
    if (code === 0) {
      console.log("ok");
    } else {
      console.log(`FAILED (exit ${code})`);
      failed.push({ walk, engine, out });
    }
  }
}

console.log(`\n${"-".repeat(72)}`);
if (failed.length === 0) {
  console.log(`WALK MATRIX PASSED — ${walks.length} walk(s) × ${engines.length} engine(s)`);
  process.exit(0);
}

// The full output of every failure, not a count: a matrix that tells you "3
// failed" and makes you re-run each one by hand is a worse tool than the loop
// you were already typing.
for (const f of failed) {
  console.log(`\n${"=".repeat(72)}\n  FAILED: ${f.walk} in ${f.engine}\n${"=".repeat(72)}`);
  console.log(f.out.trimEnd());
}
console.log(
  `\nWALK MATRIX FAILED — ${failed.length} of ${walks.length * engines.length}: ` +
    failed.map((f) => `${f.walk}/${f.engine}`).join(", "),
);
process.exit(1);
