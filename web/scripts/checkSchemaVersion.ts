/**
 * SCHEMA VERSION COVERAGE — every host reports the SAME schema version.
 *
 *   node --experimental-strip-types scripts/checkSchemaVersion.ts
 *
 * WHY THIS EXISTS. `web/protocol/schema.ts` owns SCHEMA_VERSION. Two C++
 * constants are required to equal it, and both said so in a comment:
 *
 *   shell/src/SlDispatch.cpp   getCapabilities -> the UI compares it at boot
 *   shell/src/MergedApp.h      -> sl_engine_create, echoed in HotFrame slot 0
 *
 * On 2026-07-30 they were at 92 and 88 against a schema.ts of 96. FOUR AND
 * EIGHT VERSIONS STALE, in a repo with eight drift gates, because the two
 * things that should have caught it both structurally could not:
 *
 *   1. App.tsx:207 genuinely compares them and renders "SCHEMA MISMATCH: ui vN
 *      vs engine vM" — on the FALLBACK debug panel. Every real panel (`plane`
 *      included) returns earlier, so the backstop was defeated by routing.
 *   2. Every browser walk passed and always would: `browserLink.ts` reports the
 *      UI's OWN SCHEMA_VERSION, so the browser host agrees with itself BY
 *      CONSTRUCTION. It cannot fail this check however wrong the native host is.
 *
 * That is the shape of the defect this gate answers: a coupling checked only by
 * a comment, and "verified" by a harness that shared the value with itself.
 * Comments are not gates. Bump SCHEMA_VERSION and this fails until both hosts
 * follow — which is the whole job.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const schemaPath = resolve(appRoot, 'web/protocol/schema.ts')

/** Each C++ site that must carry SCHEMA_VERSION, with the pattern that finds it.
    Capture group 1 is the number.

    ⚠️ EVERY occurrence is checked, not the first. `sl_dispatch_test.cpp` asserts
    the version TWICE, and a gate that stopped at the first match would let the
    second rot — which is the same "checked by inspection" mistake one level in. */
const sites = [
  {
    path: 'shell/src/SlDispatch.cpp',
    what: 'getCapabilities().schemaVersion — the value App.tsx compares at boot',
    re: /setProperty\s*\(\s*"schemaVersion"\s*,\s*(\d+)\s*\)/g,
  },
  {
    path: 'shell/src/MergedApp.h',
    what: 'kScoopySchemaVersion — passed to sl_engine_create, echoed in HotFrame slot 0',
    re: /kScoopySchemaVersion\s*=\s*(\d+)/g,
  },
  {
    // The pin that DEFENDED the drift: it asserted 92 while schema.ts said 96,
    // so ctest went green across four bumps. A test's hand-written literal is a
    // place to drift, not a check, unless something holds it to the authority.
    path: 'shell/tools/sl_dispatch_test.cpp',
    what: 'the ctest assertions on getCapabilities().schemaVersion',
    re: /getProperty\s*\(\s*"schemaVersion"\s*,\s*0\s*\)\s*==\s*(\d+)/g,
  },
]

function fail(lines: string[]): never {
  console.error('schema:check FAILED — hosts disagree about the protocol version:\n')
  for (const l of lines) console.error('  ' + l)
  console.error('\n  One schema, one number. Update every site above, or the native host')
  console.error('  tells the UI it speaks a protocol it does not.')
  process.exit(1)
}

let schemaSource: string
try {
  schemaSource = readFileSync(schemaPath, 'utf8')
} catch {
  fail([`cannot read ${schemaPath} — it is the authority for SCHEMA_VERSION`])
}

const authorityMatch = /export const SCHEMA_VERSION\s*=\s*(\d+)/.exec(schemaSource)
if (!authorityMatch)
  fail([`no \`export const SCHEMA_VERSION = <n>\` in web/protocol/schema.ts — the authority is unreadable`])
const authority = Number(authorityMatch![1])

const problems: string[] = []
const found: string[] = []

for (const site of sites) {
  const full = resolve(appRoot, site.path)
  let source: string
  try {
    source = readFileSync(full, 'utf8')
  } catch {
    problems.push(`${site.path}: missing — this gate names a file that is not there`)
    continue
  }
  const matches = [...source.matchAll(site.re)]
  if (matches.length === 0) {
    // A site whose pattern stops matching is a FAILURE, never a skip: the most
    // likely cause is that someone renamed the constant, and silently checking
    // nothing is exactly how the last one survived eight bumps.
    problems.push(
      `${site.path}: could not find the version — the constant moved or was renamed.\n` +
        `      Looked for: ${site.re}\n` +
        `      (${site.what})`,
    )
    continue
  }
  const wrong = matches.map((m) => Number(m[1])).filter((v) => v !== authority)
  if (wrong.length)
    problems.push(
      `${site.path}: ${wrong.join(', ')} — schema.ts says ${authority}` +
        ` (${wrong.length} of ${matches.length} occurrence(s) stale)\n      (${site.what})`,
    )
  else found.push(`${site.path} = ${authority} ×${matches.length}`)
}

if (problems.length) fail(problems)

console.log(
  `schema:check OK — schema.ts v${authority}, and ${found.length}/${sites.length} native site(s) agree`,
)
