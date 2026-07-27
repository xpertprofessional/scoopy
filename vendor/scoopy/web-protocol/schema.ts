import { z } from "zod";
import type { MethodOf, ParamsOf, ResultOf } from "./types.ts";

/**
 * SLP — ScoopyLoops Protocol, single source of truth.
 *
 * Everything the UI and the engine agree on is defined here as plain data
 * tables; zod schemas and the generated Swift (`ScoopyLoops/Generated/
 * SLPProtocol.swift`) are both derived from these tables. Never edit the
 * generated Swift by hand — run `npm run protocol:generate`.
 *
 * Bump SCHEMA_VERSION on any breaking change and update both sides in the
 * same increment. Publishes across mismatched versions are refused.
 */
export const SCHEMA_VERSION = 88; // v88: the SPLIT TAP (merge P2-5) — slChannel/setMonitor puts sl_channel_set_monitor on the wire and one appended HotFrame scalar (slChanMonitorMask) reports the engine's own state, because the engine opens the switch at record-start and closes it at the Law C-3 handoff (D-WZ-MON-01/02). Fixes a strip arriving with its input permanently patched and audible, where the only control that stopped the feedback (`M`) also silenced the tape. v87: the plane (merge P2 step 4) — slChannel/slTape/slRoute/slRouteList/slRecord/slTakes put the merged engine's strip surface (sl_channel_*/sl_tape_*/sl_route_*) on the wire, plus 42 appended HotFrame scalars (per-channel peaks, tape playhead/state/cap, the watchdog lamp). Answered by WizardMerged only; ScoopyLoops.app refuses them like any unimplemented method. v86: shared-envelope convergence (shared/ROLLOUT.md phase 5 / merge P0-A) — command replies carry `ok` ({id, ok, result?, error?}, mirrors shared/protocol/envelope.ts), every schema object is `.strict()`. v85: MOD-11 "SHAPES" — ModChannelState gains warp/curve/fold/quant/chaos macros + stageCount/stageLevels/stageGlide step layer.

// ---------------------------------------------------------------------------
// ParamWrite — fine-grained live controls (audio-thread atomics on the
// native side). v1 covers the spectral panel subset; extended per panel.
// `deck` scopes to a DJ deck (0 = composition), `track` to a track index.
// ---------------------------------------------------------------------------
// Mirrors the post-carve-down facade surface (see panels/spectral.md §4).
// deckBusChaos/deckBusAir are a pair: Swift caches both per deck and always
// calls setDeckBusSpectral(deck:chaos:airDb:) with the latest of each.
export const PARAM_IDS = [
  "deckBusTexture", // v: 0..1, deck-scoped → setDeckBusTexture
  "deckBusChaos", // v: -1..1, deck-scoped → setDeckBusSpectral (paired)
  "deckBusAir", // v: 0..12 dB, deck-scoped → setDeckBusSpectral (paired)
  // INSP-3 (Direction B): the master clipper ParamWrite ids (Drive/Threshold/
  // Softness/Ceiling) were retired with the Master FX sheet. All clipper params
  // are now hardcoded at the engine boundary (AudioEngineFacade.MasterClipperPin);
  // DRIVE stays live on the master-row DRV box via `sessionMasterDrive`.
  // Toolbar / Deck Mixer (panels/toolbar.md §4). deck field = deck index;
  // `track` field carries the return index for send/return params.
  "deckVolume", // 0..1, deck-scoped
  "deckMuted", // 0|1, deck-scoped (transient engine atomic, post-send-tap)
  "deckSoloed", // 0|1, deck-scoped (exclusive-additive)
  "sendSoloed", // 0|1, track=returnIndex (1-based)
  "returnVolume", // 0..2, track=returnIndex (1..4 — 3/4 are app-global on AudioDeviceManager)
  "masterTempo", // 0..300 BPM, global
  "crossfaderPosition", // 0..1, global
  "crossfaderEngaged", // 0|1, global — explicit opt-in for crossfader ducking (persisted djMode.crossfaderEngaged)
  "micGain", // 0..1
  "micMonitorOn", // 0|1
  "micMuted", // 0|1
  "micSendLevel", // 0..1, track=returnIndex (1..4 since MIX-NATIVE-3)
  "deckTranspose", // -12..12 semitones, deck-scoped (writes deckState + refresh)
  "returnMuted", // 0|1, track=returnIndex (1..4 — 3/4 mute app-globally, mixer overhaul)
  "sendMasterGain", // 0..2, track=returnIndex (1..4)
  "deckMasterSend", // 0..1, deck-scoped, track=returnIndex (1..4) — deck full output → FX bus (pre-fader/pre-mute)
  // --- DJ view (P6-02, panels/djmode.md). X·MIX *is* the crossfader here: the
  // classic constant-power blend and crossfader-driven tempo blending ("smart
  // BPM") are workflow-dead and get NO web surface. These ride the ParamWrite
  // lane for the same reason crossfaderEngaged does — live gestures, and the
  // owner (DJModeManager) persists + republishes on write.
  "xmixEnabled", // 0|1, global (persisted djMode.xmixEnabled)
  "xmixStrength", // 0..1, global — carve depth
  "xmixFullerCurve", // 0|1, global — γ=0.5 volume curve (both decks stay loud)
  "xmixShimmer", // 0|1, global — carved bands ring back instead of just ducking
  "xmixShimmerAmount", // 0..1, global
  "deckCEnabled", // 0|1, global — enabling/disabling deck C also drives its transport
  // Transient sync NUDGE: a BPM delta on top of the locked sync rate (never
  // mutates bpm/originalBpm — see BeatSequencer.applyDJNudge). Write 0 on
  // release to snap back to lock.
  "deckNudgeBpm", // −20..20 BPM, deck-scoped
  // --- Master track row (P6-08, djmode.md §4C). PER-SEQUENCER, so they take
  // the same optional `deck` scope as gridEdit: absent = the compose grid
  // resolver's sequencer, 0|1|2 = that DJ deck. This is the SESSION tempo the
  // deck plays at (BeatSequencer.updateMasterTrackBPM) — NOT the DJ master
  // tempo (`masterTempo`, global, which synced decks FOLLOW).
  "sessionBpm", // 20..200 BPM, deck-scoped
  "sessionMasterVolume", // 0..2 (display ×100; native reset 0.8), deck-scoped
  "sessionMasterDrive", // 1..32 clipper drive (compose row only), deck-scoped
] as const;
export type ParamId = (typeof PARAM_IDS)[number];

export const ParamWrite = z.object({
  p: z.enum(PARAM_IDS),
  deck: z.number().int().min(0).max(3).optional(),
  track: z.number().int().min(0).optional(),
  v: z.number(),
}).strict();
export type ParamWrite = z.infer<typeof ParamWrite>;

// ---------------------------------------------------------------------------
// HotFrame — 30 Hz engine→UI push, one flat Float64Array. UI code must only
// index via this layout table (generated into Swift as SLPHotFrameIndex).
// ---------------------------------------------------------------------------
export const SPECTRUM_BIN_COUNT = 16;

export const HOT_FRAME_SCALARS = [
  "frameCounter", // monotonic, detects dropped frames / jitter measurement
  "hostTimeMs", // host clock at capture, for client-side dead-reckoning
  "playheadStepDeck0",
  "playheadStepDeck1",
  "playheadStepDeck2",
  "outputPeakL", // read-and-reset peaks, linear 0..1+
  "outputPeakR",
  "outputClip", // 0|1 latched clip (native clip threshold 0.999)
  "inputPeak",
  "callbackLoad", // 0..1 render-callback CPU load peak
  "deadlineMissCount", // cumulative
  // Master mod-channel live monitor levels (M1–M4), deck 0 — pure atomic
  // loads via nativeDeckModChannelValue. Feed the Master FX LFO monitors.
  "modChannel0",
  "modChannel1",
  "modChannel2",
  "modChannel3",
  // MOD-3: normalised PROGRESS through each channel's shape, 0..1 — the playhead that rides the
  // static curve the Mod Lab draws. -1 = nothing to ride (an env-follower, which has no static
  // shape, or an envelope sitting idle between gates). Backed by deckModChannelPhase (MOD-2), a
  // relaxed atomic read of state the render loop already maintains — zero audio-thread cost.
  "modChannelPhase0",
  "modChannelPhase1",
  "modChannelPhase2",
  "modChannelPhase3",
  // Toolbar: per-deck LCM cycle (position, length in steps) + mic level
  // (already-decayed MicChannel.inputLevel — no extra atomic drain).
  "lcmPosDeck0",
  "lcmLenDeck0",
  "lcmPosDeck1",
  "lcmLenDeck1",
  "lcmPosDeck2",
  "lcmLenDeck2",
  "micInputLevel",
  // File browser (BR-2): the audition player's level, and its playhead as a
  // 0..1 fraction of the previewed file. A meter is a meter — it rides the
  // 30 Hz frame like every other one rather than a UiState push storm (the
  // native browser polls its AVAudioPlayer on a 20 Hz timer for exactly this).
  // -1 = nothing playing.
  "previewLevel",
  "previewProgress",
  // Grid (P5-01): per-track RESOLVED playhead steps for the composition
  // deck (locator/phase/free-rate/direction-aware via getCurrentTrackStep);
  // -1 = not playing. 16 slots (kMaxGridTracks).
  "trackStep0", "trackStep1", "trackStep2", "trackStep3",
  "trackStep4", "trackStep5", "trackStep6", "trackStep7",
  "trackStep8", "trackStep9", "trackStep10", "trackStep11",
  "trackStep12", "trackStep13", "trackStep14", "trackStep15",
  // DJ (P6-02): the same resolved per-track playhead, but DECK-SCOPED. The
  // block above follows the grid RESOLVER (one deck — whichever the compose
  // view shows); the DJ view renders two deck grids side by side, so it needs
  // all three decks explicitly (deck C projects into a slot, so which two are
  // visible varies). Cost: 48 extra Float64 @ 30 Hz ≈ 11.5 KB/s — negligible,
  // and it keeps the compose block (and the P5-04 shadow-drift evidence that
  // rides on it) untouched.
  "djTrackStepD0T0", "djTrackStepD0T1", "djTrackStepD0T2", "djTrackStepD0T3",
  "djTrackStepD0T4", "djTrackStepD0T5", "djTrackStepD0T6", "djTrackStepD0T7",
  "djTrackStepD0T8", "djTrackStepD0T9", "djTrackStepD0T10", "djTrackStepD0T11",
  "djTrackStepD0T12", "djTrackStepD0T13", "djTrackStepD0T14", "djTrackStepD0T15",
  "djTrackStepD1T0", "djTrackStepD1T1", "djTrackStepD1T2", "djTrackStepD1T3",
  "djTrackStepD1T4", "djTrackStepD1T5", "djTrackStepD1T6", "djTrackStepD1T7",
  "djTrackStepD1T8", "djTrackStepD1T9", "djTrackStepD1T10", "djTrackStepD1T11",
  "djTrackStepD1T12", "djTrackStepD1T13", "djTrackStepD1T14", "djTrackStepD1T15",
  "djTrackStepD2T0", "djTrackStepD2T1", "djTrackStepD2T2", "djTrackStepD2T3",
  "djTrackStepD2T4", "djTrackStepD2T5", "djTrackStepD2T6", "djTrackStepD2T7",
  "djTrackStepD2T8", "djTrackStepD2T9", "djTrackStepD2T10", "djTrackStepD2T11",
  "djTrackStepD2T12", "djTrackStepD2T13", "djTrackStepD2T14", "djTrackStepD2T15",
  // SIG-1 — WHERE INSIDE THE SAMPLE each track's newest voice actually is, as a
  // fraction of its source buffer (0…1). -1 = nothing sounding.
  //
  // The trackStep blocks above answer "which CELL is playing". This answers
  // "where in the AUDIO", and the two disagree constantly: a REG cell spanning
  // eight steps, a pitched or varispeed voice eating its buffer faster than the
  // clock, a reversed cell running backwards, an OWN tail still ringing three
  // cells later. The grid draws its waveform from these same source frames, so a
  // fraction maps straight onto a drawn column — no shared knowledge of trim,
  // chop, stretch or reverse needed on either side.
  //
  // This is what turns the playhead from a flat rectangle sliding over a cell
  // into a cursor that reads the waveform it is standing on.
  "trackPos0", "trackPos1", "trackPos2", "trackPos3",
  "trackPos4", "trackPos5", "trackPos6", "trackPos7",
  "trackPos8", "trackPos9", "trackPos10", "trackPos11",
  "trackPos12", "trackPos13", "trackPos14", "trackPos15",
  // …and the deck-scoped mirror, for the same reason the djTrackStep block
  // exists: the DJ view renders deck grids side by side and must not fall back
  // to a quantized playhead while compose has a truthful one.
  "djTrackPosD0T0", "djTrackPosD0T1", "djTrackPosD0T2", "djTrackPosD0T3",
  "djTrackPosD0T4", "djTrackPosD0T5", "djTrackPosD0T6", "djTrackPosD0T7",
  "djTrackPosD0T8", "djTrackPosD0T9", "djTrackPosD0T10", "djTrackPosD0T11",
  "djTrackPosD0T12", "djTrackPosD0T13", "djTrackPosD0T14", "djTrackPosD0T15",
  "djTrackPosD1T0", "djTrackPosD1T1", "djTrackPosD1T2", "djTrackPosD1T3",
  "djTrackPosD1T4", "djTrackPosD1T5", "djTrackPosD1T6", "djTrackPosD1T7",
  "djTrackPosD1T8", "djTrackPosD1T9", "djTrackPosD1T10", "djTrackPosD1T11",
  "djTrackPosD1T12", "djTrackPosD1T13", "djTrackPosD1T14", "djTrackPosD1T15",
  "djTrackPosD2T0", "djTrackPosD2T1", "djTrackPosD2T2", "djTrackPosD2T3",
  "djTrackPosD2T4", "djTrackPosD2T5", "djTrackPosD2T6", "djTrackPosD2T7",
  "djTrackPosD2T8", "djTrackPosD2T9", "djTrackPosD2T10", "djTrackPosD2T11",
  "djTrackPosD2T12", "djTrackPosD2T13", "djTrackPosD2T14", "djTrackPosD2T15",
  // SIG-3 — IS THE TRACK MAKING SOUND? Real post-plugin decayed peak of the
  // track's mix contribution, linear (0 = silent). Drives the track-row LED.
  //
  // The playhead blocks above are sequencer-side truths and go to -1 the moment
  // transport stops — they cannot see plugin-generated audio (an arpeggiator, a
  // long release, a self-playing instrument). This is measured off the actual
  // rendered contribution (post mute-gain, so a muted track reads 0) and decays
  // in the ENGINE (~-60 dB in 300 ms), so reads are plain and idempotent —
  // never gate these on isPlaying; that gate is the blindness this block fixes.
  "trackLevel0", "trackLevel1", "trackLevel2", "trackLevel3",
  "trackLevel4", "trackLevel5", "trackLevel6", "trackLevel7",
  "trackLevel8", "trackLevel9", "trackLevel10", "trackLevel11",
  "trackLevel12", "trackLevel13", "trackLevel14", "trackLevel15",
  // …and the deck-scoped mirror, same reason as djTrackStep/djTrackPos: the DJ
  // view renders deck grids side by side and every row needs its own LED.
  "djTrackLevelD0T0", "djTrackLevelD0T1", "djTrackLevelD0T2", "djTrackLevelD0T3",
  "djTrackLevelD0T4", "djTrackLevelD0T5", "djTrackLevelD0T6", "djTrackLevelD0T7",
  "djTrackLevelD0T8", "djTrackLevelD0T9", "djTrackLevelD0T10", "djTrackLevelD0T11",
  "djTrackLevelD0T12", "djTrackLevelD0T13", "djTrackLevelD0T14", "djTrackLevelD0T15",
  "djTrackLevelD1T0", "djTrackLevelD1T1", "djTrackLevelD1T2", "djTrackLevelD1T3",
  "djTrackLevelD1T4", "djTrackLevelD1T5", "djTrackLevelD1T6", "djTrackLevelD1T7",
  "djTrackLevelD1T8", "djTrackLevelD1T9", "djTrackLevelD1T10", "djTrackLevelD1T11",
  "djTrackLevelD1T12", "djTrackLevelD1T13", "djTrackLevelD1T14", "djTrackLevelD1T15",
  "djTrackLevelD2T0", "djTrackLevelD2T1", "djTrackLevelD2T2", "djTrackLevelD2T3",
  "djTrackLevelD2T4", "djTrackLevelD2T5", "djTrackLevelD2T6", "djTrackLevelD2T7",
  "djTrackLevelD2T8", "djTrackLevelD2T9", "djTrackLevelD2T10", "djTrackLevelD2T11",
  "djTrackLevelD2T12", "djTrackLevelD2T13", "djTrackLevelD2T14", "djTrackLevelD2T15",
  // SIG-2 — THE CARVE, MADE VISIBLE. 8 carve nodes × 6 bands = how much X-MIX is
  // EATING out of each node right now (0 = untouched, 1 = the band is gone).
  //
  // Node order is the engine's own (kMaxCarveNodes): decks A/B/C, FX returns
  // 1–4, then the input. Bands are split at 60 / 200 / 600 / 1800 / 5000 Hz
  // (kCarveCrossoverHz), so each segment is a real frequency range, not an index.
  //
  // This is `1 - carveStage_[node].gain[band]` — the duck ACTUALLY APPLIED to the
  // audio this callback, not a setting, not a prediction. The carve is the most
  // characteristic thing this engine does and it has never had a picture: the
  // mixer shows a fader that isn't moving while the sound hollows out underneath
  // it, which makes the signature move look like nothing is happening.
  "carveN0B0", "carveN0B1", "carveN0B2", "carveN0B3", "carveN0B4", "carveN0B5",
  "carveN1B0", "carveN1B1", "carveN1B2", "carveN1B3", "carveN1B4", "carveN1B5",
  "carveN2B0", "carveN2B1", "carveN2B2", "carveN2B3", "carveN2B4", "carveN2B5",
  "carveN3B0", "carveN3B1", "carveN3B2", "carveN3B3", "carveN3B4", "carveN3B5",
  "carveN4B0", "carveN4B1", "carveN4B2", "carveN4B3", "carveN4B4", "carveN4B5",
  "carveN5B0", "carveN5B1", "carveN5B2", "carveN5B3", "carveN5B4", "carveN5B5",
  "carveN6B0", "carveN6B1", "carveN6B2", "carveN6B3", "carveN6B4", "carveN6B5",
  "carveN7B0", "carveN7B1", "carveN7B2", "carveN7B3", "carveN7B4", "carveN7B5",
  // ── THE PLANE (merge P2 step 4) ──────────────────────────────────────────
  //
  // APPENDED, never inserted. Indices are positional (HotFrameLayout derives
  // them from this array's order), so inserting anywhere above renumbers every
  // scalar after it and silently re-points every meter in the app. The merged
  // engine generates its C++ index header from this file
  // (apps/wizard/web/scripts/generateHotFrame.ts), so a mid-array insert is a
  // wire break that both sides would have to move together.
  //
  // All of it is telemetry the plane's canvases read on their rAF loop — never
  // through React state. These are the only engine reads the strip does at
  // frame rate; everything else it knows comes from the document.
  //
  // Per-strip-channel peak, post-level and post-mute — the same tap point the
  // record bus and a route use, so the meter shows what the strip CONTRIBUTES.
  // A muted strip therefore reads 0, which is correct and worth knowing before
  // someone files it as a bug.
  "slChanPeakL0", "slChanPeakL1", "slChanPeakL2", "slChanPeakL3",
  "slChanPeakL4", "slChanPeakL5", "slChanPeakL6", "slChanPeakL7",
  "slChanPeakR0", "slChanPeakR1", "slChanPeakR2", "slChanPeakR3",
  "slChanPeakR4", "slChanPeakR5", "slChanPeakR6", "slChanPeakR7",
  // Tape playhead in FRAMES (sl_tape_playhead). Fractional while varispeeding.
  "slTapePlayhead0", "slTapePlayhead1", "slTapePlayhead2", "slTapePlayhead3",
  "slTapePlayhead4", "slTapePlayhead5", "slTapePlayhead6", "slTapePlayhead7",
  // Tape state: 0 idle · 1 loop · 2 one-shot · 3 recording (sl_tape_state).
  // The strip's state word and its whole transport-enablement ladder read this
  // rather than the document, because the ENGINE owns what is playing — a
  // document that thinks it is looping while the tape stopped is the drift the
  // record→material transition (Law C-3) is most likely to produce.
  "slTapeState0", "slTapeState1", "slTapeState2", "slTapeState3",
  "slTapeState4", "slTapeState5", "slTapeState6", "slTapeState7",
  // The 256 MB record cap, reached (sl_tape_record_cap_reached). Its own scalar
  // because the tape STOPS ITSELF and goes to loop: without this the UI shows a
  // perfectly ordinary looping tape and never says why recording ended.
  "slTapeCap0", "slTapeCap1", "slTapeCap2", "slTapeCap3",
  "slTapeCap4", "slTapeCap5", "slTapeCap6", "slTapeCap7",
  // The watchdog lamp: engaged (1 while limiting, including the hold tail) and
  // the gain it is applying (1.0 = not limiting). Global, not per strip — the
  // RMS limiter is on the main pair.
  "slWatchdogEngaged", "slWatchdogGain",
  // ── THE MONITOR SWITCHES (merge P2-5 increment 1) ────────────────────────
  //
  // All eight channels' monitor state as a BITMASK: bit c = channel c's input
  // reaches its channel. One scalar rather than eight, because eight booleans
  // are eight bits and a float64 carries them exactly — and appending eight
  // near-empty scalars to carry one bit each would cost more to read than the
  // mask does to decode.
  //
  // ⚠️ IT HAS TO BE HERE RATHER THAN INFERRED FROM THE DOCUMENT, because the
  // ENGINE moves these switches by itself: record-start opens one
  // (D-WZ-MON-01), the Law C-3 record→loop handoff closes it in the same render
  // block (D-WZ-MON-02). A strip drawing MON from what it last asked for would
  // show it lit over a closed gate the moment a loop closed — the exact drift
  // `sl_deck_tempo_sync` was added to end for tempo sync.
  "slChanMonitorMask",
] as const;

