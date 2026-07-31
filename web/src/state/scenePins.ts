import { create } from "zustand";
import { SceneUiState } from "../../protocol/schema.ts";
import type { MenuItem } from "../design/ContextMenu.tsx";
import {
  PINNABLE_MASTER_KEYS,
  PINNABLE_TRACK_FIELDS,
  isPinnableKey as isPinnableHere,
  pinnedKeysFor,
  scenesWithOverrides,
} from "../audio/sceneOverrides.ts";
import { SCENE_LETTERS } from "../audio/sceneProjection.ts";
import { deckOf, useCompanion } from "../store/companionEngine.ts";

/**
 * Scene overrides (CM-3) — native `sceneOverrideContextMenuItems`
 * (TrackFXSettingsView:699).
 *
 * A parameter edit normally flows to the shared GLOBAL base, so every scene sees
 * it. **Pinning** makes the parameter scene-local: the current scene keeps its
 * own value and the others keep the base. The menu offers the inverse of
 * whatever the key currently is.
 *
 * `isPinnableKey` is reproduced here as a pure function over the two SETS Swift
 * publishes (never a hand-copied list — a copy drifts, and the failure mode is a
 * menu item that appears to work and silently does nothing). Swift re-checks it
 * on receive anyway; this only decides what to SHOW.
 */

/** What a control pins. `key` is native's string: "bpm" / "track.<row>.pan". */
export type ScenePinTarget = { key: string; deck?: number };

const EMPTY: SceneUiState = {
  enabled: [],
  current: "A",
  queued: [],
  loopEnabled: false,
  switchMode: "scheduled",
  cleanCut: false,
  latched: false,
  muted: false,
  canAdd: false,
  sceneLabel: "1",
  pinnedKeys: [],
  pinnableMasterKeys: [],
  pinnableTrackFields: [],
  scenesWithOverrides: [],
  muteGroupCount: 0,
};

interface Store {
  state: SceneUiState;
  /** Which deck the pinnable state describes — "the deck being EDITED". */
  deck: number;
}

export const useScenePinStore = create<Store>(() => ({ state: EMPTY, deck: 0 }));

/**
 * THE FEED, REPOINTED AT THE COMPANION (B2).
 *
 * ⚠️ This used to mirror a `scenes` UiState topic and `getUiState` it on mount.
 * **Nothing has ever published that topic** — not `SlDispatch`, not
 * `MergedApp`, not `browserLink` — so `state` sat at `EMPTY` forever, which
 * made `isPinnableKey` false for every key, which made `buildScenePinItems`
 * return `[]` every time. The whole pin menu was structurally invisible: built,
 * wired onto every DragBox, and unreachable. `MasterRow` has been passing
 * `scenePin={{ key: "bpm", deck }}` the entire time.
 *
 * The companion owns the pattern document, so it is the honest source. This
 * derives the wire shape from it rather than waiting for a publisher.
 */
function stateFor(deck: number): SceneUiState {
  const d = deckOf(useCompanion.getState(), deck);
  const pattern = d.session?.pattern;
  if (!pattern) return EMPTY;
  const idx = SCENE_LETTERS.indexOf(d.scene);
  return {
    ...EMPTY,
    current: d.scene,
    switchMode: d.switchMode === "seamless" ? "seamlessImmediate" : d.switchMode === "restart" ? "restartImmediate" : "scheduled",
    cleanCut: d.cleanCut,
    latched: d.sceneLatched,
    // The label a pad wears: scenes persist as letters and display as 1–8.
    sceneLabel: String((idx < 0 ? 0 : idx) + 1),
    pinnedKeys: pinnedKeysFor(pattern, d.scene),
    // ⚠️ OUR sets, not the donor's wider ones — pinning a key the projection
    // ignores would store state and change nothing audible. See
    // `audio/sceneOverrides.ts`'s header.
    pinnableMasterKeys: [...PINNABLE_MASTER_KEYS],
    pinnableTrackFields: [...PINNABLE_TRACK_FIELDS],
    scenesWithOverrides: scenesWithOverrides(pattern),
  };
}

