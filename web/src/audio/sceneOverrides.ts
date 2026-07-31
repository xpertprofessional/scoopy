/**
 * SCENE OVERRIDES — the WRITE half of the pin mechanism (B2).
 *
 * `sceneProjection.resolveSceneSettings` has read `sceneSettingsLayers` since
 * P5-06; nothing has ever written it. These are the mutators, ported from
 * `BeatSequencer.swift`:
 *   · `pinToCurrentScene`     :11733
 *   · `unpinFromCurrentScene` :11745
 *   · `pushKeyToAllScenes`    :11759
 *   · `clearSceneOverrides`   :11771
 *   · `isPinnableKey`         :11711
 *
 * Pure and layer-shaped: every function takes the layers and returns fresh
 * ones, so the store keeps its immutable-update discipline and these stay
 * testable without a session.
 *
 * ⚠️ THE PINNABLE SET IS NARROWER THAN THE DONOR'S, ON PURPOSE.
 * `BeatSequencer.pinnableTrackFields` lists 30 fields and
 * `pinnableMasterKeys` 8. Our projection maps SEVEN keys in total — the rest
 * are enumerated as deliberately-skipped in `resolveSceneSettings`'s header
 * (master-bus state the WASM world does not model, LFO depths, sample-window
 * keys, …). Offering a wider set here would let someone pin `lfoPitchDepth`,
 * see it stored, and hear nothing — *"a menu item that appears to work and
 * silently does nothing"*, which is the exact failure `state/scenePins.ts`'s
 * header exists to prevent. The set grows when the projection does, and
 * `sceneOverrides.test.ts` fails if the two ever disagree.
 */
import type { PatternFileJson } from "../persist/patternFile.ts";
import type { SceneLetter } from "./sceneProjection.ts";

type Row = Record<string, unknown>;

/** Master-scope keys the projection honours. (The donor also allows seven
    master-bus keys the WASM world does not model — see the header.) */
export const PINNABLE_MASTER_KEYS = ["bpm"] as const;

/** Per-track fields the projection honours. Sends 1–4 are absent here for the
    donor's own reason: they are performative live values, never scene-local. */
export const PINNABLE_TRACK_FIELDS = [
  "volume",
  "pan",
  "tone",
  "trackGain",
  "stereoMode",
  "globalPitchOffset",
] as const;

/** The donor's `isPinnableKey`, over our narrower vocabulary. */
export function isPinnableKey(key: string): boolean {
  if ((PINNABLE_MASTER_KEYS as readonly string[]).includes(key)) return true;
  const parts = key.split(".");
  return (
    parts.length === 3 &&
    parts[0] === "track" &&
    Number.isInteger(Number(parts[1])) &&
    (PINNABLE_TRACK_FIELDS as readonly string[]).includes(parts[2]!)
  );
}

export interface SceneLayer {
  values: Row;
  pinnedKeys: string[];
}
export type SceneLayers = Record<string, SceneLayer>;

function layersOf(pattern: PatternFileJson): SceneLayers {
  const raw = (pattern as Record<string, unknown>).sceneSettingsLayers;
  return (raw && typeof raw === "object" ? (raw as SceneLayers) : {}) ?? {};
}

/** Which keys are pinned to `scene` right now. */
export function pinnedKeysFor(pattern: PatternFileJson, scene: SceneLetter): string[] {
  return layersOf(pattern)[scene]?.pinnedKeys ?? [];
}

/** Every scene that carries at least one override — what the pads dot. */
export function scenesWithOverrides(pattern: PatternFileJson): string[] {
  const layers = layersOf(pattern);
  return Object.keys(layers).filter((s) => (layers[s]?.pinnedKeys.length ?? 0) > 0);
}

/**
 * PIN — the key forks off the current sound.
 *
 * The donor flushes live settings into the base BEFORE forking
 * (`commitLiveSettings()` at :11736) so the scene's copy starts from what you
 * are hearing rather than from whatever was last saved. `live` is that capture:
 * the caller passes the resolved settings, because only it can see them.
 *
 * Already-pinned is a no-op, not an overwrite — re-pinning must not silently
 * re-seed a value the performer has since moved.
 */
export function pinKey(
  layers: SceneLayers,
  scene: SceneLetter,
  key: string,
  live: Row,
): SceneLayers {
  if (!isPinnableKey(key)) return layers;
  const layer = layers[scene] ?? { values: {}, pinnedKeys: [] };
  if (layer.pinnedKeys.includes(key)) return layers;
  return {
    ...layers,
    [scene]: { values: { ...live }, pinnedKeys: [...layer.pinnedKeys, key] },
  };
}

/**
 * UNPIN — "reset to global": the value reverts to the shared base and future
 * edits apply everywhere again.
 *
 * A layer whose last pin is removed is DELETED rather than left empty, matching
 * the donor's `layer.pinnedKeys.isEmpty ? nil : layer`. An empty layer would
 * make `scenesWithOverrides` report a scene that overrides nothing, and the pad
 * would wear a dot for state that is not there.
 */
export function unpinKey(layers: SceneLayers, scene: SceneLetter, key: string): SceneLayers {
  const layer = layers[scene];
  if (!layer?.pinnedKeys.includes(key)) return layers;
  const pinnedKeys = layer.pinnedKeys.filter((k) => k !== key);
  const next = { ...layers };
  if (pinnedKeys.length === 0) delete next[scene];
  else next[scene] = { ...layer, pinnedKeys };
  return next;
}

/**
 * PUSH TO ALL — and it is NOT "copy this value into every scene".
 *
 * ⚠️ Read `pushKeyToAllScenes` (:11759) before changing this. It writes the live
 * value into the BASE and then removes that key's pin from EVERY scene. The
 * result is one global value again — the key stops being scene-local anywhere.
 * "Copy into all layers" would leave eight independent forks that happen to
 * agree today and drift the moment one is edited, which is the opposite of what
 * the gesture means.
 */
export function pushKeyToAll(
  layers: SceneLayers,
  key: string,
): { layers: SceneLayers; clearedFrom: string[] } {
  const next: SceneLayers = {};
  const clearedFrom: string[] = [];
  for (const [scene, layer] of Object.entries(layers)) {
    if (!layer.pinnedKeys.includes(key)) {
      next[scene] = layer;
      continue;
    }
    clearedFrom.push(scene);
    const pinnedKeys = layer.pinnedKeys.filter((k) => k !== key);
    if (pinnedKeys.length > 0) next[scene] = { ...layer, pinnedKeys };
  }
  return { layers: next, clearedFrom };
}

/** Drop every override of `scene`, so it mirrors the shared base again. */
export function clearSceneOverrides(layers: SceneLayers, scene: SceneLetter): SceneLayers {
  if (!layers[scene]) return layers;
  const next = { ...layers };
  delete next[scene];
  return next;
}
