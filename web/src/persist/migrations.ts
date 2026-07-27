/**
 * Legacy session migration (P5-06c) — the last gate before THE FLIP.
 *
 * `patternFile.ts` is STRICT: it models exactly what the CURRENT encoder writes
 * (`PatternFile.currentSchemaVersion` = 28). A session written by an older build
 * is missing keys — and in several places carries a differently-shaped value —
 * so it fails that model outright. This module normalizes any older file into
 * the current shape FIRST, reproducing Swift's `init(from decoder:)` behaviour
 * exactly. After the flip, TypeScript owns persistence: if this is wrong, the
 * user's back catalogue opens wrong (or not at all).
 *
 * ─── Why this could not be written from a spec ───────────────────────────────
 *
 * Swift's decoders do three different things, and only the first is guessable:
 *
 *   (A) PURE DEFAULT      `decodeIfPresent(...) ?? 0.8`   — missing key → constant
 *   (B) VALUE-DEPENDENT   the fallback reads ANOTHER field, or remaps the value
 *   (C) SENTINEL          a `wasDecoded` flag recording whether the key was there
 *
 * The (B) cases are where a naive "fill in the defaults" port silently changes
 * how an old session SOUNDS. Every one below is transcribed from the Swift with
 * a file:line, and pinned byte-for-byte against Swift's own decoder by the
 * legacy fixture corpus (ScoopyLoopsTests/PatternFileLegacyTests.swift writes
 * both the legacy input and — by decoding it — the expected migrated output;
 * `migrations.test.ts` byte-compares ours against it). Swift is the oracle:
 * whatever it does with an old file IS correct, by definition.
 *
 * ─── The traps, in the order they will bite you ──────────────────────────────
 *
 * 1. **`trackGain` migrates DIFFERENTLY in two structs that both spell it the
 *    same way.** `SequencerState.Track.trackGain` → `?? 1.0` (SequencerState
 *    :553, whose comment says "instead of volume" in as many words), but
 *    `TrackSettings.trackGain` → falls back to **`volume`** (:2928). One rule
 *    for both silently rewrites gain staging on one of the two paths.
 *
 * 2. **`toneQ` is sound-changing.** Absent → a per-FILTER-MODE legacy Q
 *    (:2880, :659): 0.976 lowPass / 0.892 highPass / 0.707 otherwise. A flat
 *    0.707 would alter the resonance of every old LP/HP track.
 *
 * 3. **`glideSteps` absent → ALL-TRUE when `glidePercentBetweenSteps > 0`**,
 *    else EMPTY (:694). Empty ≠ all-false: downstream code keys off the empty
 *    case (BeatSequencer:12147). Do not "helpfully" pad it.
 *
 * 4. **`LfoClockDivision` raw values < 1000 are a DIFFERENT encoding** and get
 *    remapped (:1432). ≥1000 but unknown → step8. Passing the raw through
 *    writes a value the engine cannot read.
 *
 * 5. **A file with NO `schemaVersion` is treated as CURRENT** (:373), not as
 *    ancient. Do not run every migration on it.
 *
 * 6. **The migrated form is not a fixed point.** The `wasDecoded` sentinels are
 *    re-encoded but never decoded — they are recomputed from key PRESENCE. A
 *    legacy file lacking `trackGain` migrates to (trackGain = volume,
 *    wasDecoded = false) and now HAS the key, so the next load flips the
 *    sentinel to true. First save ≠ second save; it converges on the second.
 *    We must reproduce the FIRST — that is what Swift writes when it opens an
 *    old session.
 *
 * Migrations are keyed off nothing but KEY PRESENCE, exactly like Swift's
 * decoder — never off `schemaVersion` (which, per trap 5, may not even be
 * there). That means this layer is safe to run on a current file too: every
 * branch is a no-op when the key is already present.
 */

import { PatternFileSchema, type PatternFileJson } from "./patternFile.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** Swift's `decodeIfPresent`: the key is "present" unless absent. (An explicit
 *  JSON null decodes as a present nil for optionals — we keep null as-is.) */
const absent = (o: Obj, k: string) => !(k in o);

/** Apply `?? fallback` for a missing key. */
function def(o: Obj, k: string, fallback: unknown): void {
  if (absent(o, k)) o[k] = fallback;
}

// ---------------------------------------------------------------------------
// LfoClockDivision — SequencerState.swift:1432–1454 (migrateLegacyValue) and
// :1541–1557 (the decoder). Raw < 1000 is the OLD beat-based encoding.
// ---------------------------------------------------------------------------

const STEP1 = 1000, STEP2 = 1001, STEP4 = 1002, STEP8 = 1003;
const STEP16 = 1004, STEP32 = 1005, STEP3 = 1006, STEP6 = 1007;
const LCM_CYCLE = 2000, LCM_HALF = 2001, LCM_QUARTER = 2002;
const LCM_DOUBLE = 2003, LCM_QUAD = 2004;
const LCM_TRIPLET = 2005, LCM_TRIPLET_DOUBLE = 2006, LCM_TRIPLET_THIRD = 2007;

const VALID_DIVISIONS = new Set([
  STEP1, STEP2, STEP3, STEP4, STEP6, STEP8, STEP16, STEP32,
  LCM_CYCLE, LCM_HALF, LCM_QUARTER, LCM_DOUBLE, LCM_QUAD,
  LCM_TRIPLET, LCM_TRIPLET_DOUBLE, LCM_TRIPLET_THIRD,
]);