/** Is channel `channel`'s monitor open, decoded from `slChanMonitorMask`? */
export const slChannelMonitorOn = (mask: number, channel: number): boolean =>
  (Math.round(mask) & (1 << channel)) !== 0;

/** X-MIX carve: 8 nodes (decks A/B/C · FX returns 1–4 · input) × 6 bands. */
export const CARVE_NODES = 8;
export const CARVE_BANDS = 6;

/** The band split points (kCarveCrossoverHz). Labels a segment by real frequency. */
export const CARVE_CROSSOVERS_HZ = [60, 200, 600, 1800, 5000] as const;

/** HotFrame index of carve node `node`'s band `band` depth (SIG-2). */
export const carveIndex = (node: number, band: number): number =>
  HotFrameLayout[`carveN${node}B${band}` as (typeof HOT_FRAME_SCALARS)[number]];

export const MAX_GRID_TRACKS = 16;

export const HotFrameLayout = Object.fromEntries(
  HOT_FRAME_SCALARS.map((name, i) => [name, i]),
) as Record<(typeof HOT_FRAME_SCALARS)[number], number>;

export const HOT_FRAME_SPECTRUM_BASE = HOT_FRAME_SCALARS.length;
export const HOT_FRAME_LENGTH = HOT_FRAME_SPECTRUM_BASE + SPECTRUM_BIN_COUNT;

/** HotFrame index of deck `deck`'s track `track` SAMPLE POSITION (SIG-1). */
export const djTrackPosIndex = (deck: number, track: number): number =>
  HotFrameLayout[
    `djTrackPosD${deck}T${track}` as (typeof HOT_FRAME_SCALARS)[number]
  ];

/** HotFrame index of deck `deck`'s track `track` playhead (DJ view, P6-02). */
export const djTrackStepIndex = (deck: number, track: number): number =>
  HotFrameLayout[
    `djTrackStepD${deck}T${track}` as (typeof HOT_FRAME_SCALARS)[number]
  ];

/** HotFrame index of deck `deck`'s track `track` activity LEVEL (SIG-3). */
export const djTrackLevelIndex = (deck: number, track: number): number =>
  HotFrameLayout[
    `djTrackLevelD${deck}T${track}` as (typeof HOT_FRAME_SCALARS)[number]
  ];

/** Strip channels (sl_channel_count) and tapes (sl_tape_count) on the plane. */
export const SL_CHANNEL_COUNT = 8;
export const SL_TAPE_COUNT = 8;

/** HotFrame index of strip channel `channel`'s peak on `side` (the plane). */
export const slChanPeakIndex = (channel: number, side: "L" | "R"): number =>
  HotFrameLayout[`slChanPeak${side}${channel}` as (typeof HOT_FRAME_SCALARS)[number]];

/** HotFrame index of tape `tape`'s `field` (the plane). */
export const slTapeIndex = (
  tape: number,
  field: "Playhead" | "State" | "Cap",
): number =>
  HotFrameLayout[`slTape${field}${tape}` as (typeof HOT_FRAME_SCALARS)[number]];

/** What `slTapeState<n>` carries. Mirrors sl_tape_state's return, which is the
    engine's own truth about the tape — not the document's belief about it. */
export const SL_TAPE_STATE = {
  idle: 0,
  loop: 1,
  oneShot: 2,
  recording: 3,
} as const;

// ---------------------------------------------------------------------------
// Commands — JSON-RPC style, human-rate, async replies.
// ---------------------------------------------------------------------------
export const Capabilities = z.object({
  schemaVersion: z.number().int(),
  pluginHosting: z.boolean(),
  fileSystem: z.boolean(),
  midiHardware: z.boolean(),
  audioDeviceSelection: z.boolean(),
  /** The send/return FX section exists on this host. False in the browser: the WASM render would
   *  only feed the returns' C++ DEFAULT parameters (not the session's), so the honest shape is no
   *  sends surface and a dry render — not a wrong-sounding echo nobody can edit. */
  returnFx: z.boolean(),
}).strict();
export type Capabilities = z.infer<typeof Capabilities>;

export const StereoPair = z.object({
  id: z.number().int(),
  channel1: z.number().int(),
  channel2: z.number().int(),
}).strict();
export type StereoPair = z.infer<typeof StereoPair>;

export const AudioDevice = z.object({
  id: z.number().int(), // CoreAudio AudioDeviceID
  name: z.string(),
  uid: z.string().nullable(),
  hasInput: z.boolean(),
  hasOutput: z.boolean(),
  inputChannelCount: z.number().int(),
  outputChannelCount: z.number().int(),
  inputStereoPairs: z.array(StereoPair),
  outputStereoPairs: z.array(StereoPair),
}).strict();
export type AudioDevice = z.infer<typeof AudioDevice>;

export const MidiEndpoint = z.object({
  id: z.number().int(), // MIDIUniqueID
  name: z.string(),
  manufacturer: z.string(),
  isOnline: z.boolean(),
}).strict();
export type MidiEndpoint = z.infer<typeof MidiEndpoint>;

export const MidiMapping = z.object({
  id: z.string(), // UUID
  learnId: z.string(), // human-readable target label + native remove key
  ccNumber: z.number().int(),
  channel: z.number().int(),
  minValue: z.number(),
  maxValue: z.number(),
  curve: z.enum(["Linear", "Exponential", "Logarithmic", "S-Curve"]),
  inverted: z.boolean(),
}).strict();
export type MidiMapping = z.infer<typeof MidiMapping>;

// method name -> { params, result } zod pair.
// Settings values are JSON-encoded UserDefaults values (string/number/bool/
// object); `null` result = key absent. Dialog purposes map to a fixed
// UserDefaults key + security-scoped bookmark minted Swift-side
// (see panels/settings.md §9).
// Hoisted above COMMANDS: the `modChannel/setEnvelope` command carries a full MSEG,
// so the node shape must exist before the command table is evaluated.
export const EnvelopeNode = z.object({
  value: z.number(), // 0..1 as STORED. A bipolar envelope reinterprets it: 0.5 = centre.
  timeMs: z.number(), // segment length INTO this node, not an absolute timestamp
  // MOD-3: power-curve exponent, applied as pow(frac, max(0.01, curve)); 1 = linear. The engine
  // has honoured this since the modulation overhaul (NativeAudioEngineCore.cpp:110) but nothing
  // could ever SET it — the native curve editor only moves nodes. The Lab's segment-bend does.
  curve: z.number(),
}).strict();

