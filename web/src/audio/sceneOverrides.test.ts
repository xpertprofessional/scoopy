/**
 * The scene-override mutators, and the drift guard that keeps the pinnable
 * vocabulary honest.
 */
import { describe, expect, it } from "vitest";

import {
  PINNABLE_MASTER_KEYS,
  PINNABLE_TRACK_FIELDS,
  clearSceneOverrides,
  isPinnableKey,
  pinKey,
  pinnedKeysFor,
  pushKeyToAll,
  scenesWithOverrides,
  unpinKey,
  type SceneLayers,
} from "./sceneOverrides.ts";
import { resolveSceneSettings } from "./sceneProjection.ts";
import type { PatternFileJson } from "../persist/patternFile.ts";
import type { SceneLetter } from "./sceneProjection.ts";

const live = { bpm: 128, trackSettings: [{ volume: 0.4, pan: -0.2, trackGain: 0.9 }] };

describe("what may be pinned", () => {
  it("accepts the master and track keys the projection maps", () => {
    expect(isPinnableKey("bpm")).toBe(true);
    expect(isPinnableKey("track.0.volume")).toBe(true);
    expect(isPinnableKey("track.12.globalPitchOffset")).toBe(true);
  });

  it("refuses malformed keys rather than storing something inert", () => {
    expect(isPinnableKey("track.volume")).toBe(false);
    expect(isPinnableKey("track.x.volume")).toBe(false);
    expect(isPinnableKey("track.0.volume.extra")).toBe(false);
    expect(isPinnableKey("")).toBe(false);
  });

  it("refuses keys the DONOR allows but this projection does not honour", () => {
    // The donor's pinnableTrackFields has 30 entries; resolveSceneSettings maps
    // six. Offering the rest would store a pin that changes nothing audible —
    // "a menu item that appears to work and silently does nothing", which is
    // the failure state/scenePins.ts's header exists to prevent.
    expect(isPinnableKey("track.0.lfoPitchDepth")).toBe(false);
    expect(isPinnableKey("track.0.sampleStartMs")).toBe(false);
    expect(isPinnableKey("masterVolume")).toBe(false);
  });

  /**
   * THE DRIFT GUARD. Every key this module offers must actually reach the
   * projection — the two lists are in different files and would otherwise
   * diverge silently, which is precisely how a pin becomes decorative.
   */
  it("every offered key produces a real override through resolveSceneSettings", () => {
    for (const field of PINNABLE_TRACK_FIELDS) {
      const key = `track.0.${field}`;
      const pattern = {
        sceneSettingsLayers: {
          A: { values: { trackSettings: [{ [field]: 0.33 }] }, pinnedKeys: [key] },
        },
      } as unknown as PatternFileJson;
      const { trackOverrides } = resolveSceneSettings(pattern, "A" as SceneLetter);
      expect(trackOverrides.has(0), `${key} reaches the projection`).toBe(true);
    }
    for (const key of PINNABLE_MASTER_KEYS) {
      const pattern = {
        sceneSettingsLayers: { A: { values: { [key]: 111 }, pinnedKeys: [key] } },
      } as unknown as PatternFileJson;
      const resolved = resolveSceneSettings(pattern, "A" as SceneLetter);
      expect(resolved.bpm, `${key} reaches the projection`).toBe(111);
    }
  });
});

describe("pin", () => {
  it("forks the key off the CURRENT sound, not off what was last saved", () => {
    const out = pinKey({}, "A" as SceneLetter, "track.0.volume", live);
    expect(out.A?.pinnedKeys).toEqual(["track.0.volume"]);
    expect(out.A?.values).toEqual(live);
  });

  it("is a no-op when already pinned — never a silent re-seed", () => {
    // Re-pinning must not overwrite a value the performer has since moved.
    const first = pinKey({}, "A" as SceneLetter, "bpm", live);
    const again = pinKey(first, "A" as SceneLetter, "bpm", { bpm: 999 });
    expect(again).toBe(first);
  });

  it("refuses a key outside the vocabulary", () => {
    expect(pinKey({}, "A" as SceneLetter, "track.0.lfoPitchDepth", live)).toEqual({});
  });

  it("leaves other scenes alone", () => {
    let l: SceneLayers = pinKey({}, "A" as SceneLetter, "bpm", live);
    l = pinKey(l, "B" as SceneLetter, "track.0.pan", live);
    expect(pinnedKeysFor({ sceneSettingsLayers: l } as never, "A" as SceneLetter)).toEqual(["bpm"]);
    expect(pinnedKeysFor({ sceneSettingsLayers: l } as never, "B" as SceneLetter)).toEqual([
      "track.0.pan",
    ]);
  });
});

describe("unpin", () => {
  it("removes the key and keeps the rest of the layer", () => {
    let l = pinKey({}, "A" as SceneLetter, "bpm", live);
    l = pinKey(l, "A" as SceneLetter, "track.0.pan", live);
    const out = unpinKey(l, "A" as SceneLetter, "bpm");
    expect(out.A?.pinnedKeys).toEqual(["track.0.pan"]);
  });

  it("DELETES a layer whose last pin goes, so no scene claims an empty override", () => {
    // The donor's `pinnedKeys.isEmpty ? nil : layer`. An empty layer would make
    // the pad wear an override dot for state that is not there.
    const l = pinKey({}, "A" as SceneLetter, "bpm", live);
    const out = unpinKey(l, "A" as SceneLetter, "bpm");
    expect(out.A).toBeUndefined();
    expect(scenesWithOverrides({ sceneSettingsLayers: out } as never)).toEqual([]);
  });

  it("is a no-op for a key that was never pinned", () => {
    const l = pinKey({}, "A" as SceneLetter, "bpm", live);
    expect(unpinKey(l, "A" as SceneLetter, "track.0.pan")).toBe(l);
  });
});

describe("push to all", () => {
  it("clears the pin from EVERY scene — it does not copy into them", () => {
    // ⚠️ The donor writes the value into the BASE and drops the forks. Copying
    // into all eight layers would leave independent values that agree today and
    // drift the moment one is edited.
    let l = pinKey({}, "A" as SceneLetter, "bpm", live);
    l = pinKey(l, "B" as SceneLetter, "bpm", live);
    l = pinKey(l, "C" as SceneLetter, "track.0.pan", live);
    const { layers, clearedFrom } = pushKeyToAll(l, "bpm");
    expect(clearedFrom.sort()).toEqual(["A", "B"]);
    expect(layers.A).toBeUndefined();
    expect(layers.B).toBeUndefined();
    // A scene pinning something ELSE keeps its layer.
    expect(layers.C?.pinnedKeys).toEqual(["track.0.pan"]);
  });
});

describe("clear overrides", () => {
  it("drops the whole layer so the scene mirrors the base again", () => {
    let l = pinKey({}, "A" as SceneLetter, "bpm", live);
    l = pinKey(l, "A" as SceneLetter, "track.0.pan", live);
    expect(clearSceneOverrides(l, "A" as SceneLetter).A).toBeUndefined();
  });
});
