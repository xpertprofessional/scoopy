/**
 * Emits shell/generated/WZProtocol.h from web/protocol/schema.ts.
 *
 *   npm run protocol:generate   — (re)write the C++ header
 *   npm run protocol:check      — exit 1 if the file on disk is stale
 *
 * The generated header is dependency-free (only <cstdint>) so the engine, the
 * JUCE shell, and test tools can all include it.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SCHEMA_VERSION,
  PARAM_IDS,
  HOT_FRAME_SCALARS,
  HOT_FRAME_LENGTH,
  COMMANDS,
} from '../protocol/schema.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outPath = resolve(repoRoot, 'shell/generated/WZProtocol.h')

const lines: string[] = []
lines.push('// GENERATED — do not edit. Source: web/protocol/schema.ts')
lines.push('// Regenerate with: cd web && npm run protocol:generate')
lines.push('#pragma once')
lines.push('#include <cstdint>')
lines.push('')
lines.push('namespace wz::protocol {')
lines.push('')
lines.push(`inline constexpr std::int32_t kSchemaVersion = ${SCHEMA_VERSION};`)
lines.push('')
lines.push('// ParamWrite atomics. JS resolves ids BY NAME at boot (never hardcodes')
lines.push('// integers); this enum is for the C++ side only.')
lines.push('enum class ParamId : std::uint32_t {')
PARAM_IDS.forEach((id, i) => lines.push(`    ${id} = ${i},`))
lines.push('};')
lines.push(`inline constexpr std::uint32_t kParamIdCount = ${PARAM_IDS.length};`)
lines.push('inline constexpr const char* kParamIdNames[] = {')
PARAM_IDS.forEach((id) => lines.push(`    "${id}",`))
lines.push('};')
lines.push('')
lines.push('// HotFrame Float64 index map.')
lines.push('namespace hotframe {')
HOT_FRAME_SCALARS.forEach((name, i) =>
  lines.push(`inline constexpr std::uint32_t k_${name} = ${i};`),
)
lines.push(`inline constexpr std::uint32_t kFrameLength = ${HOT_FRAME_LENGTH};`)
lines.push('} // namespace hotframe')
lines.push('')
lines.push('// Command method names (JSON-RPC style).')
lines.push('inline constexpr const char* kMethodNames[] = {')
for (const method of Object.keys(COMMANDS)) lines.push(`    "${method}",`)
lines.push('};')
lines.push(
  `inline constexpr std::uint32_t kMethodCount = ${Object.keys(COMMANDS).length};`,
)
lines.push('')
lines.push('} // namespace wz::protocol')
lines.push('')

const generated = lines.join('\n')
const checkMode = process.argv.includes('--check')

if (checkMode) {
  const onDisk = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
  if (onDisk !== generated) {
    console.error(
      `protocol:check FAILED — ${outPath} is stale.\nRun: cd web && npm run protocol:generate`,
    )
    process.exit(1)
  }
  console.log('protocol:check OK')
} else {
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, generated)
  console.log(`wrote ${outPath}`)
}