export const COMMANDS = {
  getCapabilities: {
    params: z.object({}).strict(),
    result: Capabilities,
  },
  getSetting: {
    params: z.object({ key: z.string() }).strict(),
    result: z.object({ value: z.unknown().nullable() }).strict(),
  },
  setSetting: {
    params: z.object({ key: z.string(), value: z.unknown() }).strict(),
    result: z.object({}).strict(),
  },
  getSettings: {
    params: z.object({ keys: z.array(z.string()) }).strict(),
    result: z.object({ values: z.record(z.string(), z.unknown()) }).strict(),
  },
  // Re-bakes every loaded sample (all sequencers/decks) with the current
  // vintage import settings. count = samples re-baked in the composition
  // sequencer's bank (DJ decks re-bake in parallel via notification fan-out).
  reprocessSamples: {
    params: z.object({}).strict(),
    result: z.object({ count: z.number().int() }).strict(),
  },
  chooseDirectory: {
    params: z.object({ purpose: z.enum(["recordings", "defaultKit"]) }).strict(),
    result: z.object({ path: z.string().nullable() }).strict(),
  },
  // Background image (kept per 2026-07-10 CONFIRM). The image crosses as a
  // data URL because the WKWebView cannot read arbitrary local paths; the
  // path + bookmark persist Swift-side in ThemeManager (BG-FIX 2026-07-14:
  // one canonical store — the native window layer renders it app-wide behind
  // transparent webviews; the legacy web.backgroundImage keys are migrated).
  chooseImageFile: {
    params: z.object({ purpose: z.enum(["background"]) }).strict(),
    result: z.object({ path: z.string().nullable(), dataUrl: z.string().nullable() }).strict(),
  },
  getBackgroundImage: {
    params: z.object({}).strict(),
    result: z.object({ dataUrl: z.string().nullable() }).strict(),
  },
  clearBackgroundImage: { params: z.object({}).strict(), result: z.object({}).strict() },
  // Background style: the web Appearance pane edits tokens.background and
  // mirrors them here so the NATIVE layer (the thing actually painting the
  // image) follows live. Opacity is applied natively ONLY — the page body is
  // fully transparent while an image is live, or the veil would double.
  setBackgroundStyle: {
    params: z.object({
      opacityPct: z.number().int().min(0).max(100),
      mode: z.enum(["fill", "fit", "stretch", "tile", "tileMirror"]),
      tileSizing: z.enum(["scale", "count"]),
      tileScalePct: z.number().int().min(25).max(400),
      tileCountPerRow: z.number().int().min(1).max(16),
      motion: z.enum(["none", "drift", "breathe"]),
      shakeEnabled: z.boolean(),
      shakeIntensityPct: z.number().int().min(0).max(100),
    }).strict(),
    result: z.object({}).strict(),
  },
  // Typed audio-device surface (panels/settings.md §9). Device id 0 =
  // system default. selectAudioOutputDevice is deferred-apply and reopens
  // the device; success=false means the open failed and the UI shows it.
  enumerateAudioDevices: {
    params: z.object({}).strict(),
    result: z.object({
      inputs: z.array(AudioDevice),
      outputs: z.array(AudioDevice),
      selectedInputId: z.number().int(),
      selectedOutputId: z.number().int(),
      preferredBufferFrames: z.number().int(),
      inputIsStereo: z.boolean(),
      inputStartChannel: z.number().int(),
    }).strict(),
  },
  refreshAudioDevices: { params: z.object({}).strict(), result: z.object({}).strict() },
  selectAudioInputDevice: {
    params: z.object({ deviceId: z.number().int() }).strict(),
    result: z.object({}).strict(),
  },
  setAudioInputChannelConfig: {
    params: z.object({ startChannel: z.number().int(), stereo: z.boolean() }).strict(),
    result: z.object({}).strict(),
  },
  selectAudioOutputDevice: {
    params: z.object({ deviceId: z.number().int() }).strict(),
    result: z.object({ success: z.boolean() }).strict(),
  },
  setAudioBufferFrames: {
    params: z.object({ frames: z.number().int() }).strict(), // 0=auto, 128, 256, 512
    result: z.object({ success: z.boolean() }).strict(),
  },
  setPerTrackOutputRouting: {
    params: z.object({ enabled: z.boolean(), deviceUid: z.string() }).strict(),
    result: z.object({}).strict(),
  },
  setDeckOutputChannels: {
    params: z.object({
      deck: z.enum(["A", "B", "C"]),
      channels: z.array(z.number().int()).nullable(),
    }).strict(),
    result: z.object({}).strict(),
  },
  setSendOutputChannel: {
    params: z.object({
      sendIndex: z.number().int().min(1).max(4),
      channel: z.number().int(), // -1 = none
    }).strict(),
    result: z.object({}).strict(),
  },
  // Pops the device picker + hardware routing matrix (the "audio" panel) out
  // into a floating window, from the mixer's routing toggle (MIX-R5).
  openAudioRoutingWindow: {
    params: z.object({}).strict(),
    result: z.object({}).strict(),
  },
  // Pops the plugin scanner/picker + return settings for one send into a
  // floating window (MIX-R8). An in-page popover cannot escape the mixer's
  // short WKWebView, so it was being clipped away entirely.
  openFxSlotWindow: {
    params: z.object({ returnIndex: z.number().int().min(1).max(4) }).strict(),
    result: z.object({}).strict(),
  },
  // The track's INSTRUMENT window — the exact same shape as the FX-slot window, and for the
  // exact same reason (MIX-R8): a plugin picker CANNOT live in an in-page popover, because a
  // popover cannot escape its host WKWebView. One floating window, retargeted per track.
  openInstrumentWindow: {
    params: z.object({
      trackIndex: z.number().int().min(0),
      deck: z.number().int().min(0).max(2).optional(),
    }).strict(),
    result: z.object({}).strict(),
  },
  getAudioInputStatus: {
    params: z.object({}).strict(),
    result: z.object({ activeInputChannels: z.number().int() }).strict(),
  },
  // Typed MIDI surface (panels/settings.md §9). Endpoint id 0 = none.
  // Selections persist Swift-side (CONFIRM 2026-07-10).
  enumerateMidiEndpoints: {
    params: z.object({}).strict(),
    result: z.object({
      sources: z.array(MidiEndpoint),
      destinations: z.array(MidiEndpoint),
      enabled: z.boolean(),
      ccDeviceId: z.number().int(),
      noteDeviceId: z.number().int(),
      clockDeviceId: z.number().int(),
      clockOutputId: z.number().int(),
      syncMode: z.enum(["internalMaster", "externalSlave"]),
      slaveTransportPolicy: z.enum(["fullTransport", "tempoAndPhaseOnly"]),
    }).strict(),
  },
  refreshMidiDevices: { params: z.object({}).strict(), result: z.object({}).strict() },
  setMidiEnabled: {
    params: z.object({ enabled: z.boolean() }).strict(),
    result: z.object({}).strict(),
  },
  selectMidiDevice: {
    params: z.object({
      role: z.enum(["cc", "note", "clock", "clockOutput"]),
      deviceId: z.number().int(),
    }).strict(),
    result: z.object({}).strict(),
  },
  setMidiSyncMode: {
    params: z.object({ mode: z.enum(["internalMaster", "externalSlave"]) }).strict(),
    result: z.object({}).strict(),
  },
  setMidiSlaveTransportPolicy: {
    params: z.object({ policy: z.enum(["fullTransport", "tempoAndPhaseOnly"]) }).strict(),
    result: z.object({}).strict(),
  },
  getMidiClockStatus: {
    params: z.object({}).strict(),
    result: z.object({
      locked: z.boolean(),
      bpm: z.number(),
      tickCount: z.number().int(),
    }).strict(),
  },
  // Mappings sub-domain (P2-08b). Learn INITIATION stays native until web
  // controls exist (Phase 3 MIDI-learn hooks) — targets are registered
  // native components. Editable fields match the native detail sheet:
  // curve + inverted; ranges are read-only.
  getMidiMappings: {
    params: z.object({}).strict(),
    result: z.object({ mappings: z.array(MidiMapping) }).strict(),
  },
  updateMidiMapping: {
    params: z.object({
      id: z.string(), // UUID
      curve: z.enum(["Linear", "Exponential", "Logarithmic", "S-Curve"]),
      inverted: z.boolean(),
    }).strict(),
    result: z.object({}).strict(),
  },
  removeMidiMapping: {
    params: z.object({ learnId: z.string() }).strict(), // native remove is learnId-keyed
    result: z.object({}).strict(),
  },
  clearMidiMappings: { params: z.object({}).strict(), result: z.object({}).strict() },
  // MIDI LEARN from web controls (CM-2). Supersedes the P2-08b note that learn
  // initiation "stays native until web controls exist" — they exist now.
  //
  // Addressing mirrors `MIDILearnSystem` semantics exactly, and Swift owns the
  // learnId grammar (the web never builds a learnId string):
  //  • trackParam — native `createMapping` DISCARDS the track UUID and stores
  //    `.trackParam(token)`, so a mapping is TRACK-AGNOSTIC: it fires on
  //    whatever track is SELECTED at CC time. The web therefore names the
  //    param token + the row it was clicked on, and Swift resolves the UUID.
  //    (Consequence, and it is native's: mapping volume on ONE track shows
  //    "Mapped: CC12" on EVERY track's volume box. That is the feature.)
  //  • singleton — master/transport controls, addressed by their native learnId
  //    ("master_bpm"), so a CC learned in SwiftUI drives the web box and back.
  // Scene overrides (CM-3) — native `sceneOverrideContextMenuItems`
  // (TrackFXSettingsView:699). A parameter edit normally flows to the shared
  // global base; PINNING it makes it scene-local, so it can differ per scene.
  // Keyed by the same strings native uses: "bpm" / "track.<row>.pan".
  /**
   * MOD-3 — the modulation channels M1–M4 (panels/modulation.md §7).
   *
   * These are STRUCTURAL edits (they change what a modulator IS), so they ride Commands and
   * Swift owns the write via @Published → pushState — not ParamWrites. `setEnvelope` carries the
   * whole breakpoint shape and commits on drag-end; node drags are local until release.
   *
   * `arm` is the arm-to-map latch: Swift owns `armedModChannel` and pushes it as UiState to BOTH
   * webviews, because a DOM overlay cannot cross a WKWebView boundary (same wall as Phase CM).
   */
  modChannel: {
    params: z.object({
      op: z.enum([
        "setType", // → setModChannelType — ALSO syncs the legacy waveform for M1/M2 (see spec §2)
        "setWaveform", // → sine/triangle/square/saw/random (envelopeFollower is a TYPE now, not a wave)
        // LFO-DIV rework: the FREE/SYNC + division-index model was replaced by a grid-cell cycle.
        "setCycleSteps", // → cycle length in grid steps, 1…64 (value rounded/clamped)
        "setCycleRatio", // → raw speed ratio; Swift snaps to the SpeedRatioTiming detent table
        "setLcmMode", // → 0/1; when on, cycle base = pattern LCM instead of the step counter
        "setPhaseOffset", // → 0…1
        "setSymmetry", // → LEGACY (MOD-10 superseded it with setSlant); kept so old UIs don't break
        "setSmooth", // → follower smoothing
        // --- MOD-10 macros: the LFO's actual shape ---
        "setSlant", // → −1…1
        "setEase", // → −1…1
        "setJitter", // → 0…1
        "setCyclic", // → 0…1
        // --- MOD-11 SHAPES macros ---
        "setWarp", // → −1…1 phase distortion
        "setCurve", // → −1…1 lobe convexity
        "setFold", // → 0…1 wavefold drive
        "setQuant", // → 0…1 amplitude staircase
        "setChaos", // → 0…1 LCM-locked drift
        "setStageCount", // → 1…16 (resizes stageLevels, filling new cells with 1.0)
        "setStageLevel", // → value = level 0…1 at cell `stageIndex`
        "setStageGlide", // → 0…1 slew between stage cells
        "setEnvEase", // → −1…1, curves every envelope segment at once
        "setWavePreset", // → mode = sine|triangle|square|saw|random; WRITES the macros (not a mode)
        "setDepth", // → 0…1 per-channel master depth
        "setFollowerSource", // → track index, -1 = none
        "setFollowerGain", // → 0…10
        "setFollowerAttack", // → 0…1
        "setFollowerRelease", // → 0…1
        "setTriggerSource", // → envelope gate source track index, -1 = none
        "setEnvelope", // → the whole MSEG (nodes + sustainNodeIndex + bipolar); commit on drag-end
        "arm", // → armModChannel(index); index -1 disarms
      ]),
      index: z.number().int(), // channel 0…3 → M1…M4 (-1 allowed for `arm` = disarm)
      value: z.number().optional(), // scalar ops
      stageIndex: z.number().int().optional(), // setStageLevel only — which stage cell to write
      mode: z.string().optional(), // setWaveform raw name
      // setEnvelope only — the full shape, so a partial edit can never desync the node arrays.
      envelope: z
        .object({
          nodes: z.array(EnvelopeNode),
          sustainNodeIndex: z.number().int(),
          bipolar: z.boolean(),
          tempoSync: z.boolean(),
        })
        .strict()
        .optional(),
    }).strict(),
    result: z.object({}).strict(),
  },
  sceneOverride: {
    params: z.object({
      op: z.enum([
        "pin", // → pinToCurrentScene   ("Make Scene-Specific")
        "unpin", // → unpinFromCurrentScene ("Reset to Global")
        "pushToAll", // → pushKeyToAllScenes  ("Push Value to All Scenes")
      ]),
      key: z.string(),
      deck: z.number().int().optional(),
    }).strict(),
    result: z.object({}).strict(),
  },
  midiLearn: {
    params: z.object({
      op: z.enum([
        "start", // arm learn on this control; the next CC binds to it
        "cancel", // abort the armed learn
        "clear", // remove the mapping this control resolves to
      ]),
      kind: z.enum(["trackParam", "singleton"]).optional(), // omit for "cancel"
      key: z.string().optional(), // trackParam: token ("volume"); singleton: learnId
      trackIndex: z.number().int().optional(), // trackParam only
      deck: z.number().int().optional(),
    }).strict(),
    result: z.object({}).strict(),
  },
  // Transport (panels/toolbar.md §4). Master ops act on activeSequencers;
  // deck ops target one deck (0=A, 1=B, 2=C).
  transportGlobalPlay: { params: z.object({}).strict(), result: z.object({}).strict() },
  transportGlobalStop: { params: z.object({}).strict(), result: z.object({}).strict() },
  transportGlobalRestart: { params: z.object({}).strict(), result: z.object({}).strict() },
  /**
   * MB-4 (v77): the MENU's transport — deck-targeted, NOT global. `play`
   * routes through `HotkeyManager.spaceTransport()` (the single-space rule:
   * compose toggles the ACTIVE deck, DJ mode toggles the global toolbar
   * transport), `stop`/`restart` hit the same active sequencer. The registry's
   * Transport commands use THIS so a menu selection can never target a
   * different deck than the keyboard would — `transportGlobal*` above remain
   * the toolbar's all-decks controls, a different instrument.
   */
  menuTransport: {
    params: z.object({ op: z.enum(["play", "stop", "restart"]) }).strict(),
    result: z.object({}).strict(),
  },
  /**
   * MB-5 slice 1 (v78): the Session menu's lifecycle INTENTS. Orchestration
   * moves to the registry; the DIALOGS stay shell calls inside the Swift
   * handler (NSSavePanel/NSOpenPanel/NSAlert — sandbox bookmarks, exactly the
   * menubar.md §6 ownership line). Bodies are the native menu items' verbatim:
   * `save` = quickSave falling back to Save As; `new` = the save-first alert.
   * Bounce and Recent Sessions stay native for now (stateful label; submenu).
   */
  menuSession: {
    // v79: `bounceToggle` — ONE op, Swift resolves trigger-vs-cancel from the
    // CURRENT `isBouncing` (a stale menu label must never invert the action).
    // v83: `exportZip` — writes the P8-0b zipped session (the ONE FILE the
    // browser companion imports). There is no `importZip`: `load`'s panel and
    // BeatSequencer.loadSession detect a zip file and expand it — one door in.
    params: z.object({ op: z.enum(["new", "save", "saveAs", "load", "bounceToggle", "exportZip"]) }).strict(),
    result: z.object({}).strict(),
  },
  transportDeck: {
    params: z.object({
      deck: z.number().int().min(0).max(2),
      op: z.enum(["play", "stop", "playOnce", "skipStep"]),
    }).strict(),
    result: z.object({}).strict(),
  },
  // DJ/compose view switch (app-level UI state; host wires the binding).
  toggleDjMode: { params: z.object({}).strict(), result: z.object({}).strict() },
  // NK-1: Musical Keyboard Mode — the "piano" (there is no on-screen keyboard
  // anywhere in this app, and never was: the mode REMAPS the computer keyboard
  // into a piano layout, A W S E D F… = C C# D D#…, and plays the selected
  // track at pitch). Native home: BeatSequencer:183 + HotkeyManager:170-235,
  // toggled by ⌘K. `toolbar.md:37` parked these controls as "still unmigrated,
  // and now homeless" when TB-1 deleted the tools row — this re-homes them.
  // Per-SEQUENCER state (each DJ deck has its own mode), so `deck` scopes it;
  // absent = the active sequencer, matching ⌘K.
  musicalKeyboard: {
    params: z.object({
      op: z.enum([
        "toggle", // → seq.musicalKeyboardModeEnabled.toggle()  (⌘K)
        "octaveDown", // → musicalKeyboardOctaveOffset -= 1  (Z)
        "octaveUp", // → musicalKeyboardOctaveOffset += 1  (X)
        "velocityDown", // → musicalKeyboardVelocityIndex -= 1  (C)
        "velocityUp", // → musicalKeyboardVelocityIndex += 1  (V)
      ]),
      deck: z.number().int().min(0).max(2).optional(),
    }).strict(),
    result: z.object({}).strict(),
  },
  // (`toolbarTool` REMOVED in TB-1, with the tools row it served. Every op it
  // carried was already dead or homed elsewhere: `cycleQuantize` went to the DJ
  // master box in P6-07; `zoomIn`/`zoomOut` posted their notification with a nil
  // object, which TrackListView's sequencer-identity filter dropped on the floor
  // — zoom lives on the keyboard (HotkeyManager) and, under the web grid, in the
  // grid's own zoom; `toggleWaveform` drove the SwiftUI cell renderer the web
  // grid replaced; `openSettings` is ⌘, / the app menu.)
  // Per-deck section ops (panels/toolbar.md row 2). Sync/pulse/TR mirror the
  // native controls' mode-aware semantics (TP: sync⊕TR mutually exclusive).
  // select/eject/double/saveAs run through host-wired closures.
  deckSection: {
    params: z.object({
      deck: z.number().int().min(0).max(2),
      op: z.enum([
        "select", "open", "eject", "double", "quickSave",
        "toggleSync", "pulsePrev", "pulseNext",
        "toggleTranspose", "trDown", "trUp",
        "toggleBeatRepeat", "brFiner", "brCoarser", "brShiftLeft", "brShiftRight",
      ]),
    }).strict(),
    result: z.object({}).strict(),
  },
  // DJ enum settings (P6-02). Everything continuous or boolean rides the
  // ParamWrite lane; this carries the CHOICES, whose values are raw strings
  // from the Swift enums (DJTempoMode / LaunchQuantize / XfaderSide / the
  // deck-C projection slot). Domain Ownership holds: DJModeManager stays the
  // owner — the web sends intents, exactly like scenes.
  djSetting: {
    params: z.object({
      op: z.enum([
        "tempoMode", // value: timePitch | timeStretch | tempoOnly
        "launchQuantize", // value: off|1|2|4|8|16|cycle (LaunchQuantize raw)
        // NOTE: the deck-scoped xfader-side op USED to live here. Phase XN retired it — a
        // crossfader side is not a deck property, it belongs to any signal the X-MIX carve
        // can eat, so it moved to the node-scoped `setXmixSide` below. Deliberately NOT kept
        // alongside: two commands writing one control is how a second home creeps back in.
        // (xmixNodes.test.ts greps this file to keep the retired op from reappearing.)
        "modifiersInRows", // value: on | off — show mod-depth slots in the deck rows
        // Deck-C projection (value: a | b | none — ABSOLUTE, not a toggle: the C
        // flip button lives in the transport strip while the deck windows live in
        // the djmode page, and two webviews toggling one bit is a double-flip
        // race). Owner: DJModeManager.deckCProjectedSlot (revised 2026-07-14 —
        // was view-local in DjPanel until the flip button moved webviews).
        "deckCProjection",
        // Per-DECK "hide the DJ grid" (value: on = hidden | off; `deck` names the
        // deck). Web-only UI state, but read by the djmode page and written from
        // the transport strip → Swift-owned like the projection.
        "gridHidden",
        // Per-DECK perform mode (value: on | off; `deck` names the deck, so the
        // mode follows C through a projection). When on, pointer input on that
        // deck's grid sets the per-track locator repeat window instead of
        // composing. Written from the transport strip, read by the djmode page
        // → Swift-owned like gridHidden. Session-lifetime, not persisted.
        "performMode",
      ]),
      deck: z.number().int().min(0).max(2).optional(),
      value: z.string(),
    }).strict(),
    result: z.object({}).strict(),
  },
  // setXmixSide RETIRED (mixer overhaul, 2026-07-14): the per-channel X picker cost more
  // mixer space than it earned, so sides are FIXED POLICY in DJModeManager.init — deck A → a,
  // deck B → b, everything else (deck C, FX returns, input) own — until the planned X-MIX
  // matrix gives node assignment a real surface. DJModeManager.setXmixSide (Swift) survives
  // for that matrix; the WIRE op is gone so a second home cannot creep back meanwhile.
  // (xmixNodes.test.ts greps this file to keep the retired op from reappearing.)

  // DJ session browser (P6-04). `load` is an INTENT: Swift runs the SAME
  // loadSession path the native browser does (deck-playing guard, security-
  // scoped access, BPM adoption, LCM playhead sync, sync-mode recalc), so
  // there is exactly one load implementation. `notice` carries back what the
  // native browser would have shown as a toast (e.g. "Stop Deck A before
  // loading a new session.").
  djBrowser: {
    params: z.object({
      op: z.enum(["chooseFolder", "refresh", "load"]),
      path: z.string().optional(), // load: the session to load
      deck: z.number().int().min(0).max(2).optional(), // load: destination deck
    }).strict(),
    result: z.object({ notice: z.string().nullable() }).strict(),
  },
  // Compose sample browser (BR-2). Mirrors djBrowser's shape so the two
  // browsers stay symmetrical — and, like it, `load` is an INTENT: Swift keeps
  // ONE loader (addTrack / loadAudioFile), so the ⌥-stretch config, the
  // security-scoped bookmark minting, pushState(critical:) and the undo entry
  // never fork into a second implementation.
  //
  // Directory listing stays Swift by Domain Ownership (browser.md §2): a
  // WKWebView cannot read arbitrary disk paths, and the browser target swaps
  // this for OPFS — so the listing is a pushed topic from day one, never a
  // web-side `fs` call.
  fileBrowser: {
    params: z.object({
      op: z.enum([
        "chooseFolder", // native NSOpenPanel → new root + security-scoped bookmark
        "refresh", // re-scan cwd
        "navigate", // path: a directory at or below root → becomes cwd
        "up", // one level toward root
        "select", // path: a FILE → selection + (if autoPlay) audition
        "togglePreview", // play/stop the audition player
        "setSort", // value: name | date
        "setAutoPlay", // value: on | off
        "setFolded", // value: on | off — SwiftUI sizes the host frame from this
        "load", // path: a FILE → into trackIndex, or a NEW track if omitted
      ]),
      path: z.string().optional(),
      value: z.string().optional(),
      // load: the destination row. OMITTED = create a new track — which is
      // what the native browser's double-click and `load` button both do.
      // Present only when a browser row is DROPPED onto an existing track row.
      trackIndex: z.number().int().min(0).optional(),
      // load: the ⌥ modifier (⇒ configureTrackAsStretch). The web owns the
      // event now, so it is an explicit field rather than an NSEvent read.
      asStretch: z.boolean().optional(),
    }).strict(),
    result: z.object({ notice: z.string().nullable() }).strict(),
  },
  // Peak envelope for a file that is NOT loaded into a track — the preview
  // waveform in the browser footer. `getSamplePeaks` cannot serve this: it is
  // keyed by trackIndex, and the whole point is to see the sample BEFORE you
  // spend a track on it. Same WaveformCache pipeline; one decode per
  // SELECTION, not per keystroke.
  getFilePeaks: {
    params: z.object({
      path: z.string(),
      points: z.number().int().min(16).max(1024),
    }).strict(),
    result: z.object({
      minMax: z.array(z.number()), // interleaved [min0,max0,min1,max1,…]
      rms: z.array(z.number()),
      durationMs: z.number(),
      error: z.string().nullable(),
    }).strict(),
  },
  // FX return slot setup ops (Variant A popover, SURFACE-MAP decision
  // 2026-07-11). v72: `openReturnPanel` RETIRED (AR-10) — it opened the native
  // SwiftUI FX Return overlay, which is archived; `listPlugins`/`selectPlugin`
  // below are the only plugin-change surface.
  fxSlot: {
    params: z.object({
      returnIndex: z.number().int().min(1).max(4),
      // setHostOutput (mixer overhaul) = toggleHostOutput with ABSOLUTE Select
      // semantics: `value` true → dedicated hardware out, false → MAIN. The
      // strip's HOST-mode output picker is a Select, and a Select must be
      // idempotent — a toggle behind it would double-flip on re-render.
      op: z.enum(["toggleMode", "toggleEditor", "toggleHostOutput", "setHostOutput", "togglePostFader"]),
      value: z.boolean().optional(), // setHostOutput only
    }).strict(),
    result: z.object({}).strict(),
  },
  // Real plugin picker for FX return slots (repair of the openReturnPanel
  // stopgap, which targeted the wrong sequencer's overlay).
  listPlugins: {
    params: z.object({}).strict(),
    result: z.object({
      plugins: z.array(z.object({
        identifier: z.string(),
        name: z.string(),
        manufacturer: z.string(),
        format: z.string(),
      }).strict()),
      scanning: z.boolean(),
    }).strict(),
  },
  rescanPlugins: { params: z.object({}).strict(), result: z.object({}).strict() },
  // The INSTRUMENT half of the scanned plugin list (listPlugins returns the FX half). Feeds the
  // track row's instrument picker — same scan, opposite filter.
  listInstruments: {
    params: z.object({}).strict(),
    result: z.object({
      plugins: z.array(z.object({
        identifier: z.string(),
        name: z.string(),
        manufacturer: z.string(),
        format: z.string(),
      }).strict()),
      scanning: z.boolean(),
    }).strict(),
  },
  // Host resizes the embedding view (popovers can't escape the WKWebView).
  setPanelHeight: {
    params: z.object({ heightPx: z.number() }).strict(),
    result: z.object({}).strict(),
  },
  selectFxPlugin: {
    params: z.object({
      returnIndex: z.number().int().min(1).max(4),
      identifier: z.string().nullable(), // null = unload
    }).strict(),
    result: z.object({}).strict(),
  },
  // Grid (P5-01): waveform peak envelopes served from the native
  // WaveformCache. minMax is interleaved [min0,max0,min1,max1,…].
  getSamplePeaks: {
    params: z.object({
      trackIndex: z.number().int().min(0),
      deck: z.number().int().min(0).max(2).optional(), // DECK SCOPE (P6-03), as gridEdit.deck
      points: z.number().int().min(16).max(1024),
      // Ask for the spectral-brightness envelope too (GR-WAVE spectrum colour).
      // OPT-IN: it costs one FFT per column on the Swift side, so a style that
      // doesn't paint with it never pays. Empty array when not requested.
      spectrum: z.boolean().optional(),
    }).strict(),
    result: z.object({
      sampleKey: z.string().nullable(), // sampleId uuid, null = no sample
      minMax: z.array(z.number()),
      rms: z.array(z.number()),
      /** Normalized spectral centroid per column, 0=dark…1=bright. [] unless `spectrum`. */
      brightness: z.array(z.number()).default([]),
      durationMs: z.number(),
    }).strict(),
  },
  // ── P5-06 step A — THE WORLD WIRE (a pipe, NOT an ownership change) ─────────
  // THE FLIP inverts who owns pattern data. Step A builds only the pipe and proves
  // it end-to-end: Swift can hand TS the canonical PatternFile, and TS can hand a
  // full PatternFile back and have it reach the engine. Ownership does NOT move here
  // — Swift still owns the document, still saves it, still owns undo.
  //
  // Both directions deliberately speak the CANONICAL PatternFile form
  // (PersistenceService.canonicalPatternEncoder: prettyPrinted + sortedKeys), because
  // that is the exact byte form `web/src/persist/` is pinned against. Reusing it means
  // the wire inherits the P5-06b/c byte-identity proof instead of inventing a new
  // contract that nothing verifies.
  getPattern: {
    params: z.object({
      deck: z.number().int().min(0).max(2).optional(), // DECK SCOPE, as gridEdit.deck
    }).strict(),
    result: z.object({ json: z.string() }).strict(),
  },
  /**
   * P5-06 step D — THE FLIP's write path. TS owns the pattern; this is how it reaches the engine.
   *
   * One TRACK's pattern half, published by TS after it applied a reducer. Swift decodes it into
   * `BeatSequencer.tracks[i]` — which becomes a MIRROR of TS's document rather than the source of
   * it — and its existing `didSet → pushState` chain carries it to the engine unchanged. That
   * chain was the thing the ledger feared most (225 call sites); it turns out to be harmless once
   * Swift is no longer an independent WRITER, because it is then delivering TS's state, not
   * fighting it with its own.
   *
   * ⚠️ It publishes ONLY the fields TS actually owns — the ones its reducers model. Everything
   * else on the track (mod routings, the plugin binding, the colour, rhythmic offsets) has no web
   * editor, so TS never changes it and Swift keeps it. Publishing a field nobody edits would be a
   * chance to corrupt it for nothing.
   *
   * Refused while `web.owner.patterns` is off, exactly like worldPublish.
   */
  /**
   * P5-06 UNDO — TS owns the pattern domain's history, so it must tell Swift how deep it is.
   *
   * The Edit menu's Undo/Redo items are `.disabled(!canUndoEdit)`, and Swift cannot see TS's
   * stack. Without this the menu would either grey out while TS HAS history (⌘Z dead) or stay
   * enabled while it has none (⌘Z does nothing) — and "enabled but does nothing" is precisely
   * the bug we are fixing. The label rides along so the menu can say what it will undo.
   */
  reportUndoState: {
    params: z.object({
      undo: z.number().int().min(0),
      redo: z.number().int().min(0),
      label: z.string().nullable(),
    }).strict(),
    result: z.object({}).strict(),
  },
  /**
   * TS's stack is empty — fall through to SWIFT's undo.
   *
   * Swift keeps the domains TS does not own: topology (add/delete/duplicate/move track) and
   * global (bpm, settings scenes). Draining TS's pattern history first and then Swift's keeps
   * the combined history in ORDER, which is the one thing Swift's single ordered stack got right.
   */
  swiftUndo: {
    params: z.object({ redo: z.boolean() }).strict(),
    result: z.object({ applied: z.boolean() }).strict(),
  },
  publishTrackPattern: {
    params: z.object({
      trackIndex: z.number().int().min(0),
      deck: z.number().int().min(0).max(2).optional(),
      json: z.string(), // one GridPatternState
    }).strict(),
    result: z.object({ applied: z.boolean(), error: z.string().nullable() }).strict(),
  },
  worldPublish: {
    params: z.object({
      deck: z.number().int().min(0).max(2).optional(),
      json: z.string(), // a full PatternFile in canonical form
    }).strict(),
    // ⚠️ GATED on `web.owner.patterns` (default OFF) and REFUSED when it is off.
    // This command replaces the entire document, so a stray send must be inert rather
    // than destructive. `applied:false` + a reason is the honest answer, not a silent no-op.
    result: z.object({ applied: z.boolean(), error: z.string().nullable() }).strict(),
  },
  /**
   * B1-A — the PERSISTENCE SHADOW GATE (v73). The step-A round-trip prover
   * (`verifyWorldRoundTrip`) existed only as a manual context-menu action;
   * this makes it run automatically on every desktop save and report back.
   *
   * Trigger: Swift pushes the ad-hoc `persistShadow` topic `{seq, kind}` after
   * each successful save (no pattern bytes ride the push — TS re-fetches via
   * `getPattern`, which re-runs the same `makePatternFile()` the save used, so
   * the comparison covers the exact state that was just written). TS runs the
   * decode→re-encode byte compare and answers with this command; Swift keeps
   * pass/fail counters (`persist.shadow.pass|fail`) — the evidence the B1
   * writer-flip gate reads. Report-only: no save ever blocks on it.
   */
  persistShadowReport: {
    params: z.object({
      seq: z.number().int().min(0),   // echo of the triggering push
      ok: z.boolean(),
      bytes: z.number().int().min(0), // size of Swift's canonical pattern
      firstDiff: z.number().int(),    // char offset of first divergence, -1 when clean
      detail: z.string(),             // readable window around the divergence, "" when clean
    }).strict(),
    result: z.object({}).strict(),
  },
  /**
   * MB-3 — the registry's PUBLISH leg (see web/src/commands/registry.ts).
   *
   * The page evaluates `menuTree(state)` and hands Swift the RENDERABLE tree:
   * labels already resolved (Play/Pause flipped), enablement already decided.
   * Swift caches it (`WebMenuRegistry`) and — MB-4 — builds the NSMenu from it,
   * registering key equivalents from `shortcut`. Published on structural or
   * label-relevant change only (undo depth, isPlaying), never per frame.
   *
   * A HOST publishes only the sections it can honestly evaluate (the compose
   * grid: Edit/Transport/Track/Pattern — it does not know `djMode`). Sections
   * merge by name in the Swift cache, so a second host can adopt DJ later
   * without either publish clobbering the other.
   */
  publishMenuTree: {
    params: z.object({
      sections: z.array(
        z.object({
          section: z.string(),
          items: z.array(
            z.object({
              id: z.string(),
              label: z.string(),
              shortcut: z
                .object({
                  code: z.string(), // physical key (KeyboardEvent.code), same as forwardKey
                  cmd: z.boolean().optional(),
                  shift: z.boolean().optional(),
                  alt: z.boolean().optional(),
                  ctrl: z.boolean().optional(),
                })
                .strict()
                .optional(),
              enabled: z.boolean(),
              checked: z.boolean(),
            }).strict(),
          ),
        }).strict(),
      ),
    }).strict(),
    result: z.object({}).strict(),
  },

  // Grid editing (P5-02, view+command — NOT ownership): each op mirrors one
  // BeatSequencer mutator 1:1; Swift stays document owner, undo stays
  // pushState. The edited state echoes back via the grid/<i> UiState push.
  gridEdit: {
    params: z.object({
      op: z.enum([
        "toggleStep", // → toggleStep(trackId:index:)
        "setCellLength", // → updateCellLength(trackId:ownerStepIndex:newLength:wrapLength:)
        "cycleAccent", // → cycleAccentLevel(trackId:index:) off→soft→hard→off
        "cycleFlam", // → cycleStepFlam(trackId:stepIndex:) 1→…→kMaxFlam(16)→1
        "adjustParameter", // → adjustStepParameter(trackId:stepIndex:delta:isOption:) on the track's activeCellParameter
        "beginUndo", // → beginUndoActivity() — one undo step per drag gesture
        "endUndo", // → endUndoActivity()
        "paintCell", // ⌘-drag ramp: Swift computes the value via PaintModeSettings → setPaintedCellValue
        "copyCells", // → BeatSequencer.cellCopyBuffer = CellSelectionData(track, steps) — selection stays web-side
        "pasteCells", // → pasteSelectedCells(at: step) on the target track
        // P5-PCE in-cell affordance marks (direct gestures, no param-mode).
        // All write the resolved OWNER index; the web resolves before sending.
        "setAccent", // → setAccentLevel(trackId:stepIndex:level:) 0/1/2, activates the step
        "setFlam", // → setStepFlam(trackId:stepIndex:count:) clamp 1…kMaxFlam(16)
        "setGlide", // → setStepGlide(trackId:stepIndex:on:) with legacy all-true materialization
        "setReverse", // → setStepReverse(trackId:stepIndex:on:) XOR chain in engine
        "setPreSilenceCell", // → setPreSilencePerCell(trackId:stepIndex:absoluteValueMs:)
        // MB-1b — the Pattern menu's WHOLE-PATTERN ops. Both-mode by design: pre-flip they route to
        // the Swift mutator below; post-flip GridPanel applies the TS reducer (patternOps.ts) and
        // publishes the result, so the document keeps ONE writer. Golden-pinned in grid-ops.json.
        // NOTE: "Clear Grid + SETTINGS" is deliberately NOT here — it zeroes LFO depths, which are
        // not in GRID_PATTERN_SHAPE, i.e. TS does not own them. It stays a Swift-only menu op.
        "clearGrid",         // → clearPattern(clearSettings: false, trackIndex:)
        "generateInterval",  // → generateIntervalPattern(interval:trackIndex:startStep:)
        // MB-1f — DESIGNED, not ported. Subsumes all seven "Every Nth" items (pulses = stepCount/N)
        // and both off-beat ones (rotation). The MELODY generators are CUT, not migrated: all four
        // stepped pitch by one semitone, so they were chromatic ramps — and one was a flat line.
        "generateEuclidean", // → generateEuclideanPattern(pulses:rotation:trackIndex:)
        // NK-1: publish the web cursor's track as the NATIVE selected track.
        // Everything native plays "on the selected track" — the ⌥ chop preview,
        // batch fan-outs, activeSequencer — reads `keyboardSelectedTrackIndex`,
        // which the web never set, so it silently fired at a STALE index under
        // every web panel. (Note-in is NOT in that list any more: routing is
        // pin-only since 2026-07-15 — the selection never hears notes.) Routed
        // Swift-side through HotkeyManager.setSelectedTrack, never a raw write:
        // musical key-DOWN reads seq.keyboardSelectedTrackIndex but key-UP
        // reads HotkeyManager's own selectedTrackIndex, so writing one and not
        // the other releases the note on the wrong track and HANGS the voice.
        // Plain selection (cell click, Tab, arrows). FINDER SEMANTICS (user, 2026-07-15): a plain
        // select ALWAYS collapses the multi-selection to this one track — inside or outside the
        // old set. (The old keep-inside rule made a selection sticky: navigating within it never
        // cleared it, and users read that as "cannot deselect".) The keep-inside rule survives
        // ONLY for band-control clicks via `keepWithinSelection` (Finder's drag-within-selection:
        // touching a control on a selected track must not break the set a STEP change fans across).
        "selectTrack",
        // ⌘-click. Native reserves ⇧ for CELL selection, so the track multi-select toggle is ⌘
        // and only ⌘ (ContentView:1276).
        "toggleTrackSelection",
        // ⇧↑/⇧↓ track-wise selection EXTEND → HotkeyManager.addTrackToSelection.
        // Add-only (never toggles: walking back must not deselect); the anchor is
        // auto-seeded from the keyboard track when the set is empty
        // (BeatSequencer.addTrackToSelection), which also moves the keyboard
        // index to the landed track — so the web does NOT send selectTrack too.
        "addTrackToSelection",
        // Escape: drop the whole multi-selection at once. ⌘-click only toggles
        // one track per click, and with EVERY track selected there is no
        // outside track to selectTrack-replace with — a full selection was
        // literally unclearable from the web. Native SwiftUI cleared it on
        // background clicks (ContentView:424), a surface the grid never ported.
        "clearTrackSelection",
      ]),
      trackIndex: z.number().int().min(0),
      // DECK SCOPE (P6-03): absent = the compose grid resolver's sequencer
      // (unchanged). Present = that DJ deck — the DJ view edits two decks at
      // once, so its rows must name their target instead of relying on which
      // deck the resolver happens to point at.
      deck: z.number().int().min(0).max(2).optional(),
      step: z.number().int().min(0).optional(), // owner step for setCellLength/cycleFlam; played step otherwise; absent for begin/endUndo
      length: z.number().int().min(1).optional(), // setCellLength
      wrapLength: z.number().int().min(0).optional(), // setCellLength continuation past pattern end
      delta: z.number().int().optional(), // adjustParameter (±n)
      fine: z.boolean().optional(), // adjustParameter ⌥=fine → Swift isOption (native fine; the old `coarse` name was mis-mapped — UX-RESEARCH F5)
      steps: z.array(z.number().int().min(0)).optional(), // copyCells: web-side selection
      anchorStep: z.number().int().min(0).optional(), // paintCell: ramp anchor (keeps its value)
      cellIndex: z.number().int().min(1).optional(), // paintCell: position in the paint sequence
      ascending: z.boolean().optional(), // paintCell: ramp direction (⌘⌥ = ascending)
      level: z.number().int().min(0).max(2).optional(), // setAccent: off/soft/hard
      count: z.number().int().min(1).max(16).optional(), // setFlam: ratchet count
      on: z.boolean().optional(), // setGlide/setReverse: flag state
      // selectTrack only: true = a band-CONTROL click. Inside a >1 selection it keeps the set
      // and just moves the keyboard focus (batch fan-outs need the set intact under the pointer);
      // absent/false = plain navigation, which always collapses to this track (Finder semantics).
      keepWithinSelection: z.boolean().optional(),
      ms: z.number().min(0).max(1000).optional(), // setPreSilenceCell: absolute lead-in
      // MB-1b payloads
      interval: z.number().int().min(1).optional(), // generateInterval: light every Nth step
      startStep: z.number().int().min(0).optional(), // generateInterval: off-beat variants pass 1
      pulses: z.number().int().min(0).optional(), // generateEuclidean: onsets spread across stepCount
      rotation: z.number().int().optional(), // generateEuclidean: shift the pattern LATER by N steps
    }).strict(),
    result: z.object({}).strict(),
  },
  // Track-row editing (TR-2/3, view+command like gridEdit — NOT ownership):
  // each op mirrors one BeatSequencer mutator 1:1 (trackrow.md §8.2). Swift
  // stays document owner, undo stays pushState. Edited state echoes via the
  // grid/<i> UiState push; the web applies an optimistic local echo first.
  trackEdit: {
    params: z.object({
      op: z.enum([
        "setGain", // → updateTrackGain(trackId:gain:)  value 0…2
        "setVolume", // → updateTrackVolume(trackId:volume:)  value 0…2 internal
        "setPan", // → updateTrackPan(trackId:pan:)  value −1…1
        "setTone", // → updateTrackTone(trackId:value:)  −100…100
        "setToneFilterMode", // → updateTrackToneFilterMode(trackId:mode:)  mode raw
        "setToneQ", // → updateTrackToneQ(trackId:value:)
        "setFilterDrive", // → updateTrackFilterDrive(trackId:value:) — resonance drive 0…100
        "setPitch", // → updateTrackGlobalPitch(trackId:offset:)  value = quarter-tones int
        "setFineTune", // → updateTrackGlobalFineTuneCents(trackId:cents:)  value = cents int
        "setChokeGroup", // → setChokeGroup(trackId:group:)  value 0…8
        "setVoiceMode", // → setVoiceMode(trackId:mode:)  mode "mono"|"poly"
        "setStereoMode", // → updateTrackStereoMode(trackId:mode:)  value 0…3
        "setSend", // → updateTrackSend{index}Level(trackId:level:)  index 1…4, value 0…1
        "setGlidePercent", // → updateTrackGlidePercent(trackId:percent:)  0…100
        "setSwing", // → updateSwing(trackId:amount:)  amount 0…1 (value = percent)
        "setStepCount", // → updateStepCountsForSelection(...)  value = new count 1…64
        "toggleMute", // → toggleMute / toggleMultipleTracksMute
        "toggleSolo", // → toggleSolo / toggleMultipleTracksSolo
        "toggleLaunch", // → toggleTrackLaunch
        "toggleDirection", // → togglePlaybackDirectionForSelection
        "cyclePlaybackMode", // → tapPlaybackMode (REG↔OWN)
        // --- R1 cell-tools + pattern (v10) ---
        "setActiveCellParameter", // → setActiveCellParameter(mode = CellParameter case name)
        "clearCellParameter", // → clearPerCellParameter(mode = param) — right-click "Clear all"
        "setPreSilence", // → updatePreSilence(preSilenceMs: value)
        "setPatternStart", // → setPatternStartStep(startStep: value)
        "setFreeRate", // → updateFreeRate(rate: value)
        "adjustLocatorStart", // → adjustLocatorStartKeepingLength(delta: value)
        "adjustLocatorLength", // → adjustLocatorLength(delta: value)
        "toggleLocatorRepeat", // → toggleLocatorRepeatForSelection
        // DJ perform-mode gestures (v68). Absolute one-shots, per-track — unlike the
        // delta steppers / selection-scoped toggle above. setLocatorRange takes
        // startStep + value = lengthSteps (inclusive, ≥1) + engage; the Swift mutator
        // clamps end ≤ stepCount−1, so drags never write a wrapping window. NOT in
        // VERIFIABLE_TRACK_OPS — Swift owns the engine's engagement latch, the web
        // adopts the echo. Registers no undo: locator mutators are undo-free live-perf
        // ops throughout (matches the existing steppers).
        "setLocatorRange", // → setLocatorRange(startStep:endStep:) [+ setLocatorRepeatActive(true) when engage]
        "setLocatorRepeat", // → setLocatorRepeatActive(active: value != 0) — per-track ABSOLUTE
        "stepSpeed", // → stepSpeedMultiplier(direction: value>0 faster/<0 slower)
        "resetSpeed", // → resetSpeedMultiplier
        "setSpeedMultiplier", // → setSpeedMultiplierToAllowedRatio(multiplier: value) — unified rate slider detents (rejects non-ratio values)
        "setRateLockRatio", // → setRateLockRatio(ratio: value) — per-track designated ⟳ reset ratio (rate control right-click menu); store-only, does NOT change live speed; rejects non-ratio values

        "setPlaybackDirection", // → setPlaybackDirection(backward: value != 0) — rate slider's reversed (left-side) detents; absolute, unlike toggleDirection
        "setSpeedMode", // → setSpeedMode(mode: value 0=timeOnly 1=timeAndPitch) — rate control Pitch Tracking menu (TS not user-selectable)
        "cycleSubMode", // → OWN —/CHOP/LOOP · REG —/STR/LOOP (loop/stretch/chop mutators)
        "setStretchTimeOnly", // → setStretchTimeOnly(timeOnly: value != 0)
        "browseSample", // → browsePreviousSample (value<0) / browseNextSample (value>0)
        "setSampleStart", // → updateSampleStart(startMs: value) — trim bar S handle/box
        "setSampleEnd", // → updateSampleEnd(endMs: value) — trim bar E handle/box
        // Trim-bar right-click "Crop to trim". Bakes the current [sampleStartMs,
        // sampleEndMs] window into a NEW file, loads it, resets trim/loop/chop.
        // Swift-owned file write (like loadSample) — no value; NOT in
        // VERIFIABLE_TRACK_OPS, so TS adopts Swift's echo.
        "cropSample", // → BeatSequencer.cropSampleToTrim(trackId:)
        "setLoopStart", // → updateTrackLoopStart(startMs: value)
        "setLoopEnd", // → updateTrackLoopEnd(endMs: value)
        "setLoopCrossfade", // → updateTrackLoopCrossfade(crossfadeMs: value)
        "setDefaultChop", // → setDefaultChopIndex(chopIndex: value)
        "setChopPoint", // → updateChopPoint(chopIndex: index, startMs: value) — drag a chop boundary
        "resetChopPoint", // → resetChopPoint(chopIndex: index) — back to auto-distribute (−1 sentinel)
        "setChopCount", // → setChopCount(trackId:count:) — slice count 1…8; native resets all points to auto-distribute
        "setOwnerAttack", // → updateOwnerModeAttack(attack: value)
        "setOwnerGate", // → updateOwnerModeGate(gate: value)
        "setModDepth", // → mod slot depth (index = channelIndex, mode = target, value −1…1)
        "unmapMod", // → unmapModifier(channel: index, target: mode)
        // MOD-3 (also closes CM-4 "Map-to-Modifier"): the WRITE side of arm-to-map. Native beeps
        // and REFUSES sampleStart/sampleEnd on M3/M4 (no flat depth field exists there) — the web
        // must refuse too, not silently no-op. Cap is Track.kMaxModRoutingsPerTrack = 6.
        "mapMod", // → mapModifier(channel: index, target: mode)
        "setOutputAssign", // → updateTrackOutputAssign(assign: value) — pan box menu
        "setTuning", // → updateTrackTuning(tuning: value) — pitch box menu
        "setMelodicPitchMode", // → setTrackMelodicPitchMode(enabled: value != 0)
        "loadSample", // → loadAudioFileFromPanel (native NSOpenPanel; idx 48)
        // CM-5: the track M button's right-click menu (native ContentView:3761/:4038).
        "toggleMuteGroup", // → toggleMuteGroupMembership(trackId)
        "renameTrack", // → updateTrackCustomName(customName: mode; empty string resets to derived)
        "setColor", // → updateTrackColor(color: mode as #RRGGBB) — compose identity-row swatch
        // --- Topology (v80, MB-5 relocations → the track's right-click). INTENTS:
        // topology stays Swift's (MB-1c — undoStore's markers record positions,
        // never topology payloads), so these are NOT in VERIFIABLE_TRACK_OPS and
        // never will be. Targets the CLICKED row, which is what made the menu
        // items say "Selected" — worded around being in the wrong place.
        "duplicateTrack", // → duplicateTrack(at:) — refused at the 16-per-type cap
        "deleteTrack", // → deleteTrack(at:) — refused when it is the last track
        "moveTrackUp", // → moveTrackUp(index:)
        "moveTrackDown", // → moveTrackDown(index:)
        // --- Unified MIDI/instrument track (v40) ---
        // SMP|INST is a HARD-EXCLUSIVE source switch since v81 (user decision 2026-07-18,
        // superseding the v45 "never exclusive" pair): enabling one disables the other, enforced
        // Swift-side. The no-erase law survives the change — a flip only silences a source, the
        // sample stays loaded and the plugin stays bound with its captured state. MIDI remains an
        // independent third output.
        "setSampleOut", // → setTrackSampleOut(enabled: value != 0) — the sample voice (on flips INST off; off keeps the sample loaded)
        "setInstrumentOut", // → setTrackInstrumentOut(enabled: value != 0) — the bound plugin (on flips SMP off; off keeps the binding AND its state)
        "setMidiOutEnabled", // → setTrackMidiOutEnabled(enabled: value != 0) — the external port, on top of whatever else sounds
        "setMidiChannel", // → updateTrackMidiChannel(channel: value 0…15)
        "setMidiRootNote", // → updateTrackMidiRootNote(rootNote: value 0…127) — the pitch dial's origin
        "setMidiGate", // → setTrackMidiGatePercent(percent: value 1…100)
        "setMidiVelocity", // → updateTrackMidiVelocity(velocity: value 0…127) — the track's default velocity
        "loadInstrument", // → selectTrackInstrument(identifier: mode) — binding an instrument IS the source flip
        "openInstrumentEditor", // → show the bound plugin's editor window
        "clearInstrument", // → applyTrackInstrument(identifier: nil) — unbind
        // Preset stepping (v81): walk the bound plugin's JUCE program list. The row's ‹›
        // stepper in INST mode sends ±1; Swift marshals setCurrentProgram to the message
        // thread and republishes the grid topic (preset name/index/count ride
        // GridTrackState). A plugin whose preset browser bypasses the JUCE program list
        // reports ≤ 1 programs — the stepper renders disabled, never a wrong preset.
        "instrumentPresetStep", // → stepInstrumentPreset(delta: value ±1)
        // NK-1: PIN this track to the note keyboard (value != 0 = pinned).
        // Not new engine state — it writes the EXISTING `Track.midiInputChannel`
        // (Track.swift:399): Omni (17) on the pinned track, Off (0) on every
        // other track in every deck, so exactly one track hears the keyboard.
        // The engine's multitimbral router already honours it — the moment ANY
        // track is non-Off, note-in stops following the selection
        // (BeatSequencer.midiInputTargetTrackIndices:5692). The pin therefore
        // SURVIVES both a selection change and a deck switch, which is the
        // whole point: play deck A's track while your hands are on deck B.
        "setMidiInputPin", // → BeatSequencer.setMidiInputPin(trackId:pinned:) (clears all other decks)
        "beginUndo", // → beginUndoActivity() — one undo per drag gesture
        "endUndo", // → endUndoActivity()
      ]),
      trackIndex: z.number().int().min(0),
      // DECK SCOPE (P6-03) — same contract as gridEdit.deck.
      deck: z.number().int().min(0).max(2).optional(),
      value: z.number().optional(), // absolute set (or delta for step/level nudges)
      index: z.number().int().optional(), // send index 1…4
      mode: z.string().optional(), // filter/voice/stereo/cell-param raw string
      startStep: z.number().int().min(0).optional(), // setLocatorRange window start
      engage: z.boolean().optional(), // setLocatorRange: also engage locator repeat
    }).strict(),
    result: z.object({}).strict(),
  },
  // Track TOPOLOGY — creating a track (the master row's `+`). Every other web
  // op addresses a track that already exists (`gridEdit`/`trackEdit` both
  // *require* `trackIndex` and Swift guards `tracks.indices.contains`), so
  // "create" could not be expressed at all: with the web grid on, the app had
  // no reachable add-track control. The native Track menu (⌘T) is the other
  // home and stays — it is app chrome, not a panel control.
  //
  // One track kind, deliberately: post-UT (v40) MIDI is a DESTINATION, not a
  // track type, so `addTrack` mirrors `BeatSequencer.addTrack()` 1:1 and the
  // row itself flips SMP⇄INST / MIDI-out. Deck scope is the gridEdit contract.
  // Swift stays document owner — undo + pushState live inside addTrack, and
  // the new row echoes back on `gridMeta` + `grid/<i>` via the $tracks push.
  addTrack: {
    params: z.object({
      deck: z.number().int().min(0).max(2).optional(),
    }).strict(),
    // The appended index, so the caller can focus the row it just made.
    // Refused (16-track cap) comes back as an error, not a silent no-op —
    // native's `addTrackInternal` only prints, which is how you get a button
    // that does nothing.
    result: z.object({ trackIndex: z.number().int().min(0) }).strict(),
  },
  // Pattern-scene intents (P5-05 wire; P4-05e pads). Scenes stay Swift-owned
  // (Domain Ownership row 7) — each op mirrors the native scene-cell gesture
  // 1:1 (PdSceneCell.handleClick + the SCN/MUTE hotkeys 9/0).
  patternScene: {
    params: z.object({
      op: z.enum([
        "activate", // → activatePatternSceneViaSwitchMode(scene, addToQueue:) — plain click (⇧=queue)
        "runImmediate", // → switchToPatternSceneImmediate — ⌘-click (seamless, running position)
        "startImmediate", // → switchToPatternSceneImmediateFromStart — ⌥⇧-click (from step 0)
        "move", // → movePatternScene(scene, by: value ±1) — right-click reorder
        "add", // → addPatternScene() (legacy add-slot)
        "remove", // → removePatternScene(scene)
        "setSwitchMode", // → patternSceneMouseSwitchMode = mode (Sched/Run/Start picker)
        "setCleanCut", // → patternSceneCleanCut = on (omitted on = toggle) — boundary voice cut

        "toggleLatch", // → sceneEditLatched.toggle() (SCN, hotkey 9)
        "toggleMute", // → toggleMuteGroupActive() (MUTE, hotkey 0)
        // CM-5, from the MUTE / scene-pad right-click menus (native
        // MasterTrackRowView:1628 "Clear Group" and :1717 "Clear Scene Overrides").
        "clearMuteGroup", // → clearMuteGroup() — empty the membership set
        "clearOverrides", // → clearSceneOverrides(scene) — drop this scene's pinned values
      ]),
      // Scenes are PER-SEQUENCER (each deck owns its own scene set), so every
      // op names the deck it acts on. Omitted = the edited deck (grid panel).
      deck: z.number().int().optional(), // 0=A, 1=B, 2=C
      scene: z.string().optional(), // "A"…"H"
      queue: z.boolean().optional(), // activate: ⇧ add-to-loop-queue
      value: z.number().int().optional(), // move: ±1
      mode: z.string().optional(), // setSwitchMode raw value
      on: z.boolean().optional(), // setCleanCut explicit state (omitted = toggle)
    }).strict(),
    result: z.object({}).strict(),
  },
  // Forward a keyboard shortcut the web grid did NOT handle to the native
  // HotkeyManager (TR-FT-5). While a migration WKWebView owns first-responder
  // the single-owner rule yields ALL keys to the web; the web handles its
  // grid-lane keys and forwards the rest here, so the full shortcut library
  // (transport, record, undo, mute-all, zoom…) stays live. Native rebuilds a
  // synthetic NSEvent and runs dispatchGridShortcut. `handled` echoes whether
  // native consumed it (the web already preventDefaulted).
  forwardKey: {
    params: z.object({
      keyCode: z.number().int(), // physical macOS keyCode (layout-independent shortcuts)
      chars: z.string(), // charactersIgnoringModifiers (e.g. ".", "p")
      command: z.boolean(),
      option: z.boolean(),
      shift: z.boolean(),
      control: z.boolean(),
      isRepeat: z.boolean(),
    }).strict(),
    result: z.object({ handled: z.boolean() }).strict(),
  },
  // Cross-webview controls-focus relay (one accent ring across ALL webviews).
  // Each panel is its own WKWebView with its own FocusModel store, and ö/ä is
  // web-owned (never forwarded), so a box focused in the mixer webview was
  // unreachable while the deck-surface webview held first responder — the key
  // died in a store that had nothing focused.
  //   claim:  this page's FocusModel took the controls ("controls") or grid
  //           ("grid") lane — native broadcasts to every OTHER link so their
  //           stores clear/park (the store invariant keeps at most one owner).
  //   adjust: ö/ä landed in a webview parked-for-remote — native broadcasts;
  //           the single page holding controls focus applies it.
  focusRelay: {
    params: z.object({
      op: z.enum(["claim", "adjust"]),
      kind: z.enum(["controls", "grid"]).optional(), // claim only
      delta: z.number().int().optional(), // adjust: ±1 coarse steps
      fine: z.boolean().optional(), // adjust: ⌥ fine held
    }).strict(),
    result: z.object({}).strict(),
  },
  // Capture (CAP-1, capture.md §4) — the recorder, which P4-05d deferred and
  // never re-homed: the web tools row replaces the WHOLE of GlobalToolbarView
  // row1, and row1 is where the Capture button lived, so with
  // `web.panel.toolbartools` on the app could not record at all.
  //
  // Every op is an INTENT onto ToolbarRecorder — capture stays Swift (Domain
  // Ownership): the AVFoundation export, the recordings-folder write and the
  // `In Progress` crash-marker protocol are OS concerns, and a webview has no
  // business near them. The web renders phase and asks; it never touches a file.
  capture: {
    params: z.object({
      op: z.enum([
        "toggle", // THE interaction: idle→recording→recorded→(clear)→recording
        "clear", // discard the take, back to idle
        "togglePreview", // audition the CROPPED span
        "setTrim", // trimStart/trimEnd, 0–1 normalised
        "sendToTrack", // export the crop → addTrack(sampleURL:)
        "sendToDisk", // export the crop → the recordings folder
        "openWindow", // re-open the take window (it auto-opens on stop)
      ]),
      trimStart: z.number().min(0).max(1).optional(),
      trimEnd: z.number().min(0).max(1).optional(),
    }).strict(),
    result: z.object({}).strict(),
  },
  // ── THE PLANE (merge P2 step 4) ──────────────────────────────────────────
  //
  // The merged engine's strip surface — sl_channel_* / sl_tape_* / sl_route_*
  // (SL-ABI-V3 §4/§5 plus the strip channel), built and sanitizer-clean in
  // apps/wizard/slengine but until now unreachable from any UI.
  //
  // ONLY THE MERGED HOST (WizardMerged) ANSWERS THESE. ScoopyLoops.app links
  // the pinned core, which has no tapes, no strip channels and no patchbay, so
  // it refuses them like any unimplemented method. That is deliberate and it is
  // why the plane is its own panel rather than a change to an existing one.
  //
  // Bundled by NOUN with an `action` enum, following gridEdit/fxSlot/capture,
  // rather than one method per ABI entry point. ~50 one-to-one methods would
  // make this file a hand-mirror of a C header — the thing the "never
  // hand-mirror a mapping" law exists to prevent — and 50 more branches in
  // SlDispatch. The C ABI stays the authority; this is its verb surface.
  //
  // Action-specific fields are `.optional()` because one zod object serves
  // every action. The DISPATCHER validates the combination, so a missing
  // required field is a loud refusal there, not a silent default here.
  slChannel: {
    params: z.object({
      action: z.enum(["setSource", "setLevel", "setMute", "setSend", "setMonitor"]),
      channel: z.number().int().min(0).max(7),
      /** setSource: 0 none · 1 tape · 2 gridDeck (sl_channel_set_source). */
      kind: z.number().int().min(0).max(2).optional(),
      /** setSource: the tape or grid-deck index within that kind's space. */
      index: z.number().int().min(0).optional(),
      /** setLevel/setSend: LINEAR gain, not a fader position. */
      level: z.number().min(0).optional(),
      /** setSend: which of the four sends. */
      send: z.number().int().min(0).max(3).optional(),
      /** setMute. */
      muted: z.boolean().optional(),
      /** setMonitor: does this strip's DEVICE INPUT reach the channel?
          NOT a second mute — `muted` is the channel's OUTPUT (it silences the
          strip and everything routed from it, including a tape playing back),
          while this gates only the input's path IN. The record path is
          untouched either way, so a take captured with the monitor closed holds
          the same audio as one captured with it open — which is what makes
          recording a mic without hearing it possible at all, and what lets a
          feedback loop be broken without losing the take. */
      on: z.boolean().optional(),
    }).strict(),
    /** `monitor` comes back on setMonitor, and it is THE ENGINE'S state rather
        than an echo of the request. The engine moves that switch itself —
        record-start opens it, the Law C-3 record→loop handoff closes it in the
        same render block (D-WZ-MON-01/02) — so a UI drawing what it last asked
        for would show a lit MON over a closed gate. Same discipline that
        `sl_deck_tempo_sync` exists for: display what is TRUE. */
    result: z.object({ ok: z.boolean(), monitor: z.boolean().optional() }).strict(),
  },
  slTape: {
    params: z.object({
      action: z.enum([
        "trigger", // 0 loop · 1 one-shot · 2 stop · 3 retrigger
        "seek",
        "setLoop",
        "setRate", // signed; negative is reverse
        "scrubBegin", "scrubTo", "scrubEnd",
        "overdubStart", // 0 SUM · 1 REPLACE (D-WZ-OVERDUB-01)
        "overdubStop",
        "waveform", // min/max columns for the strip's wave field
        "info", // frames/channels/rate/state — the post-record pull
      ]),
      tape: z.number().int().min(0).max(7),
      mode: z.number().int().min(0).max(3).optional(), // trigger / overdubStart
      frame: z.number().min(0).optional(), // seek / scrubTo (fractional: scrub)
      enabled: z.boolean().optional(), // setLoop
      start: z.number().min(0).optional(), // setLoop
      end: z.number().min(0).optional(), // setLoop
      rate: z.number().optional(), // setRate
      /** waveform: the span and the column count to reduce it into. */
      channel: z.number().int().min(0).optional(),
      startFrame: z.number().min(0).optional(),
      endFrame: z.number().min(0).optional(),
      columns: z.number().int().min(1).max(4096).optional(),
    }).strict(),
    result: z.object({
      ok: z.boolean(),
      // waveform
      min: z.array(z.number()).optional(),
      max: z.array(z.number()).optional(),
      // info
      frames: z.number().optional(),
      channels: z.number().optional(),
      rate: z.number().optional(),
      state: z.number().optional(),
    }).strict(),
  },
  slRoute: {
    params: z.object({
      action: z.enum([
        "add", "remove", "setGain",
        "clearAll", // what a document load issues FIRST (see mapApply)
        "installDefaults",
        "wouldCycle", // ask before adding, so a cycle is offered as a feedback
                      // edge rather than refused with no explanation
      ]),
      id: z.number().int().min(0).optional(), // remove / setGain
      /** add/wouldCycle source: 0 channelOut · 1 channelSend · 2 deviceInput
          · 3 fxReturn. Encodings are mapApply's, which are sl_engine.h's. */
      srcKind: z.number().int().min(0).max(3).optional(),
      srcIndex: z.number().int().min(0).optional(),
      /** Send 0–3, or the right-hand input channel. 0xFFFFFFFF = none — and
          NEVER 0, which is a real send index and a real input channel. */
      srcSub: z.number().int().min(0).optional(),
      /** add destination: 0 channelIn · 1 sendBus · 2 main. */
      dstKind: z.number().int().min(0).max(2).optional(),
      dstIndex: z.number().int().min(0).optional(),
      gain: z.number().min(0).optional(),
      /** THE LOAD-BEARING FLAG. false = rendered in dependency order at zero
          added latency, refused at edit time if it closes a cycle. true = reads
          the previous block, costs exactly one block, and is the only edge
          allowed to loop. Two routes differing only in this bit differ by a
          whole block of latency. */
      feedback: z.boolean().optional(),
    }).strict(),
    result: z.object({
      ok: z.boolean(),
      /** add: the new route's id. wouldCycle: whether it would. */
      id: z.number().optional(),
      wouldCycle: z.boolean().optional(),
    }).strict(),
  },
  /** Read the patchbay back out. The shape is mapApply's `LiveRoute`, one entry
      per SLOT over 0..sl_route_capacity(), so captureRoutes() consumes it
      unchanged — a save records the graph that EXISTS rather than the one the
      UI believes it issued, and those drift the moment anything edits routing
      outside the document's view. */
  slRouteList: {
    params: z.object({}).strict(),
    result: z.object({
      routes: z.array(z.object({
        active: z.boolean(),
        srcKind: z.number(),
        srcIndex: z.number(),
        srcSub: z.number(),
        dstKind: z.number(),
        dstIndex: z.number(),
        gain: z.number(),
        feedback: z.boolean(),
        /** Engine-only: installed by sl_route_install_defaults rather than by
            the user. Not in the document — a default is an ordinary route and
            is saved like one — but the plane uses it to decide what NOT to draw
            a cable for, so every cable on screen is one you made. */
        isDefault: z.boolean(),
      }).strict()).max(128),
      /** The published render order (sl_route_render_order), for the routing
          view's "this strip renders first" explanation. */
      renderOrder: z.array(z.number().int()).max(8),
    }).strict(),
  },
  /** Recording, as ONE method rather than start/stop pairs on two surfaces.
      The Law C-2 stamp exists only in the gap between them: sl_tape_record_stop
      RETURNS the engine sample capture began on, and RecordService::endTake must
      apply it before closing the file or the take ships TimeReference = 0 — the
      exact regression recorder_drain_test and sl_take_drain_test were written to
      catch. Splitting this across two round trips would put a UI thread in the
      middle of that handoff. */
  slRecord: {
    params: z.object({
      action: z.enum(["start", "stop"]),
      tape: z.number().int().min(0).max(7),
      /** start: WHERE the audio comes from — 0 deviceInput · 1 mainMix ·
          2 channelBus. For channelBus, `chan0` is a CHANNEL index, which is
          what makes "record the input" and "record the deck output" literally
          one operation on one code path.

          Carried HERE rather than as a separate arm call because the sequence
          is order-critical — set source, service (pre-allocate), start, open
          the file — and a UI that could interleave anything between those steps
          would be a UI that can arm a tape at the wrong source. The legacy
          shell's deckRecordStart is the same single atomic call for the same
          reason. */
      sourceKind: z.number().int().min(0).max(2).optional(),
      chan0: z.number().int().optional(),
      /** -1 = mono. Also decides the take file's channel count. */
      chan1: z.number().int().optional(),
      /** start: the human label of what is being captured, stored in the take's
          sidecar. It is the strip's provenance — the only record of what the
          material was, once the strip's element is the tape. */
      sourceDesc: z.string().optional(),
    }).strict(),
    result: z.object({
      ok: z.boolean(),
      /** stop: the take's path and its Law C-2 stamp. */
      path: z.string().optional(),
      startEngineSample: z.number().optional(),
      frames: z.number().optional(),
    }).strict(),
  },
  /** The take library. `list` unions what THIS process recorded with a scan of
      the takes directory, so reopening tomorrow still finds yesterday's takes.
      Sidecars are returned RAW: the document layer owns that schema (strict
      zod, persist/takeLibrary.ts), and a second parser in C++ would be a second
      definition of a format that is already a hand-mirrored boundary. */
  slTakes: {
    params: z.object({
      action: z.enum(["list", "delete", "reveal"]),
      path: z.string().optional(), // delete / reveal
    }).strict(),
    result: z.object({
      ok: z.boolean(),
      takes: z.array(z.object({
        path: z.string(),
        /** The sidecar's JSON text, or null when there is none. A .wav with no
            sidecar is STILL a take — a crash between closing the audio and
            writing the json produces exactly the take a user most wants back. */
        sidecar: z.string().nullable(),
      }).strict()).optional(),
    }).strict(),
  },
  /**
   * The GRID DECKS' engine surface (merge P2 step 4, increment 3).
   *
   * Only what the ABI actually has. `sl_deck_*` exposes count · clear ·
   * set_tempo_sync and NOTHING ELSE — in particular **there is no scene API**,
   * so scene selection is not here and cannot be: it travels inside the
   * published world (`slWorld`), because a scene is a projection of the
   * document, not an engine parameter.
   *
   * Declaring only what exists is the point. A `sceneSelect` here would be dead
   * ABI in the document equivalent — a method the UI could call, that would
   * return ok, and that would change nothing.
   */
  slDeck: {
    params: z.object({
      action: z.enum(["setTempoSync", "clear"]),
      deck: z.number().int().min(0).max(2),
      /** setTempoSync: master ÷ deck bpm. 1.0 is "run at your own tempo" and
          must be SENT, not omitted — a deck may be carrying a ratio from a
          previously loaded map, and silence would leave it stretched with
          nothing in the document explaining why. */
      ratio: z.number().positive().optional(),
    }).strict(),
    result: z.object({ ok: z.boolean() }).strict(),
  },
  /**
   * THE `.scoopyMap` DOCUMENT ON DISK (merge P2 step 4, increment 6).
   *
   * ⚠️ NOTHING COULD SAVE A MAP BEFORE THIS. The wire carried no file read or
   * write at all — `chooseDirectory` was the only filesystem method, and
   * `capabilities.fileSystem: true` means "this host owns native dialogs", not
   * "the web layer can write files". The browser companion persists through
   * OPFS, which is browser storage and exactly wrong for a native document. So
   * a whole plane could be built and lost.
   *
   * The map is a NATIVE document in a native app, stored beside the takes it
   * references: a map and its audio travelling together is what makes the
   * eventual collect-on-export a copy rather than a hunt.
   *
   * Deliberately JSON text rather than a path handed to the web layer — the web
   * layer must never hold a filesystem path it could dereference, and the
   * document layer already owns the format (strict zod, migrations,
   * refuse-newer). The shell moves bytes; TS decides what they mean.
   */
  slMap: {
    params: z.object({
      action: z.enum(["save", "open", "list", "delete", "export"]),
      /** save/open/delete: the map's name, without extension. */
      name: z.string().optional(),
      /** save: the serialised MapDocument. export: the REWRITTEN one, whose
          take refs already point inside the package. */
      json: z.string().optional(),
      /** export: the files to collect and the entry each becomes.
          ⚠️ NO AUDIO CROSSES THE BRIDGE. A take is capped at 256 MB, so base64
          would be ~350 MB of string per take — not slow, fatal. TS decides WHAT
          to collect (it owns the document); the shell moves the BYTES (it owns
          the files). Neither learns the other's job. */
      takes: z.array(z.object({ path: z.string(), entry: z.string() }).strict()).optional(),
    }).strict(),
    result: z.object({
      ok: z.boolean(),
      /** open: the file's bytes, for the document layer to parse. */
      json: z.string().optional(),
      /** export: where the package was written, and what it could not find.
          A missing take is REPORTED — a package quietly short one file fails on
          the other machine, at the worst moment, with no way to know why. */
      path: z.string().optional(),
      missing: z.array(z.string()).optional(),
      /** list: every map this host can open, newest first. */
      maps: z.array(z.object({
        name: z.string(),
        /** Epoch ms, for ordering and for showing "saved 3 minutes ago". */
        savedAt: z.number(),
      }).strict()).optional(),
      error: z.string().nullable().optional(),
    }).strict(),
  },
  /**
   * THE MASTER OUTPUT (merge P2 step 4, increment 5).
   *
   * The plane's front-of-house level. Live, applied once by the core's master
   * stage, and deliberately NOT reachable any other way: the world sink's
   * `setMainGain` stays a no-op because a SESSION's master volume must not
   * move the PLANE's master — loading a session would otherwise change your
   * front-of-house level, which is the last thing that should happen mid-set.
   *
   * The watchdog's lamp needs no method: `slWatchdogEngaged` / `slWatchdogGain`
   * are already HotFrame scalars, so the master section reads them on the same
   * rAF loop as every meter.
   */
  slMaster: {
    params: z.object({
      action: z.enum(["setLevel"]),
      /** Linear gain. Above 1.0 is allowed — the core's master clipper is
          behind this, so it is a fader, not a limiter. */
      level: z.number().min(0),
    }).strict(),
    result: z.object({ ok: z.boolean() }).strict(),
  },
  /**
   * THE INPUT SOURCE PICKER's data (merge P2 step 4, increment 2).
   *
   * A strip's live input is a ROUTE from a `deviceInput` endpoint — that is what
   * lets an input element need no special case anywhere. But a route names a
   * CHANNEL INDEX, and until something can turn indices into names there is
   * nothing to pick from, which is why every strip was hard-wired to inputs
   * 0/1 and every strip claimed to record "this strip's input" without being
   * able to say which.
   *
   * `channels` is compacted to ACTIVE inputs, so index i here IS the `srcIndex`
   * a route wants — no second mapping to keep in step.
   */
  slDevices: {
    params: z.object({
      action: z.enum(["list", "setInput"]),
      /** setInput: the device name from `devices`. */
      name: z.string().optional(),
    }).strict(),
    result: z.object({
      ok: z.boolean(),
      /** The input device in use. */
      current: z.string().optional(),
      /** Every input device this host could switch to. */
      devices: z.array(z.string()).optional(),
      /** Active input channel names, in route-index order. */
      channels: z.array(z.string()).optional(),
      /** setInput failure reason — reported, because a picker that silently
          fails leaves the user staring at a device that did not change. */
      error: z.string().nullable().optional(),
    }).strict(),
  },
  /**
   * THE GRID, PLAYING THROUGH THE NATIVE ENGINE (merge P2 step 4).
   *
   * WHY THIS IS SEPARATE FROM `worldPublish`. That method's params are
   * `{json: <a full PatternFile string>}` — scoopy/Swift's document path. The
   * merged host deliberately does NOT parse PatternFile in C++: the
   * document→engine translation is 505 tested lines of TS (`worldFromSession`)
   * and porting it a third time is exactly what the "never hand-mirror a
   * mapping" law forbids. So the merged host takes the FLAT `World` that
   * translation already produces, keyed by engine param NAME, and applies it
   * generically (`SlWorldApply`) without knowing what any field means.
   *
   * Overloading `worldPublish` with an optional `world` would leave one method
   * whose payload means two different things depending on the host — a
   * hand-mirror with no gate on it. This is the native path, named as such.
   *
   * ⚠️ WITHOUT THIS THE GRID CANNOT PLAY NATIVELY. `SlWorldApply` has been
   * built and tested since P1 with ZERO callers, because there was no wire
   * method to reach it: the web layer's world sink was written for the browser
   * companion and still pointed at the WASM worklet — an Emscripten copy of the
   * same core, running inside a native app that already has the real one. A
   * grid deck in a strip is impossible until a world can reach `sl_engine`,
   * which is why that was never a UI task.
   */
  slWorld: {
    params: z.object({
      action: z.enum(["registerSample", "publish"]),
      /** registerSample: the kit's id for this sample — what a world's tracks
          name. The engine resolves a track to audio through this id alone. */
      id: z.string().optional(),
      /** Decoded PCM, -1..1. `right` omitted = mono (the engine duplicates).
          Sent decoded rather than as a path because the DECODER lives in the
          web layer — it already decoded this kit — and the native side has no
          business owning a second one. */
      left: z.array(z.number()).optional(),
      right: z.array(z.number()).optional(),
      sampleRate: z.number().positive().optional(),
      /** publish: the flat World from `worldFromSession`, sent AS-IS. Typed
          `unknown` on purpose — restating its ~90 fields here would be a third
          copy of a shape that already has exactly one authority. */
      world: z.unknown().optional(),
    }).strict(),
    result: z.object({
      ok: z.boolean(),
      /** publish: whether the snapshot was committed, and why not if not. A
          refusal is reported, never swallowed — a silent no-op is
          indistinguishable from a dead wire. */
      applied: z.boolean().optional(),
      error: z.string().nullable().optional(),
    }).strict(),
  },
  /** Spawn a named panel in its own window. The plane's own spawn verb: it
      NAMES the panel rather than encoding it in the method (openFxSlotWindow,
      openInstrumentWindow, …), because "compose beside the map" means the plane
      opens a window per strip and cannot know at schema-writing time which
      panels a strip will want. Host-owned — it needs the window layer, so the
      shell intercepts it before the pure dispatcher. */
  openPanelWindow: {
    params: z.object({
      panel: z.string(),
      /** Becomes `window.__slPanelArg` in the new window — a deck index for a
          compose window, a slot for an FX window. */
      arg: z.string().optional(),
    }).strict(),
    result: z.object({}).strict(),
  },
  // Deterministic UiState pull: the page requests a topic after installing
  // its handlers; Swift re-runs the topic's push provider. Panels call this
  // on mount — pushes then keep it live. Eliminates load-order races.
  getUiState: {
    params: z.object({ topic: z.string() }).strict(),
    result: z.object({}).strict(),
  },
} as const;
export type Method = MethodOf<typeof COMMANDS>;
export type Params<M extends Method> = ParamsOf<typeof COMMANDS, M>;
export type Result<M extends Method> = ResultOf<typeof COMMANDS, M>;

