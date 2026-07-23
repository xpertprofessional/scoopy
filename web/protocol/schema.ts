/**
 * WZP protocol for Wizard — single source of truth.
 *
 * Every boundary artifact (the C++ header for the JUCE shell/engine, TS types
 * for the UI) is generated from this file. Never hand-edit generated output;
 * `npm run protocol:check` fails the build if it drifts.
 *
 * Message classes (see docs/ARCHITECTURE.md §7.3):
 *   Command      UI → engine   JSON-RPC {id, method, params}, async reply
 *   ParamWrite   UI → engine   coalesced live-control atomics, keyed by NAME + channel
 *   WorldPublish UI → engine   full Patch snapshot on edit (RCU-installed)
 *   HotFrame     engine → UI   30–60 Hz flat Float64Array, indexed below
 *
 * TypeScript owns the Patch document; the engine is a follower that renders
 * whatever world it is handed. Both sides never write the same domain.
 * Domain math (pan/fader/ramps) is normative in docs/specs/routing.md.
 */
import { z } from 'zod'

/** Bumped on every boundary change. Shell refuses mismatched publishes. */
export const SCHEMA_VERSION = 7

/**
 * ParamWrite atomics — the live-control set, coalesced per (id, channel) per
 * rAF. `mainGain` is master-global (channel ignored); the rest are per-strip.
 * Adding one is a schema increment: extend here, regenerate, wire both sides
 * (the ABI coverage gate keeps us honest — engine-side per-channel storage
 * lands P1-03, waived until then in abi-not-carried.json).
 */
export const PARAM_IDS = ['mainGain', 'gain', 'pan', 'mute', 'solo'] as const
export type ParamId = (typeof PARAM_IDS)[number]

// --- HotFrame layout (docs/specs/routing.md §8) ------------------------------
// Scalars first (fixed indices, never renumbered), then per-CHANNEL blocks,
// then per-DECK blocks. Block counts ride WorldPublish; offsets are derived
// via the helpers below — never hand-computed on either side.

export const HOT_FRAME_SCALARS = [
  'schemaVersion', // echoed so a stale shell/UI pairing is loudly detectable
  'engineTimeSamples', // free-running samples since engine start (wall-clock in samples)
  'cpuLoad', // render-thread load estimate 0..1
  'feedbackAlarm', // 1 while the watchdog limiter is engaged (P4), else 0
  'mainPeakL', // main bus output peak (linear amplitude) since last frame, L / R
  'mainPeakR',
  'monitorPeakL', // monitor (cue) bus output peak, L / R
  'monitorPeakR',
] as const

/**
 * Per-channel block. srcRingFill/srcDriftPpm/srcDropouts are RESERVED now
 * (zero until P2's capture lands) so the stride never migrates and clock-drift
 * telemetry appears per strip the day taps exist (D-WZ-CLOCK-01: drift must be
 * visible live, not discovered in a desynced file).
 */
export const CHANNEL_BLOCK_FIELDS = [
  'peakL',
  'peakR',
  'rmsL',
  'rmsR',
  'srcRingFill', // 0..1 ring fill (P2)
  'srcDriftPpm', // ASRC-measured source clock drift (P2)
  'srcDropouts', // cumulative over/underrun count (P2)
] as const

/** Per-deck block. Record fields are zero until P3. */
export const DECK_BLOCK_FIELDS = [
  'state', // 0 idle · 1 looping · 2 oneShot · 3 recording (P3)
  'playhead', // buffer read position, samples
  'loopStart',
  'loopEnd',
  'rate', // signed varispeed (engine plays 1.0 until P4)
  'recordLengthSamples', // P3
  'recordDrainFill', // P3
] as const

export const HOT_FRAME_LENGTH = HOT_FRAME_SCALARS.length // scalar section only

/** Total frame length for a world with the given block counts. */
export function hotFrameLength(channelCount: number, deckCount: number): number {
  return (
    HOT_FRAME_SCALARS.length +
    channelCount * CHANNEL_BLOCK_FIELDS.length +
    deckCount * DECK_BLOCK_FIELDS.length
  )
}

/** Index of a per-channel field inside a frame. */
export function channelFieldIndex(
  channel: number,
  field: (typeof CHANNEL_BLOCK_FIELDS)[number],
): number {
  return (
    HOT_FRAME_SCALARS.length +
    channel * CHANNEL_BLOCK_FIELDS.length +
    CHANNEL_BLOCK_FIELDS.indexOf(field)
  )
}

