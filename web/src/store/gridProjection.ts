/**
 * THE GRID PROJECTION — the document, as the grid sees it. This is what makes the browser editable.
 *
 * Under THE FLIP, `GridPanel` owns the pattern and speaks exactly one language: `GridPatternState`
 * (78 fields, `schema.ts`). On the desktop, Swift builds that from its `Track` view-model
 * (`WebGridBinding.gridPatternState`) and applies edits back (`applyGridPatternState`). **There is no
 * Swift in a browser**, so the companion has to do both halves — from the DOCUMENT.
 *
 * ⚠️ A GRID TRACK IS ASSEMBLED FROM TWO PARALLEL ARRAYS, and finding the second one is not obvious.
 * `PatternFile` keeps the pattern half in `sectionA[i]` and the *settings* half — colour, the LFO
 * depths, the mod routings, the tone stack — in **`baseSettings.trackSettings[i]`**. Not
 * `pattern.trackSettings`: there is no such field. `baseSettings` is the pattern-scene system's
 * GLOBAL BASE (scenes are base + sparse pinned overrides), and the per-track settings hang off it.
 * The two arrays overlap (both carry `volume`, `tone`, `playbackMode`…); `sectionA` is the live track
 * set and is what the engine plays, so it wins, and the settings row supplies what only it has.
 *
 * `docRows()` below does that walk, so no caller has to know it — and getting it wrong does not fail
 * loudly, it just silently defaults half the track.
 *
 * ⚠️ SOME GRID FIELDS ARE DERIVED, NOT STORED — the same trap that cost us chords and free-rate LFOs
 * at the C ABI. `stretchToCell` and `loopEnabled` are computed from `playbackMode` + flags;
 * `rhythmicOffsetRatios` turns a stored enum into a fraction; `gain` is `trackGain ?? 1`. Every one
 * of them is inverted on the way back, or the edit would not survive a save.
 *
 * HOW THIS IS KEPT HONEST — and it costs nothing, which is the nice part:
 *
 *   1. `GridPatternState` is a STRICT zod object. If `toGridPattern` forgets a field, `parse()`
 *      throws. Coverage of the read side is not a thing anyone has to remember to check.
 *   2. The write side is proven by a ROUND TRIP: doc → grid → doc → grid must be identical. A field
 *      the writer drops changes on the second pass, and the test says which one. That is the
 *      `abi-coverage` idea again, in the one place it can be had for free.
 *
 * @see gridProjection.test.ts — the round trip
 * @see docs/migration/CROSS-PLATFORM.md §2.1 — why "derived in Swift" is the recurring trap
 */
import type { GridPatternState, GridRuntimeState } from "../../protocol/schema.ts";
import { UNSET_TRACK_HEX } from "../design/tokens.ts";

/** `TrackPlaybackMode` — Track.swift:40. The grid speaks the case NAME, the file stores the raw Int. */
export const PLAYBACK_MODES = ["regular", "stretch", "loop", "owner"] as const;

/** `Track.RhythmicOffset.ratio` — Track.swift:838. Stored as the enum; the grid wants the fraction. */
export const RHYTHMIC_RATIOS = [0, 0.25, 0.5, 0.75, 1 / 3, 2 / 3];

/** `SpeedMode.timeStretch` — the raw value the document stores for `speedMode`. */
const SPEED_MODE_TIME_STRETCH = 1;

/** Anything the document does not model. Kept together so the list is visible, not scattered. */
const PLUGIN_ABSENT = {
  // P8-9: a browser cannot host an AU/VST3. The document still CARRIES the binding (preserve-don't-
  // drop) — it simply cannot be played or edited here, and the grid renders it inert.
  hasInstrument: false,
  instrumentName: null,
} as const;

/** The two document rows a grid track is made of. */
export interface DocRow {
  track: Record<string, unknown>;
  settings: Record<string, unknown>;
}

/**
 * The document's tracks, paired with their settings. THE one place that knows where the settings
 * live (`baseSettings.trackSettings`), so nothing else has to.
 */
