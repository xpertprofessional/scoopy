/**
 * DOES THE BUILT PLUGIN EMBED THE CURRENT UI?
 *
 * The app serves `webdist/` off disk, so a web rebuild is live the moment you
 * reload a window. A PLUGIN does not: `shell/plugin/CMakeLists.txt` packs
 * `webdist/` into a zip and `juce_add_binary_data` links it INTO the binary,
 * because a plugin is copied onto machines that never saw this tree. So the UI
 * a DAW runs is frozen at the last `cmake --build`.
 *
 * That makes `npm run bundle` a TRAP for plugin work. The project rule is that
 * bundling is the last step before `git add` (so `.buildhash` matches the tree)
 * — correct, and it leaves the installed plugin one build behind. Twice in a row
 * a real-host fix was reported "still broken" when the fix was simply not in the
 * binary yet, which is unfalsifiable from inside a DAW: the UI looks right, it
 * is just old.
 *
 * CMake's own dependency tracking is correct — the zip DEPENDS on the webdist
 * files and repacks when they change. The only failure is forgetting to run it.
 * So this does not re-derive anything; it compares timestamps and says which
 * command to run.
 *
 *   node --experimental-strip-types scripts/pluginFresh.ts
 */
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const webdist = join(repo, "webdist");
const zip = join(repo, "build", "shell", "plugin", "webdist_zip");

/** Newest mtime among the files the CMake glob actually embeds. */
function newestEmbedded(dir: string): { path: string; ms: number } | null {
  let best: { path: string; ms: number } | null = null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = newestEmbedded(p);
      if (sub && (!best || sub.ms > best.ms)) best = sub;
      continue;
    }
    // Mirrors the CMakeLists glob: sourcemaps and `.buildhash` are excluded
    // there, so a change to them cannot make the plugin stale and must not be
    // reported as if it had.
    if (/\.map$/.test(entry.name) || entry.name === ".buildhash") continue;
    if (!/\.(html|css|js|svg|png|jpe?g|woff2|wasm|json)$/.test(entry.name)) continue;
    const ms = statSync(p).mtimeMs;
    if (!best || ms > best.ms) best = { path: p, ms };
  }
  return best;
}

if (!existsSync(webdist)) {
  console.error("plugin:check — no webdist/ at all. Run `npm run bundle` first.");
  process.exit(1);
}

// NOT a failure: a tree that has never built the plugin is not a stale one, and
// failing here would break `npm test` for everyone who only touches the app.
if (!existsSync(zip)) {
  console.log("plugin:check — no plugin build in this tree yet (nothing to be stale)");
  process.exit(0);
}

const newest = newestEmbedded(webdist);
if (!newest) {
  console.error("plugin:check — webdist/ has no embeddable files. Run `npm run bundle`.");
  process.exit(1);
}

const zipMs = statSync(zip).mtimeMs;
if (newest.ms > zipMs) {
  const behind = Math.round((newest.ms - zipMs) / 1000);
  console.error(
    `plugin:check FAILED — the built plugin embeds a web bundle ${behind}s older than webdist/.\n` +
      `  newest web file: ${newest.path.replace(repo + "/", "")}\n` +
      `  embedded zip:    ${zip.replace(repo + "/", "")}\n` +
      `\n` +
      `  A DAW loads the UI from INSIDE the binary, so your change is not in the\n` +
      `  plugin yet — it will look exactly like the fix did not work.\n` +
      `\n` +
      `  Fix:  cmake --build build --target ScoopyDeck_All ScoopyTape_All\n` +
      `  then RELOAD the plugin in the DAW (hosts cache the binary in-process).`,
  );
  process.exit(1);
}

console.log("plugin:check ok — the built plugin embeds the current web bundle");
