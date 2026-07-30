/**
 * TAPE ABI coverage — the §5 transplant is CARRIED OR WAIVED, never "nobody noticed".
 *
 *   node --experimental-strip-types scripts/checkTapeCoverage.ts
 *
 * WHY: SL-ABI-V3 §5 transplants wizard's deck surface into the merged engine
 * under sl_tape_* names. That is a 21-entry-point rename, and a rename is
 * exactly the shape of change where something falls off the end quietly — the
 * codebase has a standing law against hand-mirrored mappings for this reason
 * (see generateTrackParams.ts's header: a mis-mapped field is written into the
 * WRONG parameter, which is worse than one not carried at all).
 *
 * Unlike the track-param/HotFrame/worldmap generators there is nothing to EMIT
 * here — the tape surface is hand-written C, because the signatures genuinely
 * changed (a record SOURCE KIND replaced a pair of channel indices). What can
 * still be mechanised is the COVERAGE, so that is what this gates:
 *
 *   authority : slengine/tape-donor-surface.json — the frozen wz_deck_* list
 *   ported    : slengine/include/sl_engine.h     — every sl_tape_* declaration
 *   waivers   : slengine/tape-not-carried.json
 *
 * ⚠️ THE AUTHORITY MOVED AT H2a. It used to be parsed live out of
 * `engine/include/wz_engine.h`. D-SL-ONEHOST-01 retired that header and the
 * engine behind it, and this gate died with an ENOENT stack trace — a gate
 * whose authority can vanish is a gate that stops asking rather than one that
 * fails. The donor surface is now a SNAPSHOT, which is the honest shape: a
 * retired donor cannot drift, so those 21 names are a historical constant.
 *
 * The rule is symmetric, which is the point. Every donor entry point must be
 * carried under its sl_tape_ name or waived WITH A REASON; and every sl_tape_
 * entry point with no donor counterpart must be declared as a deliberate v3
 * addition, also with a reason. Both directions, so neither "we dropped one" nor
 * "we invented one" can happen silently. A waiver naming a function that no
 * longer exists is itself a failure — stale waivers are how a gate rots into a
 * rubber stamp.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const donorPath = resolve(appRoot, 'slengine/tape-donor-surface.json')
const portedPath = resolve(appRoot, 'slengine/include/sl_engine.h')
const waiverPath = resolve(appRoot, 'slengine/tape-not-carried.json')

class CoverageFailed extends Error {}

/** Strip // and /* *\/ comments so a name MENTIONED in prose is never mistaken
    for a declaration. The donor header discusses wz_deck_* in its comments. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** Declared functions with the given prefix, in the order they appear. A
    "declaration" is the name followed by `(` — so a bare mention cannot count. */
function declarations(path: string, prefix: string): string[] {
  const source = stripComments(readFileSync(path, 'utf8'))
  const re = new RegExp(`\\b(${prefix}[a-z0-9_]*)\\s*\\(`, 'g')
  const names = [...source.matchAll(re)].map((m) => m[1]!)
  if (names.length === 0) throw new CoverageFailed(`no ${prefix}* declarations found in ${path}`)
  return [...new Set(names)].sort()
}

/** The frozen donor surface (see slengine/tape-donor-surface.json). Validated
    rather than trusted: this file replaced a parsed header, and a snapshot that
    silently read as empty would turn every coverage question below into a
    vacuous pass — the exact failure mode the ENOENT it replaced could not have. */
function donorSurface(path: string): string[] {
  let parsed: { donor?: unknown }
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as { donor?: unknown }
  } catch (e) {
    throw new CoverageFailed(
      `${path} is missing or not valid JSON — it is the frozen wz_deck_* donor surface ` +
        `this gate checks against (${(e as Error).message})`,
    )
  }
  const donor = parsed.donor
  if (!Array.isArray(donor) || donor.length === 0)
    throw new CoverageFailed(`${path} has no non-empty "donor" array — the gate has nothing to check against`)
  for (const name of donor)
    if (typeof name !== 'string' || !/^wz_deck_[a-z0-9_]+$/.test(name))
      throw new CoverageFailed(`${path}: "${String(name)}" is not a wz_deck_* entry point name`)
  return [...new Set(donor as string[])].sort()
}

