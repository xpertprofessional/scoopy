/**
 * The cross-language handshake fixture — `web/fixtures/session/session-from-ts.zip`.
 *
 *   npm run session:generate            (write)
 *
 * WHY THIS IS A SCRIPT AND NOT A TEST. The fixture is a `.scoopySession` written by the TypeScript
 * packer and read back by the desktop's Swift suite (`SessionZipTests.opensAZipWrittenByTypeScript`)
 * — the far half of an interop proof neither language is allowed to grade alone. It used to be
 * (re)written by `sessionPackage.zip.test.ts` on every `npm test`, which made the default gate
 * MUTATE a tracked file: `git status` was dirty after any run, so the suite was not reproducible and
 * a tracked file that dirties itself is a standing invitation to a stray `git add -A` in a tree
 * several agents share (P11-5d). Regeneration is now deliberate — the same shape `hotframe`,
 * `worldmap` and `trackparams` already use — and the suite only COMPARES.
 *
 * ⚠️ The fixture cannot be gitignored instead: the Swift half lives in another tree and reads this
 * file out of the repository, so it has to stay committed. What keeps it from silently rotting is
 * `sessionPackage.zip.test.ts` — "the committed archive the SWIFT suite opens is still what we write
 * today" goes red the moment `packSession`'s output moves, and names this script.
 *
 * ⚠️ The SOURCE is `session.zip`, the Swift-written package. The fixture is deliberately a
 * round-trip of the real desktop archive, not a synthetic one: a handshake proved with a fake thin
 * enough to pass either way proves nothing.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { packSession, unpackSession } from '../src/persist/sessionPackage.ts'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = resolve(webRoot, 'fixtures/session')
const sourcePath = resolve(fixtures, 'session.zip')
const outPath = resolve(fixtures, 'session-from-ts.zip')

const bytes = packSession(unpackSession(new Uint8Array(readFileSync(sourcePath))))

// Idempotent on purpose: a generator that rewrites an identical file still dirties the tree in some
// filesystems' eyes and, more to the point, tells the reader nothing. Only report real movement.
let unchanged = false
try {
  const existing = new Uint8Array(readFileSync(outPath))
  unchanged = existing.length === bytes.length && existing.every((b, i) => b === bytes[i])
} catch {
  unchanged = false
}

if (unchanged) {
  console.log(`session:generate — ${outPath} already matches packSession (${bytes.length} bytes)`)
} else {
  writeFileSync(outPath, bytes)
  console.log(`session:generate — wrote ${outPath} (${bytes.length} bytes)`)
  console.log('  commit it: the desktop Swift suite opens this file.')
}