export function docRows(pattern: Record<string, unknown>): DocRow[] {
  const tracks = (pattern.sectionA as Record<string, unknown>[] | undefined) ?? [];
  const base = pattern.baseSettings as { trackSettings?: Record<string, unknown>[] } | undefined;
  const settings = base?.trackSettings ?? [];
  return tracks.map((track, i) => ({ track, settings: settings[i] ?? {} }));
}

const num = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
const bool = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/**
 * document → `GridPatternState`. Mirrors `WebGridBinding.gridPatternState` (:1115) field for field.
 *
 * `muteGroupMember` comes from the file's top-level mute-group list, not the track, so it is passed
 * in rather than guessed.
 */
export function toGridPattern(row: DocRow, opts: { muteGroupMember?: boolean } = {}): GridPatternState {
  const t = row.track;
  const s = row.settings;

  const playbackMode = PLAYBACK_MODES[num(t.playbackMode)] ?? "regular";
  const stretchEnabled = bool(t.stretchEnabled);
  const loopEnabledFlag = bool(t.loopEnabled);

  return {
    // ── identity / chrome (the settings row is the only one that has these) ──────────────────
    colorHex: str(s.colorHex, UNSET_TRACK_HEX),
    trackType: num(t.trackType) === 0 ? "audio" : "midi",
    playbackMode,
    stepCount: arr<boolean>(t.steps).length,
    muted: bool(t.isMuted),
    // Swift ships `nil` for 0 — the grid reads "no custom start", not "starts at 0".
    patternStartStep: num(t.patternStartStep) === 0 ? null : num(t.patternStartStep),

    // ── per-step arrays ─────────────────────────────────────────────────────────────────────
    steps: arr<boolean>(t.steps),
    cellLengths: arr<number>(t.cellLengths),
    wrapSourceStep: (t.wrapSourceStep as number | null | undefined) ?? null,
    pitchOffsets: arr<number>(t.pitchOffsets),
    accentLevels: arr<number>(t.accentLevels),
    flamCounts: arr<number>(t.flamCounts),
    glideSteps: arr<boolean>(t.glideSteps),
    reverseSteps: arr<boolean>(t.reverseSteps),
    preSilenceMsOffsets: arr<number>(t.preSilenceMsOffsets),
    cellChopIndices: arr<number>(t.cellChopIndices),
    chordIndices: arr<number>(t.chordIndices),
    volumeOffsets: arr<number>(t.volumeOffsets),
    mixVolumeOffsets: arr<number>(t.mixVolumeOffsets),
    panOffsets: arr<number>(t.panOffsets),
    toneOffsets: arr<number>(t.toneOffsets),
    sampleStartMsOffsets: arr<number>(t.sampleStartMsOffsets),
    sampleEndMsOffsets: arr<number>(t.sampleEndMsOffsets),
    // DERIVED: the file stores the enum, the grid wants the fraction of a cell.
    rhythmicOffsetRatios: arr<number>(t.rhythmicOffsetSteps).map((i) => RHYTHMIC_RATIOS[i] ?? 0),

    // ── sample region ───────────────────────────────────────────────────────────────────────
    sampleStartMs: num(t.sampleStartMs),
    sampleEndMs: num(t.sampleEndMs),

    // ── timing / pitch ──────────────────────────────────────────────────────────────────────
    swing: num(t.swingAmount),
    globalPitchOffset: num(t.globalPitchOffset),
    speedMultiplier: num(t.speedMultiplier, 1),
    rateLockRatio: num(t.rateLockRatio, 1),
    pitchSyncMode: bool(t.pitchSyncMode),
    timeStretchMode: num(t.speedMode) === SPEED_MODE_TIME_STRETCH,
    // DERIVED (WebGridBinding:1137-1140): "stretch to the cell" is true in the dedicated stretch
    // mode OR when regular mode has stretch switched on.
    stretchToCell: bool(t.isStretchByLength) || (playbackMode === "regular" && stretchEnabled),
    // DERIVED: loop mode, or the loop flag inside regular/owner.
    loopEnabled:
      playbackMode === "loop" ||
      ((playbackMode === "regular" || playbackMode === "owner") && loopEnabledFlag),
    loopStartMs: num(t.loopStartMs),
    loopEndMs: num(t.loopEndMs),
    loopCrossfadeMs: num(t.loopCrossfadeMs),
    melodicPitchMode: bool(t.melodicPitchMode),
    isReversed: bool(t.isReversed),
    preSilenceMs: num(t.preSilenceMs),

    // ── chops (RAW, not resolved: resolving needs sampleDurationMs, which is RUNTIME) ────────
    chopPoints: arr<number>(t.chopPoints),
    chopCount: num(t.chopCount),
    defaultChopIndex: num(t.defaultChopIndex),

    // ── the track-row scalars ───────────────────────────────────────────────────────────────
    gain: num(t.trackGain, 1),
    volume: num(t.volume, 1),
    pan: num(t.pan),
    tone: num(t.tone),
    toneFilterMode: str(t.toneFilterMode, "tone"),
    toneQ: num(t.toneQ, 0.707),
    filterDrive: num(t.filterDrive, 0),
    globalFineTuneCents: num(t.globalFineTuneCents),
    chokeGroup: num(t.chokeGroup),
    voiceMode: str(t.voiceMode, "mono"),
    stereoMode: num(t.stereoMode, 1),
    send1Level: num(t.send1Level),
    send2Level: num(t.send2Level),
    send3Level: num(t.send3Level),
    send4Level: num(t.send4Level),
    glidePercent: num(t.glidePercentBetweenSteps),
    freeRate: num(t.freeRate, 1),
    freeRateEnabled: bool(t.freeRateEnabled),
    stretchTimeOnly: bool(t.stretchTimeOnly),
    playbackDirectionReversed: num(t.playbackDirection) === 1,
    ownerAttack: num(t.ownerModeAttack),
    ownerGate: num(t.ownerModeGate),

    // ── locators: the PRIMITIVES, not the computed length (the raw end may exceed the pattern —
    //    that is how a wrap is encoded, and shipping the length would lose it) ────────────────
    locatorStartStep: num(t.locatorStartStep),
    locatorEndStep: num(t.locatorEndStep),
    locatorRepeatActive: bool(t.locatorRepeatActive),

    // ── modulation slots: only the routings the user actually mapped ─────────────────────────
    modSlots: arr<Record<string, unknown>>(s.modRoutings).map((r) => ({
      channelIndex: num(r.channelIndex),
      target: str(r.target),
      targetShort: str(r.target).slice(0, 3).toUpperCase(),
      depth: num(r.depth),
    })),

    outputAssign: num(t.outputAssign, 1),
    tuning: num(t.tuning),
    muteGroupMember: opts.muteGroupMember ?? false,

    // ── unified track: MIDI out is a DESTINATION, independent of what the track sounds ───────
    instrumentOutEnabled: bool(t.instrumentOutEnabled),
    midiOutEnabled: bool(t.midiOutEnabled),
    midiRootNote: num(t.midiRootNote, 60),
    midiGatePercent: num(t.midiGatePercent, 50),
    midiVelocities: arr<number>(t.midiVelocities),
    ...PLUGIN_ABSENT,
    // NK-2: lit whenever the track is channel-routed at all.
    midiInputPinned: num(t.midiInputChannel, 0) > 0,
  } as GridPatternState;
}

