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
// Explicit .ts extensions: the protocol:generate / abi:check gates load this
// module under raw `node --experimental-strip-types`, which will not resolve an
// extensionless relative import.
import type { MethodOf, ParamsOf, ResultOf } from './types.ts'

/** Bumped on every boundary change. Shell refuses mismatched publishes. */
export const SCHEMA_VERSION = 26

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
  'recordLengthSamples', // P3: committed record-buffer length, live
  'recordDrainFill', // P3: drain-ring backlog (0..1) — file writer falling behind
  'recordCapReached', // P3: 1 when the 256 MB/deck cap stopped this recording (D-WZ-DECK-01)
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
/** PD-CANVAS (D-WZ-PDCANVAS-01): where a strip sits on the boundless plane.
    Geometry is PURE UI state — it never crosses the ABI (the engine has never
    known where a strip is drawn). Additive: the console UI ignores it until the
    Plane/Cell components (PD-CANVAS-02) render it. */
export const CellSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    w: z.number().positive(),
    h: z.number().positive(),
  })
  .strict()
export type Cell = z.infer<typeof CellSchema>

/** Default Cell size for a freshly-created strip. Sized to hold the FULL control
    set without clipping — the transport alone is now ten controls (record,
    loop/one-shot/retrigger/stop, overdub, input-monitor, mute/solo/cue) and the
    strip clips its overflow, so a budget that is merely nearly enough loses
    controls silently. HORIZONTAL and player-shaped
    (the Parlante reference): wide enough for a readable waveform and Layout-B
    parameter rows. Real placement (drag, auto-layout) is the Plane's job; this
    just keeps the field valid and sets the auto-layout grid's cell size. */
export const DEFAULT_CELL: Cell = { x: 0, y: 0, w: 380, h: 268 }

/**
 * What a Strip PLAYS, as opposed to `source` — what it captures FROM
 * (PD-CANVAS-06, D-WZ-RECMODEL-01 step B).
 *
 * `Channel.source` was doing two jobs: where signal comes from AND where
 * material lives. That conflation is why a mic Strip had no record verb, why a
 * deck Strip recorded a hardcoded input, and why provenance vanished the moment
 * a take existed. Splitting them makes "recording is the verb that gives a Strip
 * material" expressible instead of merely aspirational.
 *
 * null = no material yet. The ENGINE is untouched by this: it still renders from
 * the published `source`, so a Strip that holds material continues to carry
 * `source.kind === 'deck'` today. Rendering a Strip's input AND its material at
 * once is a separate, engine-level change — this field is what makes that
 * change describable when it comes.
 */
export const MaterialSchema = z
  .object({ deckId: z.number().int().min(0).max(7) })
  .strict()
  .nullable()
export type Material = z.infer<typeof MaterialSchema>

