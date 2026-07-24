/**
 * SL v3 track-param mapping — DERIVED, never hand-written.
 *
 *   node --experimental-strip-types scripts/generateTrackParams.ts            (write)
 *   node --experimental-strip-types scripts/generateTrackParams.ts --check    (CI gate)
 *
 * WHY THIS EXISTS
 *
 * SL ABI v3 cannot LINK the vendored v2 C ABI — v3 reuses v2's spellings with
 * different signatures, so the two can never share a link line (SL-ABI-V3.md,
 * P1-STATUS.md). But v3 still needs v2's keyed track-param layer: the SL_T_* /
 * SL_TA_* enums and the ~112 assignments mapping them onto NativeTrackSnapshot
 * fields.
 *
 * Hand-porting that is the single most dangerous edit in this merge. The
 * vendored header says it plainly on `sl_param_id`: a hand-mirrored table's
 * failure mode is that a field is silently written into the WRONG parameter,
 * which is worse than not being carried at all. 112 lines of that is a coin
 * flip repeated 112 times.
 *
 * So it is generated from the pinned v2 source, which stays the ONE authority.
 *
 * HOW IT IS SAFE
 *
 * The generator does NOT try to understand the C++. Every case in v2 is a
 * single statement (verified: 91/91 scalar, 21/21 array), so the right-hand
 * side is transcribed VERBATIM — `static_cast<StereoMode>(i())`,
 * `clampChokeGroup(i())` and a plain `v` all survive without the generator
 * knowing what any of them mean.
 *
 * What it does check is COMPLETENESS, and it refuses to emit if any of these
 * fail — a generator that emits 90 of 91 mappings is worse than none, because
 * the result looks finished:
 *   · every enum member has exactly one case
 *   · every enum member appears in the name table
 *   · the name table and the enum agree on length and order
 *   · no case names an enum member that does not exist
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const v2Header = resolve(appRoot, 'vendor/scoopy/engine/include/sl_engine.h')
const v2Source = resolve(appRoot, 'vendor/scoopy/engine/src/sl_engine.cpp')
const outPath = resolve(appRoot, 'slengine/generated/sl_track_params.inc')

class GenerationRefused extends Error {}

/** Enum members in declaration order, minus the trailing _COUNT sentinel. */
function enumMembers(header: string, prefix: string, sentinel: string): string[] {
  // Matched by its SENTINEL rather than by prefix: the two enums' sentinels are
  // spelled differently (SL_T_SCALAR_COUNT vs SL_TA_COUNT), and guessing
  // `<prefix>COUNT` silently found neither.
  const re = new RegExp(`typedef enum \\{([\\s\\S]*?)\\}\\s*sl_\\w+;`, 'g')
  for (const m of header.matchAll(re)) {
    const bodyText = m[1] ?? ''
    if (!bodyText.includes(sentinel)) continue
    // Strip comments across the WHOLE body before splitting into lines: several
    // members carry multi-line /* … */ notes that NAME other members, and a
    // per-line strip leaves those names looking like declarations. That read 93
    // members where there are 91 — caught only because the completeness check
    // then disagreed with the name table.
    const uncommented = bodyText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const names: string[] = []
    for (const line of uncommented.split('\n')) {
      const withoutComments = line
      const nm = withoutComments.match(new RegExp(`\\b(${prefix}\\w+)\\b`))
      if (!nm) continue
      const name = nm[1]!
      if (name === sentinel) continue
      // An explicit value is only tolerated when it agrees with position —
      // otherwise the index-ordered name table below would silently misalign.
      const explicit = withoutComments.match(/=\s*(\d+)/)
      if (explicit && Number(explicit[1]) !== names.length)
        throw new GenerationRefused(
          `${name} is explicitly = ${explicit[1]} but sits at index ${names.length}; ` +
          `the generator assumes declaration order IS the value`)
      names.push(name)
    }
    return names
  }
  throw new GenerationRefused(`no enum containing ${sentinel} in ${v2Header}`)
}

/** The body of a top-level function definition, by its signature prefix. */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature)
  if (start < 0) throw new GenerationRefused(`missing ${signature} in ${v2Source}`)
  const end = source.indexOf('\n}\n', start)
  if (end < 0) throw new GenerationRefused(`unterminated ${signature}`)
  return source.slice(start, end)
}

