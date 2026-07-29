/**
 * The converter that did not exist — a SESSION becomes something the engine can play.
 *
 * Two halves of Phase 8 have been staring at each other across a gap since P8-2:
 *
 *   • the ENGINE runs in WASM, is driven by JavaScript over a C ABI, and is bit-identical to native
 *     (P8-1/P8-2/P8-3b). It takes a `World`: flat, per-track, `sampleId` + `steps`.
 *   • a SESSION opens from OPFS as `{ pattern: PatternFileJson, kit: KitJson }` (P8-0/P8-6). It is
 *     the document: 8 scene sections, ~90 fields per track, sample identity in the kit.
 *
 * Nothing joined them. `ScoopyAudio.registerSample()` had no producer until P8-6 built the sample
 * store, and even then nothing built a `World` — so the companion could open a session, browse its
 * samples and audition them one at a time, and could not play the session. This is that join.
 *
 * ⚠️ THE DOCUMENT HAS NO `tracks` FIELD. It has `sectionA` … `sectionH` — the pattern-scene system.
 * **`sectionA` is the live/base track set** and the rest are scene overrides; Swift treats A as the
 * reference everywhere it reads a file (`BeatSequencer.swift:14427`, `:7765`,
 * `PersistenceService.swift:141`). Reading `pattern.tracks` would be reading `undefined`, silently,
 * and yield a world with no tracks in it — an empty render that looks like a broken engine.
 *
 * ⚠️ SAMPLE IDENTITY LIVES IN THE KIT, NOT THE PATTERN HALF. The engine addresses audio by a
 * `sampleId` UUID; the kit is the only thing that knows both that UUID and the bytes behind it
 * (`SampleStore.registerKit` does the other half of this join). A track whose `sampleId` names a
 * sample the kit does not carry is a track that would play SILENCE — so it is reported, never
 * dropped quietly. A silent track and a track that was meant to be silent look identical, and you
 * would spend an hour on the wrong bug.
 */
import type { KitJson } from "../persist/kit.ts";
import { kitSamples } from "../persist/kit.ts";
import type { PatternFileJson } from "../persist/patternFile.ts";
import type { World, WorldTrack } from "./scoopyAudio.ts";
import { packedIntervals } from "../panels/chordLibrary.ts";

/** PlaybackDirection — `SequencerState.swift:1437`. */
const DIRECTION_BACKWARD = 1;

/**
 * `toneFilterMode` is a STRING in the document and an ENUM in the engine
 * (`NativeToneFilter::Mode`, `NativeToneFilter.hpp:42`). Order is load-bearing — get it wrong and a
 * low-pass track renders as a notch, which is the class of bug this whole row is about.
 */
const TONE_MODES = ["tone", "lowPass", "highPass", "bandPass", "notch"];

/** `Track.LfoModifierTarget` raw values — Track.swift:727-735. */
const LFO_TARGET_PITCH = 0;
const LFO_TARGET_FILTER = 1;
const LFO_TARGET_FREE_RATE = 7;

/** `Track.SpeedMode` raw values — Track.swift:73-76. */
const SPEED_TIME_AND_PITCH = 1;
const SPEED_TIME_STRETCH = 2;

/** `Track.TrackType.audio` — Track.swift:271. */
const TRACK_TYPE_AUDIO = 0;

/** `Track.PlaybackMode.regular` — Track.swift:41. */
const PLAYBACK_REGULAR = 0;

/**
 * The free-rate LFO depth is DERIVED, not stored: find the LFO's `.freeRate` modifier slot and take
 * its amount. An exact mirror of `AudioEngineFacade.freeRateDepth` (:2071) — which is the only place
 * this existed, and is why the browser silently had no free-rate modulation at all.
 */
function freeRateDepth(targets: number[], amounts: number[]): number {
  const i = targets.indexOf(LFO_TARGET_FREE_RATE);
  return i >= 0 && i < amounts.length ? amounts[i]! : 0;
}

