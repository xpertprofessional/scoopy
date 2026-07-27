/**
 * PatternFile model in TS (P5-06b) — the full session-file format, typed.
 *
 * THE FLIP's hard gate (P5-06) is a byte-stable round-trip: decode a session
 * Swift wrote → re-encode → identical bytes. The encoder kernel
 * (`foundationJson.ts`, P5-06a) proved byte-identity is achievable; what it
 * cannot know is WHICH fields are Swift `Float` (invisible in the JSON) and
 * which keys Swift accepts on decode but never re-encodes. That knowledge is
 * this file. Every table below was extracted field-by-field from the Swift
 * source (file:line cited per struct) — do not "fix" a type here without
 * checking the Swift declaration; a Float marked Double corrupts bytes.
 *
 * ONE TABLE PER STRUCT drives everything: the zod schema (strict — an
 * unmodeled key fails loudly instead of silently corrupting a re-encode), the
 * FLOAT32_PATHS / DICT_PATHS sets for the encoder, float narrowing on decode
 * (`Math.fround`, so an EDITED value re-encodes at float32 precision), and
 * decode-only stripping on encode. Never hand-maintain those views separately.
 *
 * Contract boundaries, decided deliberately:
 *
 * - **Target form = the canonical encoder** (`[.prettyPrinted, .sortedKeys]`,
 *   `PersistenceService.savePattern`, :22). NOTE: `saveSession`'s pattern.json
 *   (PersistenceService:171) uses a PLAIN JSONEncoder — compact, unspecified
 *   key order. Byte-identity against that form is impossible for ANY encoder;
 *   after the flip TS writes the canonical form, which Swift decodes fine.
 *
 * - **Decode-only keys** (Swift decodes them, never re-encodes): top-level
 *   `settingsSceneA/B`, `patternToSettingsMapping`, `return1/2GateSceneA–H`
 *   (PatternFile.swift:553–577); `bufferFxRate/Pitch` on return settings
 *   (ReturnTrack.swift:792); `playThroughSteps`/`preCachedWaveform` on Track
 *   (SequencerState.swift:607/691/870). They parse, then strip on encode —
 *   exactly what a Swift re-save does.
 *
 * - **Conditional encodes**: `SettingsSceneData.scene2ActiveOverrides` is
 *   omitted when EMPTY (SequencerState.swift:3313), not just when nil — the
 *   only `if !isEmpty` in the whole format.
 *
 * - **Swift decode MIGRATIONS live in `migrations.ts`** (P5-06c), not here. This
 *   model stays STRICT against what the CURRENT encoder writes
 *   (`PatternFile.currentSchemaVersion` = 26) — that is the format TS will own.
 *   A pre-26 session is normalized by `migratePatternFile()` first, then decoded
 *   by this model. Correction to an earlier note here: missing `trackGain` falls
 *   back to the CONSTANT 1.0, **not** to `volume` (SequencerState.swift:552 says
 *   so explicitly). The real value-dependent migrations are enumerated in
 *   migrations.ts and pinned byte-for-byte against Swift's own decoder.
 *
 * - Scalars ride through as-is: UUID/Data(base64) are strings; enums are bare
 *   raw values (Int enums numbers — incl. LfoClockDivision's non-sequential
 *   1000s/2000s raws — and `voiceMode`/`toneFilterMode`/`midiSyncMode`/
 *   `midiSlaveTransportPolicy`/`curve` strings). `MIDIMapping.learnId` IS
 *   always re-encoded (a value derived from `target`, MIDILearnSystem.swift
 *   :158–169); on an untouched round-trip the stored string already equals the
 *   derivation, so it passes through. An editor changing `target` must
 *   re-derive it.
 */

import { z } from "zod";
import { encodeFoundationJSON } from "./foundationJson.ts";

// ---------- field-spec mini-language ----------

export type Spec =
  | { k: "float" }
  | { k: "double" }
  | { k: "int" }
  | { k: "bool" }
  | { k: "string" }
  | { k: "array"; of: Spec }
  | { k: "dict"; of: Spec }
  | { k: "struct"; fields: StructFields }
  | { k: "raw"; zod: z.ZodTypeAny }; // opaque subtree — no floats inside

export interface Field {
  spec: Spec;
  /** Swift optional (`encodeIfPresent` / `if let`) — key absent when nil. */
  optional?: boolean;
  /** Accepted on decode (legacy sessions) but NEVER re-encoded. */
  decodeOnly?: boolean;
  /** Swift wraps the encode in `if !x.isEmpty` — empty container omitted. */
  omitWhenEmpty?: boolean;
}
export type StructFields = Record<string, Field>;

