import { useState } from "react";
import type { SceneUiState } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { Button } from "../design/controls.tsx";
import { muteGroupColor } from "../design/tokens.ts";
import { useContextMenu, type MenuItem } from "../design/ContextMenu.tsx";
import {
  nextSceneLabel,
  sceneDisplayLabel,
  sendSceneAdd,
  sendSceneClick,
  sendSceneMove,
  sendSceneRemove,
  sendSceneSwitchMode,
  sendSceneCleanCut,
  sendSceneToggleLatch,
  sendSceneToggleMute,
  sendSceneClearMuteGroup,
  sendSceneClearOverrides,
  sendSceneCopyPattern,
  sendScenePastePattern,
  useScenesStore,
} from "../state/scenesStore.ts";
import "./scenes.css";

/**
 * Pattern-scene cluster (P4-05e), mounted ONCE PER DECK inside that deck's
 * TRANSPORT BOX, on a row of its own (user, 2026-07-13): switching a snapshot
 * is a TRANSPORT act — it schedules against the pattern boundary exactly like
 * launching a deck — so it belongs with the deck's transport, not in the master
 * row (djmode.md §4C).
 *
 * Scenes are per-sequencer: deck A, B and C each own an independent scene set,
 * so each deck's transport block carries its own pads and its snapshots are
 * operated independently (a global cluster could only ever address whichever
 * deck happened to be selected).
 *
 * Gestures + colours mirror native `PdSceneCell` (ContentView :13239). The
 * LAYOUT does not: native stacked the pads 4+4 to squeeze them into the
 * toolbar's bar height. On a row of its own that constraint is gone, so it is
 * ONE row of regular-size buttons, followed by the S/R/0 switch-mode picker,
 * SCN and MUTE.
 *
 * Domain Ownership holds (ledger row 7): scenes stay Swift. Every gesture is
 * an INTENT carrying its deck — scheduling, morph and persistence remain in
 * BeatSequencer, and the pads render only the pushed `scenes/<deck>` topic (no
 * prediction chain: a click's effect is transport-coupled, so the web never
 * guesses).
 *
 * The native cluster in MasterTrackRowView is deliberately left in place
 * (TR-NODELETE).
 */

const SWITCH_MODES: {
  mode: SceneUiState["switchMode"];
  label: string;
  title: string;
}[] = [
  { mode: "scheduled", label: "S", title: "Scheduled — switch at the next pattern boundary" },
  { mode: "seamlessImmediate", label: "R", title: "Run — switch immediately, keep the playhead position" },
  { mode: "restartImmediate", label: "0", title: "Start — switch immediately and restart from step 0" },
];

/** Store-connected cluster for ONE deck (what each transport deck block mounts). */
export function ScenePads({ link, deck }: { link: EngineLink | null; deck: number }) {
  const scenes = useScenesStore((s) => s.byDeck[deck]);
  if (!scenes) return null;
  return <ScenePadsView scenes={scenes} link={link} deck={deck} />;
}

/**
 * Pure view — all layout/state rules live here so they are testable.
 * (zustand v5 serves `getInitialState` as the SSR snapshot, so a
 * store-connected component renders empty under renderToStaticMarkup.)
 */