/**
 * The modifier-amount SCALE on an LFO depth — `AudioEngineFacade.swift:2092-2105`. The knob stores
 * 0…1; the engine wants semitones / tone-units. The scale is the `.pitch`/`.filter` modifier slot's
 * amount when one is assigned, else the default 24 semitones / 25 tone-units. Sending the raw knob
 * (as this converter used to) made pitch/filter modulation ~24×/25× weaker than the desktop.
 */
function modifierAmount(targets: number[], amounts: number[], target: number, def: number): number {
  const i = targets.indexOf(target);
  return i >= 0 && i < amounts.length ? amounts[i]! : def;
}

/** The subset of a PatternFile track this converter reads. Everything else is not engine-visible. */
interface DocTrack {
  steps: boolean[];
  sampleId?: string;

  volume: number;
  pan: number;
  trackGain?: number;
  samplePeakGain: number;
  isMuted: boolean;
  isStopped: boolean;
  isPaused: boolean;
  trackType: number;
  stereoMode: number;
  outputAssign: number;
  chokeGroup: number;

  tone: number;
  toneQ: number;
  filterDrive: number;
  toneFilterMode: string;

  send1Level: number;
  send2Level: number;
  send3Level: number;
  send4Level: number;

  globalPitchOffset: number;
  globalFineTuneCents: number;
  tuning: number;
  speedMultiplier: number;
  speedMode: number;
  melodicPitchMode: boolean;
  preserveFormants: boolean;
  stretchEnabled: boolean;
  stretchTimeOnly: boolean;
  freeRateEnabled: boolean;
  freeRate: number;

  sampleStartMs: number;
  sampleEndMs: number;
  playbackMode: number;
  loopEnabled: boolean;
  loopStartMs: number;
  loopEndMs: number;
  loopCrossfadeMs: number;
  defaultChopIndex: number;
  chopCount: number;

  attackPercent: number;
  releasePercent: number;
  fadeCurve: number;
  swingAmount: number;
  humanize: number;
  preSilenceMs: number;
  glidePercentBetweenSteps: number;
  ownerModeGate: number;
  ownerModeAttack: number;
  randomize: boolean;
  playbackDirection: number;
  voiceMode: string;

  lfoPitchDepth: number;
  lfoVolumeDepth: number;
  lfoPanDepth: number;
  lfoFilterDepth: number;
  lfoGainDepth: number;
  lfo2PitchDepth: number;
  lfo2VolumeDepth: number;
  lfo2PanDepth: number;
  lfo2FilterDepth: number;
  lfo2GainDepth: number;
  lfo3PitchDepth: number;
  lfo3VolumeDepth: number;
  lfo3PanDepth: number;
  lfo3FilterDepth: number;
  lfo3GainDepth: number;
  lfo4PitchDepth: number;
  lfo4VolumeDepth: number;
  lfo4PanDepth: number;
  lfo4FilterDepth: number;
  lfo4GainDepth: number;
  grainModeEnabled: boolean;
  grainRateMode: number;
  grainRateHz: number;
  grainSyncRatio: number;
  grainLengthMs: number;
  grainWindow: number;
  grainScanPosition: number;
  grainScanSpeed: number;
  grainPitchSemitones: number;
  grainRandomize: number;
  grainKeyTrack: boolean;
  locatorStartStep: number;
  locatorEndStep: number;
  locatorRepeatActive: boolean;
  rhythmicOffset: number;