/** Dialog purpose → UserDefaults path key (bookmark = `<key>.bookmark`). */
export const DIRECTORY_PURPOSE_KEYS = {
  recordings: "recordingsFolder",
  defaultKit: "defaultKitFolder",
} as const;

// The command envelope is the shared one (vendored shared/protocol/envelope.ts):
// requests are {id, method, params}, replies are {id, ok, result?, error?},
// both `.strict()`. The Swift emitter (WebEngineLink.respond) mirrors the reply
// exactly — a change there is a wire-format change moving both sides together.
export { CommandEnvelopeSchema, CommandReplySchema } from "./envelope.ts";

// ---------------------------------------------------------------------------
// Engine events — async native→UI notifications.
// ---------------------------------------------------------------------------
// MB-3 prep (2026-07-17): this union was STALE — `undo`/`redo`/`swiftEdit`/
// `settingChanged`/`focusRelay` were all emitted and consumed without being in
// it, so the event channel was de-facto untyped. It now describes EVERY event
// Swift emits (grep `emitEvent(` to re-audit); `menuCommand` joins with MB-3.
export const EngineEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("log"), message: z.string() }).strict(),
  // CoreAudio hot-plug: re-fetch enumerateAudioDevices.
  z.object({ type: z.literal("device-list-changed") }).strict(),
  // Output device/buffer apply completed (mirrors .audioOutputDeviceChanged).
  z.object({ type: z.literal("audio-output-changed") }).strict(),
  // CoreMIDI setup changed: re-fetch enumerateMidiEndpoints.
  z.object({ type: z.literal("midi-endpoints-changed") }).strict(),
  // Mapping list changed (learn completed natively, edit, delete).
  z.object({ type: z.literal("midi-mappings-changed") }).strict(),
  // Edit ▸ Undo/Redo delegated to the page under the flip (an NSMenu key
  // equivalent is consumed before the web view ever sees the keystroke).
  z.object({ type: z.literal("undo") }).strict(),
  z.object({ type: z.literal("redo") }).strict(),
  // MB-1a/MB-1d: Swift wrote the document behind TS's back (native menu op,
  // hotkey, track clipboard). `deck` present ⇒ the DJ link, which hosts BOTH
  // deck grids on one channel — only the grid whose source.deck matches adopts.
  z.object({
    type: z.literal("swiftEdit"),
    scope: z.string(),
    deck: z.number().int().min(0).max(2).optional(),
  }).strict(),
  // A cross-webview settings write landed (WebEngineLink.settingChangedNotification).
  z.object({ type: z.literal("settingChanged"), key: z.string() }).strict(),
  // KB: the focus relay's cross-webview leg (claim/adjust/release forwarding).
  z.object({
    type: z.literal("focusRelay"),
    op: z.string(),
    kind: z.string().optional(),
    delta: z.number().int().optional(),
    fine: z.boolean().optional(),
  }).strict(),
  // MB-3: a shell menu selection, routed to the registry host page. `id` is a
  // CommandId (registry.ts) — the page's runCommand refuses ids it does not
  // know or whose enablement predicate now says no.
  z.object({ type: z.literal("menuCommand"), id: z.string() }).strict(),
]);
export type EngineEvent = z.infer<typeof EngineEvent>;

