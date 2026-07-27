/**
 * DJ perform-mode locator gesture (v68) — the pure state machine behind the
 * grid's PERF pointer handling, kept canvas-free so vitest can pin it.
 *
 * One drag = one per-track window: on release the dragged step range becomes
 * the track's locator repeat window AND engages it (Swift owns the engine's
 * catch-the-playhead latch; the web only sends the intent). A plain click
 * (never left the anchor step) disengages instead — set on drag, kill on
 * click. Ranges are non-wrapping by construction: right-to-left drags flip
 * to min…max, so the Swift mutator's end ≤ stepCount−1 clamp never bites.
 */

export interface PerformDrag {
  trackIndex: number;
  /** Step the pointer went down on. */
  anchor: number;
  /** Most recent step hit on the anchor track. */
  last: number;
  /** Pointer position at press, in canvas coords — the pixel arming origin. */
  downX: number;
  downY: number;
  /**
   * Click-vs-drag threshold, armed EITHER by hitting a step other than the
   * anchor OR by travelling past PERFORM_DRAG_PX from the press point. The
   * pixel rule is what makes a 1-step window reachable: a drag that never
   * leaves the anchor cell is otherwise indistinguishable from a click, and
   * a click means disengage. Stays true if the drag returns to the anchor.
   */
  moved: boolean;
}

/**
 * Pixel travel that turns a press into a drag. Matches the affordance
 * deadzone (§3.2) so both grid gestures commit at the same wrist movement.
 */
export const PERFORM_DRAG_PX = 6;

/** True once the pointer has left the press point's deadzone. */
export function performDragArmed(d: PerformDrag, x: number, y: number): boolean {
  return Math.hypot(x - d.downX, y - d.downY) > PERFORM_DRAG_PX;
}

const clampStep = (step: number, stepCount: number) =>
  Math.max(0, Math.min(stepCount - 1, step));

/** Normalized inclusive window of an in-flight drag (R→L drags flip). */
export function performRange(
  d: PerformDrag,
  stepCount: number,
): { startStep: number; lengthSteps: number } {
  const a = clampStep(d.anchor, stepCount);
  const b = clampStep(d.last, stepCount);
  const startStep = Math.min(a, b);
  return { startStep, lengthSteps: Math.max(a, b) - startStep + 1 };
}

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Row-locked step under (x,y) within one track's step→rect map — the geometry
 * behind a PERF drag's moving end. Picks the y-BAND nearest the pointer, then
 * maps x to a column within that band, clamped to the band's step span.
 *
 * y is load-bearing: in SPLIT display a track's steps wrap onto two visual rows
 * (0…n/2−1 on top, the rest below) at the SAME x positions, so the column alone
 * is ambiguous. Without the band pick, a drag anchored in the lower row mapped
 * back to the upper one and the window spanned the row border. Nearest-band (not
 * strict containment) keeps drift forgiveness: sliding above/below the row still
 * tracks its columns, and gaps between cells still resolve to a real step.
 *
 * Returns -1 for an empty map.
 */
export function rowStepFromXY(rects: Iterable<[number, CellRect]>, x: number, y: number): number {
  const all = [...rects];
  // Nearest visual sub-row by vertical centre.
  let bandY = Infinity;
  let bandDist = Infinity;
  for (const [, r] of all) {
    const d = Math.abs(r.y + r.h / 2 - y);
    if (d < bandDist) {
      bandDist = d;
      bandY = r.y;
    }
  }
  if (bandY === Infinity) return -1;
  // Column mapping within that band only (the other band shares the x range).
  let leftStep = -1;
  let leftX = Infinity;
  let cellW = 0;
  let rightStep = -1;
  for (const [step, r] of all) {
    if (Math.abs(r.y - bandY) > r.h * 0.5) continue; // a different sub-row
    if (r.x < leftX) {
      leftX = r.x;
      leftStep = step;
      cellW = r.w + 2;
    }
    if (step > rightStep) rightStep = step;
  }
  if (leftStep < 0 || cellW <= 0) return -1;
  const col = Math.floor((x - (leftX - 1)) / cellW);
  return Math.max(leftStep, Math.min(rightStep, leftStep + col));
}

export type PerformRelease =
  | { kind: "setRange"; startStep: number; lengthSteps: number }
  | { kind: "disengage" }
  | { kind: "none" };

/**
 * What releasing the gesture does: a drag sets (and engages) the window; a
 * plain click disengages iff the track's repeat is currently engaged.
 */
export function resolvePerformRelease(
  d: PerformDrag,
  stepCount: number,
  engaged: boolean,
): PerformRelease {
  if (d.moved) return { kind: "setRange", ...performRange(d, stepCount) };
  return engaged ? { kind: "disengage" } : { kind: "none" };
}