  pitchOffsets: number[];
  accentLevels: number[];
  cellLengths: number[];
  reverseSteps: boolean[];
  glideSteps: boolean[];
  volumeOffsets: number[];
  mixVolumeOffsets: number[];
  panOffsets: number[];
  toneOffsets: number[];
  sampleStartMsOffsets: number[];
  sampleEndMsOffsets: number[];
  preSilenceMsOffsets: number[];
  cellChopIndices: number[];
  chordIndices: number[];
  lfo1ModifierTargets: number[];
  lfo1ModifierAmounts: number[];
  lfo2ModifierTargets: number[];
  lfo2ModifierAmounts: number[];
  lfo3ModifierTargets: number[];
  lfo3ModifierAmounts: number[];
  lfo4ModifierTargets: number[];
  lfo4ModifierAmounts: number[];
  send1Offsets: number[];
  send2Offsets: number[];
  send3Offsets: number[];
  send4Offsets: number[];
  flamCounts: number[];
  rhythmicOffsetSteps: number[];
  chopPoints: number[];
}

export interface WorldBuild {
  world: World;
  /**
   * Tracks that name a sample the kit does not carry. NOT an exception and NOT a silent drop: the
   * session still plays, minus these, and the caller says so out loud.
   */
  missingSamples: string[];
  /** Tracks with no sample at all — empty rows. Normal; counted, not complained about. */
  emptyTracks: number;
  /** Tracks whose sample trim could not be converted to frames (no sample rate given). */
  unresolvedTrims: string[];
}

export interface WorldOptions {
  isPlaying?: boolean;
  startStep?: number;
  /**
   * sampleId → the decoded sample's rate. Needed ONLY to turn the document's `sampleStartMs` /
   * `sampleEndMs` into the FRAMES the engine wants. Omit it and the trim cannot be expressed, so it
   * is reported in `unresolvedTrims` rather than silently dropped — a sample that plays from the top
   * when it was trimmed is a wrong note, not a missing feature.
   */
  sampleRates?: Map<string, number>;
  /**
   * RUNTIME launch gates, by section index — the companion's per-track ▶/■. When present it
   * REPLACES the document's `isStopped` in the mute fold (the runtime set is seeded from the
   * document at open, then owned by the user's clicks); when absent the document's flag applies,
   * which keeps every existing caller and fixture unchanged.
   */
  stoppedTracks?: ReadonlySet<number>;
  /**
   * RUNTIME solo, by section index — solo is never persisted (`isSoloed` is not a document field;
   * BeatSequencer.swift:8268 "a transient UI state that resets on load"). Mirrors the desktop's
   * derivation exactly (BeatSequencer.swift:6626-6643): when ANY track is soloed, every un-soloed
   * peer gets `mixMuted` — the gain-kill lane, NOT the trigger gate, so peers keep firing (and
   * keep choking) at zero gain and un-solo reveals the groove mid-ring.
   */
  soloedTracks?: ReadonlySet<number>;
  /**
   * Host has no return-FX section (caps.returnFx false — the browser): zero the send levels and
   * drop the per-step send offsets, so the render is DRY rather than feeding the returns' C++
   * default parameters (delay 250 ms / feedback 0.4 — never the session's settings). The document
   * keeps its send values untouched; this shapes only the published world.
   */
  disableReturnFx?: boolean;
  /** DECK-SCOPE transport verbs (P3-M-1b) — beat repeat + whole-session
      reverse, runtime performance state the store restates on every publish
      (never the document: a beat repeat is a hand gesture). Emitted onto the
      World for the NATIVE applier; the browser worklet ignores them today. */
  beatRepeat?: { startStep: number; length: number; subdivision?: number } | null;
  reverseTransport?: boolean;
}

/**
 * `sectionA` + the kit → the engine's `World`.
 *
 * Pure: no OPFS, no AudioContext, no engine. That is what makes it testable against the real
 * Swift-written fixture under node, with no browser in sight.
 */
/** The pattern's master volume + clipper block, each field only when the
    document actually carries a sane value (absent → the engine's defaults). */