export const F: Spec = { k: "float" };
export const D: Spec = { k: "double" };
export const I: Spec = { k: "int" };
export const B: Spec = { k: "bool" };
export const S: Spec = { k: "string" };
export const arr = (of: Spec): Spec => ({ k: "array", of });
export const dict = (of: Spec): Spec => ({ k: "dict", of });
export const st = (fields: StructFields): Spec => ({ k: "struct", fields });
export const req = (spec: Spec): Field => ({ spec });
export const opt = (spec: Spec): Field => ({ spec, optional: true });
const legacy = (spec: Spec): Field => ({ spec, optional: true, decodeOnly: true });

// ---------- leaf structs ----------

/** Track.ModRouting — Track.swift:759, synthesized. */
const PORTABLE_PLUGIN_REF = st({
  manufacturer: req(S),
  name: req(S),
  version: req(S),
  au: opt(S),
  vst3: opt(S),
  clap: opt(S),
});
const MOD_ROUTING = st({ channelIndex: req(I), target: req(I) });

/** EnvelopeNode / BreakpointEnvelope — ModulationModel.swift:57/75, synthesized. */
const ENVELOPE_NODE = st({ timeMs: req(D), value: req(D), curve: req(D) });
const BREAKPOINT_ENVELOPE = st({
  nodes: req(arr(ENVELOPE_NODE)),
  sustainNodeIndex: req(I),
  bipolar: req(B),
  // MOD-10 macro (ModulationModel.swift:85). Double, non-optional → Swift ALWAYS writes it.
  ease: req(D),
  tempoSync: req(B),
});

/** ModChannel — ModulationModel.swift:116 (custom decode, synthesized encode). */
const MOD_CHANNEL = st({
  type: req(I),
  lfoWaveform: req(I),
  // LFO-DIV rework: cycle steps + speed ratio + LCM toggle (was lfoRate/lfoSync/lfoDivision).
  lfoCycleSteps: req(I),
  lfoCycleRatio: req(D),
  lfoLcmMode: req(B),
  lfoPhaseOffset: req(D),
  lfoSymmetry: req(D),
  lfoSmooth: req(D),
  depth: req(D),
  followerSourceTrackId: opt(S), // UUID
  followerGain: req(F),
  followerAttack: req(F),
  followerRelease: req(F),
  envelope: req(BREAKPOINT_ENVELOPE),
  triggerSourceTrackId: opt(S), // UUID
  // MOD-10 LFO shape macros (ModulationModel.swift:144-150). All Double — NOT Float — and
  // non-optional, so Swift always writes them. Swift decodes them with `decodeIfPresent`
  // + a per-waveform preset fallback, so an OLD file lacking them still opens; but once
  // opened it is re-encoded WITH them, which is why the migration layer must add them too.
  lfoSlant: req(D),
  lfoEase: req(D),
  lfoJitter: req(D),
  lfoCyclic: req(D),
  // MOD-11 SHAPES macros + stage layer (ModulationModel.swift). CONDITIONALLY encoded — Swift writes
  // each key only when it is off its identity value, so an untouched channel omits them entirely and
  // re-encodes byte-for-byte. Hence `opt` here (unlike the always-written MOD-10 macros above).
  lfoWarp: opt(D),
  lfoCurve: opt(D),
  lfoFold: opt(D),
  lfoQuant: opt(D),
  lfoChaos: opt(D),
  lfoStageCount: opt(I), // paired with lfoStageLevels (both written or both omitted)
  lfoStageLevels: opt(arr(D)),
  lfoStageGlide: opt(D),
});

/** SpectralSettings / SpectralChannelSettings — ModulationModel.swift:228/250. */
const SPECTRAL_SETTINGS = st({ texture: req(D), chaos: req(D), airDb: req(D) });
const SPECTRAL_CHANNEL = st({
  enabled: req(B),
  wetLevel: req(D),
  texture: req(D),
  shiftHz: req(D),
  alpha: req(D),
  pivotHz: req(D),
  blur: req(D),
  chaos: req(D),
  formantSemis: req(D),
  tilt: req(D),
  tempoSnap: req(I),
  modDepth: req(D),
  modRiseSecs: req(D),
  xmodAmount: req(D),
});

/**
 * MIDIMapping.target — MIDILearnSystem.swift:25, Swift's synthesized
 * enum-with-payload form: one key naming the case, payload keyed inside.
 */
const MAPPING_TARGET: Spec = {
  k: "raw",
  zod: z.union([
    z.object({ trackParam: z.object({ token: z.string() }).strict() }).strict(),
    z.object({ singleton: z.object({ learnId: z.string() }).strict() }).strict(),
  ]),
};

