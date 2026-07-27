import { createContext, useContext } from "react";
import { create } from "zustand";

/**
 * Web FocusModel (INTERACTION-MODEL.md §0; P5-PCE P2.1 lane merge): ONE
 * focus world for the whole web build. Two lanes —
 *   "controls": a DragBox owns the keys (ö/ä adjusts it); the grid's cell
 *               focus is KEPT but inert (dimmed ring — "focus parked here,
 *               keys are elsewhere").
 *   "grid":     the grid owns the keys (ö/ä value, arrows nav, p/t/n/v/s/e,
 *               [ ] Ö Ä param cycle); no control ring anywhere.
 * Exactly one accent ring on screen at any time — the ring IS the lane
 * indicator. Tab toggles lanes (native HotkeyManager parity): grid→controls
 * lands on the focused track's first registered DragBox; controls→grid
 * revives the kept cell focus. Esc never clears focus (menus only).
 * The Swift HotkeyManager yields while a web panel's WKWebView is first
 * responder (single-owner rule, P3-03).
 */

export interface FocusedControl {
  /** Stable id, e.g. "spectral/texture" or "track/3/pitch". */
  id: string;
  /** Adjust by n coarse steps (n is ±1 from ö/ä); fine = Option held. */
  adjust: (deltaSign: number, fine: boolean) => void;
  /** Activate (Enter / '.') — toggles/buttons only; absent on DragBoxes. */
  press?: () => void;
}

export interface CellFocus {
  trackIndex: number;
  step: number;
}

interface FocusState {
  lane: "controls" | "grid";
  focused: FocusedControl | null;
  /** Grid cell focus — survives a lane switch to controls (inert, dimmed). */
  cell: CellFocus | null;
  /**
   * ANOTHER webview's DragBox owns the controls focus (each panel is its own
   * WKWebView with its own store — this flag is how "one ring across ALL
   * webviews" reaches this one). Lane stays "grid" so arrows keep navigating;
   * ö/ä landing here is relayed to the owner instead of dying, and the local
   * cell ring renders parked/dimmed.
   */
  remoteControls: boolean;
  setFocus: (control: FocusedControl) => void;
  clearFocus: (id?: string) => void;
  setCellFocus: (cell: CellFocus) => void;
  /** Apply a cross-webview claim broadcast (never re-notifies — no loops). */
  applyRemoteClaim: (kind: "controls" | "grid") => void;
}

export const useFocusModel = create<FocusState>((set, get) => ({
  lane: "grid",
  focused: null,
  cell: null,
  remoteControls: false,
  // A DragBox click flips the lane to controls; the parked cell focus stays.
  // Claiming here (inside the store action) covers EVERY call site — DragBox,
  // trackRowControls, acquireControlFocus targets.
  setFocus: (control) => {
    set({ focused: control, lane: "controls", remoteControls: false });
    focusClaimNotifier?.("controls");
  },
  // Clearing the focused control hands the keys back to the grid lane, so
  // the kept cell focus revives (controls→grid restore). A focused DragBox
  // unmounting must release the cross-webview claim too, or every other
  // webview stays parked on a dead owner.
  clearFocus: (id) => {
    const hadFocus = get().focused !== null && (id === undefined || get().focused?.id === id);
    if (!hadFocus) return;
    set({ focused: null, lane: "grid" });
    focusClaimNotifier?.("grid");
  },
  // A cell click / grid-nav key claims the grid lane and drops the control
  // ring (exactly one accent ring on screen). Only broadcast when this
  // actually takes ownership back from a control (local or remote) —
  // steady-state arrow navigation must not emit a command per keypress.
  setCellFocus: (cell) => {
    const s = get();
    const tookOwnership = s.focused !== null || s.remoteControls;
    set({ cell, lane: "grid", focused: null, remoteControls: false });
    if (tookOwnership) focusClaimNotifier?.("grid");
  },
  applyRemoteClaim: (kind) => {
    if (kind === "controls") {
      // Another webview's box took the ring: clear any local ring, park the
      // cell (kept, dimmed), keep the grid lane so arrows still navigate.
      set({ focused: null, lane: "grid", remoteControls: true });
    } else {
      set({ focused: null, lane: "grid", remoteControls: false });
    }
  },
}));

