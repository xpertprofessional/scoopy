import { useEffect, useRef } from "react";
import { currentTokens } from "./tokens.ts";
import { useContextMenu, type MenuItem } from "./ContextMenu.tsx";
import {
  buildMidiLearnItems,
  isLearningTarget,
  mappingFor,
  useMidiLearnStore,
  type LearnTarget,
} from "../state/midiLearn.ts";
import {
  buildScenePinItems,
  isPinnedToCurrentScene,
  useScenePinStore,
  type ScenePinTarget,
} from "../state/scenePins.ts";
import {
  installFocusKeyboard,
  registerFocusTarget,
  useFocusModel,
  useFocusScope,
} from "./focusModel.ts";
import { isDoubleTap, type TapStamp } from "./touchGestures.ts";

/**
 * DragBox — the parameter focus target (INTERACTION-MODEL.md; pairs with
 * GeoRange in a ParamRow). DraggableNumberBox parity:
 * - click        → acquire parameter focus (arms ö/ä browsing)
 * - vertical drag→ adjust (sensitivity token; Option/Alt = fine)
 * - double-click → reset to defaultValue (tokens.control.dragBox
 *                  .doubleClickReset — boxes only, NEVER sliders)
 * - focus ring   → visible accent border (focus must be seen)
 * - right-click  → the BASE menu ("Enter value…") plus any `menu` extras the
 *                  panel passes (native `extraContextMenu`)
 */

/** DragBox props that also define its right-click menu. */
export type DragBoxMenuSource = {
  value: number;
  min: number;
  max: number;
  onChange: (v: number, intent?: EditIntent) => void;
  /** Extra items appended after the base menu (native `extraContextMenu`). */
  menu?: MenuItem[];
  /** Names this control to MIDILearnSystem; omit = not learnable. */
  learn?: LearnTarget;
  /** The scene-override key ("bpm" / "track.<row>.pan"); omit = not pinnable. */
  scenePin?: ScenePinTarget;
  /** "Map to Modifier" items (CM-4); the panel builds them from its mod slots. */
  modMenu?: MenuItem[];
};

/**
 * How the value arrived — the only thing that separates a CONTINUOUS gesture
 * from a DECLARED value, which is what a multi-track fan-out has to know.
 *
 * Native's rule (ContentView:4974): dragging with several tracks selected sends
 * a RELATIVE delta, so the tracks keep the offsets between them — a mix stays a
 * mix instead of collapsing to one flat value. But a reset or a typed number is
 * a statement about the value itself ("all of these are 0 dB now"), and native
 * sends those ABSOLUTE (`updateMultipleTracksPan(value: 0)`, :4312).
 *
 * Every box reports its intent; only the ops in `SELECTION_FANOUT` act on it,
 * and only while more than one track is selected. A single-track edit ignores
 * it entirely.
 */
export type EditIntent = "drag" | "set";

/**
 * The box's menu, in NATIVE order (DraggableNumberBox.swift:520 + the extras
 * closure, e.g. the pan box at ContentView:4289, which ends with the scene
 * helper then the LFO-mapping helper):
 *   Enter value… · MIDI-learn · caller extras · scene overrides · map-to-modifier
 * Pure, so the composition is testable without a DOM.
 */
export function buildDragBoxMenu(
  src: DragBoxMenuSource,
  onEnterValue: () => void,
  sections: { midi?: MenuItem[]; scene?: MenuItem[] } = {},
): MenuItem[] {
  const items: MenuItem[] = [
    { kind: "item", label: "Enter value…", onSelect: onEnterValue },
  ];
  if (sections.midi?.length) items.push({ kind: "sep" }, ...sections.midi);
  if (src.menu?.length) items.push({ kind: "sep" }, ...src.menu);
  if (sections.scene?.length) items.push({ kind: "sep" }, ...sections.scene);
  if (src.modMenu?.length) items.push({ kind: "sep" }, ...src.modMenu);
  return items;
}

/**
 * The box's right-click handler. Exported so a control that WRAPS a DragBox
 * (the paired box+slider row) can put the identical menu on the whole row.
 */
