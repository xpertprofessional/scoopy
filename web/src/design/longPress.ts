/**
 * Long-press → context menu (mobile pass, 2026-07-21).
 *
 * Touch has no right-click, and every secondary action in the app lives on
 * the ContextMenu system (CM-1): MIDI-learn, scene pins, "Enter value…",
 * clear-per-cell, track color/rename, grid background ops. Rather than wiring
 * a touch path into each of the nine onContextMenu surfaces, ONE global
 * recognizer synthesizes a bubbling `contextmenu` MouseEvent at the touched
 * element — React's root delegation does not check isTrusted, so every
 * existing handler (including the grid's defaultPrevented catch-all chain)
 * works untouched.
 *
 * Fire sequence: (1) synthetic `pointercancel` at the target — the canvas and
 * DragBox already clean up in-flight gestures on it, and the grid's deferred
 * touch press guarantees nothing was committed yet; (2) synthetic
 * `contextmenu` at the press coords — the surface opens its own menu;
 * (3) the trailing pointerup + click of the still-held finger are swallowed
 * so lifting cannot instantly activate whatever opened under it.
 *
 * The recognizer core is a pure state machine (longPressStep) so the
 * hold/slop/dedupe arbitration is testable without a DOM.
 */

export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

export type LongPressState =
  | { phase: "idle" }
  | { phase: "tracking"; x: number; y: number }
  | { phase: "fired" };

export type LongPressEvent =
  | { type: "down"; x: number; y: number; touch: boolean; primary: boolean }
  | { type: "move"; x: number; y: number }
  | { type: "up" }
  /** pointercancel, or a TRUSTED native contextmenu (Android synthesizes its
   *  own from a long-press — ours must stand down, not double-fire). */
  | { type: "cancel" }
  | { type: "timer" };

export function longPressStep(
  s: LongPressState,
  e: LongPressEvent,
  slopPx: number = LONG_PRESS_SLOP_PX,
): LongPressState {
  switch (e.type) {
    case "down":
      // Only a primary touch can become a long-press; a second finger (pan)
      // or a mouse/pen press resets to idle.
      return e.touch && e.primary ? { phase: "tracking", x: e.x, y: e.y } : { phase: "idle" };
    case "move":
      if (s.phase !== "tracking") return s;
      return Math.hypot(e.x - s.x, e.y - s.y) > slopPx ? { phase: "idle" } : s;
    case "up":
    case "cancel":
      return { phase: "idle" };
    case "timer":
      return s.phase === "tracking" ? { phase: "fired" } : s;
  }
}

/** After a fire, how long the trailing click of the lifting finger stays
 *  swallowed. Generous: iOS can deliver the click hundreds of ms late. */
export const CLICK_SUPPRESS_MS = 700;

export function installLongPressContextMenu(win: Window = window): void {
  let state: LongPressState = { phase: "idle" };
  let timer: number | null = null;
  let target: Element | null = null;
  let pointerId = -1;
  // Post-fire suppression: the finger that long-pressed is still down.
  let suppressUpOf = -1;
  let suppressClickUntil = 0;

  const clearTimer = () => {
    if (timer !== null) {
      win.clearTimeout(timer);
      timer = null;
    }
  };
  const reset = () => {
    clearTimer();
    state = { phase: "idle" };
    target = null;
    pointerId = -1;
  };

  win.addEventListener(
    "pointerdown",
    (e) => {
      clearTimer();
      state = longPressStep(state, {
        type: "down",
        x: e.clientX,
        y: e.clientY,
        touch: e.pointerType === "touch",
        primary: e.isPrimary,
      });
      if (state.phase !== "tracking") {
        target = null;
        return;
      }
      target = e.target instanceof Element ? e.target : null;
      pointerId = e.pointerId;
      const at = { x: e.clientX, y: e.clientY, id: e.pointerId };
      timer = win.setTimeout(() => {
        state = longPressStep(state, { type: "timer" });
        if (state.phase !== "fired" || !target) return;
        const el = target;
        // Suppression arms BEFORE dispatch: the synthetic pointercancel below
        // bubbles back through our own window listeners.
        suppressUpOf = at.id;
        suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
        el.dispatchEvent(
          new PointerEvent("pointercancel", {
            bubbles: true,
            pointerId: at.id,
            pointerType: "touch",
          }),
        );
        el.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: at.x,
            clientY: at.y,
          }),
        );
        reset();
      }, LONG_PRESS_MS);
    },
    true,
  );

  win.addEventListener(
    "pointermove",
    (e) => {
      if (state.phase !== "tracking" || e.pointerId !== pointerId) return;
      state = longPressStep(state, { type: "move", x: e.clientX, y: e.clientY });
      if (state.phase === "idle") reset();
    },
    true,
  );

  win.addEventListener(
    "pointerup",
    (e) => {
      if (e.pointerId === suppressUpOf) {
        suppressUpOf = -1;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.pointerId === pointerId) reset();
    },
    true,
  );

  win.addEventListener(
    "pointercancel",
    (e) => {
      if (e.pointerId === pointerId) reset();
    },
    true,
  );

  // A TRUSTED contextmenu while tracking = the platform long-pressed for us
  // (Android). Stand down and let the surface's handler take that one.
  win.addEventListener(
    "contextmenu",
    (e) => {
      if (e.isTrusted && state.phase === "tracking") reset();
    },
    true,
  );

  win.addEventListener(
    "click",
    (e) => {
      if (Date.now() < suppressClickUntil) {
        suppressClickUntil = 0;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );
}