/** Index of a per-deck field inside a frame (decks follow ALL channel blocks). */
export function deckFieldIndex(
  channelCount: number,
  deck: number,
  field: (typeof DECK_BLOCK_FIELDS)[number],
): number {
  return (
    HOT_FRAME_SCALARS.length +
    channelCount * CHANNEL_BLOCK_FIELDS.length +
    deck * DECK_BLOCK_FIELDS.length +
    DECK_BLOCK_FIELDS.indexOf(field)
  )
}

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

// --- Patch / world model (WorldPublish payload) ------------------------------
// TS owns the document; the engine follows. Strict schemas: unknown key = loud
// failure, never a silent drop on re-save (preserve-don't-drop law).

/**
 * A Source is a portable, re-resolvable REFERENCE, never a live handle
 * ("Spotify" survives relaunch; a vanished source leaves its strip in place,
 * silent, reference intact). The full kind enum ships in v3 so Patches stay
 * forward-readable; P1 resolves only deviceInput / deck / none.
 */
export const SourceKindSchema = z.enum([
  'none',
  'deviceInput', // duplex hardware input channels (P1, same-clock)
  'deck',
  'appTap', // P2
  'systemMixExcept', // P2
  'virtualDeviceInput', // P5
  'busTap', // P6 (FX returns)
])
export type SourceKind = z.infer<typeof SourceKindSchema>

export const SourceRefSchema = z
  .object({
    kind: SourceKindSchema,
    /** Kind-scoped identifier: deviceInput "0,1" (channel pick) · deck "3" ·
        appTap bundle-id/pid-key (P2). Empty for 'none'. */
    id: z.string(),
    /** Human label at bind time ("Built-in Mic", "Spotify") — survives the
        source vanishing. */
    name: z.string(),
  })
  .strict()
export type SourceRef = z.infer<typeof SourceRefSchema>

/**
 * The universal strip (CONCEPT law: everything is a channel). P1 drives
 * gain/pan/mute/solo/monitorAssign; sends/recordArm/monitorSwitch/inserts are
 * RESERVED fields — carried, validated, ignored by the engine until their
 * phase — so adding P3/P6 is an increment, not a migration.
 */
export const ChannelSchema = z
  .object({
    key: z.string().min(1), // stable identity across edits (engine world key)
    name: z.string(),
    source: SourceRefSchema,
    gain: z.number().min(0).max(1), // fader POSITION; dB mapping per D-WZ-FADER-01
    pan: z.number().min(-1).max(1),
    mute: z.boolean(),
    solo: z.boolean(),
    toMonitor: z.boolean(), // cue assign (main is always fed; spec §2)
    sends: z.array(z.number().min(0).max(1)).length(4), // P6 (reserved)
    recordArm: z.boolean(), // P3 (reserved)
    monitorSwitch: z.boolean(), // P3 per-deck input monitoring (reserved)
    inserts: z.array(z.string()).length(4), // P6 plugin refs, '' = empty (reserved)
  })
  .strict()
export type Channel = z.infer<typeof ChannelSchema>

/** Deck v0 (playback only). Record fields arrive P3; varispeed plays 1.0 until P4. */
export const DeckSchema = z
  .object({
    id: z.number().int().min(0).max(7),
    name: z.string(),
    loopEnabled: z.boolean(),
    // Half-open [start, end) in deck-buffer samples; equal = whole buffer.
    loopStartSample: z.number().int().nonnegative(),
    loopEndSample: z.number().int().nonnegative(),
    rate: z.number(), // signed; negative = reverse (P4)
    /** Loaded file path ('' = empty deck). Takes (P3) load through the same field. */
    sourcePath: z.string(),
  })
  .strict()
export type Deck = z.infer<typeof DeckSchema>

/** Bus → device-channel map. Monitor is null when the device lacks ≥4 outputs —
    surfaced in the UI, never silently re-routed (spec §4). */
export const OutputMapSchema = z
  .object({
    main: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
    monitor: z
      .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
      .nullable(),
  })
  .strict()
export type OutputMap = z.infer<typeof OutputMapSchema>

export const PatchSchema = z
  .object({
    schemaVersion: z.number().int(),
    channels: z.array(ChannelSchema),
    decks: z.array(DeckSchema).max(8),
    outputMap: OutputMapSchema,
    uiMode: z.enum(['console', 'strip']), // display mode is document state (CONCEPT §6)
  })
  .strict()
export type Patch = z.infer<typeof PatchSchema>