/** Legacy beat-based raws → modern step/LCM raws (SequencerState.swift:1435–1445). */
const LEGACY_DIVISION: Record<number, number> = {
  1: LCM_CYCLE, // whole note → 1/LCM
  2: STEP8, // half
  4: STEP4, // quarter
  8: STEP8, // 1/8
  16: STEP16,
  32: STEP32,
  64: LCM_DOUBLE, // 2 bars
  128: LCM_QUAD, // 4 bars
  800: STEP3, // 1/8 triplet → 3 steps
  // NOTE: Swift also lists 1600 → step6 and 3200 → step6, but those branches are
  // DEAD on the decode path: the remap only runs when raw < 1000, and 1600/3200
  // are not. They fall through to "unknown ≥1000" → step8. Reproducing the
  // reachable behaviour, not the written-but-unreachable table.
};

export function migrateLfoClockDivision(raw: number): number {
  if (raw < 1000) return LEGACY_DIVISION[raw] ?? STEP8;
  return VALID_DIVISIONS.has(raw) ? raw : STEP8;
}

// ---------------------------------------------------------------------------
// LFO timing (LFO-DIV rework) — the FREE/SYNC + LfoClockDivision model became a
// grid-cell {cycleSteps, cycleRatio, lcmMode} triple. This mirrors Swift's
// `LfoTimingMigration` + `LfoClockDivision.migratedTriple` (SequencerState.swift)
// EXACTLY — the two must produce byte-identical results (byte-stable persistence).
// ---------------------------------------------------------------------------

const LFO_REF_BPM = 120;
/** SpeedRatioTiming.orderedRatios (ascending) — the 17 speed detents. */
const RATIO_DETENTS: readonly number[] = [
  0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8, 12, 16,
];
const DIVISION_STEP_COUNT: Record<number, number> = {
  [STEP1]: 1, [STEP2]: 2, [STEP3]: 3, [STEP4]: 4,
  [STEP6]: 6, [STEP8]: 8, [STEP16]: 16, [STEP32]: 32,
};
const DIVISION_CYCLES_PER_LCM: Record<number, number> = {
  [LCM_CYCLE]: 1, [LCM_HALF]: 2, [LCM_TRIPLET]: 3, [LCM_QUARTER]: 4,
  [LCM_TRIPLET_DOUBLE]: 6, [LCM_DOUBLE]: 0.5, [LCM_TRIPLET_THIRD]: 1 / 3, [LCM_QUAD]: 0.25,
};

/** LfoClockDivision.migratedTriple — a step division keeps its count at 1:1; an
 *  LCM division becomes lcmMode with cycles-per-LCM as the speed ratio. */
function divisionTriple(divRaw: number): { steps: number; ratio: number; lcm: boolean } {
  const sc = DIVISION_STEP_COUNT[divRaw];
  if (sc !== undefined) return { steps: sc, ratio: 1, lcm: false };
  const cyc = DIVISION_CYCLES_PER_LCM[divRaw];
  if (cyc !== undefined) return { steps: 8, ratio: cyc, lcm: true };
  return { steps: 8, ratio: 1, lcm: false };
}

/** LfoTimingMigration.freeTriple — nearest (steps 1…64, detent ratio) to the Hz cycle. */
function freeTriple(rateHz: number, bpm: number): { steps: number; ratio: number } {
  const safeBpm = bpm > 0 ? bpm : LFO_REF_BPM;
  const safeRate = Math.max(0.001, rateHz);
  const targetLog = Math.log(safeBpm / (15 * safeRate));
  let best = { steps: 8, ratio: 1 };
  let bestErr = Infinity;
  for (let steps = 1; steps <= 64; steps++) {
    for (const ratio of RATIO_DETENTS) {
      const err = Math.abs(Math.log(steps / ratio) - targetLog);
      const better =
        err < bestErr - 1e-9 ||
        (err < bestErr + 1e-9 && ratio === 1 && best.ratio !== 1);
      if (better) {
        best = { steps, ratio };
        bestErr = err;
      }
    }
  }
  return best;
}

/**
 * Migrate one LFO's legacy timing keys (`<p>Sync`/`<p>Division`/`<p>Rate`) to the
 * new triple (`<p>CycleSteps`/`<p>CycleRatio`/`<p>LcmMode`) IN PLACE, then delete
 * the retired keys. No-op if the new keys are already present. `p` is "lfo"|"lfo2".
 */
function migrateLfoTiming(o: Obj, p: string, bpm: number): void {
  const stepsKey = `${p}CycleSteps`, ratioKey = `${p}CycleRatio`, lcmKey = `${p}LcmMode`;
  if (!absent(o, stepsKey)) {
    // Already migrated (or a current file) — just drop any stale legacy keys.
    delete o[`${p}Sync`];
    delete o[`${p}Division`];
    return;
  }
  const sync = o[`${p}Sync`] === true;
  const rate = typeof o[`${p}Rate`] === "number" ? (o[`${p}Rate`] as number) : 2.0;
  let steps: number, ratio: number, lcm: boolean;
  if (sync) {
    const divRaw = absent(o, `${p}Division`)
      ? STEP8
      : migrateLfoClockDivision(o[`${p}Division`] as number);
    ({ steps, ratio, lcm } = divisionTriple(divRaw));
  } else {
    ({ steps, ratio } = freeTriple(rate, bpm));
    lcm = false;
  }
  o[stepsKey] = steps;
  o[ratioKey] = ratio;
  o[lcmKey] = lcm;
  delete o[`${p}Sync`];
  delete o[`${p}Division`];
}

// ---------------------------------------------------------------------------
// toneQ — the per-filter-mode legacy Q. SequencerState.swift:659–671 (Track)
// and :2880–2890 (TrackSettings) — identical tables, two structs.
// ---------------------------------------------------------------------------

export function legacyToneQ(toneFilterMode: unknown): number {
  switch (toneFilterMode) {
    case "lowPass":
      return 0.976;
    case "highPass":
      return 0.892;
    default:
      return 0.707;
  }
}

