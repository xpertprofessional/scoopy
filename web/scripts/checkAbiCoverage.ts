/**
 * ABI coverage gate (P0-08) — the ScoopyLoops P0-08 lesson made mechanical:
 * "when two components are tested against each other, nothing tests the
 * boundary they share."
 *
 * The schema (web/protocol/schema.ts) is the UI-side authority; the engine
 * (engine/src/wz_engine.cpp) is the independently hand-written C++ authority.
 * The generated WZProtocol.h is derived FROM the schema, so checking those two
 * proves nothing. This gate compares the schema against the ENGINE SOURCE and
 * fails unless every boundary field is either carried end-to-end or listed in
 * abi-not-carried.json with a reason. There is no third state, so "nobody
 * noticed" cannot happen.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARAM_IDS, HOT_FRAME_SCALARS } from '../protocol/schema.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const enginePath = resolve(repoRoot, 'engine/src/wz_engine.cpp')
const waiverPath = resolve(repoRoot, 'engine/tools/abi-not-carried.json')

interface Waivers {
  params: Record<string, string>
  hotframe: Record<string, string>
}

interface EngineAbi {
  params: string[]
  hotFrameLength: number
}

/** Parse the engine's real ABI surface from its source. Throws (loudly) if the
 * expected declarations can't be found — a refactor that changes their shape
 * must fail the gate, never silently pass it. */
export function parseEngineAbi(source: string): EngineAbi {
  const paramsBlock = source.match(/kParamNames\[\]\s*=\s*\{([^}]*)\}/)
  if (!paramsBlock) throw new Error('ABI parse: kParamNames[] table not found in wz_engine.cpp')
  const params = [...paramsBlock[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)

  const lenMatch = source.match(/kHotFrameLength\s*=\s*(\d+)/)
  if (!lenMatch) throw new Error('ABI parse: kHotFrameLength not found in wz_engine.cpp')
  return { params, hotFrameLength: Number(lenMatch[1]) }
}

export function checkAbiCoverage(): { ok: boolean; errors: string[] } {
  const engine = parseEngineAbi(readFileSync(enginePath, 'utf8'))
  const waivers = JSON.parse(readFileSync(waiverPath, 'utf8')) as Waivers
  const errors: string[] = []

  // --- ParamWrite ids: carried (in engine table, same index) or waived. ---
  PARAM_IDS.forEach((id, i) => {
    const carriedAt = engine.params.indexOf(id)
    if (carriedAt === -1) {
      if (!(id in waivers.params))
        errors.push(`param "${id}" is in schema but not carried by the engine, and not waived`)
    } else if (carriedAt !== i) {
      // Order matters: the generated ParamId enum assigns ids by schema order,
      // so a mismatched engine index means a by-id write hits the wrong param.
      errors.push(`param "${id}" is at schema index ${i} but engine index ${carriedAt} — reorder to match`)
    }
  })
  for (const id of engine.params)
    if (!PARAM_IDS.includes(id as (typeof PARAM_IDS)[number]))
      errors.push(`engine param "${id}" is not declared in the schema (a param JS can never address)`)
  for (const id of Object.keys(waivers.params))
    if (engine.params.includes(id))
      errors.push(`param "${id}" is waived but the engine actually carries it — remove the stale waiver`)

  // --- HotFrame scalars: filled if index < engine length, else must be waived. ---
  HOT_FRAME_SCALARS.forEach((name, i) => {
    if (i >= engine.hotFrameLength && !(name in waivers.hotframe))
      errors.push(`hotframe scalar "${name}" (index ${i}) is beyond the engine's kHotFrameLength=${engine.hotFrameLength} and not waived`)
  })
  const filledCount = HOT_FRAME_SCALARS.filter((_, i) => i < engine.hotFrameLength).length
  if (engine.hotFrameLength > filledCount)
    errors.push(`engine kHotFrameLength=${engine.hotFrameLength} exceeds the ${filledCount} schema scalars it maps to`)

  return { ok: errors.length === 0, errors }
}

// CLI entry for CI: `node --experimental-strip-types scripts/checkAbiCoverage.ts`.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, errors } = checkAbiCoverage()
  if (!ok) {
    console.error('ABI coverage FAILED:\n' + errors.map((e) => '  - ' + e).join('\n'))
    process.exit(1)
  }
  console.log('ABI coverage OK')
}