export function emptyPatch(): Patch {
  return {
    schemaVersion: SCHEMA_VERSION,
    channels: [],
    decks: [],
    outputMap: { main: [0, 1], monitor: null },
    uiMode: 'console',
  }
}

/** Factory for a fresh strip bound to a source (defaults per routing.md §2). */
export function makeChannel(key: string, name: string, source: SourceRef): Channel {
  return {
    key,
    name,
    source,
    gain: 0.75, // unity detent (D-WZ-FADER-01)
    pan: 0,
    mute: false,
    solo: false,
    toMonitor: false,
    sends: [0, 0, 0, 0],
    recordArm: false,
    monitorSwitch: false,
    inserts: ['', '', '', ''],
  }
}

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
  // Duplex-device introspection for the sources browser (shell-owned — needs
  // the host device layer, so Main.cpp answers it before the pure dispatcher).
  // inputs[] is compacted to ACTIVE channels: inputs[i].index is exactly the
  // srcChan value a deviceInput SourceRef uses. monitorAvailable mirrors
  // routing.md §4: the cue pair exists only when the device has ≥4 outputs.
  getDeviceInfo: {
    params: z.object({}).strict(),
    result: z
      .object({
        deviceName: z.string(), // output side (macOS pairs separate in/out devices)
        inputDeviceName: z.string(), // '' when no input device opened
        // Non-empty when the duplex open failed or was degraded (e.g. mic
        // permission denied) — the UI explains silence instead of hiding it.
        error: z.string(),
        sampleRate: z.number().nonnegative(),
        inputs: z.array(
          z.object({ index: z.number().int().nonnegative(), name: z.string() }).strict(),
        ),
        outputChannels: z.number().int().nonnegative(),
        monitorAvailable: z.boolean(),
      })
      .strict(),
  },
  // Available devices for the picker (shell-owned). inputs/outputs are device
  // NAMES for the current device type.
  listDevices: {
    params: z.object({}).strict(),
    result: z
      .object({
        inputs: z.array(z.string()),
        outputs: z.array(z.string()),
        currentInput: z.string(),
        currentOutput: z.string(),
      })
      .strict(),
  },
  // Switch input and/or output device (empty string = leave that side). Re-opens
  // at the CURRENT engine rate; ok=false + error when the device can't run it
  // (D-WZ-RATE-01: no silent coercion). The world + decks survive; but decks
  // loaded before a rate-differing switch would be at the wrong rate — the UI
  // warns (P0-11a will auto-reload). Shell-owned (needs the device layer).
  setDevice: {
    params: z.object({ input: z.string(), output: z.string() }).strict(),
    result: z.object({ ok: z.boolean(), error: z.string() }).strict(),
  },
  // WorldPublish: the full Patch document. The engine RCU-installs the world;
  // `revision` echoes a monotonic install counter so the UI can correlate
  // HotFrame block counts with the world it published. Dispatch lands P1-03.
  publishWorld: {
    params: z.object({ patch: PatchSchema }).strict(),
    result: z.object({ revision: z.number().int().nonnegative() }).strict(),
  },
  // Opens a native file-open dialog (shell-owned, async) and loads the chosen
  // file into `deck`: decode → off-thread SINC_BEST resample to engine rate
  // (D-WZ-DECKSRC-01) → wz_deck_load. ok=false + empty path on cancel.
  // sampleRate = the FILE's native rate; engineFrames = frames after resample.
  // Dispatch lands P1-07.
  deckLoadFile: {
    params: z.object({ deck: z.number().int().min(0).max(7) }).strict(),
    result: z
      .object({
        ok: z.boolean(),
        path: z.string(),
        channels: z.number().int().nonnegative(),
        sampleRate: z.number().nonnegative(),
        engineFrames: z.number().int().nonnegative(),
      })
      .strict(),
  },
  // Deck transport intent; state truth streams back via the HotFrame deck
  // block, never from this reply. Dispatch lands P1-07.
  deckTrigger: {
    params: z
      .object({
        deck: z.number().int().min(0).max(7),
        mode: z.enum(['loop', 'oneShot', 'stop', 'retrigger']),
      })
      .strict(),
    result: z.object({}).strict(),
  },
  // Half-open [startSample, endSample); published atomically (seqlock — the
  // render thread never observes a torn pair). Dispatch lands P1-07.
  deckSetLoop: {
    params: z
      .object({
        deck: z.number().int().min(0).max(7),
        enabled: z.boolean(),
        startSample: z.number().int().nonnegative(),
        endSample: z.number().int().nonnegative(),
      })
      .strict(),
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