// ---------------------------------------------------------------------------
// SequencerState.Track — the pattern sections. SequencerState.swift:546–759.
// ---------------------------------------------------------------------------

function migrateTrack(t: Obj): void {
  const stepCount = Array.isArray(t.steps) ? t.steps.length : 0;

  // (B) stereoMode ← isMono (:555–556). isMono itself defaults to TRUE.
  const isMono = absent(t, "isMono") ? true : t.isMono;
  def(t, "isMono", true);
  def(t, "stereoMode", isMono ? 0 : 1); // .mono = 0, .stereo = 1

  // (B) speedMode ← the legacy pitchSyncMode flag (:574–580).
  if (absent(t, "speedMode")) {
    t.speedMode = t.pitchSyncMode === true ? 1 : 0; // .timeAndPitch : .timeOnly
  }

  // (B) playbackMode ⇄ isStretchByLength (:583–590). When playbackMode IS
  // present the stored isStretchByLength is DISCARDED and recomputed from it.
  if (absent(t, "playbackMode")) {
    const stretch = t.isStretchByLength === true;
    t.playbackMode = stretch ? 1 : 0; // .stretch : .regular
    t.isStretchByLength = stretch;
  } else {
    t.isStretchByLength = t.playbackMode === 1;
  }

  // (B) toneQ ← toneFilterMode (:659–671). SOUND-CHANGING — see trap 2.
  def(t, "toneFilterMode", "tone");
  def(t, "toneQ", legacyToneQ(t.toneFilterMode));
  // filterDrive (v29) — absent = 0 = the exactly linear kernel, which is what pre-drive files were.
  def(t, "filterDrive", 0);

  // (B) step-count-sized fallbacks (:601–614). Only ABSENCE triggers a fill —
  // Swift never resizes a present-but-wrong-length array on the decode path.
  def(t, "accentLevels", Array(stepCount).fill(0));
  def(t, "cellLengths", Array(stepCount).fill(1));
  def(t, "fullReleaseAutoExtend", Array(stepCount).fill(false));

  // (B) fullReleaseSteps ← the legacy key playThroughSteps (:604–612).
  if (absent(t, "fullReleaseSteps")) {
    t.fullReleaseSteps = Array.isArray(t.playThroughSteps)
      ? t.playThroughSteps
      : Array(stepCount).fill(false);
  }
  delete t.playThroughSteps; // decode-only: read, never re-encoded
  // RETIRED keys — gone from Swift's CodingKeys entirely, so the desktop's decoder ignores them
  // and never writes them back. The strict model rightly refuses them; deleting mirrors Swift.
  // ⚠️ A CLOSED list on purpose: stripping ALL unknown keys would also strip a field a NEWER
  // desktop wrote, which is exactly the silent data loss preserve-don't-drop forbids. Every name
  // here was verified absent from the current Track CodingKeys (SequencerState.swift:369) and
  // present in the real back catalogue (348-session sweep, 2026-07-17).
  for (const k of RETIRED_TRACK_KEYS) delete t[k];

  // (B) glideSteps ← glidePercentBetweenSteps (:694–697). ALL-TRUE or EMPTY —
  // never all-false. See trap 3.
  def(t, "glidePercentBetweenSteps", 0.0);
  if (absent(t, "glideSteps")) {
    t.glideSteps =
      (t.glidePercentBetweenSteps as number) > 0 ? Array(stepCount).fill(true) : [];
  }

  // (B) chopPoints length-validated to exactly 8; chopCount clamped 1…8 (:754–756).
  const chop = t.chopPoints;
  t.chopPoints = Array.isArray(chop) && chop.length === 8 ? chop : Array(8).fill(0);
  const rawChopCount = absent(t, "chopCount") ? 8 : (t.chopCount as number);
  t.chopCount = Math.max(1, Math.min(8, rawChopCount));

  // (B) chokeGroup >8 = legacy auto-assign artifact → OFF, mirroring the
  // SequencerState.Track decode. Valid groups are 1…8 (0 = off); mapping to
  // 8 instead would merge unrelated tracks into one group.
  if (typeof t.chokeGroup === "number" && t.chokeGroup > 8) t.chokeGroup = 0;

  // (A) pure defaults — SequencerState.swift:553–758.
  def(t, "trackGain", 1.0); // ⚠️ 1.0, NOT volume — see trap 1 (:553)
  def(t, "outputAssign", 0);
  def(t, "isStopped", false);
  def(t, "tuning", 0);
  def(t, "globalPitchOffset", 0);
  def(t, "globalFineTuneCents", 0);
  def(t, "transposeOffset", 0);
  def(t, "fineTuneCents", 0);
  def(t, "speedMultiplier", 1.0);
  def(t, "pitchSyncMode", false); // (:611)
  def(t, "melodicPitchMode", false);
  def(t, "preserveFormants", false);
  def(t, "ownerModeGate", 0);
  def(t, "ownerModeAttack", 0);
  def(t, "patternStartStep", 0);
  def(t, "voiceMode", "mono");
  def(t, "locatorStartStep", 0);
  def(t, "locatorEndStep", 0);
  def(t, "locatorRepeatActive", false);
  for (const k of LFO_DEPTH_KEYS) def(t, k, 0.0);
  def(t, "lfo1VolumeTarget", 1); // .volume = 1 (NOT 0)
  def(t, "lfo2VolumeTarget", 1);
  for (const n of [1, 2, 3, 4]) {
    def(t, `lfo${n}ModifierTargets`, [0, 1, 2]); // [.pitch, .filter, .volume]
    def(t, `lfo${n}ModifierAmounts`, [3.0, 25.0, 0.5]);
  }
  def(t, "modRoutings", []);
  for (const n of [1, 2, 3, 4]) def(t, `send${n}Level`, 0.0);
  def(t, "tone", 0.0);
  def(t, "fadeCurve", 1.0);
  def(t, "sampleStartMs", 0.0);
  def(t, "sampleEndMs", 0.0);
  def(t, "loopStartMs", 0.0);
  def(t, "loopEndMs", 0.0);
  def(t, "loopCrossfadeMs", 10.0);
  def(t, "loopEnabled", false);
  def(t, "stretchEnabled", false);
  def(t, "stretchTimeOnly", false);
  def(t, "sampleDurationMs", 0.0);
  def(t, "samplePeakGain", 1.0);
  def(t, "rhythmicOffset", 0);
  def(t, "preSilenceMs", 0.0);
  def(t, "swingAmount", 0.0);
  def(t, "attackPercent", 0.0);
  def(t, "releasePercent", 0.0);
  def(t, "isReversed", false);
  def(t, "reverseSteps", []);
  def(t, "humanize", 0.0);
  for (const k of ["sampleStartMsOffsets", "preSilenceMsOffsets", "sampleEndMsOffsets"]) def(t, k, []);
  for (const k of ["volumeOffsets", "mixVolumeOffsets", "panOffsets", "toneOffsets"]) def(t, k, []);
  for (const n of [1, 2, 3, 4]) def(t, `send${n}Offsets`, []);
  def(t, "rhythmicOffsetSteps", []);
  def(t, "flamCounts", []);
  def(t, "chordIndices", []);
  def(t, "freeRateEnabled", false);
  def(t, "freeRate", 1);
  def(t, "grainModeEnabled", false);
  def(t, "grainRateMode", 0);
  def(t, "grainRateHz", 110);
  def(t, "grainSyncRatio", 8);
  def(t, "grainLengthMs", 30);
  def(t, "grainWindow", 0);
  def(t, "grainScanPosition", 0);
  def(t, "grainScanSpeed", 0);
  def(t, "grainPitchSemitones", 0);
  def(t, "grainRandomize", 0);
  def(t, "grainKeyTrack", true); // note: TRUE
  def(t, "trackType", 0);
  def(t, "midiNotes", []);
  def(t, "midiVelocities", []);
  def(t, "midiPitchBends", []);
  def(t, "midiChannel", 0);
  def(t, "midiVelocity", 100);
  def(t, "midiRootNote", 60);
  def(t, "midiGatePercent", 100); // pre-27: notes held until the next trigger → legato
  // pre-28: the two OUTPUT flags did not exist. A track's outputs are derived from the OLD
  // two-type model, which is the only place that information lived: a `.midiOut` track with a
  // plugin bound sounded that plugin; one without drove the external port. Mirrors the Swift
  // decoder (SequencerState.Track.init(from:)) exactly — Swift is the oracle for these bytes.
  {
    const legacyIsMidi = t.trackType === 1;
    const legacyHasInstrument = t.instrumentPluginIdentifier != null;
    def(t, "instrumentOutEnabled", legacyIsMidi && legacyHasInstrument);
    def(t, "midiOutEnabled", legacyIsMidi && !legacyHasInstrument);
  }
  def(t, "midiInputChannel", 0);
  def(t, "midiDisplayMode", 0);
  // Swift `[Int: T]` encodes as an OBJECT with stringified keys (`{}` when empty) since Int keys
  // became CodingKeyRepresentable — verified against Foundation on this machine AND against the
  // fixture corpus (every `.expected.json` carries `{}`). The `[]` this used to write was old-Swift
  // lore, and it made every real pre-TR-4f session (which lacks these keys entirely, e.g. any
  // schemaVersion-15 file) fail the strict parse after migration.
  for (const k of STORED_EXTENSION_KEYS) def(t, k, {});
  def(t, "cellChopIndices", []);
  def(t, "defaultChopIndex", -1);
}

