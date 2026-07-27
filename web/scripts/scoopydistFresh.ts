/**
 * scoopydist:check — is the bundle the MERGED APP SERVES actually current?
 *
 * ⚠️ THIS GATE EXISTS BECAUSE ITS ABSENCE COST A WHOLE SESSION. On 2026-07-27 a
 * day's UI work — the monitor switch, the record-tap menu, the session-loading
 * gesture, the in-window composer — was built, tested, committed and INVISIBLE
 * in the running app, because `MergedMain` serves `vendor/scoopy/webdist`: a
 * vendored BUILD of the web UI, not its sources. Nothing rebuilt it, nothing
 * checked it, and a stale bundle is the quietest failure there is — the app
 * runs, the UI looks right, it is simply OLD.
 *
 * The shipping app has had exactly this gate since 2026-07-13 (its own
 * `scripts/check-webdist-fresh.sh`, written after shipping an archive a full
 * feature behind). The merged tree vendored the bundle and not the lesson.
 *
 * THE CHAIN HAS TWO LINKS and both can rot independently:
 *
 *   1. shipping web/src  →  shipping webdist    (their `npm run bundle:mac`)
 *   2. shipping webdist  →  vendor/scoopy/webdist   (our `npm run engine:sync`)
 *
 * Link 1 is proven by their `.srcstamp` against their `websrc-hash.sh`. Link 2
 * is proven by comparing content: after a sync the two trees must be identical.
 *
 * ⚠️ AND `.srcstamp` DOES NOT SURVIVE THE SYNC. `sharedSync.ts` skips every
 * dotfile (rightly — there is a `.DS_Store` in that folder), so the one file
 * that would let the vendored copy describe itself is dropped in transit. That
 * is why this checks link 2 by content rather than by reading a stamp that
 * isn't there.
 *
 * EXPECTED LIFETIME: short. Once `vendor/scoopy/` is replaced by first-class
 * sources and the web builds in-tree (P3-0 step 2), both links disappear and so
 * does this file. It is worth writing anyway — the migration has not happened,
 * and until it does every session can lose its work the same way.
 *
 *   node --experimental-strip-types scripts/scoopydistFresh.ts
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
/** The shipping app's working copy. Read from the engine lock rather than
    hardcoded, so the two cannot drift after a folder move — which is exactly
    what the P3-0 collapse just did to every path in this repo. */
const lock = JSON.parse(readFileSync(resolve(appRoot, 'engine.lock.json'), 'utf8')) as {
  sharedRoot: string
}
const shippingRoot = resolve(appRoot, lock.sharedRoot)
const vendored = resolve(appRoot, 'vendor/scoopy/webdist')
const shippingDist = resolve(shippingRoot, 'webdist')

const fail = (msg: string): never => {
  console.error(`scoopydist:check FAILED — ${msg}`)
  process.exit(1)
}

/** Every file under `dir`, hashed, keyed by path relative to it. Dotfiles are
    skipped to match what `sharedSync` actually vendors — comparing against
    files the sync will never copy would make this permanently red. */
function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith('.')) continue
      const full = join(d, name)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      // Source maps are build output the shell never serves, and they are not
      // vendored either. Comparing them would report drift that cannot matter.
      if (name.endsWith('.map')) continue
      out.set(relative(dir, full), createHash('sha256').update(readFileSync(full)).digest('hex'))
    }
  }
  walk(dir)
  return out
}

// THE ONE CHECK THAT RUNS EVERYWHERE. A missing bundle is provable from this
// repo alone, and it is the worst case: the app serves nothing.
if (!existsSync(join(vendored, 'index.html'))) {
  fail(`vendor/scoopy/webdist is missing or empty — the merged app would serve NO web UI at all.`)
}

// TWO TIERS, the same shape `sharedSync` already uses: integrity always,
// freshness only when the sibling repo is reachable.
//
// In CI this repo is checked out ALONE, so there is no shipping tree to compare
// against and the comparison is not merely inconvenient — it is impossible. A
// gate that went red there would be failing for a reason that has nothing to do
// with the code, and a red gate nobody believes is a gate nobody reads. So it
// SKIPS, loudly, and stays a developer-machine check where the answer is real.
if (!existsSync(shippingRoot)) {
  console.log(
    `scoopydist:check SKIPPED — no shipping tree at ${lock.sharedRoot} (expected in CI, ` +
      `where this repo is checked out alone). The bundle's presence was verified; its ` +
      `freshness cannot be from here.`,
  )
  process.exit(0)
}

// ── link 1: the shipping bundle is a current build of its own sources ────────
const stampPath = join(shippingDist, '.srcstamp')
if (!existsSync(stampPath)) {
  fail(`${relative(appRoot, stampPath)} is missing — the shipping bundle cannot be proven current. ` +
    `Run: cd ${lock.sharedRoot}/web && npm run bundle:mac`)
}
let expected: string
try {
  expected = execFileSync('sh', [join(shippingRoot, 'scripts/websrc-hash.sh')], {
    encoding: 'utf8',
    cwd: shippingRoot,
  }).trim()
} catch (err) {
  fail(`could not hash the shipping app's web sources: ${(err as Error).message}`)
}
const actual = readFileSync(stampPath, 'utf8').trim()
if (expected! !== actual) {
  fail(
    `the SHIPPING bundle is stale — its web/src has changed since it was built, so anything ` +
      `vendored from it is old too. Run: cd ${lock.sharedRoot}/web && npm run bundle:mac`,
  )
}

// ── link 2: what we vendored is what they built ──────────────────────────────
const theirs = tree(shippingDist)
const ours = tree(vendored)

const missing = [...theirs.keys()].filter((k) => !ours.has(k))
const extra = [...ours.keys()].filter((k) => !theirs.has(k))
const changed = [...theirs.entries()].filter(([k, h]) => ours.has(k) && ours.get(k) !== h).map(([k]) => k)

if (missing.length || extra.length || changed.length) {
  const lines: string[] = []
  // EXTRA files are named as loudly as missing ones. `engine:sync` does not
  // PRUNE a vendored directory, so old bundles pile up and the lock blesses
  // them — three dead ones had accumulated before anyone looked.
  if (missing.length) lines.push(`  not vendored: ${missing.join(', ')}`)
  if (extra.length) lines.push(`  stale leftovers: ${extra.join(', ')}`)
  if (changed.length) lines.push(`  differs: ${changed.join(', ')}`)
  fail(
    `vendor/scoopy/webdist does not match the shipping build — the merged app would serve an OLD ` +
      `web UI, silently.\n${lines.join('\n')}\nRun: cd web && npm run engine:sync`,
  )
}

console.log(`scoopydist:check ok — ${ours.size} files, current with ${lock.sharedRoot}/webdist`)
