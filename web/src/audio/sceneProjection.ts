/**
 * Pattern-scene projection (P8 — scenes in the browser companion).
 *
 * The document carries eight full track arrays (`sectionA`…`sectionH`), but a scene switch on the
 * desktop does NOT swap whole tracks: Swift applies only a PATTERN-SCOPED subset of the target
 * section onto the live tracks (`PatternData.apply(to:)`, SequencerState.swift:2082) — steps and
 * everything per-cell switch; a track's identity and mix do not. `worldFromSession` reads only
 * `sectionA`, so the companion projects "what would the live tracks be in scene S" into a
 * pattern whose `sectionA` IS that answer, and publishes it.
 *
 * Pure and read-only: never mutates its input, never writes back to the document. The write path
 * (scene-aware `applyGridRow`) lives in companionEngine.
 */
import type { PatternFileJson } from "../persist/patternFile.ts";

export const SCENE_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
export type SceneLetter = (typeof SCENE_LETTERS)[number];

/** Every section key — shared so no writer can forget G/H again (loadSample once did). */
export const SECTION_KEYS = SCENE_LETTERS.map((s) => `section${s}`) as readonly string[];

export const sectionKeyFor = (scene: SceneLetter): string => `section${scene}`;

/**
 * EXACTLY the fields `PatternData.apply(to:)` copies onto a live track, intersected with the
 * persisted TRACK spec (patternFile.ts:185). Deliberately NOT here — Swift's own exclusions,
 * with its reasons (SequencerState.swift:2107-2120):
 *   sampleId · volume/trackGain/pan · isMuted/isStopped · tone/toneQ/filterDrive/toneFilterMode ·
 *   send1-4Level · chokeGroup ("settings scenes, not pattern scenes") · playbackMode/ownerModeGate
 *   ("global track settings, constant across scene switches") · ownerModeAttack · trackType
 *   ("track identity, not pattern content") · tuning/globalPitchOffset/fineTuneCents · voiceMode ·
 *   sampleStartMs/sampleEndMs/loop* · chopPoints/chopCount/defaultChopIndex ·
 *   attackPercent/releasePercent/humanize · fullReleaseSteps/fullReleaseAutoExtend ·
 *   midiGatePercent/midiDisplayMode · instrument bindings.
 * (apply() also copies runtime-only stored… / euclidean… state that the persisted track does not
 * carry — nothing to project there.)
 */
export const PATTERN_SCENE_FIELDS: ReadonlySet<string> = new Set([
  "steps",
  "pitchOffsets",
  "accentLevels",
  "stereoMode",
  "outputAssign",
  "playbackDirection",
  "isPaused",
  "randomize",
  "speedMultiplier",
  "rateLockRatio",
  "speedMode",
  "phaseResetStep",
  "patternStartStep",
  "reverseSteps",
  "glideSteps",
  "midiNotes",
  "midiVelocities",
  "midiPitchBends",
  "midiChannel",
  "midiVelocity",
  "midiRootNote",
  "cellLengths",
  "wrapSourceStep",
  "locatorStartStep",
  "locatorEndStep",
  "locatorRepeatActive",
  "glidePercentBetweenSteps",
  "volumeOffsets",
  "mixVolumeOffsets",
  "panOffsets",
  "toneOffsets",
  "send1Offsets",
  "send2Offsets",
  "send3Offsets",
  "send4Offsets",
  "sampleStartMsOffsets",
  "sampleEndMsOffsets",
  "preSilenceMsOffsets",
  "rhythmicOffsetSteps",
  "flamCounts",
  "chordIndices",
  "freeRateEnabled",
  "freeRate",
  "grainModeEnabled",
  "grainRateMode",
  "grainRateHz",
  "grainSyncRatio",
  "grainLengthMs",
  "grainWindow",
  "grainScanPosition",
  "grainScanSpeed",
  "grainPitchSemitones",
  "grainRandomize",
  "grainKeyTrack",
  "preSilenceMs",
  "swingAmount",
  "cellChopIndices",
  "storedExtensionPitchOffsets",
  "storedExtensionVolumeOffsets",
  "storedExtensionMixVolumeOffsets",
  "storedExtensionPanOffsets",
  "storedExtensionSampleStartMsOffsets",
  "storedExtensionSampleEndMsOffsets",
  "storedExtensionToneOffsets",
  "storedExtensionReverseSteps",
  "storedOwnerModeCellLengths",
]);

type Row = Record<string, unknown>;

/** The pad row: a prefix of A…H (`enabledSceneCount`, default all 8 — BeatSequencer.swift:1691). */
export function enabledScenes(pattern: PatternFileJson): SceneLetter[] {
  const n = typeof pattern.enabledSceneCount === "number" ? pattern.enabledSceneCount : 8;
  return SCENE_LETTERS.slice(0, Math.min(Math.max(n, 1), 8));
}

/**
 * The settings-scene half: `baseSettings` + the scene's sparse layer (`sceneSettingsLayers`,
 * resolved by pinnedKeys — BeatSequencer.swift:11666 `resolvedSettings` / :11675 `overlaySettings`).
 *
 * RESTRICTED to what `worldFromSession` actually reads off a section row, mapped per key:
 *   "bpm"                       → world bpm                    (:11680)
 *   "track.<i>.volume"          → row.volume                   (:11699)
 *   "track.<i>.pan"             → row.pan                      (:11700)
 *   "track.<i>.tone"            → row.tone + toneFilterMode + toneQ + filterDrive (:11701-11705)
 *   "track.<i>.trackGain"       → row.trackGain                (:11706)
 *   "track.<i>.stereoMode"      → row.stereoMode               (:11707)
 *   "track.<i>.globalPitchOffset" → row.globalPitchOffset      (:11709)
 * Deliberately skipped (pinnable on the desktop, no confirmed section-row target here — listed,
 * not silently dropped): masterVolume/clipper/fadeCurve/transposeEnabled/reverseTransportEnabled
 * (master-bus state the WASM world does not model), globalFineTuneCents (the world reads
 * row.fineTuneCents — a DIFFERENT field; verify against applySettings before mapping), LFO
 * depths/modifiers, chokeGroup, voiceMode, sample window/loop keys, isReversed.
 */