type Waivers = {
  notCarried?: { name: string; reason: string }[]
  additions?: { name: string; reason: string }[]
}

function readWaivers(): Waivers {
  let raw: string
  try {
    raw = readFileSync(waiverPath, 'utf8')
  } catch {
    throw new CoverageFailed(`missing ${waiverPath} — the gate needs a waiver file, even an empty one`)
  }
  const parsed = JSON.parse(raw) as Waivers
  for (const key of ['notCarried', 'additions'] as const) {
    for (const entry of parsed[key] ?? []) {
      if (!entry.name) throw new CoverageFailed(`a ${key} waiver has no name`)
      if (!entry.reason || entry.reason.trim().length < 10)
        throw new CoverageFailed(
          `${key} waiver "${entry.name}" has no real reason — a waiver without one is just a silent drop`,
        )
    }
  }
  return parsed
}

try {
  const donor = donorSurface(donorPath)
  const ported = declarations(portedPath, 'sl_tape_')
  const waivers = readWaivers()

  const portedSet = new Set(ported)
  const waivedNotCarried = new Map((waivers.notCarried ?? []).map((w) => [w.name, w.reason]))
  const declaredAdditions = new Map((waivers.additions ?? []).map((w) => [w.name, w.reason]))

  const problems: string[] = []

  // 1. Every donor entry point is carried or waived.
  const dropped: string[] = []
  for (const wz of donor) {
    const expected = wz.replace(/^wz_deck_/, 'sl_tape_')
    if (portedSet.has(expected)) continue
    if (waivedNotCarried.has(wz)) continue
    dropped.push(`${wz}  (expected as ${expected})`)
  }
  if (dropped.length)
    problems.push(
      `${dropped.length} donor entry point(s) neither carried nor waived:\n` +
        dropped.map((d) => `    - ${d}`).join('\n'),
    )

  // 2. Every ported entry point traces back, or is a declared addition.
  const donorSet = new Set(donor)
  const invented: string[] = []
  for (const sl of ported) {
    const origin = sl.replace(/^sl_tape_/, 'wz_deck_')
    if (donorSet.has(origin)) continue
    if (declaredAdditions.has(sl)) continue
    invented.push(sl)
  }
  if (invented.length)
    problems.push(
      `${invented.length} sl_tape_* entry point(s) with no donor counterpart and no declared reason:\n` +
        invented.map((d) => `    - ${d}`).join('\n'),
    )

  // 3. Stale waivers — a waiver for something that is now carried, or for a
  //    function that no longer exists, quietly turns the gate into decoration.
  for (const [name] of waivedNotCarried) {
    if (!donorSet.has(name)) problems.push(`stale notCarried waiver: ${name} is not a donor entry point`)
    else if (portedSet.has(name.replace(/^wz_deck_/, 'sl_tape_')))
      problems.push(`stale notCarried waiver: ${name} IS carried now — delete the waiver`)
  }
  for (const [name] of declaredAdditions) {
    if (!portedSet.has(name)) problems.push(`stale additions entry: ${name} is not declared in the ABI`)
    else if (donorSet.has(name.replace(/^sl_tape_/, 'wz_deck_')))
      problems.push(`stale additions entry: ${name} has a donor counterpart — it is carried, not added`)
  }

  if (problems.length) {
    console.error('tape:check FAILED — the §5 transplant is not fully accounted for:\n')
    for (const p of problems) console.error('  ' + p + '\n')
    console.error(`  Carry it under its sl_tape_ name, or add a waiver with a reason to`)
    console.error(`  ${waiverPath}`)
    process.exit(1)
  }

  const carried = donor.length - waivedNotCarried.size
  console.log(
    `tape:check OK — ${carried}/${donor.length} donor entry points carried, ` +
      `${waivedNotCarried.size} waived, ${declaredAdditions.size} v3 addition(s) declared`,
  )
} catch (e) {
  if (e instanceof CoverageFailed) {
    console.error('tape:check FAILED:')
    console.error('  ' + e.message)
    process.exit(1)
  }
  throw e
}