// ---------------------------------------------------------------------------
// UiState — read-only view state pushed down by the Swift document owner
// (view+command mode) via window.__slpUiState(topic, state). Topic
// "spectral": all three decks' persisted SpectralSettings (Global debug
// section dropped per user CONFIRM — see panels/spectral.md §3).
// ---------------------------------------------------------------------------
export const SpectralDeckState = z.object({
  texture: z.number(), // 0..1 window-bank position
  chaos: z.number(), // -1..1
  airDb: z.number(), // 0..12
}).strict();
export type SpectralDeckState = z.infer<typeof SpectralDeckState>;

export const SpectralUiState = z.object({
  decks: z.tuple([SpectralDeckState, SpectralDeckState, SpectralDeckState]),
}).strict();
export type SpectralUiState = z.infer<typeof SpectralUiState>;

/**
 * One modulation channel, M1–M4 (MOD-3, panels/modulation.md).
 *
 * IMPORTANT: this is a FLAT, ALREADY-RESOLVED view. Swift owns the dual-model wart — M1/M2 read
 * their LFO/follower params from the legacy `masterTrack.lfo*` fields while M3/M4 read the
 * `ModChannel`, and the channel TYPE is derived three different ways in the Swift sources. The
 * binding resolves all of that when it builds this, so the web sees one shape and derives nothing.
 */