/** case → verbatim statement. Refuses anything that is not one statement. */
function cases(body: string, prefix: string): Map<string, string> {
  const out = new Map<string, string>()
  const all = [...body.matchAll(new RegExp(`case\\s+(${prefix}\\w+)\\s*:`, 'g'))].map((m) => m[1]!)
  for (const m of body.matchAll(
    new RegExp(`case\\s+(${prefix}\\w+)\\s*:\\s*([^;{}]*;)\\s*break;`, 'g'))) {
    const name = m[1]!
    if (out.has(name)) throw new GenerationRefused(`duplicate case ${name}`)
    out.set(name, m[2]!.trim())
  }
  const missed = all.filter((c) => !out.has(c))
  if (missed.length)
    throw new GenerationRefused(
      `these cases are not a single statement and cannot be transcribed verbatim: ${missed.join(', ')}`)
  return out
}

/** Names as the v2 lookup table declares them, in table order. */
function nameTable(source: string, tableName: string, prefix: string): string[] {
  const start = source.indexOf(`${tableName}[] = {`)
  if (start < 0) throw new GenerationRefused(`missing ${tableName} in ${v2Source}`)
  const end = source.indexOf('};', start)
  const body = source.slice(start, end)
  return [...body.matchAll(new RegExp(`\\{"(${prefix}\\w+)",\\s*(${prefix}\\w+)\\}`, 'g'))]
    .map((m) => {
      if (m[1] !== m[2])
        throw new GenerationRefused(`${tableName}: "${m[1]}" is bound to ${m[2]} — the string and the enum disagree`)
      return m[1]!
    })
}

/** v2-local free functions the statements call; carried verbatim so the output
    compiles standalone. Distinct from the conversion lambdas, which are
    extracted per setter (below) rather than listed here. */
const CARRIED_HELPERS = ['clampChokeGroup']

/** The helper preamble of a setter: everything between the `t` binding and the
    switch. That region IS the conversion lambdas — `f/b/i/z` for the scalar
    setter, `asFloat/asSize/…` for the array one, which take different captures
    and different arguments. Emitting it verbatim beats listing the names,
    because a new helper in v2 then arrives automatically instead of surfacing
    as an unresolved call. */
function lambdaPreamble(body: string): string {
  const anchor = 'NativeTrackSnapshot& t = e->track;'
  const start = body.indexOf(anchor)
  if (start < 0) throw new GenerationRefused('setter does not bind `t` where expected')
  const end = body.indexOf('switch (param)', start)
  if (end < 0) throw new GenerationRefused('setter has no switch (param)')
  return body.slice(start + anchor.length, end).trim()
}

/** Names declared by a preamble — the set the audit may treat as resolvable. */
function declaredHelpers(preamble: string): Set<string> {
  return new Set([...preamble.matchAll(/const auto (\w+)\s*=/g)].map((m) => m[1]!))
}

function helperDefinitions(source: string): string[] {
  const out: string[] = []
  for (const name of CARRIED_HELPERS) {
    // A line scan rather than a regex: the definition is a one-line `static`
    // function, and building the pattern in a template literal turned `\b` into
    // a backspace escape.
    const line = source.split('\n').find((l) => l.startsWith('static ') && l.includes(name + '('))
    if (!line) throw new GenerationRefused(`cannot find the definition of helper ${name} to carry`)
    out.push(line.trim())
  }
  return out
}

/** Refuses on any call the output could not resolve. */
function auditCalls(statements: string[], known: Set<string>): void {
  const unknown = new Set<string>()
  for (const st of statements)
    for (const m of st.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) {
      const name = m[1]!
      if (known.has(name) || CARRIED_HELPERS.includes(name)) continue
      if (['static_cast', 'decltype', 'sizeof'].includes(name)) continue
      unknown.add(name)
    }
  if (unknown.size)
    throw new GenerationRefused(
      `the mapping calls ${[...unknown].join(', ')}, which the generated file cannot resolve — ` +
      `add it to CARRIED_HELPERS (and check it is safe to copy) or teach the generator about it`)
}

function build(kind: { prefix: string; setter: string; table: string; label: string; sentinel: string },
               header: string, source: string) {
  const members = enumMembers(header, kind.prefix, kind.sentinel)
  const setterBody = functionBody(source, kind.setter)
  const caseMap = cases(setterBody, kind.prefix)
  const names = nameTable(source, kind.table, kind.prefix)
  const preamble = lambdaPreamble(setterBody)
  auditCalls([...caseMap.values()], declaredHelpers(preamble))

  const missingCase = members.filter((m) => !caseMap.has(m))
  if (missingCase.length)
    throw new GenerationRefused(`${kind.label}: no case carries ${missingCase.join(', ')}`)
  const strayCase = [...caseMap.keys()].filter((c) => !members.includes(c))
  if (strayCase.length)
    throw new GenerationRefused(`${kind.label}: case for unknown member ${strayCase.join(', ')}`)
  const missingName = members.filter((m) => !names.includes(m))
  if (missingName.length)
    throw new GenerationRefused(`${kind.label}: not name-resolvable: ${missingName.join(', ')}`)
  if (names.length !== members.length)
    throw new GenerationRefused(
      `${kind.label}: name table has ${names.length} entries, enum has ${members.length}`)

  return { members, caseMap, preamble }
}