/** MIDIMapping — MIDILearnSystem.swift:107 (custom encode :158). */
const MIDI_MAPPING = st({
  id: req(S), // UUID
  target: req(MAPPING_TARGET),
  ccNumber: req(I),
  channel: req(I),
  minValue: req(D),
  maxValue: req(D),
  curve: req(S), // "Linear" | "Exponential" | "Logarithmic" | "S-Curve"
  inverted: req(B),
  learnId: req(S), // ALWAYS re-encoded; derived from target at write time
  scope: legacy({ k: "raw", zod: z.unknown() }), // dead CodingKey — never written
});

/** SequencerState.Track — SequencerState.swift:64 (encode :761–933). */
const TRACK = st({
  id: req(S), // UUID
  steps: req(arr(B)),
  pitchOffsets: req(arr(D)),
  volume: req(F),
  trackGain: opt(F),
  pan: req(F),
  isMono: req(B),
  stereoMode: req(I),
  outputAssign: req(I),
  sampleId: opt(S), // UUID
  originalSamplePath: opt(S),
  originalSampleFolderBookmark: opt(S), // Data → base64 string
  isMuted: req(B),
  isStopped: req(B),
  tuning: req(I),
  globalPitchOffset: req(I),
  globalFineTuneCents: req(I),
  transposeOffset: req(I),
  fineTuneCents: req(I),
  playbackDirection: req(I),
  isPaused: req(B),
  randomize: req(B),
  speedMultiplier: req(D),
  // Per-track ⟳ reset ratio. CONDITIONAL: Swift encodes it only when != 1.0
  // (SequencerState.Track/PatternData encode), so the default never bloats a
  // track and every pre-v71 fixture stays byte-identical. `opt` mirrors that —
  // absent key ⇒ default 1.0 at read (deriveTrackState `num(t.rateLockRatio, 1)`),
  // present key ⇒ re-encoded. A file never carries an explicit 1.0, so the two
  // encoders can never disagree.
  rateLockRatio: opt(D),
  speedMode: req(I),
  pitchSyncMode: req(B), // computed in Swift (= speedMode == .timeAndPitch)
  melodicPitchMode: req(B),
  preserveFormants: req(B),
  isStretchByLength: req(B),
  playbackMode: req(I),
  ownerModeGate: req(F),
  ownerModeAttack: req(F),
  phaseResetStep: req(I),
  patternStartStep: req(I),
  chokeGroup: req(I), // UInt8
  voiceMode: req(S), // "mono" | "poly"
  accentLevels: req(arr(I)),
  cellLengths: req(arr(I)),
  fullReleaseSteps: req(arr(B)),
  fullReleaseAutoExtend: req(arr(B)),
  wrapSourceStep: opt(I),
  locatorStartStep: req(I),
  locatorEndStep: req(I),
  locatorRepeatActive: req(B),
  lfoPitchDepth: req(F),
  lfoFilterDepth: req(F),
  lfoVolumeDepth: req(F),
  lfoPanDepth: req(F),
  lfo2PitchDepth: req(F),
  lfo2FilterDepth: req(F),
  lfo2VolumeDepth: req(F),
  lfo2PanDepth: req(F),
  lfoStartDepth: req(F),
  lfoEndDepth: req(F),
  lfo2StartDepth: req(F),
  lfo2EndDepth: req(F),
  lfoGainDepth: req(F),
  lfo2GainDepth: req(F),
  lfo3PitchDepth: req(F),
  lfo3FilterDepth: req(F),
  lfo3VolumeDepth: req(F),
  lfo3PanDepth: req(F),
  lfo3GainDepth: req(F),
  lfo4PitchDepth: req(F),
  lfo4FilterDepth: req(F),
  lfo4VolumeDepth: req(F),
  lfo4PanDepth: req(F),
  lfo4GainDepth: req(F),
  lfo1VolumeTarget: req(I),
  lfo2VolumeTarget: req(I),
  lfo1ModifierTargets: req(arr(I)),
  lfo1ModifierAmounts: req(arr(D)),
  lfo2ModifierTargets: req(arr(I)),
  lfo2ModifierAmounts: req(arr(D)),
  lfo3ModifierTargets: req(arr(I)),
  lfo3ModifierAmounts: req(arr(D)),
  lfo4ModifierTargets: req(arr(I)),
  lfo4ModifierAmounts: req(arr(D)),
  modRoutings: req(arr(MOD_ROUTING)),
  send1Level: req(F),
  send2Level: req(F),
  send3Level: req(F),
  send4Level: req(F),
  glidePercentBetweenSteps: req(D),
  tone: req(F),
  toneFilterMode: req(S), // "tone"|"lowPass"|"highPass"|"bandPass"|"notch"
  toneQ: req(F),
  filterDrive: req(F),
  fadeCurve: req(D),
  sampleStartMs: req(D),
  sampleEndMs: req(D),
  loopStartMs: req(D),
  loopEndMs: req(D),
  loopCrossfadeMs: req(D),
  loopEnabled: req(B),
  stretchEnabled: req(B),
  stretchTimeOnly: req(B),
  sampleDurationMs: req(D),
  samplePeakGain: req(F),
  rhythmicOffset: req(I),
  preSilenceMs: req(D),
  swingAmount: req(D),
  attackPercent: req(D),
  releasePercent: req(D),
  isReversed: req(B),
  reverseSteps: req(arr(B)),
  glideSteps: req(arr(B)),
  humanize: req(F),
  sampleStartMsOffsets: req(arr(D)),
  sampleEndMsOffsets: req(arr(D)),
  volumeOffsets: req(arr(F)),
  mixVolumeOffsets: req(arr(F)),
  panOffsets: req(arr(F)),
  toneOffsets: req(arr(F)),
  send1Offsets: req(arr(F)),
  send2Offsets: req(arr(F)),
  send3Offsets: req(arr(F)),
  send4Offsets: req(arr(F)),
  rhythmicOffsetSteps: req(arr(I)),
  flamCounts: req(arr(I)),
  chordIndices: req(arr(I)), // schema 26
  freeRateEnabled: req(B),
  freeRate: req(D),
  grainModeEnabled: req(B),
  grainRateMode: req(I),
  grainRateHz: req(D),
  grainSyncRatio: req(D),
  grainLengthMs: req(D),
  grainWindow: req(I),
  grainScanPosition: req(D),
  grainScanSpeed: req(D),
  grainPitchSemitones: req(D),
  grainRandomize: req(D),
  grainKeyTrack: req(B),
  preSilenceMsOffsets: req(arr(D)),
  // Swift [Int: X] dictionaries — JSON objects with stringified-int keys.
  storedExtensionPitchOffsets: req(dict(D)),
  storedExtensionVolumeOffsets: req(dict(F)),
  storedExtensionMixVolumeOffsets: req(dict(F)),
  storedExtensionPanOffsets: req(dict(F)),
  storedExtensionSampleStartMsOffsets: req(dict(D)),
  storedExtensionSampleEndMsOffsets: req(dict(D)),
  storedExtensionToneOffsets: req(dict(F)),
  storedExtensionReverseSteps: req(dict(B)),
  storedOwnerModeCellLengths: req(dict(I)),
  trackType: req(I),
  midiNotes: req(arr(I)), // [UInt8]
  midiVelocities: req(arr(I)), // [UInt8]
  midiPitchBends: req(arr(I)),
  midiChannel: req(I), // UInt8
  midiVelocity: req(I), // UInt8
  midiRootNote: req(I), // UInt8
  midiGatePercent: req(D), // schema 27 — % of a cell a generated note sustains
  instrumentOutEnabled: req(B), // schema 28 — the INST output
  midiOutEnabled: req(B), // schema 27/28 — the MIDI output
  midiInputChannel: req(I), // UInt8
  midiDisplayMode: req(I),
  instrumentPluginIdentifier: opt(S),
  instrumentPluginName: opt(S),
  instrumentPluginStateBase64: opt(S),
  // Schema 32 (XP-0b-1): format-agnostic plugin identity + per-format id hints, so a session
  // bound to an AU on macOS can resolve the same plugin's VST3/CLAP on another shell. Swift
  // encodeIfPresent-s it, so a track with no instrument omits the key entirely.
  instrumentPluginRef: opt(PORTABLE_PLUGIN_REF),
  chopPoints: req(arr(D)), // always 8 elements
  chopCount: req(I),
  cellChopIndices: req(arr(I)),
  defaultChopIndex: req(I),
  // Decode-only (SequencerState.swift:607 migration source / :691+:870 dropped):
  playThroughSteps: legacy(arr(B)),
  preCachedWaveform: legacy(arr(F)),
  // Phantom CodingKeys (:349) — no property, never decoded, never encoded:
  send1Parameters: legacy({ k: "raw", zod: z.unknown() }),
  send2Parameters: legacy({ k: "raw", zod: z.unknown() }),
});

