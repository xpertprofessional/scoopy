import { create } from "zustand";
import { SceneUiState } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";

/**
 * P5-05 scenes in TS. Domain Ownership holds (scenes stay Swift — row 7):
 * this store mirrors the "scenes" topic and exposes typed INTENT senders
 * mirroring the native scene-cell gestures 1:1. There is deliberately NO
 * prediction chain here (unlike the patternStore): scene switching is
 * transport-coupled (scheduled vs immediate depends on isPlaying and LCM
 * boundaries), so the web never guesses — pads render pushed state only.
 * Scene-LAYER reducers (base + pinned overrides application) arrive with
 * the P5-06 PatternFile model, where they become fixture-testable.
 */

/** Scenes are per-sequencer: each deck owns its own scene set, keyed by deck. */
export interface ScenesState {
  byDeck: Record<number, SceneUiState>;
}

export const useScenesStore = create<ScenesState>(() => ({ byDeck: {} }));

/** Subscribe the store to each deck's `scenes/<d>` topic. Returns the unsubscribe. */
export function attachScenes(link: EngineLink, deckCount = 3): () => void {
  const offs: (() => void)[] = [];
  for (let d = 0; d < deckCount; d++) {
    const deck = d;
    const topic = `scenes/${deck}`;
    offs.push(
      link.onUiState(topic, (raw) => {
        const parsed = SceneUiState.safeParse(raw);
        if (!parsed.success) {
          console.error(`${topic} rejected:`, parsed.error.issues, raw);
          return;
        }
        useScenesStore.setState((s) => ({ byDeck: { ...s.byDeck, [deck]: parsed.data } }));
      }),
    );
    link.command("getUiState", { topic }).catch(() => {});
  }
  return () => offs.forEach((off) => off());
}

/* `sceneRows` (the native 4+4 A–D/E–H row filter) was REMOVED 2026-07-12: the
   pads render in one row of regular-size buttons now, so the split has no
   meaning. It only ever existed to fit two rows inside the toolbar's bar
   height, and the cluster has since moved to the master track row. */

/** Scene letter → the 1-based display label (native displayLabel: scenes
 *  persist as letters but display as 1–8 by A–H position). */
export function sceneDisplayLabel(letter: string): string {
  const idx = "ABCDEFGH".indexOf(letter);
  return idx >= 0 ? String(idx + 1) : letter;
}

/** Label for the add slot. Native nextPatternSceneLetter is
 *  `allScenes[enabledPatternScenes.count].displayLabel` — scenes are always
 *  added in A→H order, so the next label is just the 1-based count + 1.
 *  null when the grid is full (canAdd false). */
export function nextSceneLabel(s: SceneUiState): string | null {
  if (!s.canAdd || s.enabled.length >= 8) return null;
  return String(s.enabled.length + 1);
}

// --- intent senders (1:1 with PdSceneCell.handleClick + hotkeys 9/0) -------
// Every op names its DECK: scenes are per-sequencer, so a pad in deck B's
// transport section must never act on deck A's scene set.

export function sendSceneClick(
  link: EngineLink,
  deck: number,
  scene: string,
  mods: { shift?: boolean; meta?: boolean; alt?: boolean } = {},
) {
  if (mods.alt && mods.shift) {
    link.command("patternScene", { op: "startImmediate", deck, scene }).catch(() => {});
  } else if (mods.meta) {
    link.command("patternScene", { op: "runImmediate", deck, scene }).catch(() => {});
  } else {
    link
      .command("patternScene", { op: "activate", deck, scene, queue: mods.shift ?? false })
      .catch(() => {});
  }
}

export function sendSceneMove(link: EngineLink, deck: number, scene: string, dir: 1 | -1) {
  link.command("patternScene", { op: "move", deck, scene, value: dir }).catch(() => {});
}

export function sendSceneAdd(link: EngineLink, deck: number) {
  link.command("patternScene", { op: "add", deck }).catch(() => {});
}

export function sendSceneRemove(link: EngineLink, deck: number, scene: string) {
  link.command("patternScene", { op: "remove", deck, scene }).catch(() => {});
}

export function sendSceneSwitchMode(
  link: EngineLink,
  deck: number,
  mode: SceneUiState["switchMode"],
) {
  link.command("patternScene", { op: "setSwitchMode", deck, mode }).catch(() => {});
}

/** Boundary clean-cut toggle: fade all still-ringing voices (~10 ms) at the
 *  switch boundary instead of letting the old scene ring out. Explicit `on`
 *  sets; native treats an omitted `on` as a toggle. */
export function sendSceneCleanCut(link: EngineLink, deck: number, on: boolean) {
  link.command("patternScene", { op: "setCleanCut", deck, on }).catch(() => {});
}

export function sendSceneToggleLatch(link: EngineLink, deck: number) {
  link.command("patternScene", { op: "toggleLatch", deck }).catch(() => {});
}

export function sendSceneToggleMute(link: EngineLink, deck: number) {
  link.command("patternScene", { op: "toggleMute", deck }).catch(() => {});
}

/** CM-5: the MUTE button's right-click menu (MasterTrackRowView:1628). */
export function sendSceneClearMuteGroup(link: EngineLink, deck: number) {
  link.command("patternScene", { op: "clearMuteGroup", deck }).catch(() => {});
}

/** CM-5: drop one scene's pinned values, from its pad menu (:1717). */
export function sendSceneClearOverrides(link: EngineLink, deck: number, scene: string) {
  link.command("patternScene", { op: "clearOverrides", deck, scene }).catch(() => {});
}

/**
 * MB (menubar.md §10): the menu bar's "Copy Pattern" (⇧⌘C), rehomed onto the
 * scene pad's right-click. Acts on the deck's CURRENT scene — faithful to
 * native `copyCurrentSection` (no scene arg; the buffer is a shared static, so
 * a copy in deck A can paste into deck B). The action stays Swift-owned (§3):
 * scenes are Swift's, so this is an INTENT, not a TS reducer.
 */
export function sendSceneCopyPattern(link: EngineLink, deck: number) {
  link.command("patternScene", { op: "copyPattern", deck }).catch(() => {});
}

/** MB: "Paste Pattern" (⇧⌘V) — overwrite the deck's current scene from the buffer. */
export function sendScenePastePattern(link: EngineLink, deck: number) {
  link.command("patternScene", { op: "pastePattern", deck }).catch(() => {});
}