export function resolveSceneSettings(
  pattern: PatternFileJson,
  scene: SceneLetter,
): { bpm?: number; trackOverrides: Map<number, Row> } {
  const trackOverrides = new Map<number, Row>();
  const layers = pattern.sceneSettingsLayers as
    | Record<string, { values?: Row; pinnedKeys?: string[] }>
    | undefined;
  const layer = layers?.[scene];
  const pinned = layer?.pinnedKeys ?? [];
  if (!layer?.values || pinned.length === 0) return { trackOverrides };

  let bpm: number | undefined;
  const settings = layer.values;
  const trackSettings = (settings.trackSettings as Row[] | undefined) ?? [];

  for (const key of pinned) {
    if (key === "bpm") {
      if (typeof settings.bpm === "number") bpm = settings.bpm;
      continue;
    }
    const parts = key.split(".");
    if (parts.length !== 3 || parts[0] !== "track") continue;
    const idx = Number(parts[1]);
    const src = trackSettings[idx];
    if (!Number.isInteger(idx) || !src) continue;
    const over = trackOverrides.get(idx) ?? {};
    switch (parts[2]) {
      case "volume":
        over.volume = src.volume;
        break;
      case "pan":
        over.pan = src.pan;
        break;
      case "tone":
        over.tone = src.tone;
        over.toneFilterMode = src.toneFilterMode;
        over.toneQ = src.toneQ;
        over.filterDrive = src.filterDrive;
        break;
      case "trackGain":
        over.trackGain = src.trackGain;
        break;
      case "stereoMode":
        over.stereoMode = src.stereoMode;
        break;
      case "globalPitchOffset":
        over.globalPitchOffset = src.globalPitchOffset;
        break;
      default:
        continue; // outside the mapped vocabulary — comes from the base (= the row as saved)
    }
    trackOverrides.set(idx, over);
  }
  return { bpm, trackOverrides };
}

/**
 * The WRITE split — the inverse of the projection, for the companion's scene-aware edit path.
 *
 * The grid edits the PROJECTED row, so the write must divide it the way a desktop save would:
 * `PATTERN_SCENE_FIELDS` are scene-local (they land in the active scene's section row), and
 * everything else is global (it lands in the `sectionA` row, heard by every scene). `sectionA`
 * keeps ITS OWN pattern fields — scene A's pattern must not absorb a scene-B step edit.
 *
 * Pure: returns fresh rows, mutates nothing.
 */
export function splitSceneEdit(
  edited: Row,
  oldBase: Row,
  oldScene: Row,
): { baseRow: Row; sceneRow: Row } {
  const sceneRow: Row = { ...oldScene };
  const baseRow: Row = {};
  for (const [k, v] of Object.entries(edited)) {
    if (!PATTERN_SCENE_FIELDS.has(k)) baseRow[k] = v; // global — every scene hears it
  }
  for (const field of PATTERN_SCENE_FIELDS) {
    if (field in edited) sceneRow[field] = edited[field];
    else delete sceneRow[field]; // absent = conditional-encode default (rateLockRatio)
    if (field in oldBase) baseRow[field] = oldBase[field];
  }
  return { baseRow, sceneRow };
}

/**
 * "What would the live tracks be in scene `scene`" — as a pattern whose `sectionA` is the answer.
 *
 * Scene "A" is the identity (the base IS the live state, exactly what a desktop save wrote).
 * Otherwise each base row merges the scene row's PATTERN_SCENE_FIELDS: rows match by track `id`
 * with index fallback (BeatSequencer.swift:11296), and a missing row / empty section inherits the
 * base unchanged — Swift's "empty scene ≡ A" lazy-copy semantic (BeatSequencer.swift:11201).
 */
export function projectScene(pattern: PatternFileJson, scene: SceneLetter): PatternFileJson {
  if (scene === "A") return pattern;

  const base = (pattern.sectionA as Row[] | undefined) ?? [];
  const sceneRows = (pattern[sectionKeyFor(scene)] as Row[] | undefined) ?? [];
  const byId = new Map(sceneRows.map((r) => [r.id, r]));

  const merged = base.map((row, i) => {
    const sceneRow = (row.id !== undefined ? byId.get(row.id) : undefined) ?? sceneRows[i];
    if (!sceneRow) return row;
    const out: Row = { ...row };
    for (const field of PATTERN_SCENE_FIELDS) {
      // A key ABSENT from the scene row (rateLockRatio's conditional encode) must fall back to
      // its decode-time default, so it is deleted rather than kept from the base row.
      if (field in sceneRow) out[field] = sceneRow[field];
      else delete out[field];
    }
    return out;
  });

  const { bpm, trackOverrides } = resolveSceneSettings(pattern, scene);
  for (const [idx, over] of trackOverrides) {
    if (merged[idx]) merged[idx] = { ...merged[idx], ...over };
  }

  return {
    ...pattern,
    sectionA: merged,
    ...(bpm !== undefined ? { bpm } : {}),
  };
}