/** TrackSettings — SequencerState.swift:2540 (encode :2958–3037). */
const TRACK_SETTINGS = st({
  volume: req(F),
  pan: req(F),
  stereoMode: req(I),
  globalPitchOffset: req(I),
  globalFineTuneCents: req(I),
  transposeOffset: req(I),
  fineTuneCents: req(I),
  lfoPitchDepth: req(F),
  lfoFilterDepth: req(F),
  lfoVolumeDepth: req(F),
  lfoPanDepth: req(F),
  lfo2PitchDepth: req(F),
  lfo2FilterDepth: req(F),
  lfo2VolumeDepth: req(F),
  lfo2PanDepth: req(F),
  lfo1VolumeTarget: req(I),
  lfo2VolumeTarget: req(I),
  lfo1ModifierTargets: req(arr(I)),
  lfo1ModifierAmounts: req(arr(D)),
  lfo2ModifierTargets: req(arr(I)),
  lfo2ModifierAmounts: req(arr(D)),
  lfoStartDepth: req(F),
  lfoEndDepth: req(F),
  lfo2StartDepth: req(F),
  lfo2EndDepth: req(F),
  lfoGainDepth: req(F),
  lfo2GainDepth: req(F),
  lfo3PitchDepth: req(F),
  lfo3FilterDepth: req(F),
  lfo3VolumeDepth: req(F),
  lfo3PanDepth: req(F),
  lfo3GainDepth: req(F),
  lfo4PitchDepth: req(F),
  lfo4FilterDepth: req(F),
  lfo4VolumeDepth: req(F),
  lfo4PanDepth: req(F),
  lfo4GainDepth: req(F),
  lfo3ModifierTargets: req(arr(I)),
  lfo3ModifierAmounts: req(arr(D)),
  lfo4ModifierTargets: req(arr(I)),
  lfo4ModifierAmounts: req(arr(D)),
  modRoutings: req(arr(MOD_ROUTING)),
  send1Level: req(F),
  send2Level: req(F),
  send3Level: req(F),
  send4Level: req(F),
  tone: req(F),
  toneFilterMode: req(S),
  toneQ: req(F),
  filterDrive: req(F),
  fadeCurve: req(D),
  sampleStartMs: req(D),
  sampleEndMs: req(D),
  loopStartMs: req(D),
  loopEndMs: req(D),
  loopCrossfadeMs: req(D),
  isReversed: req(B),
  isStretchByLength: req(B), // computed over playbackMode in Swift
  playbackMode: req(I),
  ownerModeGate: req(F),
  ownerModeAttack: req(F),
  loopEnabled: req(B),
  stretchEnabled: req(B),
  stretchTimeOnly: req(B),
  reverseSteps: req(arr(B)),
  glideSteps: req(arr(B)),
  transposeEnabled: req(B),
  chokeGroup: req(I), // UInt8
  voiceMode: req(S),
  trackGain: opt(F),
  trackGainWasDecoded: req(B),
  colorHex: opt(S),
  colorWasDecoded: req(B),
  chopPoints: req(arr(D)),
  chopCount: req(I),
  defaultChopIndex: req(I),
  customName: opt(S),
  melodicPitchMode: req(B),
});