export const ModChannelState = z.object({
  type: z.enum(["lfo", "envFollower", "envelope"]),
  // --- LFO ---
  waveform: z.string(), // sine/triangle/square/saw/random
  // LFO-DIV rework: the cycle is a grid cell. Cycle length = (lcmMode ? patternLCM : cycleSteps)
  // ÷ cycleRatio steps. Always step-synced; the old FREE/SYNC + division-index model is gone.
  cycleSteps: z.number().int(), // 1…64 grid steps
  cycleRatio: z.number(), // speed ratio from the track-row detent table (2:1 = twice as fast)
  ratioLabel: z.string(), // e.g. "1:1" / "3:2" — resolved from cycleRatio (nearest detent)
  lcmMode: z.boolean(), // cycle base = pattern LCM instead of the step counter
  stepsPerCycle: z.number(), // RESOLVED effective cycle in steps (fractional); drives the Lab gridlines
  phaseOffset: z.number(), // 0..1 (0–360°)
  symmetry: z.number(), // LEGACY — superseded by `slant` (MOD-10). Persisted, no longer read.
  smooth: z.number(), // Follower smoothing only.
  // --- MOD-10 macro shaping: these ARE the LFO's shape. The waveform picker is now just a set of
  // presets that write these four, because the macros CONTAIN every classic wave exactly
  // (slant 0 / ease +1 is provably −cos(2πp), a pure sine). The space between the old waveforms —
  // unreachable with a discrete picker — is what this opens up.
  slant: z.number(), // −1 falling ramp · 0 symmetric · +1 rising ramp (and pulse width when hard)
  ease: z.number(), // −1 hard/stepped · 0 linear · +1 soft — square → triangle → sine on one axis
  jitter: z.number(), // 0..1 random deviation riding on the shape
  cyclic: z.number(), // 0..1 — does that deviation REPEAT (1) or is it fresh every cycle (0)?
  // --- MOD-11 "SHAPES": five more macros + a per-step stage layer. ALL default to identity
  // (warp/curve/chaos 0, fold/quant 0, stageCount 1, stageLevels [1], stageGlide 0) so an untouched
  // channel is bit-exact the MOD-10 wave. Eval order: warp(phase) → slant → ease → curve → fold →
  // quant → jitter/chaos → stages(×). See docs & NativeAudioEngineCore macroLfoValue.
  warp: z.number(), // −1..1 phase distortion (accelerate/decelerate the cycle without moving the peak)
  curve: z.number(), // −1..1 lobe convexity: +fat/round bulge · −pinched (beyond ease's cosine)
  fold: z.number(), // 0..1 wavefold drive — reflect the signal on itself to spawn new lobes
  quant: z.number(), // 0..1 amplitude staircase — S&H / stepped LFO
  chaos: z.number(), // 0..1 evolving drift that repeats at the LCM boundary (Turing-machine)
  stageCount: z.number().int(), // 1..16 cells the cycle is divided into
  stageLevels: z.array(z.number()), // per-cell VCA level 0..1, length == stageCount ([1] = identity)
  stageGlide: z.number(), // 0..1 slew between cells (0 = hard gate, 1 = smoothed)
  // --- all types ---
  depth: z.number(), // 0..1 per-channel master depth. At 0 the ENGINE silences it → draws flat.
  // --- Env-Follower ---
  envSourceTrackIndex: z.number().int(), // -1 = none
  envGain: z.number(),
  envAttack: z.number(),
  envRelease: z.number(),
  // --- Envelope (MSEG) ---
  trigSourceTrackIndex: z.number().int(), // -1 = none
  envelopeNodes: z.array(EnvelopeNode),
  sustainNodeIndex: z.number().int(),
  bipolar: z.boolean(),
  tempoSync: z.boolean(),
  /** MOD-10: one macro curving EVERY envelope segment — −1 snappy · 0 linear · +1 soft. */
  envEase: z.number(),
}).strict();
export type ModChannelState = z.infer<typeof ModChannelState>;

export const DeckSectionState = z.object({
  texture: z.number(), // WIN 0..1 (writes via deckBusTexture ParamWrite)
  syncEnabled: z.boolean(),
  pulse: z.string(), // DJPulseRelation rawValue, e.g. "1:1"
  transposeEnabled: z.boolean(),
  transposeSemitones: z.number(),
  beatRepeatActive: z.boolean(),
  beatRepeatLength: z.number().int(),
  // The micro zone. `nudgeBeatRepeatScale` walks ONE fused scale — 16…2, 1, then 1/2…1/32 —
  // where the tail is a re-triggering roll (length pinned to 1, subdivision 2…32). Without
  // this field the readout cannot name half its own scale, so the length cycler could not be
  // built: the web would show "1" for six distinct settings.
  beatRepeatSubdivision: z.number().int(), // 1 = whole steps; 2|4|8|16|32 = 1/N of a step
  // REV: global "session plays backwards" toggle (DJ Q/A shortcuts + the transport REV button).
  reverseActive: z.boolean(),
  sessionName: z.string(),
}).strict();
export type DeckSectionState = z.infer<typeof DeckSectionState>;

export const FxSlotState = z.object({
  mode: z.enum(["host", "external"]),
  pluginName: z.string().nullable(),
  editorVisible: z.boolean(),
  hostToHardware: z.boolean(),
  postFader: z.boolean(),
  latencyMs: z.number(),
  sendMasterGain: z.number(), // 0..2
  returnLevel: z.number(), // 0..2 (wet)
  muted: z.boolean(),
  soloed: z.boolean(),
  externalAvailable: z.boolean(),
  channelLabel: z.string().nullable(), // dedicated hw channel, 1-indexed
  // Numeric form of channelLabel (0-indexed device channel, -1 = none). The
  // label alone can't drive a Select — the EXT destination picker needs the
  // real value to show the current routing and to guard against showing a
  // stale one (MIX-R2).
  outputChannel: z.number().int(),
}).strict();
export type FxSlotState = z.infer<typeof FxSlotState>;

// ---------------------------------------------------------------------------
// Grid topics. "gridMeta" = pattern-wide. One TRACK arrives as two topics since P5-06
// step B — "gridPattern/<i>" (the document) + "gridRuntime/<i>" (Swift's forever); see the
// ownership header above GRID_RUNTIME_SHAPE. Per-track topics keep pushes small
// (panels/grid.md §6): Swift pushes only edited tracks. Cell arrays follow the
// PatternTrackCells contract (grid.md §2).
// ---------------------------------------------------------------------------
export const GridMetaState = z.object({
  trackCount: z.number().int(),
  horizontalZoom: z.number().int(), // 16 | 32
  displayMode: z.enum(["split", "scroll"]),
  isPlaying: z.boolean(),
  activeCellParameterName: z.string(), // selected track's param label for cells
  // NK-1: the NATIVE selected track (BeatSequencer.keyboardSelectedTrackIndex).
  // Read-back of what the web's own cursor published via gridEdit/selectTrack —
  // the web keeps the cursor, Swift keeps the selection, and this closes the
  // loop so the row can draw a selection ring that matches what the musical
  // keyboard and MIDI note-in will actually play. -1 = none/master/return.
  selectedTrackIndex: z.number().int(),
  /**
   * P5-06 step C3 — the MULTI-track selection (⌘-click), empty when there is none.
   *
   * Six ops fan out across it in the engine — setStepCount, cyclePlaybackMode(*),
   * toggleDirection, toggleLocatorRepeat, setOutputAssign, setTuning — so the web must be able
   * to both SEE it and set it. Until now it could do neither: the web's `selectTrack` only
   * moved the keyboard cursor and never touched `selectedTrackIds`, which meant (a) ⌘-click
   * multi-edit, a native capability, simply did not exist in the web grid, and (b) a selection
   * left over from a native or DJ-deck interaction was INVISIBLE here and would silently fan a
   * STEP change out across tracks the user never touched.
   *
   * Swift stays the owner (view+command); the web renders this and sends intents.
   */
  selectedTrackIndices: z.array(z.number().int()),
  /**
   * P5-06 step D — WHO OWNS THE PATTERN. Mirrors the `web.owner.patterns` flag.
   *
   * false (the default, and the only state that shipped before D): Swift owns it. The web sends
   * gridEdit/trackEdit INTENTS and renders what comes back — the arrangement since P5-02.
   *
   * true: TS owns it. Its reducers ARE the write path; it applies the edit itself and publishes
   * the result via `publishTrackPattern`. Swift becomes a mirror + the engine's delivery path.
   *
   * The web must be TOLD, not guess: sending an intent AND applying the reducer would double-
   * apply every edit, and doing neither would make the grid inert.
   */
  ownerPatterns: z.boolean(),
  // NK-1: Musical Keyboard Mode is engaged on the sequencer that will RECEIVE
  // keys (the focused one) — so every deck's grid reports the same answer, which
  // is what the grid actually needs to know. While it is true the grid must YIELD
  // its bare-letter shortcuts: the piano layout wants a·f·g·j·k·l·ö·ä, and the
  // grid claims every one of them (accent · flam · glide · reverse · param cycle
  // · value ±). Claim-by-default would eat six notes out of the scale and the
  // keyboard would look built and play wrong.
  noteKeyboardActive: z.boolean(),
  // NK-5: this sequencer is the one the KEYBOARD is on (HotkeyManager's
  // activeSequencer). The DJ view mounts TWO GridPanels in ONE page, each with
  // its own `window` keydown listener and no notion of the other — so every
  // arrow moved BOTH decks' cursors, and (once NK-3 made the cursor publish a
  // selection) both decks raced to claim the native selection on every press.
  // A grid that is not the keyboard's yields ALL keys to native, which routes
  // them to the deck that IS. `-` (native switchActiveDeck) then works because
  // the web finally hears about it — the ring existed, nothing ever re-pushed it.
  // Always true in compose, where there is exactly one grid.
  keyboardActive: z.boolean(),
  // PERF (v68): this sequencer's grid is in perform mode — pointer input sets the
  // per-track locator repeat window (drag = set + engage, click = disengage)
  // instead of composing. A per-sequencer property read straight off `seq`
  // (BeatSequencer.gridPerformModeActive), exactly like noteKeyboardActive /
  // muteGroupActive — so it reaches the COMPOSE grid (which follows the active
  // deck and only ever gets this meta topic, never the `dj` prop path) and each
  // DJ deck's grid uniformly. The transport PERF button still lights off
  // `dj.performMode`; this is the read the grid's pointer handling obeys.
  performActive: z.boolean(),
  bpm: z.number(), // segment mapping needs the grid step duration
  // CM-5b: the mute group is LATCHED (BeatSequencer.muteGroupActive). While it is
  // true, a track row's M button edits MEMBERSHIP instead of muting — so the row
  // has to know, and the grid's own meta topic is the row's context. (The `scenes`
  // topic carries the same flag as `muted` for the MUTE pad, but that pad lives in
  // the TRANSPORT panel — a different WKWebView, whose store the grid cannot read.)
  muteGroupActive: z.boolean(),
  // --- Master track row (P6-08). It is a per-sequencer surface, exactly like
  // the grid, so it rides the grid's own meta topic (gridMeta / djMeta/<d>)
  // rather than inventing a parallel one. `bpm` above IS the row's BPM.
  masterVolume: z.number(), // 0..2 (native VOL, display ×100)
  masterDrive: z.number(), // 1..32 clipper drive — reaches DSP on every deck (in-main decks drive pre-sum)
  /** The tempo the sync system resolved this deck to, or null when unsynced —
   *  native strikes the BPM through and prints this beneath it. */
  syncedBpm: z.number().nullable(),
  /**
   * Which DECK this grid page is showing (0|1|2), or null for the headless/debug
   * grid. Compose: the editing deck (the host re-captures it on every deck
   * switch); DJ: the deck literal. Drives the compose focus ring — the 1px inset
   * ring in the deck's identity color that marks WHICH deck you are composing,
   * now that the DJ deck header (the A/B letter badge) is gone.
   */
  deckIndex: z.number().int().nullable(),
  /**
   * This deck's MASTER sends to the FX buses (MixerConsole.deckMasterSend[deck],
   * pre-fader/pre-mute, 0..1) — length mirrors the live FX-bus count (2, or 4
   * with sends 3/4 enabled), like toolbar.fxSlots. The master row renders them
   * as regular horizontal sends (the deck header IS the deck's master track);
   * empty when deckIndex is null. Writes go back via paramWrite("deckMasterSend",
   * v, deckIndex, bus).
   */
  masterSends: z.array(z.number()),
  /**
   * MB-4 prerequisite (v75): does SWIFT's undo stack hold history (topology,
   * bpm, settings scenes — the domains TS does not own)? The command
   * registry's `canUndo` must mean the COMBINED history — the page's TS
   * stack OR these — or the registry menu would grey ⌘Z exactly when only
   * the `swiftUndo` fall-through remains. Pushed from the undo choke point
   * (`swiftEditNotification`) and after every `swiftUndo` command. Optional
   * so older meta constructions (tests/companion) stay valid; absent = false.
   */
  // `.nullable()` too: the Swift twins are `Bool?` with explicit-null encode —
  // a nil there must degrade to "unknown", never reject the whole payload.
  swiftCanUndo: z.boolean().nullable().optional(),
  swiftCanRedo: z.boolean().nullable().optional(),
}).strict();
export type GridMetaState = z.infer<typeof GridMetaState>;

