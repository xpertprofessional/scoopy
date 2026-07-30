/**
 * Plane geometry (merge P2 step 4).
 *
 * Pure functions the boundless-plane UI is built on: where auto-placed strips
 * go, and how to frame all of them ("fit to content" — GRM has no overview aid,
 * so this is our answer, pd-canvas.md §4.1). Kept pure and separate from any
 * React so it is exhaustively testable without a DOM, and so the SAME
 * auto-layout serves placement, a load carrying no geometry, and a future
 * "arrange" command — one source of truth for the grid, never two that drift.
 *
 * PORTED VERBATIM from wizard's `web/src/plane/planeLayout.ts`, tests included:
 * the geometry was already right and already covered, and re-deriving it would
 * only have risked losing the zoom-about invariant. The only change is where
 * `Cell` and `Plane` come from — the `.scoopyMap` document rather than wizard's
 * schema. They are structurally identical.
 */
import type { PlaneMap, Strip } from '../persist/mapDocument.ts'

/** A strip's box on the plane, and the plane's own viewport transform. Aliased
    off the document so there is never a second definition of either. */
export type Cell = Strip['cell']
export type Plane = PlaneMap['plane']

/** The strip's default box. A BUDGET, not a placeholder: the strip anatomy
    (wizard `docs/archive/pd-strip-anatomy.md` §4.1) closes to the pixel at this
    size, so changing it means re-deriving the interior. */
export const DEFAULT_CELL: Cell = { x: 0, y: 0, w: 340, h: 196 }

/** Grid spacing for auto-placement. The strip's own default size drives it, so
    a change to DEFAULT_CELL moves the grid with it. */
export const LAYOUT = {
  w: DEFAULT_CELL.w,
  h: DEFAULT_CELL.h,
  gap: 12,
  perRow: 4, // wide player-shaped strips: fewer per row than a narrow rack
} as const

/** The DECK TILE (P3-D4-1, STRIP-DECK.md): a session-loaded strip expanded to
    host the REAL GridPanel at DJ density. 2×3 grid cells including the gaps
    they span, so an expanded strip still sits ON the placement grid — collapse
    restores DEFAULT_CELL exactly and nothing else ever moved. */
export const DECK_CELL = {
  w: LAYOUT.w * 2 + LAYOUT.gap, // 692 — clears the dj column's ~500px floor
  h: LAYOUT.h * 3 + LAYOUT.gap * 2, // 612 — four tracks fully, more scroll inside
} as const

/** Is this cell wearing the deck-tile size? The DOCUMENT carries only the
    cell — expansion is a size, not a mode flag, so this predicate is the one
    definition of "expanded" (a second flag could disagree with the geometry). */
export function isDeckCell(cell: Cell): boolean {
  return cell.w >= DECK_CELL.w && cell.h >= DECK_CELL.h
}

/**
 * Deterministic left-to-right, top-to-bottom grid of `count` cells — matching
 * the old rack's reading order so a migrated session looks familiar. Inventing
 * nothing beyond position: identical input always yields identical geometry.
 */
export function autoLayout(count: number): Cell[] {
  const { w, h, gap, perRow } = LAYOUT
  const cells: Cell[] = []
  for (let i = 0; i < count; i++) {
    const col = i % perRow
    const row = Math.floor(i / perRow)
    cells.push({ x: col * (w + gap), y: row * (h + gap), w, h })
  }
  return cells
}

export interface Viewport {
  width: number
  height: number
}

/**
 * A plane transform that frames every cell within `viewport`, centred, with a
 * small margin. Returns the DEFAULT_PLANE identity when there is nothing to
 * frame (an empty plane must not divide by zero or jump to some far corner).
 * Scale is clamped to a sane range so one stray far-off cell can't zoom the
 * world to a speck.
 */
export function fitToContent(
  cells: readonly Cell[],
  viewport: Viewport,
  margin = 40,
): Plane {
  if (cells.length === 0 || viewport.width <= 0 || viewport.height <= 0)
    return { scale: 1, panX: 0, panY: 0 }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of cells) {
    minX = Math.min(minX, c.x)
    minY = Math.min(minY, c.y)
    maxX = Math.max(maxX, c.x + c.w)
    maxY = Math.max(maxY, c.y + c.h)
  }

  const contentW = maxX - minX
  const contentH = maxY - minY
  const availW = Math.max(1, viewport.width - margin * 2)
  const availH = Math.max(1, viewport.height - margin * 2)

  // Fit the larger dimension; never scale UP past 1 (framing a tiny patch
  // shouldn't blow the Cells up to fill a huge window).
  const rawScale = Math.min(availW / contentW, availH / contentH)
  const scale = clamp(Number.isFinite(rawScale) ? rawScale : 1, 0.1, 1)

  // Centre the content: pan so the content midpoint lands at the viewport
  // midpoint, in plane (pre-scale) coordinates.
  const panX = viewport.width / 2 / scale - (minX + contentW / 2)
  const panY = viewport.height / 2 / scale - (minY + contentH / 2)
  return { scale, panX, panY }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/**
 * Zoom a plane transform by `factor` about a SCREEN point (relative to the
 * plane's top-left), keeping the plane coordinate under that point fixed — the
 * "zoom toward the cursor" invariant. Scale is clamped to [min,max]; if the
 * clamp leaves scale unchanged the transform is returned untouched.
 *
 * Derivation: screen = (plane + pan)·scale, so plane = screen/scale − pan. To
 * hold `plane` constant as scale s→s': pan' = pan + screen·(1/s′ − 1/s).
 */
export function zoomAbout(
  t: Plane,
  factor: number,
  screenX: number,
  screenY: number,
  min: number,
  max: number,
): Plane {
  const next = clamp(t.scale * factor, min, max)
  if (next === t.scale) return t
  const k = 1 / next - 1 / t.scale
  return { scale: next, panX: t.panX + screenX * k, panY: t.panY + screenY * k }
}