export function useDragBoxMenu(src: DragBoxMenuSource) {
  const { openMenu, openNumberEntry } = useContextMenu();
  const learnState = useMidiLearnStore((s) => s.state);
  const sceneState = useScenePinStore((s) => s.state);
  return (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { clientX: x, clientY: y } = e;
    const items = buildDragBoxMenu(
      src,
      () =>
        openNumberEntry({
          x,
          y,
          seed: src.value,
          min: src.min,
          max: src.max,
          // A typed number is a DECLARED value, not a nudge — it fans out absolute.
          onCommit: (v: number) => src.onChange(v, "set"),
        }),
      {
        midi: src.learn ? buildMidiLearnItems(src.learn, learnState) : [],
        scene: src.scenePin ? buildScenePinItems(src.scenePin, sceneState) : [],
      },
    );
    openMenu(items, x, y);
  };
}

/**
 * The right-click menu for a learnable control that is NOT a box — a bare
 * fader. Native's `DJCrossfaderBar` (DJModeView:1640) hangs `MIDILearnContext-
 * MenuContent` and NOTHING else off the bar: there is no numeric entry on a
 * fader, so the menu is the MIDI block alone. Returns undefined when the
 * control isn't learnable, so a caller can spread it straight onto the element.
 */
export function useLearnMenu(
  learn?: LearnTarget,
): ((e: React.MouseEvent) => void) | undefined {
  const { openMenu } = useContextMenu();
  const learnState = useMidiLearnStore((s) => s.state);
  if (!learn) return undefined;
  return (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(buildMidiLearnItems(learn, learnState), e.clientX, e.clientY);
  };
}

/** Native rings a control that is pinned to the current scene (ScenePinRing). */
export function useScenePinned(scenePin?: ScenePinTarget): boolean {
  const state = useScenePinStore((s) => s.state);
  return scenePin ? isPinnedToCurrentScene(scenePin.key, state) : false;
}

/** Native tints the box while learning / when mapped (DraggableNumberBox:445). */
export function useLearnStatus(learn?: LearnTarget): "" | " learning" | " mapped" {
  const state = useMidiLearnStore((s) => s.state);
  if (!learn) return "";
  if (isLearningTarget(state, learn)) return " learning";
  return mappingFor(state, learn) ? " mapped" : "";
}