/** ReturnEffectSettings — ReturnTrack.swift:540 (synthesized encode). */
const RETURN_EFFECT_SETTINGS = st({
  delayTimeMs: req(F),
  delayFeedback: req(F),
  delayMix: req(F),
  delayWetLevel: req(F),
  delayDryLevel: req(F),
  delayHighCut: req(F),
  delaySyncEnabled: req(B),
  delaySyncDivision: req(I), // custom Codable, bare rawValue Int
  lfoTimeDepth: req(F),
  lfo2TimeDepth: req(F),
  timeModRange: req(F),
  stereoWidth: req(F),
  volume: req(F),
  pan: req(F),
  effectBypassed: req(B),
  lfoVolumeDepth: req(F),
  lfo2VolumeDepth: req(F),
  lfoPanDepth: req(F),
  lfo2PanDepth: req(F),
  lfo1VolumeTarget: req(I),
  lfo2VolumeTarget: req(I),
});

/** ReturnTrackSettings — ReturnTrack.swift:650 (custom encode :796). */
const RETURN_TRACK_SETTINGS = st({
  id: req(S), // UUID
  name: req(S),
  volume: req(F),
  gain: req(F),
  pan: req(F),
  isMuted: req(B),
  effectBypassed: req(B),
  delayTimeMs: req(F),
  delayFeedback: req(F),
  delayMix: req(F),
  delayWetLevel: req(F),
  delayDryLevel: req(F),
  delayHighCut: req(F),
  delaySyncEnabled: req(B),
  delaySyncDivision: req(I),
  lfoTimeDepth: req(F),
  lfo2TimeDepth: req(F),
  timeModRange: req(F),
  stereoWidth: req(F),
  lfoVolumeDepth: req(F),
  lfo2VolumeDepth: req(F),
  lfoPanDepth: req(F),
  lfo2PanDepth: req(F),
  lfo1VolumeTarget: req(I),
  lfo2VolumeTarget: req(I),
  gateEnabled: req(B),
  gateStepCount: req(I),
  gateSteps: req(arr(B)),
  gateMode: req(I),
  bufferFxEnabled: req(B),
  bufferFxStepCount: req(I),
  bufferFxTypes: req(arr(I)),
  bufferFxRates: req(arr(F)),
  bufferFxPitches: req(arr(F)),
  bufferFxCellLengths: req(arr(I)),
  // Legacy scalars, superseded by the arrays (ReturnTrack.swift:776/792):
  bufferFxRate: legacy(F),
  bufferFxPitch: legacy(F),
});