/** Retired Track keys found in the real back catalogue: the pre-tone filter/saturation block
 *  (filterCutoff, filterType, the aw-, bk- and sat-prefixed families), pattern subdivisions, the
 *  old start offset, and the folded-view flag. All absent from the current CodingKeys — Swift
 *  drops them on open. */
const RETIRED_TRACK_KEYS = [
  "isFolded", "subdivisions", "startOffset", "effectType",
  "filterEnabled", "filterCutoff", "filterResonance", "filterType",
  "filterCutoffOffsets", "resonanceOffsets",
  "awCutoff", "awResonance", "saturationTone", "saturationDrive",
  "satDrive", "satHighpass", "satMix", "satOutput", "hpMix", "lpMix",
  "bkDrive", "bkVoicing", "bkSubOut", "bkBassOut", "bassGain", "subGain",
  "midiPitches",
];

/** Same story, per container. Verified against SettingsSceneData / ReturnTrack CodingKeys. */
const RETIRED_SCENE_KEYS = [
  "filterLPBaselineHz", "filterHPBaselineHz", "filterBPBaselineHz", "filterNTBaselineHz",
  "hpFreq", "hpQ", "lpFreq", "lpQ",
];
const RETIRED_TRACK_SETTINGS_KEYS = ["enableFilter", "filterCutoff", "filterResonance", "filterType"];
const RETIRED_RETURN_KEYS = [
  "effectMode", "lfoDepth", "lfoRate", "lfoWaveform", "lfoSyncEnabled", "lfoSyncDivision",
];
const RETIRED_FILE_KEYS = [
  ...RETIRED_SCENE_KEYS, "fxPads",
  "saturationDrive", "saturationHighpass", "saturationMix", "saturationOutput",
  "basskitDrive", "basskitVoicing", "basskitSubOut",
];

