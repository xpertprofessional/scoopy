/**
 * Emits shell/generated/WZProtocol.h from web/protocol/schema.ts.
 *
 *   npm run protocol:generate   — (re)write the C++ header
 *   npm run protocol:check      — exit 1 if the file on disk is stale
 *
 * The generated header is dependency-free (only <cstdint>) so the engine, the
 * JUCE shell, and test tools can all include it.
 *
 * The header skeleton lives in the shared emitter (protocolCodegen.ts, vendored
 * from shared/protocol); what stays here is Wizard's HotFrame index map — the
 * per-channel and per-deck block strides are a product decision.
 */
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SCHEMA_VERSION,
  PARAM_IDS,
  HOT_FRAME_SCALARS,
  HOT_FRAME_LENGTH,
  CHANNEL_BLOCK_FIELDS,
  DECK_BLOCK_FIELDS,
  COMMANDS,
} from '../protocol/schema.ts'
import { emitProtocolHeader, runProtocolCodegenCli } from './protocolCodegen.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outPath = resolve(repoRoot, 'shell/generated/WZProtocol.h')

// Scalars, then per-CHANNEL blocks, then per-DECK blocks (docs/specs/routing.md
// §8). Offsets are derived from these strides on both sides — never hand-computed.
const hotframeSection: string[] = [
  '// HotFrame Float64 index map: scalars, then per-CHANNEL blocks, then',
  '// per-DECK blocks (docs/specs/routing.md §8). Offsets are derived from',
  '// these strides on both sides — never hand-computed.',
  'namespace hotframe {',
  ...HOT_FRAME_SCALARS.map((name, i) => `inline constexpr std::uint32_t k_${name} = ${i};`),
  `inline constexpr std::uint32_t kScalarCount = ${HOT_FRAME_SCALARS.length};`,
  '// kFrameLength is the SCALAR section only; the full frame is',
  '// kScalarCount + nChannels*channel_block::kStride + nDecks*deck_block::kStride.',
  `inline constexpr std::uint32_t kFrameLength = ${HOT_FRAME_LENGTH};`,
  'namespace channel_block {',
  ...CHANNEL_BLOCK_FIELDS.map((name, i) => `inline constexpr std::uint32_t k_${name} = ${i};`),
  `inline constexpr std::uint32_t kStride = ${CHANNEL_BLOCK_FIELDS.length};`,
  '} // namespace channel_block',
  'namespace deck_block {',
  ...DECK_BLOCK_FIELDS.map((name, i) => `inline constexpr std::uint32_t k_${name} = ${i};`),
  `inline constexpr std::uint32_t kStride = ${DECK_BLOCK_FIELDS.length};`,
  '} // namespace deck_block',
  '} // namespace hotframe',
]

const generated = emitProtocolHeader({
  namespace: 'wz',
  schemaVersion: SCHEMA_VERSION,
  paramIds: PARAM_IDS,
  methods: Object.keys(COMMANDS),
  hotframeSection,
})

runProtocolCodegenCli(outPath, generated)