export const ChannelSchema = z
  .object({
    key: z.string().min(1), // stable identity across edits (engine world key)
    name: z.string(),
    source: SourceRefSchema,
    gain: z.number().min(0).max(1), // fader POSITION; dB mapping per D-WZ-FADER-01
    pan: z.number().min(-1).max(1),
    mute: z.boolean(),
    solo: z.boolean(),
    toMonitor: z.boolean(), // cue assign (independent of the output bus)
    // Which of the 8 output buses this strip feeds (P4-10). Bus 0 IS main —
    // there is no separate main path, which is exactly why a spatial layout
    // (quad / 5.1 / octophonic) is just strips on different buses.
    outBus: z.number().int().min(0).max(7),
    sends: z.array(z.number().min(0).max(1)).length(4), // P6 (reserved)
    recordArm: z.boolean(), // P3 (reserved)
    monitorSwitch: z.boolean(), // P3 per-deck input monitoring (reserved)
    inserts: z.array(z.string()).length(4), // P6 plugin refs, '' = empty (reserved)
    cell: CellSchema, // PD-CANVAS: plane geometry (UI-only, never crosses the ABI)
    material: MaterialSchema, // PD-CANVAS-06: what it PLAYS (source = what it captures)
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

/** PD-CANVAS: the plane viewport — document state so a saved arrangement reopens
    framed the way the user left it (pd-canvas.md §4).

    This ALSO replaced `uiMode`: 'strip' used to name a second layout, but the
    console is gone and "strip mode" is simply a zoomed-out plane, which `scale`
    already expresses. Keeping the enum would have been a second source of truth
    for the same idea. */
export const PlaneSchema = z
  .object({
    scale: z.number().positive(), // zoom; the "Default" control resets to 1
    panX: z.number(),
    panY: z.number(),
  })
  .strict()
export type Plane = z.infer<typeof PlaneSchema>

export const DEFAULT_PLANE: Plane = { scale: 1, panX: 0, panY: 0 }

/** The device the session was built on (P7-08, D-WZ-DEVGONE-01). Empty string =
    "no preference, use the machine default". Kept in the Patch (not the thin
    envelope) so it travels with a shared package — where it will usually NOT
    resolve, which is exactly the case the fall-back-and-say-so posture serves.
    Like `cell`/`plane` it is carried across the ABI and ignored by the engine. */
export const SessionDeviceSchema = z
  .object({
    input: z.string(),
    output: z.string(),
  })
  .strict()

export const PatchSchema = z
  .object({
    schemaVersion: z.number().int(),
    channels: z.array(ChannelSchema),
    decks: z.array(DeckSchema).max(8),
    outputMap: OutputMapSchema,
    plane: PlaneSchema, // PD-CANVAS: viewport (UI-only, never crosses the ABI)
    device: SessionDeviceSchema, // P7-08: remembered device, '' = machine default
  })
  .strict()
export type Patch = z.infer<typeof PatchSchema>

export function emptyPatch(): Patch {
  return {
    schemaVersion: SCHEMA_VERSION,
    channels: [],
    decks: [],
    outputMap: { main: [0, 1], monitor: null },
    plane: { ...DEFAULT_PLANE },
    device: { input: '', output: '' },
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
    outBus: 0, // main
    sends: [0, 0, 0, 0],
    recordArm: false,
    monitorSwitch: false,
    inserts: ['', '', '', ''],
    cell: { ...DEFAULT_CELL }, // fresh copy so strips never share a geometry object
    material: null, // no material until something records or loads into it
  }
}

/**
 * A recorded artifact (CONCEPT §3). `startEngineSample` is the Law C-2 anchor:
 * any two takes realign by the DELTA of their stamps — a subtraction, not an
 * editing session. The same stamp is written into the BWF bext TimeReference,
 * so a take carries its anchor even outside a session.
 */
export const TakeSchema = z
  .object({
    deckId: z.number().int().min(0).max(7),
    path: z.string(),
    startEngineSample: z.number().int().nonnegative(),
    frames: z.number().int().nonnegative(),
    sampleRate: z.number().positive(),
    channels: z.number().int().positive(),
    sourceDesc: z.string(),
  })
  .strict()
export type Take = z.infer<typeof TakeSchema>

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
        // How many of the 8 output buses this device can actually carry
        // (wz_engine_mappable_buses). Buses beyond it are UNMAPPED — dropped
        // and labelled, never folded into another bus.
        mappableBuses: z.number().int().nonnegative(),
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
  // --- session persistence (P7-03) -----------------------------------------
  // The shell owns the filesystem; the UI hands it already-serialized text so
  // the document format lives in ONE place (persist/session.ts). The write is
  // atomic (temp -> fsync -> rename) with a rotated .bak: a half-written
  // session is the one failure mode that makes autosave worse than nothing.
  saveAutosave: {
    params: z.object({ text: z.string() }).strict(),
    result: z.object({ ok: z.boolean(), error: z.string() }).strict(),
  },
  // Returns the autosave, or the .bak if the primary is unreadable, or empty.
  // `source` tells the UI which it got so it can say so rather than pretending.
  loadAutosave: {
    params: z.object({}).strict(),
    result: z
      .object({
        text: z.string(),
        source: z.enum(['primary', 'backup', 'none']),
      })
      .strict(),
  },
  // --- `.wizard` package (P7-07) -------------------------------------------
  // Opens a native SAVE dialog and writes a STORED zip of session.json + the
  // referenced takes. The UI passes the take paths because the UI is what knows
  // which takes the document actually references; the shell owns the dialog and
  // the bytes. `missing` names takes that no longer exist — the package is
  // still written without them, because one lost take is no reason to deny the
  // user a package of everything else.
  //
  // `excluded` names references the shell DELIBERATELY did not embed: files
  // outside Wizard's own Takes folder are the user's own library, and copying
  // someone's library into our package is not ours to do (spec §1). Kept
  // separate from `missing` because "I chose not to" and "it was gone" are
  // different facts and a user acts on them differently.
  // ok=false + empty path on cancel.
  savePackage: {
    params: z.object({ text: z.string(), takes: z.array(z.string()) }).strict(),
    result: z
      .object({
        ok: z.boolean(),
        path: z.string(),
        missing: z.array(z.string()),
        excluded: z.array(z.string()),
        error: z.string(),
      })
      .strict(),
  },
  // Opens a native OPEN dialog and extracts a package. `takes` are where the
  // embedded copies landed, so the UI can fall back to them for references that
  // no longer resolve on THIS machine. ok=false + empty text on cancel.
  loadPackage: {
    params: z.object({}).strict(),
    result: z
      .object({
        ok: z.boolean(),
        text: z.string(),
        takes: z.array(z.object({ name: z.string(), path: z.string() }).strict()),
        error: z.string(),
      })
      .strict(),
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
  // SCRUB: put the playhead at `frame` (turntable-style dragging). Posted to a
  // render-thread mailbox, so dragging never races the reader. A looping deck
  // still wraps into its region — a loop is a loop.
  deckSeek: {
    params: z
      .object({
        deck: z.number().int().min(0).max(7),
        frame: z.number().int().nonnegative(),
      })
      .strict(),
    result: z.object({ ok: z.boolean() }).strict(),
  },
  // TAPE SCRUB (turntable): hold the record and move it. Unlike deckSeek, which
  // jumps at unchanged pitch, the engine DERIVES the rate from the gap between
  // the deck and where you dragged — so pitch follows hand speed. A scrubbing
  // deck sounds even when idle; a recording deck refuses.
  deckScrub: {
    params: z
      .object({
        deck: z.number().int().min(0).max(7),
        phase: z.enum(['begin', 'to', 'end']),
        frame: z.number().nonnegative(),
      })
      .strict(),
    result: z.object({ ok: z.boolean() }).strict(),
  },
  // OVERDUB (D-WZ-OVERDUB-01): sound-on-sound. The deck keeps playing and sums
  // the input into the same buffer at the playhead. Works on ANY material — a
  // loaded file layers exactly like a recorded take, because a strip is a strip.
  // Refused on an empty deck: with nothing to layer into, that is just recording.
  deckOverdub: {
    params: z
      .object({
        deck: z.number().int().min(0).max(7),
        on: z.boolean(),
        /** sum = sound-on-sound · replace = erase and write. INSERT is not here:
            splicing changes buffer LENGTH, so it cannot be a live render-thread
            mode (see P3-14). */
        mode: z.enum(['sum', 'replace']),
      })
      .strict(),
    result: z.object({ ok: z.boolean() }).strict(),
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
  // --- recording (P3) ------------------------------------------------------
  // Arm + begin capturing the deck's source. The host opens the take file and
  // begins draining; the engine stamps the exact engine sample capture began.
  deckRecordStart: {
    params: z
      .object({
        deck: z.number().int().min(0).max(7),
        // Engine input channels to capture (chan1 = -1 for mono).
        chan0: z.number().int().min(-1),
        chan1: z.number().int().min(-1),
        sourceDesc: z.string(), // human label, stored in the sidecar
      })
      .strict(),
    result: z.object({ ok: z.boolean(), error: z.string() }).strict(),
  },
  // Stop capturing. Returns the take's startEngineSample (Law C-2 anchor) and
  // the finalized Take. If the deck's loop is enabled it is ALREADY looping the
  // captured buffer by the time this returns (Law C-3 — the handoff happened in
  // the engine, in the same render block as the stop).
  deckRecordStop: {
    params: z.object({ deck: z.number().int().min(0).max(7) }).strict(),
    result: z
      .object({
        ok: z.boolean(),
        startEngineSample: z.number().int().nonnegative(),
        take: TakeSchema.nullable(),
      })
      .strict(),
  },
  // The session's takes, newest last. Click one to load it into any deck.
  listTakes: {
    params: z.object({}).strict(),
    result: z.object({ takes: z.array(TakeSchema) }).strict(),
  },
  // Load a previously recorded take into a deck (same path as deckLoadFile but
  // by take path, no dialog).
  deckLoadTake: {
    params: z
      .object({ deck: z.number().int().min(0).max(7), path: z.string().min(1) })
      .strict(),
    result: z
      .object({
        ok: z.boolean(),
        channels: z.number().int().nonnegative(),
        engineFrames: z.number().int().nonnegative(),
        error: z.string(),
      })
      .strict(),
  },
  // Discard a take: the WAV + sidecar are moved to the system Trash (NOT
  // unlinked) so a mis-click is recoverable, and the take leaves the list.
  // Refused while a deck is still recording into that file.
  deleteTake: {
    params: z.object({ path: z.string().min(1) }).strict(),
    result: z.object({ ok: z.boolean(), error: z.string() }).strict(),
  },
  // Show the take in the system file browser (shell-owned).
  revealTake: {
    params: z.object({ path: z.string().min(1) }).strict(),
    result: z.object({ ok: z.boolean() }).strict(),
  },
  // Half-open [startSample, endSample); published atomically (seqlock — the
  // render thread never observes a torn pair). Dispatch lands P1-07.
  // Signed varispeed (P4-02/07): negative = reverse, |rate| clamped to
  // [1/16, 16] by the engine. Exactly ±1 takes the bit-exact identity path.
  // Live control — sent as a command rather than a ParamWrite because it is a
  // deck property, not a channel param.
  deckSetRate: {
    params: z
      .object({ deck: z.number().int().min(0).max(7), rate: z.number() })
      .strict(),
    result: z.object({}).strict(),
  },
  // Waveform envelope for a deck's buffer, one min/max pair per column (P4-06).
  // Pulled on view change, not per frame — the playhead rides HotFrame.
  deckWaveform: {
    params: z
      .object({
        deck: z.number().int().min(0).max(7),
        channel: z.number().int().nonnegative(),
        startFrame: z.number().int().nonnegative(),
        endFrame: z.number().int().nonnegative(),
        columns: z.number().int().positive().max(4096),
      })
      .strict(),
    result: z
      .object({ min: z.array(z.number()), max: z.array(z.number()), frames: z.number().int() })
      .strict(),
  },
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
export type Method = MethodOf<typeof COMMANDS>
export type Params<M extends Method> = ParamsOf<typeof COMMANDS, M>
export type Result<M extends Method> = ResultOf<typeof COMMANDS, M>

// The command envelope is the shared wire format every JUCE-hosted app speaks
// (shared/protocol/envelope.ts, vendored). Re-exported so importers keep
// resolving it from the schema.
export { CommandEnvelopeSchema, CommandReplySchema } from './envelope.ts'
