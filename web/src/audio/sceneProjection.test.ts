import { describe, expect, it } from "vitest";
import freshText from "../../fixtures/patternfile/fresh-default.json?raw";
import { decodePatternFile, type PatternFileJson } from "../persist/patternFile.ts";
import {
  PATTERN_SCENE_FIELDS,
  SCENE_LETTERS,
  SECTION_KEYS,
  enabledScenes,
  projectScene,
  resolveSceneSettings,
  splitSceneEdit,
} from "./sceneProjection.ts";

/**
 * The projection must be an exact TS mirror of the desktop's scene switch:
 * `PatternData.apply(to:)` (SequencerState.swift:2082) for the pattern half,
 * `overlaySettings` (BeatSequencer.swift:11675) for the pinned-settings half.
 * A field on the wrong side is not a cosmetic bug — it is a scene switch that
 * changes the mix, or a pattern that refuses to switch.
 */

const row = (over: Record<string, unknown>): Record<string, unknown> => ({
  id: "T0",
  steps: [true, false, false, false],
  pitchOffsets: [0, 0, 0, 0],
  sampleId: "S0",
  volume: 0.8,
  pan: 0,
  isMuted: false,
  isStopped: false,
  chokeGroup: 0,
  playbackMode: 0,
  tone: 0,
  swingAmount: 0,
  ...over,
});

const pattern = (over: Record<string, unknown>): PatternFileJson => ({
  bpm: 120,
  sectionA: [row({})],
  sectionB: [],
  sectionC: [],
  sectionD: [],
  sectionE: [],
  sectionF: [],
  sectionG: [],
  sectionH: [],
  ...over,
});

function deepFreeze<T>(obj: T): T {
  if (obj && typeof obj === "object") {
    Object.freeze(obj);
    for (const v of Object.values(obj)) deepFreeze(v);
  }
  return obj;
}

describe("sceneProjection — shape", () => {
  it("SECTION_KEYS covers all eight scenes (the loadSample G/H bug class)", () => {
    expect(SECTION_KEYS).toEqual([
      "sectionA",
      "sectionB",
      "sectionC",
      "sectionD",
      "sectionE",
      "sectionF",
      "sectionG",
      "sectionH",
    ]);
  });

  it("enabledScenes defaults to all 8, honours enabledSceneCount, clamps", () => {
    expect(enabledScenes(pattern({}))).toEqual([...SCENE_LETTERS]);
    expect(enabledScenes(pattern({ enabledSceneCount: 3 }))).toEqual(["A", "B", "C"]);
    expect(enabledScenes(pattern({ enabledSceneCount: 99 }))).toHaveLength(8);
    expect(enabledScenes(pattern({ enabledSceneCount: 0 }))).toEqual(["A"]);
  });

  it("PATTERN_SCENE_FIELDS carries the per-cell arrays and NOT track identity/mix", () => {
    for (const f of ["steps", "pitchOffsets", "cellLengths", "swingAmount", "chordIndices"]) {
      expect(PATTERN_SCENE_FIELDS.has(f)).toBe(true);
    }
    // Swift's own exclusions (SequencerState.swift:2107-2120) — a scene switch must not touch these.
    for (const f of [
      "sampleId",
      "volume",
      "pan",
      "trackGain",
      "isMuted",
      "isStopped",
      "tone",
      "send1Level",
      "chokeGroup",
      "playbackMode",
      "trackType",
      "tuning",
      "voiceMode",
      "sampleStartMs",
      "loopEnabled",
    ]) {
      expect(PATTERN_SCENE_FIELDS.has(f)).toBe(false);
    }
  });
});

describe("projectScene — the pattern half", () => {
  it("scene A is the identity", () => {
    const p = pattern({});
    expect(projectScene(p, "A")).toBe(p);
  });

  it("an empty scene section inherits A unchanged (Swift's lazy-copy semantic)", () => {
    const p = pattern({});
    const projected = projectScene(p, "B");
    expect(projected.sectionA).toEqual(p.sectionA);
  });

  it("pattern fields switch; identity and mix do not", () => {
    const p = pattern({
      sectionB: [
        row({ steps: [false, true, true, false], volume: 0.1, sampleId: "OTHER", isMuted: true, swingAmount: 0.4 }),
      ],
    });
    const [t] = projectScene(p, "B").sectionA as Record<string, unknown>[];
    expect(t!.steps).toEqual([false, true, true, false]); // pattern — switched
    expect(t!.swingAmount).toBe(0.4); // pattern — switched
    expect(t!.volume).toBe(0.8); // mix — from A
    expect(t!.sampleId).toBe("S0"); // identity — from A
    expect(t!.isMuted).toBe(false); // mute — from A
  });

  it("rows match by id with index fallback (survives a reordered scene section)", () => {
    const p = pattern({
      sectionA: [row({ id: "T0" }), row({ id: "T1", steps: [false, false, false, false] })],
      sectionB: [
        row({ id: "T1", steps: [true, true, true, true] }),
        row({ id: "T0", steps: [false, true, false, true] }),
      ],
    });
    const rows = projectScene(p, "B").sectionA as Record<string, unknown>[];
    expect(rows[0]!.steps).toEqual([false, true, false, true]); // T0's scene row, found by id
    expect(rows[1]!.steps).toEqual([true, true, true, true]);
  });

  it("a conditional-encode key ABSENT from the scene row falls back to its default (deleted)", () => {
    const p = pattern({
      sectionA: [row({ rateLockRatio: 2 })],
      sectionB: [row({})], // no rateLockRatio → scene's value is the default 1.0
    });
    const [t] = projectScene(p, "B").sectionA as Record<string, unknown>[];
    expect("rateLockRatio" in t!).toBe(false);
  });

  it("never mutates its input (deep-frozen round trip)", () => {
    const p = deepFreeze(
      pattern({ sectionB: [row({ steps: [true, true, false, false] })] }),
    );
    expect(() => projectScene(p, "B")).not.toThrow();
  });

  it("projects the real fixture without loss: identity on A, stable structure on B", () => {
    const p = decodePatternFile(freshText);
    expect(projectScene(p, "A")).toBe(p);
    const b = projectScene(p, "B");
    expect((b.sectionA as unknown[]).length).toBe((p.sectionA as unknown[]).length);
    expect(b.bpm).toBe(p.bpm);
  });
});