const LFO_DEPTH_KEYS = [
  "lfoPitchDepth", "lfoFilterDepth", "lfoVolumeDepth", "lfoPanDepth",
  "lfo2PitchDepth", "lfo2FilterDepth", "lfo2VolumeDepth", "lfo2PanDepth",
  "lfoStartDepth", "lfoEndDepth", "lfo2StartDepth", "lfo2EndDepth",
  "lfoGainDepth", "lfo2GainDepth",
  "lfo3PitchDepth", "lfo3FilterDepth", "lfo3VolumeDepth", "lfo3PanDepth", "lfo3GainDepth",
  "lfo4PitchDepth", "lfo4FilterDepth", "lfo4VolumeDepth", "lfo4PanDepth", "lfo4GainDepth",
];

const STORED_EXTENSION_KEYS = [
  "storedExtensionPitchOffsets", "storedExtensionVolumeOffsets",
  "storedExtensionMixVolumeOffsets", "storedExtensionPanOffsets",
  "storedExtensionSampleStartMsOffsets", "storedExtensionSampleEndMsOffsets",
  "storedExtensionToneOffsets", "storedExtensionReverseSteps",
  "storedOwnerModeCellLengths",
];

// ---------------------------------------------------------------------------
// TrackSettings — inside settings scenes. SequencerState.swift:2830–2956.
// Same field NAMES as Track, DIFFERENT rules. See trap 1.
// ---------------------------------------------------------------------------

function migrateTrackSettings(s: Obj): void {
  def(s, "volume", 0.8);
  def(s, "pan", 0.0);

  // (C) SENTINELS — re-encoded but never decoded; recomputed from key presence.
  // This is what makes the migrated form a non-fixed-point (trap 6).
  const hadTrackGain = !absent(s, "trackGain");
  if (!hadTrackGain) s.trackGain = s.volume; // ⚠️ ← volume, NOT 1.0 (:2928)
  s.trackGainWasDecoded = hadTrackGain;

  // NOTE: colorHex is a Swift OPTIONAL (String?). Absent → nil → `encodeIfPresent`
  // OMITS the key. So we must leave it ABSENT, not set it to null: writing null
  // would add a key Swift never writes and break byte-identity. (Same for every
  // optional below — the only thing the migration does for them is nothing.)
  const hadColor = !absent(s, "colorHex");
  s.colorWasDecoded = hadColor;

  // (B) toneQ ← toneFilterMode (:2880–2890).
  def(s, "toneFilterMode", "tone");
  def(s, "toneQ", legacyToneQ(s.toneFilterMode));
  def(s, "filterDrive", 0);

  // (B) playbackMode ← isStretchByLength (:2898–2903). Note isStretchByLength
  // is a COMPUTED property here (playbackMode == .stretch), so it is always
  // re-encoded from playbackMode — never trusted from the file.
  if (absent(s, "playbackMode")) {
    s.playbackMode = s.isStretchByLength === true ? 1 : 0;
  }
  s.isStretchByLength = s.playbackMode === 1;

  // (B) chopPoints validated to exactly 8; chopCount clamped (:2944–2946).
  const chop = s.chopPoints;
  s.chopPoints = Array.isArray(chop) && chop.length === 8 ? chop : Array(8).fill(0);
  const rawChopCount = absent(s, "chopCount") ? 8 : (s.chopCount as number);
  s.chopCount = Math.max(1, Math.min(8, rawChopCount));

  // (A) defaults — note the sentinel-guarded ones (chokeGroup/voiceMode/
  // melodicPitchMode) have no *WasDecoded key in the ENCODED form, so a plain
  // default is byte-correct here.
  def(s, "chokeGroup", 0);
  // >8 = legacy auto-assign artifact → OFF (see migrateTrack note).
  if (typeof s.chokeGroup === "number" && s.chokeGroup > 8) s.chokeGroup = 0;
  def(s, "voiceMode", "mono");
  def(s, "melodicPitchMode", false);
  def(s, "stereoMode", 1); // .stereo
  def(s, "globalPitchOffset", 0);
  def(s, "globalFineTuneCents", 0);
  def(s, "transposeOffset", 0);
  def(s, "fineTuneCents", 0);
  for (const k of LFO_DEPTH_KEYS) def(s, k, 0.0);
  def(s, "lfo1VolumeTarget", 1);
  def(s, "lfo2VolumeTarget", 1);
  for (const n of [1, 2, 3, 4]) {
    def(s, `lfo${n}ModifierTargets`, [0, 1, 2]);
    def(s, `lfo${n}ModifierAmounts`, [3.0, 25.0, 0.5]);
  }
  def(s, "modRoutings", []);
  for (const n of [1, 2, 3, 4]) def(s, `send${n}Level`, 0);
  def(s, "tone", 0);
  def(s, "fadeCurve", 1.0);
  def(s, "sampleStartMs", 0);
  def(s, "sampleEndMs", 0);
  def(s, "loopStartMs", 0);
  def(s, "loopEndMs", 0);
  def(s, "loopCrossfadeMs", 10);
  def(s, "isReversed", false);
  def(s, "ownerModeGate", 0);
  def(s, "ownerModeAttack", 0);
  def(s, "loopEnabled", false);
  def(s, "stretchEnabled", false);
  def(s, "stretchTimeOnly", false);
  def(s, "reverseSteps", []);
  def(s, "glideSteps", []);
  def(s, "transposeEnabled", false);
  def(s, "defaultChopIndex", -1);
  // `customName` (String?) is deliberately NOT defaulted — see the colorHex note.
  for (const k of RETIRED_TRACK_SETTINGS_KEYS) delete s[k];
}

// ---------------------------------------------------------------------------
// SettingsSceneData — SequencerState.swift:3217–3268.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Return tracks — ReturnTrack.swift. Three decoders share one defaulting core
// (ReturnEffectSettings :204ff, gate/bufferFx :225ff/:773ff, ReturnTrackSettings
// :746ff); the fields below carry the same `?? default` in each.
// ---------------------------------------------------------------------------

