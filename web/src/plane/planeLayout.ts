/**
 * Plane geometry (PD-CANVAS-02, D-WZ-PDCANVAS-01).
 *
 * Pure functions the boundless-plane UI is built on: where auto-placed Cells go,
 * and how to frame all of them ("fit to content" — GRM has no overview aid, so
 * this is our answer, pd-canvas.md §4.1). Kept pure and separate from any React
 * so it is exhaustively testable without a DOM, and so the SAME auto-layout
 * serves both the v15→v16 session migration and a future "arrange" command —
 * one source of truth for the grid, never two that drift.
 */
import { DEFAULT_CELL, type Cell, type Plane } from '../../protocol/schema'

/** Grid spacing for auto-placement. The Cell's own default size drives it, so a
    change to DEFAULT_CELL moves the grid with it. */
export const LAYOUT = {
  w: DEFAULT_CELL.w,
  h: DEFAULT_CELL.h,
  gap: 12,
  perRow: 4, // wide player-shaped strips: fewer per row than a narrow rack
} as const

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
