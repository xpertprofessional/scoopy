/**
 * webdist freshness gate (P0-09). The JUCE shell ships the committed
 * `webdist/` bundle and never builds the web UI itself, so a stale bundle
 * means the app runs old UI against new engine/protocol code. This records a
 * digest of every web source input into `webdist/.buildhash` at bundle time
 * and verifies it in CI.
 *
 *   node scripts/webdistFresh.ts --write   (run by `npm run bundle`)
 *   node scripts/webdistFresh.ts --check    (CI gate; exit 1 if stale)
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hashFile = resolve(webRoot, '../webdist/.buildhash')

// The closure of inputs that determine the bundle output. Anything the build
// reads must be here, or a change to it could ship silently.
// scripts/ is build tooling Vite does not bundle, so it is deliberately
// excluded — a codegen/gate edit must not flag the shipped bundle stale.
const FILE_INPUTS = ['index.html', 'vite.config.ts', 'tsconfig.json', 'package.json', 'package-lock.json']
const DIR_INPUTS = ['src', 'protocol']
const SKIP = /(\.test\.ts$|\.bak$)/ // tests/backups don't affect the shipped bundle

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    // Skip dotfiles/dotdirs: they aren't bundled and, being git-ignored
    // (.DS_Store, editor cruft), exist only locally — walking them would make
    // the local --write hash disagree with CI's checkout and flag STALE.
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (!SKIP.test(full)) out.push(full)
  }
  return out
}

/**
 * The bytes of an input that actually determine the bundle. For package.json
 * this EXCLUDES the `scripts` block: npm scripts are build/CI tooling Vite never
 * bundles (the same reason scripts/ is not a DIR_INPUT), so adding one — e.g.
 * shared:check — must not flag the shipped bundle stale. Everything else, and
 * every other field of package.json (deps, type, version), is hashed verbatim.
 */
function bundleInputBytes(abs: string): Buffer {
  if (basename(abs) === 'package.json') {
    const pkg = JSON.parse(readFileSync(abs, 'utf8')) as Record<string, unknown>
    delete pkg['scripts']
    return Buffer.from(JSON.stringify(pkg))
  }
  return readFileSync(abs)
}

export function computeSourceHash(): string {
  const files = [
    ...FILE_INPUTS.map((f) => resolve(webRoot, f)).filter(existsSync),
    ...DIR_INPUTS.flatMap((d) => walk(resolve(webRoot, d))),
  ].sort()

  const h = createHash('sha256')
  for (const f of files) {
    h.update(relative(webRoot, f))
    h.update('\0')
    h.update(bundleInputBytes(f))
    h.update('\0')
  }
  return h.digest('hex')
}

const mode = process.argv.includes('--write') ? 'write' : 'check'

if (mode === 'write') {
  writeFileSync(hashFile, computeSourceHash() + '\n')
  console.log('wrote webdist/.buildhash')
} else {
  const current = computeSourceHash()
  const stored = existsSync(hashFile) ? readFileSync(hashFile, 'utf8').trim() : ''
  if (stored !== current) {
    console.error(
      'webdist is STALE — the committed bundle does not match web source.\n' +
        'Run: cd web && npm run bundle   (then commit webdist/)',
    )
    process.exit(1)
  }
  console.log('webdist freshness OK')
}
