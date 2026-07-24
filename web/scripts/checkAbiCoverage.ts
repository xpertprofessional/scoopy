/**
 * ABI coverage gate (P0-08) — the ScoopyLoops P0-08 lesson made mechanical:
 * "when two components are tested against each other, nothing tests the
 * boundary they share."
 *
 * The schema (web/protocol/schema.ts) is the UI-side authority; the engine
 * (engine/src/wz_engine.cpp) is the independently hand-written C++ authority.
 * The generated WZProtocol.h is derived FROM the schema, so checking those two
 * proves nothing. The check itself is shared (abiCoverage.ts, vendored from
 * shared/protocol); this file binds it to Wizard's paths and schema tables.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PARAM_IDS, HOT_FRAME_SCALARS } from '../protocol/schema.ts'
import {
  checkAbiCoverage as sharedCheckAbiCoverage,
  runAbiCoverageCli,
  type AbiCheckConfig,
} from './abiCoverage.ts'

export { parseEngineAbi } from './abiCoverage.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const CONFIG: AbiCheckConfig = {
  enginePath: resolve(repoRoot, 'engine/src/wz_engine.cpp'),
  waiverPath: resolve(repoRoot, 'engine/tools/abi-not-carried.json'),
  paramIds: PARAM_IDS,
  hotFrameScalars: HOT_FRAME_SCALARS,
}

export function checkAbiCoverage(): { ok: boolean; errors: string[] } {
  return sharedCheckAbiCoverage(CONFIG)
}

// CLI entry for CI: `node --experimental-strip-types scripts/checkAbiCoverage.ts`.
if (import.meta.url === `file://${process.argv[1]}`) runAbiCoverageCli(CONFIG)