/** Fields common to ReturnEffectSettings AND ReturnTrackSettings. */
function migrateReturnShared(r: Obj): void {
  def(r, "delayWetLevel", 1.0);
  def(r, "delayDryLevel", 0.0);
  def(r, "lfoTimeDepth", 0.0);
  def(r, "lfo2TimeDepth", 0.0);
  def(r, "timeModRange", 10.0);
  def(r, "stereoWidth", 0.5);
  def(r, "lfoVolumeDepth", 0.0);
  def(r, "lfo2VolumeDepth", 0.0);
  def(r, "lfoPanDepth", 0.0);
  def(r, "lfo2PanDepth", 0.0);
  def(r, "lfo1VolumeTarget", 1); // .volume = 1, same enum as Track
  def(r, "lfo2VolumeTarget", 1);
  for (const k of RETIRED_RETURN_KEYS) delete r[k];
}

/** ReturnTrackSettings (returnTrack1/2) additionally carries the gate + bufferFx banks. */
function migrateReturnTrack(r: Obj): void {
  migrateReturnShared(r);
  def(r, "gateEnabled", false);
  def(r, "gateStepCount", 16);
  const gateCount = typeof r.gateStepCount === "number" ? r.gateStepCount : 16;
  def(r, "gateSteps", Array(gateCount).fill(false));
  def(r, "gateMode", 1); // .output = 1 (:228)
  // (B) bufferFx arrays fall back to the LEGACY SCALARS (:776-780): a pre-array session with
  // bufferFxRate 2.0 fills the whole rate bank with 2.0, not with the fresh-default 1.0.
  def(r, "bufferFxEnabled", false);
  def(r, "bufferFxStepCount", 16);
  const n = typeof r.bufferFxStepCount === "number" ? r.bufferFxStepCount : 16;
  def(r, "bufferFxTypes", Array(n).fill(0));
  const legacyRate = typeof r.bufferFxRate === "number" ? r.bufferFxRate : 1.0;
  const legacyPitch = typeof r.bufferFxPitch === "number" ? r.bufferFxPitch : 0.0;
  def(r, "bufferFxRates", Array(n).fill(legacyRate));
  def(r, "bufferFxPitches", Array(n).fill(legacyPitch));
  def(r, "bufferFxCellLengths", Array(n).fill(1));
}

function migrateSettingsScene(sc: Obj): void {
  def(sc, "bpm", 120);
  def(sc, "masterVolume", 0.8);
  def(sc, "sp12Mode", false);
  def(sc, "masterClipperDrive", 2.0);
  def(sc, "masterClipperThreshold", 0.7);
  def(sc, "masterClipperSoftness", 0.4);
  def(sc, "accentSteps", Array(16).fill(0));
  def(sc, "masterSpeedPercent", 0);
  def(sc, "speedPitchOnly", false);
  def(sc, "fadeCurve", 1.0);
  def(sc, "reverseTransportEnabled", false);
  def(sc, "transposeEnabled", false);
  def(sc, "trackSettings", []);
  def(sc, "lfoRate", 2.0);
  def(sc, "lfoWaveform", 0);
  def(sc, "lfo2Rate", 2.0);
  def(sc, "lfo2Waveform", 1);
  // LFO-DIV rework: migrate legacy sync/division/rate → the cycle triple (uses this scene's bpm).
  migrateLfoTiming(sc, "lfo", sc.bpm as number);
  migrateLfoTiming(sc, "lfo2", sc.bpm as number);
  def(sc, "lfoPitchAmount", 3.0);
  def(sc, "lfoToneAmount", 25.0);
  def(sc, "lfoSampleAmount", 0.5);
  def(sc, "lfoEnvelopeInvert", false);
  def(sc, "lfo2EnvelopeInvert", false);
  def(sc, "lfoEnvelopeGain", 1.0);
  def(sc, "lfo2EnvelopeGain", 1.0);
  def(sc, "lfoSmooth", 0.0);
  def(sc, "lfo2Smooth", 0.0);
  def(sc, "lfoEnvelopeAttack", 0.0);
  def(sc, "lfo2EnvelopeAttack", 0.0);
  def(sc, "lfoEnvelopeRelease", 0.2);
  def(sc, "lfo2EnvelopeRelease", 0.2);

  if (Array.isArray(sc.trackSettings)) {
    for (const s of sc.trackSettings) if (isObj(s)) migrateTrackSettings(s);
  }
  if (isObj(sc.return1EffectSettings)) migrateReturnShared(sc.return1EffectSettings);
  if (isObj(sc.return2EffectSettings)) migrateReturnShared(sc.return2EffectSettings);
  for (const k of RETIRED_SCENE_KEYS) delete sc[k];
}

// ---------------------------------------------------------------------------
// PatternFile top level — PatternFile.swift:371–487.
// ---------------------------------------------------------------------------

const SECTIONS = ["sectionA", "sectionB", "sectionC", "sectionD",
                  "sectionE", "sectionF", "sectionG", "sectionH"];

/**
 * Normalize any session (old or current) into the current on-disk shape.
 * Pure: returns a new object, never mutates the input.
 */
