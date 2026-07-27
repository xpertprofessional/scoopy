import type { GridTrackState } from "../../protocol/schema.ts";
import { resolveCellAt } from "./gridModel.ts";

/**
 * In-cell affordance geometry + mapping (incell-affordance-ux.md §3/§4.1).
 * ALL pure functions — the pointer machine and renderer stay dumb; this is
 * the single unit-testable source of zone hit-testing and mark math.
 *
 * Marks are edited by touching their visual form in the cell (Family 2, no
 * param-mode). Zones exist ONLY on ACTIVE cells and ONLY for unmodified
 * pointer input; the center body keeps the existing value-drag/draw machine.
 */

export type Mark = "reverse" | "flam" | "accent" | "glide" | "preSilence";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Zone sizes scale with the cell and floor so every zone stays hittable at
 *  the 24 px minimum (§2.0). CSS px. `coarse` = the press came from a finger:
 *  HIT zones grow toward fingertip size while the drawn marks keep the fine
 *  geometry (standard hit-slop — visuals stay identical across devices). */
export function zoneSizes(rect: Rect, coarse = false) {
  const corner = coarse
    ? clamp(Math.round(Math.min(rect.w, rect.h) * 0.4), 14, 20)
    : clamp(Math.round(Math.min(rect.w, rect.h) * 0.28), 8, 12);
  const topBand = coarse
    ? clamp(Math.round(rect.h * 0.22), 10, 14)
    : clamp(Math.round(rect.h * 0.14), 5, 8);
  const edgeGrab = coarse ? 10 : 4; // half-width of the glide/pre-silence strips
  return { corner, topBand, edgeGrab };
}

/**
 * Which mark zone (if any) a press at (x,y) lands in, on an ACTIVE OWNER
 * cell. FIXED priority (most-specific geometry first, §3.2): corners beat
 * bands beat edges beat body. `hasLeftJunction` = the step to the left is
 * covered by another cell (a glide junction exists there) — it arbitrates
 * the glide-vs-preSilence overlap via the neighbor rule (§2.4).
 * `onsetFrac` = the total lead-in as a fraction of the cell (0 = no inset).
 * Returns null → the press falls through to the existing pointer machine.
 */
export function affordanceHit(
  rect: Rect,
  x: number,
  y: number,
  ctx: { hasLeftJunction: boolean; onsetFrac: number; hasSample: boolean; coarse?: boolean },
): Mark | null {
  const { corner, topBand, edgeGrab } = zoneSizes(rect, ctx.coarse ?? false);
  const localX = x - rect.x;
  const localY = y - rect.y;
  const inCell = localX >= 0 && localX <= rect.w && localY >= 0 && localY <= rect.h;
  if (!inCell) return null;

  // 1. reverse — top-right corner square
  if (localX >= rect.w - corner && localY <= corner) return "reverse";
  // 2. flam — lower-left corner square
  if (localX <= corner && localY >= rect.h - corner) return "flam";
  // 3. accent — top band across the width MINUS the reverse corner
  if (localY <= topBand && localX < rect.w - corner) return "accent";

  // 4/5. glide junction vs pre-silence onset — left-edge strips.
  const onsetX = ctx.onsetFrac * rect.w;
  const detached = onsetX > edgeGrab + 1; // handle left the border
  if (ctx.hasLeftJunction) {
    // Glide owns the boundary strip ±(edgeGrab+1); pre-silence uses an inner
    // strip only when its onset has NOT detached to its own position.
    if (localX <= edgeGrab + 1) return "glide";
    if (ctx.hasSample && !detached && localX >= edgeGrab + 3 && localX <= edgeGrab + 7) {
      return "preSilence";
    }
  } else if (ctx.hasSample) {
    // No junction: the whole left strip (or the detached onset handle) is
    // pre-silence.
    if (Math.abs(localX - onsetX) <= edgeGrab && localY > topBand) return "preSilence";
  }
  if (ctx.hasSample && detached && Math.abs(localX - onsetX) <= edgeGrab && localY > topBand) {
    return "preSilence";
  }
  return null;
}

/** Flam count from a rightward drag (§2.2). notchPx floors at 8 CSS px so a
 *  narrow owner step still reaches all 16. */
export function fanCount(dx: number, ownerStepW: number, startCount: number): number {
  const notchPx = clamp(ownerStepW / 8, 8, 14);
  return clamp(startCount + Math.floor(dx / notchPx), 1, 16);
}

/** Absolute accent level from a vertical scrub (up = louder, §2.1). No wrap.
 *  `pxPerLevel` comes from the gesture tuning (8 mouse / 12 touch). */
export function accentScrubLevel(dy: number, startLevel: number, pxPerLevel = 8): number {
  // dy = startY − y (up positive).
  return clamp(startLevel + Math.floor(dy / pxPerLevel), 0, 2);
}

/**
 * Onset-drag px → absolute pre-silence ms (§2.4). The pointer drags the
 * VISIBLE onset (total lead-in); the op stores the pre-silence component the
 * engine needs, floored by the non-editable lead-in (negative-start +
 * rhythmic + swing) which the handle cannot drag below.
 */
export function leadInPxToPreMs(
  localX: number,
  regionW: number,
  cellDurationMs: number,
  floorMs: number,
): number {
  const leadInMs = clamp((localX / regionW) * cellDurationMs, 0, cellDurationMs);
  return clamp(Math.round(leadInMs - floorMs), 0, 1000);
}

/** Inverse: absolute pre-silence ms → onset x fraction of the cell (for the
 *  handle/hairline position). */
export function preMsToOnsetFrac(
  preMs: number,
  floorMs: number,
  cellDurationMs: number,
): number {
  if (cellDurationMs <= 0) return 0;
  return clamp((preMs + floorMs) / cellDurationMs, 0, 1);
}

/**
 * Resolve a hit step to its OWNER + whether the step to the left is a
 * junction (covered by a *different* cell). Wrap-continuation cells (step 0
 * via wrapSourceStep) expose NO zones — edit at the source (§4.4).
 */
export function ownerContext(
  t: GridTrackState,
  step: number,
): { owner: number; hasLeftJunction: boolean } | null {
  const r = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, step);
  if (!r || r.viaWrap) return null;
  const leftLeft = r.owner - 1;
  const leftResolved =
    leftLeft >= 0 ? resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, leftLeft) : null;
  const hasLeftJunction = leftResolved !== null && leftResolved.owner !== r.owner;
  return { owner: r.owner, hasLeftJunction };
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}