export function ScenePadsView({
  scenes,
  link,
  deck,
}: {
  scenes: SceneUiState;
  link: EngineLink | null;
  deck: number;
}) {
  const { openMenu: showMenu } = useContextMenu();

  // ONE row of full-size buttons: eight targets you hit mid-set, at the same
  // size as every other button in the app (see the file header).
  const pads = scenes.enabled;
  const addLabel = nextSceneLabel(scenes);

  const padClass = (scene: string) => {
    const isScheduled = scenes.queued.includes(scene);
    // ds-hot LAST: tests match on the "scene-pad is-*" prefix. The pads' slop
    // is scoped to 1px (scenes.css) because their gutter is only 2px.
    if (scenes.current === scene) return "scene-pad is-active ds-hot";
    if (isScheduled && scenes.loopEnabled) return "scene-pad is-loop ds-hot";
    if (isScheduled) return "scene-pad is-scheduled ds-hot";
    return "scene-pad ds-hot";
  };

  const openMenu = (e: React.MouseEvent, scene: string) => {
    e.preventDefault();
    const idx = scenes.enabled.indexOf(scene);
    const items: MenuItem[] = [];
    // Native PdSceneCell "Reorder" section — the guards mirror
    // canMovePatternSceneEarlier/Later over the display order.
    if (idx > 0) {
      items.push({ kind: "item", label: "Move Left", onSelect: () => link && sendSceneMove(link, deck, scene, -1) });
    }
    if (idx >= 0 && idx < scenes.enabled.length - 1) {
      items.push({ kind: "item", label: "Move Right", onSelect: () => link && sendSceneMove(link, deck, scene, 1) });
    }
    // Copy/Paste Pattern — the menu bar's ⇧⌘C/⇧⌘V "Scene Operations", rehomed
    // here (menubar.md §10). They act on the deck's CURRENT scene, not `scene`:
    // that is faithful to native `copyCurrentSection`/`pasteToCurrentSection`,
    // which had no scene context. The buffer is a shared static, so Copy in one
    // deck and Paste in another works. Paste is not greyed out (native did not
    // grey it either — an empty buffer is a no-op).
    if (items.length) items.push({ kind: "sep" });
    items.push({ kind: "item", label: "Copy Pattern", onSelect: () => link && sendSceneCopyPattern(link, deck) });
    items.push({ kind: "item", label: "Paste Pattern", onSelect: () => link && sendScenePastePattern(link, deck) });
    // Native "Scene Settings" — disabled (not hidden) when the scene has no
    // overrides, so the menu still tells you the scene is clean.
    if (items.length) items.push({ kind: "sep" });
    items.push({
      kind: "item",
      label: "Clear Scene Overrides",
      disabled: !scenes.scenesWithOverrides.includes(scene),
      onSelect: () => link && sendSceneClearOverrides(link, deck, scene),
    });
    // Native rule: any scene is removable as long as more than one exists.
    if (scenes.enabled.length > 1) {
      if (items.length) items.push({ kind: "sep" });
      items.push({ kind: "item", label: "Remove Scene", onSelect: () => link && sendSceneRemove(link, deck, scene) });
    }
    if (!items.length) return;
    showMenu(items, e.clientX, e.clientY);
  };

  const pad = (scene: string) => (
    <button
      key={scene}
      className={padClass(scene)}
      title="click = switch/schedule · ⇧ queue · ⌘ run now · ⌥⇧ restart from 0 · right-click to reorder"
      onClick={(e) =>
        link && sendSceneClick(link, deck, scene, { shift: e.shiftKey, meta: e.metaKey, alt: e.altKey })
      }
      onContextMenu={(e) => openMenu(e, scene)}
    >
      {sceneDisplayLabel(scene)}
    </button>
  );

  const addSlot = (
    <button
      className="scene-add"
      title={`Add pattern scene ${addLabel ?? ""}`}
      onClick={() => link && sendSceneAdd(link, deck)}
    >
      {addLabel}
    </button>
  );

  return (
    <div className="scene-cluster">
      <div className="scene-pads">
        {pads.map(pad)}
        {addLabel !== null && addSlot}
      </div>

      <div className="scene-mode">
        {SWITCH_MODES.map((m) => (
          <button
            key={m.mode}
            className={scenes.switchMode === m.mode ? "is-on" : undefined}
            title={m.title}
            onClick={() => link && sendSceneSwitchMode(link, deck, m.mode)}
          >
            {m.label}
          </button>
        ))}
      </div>

      {/* CUT is orthogonal to the S/R/0 picker (a toggle, not a mode): at the
          switch boundary every still-ringing voice fades (~10 ms) so the old
          scene stops instead of ringing out. FX tails keep ringing. */}
      <div className="scene-mode">
        <button
          className={scenes.cleanCut ? "is-on" : undefined}
          title={
            scenes.cleanCut
              ? "Clean cut ON: scene switches fade the old scene's voices at the boundary. Click for ring-out."
              : "Clean cut OFF: the old scene's voices ring out across a switch. Click to cut at the boundary."
          }
          onClick={() => link && sendSceneCleanCut(link, deck, !scenes.cleanCut)}
        >
          CUT
        </button>
      </div>

      <Button
        label="SCN"
        active={scenes.latched}
        title={
          scenes.latched
            ? "SCENE EDIT on: edits pin to the current scene. Click for global editing."
            : "SCENE EDIT off: edits apply to all scenes. Click to pin to the current scene."
        }
        onClick={() => link && sendSceneToggleLatch(link, deck)}
      />
      {/* The MUTE latch and its member tracks' M buttons are ONE group, so they
          share one identity color (DESIGN-SYSTEM §2b). They used not to: the
          button lit --accent while its members ringed --warn, which made the two
          halves of the same object look unrelated. The halo here says "a group
          exists" even while the latch is released — that is otherwise invisible
          until you right-click for the member count. */}
      <span
        className={`sem sem-latch${scenes.muteGroupCount > 0 ? " sem-ring" : ""}${
          scenes.muted ? " sem-ring-live" : ""
        }`}
        style={{ "--sem-color": muteGroupColor() } as React.CSSProperties}
      >
        <Button
          label="MUTE"
          hot
          active={scenes.muted}
          title={
            scenes.muted
              ? "Mute group active. Click a track's M to add/remove; click here to release."
              : "Click to mute the group, then click track M buttons to edit members."
          }
          onClick={() => link && sendSceneToggleMute(link, deck)}
          onContextMenu={(e) => {
            e.preventDefault();
            const n = scenes.muteGroupCount;
            showMenu(
              [
                {
                  kind: "item",
                  label: "Clear Group",
                  disabled: n === 0,
                  onSelect: () => link && sendSceneClearMuteGroup(link, deck),
                },
                { kind: "sep" },
                { kind: "info", label: `${n} member${n === 1 ? "" : "(s)"}` },
              ],
              e.clientX,
              e.clientY,
            );
          }}
        />
      </span>

    </div>
  );
}