const KINDS = [
  { prefix: 'SL_T_', setter: 'void sl_snapshot_track_set(', table: 'kScalarNames', label: 'scalar',
    sentinel: 'SL_T_SCALAR_COUNT' },
  { prefix: 'SL_TA_', setter: 'void sl_snapshot_track_set_array(', table: 'kArrayNames', label: 'array',
    sentinel: 'SL_TA_COUNT' },
] as const

function generate(): string {
  const header = readFileSync(v2Header, 'utf8')
  const source = readFileSync(v2Source, 'utf8')
  const scalar = build(KINDS[0], header, source)
  const array = build(KINDS[1], header, source)
  const helpers = helperDefinitions(source)

  const lockCommit = (() => {
    try {
      return JSON.parse(readFileSync(resolve(appRoot, 'engine.lock.json'), 'utf8')).sharedCommit as string
    } catch { return 'unknown' }
  })()

  const macroName = (label: string) => label.toUpperCase()
  const asMacro = (name: string, lines: string[]) =>
    [`#define ${name} \\`, ...lines.map((l, i) => `    ${l}${i === lines.length - 1 ? '' : ' \\'}`)]

  const emit = (k: { prefix: string; label: string; sentinel: string },
                g: { members: string[]; caseMap: Map<string, string>; preamble: string }) => [
    `// ---- ${k.label} track params (${g.members.length}) ----`,
    `enum { ${g.members.map((m, i) => `${m} = ${i}`).join(', ')}, ${k.sentinel} };`,
    ``,
    `static const char* const k${k.label === 'scalar' ? 'Scalar' : 'Array'}ParamNames[] = {`,
    ...g.members.map((m) => `    "${m}",`),
    `};`,
    ``,
    `// The conversion helpers these cases call, verbatim from the v2 setter.`,
    ...asMacro(`SL_V3_${macroName(k.label)}_PARAM_LAMBDAS`,
               g.preamble.split('\n').map((l) => l.trim()).filter(Boolean)),
    ``,
    ...asMacro(`SL_V3_${macroName(k.label)}_PARAM_CASES`,
               g.members.map((m) => `case ${m}: ${g.caseMap.get(m)} break;`)),
    ``,
  ].join('\n')

  return [
    `// GENERATED by web/scripts/generateTrackParams.ts — DO NOT EDIT.`,
    `//`,
    `// Derived from the hash-pinned vendored v2 ABI (engine.lock.json`,
    `// sharedCommit ${lockCommit.slice(0, 12)}), which stays the one authority for this`,
    `// mapping. v3 cannot link that library — it reuses v2's spellings with different`,
    `// signatures — so the mapping is transcribed here instead of duplicated by hand.`,
    `//`,
    `// The assignments are copied VERBATIM: the generator never interprets them, so`,
    `// static_cast<>, clamps and raw doubles all survive unchanged. It refuses to`,
    `// emit unless every enum member has exactly one case and is name-resolvable.`,
    `//`,
    `// Regenerate: npm run trackparams:generate  ·  Verify: npm run trackparams:check`,
    ``,
    `// ---- helpers carried verbatim from the v2 source ----`,
    `// The consumer supplies the f/b/i/z conversion lambdas (they close over the`,
    `// incoming double); these are v2-local functions the assignments call.`,
    ...helpers,
    ``,
    emit(KINDS[0], scalar),
    emit(KINDS[1], array),
  ].join('\n')
}

const check = process.argv.includes('--check')
try {
  const text = generate()
  if (check) {
    if (!existsSync(outPath)) {
      console.error(`trackparams:check FAILED — ${outPath} does not exist; run npm run trackparams:generate`)
      process.exit(1)
    }
    if (readFileSync(outPath, 'utf8') !== text) {
      console.error('trackparams:check FAILED — the generated mapping is stale.')
      console.error('The vendored v2 ABI changed; run npm run trackparams:generate and review the diff.')
      process.exit(1)
    }
    const n = (text.match(/case SL_T\w*_?\w+:/g) ?? []).length
    console.log(`trackparams:check OK (${n} mappings, in sync with the pinned v2 ABI)`)
  } else {
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, text)
    console.log(`wrote ${outPath}`)
  }
} catch (e) {
  if (e instanceof GenerationRefused) {
    // Refusing is the feature. A partial mapping looks complete and is not.
    console.error('REFUSED to generate the track-param mapping:')
    console.error('  ' + e.message)
    console.error('Fix the mismatch (or teach the generator the new shape) — do NOT hand-edit the output.')
    process.exit(1)
  }
  throw e
}