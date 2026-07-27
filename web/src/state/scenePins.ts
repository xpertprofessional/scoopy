import { create } from "zustand";
import { SceneUiState } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import type { MenuItem } from "../design/ContextMenu.tsx";

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
  link: EngineLink | null;
}

export const useScenePinStore = create<Store>(() => ({ state: EMPTY, link: null }));

/**
 * Mirror the deck-less "scenes" topic — the deck whose grid is being EDITED.
 * (The per-deck `scenes/<d>` topics belong to the transport strip's pads.)
 */
export function attachScenePins(link: EngineLink): () => void {
  useScenePinStore.setState({ link });
  const off = link.onUiState("scenes", (raw) => {
    const parsed = SceneUiState.safeParse(raw);
    if (!parsed.success) {
      console.error("scenes rejected:", parsed.error.issues, raw);
      return;
    }
    useScenePinStore.setState({ state: parsed.data });
  });
  link.command("getUiState", { topic: "scenes" }).catch(() => {});
  return () => {
    off();
    useScenePinStore.setState({ link: null, state: EMPTY });
  };
}

/**
 * Exact mirror of `BeatSequencer.isPinnableKey` (:10956): a master key, or
 * `track.<int>.<field>` with a pinnable field. Sends are deliberately NOT
 * pinnable — they are performative live values (BeatSequencer :10943).
 */
export function isPinnableKey(key: string, state: SceneUiState): boolean {
  if (!key) return false;
  if (state.pinnableMasterKeys.includes(key)) return true;
  const parts = key.split(".");
  if (parts.length !== 3 || parts[0] !== "track") return false;
  if (!/^\d+$/.test(parts[1] ?? "")) return false;
  return state.pinnableTrackFields.includes(parts[2] ?? "");
}

export function isPinnedToCurrentScene(key: string, state: SceneUiState): boolean {
  return state.pinnedKeys.includes(key);
}

function send(op: "pin" | "unpin" | "pushToAll", t: ScenePinTarget) {
  const { link } = useScenePinStore.getState();
  if (!link) return;
  const params: Record<string, unknown> = { op, key: t.key };
  if (t.deck !== undefined) params.deck = t.deck;
  link.command("sceneOverride", params).catch(() => {});
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