/** Point the pin state at `deck` and keep it fresh. Called by whichever binding
    owns the grid being edited; the last mount wins, which is what "the deck
    being EDITED" means. */
export function attachScenePins(deck = 0): () => void {
  const refresh = () => useScenePinStore.setState({ deck, state: stateFor(deck) });
  refresh();
  const off = useCompanion.subscribe(refresh);
  return () => {
    off();
    useScenePinStore.setState({ state: EMPTY, deck: 0 });
  };
}

/**
 * Exact mirror of `BeatSequencer.isPinnableKey` (:10956): a master key, or
 * `track.<int>.<field>` with a pinnable field. Sends are deliberately NOT
 * pinnable — they are performative live values (BeatSequencer :10943).
 */
export function isPinnableKey(key: string, state: SceneUiState): boolean {
  if (!key) return false;
  // Still driven by the STATE's sets rather than the module constant, because a
  // host that publishes a different vocabulary must be able to say so — but the
  // state is now seeded from `sceneOverrides`, so the two cannot disagree here.
  if (state.pinnableMasterKeys.includes(key)) return true;
  const parts = key.split(".");
  if (parts.length !== 3 || parts[0] !== "track") return false;
  if (!/^\d+$/.test(parts[1] ?? "")) return false;
  return state.pinnableTrackFields.includes(parts[2] ?? "");
}

/** Re-exported so a caller with no `SceneUiState` in hand (a menu builder
    outside the store) can ask the same question. */
export { isPinnableHere };

export function isPinnedToCurrentScene(key: string, state: SceneUiState): boolean {
  return state.pinnedKeys.includes(key);
}

/**
 * THE ACTIONS, REPOINTED TOO. They sent `sceneOverride` — the second half of
 * the same dead pair, unanswered by every host. They call the companion's
 * override ops now.
 *
 * A target that names its own deck wins; one that does not uses the deck the
 * store is pointed at, which is the grid being edited. `MasterRow` passes a
 * deck; some track controls do not, and falling back to a hardcoded 0 would
 * pin deck 2's control onto deck 0's document.
 */
function send(op: "pin" | "unpin" | "pushToAll", t: ScenePinTarget) {
  const deck = t.deck ?? useScenePinStore.getState().deck;
  const c = useCompanion.getState();
  if (op === "pin") c.pinToScene(t.key, deck);
  else if (op === "unpin") c.unpinFromScene(t.key, deck);
  else c.pushSceneKeyToAll(t.key, deck);
}

export const pinToScene = (t: ScenePinTarget) => send("pin", t);
export const unpinFromScene = (t: ScenePinTarget) => send("unpin", t);
export const pushKeyToAllScenes = (t: ScenePinTarget) => send("pushToAll", t);

/**
 * The scene section of a box's right-click menu. Renders NOTHING when the key
 * isn't pinnable — native's guard, and the reason sends show no scene items.
 */
export function buildScenePinItems(
  t: ScenePinTarget,
  state: SceneUiState,
  actions: {
    pin: (t: ScenePinTarget) => void;
    unpin: (t: ScenePinTarget) => void;
    pushToAll: (t: ScenePinTarget) => void;
  } = { pin: pinToScene, unpin: unpinFromScene, pushToAll: pushKeyToAllScenes },
): MenuItem[] {
  if (!isPinnableKey(t.key, state)) return [];
  if (isPinnedToCurrentScene(t.key, state)) {
    return [
      { kind: "item", label: "Reset to Global", onSelect: () => actions.unpin(t) },
      {
        kind: "item",
        label: "Push Value to All Scenes",
        onSelect: () => actions.pushToAll(t),
      },
    ];
  }
  return [
    {
      kind: "item",
      label: `Make Scene-Specific (Scene ${state.sceneLabel})`,
      onSelect: () => actions.pin(t),
    },
  ];
}
