/**
 * ABI coverage gate — the ScoopyLoops lesson made mechanical: "when two
 * components are tested against each other, nothing tests the boundary they
 * share."
 *
 * The protocol schema is the UI-side authority; the engine .cpp is the
 * independently hand-written C++ authority. The generated protocol header is
 * derived FROM the schema, so checking those two proves nothing. This gate
 * compares the schema against the ENGINE SOURCE and fails unless every boundary
 * field is either carried end-to-end or listed in abi-not-carried.json with a
 * reason. There is no third state, so "nobody noticed" cannot happen.
 *
 * Vendored, not linked — see shared/README.md. Each app supplies its own paths
 * and schema tables via AbiCheckConfig.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

export interface AbiCheckConfig {
  /** Absolute path to the engine translation unit holding the ABI tables. */
  enginePath: string
  /** Absolute path to the app's abi-not-carried.json waiver file. */
  waiverPath: string
  /** PARAM_IDS from the app's schema, in schema order. */
  paramIds: readonly string[]
  /** HOT_FRAME_SCALARS from the app's schema, in schema order. */
  hotFrameScalars: readonly string[]
}

interface Waivers {
  params: Record<string, string>
  hotframe: Record<string, string>
}

export interface EngineAbi {
  params: string[]
  hotFrameLength: number
}

/**
 * Parse the engine's real ABI surface from its source. Throws (loudly) if the
 * expected declarations can't be found — a refactor that changes their shape
 * must fail the gate, never silently pass it.
 */
export function parseEngineAbi(source: string, engineName = 'the engine source'): EngineAbi {
  const paramsBlock = source.match(/kParamNames\[\]\s*=\s*\{([^}]*)\}/)
  if (!paramsBlock) throw new Error(`ABI parse: kParamNames[] table not found in ${engineName}`)
  const params = [...paramsBlock[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!)

  const lenMatch = source.match(/kHotFrameLength\s*=\s*(\d+)/)
  if (!lenMatch) throw new Error(`ABI parse: kHotFrameLength not found in ${engineName}`)
  return { params, hotFrameLength: Number(lenMatch[1]) }
}

export function checkAbiCoverage(config: AbiCheckConfig): { ok: boolean; errors: string[] } {
  const { enginePath, waiverPath, paramIds, hotFrameScalars } = config
  const engine = parseEngineAbi(readFileSync(enginePath, 'utf8'), basename(enginePath))
  const waivers = JSON.parse(readFileSync(waiverPath, 'utf8')) as Waivers
  const errors: string[] = []

  // --- ParamWrite ids: carried (in engine table, same index) or waived. ---
  paramIds.forEach((id, i) => {
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
    if (!paramIds.includes(id))
      errors.push(`engine param "${id}" is not declared in the schema (a param JS can never address)`)
  for (const id of Object.keys(waivers.params))
    if (engine.params.includes(id))
      errors.push(`param "${id}" is waived but the engine actually carries it — remove the stale waiver`)

  // --- HotFrame scalars: filled if index < engine length, else must be waived. ---
  hotFrameScalars.forEach((name, i) => {
    if (i >= engine.hotFrameLength && !(name in waivers.hotframe))
      errors.push(
        `hotframe scalar "${name}" (index ${i}) is beyond the engine's kHotFrameLength=${engine.hotFrameLength} and not waived`,
      )
  })
  const filledCount = hotFrameScalars.filter((_, i) => i < engine.hotFrameLength).length
  if (engine.hotFrameLength > filledCount)
    errors.push(`engine kHotFrameLength=${engine.hotFrameLength} exceeds the ${filledCount} schema scalars it maps to`)

  return { ok: errors.length === 0, errors }
}

/** Shared CLI body: run the check, print, exit non-zero on failure. */
export function runAbiCoverageCli(config: AbiCheckConfig): void {
  const { ok, errors } = checkAbiCoverage(config)
  if (!ok) {
    console.error('ABI coverage FAILED:\n' + errors.map((e) => '  - ' + e).join('\n'))
    process.exit(1)
  }
  console.log('ABI coverage OK')
}