// ---------------------------------------------------------------------------
// Cross-webview focus relay hooks (registered by focusRelay.ts; null-safe
// no-ops otherwise — vitest and the browser companion run without them).
// ---------------------------------------------------------------------------

let focusClaimNotifier: ((kind: "controls" | "grid") => void) | null = null;
let remoteAdjustRelay: ((delta: number, fine: boolean) => boolean) | null = null;

/** Register the outgoing claim broadcast (null to unregister). */
export function setFocusClaimNotifier(fn: ((kind: "controls" | "grid") => void) | null): void {
  focusClaimNotifier = fn;
}

/** Register the outgoing ö/ä relay toward the remote owner; returns whether
 *  the key was relayed (false = leave the event untouched). Null to unregister. */
export function setRemoteAdjustRelay(fn: ((delta: number, fine: boolean) => boolean) | null): void {
  remoteAdjustRelay = fn;
}

// ---------------------------------------------------------------------------
// Focus-target registry: DragBoxes register an acquire() so lane switches
// (Tab) can land on a control without knowing the component tree.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Focus SCOPE (NAV-11): the DJ page mounts TWO grids, and every band control
// registers the same `track/<i>/<ctrl>` id — the registry (a Map keyed by id)
// let the second deck OVERWRITE the first, so a control click / band traversal
// landed on the wrong deck's control and both decks lit the same ring. A grid
// provides a per-slot scope (`s0/`, `s1/`); the two registration primitives
// (DragBox + the trackRowControls focusable wrapper) prefix every id they
// register / stamp / compare with it. Compose leaves it "" — ids unchanged.
// ---------------------------------------------------------------------------
export const FocusScopeContext = createContext<string>("");
export function useFocusScope(): string {
  return useContext(FocusScopeContext);
}

const focusTargets = new Map<string, () => void>();

/** Register a control's focus-acquire; returns the unregister. */
export function registerFocusTarget(id: string, acquire: () => void): () => void {
  focusTargets.set(id, acquire);
  return () => {
    if (focusTargets.get(id) === acquire) focusTargets.delete(id);
  };
}

/** Focus a specific registered control by id (band ←/→ traversal and
 *  nearest-x landing resolve ids from the DOM, then acquire here). */
export function acquireControlFocus(id: string): boolean {
  const acquire = focusTargets.get(id);
  if (!acquire) return false;
  acquire();
  return true;
}

/** Focus the first registered control whose id starts with `prefix`
 *  (registration order == mount order == visual order). */
export function acquireFirstControlFocus(prefix: string): boolean {
  for (const [id, acquire] of focusTargets) {
    if (id.startsWith(prefix)) {
      acquire();
      return true;
    }
  }
  return false;
}

let keyboardInstalled = false;

/** Installs the controls-lane ö/ä listener once (module-level, spans panel
 *  remounts). Grid-lane ö/ä lives in GridPanel — this listener only fires
 *  while a control owns the lane. */
export function installFocusKeyboard(): void {
  if (keyboardInstalled) return;
  keyboardInstalled = true;
  window.addEventListener("keydown", (e) => {
    // Character-matched like the native handler — NOT keycode-based
    // (keycodes 41/39/30/33 are the ⌘[/] track-shift bindings; see
    // INTERACTION-MODEL.md §7.1).
    const delta = e.key === "ö" ? -1 : e.key === "ä" ? 1 : 0;
    if (delta !== 0 && !e.metaKey) {
      const s = useFocusModel.getState();
      if (s.lane === "controls" && s.focused) {
        e.preventDefault();
        s.focused.adjust(delta, e.altKey);
        return;
      }
      // A box in ANOTHER webview owns the ring: relay the adjust to it via
      // native instead of letting the key die here (ö/ä is web-owned, so it
      // would never reach native's forwarding path otherwise). The relay
      // declines while musical-keyboard mode is active — then no
      // preventDefault, exactly the pre-relay fall-through.
      if (s.remoteControls && remoteAdjustRelay?.(delta, e.altKey)) {
        e.preventDefault();
      }
      return;
    }
    // Enter / '.' = press the focused toggle/button (TR-FT-12: both ö/ä
    // and press activate — controls with a press capability only).
    if ((e.key === "Enter" || e.key === ".") && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const s = useFocusModel.getState();
      if (s.lane !== "controls" || !s.focused?.press) return;
      e.preventDefault();
      s.focused.press();
    }
  });
}