// ---------------------------------------------------------------------------
// Scenes (P5-05 wire surface; P4-05e transport pads consume it). Topic
// "scenes" follows the SAME sequencer the grid follows (attachGrid's
// resolver). Domain Ownership holds: scenes stay Swift (morph/persistence in
// BeatSequencer) — the web renders this state and sends INTENTS only.
// ---------------------------------------------------------------------------
export const SceneUiState = z.object({
  enabled: z.array(z.string()), // scene letters "A"…"H" in DISPLAY order (reorderable)
  current: z.string(), // active scene letter
  queued: z.array(z.string()), // scheduledPatternQueue (blink = pending)
  loopEnabled: z.boolean(), // queue auto-loops (⇧-click adds)
  switchMode: z.enum(["scheduled", "seamlessImmediate", "restartImmediate"]), // Sched/Run/Start
  // Clean cut: fade all still-ringing voices (~10 ms) at the switch boundary so the old scene
  // stops instead of ringing out (FX tails keep ringing). Global preference, persisted natively.
  cleanCut: z.boolean(),
  latched: z.boolean(), // SCN scene-edit latch (hotkey 9 — pins edits to the scene)
  muted: z.boolean(), // master mute group (hotkey 0 — toolbar MUTE)
  canAdd: z.boolean(), // legacy add-slot visibility (all 8 enabled = false)
  // Scene OVERRIDES (CM-3). A parameter is normally global across scenes; pinning
  // it makes it scene-local. The web reproduces `isPinnableKey` as a pure function
  // from the two SOURCE sets below (BeatSequencer :10938/:10945) rather than a
  // hand-copied list — a copy would drift and offer pins that silently do nothing.
  sceneLabel: z.string(), // current scene's 1–8 display label
  pinnedKeys: z.array(z.string()), // keys pinned to the CURRENT scene
  pinnableMasterKeys: z.array(z.string()), // "bpm", "masterVolume", …
  pinnableTrackFields: z.array(z.string()), // "volume", "pan", … (sends deliberately absent)
  // CM-5. `scenesWithOverrides` gates "Clear Scene Overrides" per pad (native
  // disables it when the scene has none); `muteGroupCount` is the MUTE menu's
  // "N member(s)" readout and gates "Clear Group".
  scenesWithOverrides: z.array(z.string()), // scene letters carrying pinned values
  muteGroupCount: z.number().int(),
}).strict();
export type SceneUiState = z.infer<typeof SceneUiState>;

/**
 * One explicit modifier routing (Track.ModRouting): mod channel M1–M4 driving
 * a parameter, with its live depth. Data-driven — the row shows a slider only
 * for entries the user mapped (native ModSlotView).
 */
export const ModSlotState = z.object({
  channelIndex: z.number().int(), // 0…3 → M1…M4
  target: z.string(), // "pitch"|"filter"|"volume"|"pan"|"gain"|"sampleStart"|"sampleEnd"|"freeRate"
  targetShort: z.string(), // native shortLabel: P/F/V/Pan/G/S/E/R
  depth: z.number(), // −1…1 (bipolar)
}).strict();
export type ModSlotState = z.infer<typeof ModSlotState>;

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * P5-06 step B — THE OWNERSHIP SPLIT.
 *
 * `grid/<i>` used to be ONE ~90-field struct mixing two kinds of state, which made it
 * impossible to flip ownership: TS cannot own a struct half of which only Swift can know.
 * It is now two topics, and WHICH ONE a field lives in IS the ownership contract:
 *
 *   gridPattern/<i>   the DOCUMENT. TS may own these after the flip (step D), at which
 *                     point Swift STOPS pushing them. Until then Swift still pushes —
 *                     splitting the topic is NOT the flip.
 *   gridRuntime/<i>   Swift's FOREVER. TS can never compute these; Swift pushes them for
 *                     good, before and after the flip.
 *
 * THE RULE: a field is `pattern` iff TS could reconstruct it from the PatternFile it would
 * own. If computing it needs decoded audio, the SampleBank, the plugin host, live transport
 * or native focus state, it is `runtime`.
 *
 * ⚠️ THE RULE HAS A HOLE, and three fields fall in it — they ARE persisted in the document
 * and are still runtime, because their value ORIGINATES outside it and native events rewrite
 * it: `isStopped` (the audio clock flips it at a quantize boundary), `sampleKey` and
 * `sampleDurationMs` (written from the decoded audio, and sampleKey is remapped against the
 * SampleBank on load, so the persisted value is not even the effective one). "Persisted"
 * was necessary but not sufficient; "TS can maintain it" is the real test.
 *
 * ⚠️ TWO FIELDS ARE DELIBERATELY NOT ON THE WIRE: `renderGain` and `chopPointsMs`. Each is
 * computed from BOTH a pattern input and a runtime one, so it belongs to neither side and
 * would go stale the moment TS owned its pattern half (drag the gain box → Swift's
 * renderGain is stale → the waveform amplitude lies until Swift re-pushes). We ship the
 * PRIMITIVES instead — `samplePeakGain`, `sampleDurationMs`, `chopPoints`, `chopCount` — and
 * TS derives both (`deriveTrackState`). Consumers still see `renderGain`/`chopPointsMs` on
 * `GridTrackState`; they are just computed rather than pushed.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Swift's forever. TS can never compute these — see the rule above. */
const GRID_RUNTIME_SHAPE = {
  // Resolves through the SampleBank (falls back to the sample's filename), and Swift
  // OVERWRITES track.name from the bank entry on load. Not TS-computable.
  name: z.string(),
  // NOT persisted — `isSoloed` appears nowhere in SequencerState. Session-live only.
  soloed: z.boolean(),
  // Pure UI selection: which parameter the track's +/- lane edits. Not in the document.
  activeCellParameterName: z.string(),
  // Persisted, but REMAPPED against the SampleBank on load — the persisted uuid is not
  // necessarily the effective one. Also the WaveformCache lookup handle.
  sampleKey: z.string().nullable(),
  // Persisted, but written from the DECODED AUDIO at sample load. TS cannot compute a new one.
  sampleDurationMs: z.number(),
  // 1 / peakAmplitude, straight off the decoded buffer. Replaces the old `renderGain`, which
  // multiplied this by the pattern-owned `gain` and so belonged to neither side.
  samplePeakGain: z.number(),
  // Transient by construction ("nil = no pending"); written only by the launch scheduler.
  launchScheduled: z.boolean(),
  // Persisted — but the audio clock flips it when a scheduled launch fires on the boundary.
  // If TS owned it, a launch firing on the next bar would never reach the web.
  isStopped: z.boolean(),
  // THE BEAT-REPEAT REGION, already resolved to THIS track's display indices — the steps
  // native fills blue (ContentView:12655). Empty when beat repeat is off or the deck is
  // stopped, which is also native's gate (`if isPlaying, isBeatRepeatActive`).
  //
  // Resolved Swift-side, and it has to be. The region is contiguous in GLOBAL steps
  // (`start … start+length-1`, BeatSequencer.getBeatRepeatRange) but NOT in a track's own
  // display steps: `displayStep` phase-adjusts, speed-scales, wraps and inverts it per track,
  // so a speed-ratio track lands on every other index and a backward one runs descending.
  // Shipping the range and re-deriving in TS would fork `SpeedRatioTiming.expectedLocalStep`
  // into a second language. Shipping the RESOLVED SET forks nothing.
  //
  // Not on the HotFrame, deliberately: this changes when you press a key (engage / nudge /
  // shift / play / stop), not every frame — and an exact per-track set over a ≤64-step
  // pattern is a bitmask no Float64 can hold. It is state, so it rides a state topic and
  // paints on the grid's STATIC layer.
  beatRepeatSteps: z.array(z.number().int()),
  // SUB-1 FRACTIONAL WINDOW geometry (subdivision > 1). A sub-1 repeat (1/2 … 1/32) is exactly the
  // k-th of `subdivision` equal sub-cells of a single step, so it draws as a fractional-width inset
  // of ONE display cell rather than a whole-cell fill. Resolved Swift-side (same reasons as
  // `beatRepeatSteps`, which is emptied while a sub-1 window is active to avoid double-painting).
  //   beatRepeatSubStep  = the display step the window sits in, or -1 when there is no sub-1 window.
  //   beatRepeatSubStart = fractional offset within that cell, in the cell's visual L→R direction.
  //   beatRepeatSubLen   = fractional width within the cell (= 1/subdivision).
  beatRepeatSubStep: z.number().int(),
  beatRepeatSubStart: z.number(),
  beatRepeatSubLen: z.number(),
  // Preset stepping (v81): the bound plugin's JUCE program list, read from the LIVE
  // instance on the owner core — plugin-host state, so runtime by the rule above.
  // count ≤ 1 = the plugin does not expose stepable programs (the ‹› stepper renders
  // disabled). All three are null when no instrument is bound or its slot isn't loaded.
  instrumentPresetIndex: z.number().int().nullable(), // current program, 0-based
  instrumentPresetCount: z.number().int().nullable(), // total programs
  instrumentPresetName: z.string().nullable(), // current program's display name
} as const;

/** The DOCUMENT. TS's after the flip; Swift still pushes it until then. */
const GRID_PATTERN_SHAPE = {
  colorHex: z.string(), // track color as #rrggbb (session data, not theme)
  trackType: z.enum(["audio", "midi"]),
  playbackMode: z.string(), // regular/owner/loop/stretch raw
  stepCount: z.number().int(),
  muted: z.boolean(), // the RAW track flag — not an effectiveMute (solo folds in elsewhere)
  patternStartStep: z.number().int().nullable(),
  // cells (grid.md §2 contract; dense unless noted)
  steps: z.array(z.boolean()),
  cellLengths: z.array(z.number().int()),
  wrapSourceStep: z.number().int().nullable(),
  pitchOffsets: z.array(z.number()), // may exceed steps.length
  accentLevels: z.array(z.number().int()), // 0|1|2
  flamCounts: z.array(z.number().int()),
  glideSteps: z.array(z.boolean()),
  reverseSteps: z.array(z.boolean()),
  preSilenceMsOffsets: z.array(z.number()),
  cellChopIndices: z.array(z.number().int()),
  // Per-cell chord voicing: index into ChordLibrary.entries (0 = OFF). The
  // library is Swift-owned (ChordLibrary.swift); the web mirrors its labels
  // (chordLibrary.ts) and only ever writes an INDEX via adjustParameter.
  chordIndices: z.array(z.number().int()),
  // Per-step additive offsets over track base values (P5-02: needed to
  // render + edit the active cell parameter; step-anchored, grid.md §2).
  volumeOffsets: z.array(z.number()), // pre-clipper gain
  mixVolumeOffsets: z.array(z.number()), // post-clipper volume
  panOffsets: z.array(z.number()), // −1…+1
  toneOffsets: z.array(z.number()), // −100…+100
  // NOTE: send1..4Offsets were here and are DELETED — nothing in web/src ever read them
  // (the cell-parameter lane has no send lanes), so they were 4 dead arrays × 16 tracks on
  // every push. The per-step send automation still exists in the engine and the document;
  // it simply has no web surface yet. Re-add them here when one is built.
  sampleStartMsOffsets: z.array(z.number()),
  sampleEndMsOffsets: z.array(z.number()),
  sampleStartMs: z.number(),
  sampleEndMs: z.number(),
  swing: z.number(),
  // P5-02c segment mapping — mirrors what the engine plays (the Swift
  // WaveformOverlay reads the same fields; see gridWave.ts for the port)
  globalPitchOffset: z.number(), // quarter-tones
  speedMultiplier: z.number(), // per-track varispeed
  rateLockRatio: z.number(), // per-track designated ⟳ reset ratio (assigned via the rate control's right-click menu)
  pitchSyncMode: z.boolean(), // speed also pitches (T+P)
  timeStretchMode: z.boolean(), // speedMode == .timeStretch
  stretchToCell: z.boolean(), // stretch-to-cell-length window
  loopEnabled: z.boolean(),
  loopStartMs: z.number(),
  loopEndMs: z.number(),
  // The RAW stored chop starts (−1 = "not set, use an equal slice") + the count. The
  // RESOLVED set (`chopPointsMs`) is derived from these plus the runtime sampleDurationMs —
  // see deriveTrackState. Shipping the resolved set would have frozen a runtime input into
  // a pattern field.
  chopPoints: z.array(z.number()),
  chopCount: z.number().int(),
  defaultChopIndex: z.number().int(), // -1 = chopper off
  melodicPitchMode: z.boolean(), // per-step pitch picks buffer, not rate
  isReversed: z.boolean(), // track-level reverse (XOR per-step)
  preSilenceMs: z.number(), // track-global lead-in silence
  rhythmicOffsetRatios: z.array(z.number()), // per-step delay as step fraction
  // --- TR base scalars (trackrow.md §8.2): the row's live-editable values.
  // Per-cell OFFSETS above already ride; these are the track base each box +
  // geometric slider edits (v9). Owner stays Swift; view+command trackEdit.
  // ⚠️ UI RANGE ≠ ENGINE CLAMP. These three comments used to state the UI range as if it were
  // the engine's, and a reducer written from them would clamp values the engine happily
  // accepts. The UI ranges below match the NATIVE controls (the reference); the engine's clamps
  // are wider safety bounds. Both are true — they are just different things, and P5-06-C's
  // reducers must reproduce the ENGINE's.
  gain: z.number(), // UI 0…2 (pre-clipper drive, default 1). ENGINE: **no clamp at all** (BeatSequencer:4747)
  volume: z.number(), // UI 0…2 (display 0–120 via volumeToDisplay). ENGINE clamps 0…3 (BeatSequencer:4775)
  pan: z.number(), // −1…1 (C / L## / R##). ENGINE clamps −1…1.
  tone: z.number(), // −100…100 (tone) / 0…100 (filter modes — the engine stores |v|; see clampedToneValue)
  toneFilterMode: z.string(), // "tone" | "lowPass" | "highPass" | "bandPass" | "notch"
  // ⚠️ Changing this REWRITES `tone` (convertedToneValue, BeatSequencer:18654): leaving lowPass
  // for tone restores a NEGATIVE sign; every filter mode stores the absolute value.
  toneQ: z.number(), // UI = the Q preset menu. ENGINE clamps 0.5…18 (BeatSequencer:18634)
  filterDrive: z.number(), // resonance drive 0…100 — saturates the SVF band-pass state; 0 = linear
  globalFineTuneCents: z.number(), // ±50 cents (pitch fine)
  chokeGroup: z.number().int(), // 0…8 (0 = OFF)
  voiceMode: z.string(), // "mono" | "poly"
  stereoMode: z.number().int(), // 0 mono / 1 stereo / 2 left / 3 right
  send1Level: z.number(), // 0…1 base send levels
  send2Level: z.number(),
  send3Level: z.number(),
  send4Level: z.number(),
  glidePercent: z.number(), // 0…100 glide length
  freeRate: z.number(), // −64…64 tape rate
  freeRateEnabled: z.boolean(),
  // NOTE: `speedRatioLabel` was here and is DELETED — a pure function of speedMultiplier that
  // TS had ALREADY ported (`speedRatioName` in trackControls.ts), so nothing read the pushed
  // one. A textbook derived-pattern field that was silently flipped long ago.
  stretchTimeOnly: z.boolean(), // REG stretch quality: T (true) / T+P (false)
  playbackDirectionReversed: z.boolean(), // idx 36
  ownerAttack: z.number(), // 0…100 % (engine clamps 0…100)
  ownerGate: z.number(), // 0…100 % — NOT 1…100 as this comment used to claim (BeatSequencer:12827)
  loopCrossfadeMs: z.number(),
  // LOCATOR — the DOCUMENT's own fields (start + end), not the derived length.
  //
  // ⚠️ The wire used to carry `locatorLengthSteps`, which is a COMPUTED clamp
  // (`max(1, min(euclideanSteps, end - start + 1))`, Track.swift:660) — and the raw
  // `locatorEndStep` MAY EXCEED the pattern, because that is how a wrapping locator is encoded.
  // So the end is NOT recoverable from the clamped length, and `setStepCount`'s locator re-fit
  // (which reads the raw end) could not be reproduced. Same trap as `renderGain` in step B:
  // ship the PRIMITIVE, derive the product. The length + the two gated display values are
  // computed in `deriveTrackState`.
  locatorStartStep: z.number().int(), // 0-based; display is +1
  locatorEndStep: z.number().int(), // may exceed stepCount-1 — that encodes a WRAP
  locatorRepeatActive: z.boolean(),
  modSlots: z.array(ModSlotState), // mapped modifier routings (≤ 6 per track)
  outputAssign: z.number().int(), // 0 = stereo (pan), 1 = Output 1, 2 = Output 2
  tuning: z.number().int(), // MusicalTuning: 0 = 12-TET, 1 = Just
  muteGroupMember: z.boolean(), // CM-5: in the master MUTE group (hotkey 0 mutes all members)
  // --- Unified track: MIDI is a DESTINATION, not a track type (schema v40).
  // `trackType` above says what the track SOUNDS (a sample, or a hosted instrument
  // plugin when hasInstrument). `midiOutEnabled` is orthogonal: ANY track can also
  // send its cells to the external port, so an audio track plays its sample AND
  // drives hardware. A track with no audio path of its own (midi, no instrument)
  // routes its volume/pan/tone dials to CC 7/10/74 instead.
  // `trackType` above is no longer a "type" — it is the SAMPLE output's switch ("audio" =
  // the sample voice sounds). Since v81 SMP|INST is a HARD-EXCLUSIVE source switch (user
  // decision 2026-07-18): a track sounds its sample OR its instrument, never both, enforced
  // Swift-side; flipping never clears content (the sample stays loaded, the plugin stays
  // bound with its state). MIDI stays an independent third output on top of either source.
  instrumentOutEnabled: z.boolean(), // the bound plugin sounds (its audio runs this track's DSP chain)
  midiOutEnabled: z.boolean(), // the pattern also drives the external port
  // NOTE: `midiChannel` was here and is DELETED — no panel ever read it (only test fixtures).
  // The document still carries it; re-add when the channel picker it was meant for is built.
  midiRootNote: z.number().int(), // 0…127; the cell's pitch offset transposes THIS
  midiGatePercent: z.number(), // 1…100: how much of a cell a note sustains (100 = legato)
  midiVelocities: z.array(z.number().int()), // per-cell 0…127 (0 = a gate step: release, sound nothing)
  hasInstrument: z.boolean(), // an AU/VST3 instrument plugin is bound
  instrumentName: z.string().nullable(), // its display name, null when none
  // NK-1: this track is PINNED to the note keyboard — it hears the keys no
  // matter what is selected or which deck is focused. Mirrors
  // `Track.midiInputChannel != 0` (Off), so a channel assigned from SwiftUI's
  // per-track "In" menu also lights the pin: one field, one truth, two UIs.
  midiInputPinned: z.boolean(),
} as const;