export function migratePatternFile(raw: unknown): PatternFileJson {
  if (!isObj(raw)) throw new Error("session root is not a JSON object");
  const f = structuredClone(raw) as Obj;

  // (B) trap 5: an unversioned file is CURRENT, not ancient (PatternFile.swift:394 decodes
  // `schemaVersion ?? currentSchemaVersion`). Bumped to 32 for XP-0b-1 portable plugin identity.
  def(f, "schemaVersion", 32);

  // (B) THE CLIPPER REWRITE (PatternFile.swift:384–393) — the single most
  // dangerous migration in the format. If `masterClipperDecoupled` is ABSENT,
  // Swift does not merely default the clipper section: it REWRITES it to the
  // modern transparent equivalent and DISCARDS whatever drive/curve/ceiling/
  // oversample the old file carried. Note oversample migrates to 2, which is
  // NOT its own default of 0.
  def(f, "masterClipperThreshold", 0.7);
  def(f, "masterClipperSoftness", 0.4);
  if (absent(f, "masterClipperDecoupled")) {
    f.masterClipperDecoupled = true;
    f.masterClipperDrive = 1.0;
    f.masterClipperCurve = 2; // hard = clean clip
    f.masterClipperCeiling = 1.0;
    f.masterClipperOversample = 2; // ← 2, not the 0 default
  } else {
    def(f, "masterClipperDrive", 1.0);
    def(f, "masterClipperCurve", 2);
    def(f, "masterClipperCeiling", 1.0);
    def(f, "masterClipperOversample", 0);
  }

  // (A) top-level defaults (PatternFile.swift:376–487).
  def(f, "sp12Mode", false);
  def(f, "lfoRate", 2.0);
  def(f, "lfoWaveform", 0);
  def(f, "lfo2Rate", 2.0);
  def(f, "lfo2Waveform", 1);
  // LFO-DIV rework: migrate legacy sync/division/rate → the cycle triple (uses this file's bpm).
  migrateLfoTiming(f, "lfo", f.bpm as number);
  migrateLfoTiming(f, "lfo2", f.bpm as number);
  def(f, "lfoPitchAmount", 3.0);
  def(f, "lfoToneAmount", 25.0);
  def(f, "lfoSampleAmount", 0.5);
  def(f, "lfoEnvelopeInvert", false);
  def(f, "lfo2EnvelopeInvert", false);
  def(f, "lfoEnvelopeGain", 1.0);
  def(f, "lfo2EnvelopeGain", 1.0);
  def(f, "lfoSmooth", 0.0);
  def(f, "lfo2Smooth", 0.0);
  def(f, "modChannels", DEFAULT_MOD_CHANNELS());
  // A pre-MOD-10 session HAS modChannels — they just lack the macro keys. `def` above only
  // covers a wholly absent array, so fill the existing ones too, or the strict schema rejects
  // them (which is precisely how the live world-wire check caught this: real sessions carry
  // the macros, the golden fixtures predate them).
  if (Array.isArray(f.modChannels)) {
    for (const ch of f.modChannels) if (isObj(ch)) migrateModChannel(ch);
  }
  def(f, "modChannelTriggerIndices", []);
  def(f, "modChannelFollowerIndices", []);
  def(f, "accentSteps", Array(16).fill(0));
  def(f, "masterSpeed", 1.0);
  def(f, "speedPitchOnly", false);
  def(f, "transposeEnabled", false);
  def(f, "midiMappings", []);
  // (B) pre-v2 mappings carry only `learnId`; Swift derives `target` from it
  // (MIDILearnSystem.swift:145 → inferFromLearnId :84). Neither present → Swift
  // throws dataCorrupted; here the mapping is left as-is and the strict parse
  // refuses it just as loudly.
  if (Array.isArray(f.midiMappings)) {
    for (const m of f.midiMappings) {
      if (isObj(m) && absent(m, "target") && typeof m.learnId === "string") {
        m.target = inferMappingTarget(m.learnId);
      }
    }
  }
  def(f, "midiEnabled", false);
  def(f, "midiSelectedDeviceId", 0);
  def(f, "midiClockInputDeviceId", 0);
  def(f, "midiClockOutputDestinationId", 0);
  def(f, "midiSyncMode", "internalMaster");
  def(f, "midiSlaveTransportPolicy", "fullTransport");
  // Missing sections default to EMPTY (not to sectionA — the loader decides
  // that later; the FILE just says empty). PatternFile.swift:441–448.
  for (const s of SECTIONS.slice(2)) def(f, s, []);

  for (const s of SECTIONS) {
    const tracks = f[s];
    if (Array.isArray(tracks)) for (const t of tracks) if (isObj(t)) migrateTrack(t);
  }
  if (isObj(f.baseSettings)) migrateSettingsScene(f.baseSettings);
  // The RETIRED top-level scene containers (pre-sceneSettingsLayers). They are `legacy()` in the
  // model — optional and decode-only — but optional means "may be absent", not "may be stale":
  // when a real old file CARRIES them, they hit the same strict per-field parse as everything
  // else, and without this walk a schemaVersion-15 session fails on settingsSceneA.lfoSmooth.
  // Swift decodes them through the same defaulting init, so migrating them mirrors the oracle;
  // decode-only means the result never reaches the encoder, so byte-identity is untouched.
  if (isObj(f.settingsSceneA)) migrateSettingsScene(f.settingsSceneA);
  if (isObj(f.settingsSceneB)) migrateSettingsScene(f.settingsSceneB);
  if (isObj(f.returnTrack1)) migrateReturnTrack(f.returnTrack1);
  if (isObj(f.returnTrack2)) migrateReturnTrack(f.returnTrack2);
  for (const k of RETIRED_FILE_KEYS) delete f[k];
  if (isObj(f.sceneSettingsLayers)) {
    for (const layer of Object.values(f.sceneSettingsLayers)) {
      if (isObj(layer) && isObj(layer.values)) migrateSettingsScene(layer.values);
    }
  }

  return f as PatternFileJson;
}

/**
 * `ModChannel.defaultChannels` — 4 identical LFO channels (ModulationModel.swift
 * :215), each carrying `BreakpointEnvelope.defaultShape` (:100–107).
 *
 * These values are NOT hand-transcribed from the Swift declarations: an earlier
 * attempt to do that got the field names AND the envelope wrong, and only the
 * byte-comparison caught it. They are lifted verbatim from what a fresh session
 * actually serializes, and `migrations.test.ts` re-checks them against the
 * `fresh-default` fixture — so if Swift's defaults ever move, that test fails
 * loudly instead of this constant rotting in silence.
 */