/**
 * `GridPatternState` → the document. The inverse of the above, and it must be EXACT: a field the
 * writer drops is an edit the user makes, sees, and loses on save.
 *
 * Returns new rows — the caller owns the document and we do not mutate it under them.
 *
 * ⚠️ THE DERIVED FIELDS ARE INVERTED HERE. `stretchToCell` and `loopEnabled` are not stored; they
 * fold back into `isStretchByLength` / `stretchEnabled` / `loopEnabled` **according to the mode**,
 * exactly as `applyGridPatternState` does. Writing them blindly would silently change the mode.
 */
export function applyGridPattern(state: GridPatternState, row: DocRow): DocRow {
  const track = { ...row.track };
  const settings = { ...row.settings };

  // ⚠️ DENSE OR NOTHING. The grid reducers write per-step arrays by index
  // (`flamCounts[step] = …` on a slice), and several of these arrays start [] in a
  // fresh session — an edit at step 8 then yields a SPARSE array whose holes
  // JSON.stringify as null, and the strict decoder refuses the whole session on
  // reopen (the 2026-07-29 real-host find). This is the one seam where runtime grid
  // state re-enters the DOCUMENT, so holes die here: each array is copied with its
  // native neutral fill (the same defaults canonicalGridSubset pads with).
  const dense = <T,>(a: readonly T[], fill: T): T[] =>
    Array.from(a, (v) => (v === undefined ? fill : v));

  const modeIndex = Math.max(0, PLAYBACK_MODES.indexOf(state.playbackMode as never));

  track.playbackMode = modeIndex;
  track.isMuted = state.muted;
  track.patternStartStep = state.patternStartStep ?? 0;

  track.steps = dense(state.steps, false);
  track.cellLengths = dense(state.cellLengths, 1);
  track.wrapSourceStep = state.wrapSourceStep ?? undefined;
  track.pitchOffsets = dense(state.pitchOffsets, 0);
  track.accentLevels = dense(state.accentLevels, 0);
  track.flamCounts = dense(state.flamCounts, 1);
  track.glideSteps = dense(state.glideSteps, false);
  track.reverseSteps = dense(state.reverseSteps, false);
  track.preSilenceMsOffsets = dense(state.preSilenceMsOffsets, 0);
  track.cellChopIndices = dense(state.cellChopIndices, 0);
  track.chordIndices = dense(state.chordIndices, 0);
  track.volumeOffsets = dense(state.volumeOffsets, 0);
  track.mixVolumeOffsets = dense(state.mixVolumeOffsets, 0);
  track.panOffsets = dense(state.panOffsets, 0);
  track.toneOffsets = dense(state.toneOffsets, 0);
  track.sampleStartMsOffsets = dense(state.sampleStartMsOffsets, 0);
  track.sampleEndMsOffsets = dense(state.sampleEndMsOffsets, 0);
  // The fraction back to the enum. Nearest wins — the grid can only ever send one of the six.
  // (dense first: .map PRESERVES holes, it does not fill them.)
  track.rhythmicOffsetSteps = dense(state.rhythmicOffsetRatios, 0).map((r) => nearestRhythmicIndex(r));

  track.sampleStartMs = state.sampleStartMs;
  track.sampleEndMs = state.sampleEndMs;

  track.swingAmount = state.swing;
  track.globalPitchOffset = state.globalPitchOffset;
  track.speedMultiplier = state.speedMultiplier;
  track.rateLockRatio = state.rateLockRatio;
  track.pitchSyncMode = state.pitchSyncMode;
  track.speedMode = state.timeStretchMode ? SPEED_MODE_TIME_STRETCH : 0;

  // The inversion. `stretchToCell` means the dedicated mode OR regular+stretch; `loopEnabled` means
  // loop mode OR the flag inside regular/owner. Which of the two the mode implies decides where the
  // bit lands, so the mode must be read first — it already is (modeIndex above).
  track.isStretchByLength = state.playbackMode === "stretch" ? state.stretchToCell : false;
  track.stretchEnabled = state.playbackMode === "regular" ? state.stretchToCell : false;
  track.loopEnabled =
    state.playbackMode === "regular" || state.playbackMode === "owner" ? state.loopEnabled : false;

  track.loopStartMs = state.loopStartMs;
  track.loopEndMs = state.loopEndMs;
  track.loopCrossfadeMs = state.loopCrossfadeMs;
  track.melodicPitchMode = state.melodicPitchMode;
  track.isReversed = state.isReversed;
  track.preSilenceMs = state.preSilenceMs;

  track.chopPoints = state.chopPoints;
  track.chopCount = state.chopCount;
  track.defaultChopIndex = state.defaultChopIndex;

  track.trackGain = state.gain;
  track.volume = state.volume;
  track.pan = state.pan;
  track.tone = state.tone;
  track.toneFilterMode = state.toneFilterMode;
  track.toneQ = state.toneQ;
  track.filterDrive = state.filterDrive;
  track.globalFineTuneCents = state.globalFineTuneCents;
  track.chokeGroup = state.chokeGroup;
  track.voiceMode = state.voiceMode;
  track.stereoMode = state.stereoMode;
  track.send1Level = state.send1Level;
  track.send2Level = state.send2Level;
  track.send3Level = state.send3Level;
  track.send4Level = state.send4Level;
  track.glidePercentBetweenSteps = state.glidePercent;
  track.freeRate = state.freeRate;
  track.freeRateEnabled = state.freeRateEnabled;
  track.stretchTimeOnly = state.stretchTimeOnly;
  track.playbackDirection = state.playbackDirectionReversed ? 1 : 0;
  track.ownerModeAttack = state.ownerAttack;
  track.ownerModeGate = state.ownerGate;

  track.locatorStartStep = state.locatorStartStep;
  track.locatorEndStep = state.locatorEndStep;
  track.locatorRepeatActive = state.locatorRepeatActive;

  track.outputAssign = state.outputAssign;
  track.tuning = state.tuning;

  track.instrumentOutEnabled = state.instrumentOutEnabled;
  track.midiOutEnabled = state.midiOutEnabled;
  track.midiRootNote = state.midiRootNote;
  track.midiGatePercent = state.midiGatePercent;
  track.midiVelocities = dense(state.midiVelocities, 100);

  settings.colorHex = state.colorHex;

  // NOT written back, and each for a reason rather than an oversight:
  //   trackType        — a track's KIND is not a grid edit (unified-track ops own it).
  //   hasInstrument /
  //   instrumentName   — plugin state. P8-9: preserved in the file, never editable here.
  //   midiInputPinned  — derived from midiInputChannel; the pin is set by the MIDI surface.
  //   muteGroupMember  — lives in the file's top-level mute-group list, not on the track.
  //   stepCount        — the LENGTH of `steps`, not a field. Writing it would be writing twice.
  //   modSlots         — the routings are settings, and depth edits arrive by their own command.
  return { track, settings };
}