function masterStage(pattern: PatternFileJson): Partial<World> {
  const p = pattern as Record<string, unknown>;
  const out: Record<string, number | boolean> = {};
  const num = (key: keyof World & string) => {
    const v = p[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  };
  num("masterVolume");
  num("masterClipperDrive");
  num("masterClipperThreshold");
  num("masterClipperSoftness");
  num("masterClipperCurve");
  num("masterClipperCeiling");
  num("masterClipperOversample");
  if (typeof p.masterClipperDecoupled === "boolean")
    out.masterClipperDecoupled = p.masterClipperDecoupled;
  return out as Partial<World>;
}

export function worldFromSession(
  pattern: PatternFileJson,
  kit: KitJson,
  options: WorldOptions = {},
): WorldBuild {
  const known = new Set(kitSamples(kit).map((s) => s.id));
  const section = (pattern.sectionA as DocTrack[] | undefined) ?? [];

  const tracks: WorldTrack[] = [];
  const missingSamples: string[] = [];
  const unresolvedTrims: string[] = [];
  let emptyTracks = 0;

  const bools = (v: boolean[]) => v;
  const nums = (v: number[]) => v;

  const anySolo = (options.soloedTracks?.size ?? 0) > 0;

  for (const [index, track] of section.entries()) {
    if (!track.sampleId) {
      emptyTracks++;
      continue;
    }
    if (!known.has(track.sampleId)) {
      missingSamples.push(track.sampleId);
      continue;
    }
    const stopped = options.stoppedTracks ? options.stoppedTracks.has(index) : track.isStopped;
    const soloed = options.soloedTracks?.has(index) ?? false;

    // Free-rate pitch factor for T+P (varispeed) — AudioEngineFacade.swift:2080-2090: in T+P the
    // free rate ALSO pitches each grain on top of the multiply; gated to REG playback with the
    // free rate engaged (toggle on, or any LFO free-rate modifier assigned). Magnitude only.
    const d1 = freeRateDepth(track.lfo1ModifierTargets, track.lfo1ModifierAmounts);
    const d2 = freeRateDepth(track.lfo2ModifierTargets, track.lfo2ModifierAmounts);
    const d3 = freeRateDepth(track.lfo3ModifierTargets, track.lfo3ModifierAmounts);
    const d4 = freeRateDepth(track.lfo4ModifierTargets, track.lfo4ModifierAmounts);
    const freeRateEngaged =
      track.playbackMode === PLAYBACK_REGULAR &&
      (track.freeRateEnabled || d1 !== 0 || d2 !== 0 || d3 !== 0 || d4 !== 0);
    const tpFreeRatePitch =
      track.speedMode === SPEED_TIME_AND_PITCH && freeRateEngaged
        ? Math.max(0.0001, Math.abs(track.freeRate))
        : 1;

    // The document stores the trim in MILLISECONDS; the engine wants FRAMES of the sample. Only the
    // decoded buffer knows the rate, so it is passed in. 0 means "no trim" on both sides.
    const rate = options.sampleRates?.get(track.sampleId);
    const trimmed = track.sampleStartMs > 0 || track.sampleEndMs > 0;
    if (trimmed && rate === undefined) unresolvedTrims.push(track.sampleId);
    const toFrames = (ms: number) =>
      rate === undefined || ms <= 0 ? 0 : Math.round((ms / 1000) * rate);

    tracks.push({
      sampleId: track.sampleId,
      // boolean[] → the Uint8Array the worklet copies straight into the WASM heap.
      steps: Uint8Array.from(track.steps, (on) => (on ? 1 : 0)),

      // mix — volume premultiplied exactly as the desktop sends it (AudioEngineFacade.swift:2111):
      // the import normalizer sets samplePeakGain = 1/peak with trackGain = peak, so the product is
      // ×1 at import but scales with the GAIN knob after; sending bare volume froze the knob's
      // loudness here while the desktop's moved.
      volume: track.volume * (track.trackGain ?? 1) * track.samplePeakGain,
      pan: track.pan,
      trackGain: track.trackGain,
      // THE MUTE SPLIT, desktop-exact (BeatSequencer.swift:6631-6643 + AudioEngineFacade.swift:2124):
      // `muted` is the TRIGGER gate and carries ONLY stop/pause/no-audio-output terms; user mute and
      // the solo mask ride `mixMuted`, the ~4 ms gain ramp. Folding user mute into the trigger gate
      // (as this converter used to) stopped a muted track's triggers entirely — so it no longer
      // CHOKED its choke-group peers, and ring-outs appeared here that the desktop cuts.
      // trackType: a non-audio track's sample lane is off (SMP toggle); the WASM world does not
      // carry trackType (P8-9), so without this term the browser played samples the desktop mutes.
      muted: stopped || track.isPaused || track.trackType !== TRACK_TYPE_AUDIO,
      mixMuted: track.isMuted || (anySolo && !soloed),
      reversed: track.playbackDirection === DIRECTION_BACKWARD,
      polyphonic: track.voiceMode === "poly",
      stereoMode: track.stereoMode,
      outputAssign: track.outputAssign,
      // >8 = legacy auto-assign artifact → OFF (0), mirroring the load-time sanitize
      // in migrations.ts; last-hop guard so a stale document can't merge groups.
      chokeGroup: track.chokeGroup > 8 ? 0 : track.chokeGroup,

      // filter — the string→enum step. A wrong index here is a low-pass rendered as a notch.
      tone: track.tone,
      toneQ: track.toneQ,
      filterDrive: track.filterDrive ?? 0,
      toneMode: Math.max(0, TONE_MODES.indexOf(track.toneFilterMode)),

      // sends — silenced wholesale on a host with no return-FX section (see WorldOptions).
      send1Level: options.disableReturnFx ? 0 : track.send1Level,
      send2Level: options.disableReturnFx ? 0 : track.send2Level,
      send3Level: options.disableReturnFx ? 0 : track.send3Level,
      send4Level: options.disableReturnFx ? 0 : track.send4Level,

      // pitch / speed — each mapping mirrors AudioEngineFacade.swift:2133-2140 + :2254-2257.
      globalPitchOffset: track.globalPitchOffset,
      // The desktop sends globalFineTuneCents; `fineTuneCents` on the document is the LEGACY field.
      fineTuneCents: track.globalFineTuneCents,
      tuningIndex: track.tuning,
      // Grain-pitch multiplier: T+P and TS take the multiply (T+P also × the free-rate magnitude);
      // timeOnly pitches NOTHING — sending the raw multiplier repitched every timeOnly ×N track.
      speedMultiplier:
        (track.speedMode === SPEED_TIME_AND_PITCH || track.speedMode === SPEED_TIME_STRETCH
          ? track.speedMultiplier
          : 1) * tpFreeRatePitch,
      // The ratchet always runs at the real multiplier — every mode, incl. timeOnly (:2142).
      patternSpeedMultiplier: track.speedMultiplier,
      melodicPitchMode: track.melodicPitchMode,
      preserveFormants: track.preserveFormants,
      // speedMode == .timeStretch — NOT the document's pitchSyncMode (that is the legacy computed
      // "== .timeAndPitch", i.e. the OPPOSITE gate: it stretched T+P tracks and repitched TS ones).
      useTimeStretch: track.speedMode === SPEED_TIME_STRETCH,
      // The REG stretch toggle — NOT isStretchByLength (legacy "playbackMode == .stretch").
      stretchEnabled: track.stretchEnabled,
      stretchTimeOnly: track.stretchTimeOnly,
      freeRateEnabled: track.freeRateEnabled,
      freeRate: track.freeRate,

      // sample region / playback
      sampleStartFrame: toFrames(track.sampleStartMs),
      sampleEndFrame: toFrames(track.sampleEndMs),
      playbackMode: track.playbackMode,
      loopEnabled: track.loopEnabled,
      loopStartMs: track.loopStartMs,
      loopEndMs: track.loopEndMs,
      loopCrossfadeMs: track.loopCrossfadeMs,
      defaultChopIndex: track.defaultChopIndex,
      chopCount: track.chopCount,

      // envelope / feel
      attackPercent: track.attackPercent,
      releasePercent: track.releasePercent,
      fadeCurve: track.fadeCurve,
      swingAmount: track.swingAmount,
      humanize: track.humanize,
      preSilenceMs: track.preSilenceMs,
      glidePercent: track.glidePercentBetweenSteps,
      ownerGate: track.ownerModeGate,
      ownerAttack: track.ownerModeAttack,
      randomize: track.randomize,
      playbackDirectionBackward: track.playbackDirection === DIRECTION_BACKWARD,

      // modulation — the LFO depths and grain engine. Carried because the coverage check
      // (engine/tools/check-abi-coverage.mjs) will not let them fall out again.
      // Pitch/filter depths are SCALED to engine units exactly as the desktop does
      // (AudioEngineFacade.swift:2177-2198): × the modifier amount for LFO 1/2 (defaults 24
      // semitones / 25 tone-units), fixed ×24/×25 for LFO 3/4. Raw knob values (0…1) made
      // modulation ~24× weaker here than on the desktop.
      lfo1PitchDepth:
        track.lfoPitchDepth *
        modifierAmount(track.lfo1ModifierTargets, track.lfo1ModifierAmounts, LFO_TARGET_PITCH, 24),
      lfo1VolDepth: track.lfoVolumeDepth,
      lfo1PanDepth: track.lfoPanDepth,
      lfo1FilterDepth:
        track.lfoFilterDepth *
        modifierAmount(track.lfo1ModifierTargets, track.lfo1ModifierAmounts, LFO_TARGET_FILTER, 25),
      lfo1GainDepth: track.lfoGainDepth,
      lfo2PitchDepth:
        track.lfo2PitchDepth *
        modifierAmount(track.lfo2ModifierTargets, track.lfo2ModifierAmounts, LFO_TARGET_PITCH, 24),
      lfo2VolDepth: track.lfo2VolumeDepth,
      lfo2PanDepth: track.lfo2PanDepth,
      lfo2FilterDepth:
        track.lfo2FilterDepth *
        modifierAmount(track.lfo2ModifierTargets, track.lfo2ModifierAmounts, LFO_TARGET_FILTER, 25),
      lfo2GainDepth: track.lfo2GainDepth,
      lfo3PitchDepth: track.lfo3PitchDepth * 24,
      lfo3VolDepth: track.lfo3VolumeDepth,
      lfo3PanDepth: track.lfo3PanDepth,
      lfo3FilterDepth: track.lfo3FilterDepth * 25,
      lfo3GainDepth: track.lfo3GainDepth,
      lfo4PitchDepth: track.lfo4PitchDepth * 24,
      lfo4VolDepth: track.lfo4VolumeDepth,
      lfo4PanDepth: track.lfo4PanDepth,
      lfo4FilterDepth: track.lfo4FilterDepth * 25,
      lfo4GainDepth: track.lfo4GainDepth,
      grainModeEnabled: track.grainModeEnabled,
      grainRateMode: track.grainRateMode,
      grainRateHz: track.grainRateHz,
      grainSyncRatio: track.grainSyncRatio,
      grainLengthMs: track.grainLengthMs,
      grainWindow: track.grainWindow,
      grainScanPosition: track.grainScanPosition,
      grainScanSpeed: track.grainScanSpeed,
      grainPitchSemitones: track.grainPitchSemitones,
      grainRandomize: track.grainRandomize,
      grainKeyTrack: track.grainKeyTrack,
      locatorStartStep: track.locatorStartStep,
      locatorEndStep: track.locatorEndStep,
      locatorRepeatActive: track.locatorRepeatActive,
      rhythmicOffset: track.rhythmicOffset,
      // Derived, not stored: the engine wants a fast "does this track have flams at all" flag.
      hasFlamCells: track.flamCounts.some((n) => n > 0),
      hasChordCells: track.chordIndices.some((n) => n > 0),

      // Derived, exactly as AudioEngineFacade does it — see freeRateDepth() above.
      lfo1FreeRateDepth: freeRateDepth(track.lfo1ModifierTargets, track.lfo1ModifierAmounts),
      lfo2FreeRateDepth: freeRateDepth(track.lfo2ModifierTargets, track.lfo2ModifierAmounts),
      lfo3FreeRateDepth: freeRateDepth(track.lfo3ModifierTargets, track.lfo3ModifierAmounts),
      lfo4FreeRateDepth: freeRateDepth(track.lfo4ModifierTargets, track.lfo4ModifierAmounts),

      // per-step arrays
      pitchOffsets: nums(track.pitchOffsets),
      accentLevels: nums(track.accentLevels),
      cellLengths: nums(track.cellLengths),
      reverseSteps: bools(track.reverseSteps),
      glideSteps: bools(track.glideSteps),
      volumeOffsets: nums(track.volumeOffsets),
      mixVolumeOffsets: nums(track.mixVolumeOffsets),
      panOffsets: nums(track.panOffsets),
      toneOffsets: nums(track.toneOffsets),
      sampleStartMsOffsets: nums(track.sampleStartMsOffsets),
      sampleEndMsOffsets: nums(track.sampleEndMsOffsets),
      preSilenceMsOffsets: nums(track.preSilenceMsOffsets),
      cellChopIndices: nums(track.cellChopIndices),
      // Empty offsets keep the engine's zeros (the worklet skips empty arrays) — a positive
      // per-step offset on a zeroed base would still send.
      send1Offsets: options.disableReturnFx ? [] : nums(track.send1Offsets),
      send2Offsets: options.disableReturnFx ? [] : nums(track.send2Offsets),
      send3Offsets: options.disableReturnFx ? [] : nums(track.send3Offsets),
      send4Offsets: options.disableReturnFx ? [] : nums(track.send4Offsets),
      flamCounts: nums(track.flamCounts),
      rhythmicOffsetSteps: nums(track.rhythmicOffsetSteps),
      chopPoints: nums(track.chopPoints),
      // The engine wants INTERVALS; the document stores an index into the chord library. In the
      // desktop Swift expands one into the other — in the browser there is no Swift, so TS does,
      // from a table the chordLibrary test now PARSES out of ChordLibrary.swift. A drift there is
      // not a mislabel; it is a wrong chord, played.
      chordIntervals: packedIntervals(track.chordIndices),
    });
  }

  return {
    world: {
      bpm: pattern.bpm as number,
      isPlaying: options.isPlaying ?? true,
      startStep: options.startStep ?? 0,
      tracks,
      // Present only when SET: an absent field publishes the engine's fresh
      // defaults, so a session that never heard of beat repeat stays clean.
      ...(options.beatRepeat
        ? {
            beatRepeatActive: true,
            beatRepeatStartStep: options.beatRepeat.startStep,
            beatRepeatLength: options.beatRepeat.length,
            ...(options.beatRepeat.subdivision && options.beatRepeat.subdivision > 1
              ? { beatRepeatSubdivision: options.beatRepeat.subdivision }
              : {}),
          }
        : {}),
      ...(options.reverseTransport ? { reverseTransport: true } : {}),
      // The deck's MASTER STAGE (P3-D4-1a) — the DOCUMENT's own fields, not an
      // option: the pattern format requires them (patternFile.ts) and the scene
      // projection preserves them, so they are emitted whenever present. Guarded
      // per field anyway — a hand-built fixture pattern without them must
      // publish the engine's defaults, never NaN.
      ...masterStage(pattern),
    },
    missingSamples,
    emptyTracks,
    unresolvedTrims,
  };
}
