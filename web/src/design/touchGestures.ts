/**
 * Touch gesture tuning + math — ALL pure (the pointer machine stays dumb).
 *
 * The grid's gesture thresholds were mouse literals (6px deadzone, 8px
 * value-drag arm, 6px/step). A fingertip is ~3× a cursor: with mouse
 * thresholds a resting finger's jitter arms drags and eats taps. Each
 * gesture reads its tuning from the POINTER THAT STARTED IT
 * (e.pointerType, stamped into the drag/mark state at press) — not from
 * device class — so a mouse plugged into an iPad keeps the mouse feel.
 */

export interface GestureTuning {
  /** Mark/pending-press deadzone: motion below this is a stationary tap. */
  deadzonePx: number;
  /** Vertical travel that arms the value-drag over a covered cell. */
  valueDragArmPx: number;
  /** Value-drag notch size (px per step). */
  valueDragPxPerStep: number;
  /** Accent scrub: px per level. */
  accentPxPerLevel: number;
}

const MOUSE_TUNING: GestureTuning = {
  deadzonePx: 6,
  valueDragArmPx: 8,
  valueDragPxPerStep: 6,
  accentPxPerLevel: 8,
};

const TOUCH_TUNING: GestureTuning = {
  deadzonePx: 12,
  valueDragArmPx: 16,
  valueDragPxPerStep: 10,
  accentPxPerLevel: 12,
};

export function gestureTuning(pointerType: string): GestureTuning {
  return pointerType === "touch" ? TOUCH_TUNING : MOUSE_TUNING;
}

/**
 * Two-finger pan: the grid canvas is `touch-action: none` (a one-finger drag
 * composes), so scrolling over it must be reimplemented — one finger edits,
 * two fingers pan (drawing-app idiom). Returns the scrollTop DELTA for the
 * container: positive when the fingers moved up (content scrolls down).
 * Client-space Ys, NOT canvas-local: scrolling moves the canvas under the
 * fingers, so local coords would feed back into the pan.
 */
export function twoFingerPanDelta(prevYs: number[], nextYs: number[]): number {
  if (prevYs.length === 0 || nextYs.length === 0) return 0;
  const avg = (ys: number[]) => ys.reduce((a, b) => a + b, 0) / ys.length;
  return avg(prevYs) - avg(nextYs);
}

/** A prior tap for double-tap detection (client coords + ms timestamp). */
export interface TapStamp {
  t: number;
  x: number;
  y: number;
}

/**
 * Double-tap = the touch stand-in for double-click (350ms / 24px — looser
 * than a double-click because a fingertip cannot re-land on a pixel).
 */
export function isDoubleTap(prev: TapStamp | null, now: TapStamp): boolean {
  if (!prev) return false;
  return (
    now.t - prev.t <= 350 && Math.abs(now.x - prev.x) <= 24 && Math.abs(now.y - prev.y) <= 24
  );
}