describe("splitSceneEdit — the write half (edit a projected row, divide it back)", () => {
  it("a step edit is scene-local; a volume edit is global; A's pattern survives", () => {
    const oldBase = row({ steps: [true, false, false, false], volume: 0.8 });
    const oldScene = row({ steps: [false, false, false, true] });
    // The user, looking at scene B, drew a step AND moved the volume:
    const edited = row({ steps: [false, true, false, true], volume: 0.3 });

    const { baseRow, sceneRow } = splitSceneEdit(edited, oldBase, oldScene);
    expect(sceneRow.steps).toEqual([false, true, false, true]); // scene B's pattern
    expect(baseRow.steps).toEqual([true, false, false, false]); // scene A's pattern, untouched
    expect(baseRow.volume).toBe(0.3); // global — every scene hears it
    expect("volume" in sceneRow ? sceneRow.volume : oldScene.volume).toBe(0.8); // stale copy, ignored on load
  });

  it("round trip: split then re-project reproduces the edit in B and not in A", () => {
    const p = pattern({ sectionB: [row({})] });
    const projectedB = projectScene(p, "B").sectionA as Record<string, unknown>[];
    const edited = { ...projectedB[0]!, steps: [true, true, true, true], pan: 0.5 };

    const { baseRow, sceneRow } = splitSceneEdit(
      edited,
      (p.sectionA as Record<string, unknown>[])[0]!,
      (p.sectionB as Record<string, unknown>[])[0]!,
    );
    const next = { ...p, sectionA: [baseRow], sectionB: [sceneRow] } as PatternFileJson;

    const inB = projectScene(next, "B").sectionA as Record<string, unknown>[];
    expect(inB[0]!.steps).toEqual([true, true, true, true]); // the edit, heard in B
    expect(inB[0]!.pan).toBe(0.5); // global, heard in B
    const inA = projectScene(next, "A").sectionA as Record<string, unknown>[];
    expect(inA[0]!.steps).toEqual([true, false, false, false]); // A's pattern intact
    expect(inA[0]!.pan).toBe(0.5); // global, heard in A too
  });

  it("mutates neither input row", () => {
    const oldBase = deepFreeze(row({}));
    const oldScene = deepFreeze(row({ steps: [false, true, false, false] }));
    expect(() => splitSceneEdit(row({ steps: [true, true, false, false] }), oldBase, oldScene)).not.toThrow();
  });
});

describe("resolveSceneSettings — the pinned half (overlaySettings mirror)", () => {
  const layered = (pinnedKeys: string[]) =>
    pattern({
      sceneSettingsLayers: {
        C: {
          pinnedKeys,
          values: {
            bpm: 90,
            trackSettings: [
              {
                volume: 0.25,
                pan: -0.5,
                trackGain: 1.5,
                tone: 40,
                toneFilterMode: "lowPass",
                toneQ: 1.2,
                filterDrive: 3,
                stereoMode: 2,
                globalPitchOffset: 12,
              },
            ],
          },
        },
      },
    });

  it("no layer / no pinned keys → nothing overlays", () => {
    expect(resolveSceneSettings(pattern({}), "C").trackOverrides.size).toBe(0);
    expect(resolveSceneSettings(layered([]), "C").bpm).toBeUndefined();
  });

  it("pinned bpm reaches the projected pattern's bpm", () => {
    const p = layered(["bpm"]);
    expect(resolveSceneSettings(p, "C").bpm).toBe(90);
    expect(projectScene(p, "C").bpm).toBe(90);
    // …and only for the scene that pins it.
    expect(projectScene(p, "B").bpm).toBe(120);
  });

  it("pinned track keys land on the projected row; the tone key carries its cluster", () => {
    const p = layered(["track.0.volume", "track.0.tone", "track.0.globalPitchOffset"]);
    const [t] = projectScene(p, "C").sectionA as Record<string, unknown>[];
    expect(t!.volume).toBe(0.25);
    expect(t!.tone).toBe(40);
    expect(t!.toneFilterMode).toBe("lowPass"); // the cluster rides "tone" (BeatSequencer:11701)
    expect(t!.toneQ).toBe(1.2);
    expect(t!.filterDrive).toBe(3);
    expect(t!.globalPitchOffset).toBe(12);
    expect(t!.pan).toBe(0); // not pinned → base
  });

  it("keys outside the mapped vocabulary are skipped, never guessed", () => {
    const p = layered(["track.0.lfoPitchDepth", "track.99.volume", "nonsense", "track.0.pan"]);
    const { trackOverrides } = resolveSceneSettings(p, "C");
    expect(trackOverrides.get(0)).toEqual({ pan: -0.5 }); // only the mapped, in-range key
    expect(trackOverrides.has(99)).toBe(false);
  });
});