/** ReturnGateSequenceData — ReturnTrack.swift:488. Only reachable via the
 *  decode-only return1/2GateScene* keys, so the whole struct is legacy input. */
const RETURN_GATE_SEQUENCE = st({
  gateEnabled: req(B),
  gateStepCount: req(I),
  gateSteps: req(arr(B)),
  gateMode: req(I),
});

/** SettingsSceneData — SequencerState.swift:3049 (custom encode :3264). */
const SETTINGS_SCENE_DATA = st({
  bpm: req(D),
  masterVolume: req(F),
  sp12Mode: req(B),
  masterClipperDrive: req(F),
  masterClipperThreshold: req(F),
  masterClipperSoftness: req(F),
  accentSteps: req(arr(I)),
  masterSpeedPercent: req(D),
  speedPitchOnly: req(B),
  varispeedMode: opt(I), // `if let` (:3275)
  fadeCurve: req(D),
  reverseTransportEnabled: req(B),
  transposeEnabled: req(B),
  trackSettings: req(arr(TRACK_SETTINGS)),
  return1EffectSettings: opt(RETURN_EFFECT_SETTINGS), // `if let` (:3283)
  return2EffectSettings: opt(RETURN_EFFECT_SETTINGS), // `if let` (:3286)
  lfoRate: req(D),
  lfoWaveform: req(I),
  lfo2Rate: req(D),
  lfo2Waveform: req(I),
  lfoCycleSteps: req(I),
  lfoCycleRatio: req(D),
  lfoLcmMode: req(B),
  lfo2CycleSteps: req(I),
  lfo2CycleRatio: req(D),
  lfo2LcmMode: req(B),
  lfoPitchAmount: req(D),
  lfoToneAmount: req(D),
  lfoSampleAmount: req(D),
  lfoEnvelopeSourceTrack: opt(I),
  lfo2EnvelopeSourceTrack: opt(I),
  lfoEnvelopeInvert: req(B),
  lfo2EnvelopeInvert: req(B),
  lfoEnvelopeGain: req(F),
  lfo2EnvelopeGain: req(F),
  lfoSmooth: req(F),
  lfoEnvelopeAttack: req(F),
  lfoEnvelopeRelease: req(F),
  lfo2Smooth: req(F),
  lfo2EnvelopeAttack: req(F),
  lfo2EnvelopeRelease: req(F),
  // Set<String> → array; Swift emits it only when non-empty (:3313–3315).
  scene2ActiveOverrides: { spec: arr(S), optional: true, omitWhenEmpty: true },
});

/** SceneSettingsLayer — SequencerState.swift:3044, synthesized. */
const SCENE_SETTINGS_LAYER = st({
  values: req(SETTINGS_SCENE_DATA),
  pinnedKeys: req(arr(S)), // Set<String> → array (unordered)
});

/** VintageImportSnapshot — AudioImportSettings.swift:243, synthesized. */
const VINTAGE_IMPORT_SNAPSHOT = st({
  enabled: req(B),
  preset: req(S),
  sampleRate: req(S),
  bitDepth: req(S),
  quantMode: req(S),
  ditherType: req(S),
  filterType: req(S),
  filterCutoffRatio: req(F),
  aliasCharacter: req(F),
  driveDb: req(F),
  outputFilterType: req(S),
  outputCutoffRatio: req(F),
  outputResonance: req(F),
  outputTrimDb: req(F),
  normalizationMode: req(S),
  preGain: req(F),
});

// ---------- PatternFile top level (PatternFile.swift:9, encode :488–584) ----------