export const DEFAULT_MOD_CHANNEL = {
  type: 0, // .lfo
  lfoWaveform: 0,
  // LFO-DIV rework: the grid-cell cycle triple (ModulationModel.swift defaults 8 / 1.0 / false).
  lfoCycleSteps: 8,
  lfoCycleRatio: 1,
  lfoLcmMode: false,
  lfoPhaseOffset: 0,
  lfoSymmetry: 0.5,
  lfoSmooth: 0,
  depth: 1,
  followerAttack: 0,
  followerRelease: 0.2,
  followerGain: 1,
  // MOD-12 AGITATION controls. These match macroPreset(.sine) because lfoWaveform is 0 — and
  // ModChannel's own property defaults (ModulationModel.swift). ease 0 = the smooth-ramp default.
  lfoSlant: 0,
  lfoEase: 0,
  lfoJitter: 0,
  lfoCyclic: 1,
  envelope: {
    nodes: [
      { timeMs: 0, value: 0, curve: 1 }, // start (silent)
      { timeMs: 5, value: 1, curve: 1 }, // attack peak
      { timeMs: 0, value: 1, curve: 1 }, // sustain anchor (held)
      { timeMs: 200, value: 0, curve: 1 }, // release
    ],
    sustainNodeIndex: 2,
    bipolar: false,
    ease: 0, // MOD-10 (BreakpointEnvelope.ease, custom decode → 0.0 when absent)
    tempoSync: false,
  },
} as const;

/**
 * MOD-10 macro presets per LFO waveform — mirrors `ModChannel.macroPreset(for:)`
 * (ModulationModel.swift:249-258). Indexed by LfoWaveform raw value
 * (SequencerState.swift:1443): sine 0 · triangle 1 · square 2 · saw 3 · random 4 ·
 * envelopeFollower 5.
 *
 * This is NOT a constant fallback: the macros REPLACED the waveform as the LFO's shape, so a
 * pre-MOD-10 session is migrated by deriving the macros from the waveform it *did* save —
 * which is what makes it play back the shape it always played. Defaulting these to zeros
 * would silently flatten every old LFO.
 */
const MACRO_PRESETS: ReadonlyArray<[number, number, number, number]> = [
  [0.0, 0.0, 0.0, 1.0], // sine — smooth ramp, alternating
  [0.0, 0.0, 0.0, 1.0], // triangle — same as sine in the Agitation model
  [0.0, 1.0, 0.0, 1.0], // square — instant step, alternating
  [1.0, 0.0, 0.0, 1.0], // saw — asymmetric ramp
  [0.0, 0.0, 0.0, 0.0], // random — fully random targets (cyclic 0)
  [0.0, 0.0, 0.0, 1.0], // envelopeFollower — shape unused; it's a TYPE
];

/** Fill the MOD-10 keys a pre-MOD-10 channel lacks, exactly as Swift's decoder does. */
function migrateModChannel(ch: Record<string, unknown>): void {
  const w = typeof ch.lfoWaveform === "number" ? ch.lfoWaveform : 0;
  // Swift switches over a real enum, so an out-of-range raw value cannot occur there. Here it
  // can (the JSON is just a number), and falling back to sine keeps a corrupt file openable.
  const [slant, ease, jitter, cyclic] = MACRO_PRESETS[w] ?? MACRO_PRESETS[0]!;
  def(ch, "lfoSlant", slant);
  def(ch, "lfoEase", ease);
  def(ch, "lfoJitter", jitter);
  def(ch, "lfoCyclic", cyclic);
  def(ch, "depth", 1.0); // ModulationModel.swift:232
  if (isObj(ch.envelope)) def(ch.envelope, "ease", 0);
  // LFO-DIV rework: legacy rate/sync/division → the cycle triple. A ModChannel decodes with no
  // bpm in scope, so FREE conversion uses the fixed reference tempo (Swift does the same). The
  // legacy `lfoRate` is dropped — Swift's ModChannel encoder no longer emits it.
  migrateLfoTiming(ch as Obj, "lfo", LFO_REF_BPM);
  delete (ch as Obj).lfoRate;
}

function DEFAULT_MOD_CHANNELS(): unknown[] {
  return Array.from({ length: 4 }, () => structuredClone(DEFAULT_MOD_CHANNEL));
}

/**
 * MappingTarget.inferFromLearnId — MIDILearnSystem.swift:84–103, transcribed.
 * `track_<token>_<uuid>` or `track_<uuid>_<token>` → trackParam; anything else
 * (including a malformed track_ id) → singleton carrying the id verbatim.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function inferMappingTarget(learnId: string): unknown {
  if (!learnId.startsWith("track_")) return { singleton: { learnId } };
  const parts = learnId.slice("track_".length).split("_");
  if (parts.length < 2) return { singleton: { learnId } };
  if (UUID_RE.test(parts[parts.length - 1]!)) {
    const token = parts.slice(0, -1).join("_");
    if (token) return { trackParam: { token } };
  }
  if (UUID_RE.test(parts[0]!)) {
    const token = parts.slice(1).join("_");
    if (token) return { trackParam: { token } };
  }
  return { singleton: { learnId } };
}

/**
 * Decode a session of ANY version: migrate to the current shape, then parse
 * with the strict model. This is the entry point the flip uses for file open.
 */
export function decodePatternFileAnyVersion(text: string): PatternFileJson {
  const migrated = migratePatternFile(JSON.parse(text));
  return PatternFileSchema.parse(migrated) as PatternFileJson;
}