/** Topic `gridPattern/<i>` · `djPattern/<d>/<i>` — the document half. */
export const GridPatternState = z.object(GRID_PATTERN_SHAPE).strict();
export type GridPatternState = z.infer<typeof GridPatternState>;

/**
 * The pattern half's field names — the exact set TS may own.
 *
 * Derived from the shape, never hand-listed: the P5-04 drift detector projects a predicted
 * track onto these keys to compare against the authoritative `gridPattern` push, and a
 * hand-maintained list would silently stop covering a field the day someone added one.
 */
export const GRID_PATTERN_KEYS = Object.keys(GRID_PATTERN_SHAPE) as (keyof GridPatternState)[];

/** Topic `gridRuntime/<i>` · `djRuntime/<d>/<i>` — Swift's forever. */
export const GridRuntimeState = z.object(GRID_RUNTIME_SHAPE).strict();
export type GridRuntimeState = z.infer<typeof GridRuntimeState>;

/** The two halves as they arrive on the wire, merged. Not what panels consume — see below. */
export const GridWireState = z.object({ ...GRID_PATTERN_SHAPE, ...GRID_RUNTIME_SHAPE }).strict();
export type GridWireState = z.infer<typeof GridWireState>;

/**
 * What every panel actually consumes: the wire plus the two DERIVED fields.
 *
 * `renderGain` and `chopPointsMs` are computed by `deriveTrackState`, not pushed — each mixes
 * a pattern input with a runtime one, so neither side can own it (see the header). Keeping
 * them on this type means no consumer had to change when they left the wire.
 */
export const GridTrackState = GridWireState.extend({
  renderGain: z.number(), // = gain × samplePeakGain
  chopPointsMs: z.array(z.number()), // = resolved chopPoints (−1 → equal slice of the sample)
  // = max(1, min(stepCount, locatorEndStep − locatorStartStep + 1)) — Track.swift:660
  locatorLengthSteps: z.number().int(),
  // The row's display values: null while the repeat is off.
  locatorStart: z.number().int().nullable(),
  locatorLength: z.number().int().nullable(),
});
export type GridTrackState = z.infer<typeof GridTrackState>;

// Topic "toolbar": transport + deck-mixer + mic state (panels/toolbar.md §4).
export const ToolbarUiState = z.object({
  masterIsPlaying: z.boolean(),
  masterTempo: z.number(),
  deckPlaying: z.array(z.boolean()), // A/B/C
  deckQuantizePending: z.array(z.boolean()),
  deckVolume: z.array(z.number()),
  deckMuted: z.array(z.boolean()),
  deckSoloed: z.array(z.boolean()),
  sendSoloed: z.array(z.boolean()), // 4 entries, FX1…FX4 (mixer overhaul — was 2)
  returnVolume: z.array(z.number()), // returns 1/2
  crossfaderEngaged: z.boolean(),
  crossfaderPosition: z.number(),
  // xmixSides / xmixReturnCarveable RETIRED with the per-channel X picker (mixer
  // overhaul): sides are fixed policy — A→a, B→b, rest own — until the X-MIX matrix.
  deckCEnabled: z.boolean(),
  djModeEnabled: z.boolean(),
  // MB-5 slice 2 (v79): the ACTIVE sequencer's bounce/record state — the
  // registry's Bounce item reads these for its flipping label + enablement
  // (same resolver the `menuSession` action targets). Optional: older
  // constructions stay valid; absent = false.
  // `.nullable()` too — same explicit-null rule as GridMetaState.swiftCanUndo.
  activeIsBouncing: z.boolean().nullable().optional(),
  activeIsOutputRecording: z.boolean().nullable().optional(),
  // Which deck the COMPOSE view is editing (0/1/2); null in DJ mode. The deck
  // selector's lit state — the one thing that tells you which deck the grid
  // below is showing.
  editingDeckIndex: z.number().int().nullable(),
  deckSections: z.array(DeckSectionState),
  fxSlots: z.array(FxSlotState), // slots 1/2 (+3/4 when showSends34)
  // Inline OUT routing (P4-09c): per-deck current output channel pair
  // (null = Main mix), and the device's available stereo pairs. Empty
  // pairs list = stereo-only device → picker hidden (parity w/ native).
  deckOutputChannels: z.array(z.array(z.number().int()).nullable()),
  outputPairs: z.array(z.object({ first: z.number().int(), label: z.string() }).strict()),
  // Deck-master → FX send levels [deck][sendIndex-1] (0..1): console routing,
  // persisted app-level (MIX-NATIVE-1). 3 decks × 4 buses.
  deckMasterSend: z.array(z.array(z.number())),
  // The live-input channel (labelled INPUT — covers mic and line). Its bottom
  // row is a SOURCE picker, so the strip needs the current input selection
  // (MIX-R3): start channel is 0-indexed, `inputIsStereo` picks pair-vs-mono.
  mic: z.object({
    enabled: z.boolean(),
    gain: z.number(),
    monitorOn: z.boolean(),
    muted: z.boolean(),
    // Mic → all 4 FX buses (MIX-NATIVE-3 widened the core from 2).
    send1: z.number(),
    send2: z.number(),
    send3: z.number(),
    send4: z.number(),
    inputStartChannel: z.number().int(),
    inputIsStereo: z.boolean(),
  }).strict(),
  // Channel count of the SELECTED input device (0 = no input device) — the
  // strip builds its channel/pair options from this, same as the Audio pane.
  inputChannelCount: z.number().int(),
  // NK-1: Musical Keyboard Mode (the "piano"). Per-sequencer native state,
  // reported for the ACTIVE sequencer — the same one ⌘K toggles.
  musicalKeyboard: z.object({
    enabled: z.boolean(),
    octaveOffset: z.number().int(), // …-1, 0, +1… (×12 semitones)
    velocity: z.number().int(), // the resolved preset: 38 | 64 | 100 | 127
  }).strict(),
  // NK-1: the track PINNED to the note keyboard, or null when nothing is
  // pinned — and null means SILENT: note-in is pin-only (2026-07-15), it never
  // falls back to the selection. The transport panel is its OWN WKWebView and
  // cannot read the grid topics, so the pin's identity is carried here rather
  // than derived from grid/<i>.
  midiPin: z
    .object({
      deck: z.number().int().min(0).max(2),
      trackIndex: z.number().int().min(0),
      name: z.string(), // so the cluster can name its target without grid state
    })
    .strict()
    .nullable(),
  // (quantizeLabel removed in P6-07 — the DJ topic's `launchQuantize` is the
  // single source; the toolbar no longer mirrors it. `waveformVisible` removed
  // in TB-1 with the tools row's WAVE toggle: it mirrored a SwiftUI-only
  // renderer switch that the web grid made unreachable.)
}).strict();
export type ToolbarUiState = z.infer<typeof ToolbarUiState>;

// ---------------------------------------------------------------------------
// Topic "dj" (P6-02, panels/djmode.md §6). DELIBERATELY NARROW: the toolbar
// topic already owns masterTempo, deck play/volume/mute/solo, crossfader
// position+ENGAGE, deckCEnabled, per-deck sync/pulse/TR/beat-repeat
// (DeckSectionState) and the quantize LABEL. This topic adds only what the DJ
// *view* needs on top — duplicating a field would give it two owners.
//
// ⚠️ Workflow law (user, 2026-07-12): X·MIX *is* the crossfader; the sync
// system answers all BPM questions. The classic constant-power blend and
// crossfader-driven tempo blending ("smart BPM") are workflow-DEAD and get no
// web surface. Domain Ownership unchanged: DJModeManager owns this math
// (P6-01 fixtures guard it) — the web renders + sends intents.
// ---------------------------------------------------------------------------
export const DjDeckState = z.object({
  originalBpm: z.number(), // djOriginalBpm — the deck's own session tempo
  syncedBpm: z.number().nullable(), // currentSyncedBpm (null = not synced)
  // `xfaderSide` was here, then rode the toolbar topic (Phase XN), then left the wire
  // entirely (mixer overhaul): sides are fixed policy — A→a, B→b, rest own — until the
  // X-MIX matrix brings its own surface.
  trackCount: z.number().int(),
}).strict();
export type DjDeckState = z.infer<typeof DjDeckState>;

export const XmixState = z.object({
  enabled: z.boolean(),
  strength: z.number(), // 0..1 carve depth
  fullerCurve: z.boolean(), // γ=0.5 volume curve
  shimmer: z.boolean(),
  shimmerAmount: z.number(), // 0..1
}).strict();
export type XmixState = z.infer<typeof XmixState>;

/**
 * DECK-SCOPED GRID TOPICS (P6-02 → consumed by P6-03).
 *
 *   "djMeta/<deck>"             payload = GridMetaState     (deck 0|1|2)
 *   "djPattern/<deck>/<track>"  payload = GridPatternState  (track 0…15)
 *   "djRuntime/<deck>/<track>"  payload = GridRuntimeState
 *
 * Why a parallel namespace instead of re-scoping "grid/<i>": the compose grid
 * topics describe whatever the RESOLVER returns (one deck at a time), and the
 * P5-04 shadow PatternStore + its drift detector — the evidence gate for
 * P5-06 THE FLIP — are wired to exactly those topic names. The DJ view needs
 * two decks rendered at once, so it gets its own deck-indexed topics carrying
 * the SAME payload types (and therefore the same TS renderers/reducers). The
 * two namespaces collapse into one after the flip, when the resolver dance
 * goes away.
 *
 * P5-06 step B: the DJ decks are split into pattern/runtime halves too. They did not have
 * to be — a deck is a separate BeatSequencer and TS is not taking ownership of the DJ
 * documents — but splitting them keeps ONE code path (every surface subscribes to a pattern
 * topic + a runtime topic), avoids a third hand-mirrored field list, and CUTS push traffic:
 * a transport change now re-pushes the small runtime object instead of the whole ~90-field
 * payload.
 */
export const DJ_META_TOPIC = (deck: number) => `djMeta/${deck}`;
export const DJ_PATTERN_TOPIC = (deck: number, track: number) => `djPattern/${deck}/${track}`;
export const DJ_RUNTIME_TOPIC = (deck: number, track: number) => `djRuntime/${deck}/${track}`;

export const DjUiState = z.object({
  tempoMode: z.enum(["timePitch", "timeStretch", "tempoOnly"]),
  launchQuantize: z.string(), // LaunchQuantize raw: off|1|2|4|8|16|cycle
  xmix: XmixState,
  decks: z.tuple([DjDeckState, DjDeckState, DjDeckState]),
  activeDeckIndex: z.number().int(), // drives the active-deck ring
  modifiersInRows: z.boolean(), // showTrackModifiersInDeckRows
  /**
   * Deck-C PROJECTION (C takes over slot A or B; never a third column, djmode.md
   * §8 Q3). REVISED 2026-07-14: this WAS deliberately view-local in DjPanel
   * (mirroring native's @State), but the C flip button moved into the TRANSPORT
   * strip — a different WKWebView — so both pages must read one truth.
   * DJModeManager.deckCProjectedSlot owns it now (session-lifetime, not
   * persisted, matching the @State spirit). Native's own @State stays untouched
   * (TR-NODELETE; only one surface mounts at a time).
   */
  deckCProjectedSlot: z.enum(["a", "b", "none"]),
  /**
   * Per-DECK "hide the DJ grid" (the GRID toggle, now in the transport deck
   * box). Keyed by DECK, not slot, so it follows C through a projection.
   * Collapses only the DJ view's cells — the compose grid is never hidden.
   */
  gridHidden: z.array(z.boolean()),
  /**
   * Per-DECK perform mode (the PERF toggle in the transport deck box). Keyed
   * by DECK like gridHidden, so it follows C through a projection. When on,
   * the deck grid's pointer input sets the per-track locator repeat window
   * (drag = set + engage, click = disengage) instead of composing.
   * Session-lifetime, not persisted — every launch starts in compose.
   */
  performMode: z.array(z.boolean()),
}).strict();
export type DjUiState = z.infer<typeof DjUiState>;

// ---------------------------------------------------------------------------
// Topic "djBrowser" (P6-04). Spec'd from the LIVE browser —
// `CollapsibleBrowserPanel` (FileBrowserView.swift:733) — NOT from
// DJSessionBrowser.swift, which has zero render sites (djmode.md §3).
//
// Preload stays Swift: DJSessionPreloader parses pattern/kit JSON on a
// background queue so a deck swap is instant mid-set. The web renders its
// progress and sends load INTENTS; it never touches file I/O.
// ---------------------------------------------------------------------------
export const DjSession = z.object({
  path: z.string(), // absolute file URL path — the load intent's identifier
  name: z.string(), // displayName (filename without extension)
  preloaded: z.boolean(), // pattern/kit JSON already parsed → instant load
}).strict();
export type DjSession = z.infer<typeof DjSession>;

export const DjBrowserState = z.object({
  folder: z.string().nullable(), // current playlist folder (null = none chosen)
  sessions: z.array(DjSession),
  isLoading: z.boolean(),
  progress: z.number(), // 0..1 preload progress
  error: z.string().nullable(),
}).strict();
export type DjBrowserState = z.infer<typeof DjBrowserState>;

// ---------------------------------------------------------------------------
// Topic "fileBrowser" (BR-2) — the COMPOSE sample browser, the `.samples` half
// of FileBrowserView.swift that P6-04 left behind when it took the `.sessions`
// half. Layout is single-column + breadcrumb, NOT native's Miller columns
// (browser.md §3): 160px columns inside a 280px rail truncate every filename
// two levels deep, which is a rail-width failure rather than an idiom to keep.
//
// `crumbs` is served rather than derived in the web, because only Swift knows
// where `root` actually is — the path is a security-scoped bookmark's
// resolution, not a string the web may split on "/".
// ---------------------------------------------------------------------------
export const BrowserEntry = z.object({
  path: z.string(), // absolute; the identifier every op takes
  name: z.string(), // display name — with extension, so the format is visible
  isDirectory: z.boolean(),
  sizeBytes: z.number(), // 0 for directories
  modifiedMs: z.number(), // epoch ms; what the "date" sort orders on
}).strict();
export type BrowserEntry = z.infer<typeof BrowserEntry>;

export const BrowserCrumb = z.object({
  path: z.string(),
  name: z.string(),
}).strict();
export type BrowserCrumb = z.infer<typeof BrowserCrumb>;

export const FileBrowserState = z.object({
  root: z.string().nullable(), // chosen folder (null = none yet)
  cwd: z.string().nullable(), // current level; always root or below it
  crumbs: z.array(BrowserCrumb), // root → cwd
  entries: z.array(BrowserEntry), // directories first, then the sort order
  selected: z.string().nullable(), // the selected FILE (a directory never is)
  sort: z.enum(["name", "date"]), // @AppStorage fileBrowserSortOption — ONE owner,
  // shared with the web General settings panel
  autoPlay: z.boolean(), // audition on select
  previewPlaying: z.boolean(), // the audition player's transport
  // The fold. Unlike the DJ browser's (view-local, because it folds INSIDE a
  // full-page webview), this one is shared: the compose browser is its own
  // webview whose FRAME SwiftUI sizes, so a fold the host cannot see would
  // leave a transparent 258px panel sitting over the grid. ⌘B writes it too.
  folded: z.boolean(),
  error: z.string().nullable(),
}).strict();
export type FileBrowserState = z.infer<typeof FileBrowserState>;

// ---------------------------------------------------------------------------
// Topic "capture" (CAP-1) — the recorder, as a mixer CHANNEL (MIXER-CONCEPT:
// "record = a capture channel"). Capture takes the FULL PROGRAM off the native
// engine's main bus — what you hear is what you capture (ToolbarRecorder.swift:6)
// — so this channel is the one SINK in the console: no level, no sends, no M/S,
// and nothing to route out.
//
// Two things are deliberately NOT on this wire:
//   • the live level — it IS the master output level, and `outputPeak` has ridden
//     the HotFrame since P3-01. A second field would be the same number twice.
//   • the elapsed clock — the web derives it from the phase transition. Free.
//
// `waveform` is the 800-point abs-peak envelope (ToolbarRecorder:266). It only
// changes when a take lands, and the topic is pushed DIFFED, so it crosses the
// wire once per take rather than on every tick.
// ---------------------------------------------------------------------------
export const CaptureState = z.object({
  phase: z.enum(["idle", "recording", "recorded"]),
  hasTake: z.boolean(),
  waveform: z.array(z.number()),
  trimStart: z.number(), // 0–1 normalised, as ToolbarRecorder stores it
  trimEnd: z.number(),
  previewPlaying: z.boolean(),
  savedToDisk: z.boolean(), // savedToDiskURL != nil → the "Saved ✓" affordance
  error: z.string().nullable(), // no owner engine / file error
}).strict();
export type CaptureState = z.infer<typeof CaptureState>;

// ---------------------------------------------------------------------------
// MIDI learn (CM-2). UiState topic "midiLearn".
//
// `mapped` is a straight projection of `MIDILearnSystem.mappings`, whose target
// is EITHER a track-agnostic param token OR a concrete singleton learnId — so a
// box looks itself up by (kind, key) and needs no track UUID. `learningKey` +
// `learningTrackIndex` say which control is armed, so exactly ONE box lights up
// while learning even though a token matches every row.
// ---------------------------------------------------------------------------
export const MidiLearnMapping = z.object({
  kind: z.enum(["trackParam", "singleton"]),
  key: z.string(), // token ("volume") or learnId ("master_bpm")
  ccNumber: z.number().int(),
  channel: z.number().int(),
}).strict();
export type MidiLearnMapping = z.infer<typeof MidiLearnMapping>;

export const MidiLearnState = z.object({
  isLearning: z.boolean(),
  learningKind: z.string().nullable(),
  learningKey: z.string().nullable(),
  learningTrackIndex: z.number().int().nullable(),
  mapped: z.array(MidiLearnMapping),
}).strict();
export type MidiLearnState = z.infer<typeof MidiLearnState>;

/**
 * Topic "modulation" (MOD-3) — the ONE home for mod-channel state.
 *
 * Its own topic rather than a slice of "masterfx" because two different webviews consume it: the
 * master-row strip + Mod Lab live in the GRID webview (so they can share a DOM with the sweep
 * bands and the arm rings), while the Master FX panel is a separate webview. One topic, one owner,
 * two consumers — instead of the same state duplicated on two topics and drifting.
 *
 * `armedModChannel` rides here for the same reason: Swift owns the latch, and both webviews must
 * see it, because an arm ring drawn in one webview cannot reach a control in another.
 */
export const ModulationUiState = z.object({
  /**
   * View ▸ Show Modulation System (`showModulationSystem`, default true) — the SAME native toggle
   * that hides master rows 2 & 3. NOT a migration flag.
   *
   * It was a migration flag (`web.panel.modulation`) and that was a bug: `MasterTrackRowView` (and
   * so the native mod strip) lives inside `TrackListView`, which is the ELSE branch of the web
   * grid. With the web grid on, the native strip is not rendered — so a second flag defaulting to
   * off meant NO modulation UI anywhere. `web.panel.grid` is already the A/B switch for this whole
   * row; modulation rides it, and this is just the show/hide the user already knows.
   */
  visible: z.boolean(),
  channels: z.array(ModChannelState), // M1..M4, already resolved (see ModChannelState)
  armedModChannel: z.number().int().nullable(), // 0…3 while arm-to-map is latched
  trackNames: z.array(z.string()), // for the trigger/follower source pickers — index-aligned
  maxRoutingsPerTrack: z.number().int(), // Track.kMaxModRoutingsPerTrack — the web must refuse at the cap
  lcmSteps: z.number().int(), // current pattern LCM in steps — the "LCM (32)" caption for LCM mode
}).strict();
export type ModulationUiState = z.infer<typeof ModulationUiState>;

