/**
 * C++ protocol-header emitter. The generated header is the boundary artifact the
 * engine, the JUCE shell and the test tools all include; it is dependency-free
 * (only <cstdint>) and committed, with `npm run protocol:check` failing the build
 * when it drifts from the schema.
 *
 * The skeleton — file banner, namespace, schema version, the ParamId enum + name
 * table, the method-name table — is identical across apps and lives here. The
 * HOTFRAME INDEX MAP is deliberately app-supplied: its layout is a product
 * decision (Parlante is flat scalars; Wizard adds per-channel and per-deck block
 * strides), so each app emits that section itself and passes it in.
 *
 * Vendored, not linked — see shared/README.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ProtocolHeaderConfig {
  /** C++ namespace prefix, e.g. 'pl' → `namespace pl::protocol`. */
  namespace: string
  schemaVersion: number
  /** PARAM_IDS in schema order — the enum assigns ids by this order. */
  paramIds: readonly string[]
  /** Command method names in schema order. */
  methods: readonly string[]
  /** The `namespace hotframe { … }` block, emitted verbatim. App-specific. */
  hotframeSection: readonly string[]
}

export function emitProtocolHeader(cfg: ProtocolHeaderConfig): string {
  const lines: string[] = []
  lines.push('// GENERATED — do not edit. Source: web/protocol/schema.ts')
  lines.push('// Regenerate with: cd web && npm run protocol:generate')
  lines.push('#pragma once')
  lines.push('#include <cstdint>')
  lines.push('')
  lines.push(`namespace ${cfg.namespace}::protocol {`)
  lines.push('')
  lines.push(`inline constexpr std::int32_t kSchemaVersion = ${cfg.schemaVersion};`)
  lines.push('')
  lines.push('// ParamWrite atomics. JS resolves ids BY NAME at boot (never hardcodes')
  lines.push('// integers); this enum is for the C++ side only.')
  lines.push('enum class ParamId : std::uint32_t {')
  cfg.paramIds.forEach((id, i) => lines.push(`    ${id} = ${i},`))
  lines.push('};')
  lines.push(`inline constexpr std::uint32_t kParamIdCount = ${cfg.paramIds.length};`)
  lines.push('inline constexpr const char* kParamIdNames[] = {')
  cfg.paramIds.forEach((id) => lines.push(`    "${id}",`))
  lines.push('};')
  lines.push('')
  lines.push(...cfg.hotframeSection)
  lines.push('')
  lines.push('// Command method names (JSON-RPC style).')
  lines.push('inline constexpr const char* kMethodNames[] = {')
  for (const method of cfg.methods) lines.push(`    "${method}",`)
  lines.push('};')
  lines.push(`inline constexpr std::uint32_t kMethodCount = ${cfg.methods.length};`)
  lines.push('')
  lines.push(`} // namespace ${cfg.namespace}::protocol`)
  lines.push('')
  return lines.join('\n')
}

/**
 * Shared CLI body: `--check` fails when the committed header is stale, otherwise
 * (re)writes it. Keeping the committed artifact and the gate in one place is what
 * makes a codegen refactor provable — a zero diff on the header IS the proof.
 */
export function runProtocolCodegenCli(outPath: string, generated: string): void {
  if (process.argv.includes('--check')) {
    const onDisk = existsSync(outPath) ? readFileSync(outPath, 'utf8') : ''
    if (onDisk !== generated) {
      console.error(`protocol:check FAILED — ${outPath} is stale.\nRun: cd web && npm run protocol:generate`)
      process.exit(1)
    }
    console.log('protocol:check OK')
    return
  }
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, generated)
  console.log(`wrote ${outPath}`)
}