export function DragBox(props: {
  id: string; // stable focus id, e.g. "spectral/texture"
  value: number;
  display: string;
  min: number;
  max: number;
  step: number; // coarse step (ö/ä unit and per-pixel drag unit)
  defaultValue?: number;
  /** `intent` tells a selection fan-out whether this is a nudge or a declaration. */
  onChange: (v: number, intent?: EditIntent) => void;
  /**
   * ö/ä override for boxes whose value is NOT linear in `step` — the rate box
   * walks log-spaced detents, where a fixed step would snap back to where it
   * started. Default: value ± step (⌥ = fine).
   */
  adjust?: (deltaSign: number, fine: boolean) => void;
  /** Extra right-click items appended after the base menu. */
  menu?: MenuItem[];
  /** Names this control to MIDILearnSystem; omit = not learnable. */
  learn?: LearnTarget;
  /** The scene-override key ("bpm" / "track.<row>.pan"); omit = not pinnable. */
  scenePin?: ScenePinTarget;
  /** "Map to Modifier" items (CM-4); the panel builds them from its mod slots. */
  modMenu?: MenuItem[];
  /**
   * Inert, because the value is not this surface's to change right now.
   *
   * The box stays MOUNTED and keeps showing the value (L2 — state changes fill,
   * never presence; a control that vanishes moves everything beside it). What
   * goes away is every write: drag, double-click reset, the right-click menu and
   * the ö/ä focus claim.
   *
   * ⚠️ `title` becomes REQUIRED in spirit when this is set — DESIGN.md §6: a
   * disabled control with no explanation is a dead end. Say the precondition.
   */
  disabled?: boolean;
  /** Overrides the default "drag to adjust…" hint. The place to say WHY when disabled. */
  title?: string;
}) {
  const { focused, setFocus, clearFocus } = useFocusModel();
  // NAV-11: the focus id is SCOPED (per-deck prefix in the DJ page, "" in
  // compose) so the two grids' identical `track/<i>/<ctrl>` ids don't collide
  // in the global registry. Every place the id crosses into the shared focus
  // world — register, setFocus, compare, the DOM stamp band traversal reads —
  // uses the scoped `focusId`, never the raw `props.id`.
  const scope = useFocusScope();
  const focusId = scope + props.id;
  const isFocused = focused?.id === focusId;
  const onContextMenu = useDragBoxMenu(props);
  const learnStatus = useLearnStatus(props.learn);
  const pinned = useScenePinned(props.scenePin);

  // Keep latest props reachable from the stable adjust closure.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    installFocusKeyboard();
  }, []);

  // ö/ä on the focused box. Reads `latest` so the closure stays live, and
  // yields to the caller's `adjust` when the value isn't linear in `step`.
  const adjust = (deltaSign: number, fine: boolean) => {
    const p = latest.current;
    if (p.adjust) return p.adjust(deltaSign, fine);
    const tokens = currentTokens().control.dragBox; // behavior tokens
    const step = fine ? p.step * tokens.fineStepMultiplier : p.step;
    // ö/ä is a nudge — same relative fan-out as a drag (native's hotkey nudges
    // go through the *Relative mutators too, HotkeyManager:1286).
    p.onChange(clamp(p.value + deltaSign * step, p.min, p.max), "drag");
  };
  const adjustRef = useRef(adjust);
  adjustRef.current = adjust;
  const stableAdjust = (deltaSign: number, fine: boolean) =>
    adjustRef.current(deltaSign, fine);

  // Re-register the adjust callback while focused so ö/ä acts on live values.
  useEffect(() => {
    if (!isFocused) return;
    setFocus({ id: focusId, adjust: stableAdjust });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFocused, props.value]);

  useEffect(() => () => clearFocus(focusId), [clearFocus, focusId]);

  const acquireFocus = () => {
    setFocus({ id: focusId, adjust: stableAdjust });
  };

  // Tab lane-switch target (P2.1): grid→controls lands on the focused
  // track's first registered DragBox.
  const acquireRef = useRef(acquireFocus);
  acquireRef.current = acquireFocus;
  // A DISABLED box is not a Tab target either: landing the ring on a control
  // that then refuses ö/ä is the dead end §6 is about, one lane over.
  const focusable = props.disabled !== true;
  useEffect(() => {
    if (!focusable) return;
    return registerFocusTarget(focusId, () => acquireRef.current());
  }, [focusId, focusable]);

  // Touch double-tap detection (dblclick does not fire from taps on iOS).
  const lastTapRef = useRef<TapStamp | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    acquireFocus();
    // TOUCH: dblclick never fires, so a double-TAP is the reset door; and a
    // long-press attempt must not nudge the value on its way to the menu, so
    // touch drags arm only past a 10px deadzone (mouse feel untouched).
    const touch = e.pointerType === "touch";
    if (touch) {
      const now = { t: Date.now(), x: e.clientX, y: e.clientY };
      if (isDoubleTap(lastTapRef.current, now)) {
        lastTapRef.current = null;
        onDoubleClick();
        return;
      }
      lastTapRef.current = now;
    }
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startValue = latest.current.value;
    let armed = !touch;

    const onMove = (move: PointerEvent) => {
      if (!armed) {
        if (Math.abs(move.clientY - startY) < 10) return;
        armed = true;
      }
      const p = latest.current;
      const tokens = currentTokens().control.dragBox;
      const sensitivity = tokens.dragSensitivity * (move.altKey ? tokens.fineStepMultiplier : 1);
      const dy = startY - move.clientY; // up = increase
      // Full range ≈ 200px of drag at sensitivity 1 (feel tuned at P3-04),
      // then quantized to the control's step.
      const raw = startValue + (dy / 200) * (p.max - p.min) * sensitivity;
      const snapped = Math.round(raw / p.step) * p.step;
      p.onChange(clamp(snapped, p.min, p.max), "drag");
    };
    const onUp = () => {
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  };

  const onDoubleClick = () => {
    const tokens = currentTokens().control.dragBox;
    if (tokens.doubleClickReset && props.defaultValue !== undefined) {
      // A reset means "all of you are the default now", not "all of you move by
      // however far I happened to be from it" — absolute, as native does (:5363).
      props.onChange(props.defaultValue, "set");
    }
  };

  // Disabled: still mounted, still readable, but every write is unwired — the
  // menu included, or "Enter value…" would be a live door on an inert control.
  const off = props.disabled === true;

  return (
    <div
      className={`ds-dragbox${isFocused && !off ? " focused" : ""}${off ? "" : learnStatus}${
        pinned && !off ? " scene-pinned" : ""
      }${off ? " disabled" : ""}`}
      data-focus-id={focusId}
      aria-disabled={off || undefined}
      onPointerDown={off ? undefined : onPointerDown}
      onDoubleClick={off ? undefined : onDoubleClick}
      onContextMenu={off ? undefined : onContextMenu}
      title={
        props.title ??
        "drag to adjust · click to focus (ö/ä browse, ⌥ fine) · right-click for menu"
      }
    >
      {props.display}
    </div>
  );
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
