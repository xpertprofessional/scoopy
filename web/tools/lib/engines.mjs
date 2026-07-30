/**
 * THE BROWSER ENGINES THE WALKS RUN IN, in one place (H4).
 *
 * Lifted verbatim out of `browser_prod_test.mjs`, which was the ONLY walk that
 * ever ran more than Chromium — and which, precisely because it did, is where
 * the WebKit OPFS lesson below was learned. The other seven hardcoded
 * `chromium`. The app ships WebKit (WKWebView on macOS, WebKitGTK on Linux), so
 * seven of eight gates were measuring an engine the product does not use.
 *
 * ⚠️ EVERY ENGINE GETS A PERSISTENT PROFILE, and that is not incidental.
 *
 * With an ephemeral context, WebKit's OPFS throws `UnknownError: The operation
 * failed for an unknown transient reason` on the very FIRST `getDirectoryHandle`
 * — before any of our code runs. Read casually, that says "Safari cannot do
 * OPFS" and would have had us building a fallback store for a problem that does
 * not exist. Given a real profile to write into, WebKit supports OPFS fully,
 * `createWritable` included. The origin private file system needs an origin with
 * somewhere to put itself; a throwaway context has nowhere.
 *
 * Chromium and Firefox happen to tolerate the ephemeral case. That is exactly
 * why this was worth pinning down rather than concluding from the one engine
 * that complained — and it is why this module only exposes persistent contexts.
 * A walk that calls `chromium.launch()` will pass and its WebKit twin will fail
 * for a reason that has nothing to do with the feature under test.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, firefox, webkit } from "playwright";

export const ENGINES = {
  chromium: (dir) =>
    chromium.launchPersistentContext(dir, {
      channel: "chrome",
      args: ["--autoplay-policy=no-user-gesture-required"],
    }),
  webkit: (dir) => webkit.launchPersistentContext(dir, {}),
  firefox: (dir) =>
    // Firefox blocks an AudioContext that was not born in a gesture. Our clicks
    // ARE gestures, but headless Firefox is stricter about it than it needs to be.
    firefox.launchPersistentContext(dir, {
      firefoxUserPrefs: {
        "media.autoplay.default": 0,
        "media.autoplay.blocking_policy": 0,
      },
    }),
};

/** WebKit FIRST, because that is the engine the app ships. When a walk fails in
    both, the WebKit line is the one that matters; when it fails in only one, the
    order makes which engine is authoritative obvious in the log.
    Firefox is not in the default set — nothing ships it — but `browser_prod_test`
    still runs all three as the release ship gate. */
export const DEFAULT_ENGINES = ["webkit", "chromium"];

/**
 * Engine names for this run: `node tools/browser_x.mjs [engine]`.
 * An unknown name is a hard error, never a silent fallback — "webkit" typed as
 * "webKit" must not quietly hand you a Chromium pass.
 */
export function pickEngines(argv = process.argv, defaults = DEFAULT_ENGINES) {
  const only = argv[2];
  if (!only) return defaults;
  if (!(only in ENGINES))
    throw new Error(
      `unknown engine "${only}" — expected one of: ${Object.keys(ENGINES).join(", ")}`,
    );
  return [only];
}

/**
 * Open ONE engine for a walk that runs top-to-bottom (which is all of them but
 * `browser_prod_test`). Returns the context — usable exactly like the `browser`
 * these walks used to get from `chromium.launch()`, since a persistent context
 * also has `.newPage()` and `.close()` — plus a `cleanup()` that closes it and
 * removes the profile.
 *
 *   const { browser, engine, cleanup } = await openEngine();
 *   ... await browser.newPage() ...
 *   await cleanup();
 *
 * ⚠️ THE ENGINE COMES FROM `SL_WALK_ENGINE`, NOT FROM argv, and that is a fix
 * rather than a preference: `browser_plane_test` and `browser_session_walk_test`
 * already take `argv[2]` as the dist directory to serve. Reading argv here made
 * them try to serve `webkit/index.html` and die with ENOENT — a walk failing for
 * a reason that had nothing to do with the engine, which is precisely the kind
 * of noise that gets a new gate switched off. An env var collides with nothing.
 *
 * Default `webkit`, because that is the engine the app ships. The matrix is
 * "run the script twice with different env" rather than a control-flow rewrite
 * of every walk — `tools/walks.mjs` does exactly that.
 */
export async function openEngine(engineName = process.env.SL_WALK_ENGINE, fallback = "webkit") {
  const engine = engineName || fallback;
  if (!(engine in ENGINES))
    throw new Error(
      `unknown engine "${engine}" (SL_WALK_ENGINE) — expected one of: ${Object.keys(ENGINES).join(", ")}`,
    );
  const dir = await mkdtemp(join(tmpdir(), `scoopy-walk-${engine}-`));
  const browser = await ENGINES[engine](dir);
  console.log(`engine: ${engine}`);
  return {
    browser,
    engine,
    cleanup: async () => {
      await browser.close().catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Runs `body(context, name)` once per engine against a FRESH persistent profile,
 * and returns the per-engine failure counts.
 *
 * The profile directory is made and removed here so no walk has to remember to,
 * and so one engine's stored OPFS can never leak into the next engine's run and
 * make a broken write look like a working read.
 */
export async function forEachEngine(names, body) {
  const results = {};
  for (const name of names) {
    const dir = await mkdtemp(join(tmpdir(), `scoopy-walk-${name}-`));
    let context;
    try {
      console.log(`\n${"=".repeat(70)}\n  ${name.toUpperCase()}\n${"=".repeat(70)}`);
      context = await ENGINES[name](dir);
      results[name] = (await body(context, name)) ?? 0;
    } finally {
      await context?.close().catch(() => {});
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  return results;
}

/** One-line-per-engine summary + the process exit code. `label` says what passing
    MEANS, so a green log states the claim rather than just "ok". */
export function reportEngines(results, label) {
  console.log(`\n${"-".repeat(70)}`);
  let bad = 0;
  for (const [name, failures] of Object.entries(results)) {
    console.log(`  ${failures === 0 ? "✓" : "✗"} ${name.padEnd(10)} ${failures === 0 ? label : `${failures} failure(s)`}`);
    bad += failures;
  }
  console.log(bad === 0 ? `\nPASSED — every engine: ${label}` : `\nFAILED`);
  return bad === 0 ? 0 : 1;
}