const PATTERN_FILE = st({
  schemaVersion: req(I),
  bpm: req(D),
  swing: req(D),
  masterVolume: req(F),
  sp12Mode: req(B),
  lfoRate: req(D),
  lfoWaveform: req(I),
  lfo2Rate: req(D),
  lfo2Waveform: req(I),
  masterClipperDrive: req(F),
  masterClipperThreshold: req(F),
  masterClipperSoftness: req(F),
  masterClipperCurve: req(I), // UInt8
  masterClipperCeiling: req(F),
  masterClipperOversample: req(I), // UInt8
  masterClipperDecoupled: req(B),
  lfoCycleSteps: req(I),
  lfoCycleRatio: req(D),
  lfoLcmMode: req(B),
  lfo2CycleSteps: req(I),
  lfo2CycleRatio: req(D),
  lfo2LcmMode: req(B),
  lfoPitchAmount: req(D),
  lfoToneAmount: req(D),
  lfoSampleAmount: req(D),
  lfoEnvelopeSourceTrack: opt(I),
  lfoEnvelopeInvert: req(B),
  lfoEnvelopeGain: req(F),
  lfoSmooth: req(F),
  lfo2EnvelopeSourceTrack: opt(I),
  lfo2EnvelopeInvert: req(B),
  lfo2EnvelopeGain: req(F),
  lfo2Smooth: req(F),
  modChannels: req(arr(MOD_CHANNEL)),
  modChannelTriggerIndices: req(arr(I)),
  modChannelFollowerIndices: req(arr(I)),
  spectral: opt(SPECTRAL_SETTINGS),
  spectralChannels: opt(arr(SPECTRAL_CHANNEL)),
  accentSteps: req(arr(I)),
  masterSpeed: req(D),
  speedPitchOnly: req(B),
  varispeedMode: opt(I), // `if let` (:533)
  transposeEnabled: req(B),
  midiMappings: req(arr(MIDI_MAPPING)),
  midiEnabled: req(B),
  midiSelectedDeviceId: req(I), // Int32
  midiClockInputDeviceId: req(I), // Int32
  midiClockOutputDestinationId: req(I), // Int32
  midiSyncMode: req(S), // "internalMaster" | "externalSlave"
  midiSlaveTransportPolicy: req(S), // "fullTransport" | "tempoAndPhaseOnly"
  sectionA: req(arr(TRACK)),
  sectionB: req(arr(TRACK)),
  sectionC: req(arr(TRACK)),
  sectionD: req(arr(TRACK)),
  sectionE: req(arr(TRACK)),
  sectionF: req(arr(TRACK)),
  sectionG: req(arr(TRACK)),
  sectionH: req(arr(TRACK)),
  // Schema ≤23 two-scene system — decode-only migration inputs (:553–554):
  settingsSceneA: legacy(SETTINGS_SCENE_DATA),
  settingsSceneB: legacy(SETTINGS_SCENE_DATA),
  patternToSettingsMapping: legacy(dict(S)),
  // Schema 24+ layered settings:
  baseSettings: opt(SETTINGS_SCENE_DATA),
  sceneSettingsLayers: opt(dict(SCENE_SETTINGS_LAYER)),
  muteGroupMembers: opt(arr(S)),
  muteGroupMemberIndices: opt(arr(I)),
  // Schema 31 (XP-0b-2): THIS deck's four deck-master -> FX send levels. Written by Swift only
  // when a send is up (PatternFile.swift encode), so a console-untouched session omits it.
  deckMasterSendRow: opt(arr(F)),
  returnTrack1: opt(RETURN_TRACK_SETTINGS),
  returnTrack2: opt(RETURN_TRACK_SETTINGS),
  // Per-scene gate data — decoded for old sessions, never re-encoded (:576):
  return1GateSceneA: legacy(RETURN_GATE_SEQUENCE),
  return1GateSceneB: legacy(RETURN_GATE_SEQUENCE),
  return1GateSceneC: legacy(RETURN_GATE_SEQUENCE),
  return1GateSceneD: legacy(RETURN_GATE_SEQUENCE),
  return1GateSceneE: legacy(RETURN_GATE_SEQUENCE),
  return1GateSceneF: legacy(RETURN_GATE_SEQUENCE),
  return1GateSceneG: legacy(RETURN_GATE_SEQUENCE),
  return1GateSceneH: legacy(RETURN_GATE_SEQUENCE),
  return2GateSceneA: legacy(RETURN_GATE_SEQUENCE),
  return2GateSceneB: legacy(RETURN_GATE_SEQUENCE),
  return2GateSceneC: legacy(RETURN_GATE_SEQUENCE),
  return2GateSceneD: legacy(RETURN_GATE_SEQUENCE),
  return2GateSceneE: legacy(RETURN_GATE_SEQUENCE),
  return2GateSceneF: legacy(RETURN_GATE_SEQUENCE),
  return2GateSceneG: legacy(RETURN_GATE_SEQUENCE),
  return2GateSceneH: legacy(RETURN_GATE_SEQUENCE),
  enabledSceneCount: opt(I),
  sessionBackgroundColorHex: opt(S),
  sessionBackgroundImageFileName: opt(S),
  sessionBackgroundImageOpacity: opt(D),
  sessionBackgroundImageMode: opt(S),
  vintageImport: opt(VINTAGE_IMPORT_SNAPSHOT),
});

