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
import { spawn } from "node:child_process";
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
