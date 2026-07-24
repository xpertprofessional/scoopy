/**
 * shared:sync / shared:check — the "vendored but verified" gate for the xpert
 * coherence layer. Mirrors the webdistFresh.ts / protocol:check culture: files
 * from the shared/ repo are VENDORED (committed) into each app at their normal
 * paths, and a lock file pins each one by content hash so drift is detected, not
 * prevented — exactly the loose-coupling the workspace asks for.
 *
 *   node --experimental-strip-types scripts/sharedSync.ts --check   (CI gate)
 *   node --experimental-strip-types scripts/sharedSync.ts --write   (resync from shared/)
 *
 * `--lock <file>` selects a different lock at the app root (default
 * shared.lock.json). A second lock with its own `sharedRoot` lets an app pin
 * vendored copies from a SIBLING repo with the same mechanism — the merge's
 * engine lock (wizard vendoring scoopy's portable core) is the first user.
 *
 * Two tiers:
 *   integrity — every vendored path hashes to the sha the lock records. ALWAYS
 *               runs, needs no network and no umbrella sibling: a lifted-out app
 *               still verifies it hasn't locally forked a shared file.
 *   freshness — only when the shared/ repo is reachable: warn (or fail under
 *               --strict) when the lock's sharedCommit is behind shared HEAD.
 *
 * A file may be marked `"diverged": true` in the lock: a deliberate, loud local
 * fork (integrity is skipped for it, freshness still reports it) so a hot-fix on
 * a machine without the umbrella is a named state, never a silent hash failure.
 *
 * This script is itself vendored (it is an entry in the lock), so `--check`
 * verifies the gate too.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// web/scripts/sharedSync.ts → web/scripts → web → <appRoot>
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const lockFlag = process.argv.indexOf('--lock')
const lockName = lockFlag >= 0 ? (process.argv[lockFlag + 1] ?? '') : 'shared.lock.json'
if (!lockName) {
  console.error('--lock needs a file name (app-root-relative)')
  process.exit(1)
}
const lockPath = resolve(appRoot, lockName)
// apps live at <umbrella>/apps/<app>; shared/ is <umbrella>/shared.
const defaultSharedRoot = resolve(appRoot, '../../shared')

interface LockEntry {
  /** Path inside the shared/ repo this vendored copy came from. */
  from: string
  /** sha256 of the LF-normalized content (file) or tree digest (directory). */
  sha256: string
  /** Deliberate local fork — integrity check skipped, reported by freshness. */
  diverged?: boolean
}

interface Lock {
  /** shared/ commit the vendored copies were last synced from. */
  sharedCommit: string
  /** Override the umbrella-relative shared/ location if needed. */
  sharedRoot?: string
  /** app-relative vendored path → provenance. */
  files: Record<string, LockEntry>
}

/** LF-normalized sha256 of one file — CRLF checkouts must not read as drift. */
function hashFile(abs: string): string {
  const buf = readFileSync(abs)
  const norm = buf.includes(13) ? Buffer.from(buf.toString('binary').replace(/\r\n/g, '\n'), 'binary') : buf
  return createHash('sha256').update(norm).digest('hex')
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** Tree digest: each file's relpath + its LF-normalized content, sorted. */
function hashTree(absDir: string): string {
  const h = createHash('sha256')
  for (const f of walk(absDir)) {
    h.update(relative(absDir, f))
    h.update('\0')
    h.update(hashFile(f))
    h.update('\0')
  }
  return h.digest('hex')
}

function hashPath(abs: string): string {
  return statSync(abs).isDirectory() ? hashTree(abs) : hashFile(abs)
}

function gitHead(repo: string): string | null {
  try {
    return execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function copyPath(fromAbs: string, toAbs: string): void {
  if (statSync(fromAbs).isDirectory()) {
    mkdirSync(toAbs, { recursive: true })
    for (const f of walk(fromAbs)) {
      const dest = join(toAbs, relative(fromAbs, f))
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(f, dest)
    }
  } else {
    mkdirSync(dirname(toAbs), { recursive: true })
    copyFileSync(fromAbs, toAbs)
  }
}

function loadLock(): Lock {
  if (!existsSync(lockPath)) {
    console.error(`shared:check — no shared.lock.json at ${lockPath}`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(lockPath, 'utf8')) as Lock
}

const mode = process.argv.includes('--write') ? 'write' : 'check'
const strict = process.argv.includes('--strict')
const lock = loadLock()
const sharedRoot = resolve(appRoot, lock.sharedRoot ?? defaultSharedRoot)

if (mode === 'write') {
  if (!existsSync(sharedRoot)) {
    console.error(`shared:sync --write needs the shared/ repo at ${sharedRoot}`)
    process.exit(1)
  }
  for (const [appRel, entry] of Object.entries(lock.files)) {
    if (entry.diverged) {
      console.log(`skip (diverged): ${appRel}`)
      continue
    }
    const src = resolve(sharedRoot, entry.from)
    const dst = resolve(appRoot, appRel)
    copyPath(src, dst)
    entry.sha256 = hashPath(dst)
    console.log(`synced ${appRel}  ←  ${relative(appRoot, src)}`)
  }
  const head = gitHead(sharedRoot)
  if (head) lock.sharedCommit = head
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n')
  console.log(`updated ${lockName} (sharedCommit ${lock.sharedCommit.slice(0, 12)})`)
} else {
  const errors: string[] = []
  const notes: string[] = []
  for (const [appRel, entry] of Object.entries(lock.files)) {
    const abs = resolve(appRoot, appRel)
    if (entry.diverged) {
      notes.push(`DIVERGED (local fork, integrity skipped): ${appRel}`)
      continue
    }
    if (!existsSync(abs)) {
      errors.push(`missing vendored path: ${appRel}`)
      continue
    }
    const actual = hashPath(abs)
    if (actual !== entry.sha256)
      errors.push(`drift: ${appRel} was edited locally — resync (edit in shared/, then npm run shared:sync)`)
  }

  // Freshness tier — best-effort, never blocks unless --strict.
  const head = existsSync(sharedRoot) ? gitHead(sharedRoot) : null
  if (head && head !== lock.sharedCommit) {
    const msg = `shared/ is at ${head.slice(0, 12)}; lock pins ${lock.sharedCommit.slice(0, 12)} — run npm run shared:sync to catch up`
    if (strict) errors.push(msg)
    else notes.push('stale: ' + msg)
  }

  console.log(`shared:check — pinned ${lock.sharedCommit.slice(0, 12)}, ${Object.keys(lock.files).length} vendored paths`)
  for (const n of notes) console.log('  · ' + n)
  if (errors.length) {
    console.error('shared:check FAILED:')
    for (const e of errors) console.error('  - ' + e)
    process.exit(1)
  }
  console.log('shared:check OK')
}