function nearestRhythmicIndex(ratio: number): number {
  let best = 0;
  let bestDelta = Infinity;
  RHYTHMIC_RATIOS.forEach((r, i) => {
    const d = Math.abs(r - ratio);
    if (d < bestDelta) {
      bestDelta = d;
      best = i;
    }
  });
  return best;
}

/**
 * The RUNTIME half — everything the document cannot know, because it is about the audio, not the
 * pattern. Swift fills this from the loaded sample; here the sample store does.
 */
export function toGridRuntime(input: {
  name: string;
  sampleKey: string | null;
  sampleDurationMs: number;
  samplePeakGain: number;
  soloed?: boolean;
  isStopped?: boolean;
}): GridRuntimeState {
  return {
    name: input.name,
    soloed: input.soloed ?? false,
    activeCellParameterName: "",
    sampleKey: input.sampleKey,
    sampleDurationMs: input.sampleDurationMs,
    samplePeakGain: input.samplePeakGain,
    // The companion has no clip-launch surface (P8-9), so nothing is ever scheduled or gated.
    launchScheduled: false,
    isStopped: input.isStopped ?? false,
    beatRepeatSteps: [],
    beatRepeatSubStep: -1,
    beatRepeatSubStart: 0,
    beatRepeatSubLen: 0,
    // No plugin host in the browser (P8-9) — never a program list to step.
    instrumentPresetIndex: null,
    instrumentPresetCount: null,
    instrumentPresetName: null,
  } as GridRuntimeState;
}
