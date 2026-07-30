/**
 * THE PARAM SEAM GATE — the merged shell's name map, checked against both ends.
 *
 * WHAT THIS PROTECTS, in one sentence: a control that moves on screen and
 * reaches nothing. That defect has cost this phase repeatedly — `slParam` was
 * received and DROPPED for the whole of P2 and P3-1, and four methods missing
 * from `MergedLink.NATIVE_METHODS` meant map save had never worked in the merged
 * app. Neither crashed. Neither logged. Both were invisible until someone needed
 * the feature.
 *
 * WHY IT REPLACED `checkAbiCoverage` FOR THE V3 ENGINE. That gate compared the
 * schema's param list against the engine's, index for index, which was the right
 * safety property for wizard's ABI v1: its `ParamId` enum was positional and
 * SHARED, so a mismatched index meant a write landing on the wrong param. Three
 * things make that model wrong here:
 *
 *   1. v3 resolves params BY NAME at boot (`sl_param_id_for_name`) — ABI.md's
 *      keyed-params rule — so the engine's internal index is deliberately
 *      private and index equality asserts a constraint v3 rejects on purpose.
 *   2. The two vocabularies DO NOT OVERLAP. scoopy's `PARAM_IDS` are Swift-era
 *      names (`deckTranspose`, `deckVolume`, `masterTempo`); the engine's deck
 *      params are engine-domain (`transpose`, `syncRatio`, `tempoMode`). The
 *      shell TRANSLATES, so the seam is the translation, not either list.
 *   3. v3's HotFrame length is GENERATED from the schema, so checking it against
 *      the schema proves nothing — the exact trap `abiCoverage.ts`'s own header
 *      warns about. `hotframe:check` covers that surface honestly.
 *
 * So the boundary moved, and this follows it. Three checks, each a real bug:
 *
 *   a mapping TARGET the engine does not have   → sl_param_id_for_name returns
 *       SL_PARAM_UNKNOWN and the write is dropped, silently.
 *   a mapping SOURCE the schema does not have   → the UI can never send that
 *       name, so the row is dead and the control it was for is unwired.
 *   an engine param NOTHING MAPS TO             → built, reachable from C, and
 *       unreachable from the app. Waive it with a reason or wire it.
 *
 * Run: npm run params:check
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARAM_IDS } from '../protocol/schema.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
// `shell/src/MergedApp.cpp` since H3, which moved the shell's assembly out of
// MergedMain.cpp into a library so a walk could drive it. The gate caught the
// move by THROWING (see parseShellMap's contract below) rather than finding an
// empty table and passing — which is the whole reason that contract is written
// the way it is.
const SHELL = resolve(repoRoot, 'shell/src/MergedApp.cpp')
const ENGINE = resolve(repoRoot, 'slengine/src/sl_engine.cpp')
const WAIVERS = resolve(repoRoot, 'slengine/param-map-not-wired.json')

/** The shell's `kParamMap` rows. Throws if the table cannot be found: a refactor
    that changes its shape must FAIL the gate, never silently empty it — an empty
    map would otherwise pass every check below while dropping every param. */
export function parseShellMap(source: string): { scoopy: string; engine: string }[] {
  const block = source.match(/kParamMap\[\]\s*=\s*\{([\s\S]*?)\n\s*\};/)
  if (!block) throw new Error(`param-map parse: kParamMap[] not found in ${SHELL}`)
  const rows = [...block[1]!.matchAll(/\{\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\}/g)]
  if (rows.length === 0) throw new Error('param-map parse: kParamMap[] is empty')
  return rows.map((m) => ({ scoopy: m[1]!, engine: m[2]! }))
}

/** The engine's deck-scope param names (SL-ABI-V3 §3). */
export function parseEngineDeckParams(source: string): string[] {
  const block = source.match(/kDeckParamNames\[\]\s*=\s*\{([^}]*)\}/)
  if (!block) throw new Error(`param-map parse: kDeckParamNames[] not found in ${ENGINE}`)
  const names = [...block[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)
  if (names.length === 0) throw new Error('param-map parse: kDeckParamNames[] is empty')
  return names
}

export function checkParamMap(): { ok: boolean; errors: string[] } {
  const map = parseShellMap(readFileSync(SHELL, 'utf8'))
  const engineParams = parseEngineDeckParams(readFileSync(ENGINE, 'utf8'))
  const waivers = JSON.parse(readFileSync(WAIVERS, 'utf8')) as {
    notWired: Record<string, string>
  }
  const errors: string[] = []

  for (const row of map) {
    if (!engineParams.includes(row.engine))
      errors.push(
        `shell maps "${row.scoopy}" → "${row.engine}", which the engine does not carry ` +
          `(sl_param_id_for_name would return SL_PARAM_UNKNOWN and the write would be dropped)`,
      )
    if (!(PARAM_IDS as readonly string[]).includes(row.scoopy))
      errors.push(
        `shell maps "${row.scoopy}", which is not a schema PARAM_ID — the UI can never send it, ` +
          `so this row is dead`,
      )
  }

  const mapped = new Set(map.map((r) => r.engine))
  for (const name of engineParams) {
    if (mapped.has(name)) continue
    if (!(name in waivers.notWired))
      errors.push(
        `engine deck param "${name}" is reachable from C but nothing in the shell maps to it, ` +
          `and it is not waived — wire it or record why not`,
      )
  }
  for (const name of Object.keys(waivers.notWired)) {
    if (!engineParams.includes(name))
      errors.push(`waiver names "${name}", which the engine does not carry — remove the stale waiver`)
    else if (mapped.has(name))
      errors.push(`"${name}" is waived but the shell DOES map to it — remove the stale waiver`)
  }

  return { ok: errors.length === 0, errors }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, errors } = checkParamMap()
  if (!ok) {
    console.error('param map FAILED:\n' + errors.map((e) => '  - ' + e).join('\n'))
    process.exit(1)
  }
  console.log('param map OK')
}