// ---------- derived views (never hand-maintain these) ----------

export function zodOf(spec: Spec): z.ZodTypeAny {
  switch (spec.k) {
    case "float":
    case "double":
      return z.number();
    case "int":
      return z.number().int();
    case "bool":
      return z.boolean();
    case "string":
      return z.string();
    case "array":
      return z.array(zodOf(spec.of));
    case "dict":
      return z.record(z.string(), zodOf(spec.of));
    case "struct": {
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, field] of Object.entries(spec.fields)) {
        const base = zodOf(field.spec);
        shape[key] = field.optional || field.decodeOnly ? base.optional() : base;
      }
      return z.object(shape).strict();
    }
    case "raw":
      return spec.zod;
  }
}

export function collectPaths(spec: Spec, path: string, float32: Set<string>, dicts: Set<string>): void {
  switch (spec.k) {
    case "float":
      float32.add(path);
      return;
    case "array":
      collectPaths(spec.of, `${path}[]`, float32, dicts);
      return;
    case "dict":
      dicts.add(path);
      collectPaths(spec.of, `${path}.{}`, float32, dicts);
      return;
    case "struct":
      for (const [key, field] of Object.entries(spec.fields)) {
        if (field.decodeOnly) continue; // never reaches the encoder
        collectPaths(field.spec, path ? `${path}.${key}` : key, float32, dicts);
      }
      return;
    default:
      return;
  }
}

/** Narrow every Float field to float32 so later EDITS re-encode at Swift's
 *  precision (an untouched value already round-trips — see foundationJson). */
export function narrowFloats(value: unknown, spec: Spec): unknown {
  if (value === undefined || value === null) return value;
  switch (spec.k) {
    case "float":
      return Math.fround(value as number);
    case "array":
      return (value as unknown[]).map((v) => narrowFloats(v, spec.of));
    case "dict": {
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src)) out[k] = narrowFloats(src[k], spec.of);
      return out;
    }
    case "struct": {
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(spec.fields)) {
        if (src[key] !== undefined) out[key] = narrowFloats(src[key], field.spec);
      }
      return out;
    }
    default:
      return value;
  }
}

/** Reproduce the encode-side asymmetry: drop decode-only keys everywhere and
 *  the `if !isEmpty`-guarded containers when empty — what a Swift re-save does. */
export function stripForEncode(value: unknown, spec: Spec): unknown {
  if (value === undefined || value === null) return value;
  switch (spec.k) {
    case "array":
      return (value as unknown[]).map((v) => stripForEncode(v, spec.of));
    case "dict": {
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(src)) out[k] = stripForEncode(src[k], spec.of);
      return out;
    }
    case "struct": {
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(spec.fields)) {
        if (field.decodeOnly) continue;
        const v = src[key];
        if (v === undefined) continue;
        if (field.omitWhenEmpty && Array.isArray(v) && v.length === 0) continue;
        out[key] = stripForEncode(v, field.spec);
      }
      return out;
    }
    default:
      return value;
  }
}

const FLOAT32 = new Set<string>();
const DICTS = new Set<string>();
collectPaths(PATTERN_FILE, "", FLOAT32, DICTS);

/** Paths (`a.b[].c` / `a.{}.b`) whose numbers are Swift `Float`. */
export const FLOAT32_PATHS: ReadonlySet<string> = FLOAT32;
/** Paths whose object is a Swift dictionary (children collapse to `{}`). */
export const DICT_PATHS: ReadonlySet<string> = DICTS;

/** Strict zod model of the current on-disk format (schemaVersion 26). */
export const PatternFileSchema = zodOf(PATTERN_FILE) as z.ZodType<PatternFileJson>;
export type PatternFileJson = Record<string, unknown>; // structure enforced by the schema

/**
 * Decode a session file the CURRENT Swift encoder wrote. Strict: an unmodeled
 * key or wrong type throws (never silently drop data that would then be lost
 * on re-encode). Pre-current-schema sessions need the P5-06 migration layer.
 */
export function decodePatternFile(text: string): PatternFileJson {
  const parsed = PatternFileSchema.parse(JSON.parse(text));
  return narrowFloats(parsed, PATTERN_FILE) as PatternFileJson;
}

/**
 * Re-encode exactly as `PersistenceService.savePattern` does — Foundation's
 * `[.prettyPrinted, .sortedKeys]` bytes, decode-only keys dropped.
 */
export function encodePatternFile(file: PatternFileJson): string {
  return encodeFoundationJSON(stripForEncode(file, PATTERN_FILE), {
    float32Paths: FLOAT32_PATHS,
    dictPaths: DICT_PATHS,
  });
}
