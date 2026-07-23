/**
 * WZP protocol for Wizard — single source of truth.
 *
 * Every boundary artifact (the C++ header for the JUCE shell/engine, TS types
 * for the UI) is generated from this file. Never hand-edit generated output;
 * `npm run protocol:check` fails the build if it drifts.
 *
 * Message classes (see docs/ARCHITECTURE.md §7.3):
 *   Command      UI → engine   JSON-RPC {id, method, params}, async reply
 *   ParamWrite   UI → engine   coalesced live-control atomics, keyed by NAME (+ channel)
 *   WorldPublish UI → engine   full Patch snapshot on edit (RCU-installed) — lands P1
 *   HotFrame     engine → UI   30–60 Hz flat Float64Array, indexed below
 *
 * TypeScript owns the Patch document; the engine is a follower that renders
 * whatever world it is handed. Both sides never write the same domain.
 */
import { z } from 'zod'

/** Bumped on every boundary change. Shell refuses mismatched publishes. */
export const SCHEMA_VERSION = 2

/**
 * ParamWrite atomics. Adding one is a schema increment: extend here, regenerate,
 * then wire both sides (the ABI coverage gate keeps us honest). Wizard's params
 * are per-CHANNEL (keyed by name + channel index at the boundary); `mainGain` is
 * the master output trim, seeded here so P0 has a live-control path to exercise.
 */
export const PARAM_IDS = ['mainGain'] as const
export type ParamId = (typeof PARAM_IDS)[number]

/**
 * HotFrame layout: scalars first (fixed indices). Per-deck and per-channel block
 * sections (meters, srcRingFill/srcDriftPpm/srcDropouts per strip — D-WZ-CLOCK-01)
 * append behind named base offsets in later phases; the scalars never renumber.
 */
export const HOT_FRAME_SCALARS = [
  'schemaVersion', // echoed so a stale shell/UI pairing is loudly detectable
  'engineTimeSamples', // free-running samples since engine start (wall-clock in samples)
  'cpuLoad', // render-thread load estimate 0..1
  'feedbackAlarm', // 1 while the watchdog limiter is engaged (external loop caught), else 0
  'mainPeakL', // main bus output peak (linear amplitude) since last frame, L / R
  'mainPeakR',
  'monitorPeakL', // monitor (cue) bus output peak, L / R
  'monitorPeakR',
] as const
export const HOT_FRAME_LENGTH = HOT_FRAME_SCALARS.length

/** Capability handshake — UI mounts panels from this, never from shell guesses. */
export const CapabilitiesSchema = z
  .object({
    schemaVersion: z.number().int(),
    // Per-app / system-mix capture (macOS process taps, Linux PipeWire). P2.
    processCapture: z.boolean(),
    // The "Wizard Out" virtual device is installed and selectable. P5.
    virtualDevice: z.boolean(),
    // VST3/AU/LV2 plugin inserts + FX returns. P6.
    pluginHosting: z.boolean(),
    // Native file dialogs / take + sample file IO.
    fileSystem: z.boolean(),
    // The host can enumerate + select audio devices.
    audioDeviceSelection: z.boolean(),
  })
  .strict()
export type Capabilities = z.infer<typeof CapabilitiesSchema>

/**
 * Command registry: method → { params, result } zod schemas.
 * The C++ side gets the method-name table; TS gets full typing.
 */
export const COMMANDS = {
  ping: {
    params: z.object({}).strict(),
    result: z.object({ pong: z.literal(true) }).strict(),
  },
  getCapabilities: {
    params: z.object({}).strict(),
    result: CapabilitiesSchema,
  },
  // Boot tone (P0 walking-skeleton affordance): toggles a metered -18 dBFS sine
  // on the main bus so the device→engine→meter→UI path is provable before real
  // channels exist. Removed when P1 builds channels.
  setTestTone: {
    params: z.object({ enabled: z.boolean() }).strict(),
    result: z.object({}).strict(),
  },
} as const
export type Method = keyof typeof COMMANDS
export type Params<M extends Method> = z.infer<(typeof COMMANDS)[M]['params']>
export type Result<M extends Method> = z.infer<(typeof COMMANDS)[M]['result']>

export const CommandEnvelopeSchema = z
  .object({
    id: z.number().int().nonnegative(),
    method: z.string(),
    params: z.unknown(),
  })
  .strict()

export const CommandReplySchema = z
  .object({
    id: z.number().int().nonnegative(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  })
  .strict()

// --- Patch / world model (WorldPublish payload) -----------------------------
// The full Patch (channels, buses, decks, sends, output map, UI mode) lands in
// P1 as the mixer slice is built. P0 seeds only the handshake envelope; a
// minimal session factory keeps the schemaVersion contract testable now.

export const emptyPatch = () => ({ schemaVersion: SCHEMA_VERSION }) as const
