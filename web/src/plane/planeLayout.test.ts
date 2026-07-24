import { expect, test } from 'vitest'
import { autoLayout, fitToContent, zoomAbout, LAYOUT } from './planeLayout'
import type { Cell } from '../../protocol/schema'

test('autoLayout is empty for zero cells and never divides', () => {
  expect(autoLayout(0)).toEqual([])
})

test('autoLayout fills left-to-right, then wraps to the next row', () => {
  const cells = autoLayout(LAYOUT.perRow + 2)
  // First cell at the origin.
  expect(cells[0]).toEqual({ x: 0, y: 0, w: LAYOUT.w, h: LAYOUT.h })
  // Second cell is one column to the right, same row.
  expect(cells[1]!.x).toBe(LAYOUT.w + LAYOUT.gap)
  expect(cells[1]!.y).toBe(0)
  // The (perRow+1)th cell wraps to a new row at x=0.
  expect(cells[LAYOUT.perRow]!.x).toBe(0)
  expect(cells[LAYOUT.perRow]!.y).toBe(LAYOUT.h + LAYOUT.gap)
})

test('autoLayout is deterministic — identical input, identical geometry', () => {
  expect(autoLayout(13)).toEqual(autoLayout(13))
})

test('every auto-laid cell is a valid Cell (positive size)', () => {
  for (const c of autoLayout(20)) {
    expect(c.w).toBeGreaterThan(0)
    expect(c.h).toBeGreaterThan(0)
  }
})

const VIEWPORT = { width: 1000, height: 800 }

test('fitToContent on an empty plane is the identity, not a divide-by-zero', () => {
  expect(fitToContent([], VIEWPORT)).toEqual({ scale: 1, panX: 0, panY: 0 })
})

test('fitToContent never zooms a small patch UP past 1', () => {
  const one: Cell[] = [{ x: 0, y: 0, w: 150, h: 132 }]
  const p = fitToContent(one, VIEWPORT)
  expect(p.scale).toBeLessThanOrEqual(1)
  expect(p.scale).toBeGreaterThan(0)
})

test('fitToContent zooms OUT to frame content larger than the viewport', () => {
  // A wide spread of cells well beyond 1000px must scale below 1 to fit.
  const wide = autoLayout(60) // 10 rows of 6 → tall + wide
  const p = fitToContent(wide, VIEWPORT)
  expect(p.scale).toBeLessThan(1)
})

test('fitToContent centres the content in the viewport', () => {
  // A single cell: after applying scale+pan, its centre should map to the
  // viewport centre. screen = (plane + pan) * scale.
  const c: Cell = { x: 200, y: 100, w: 150, h: 132 }
  const p = fitToContent([c], VIEWPORT)
  const cx = c.x + c.w / 2
  const cy = c.y + c.h / 2
  const screenX = (cx + p.panX) * p.scale
  const screenY = (cy + p.panY) * p.scale
  expect(screenX).toBeCloseTo(VIEWPORT.width / 2, 4)
  expect(screenY).toBeCloseTo(VIEWPORT.height / 2, 4)
})

test('fitToContent is safe on a degenerate viewport', () => {
  expect(fitToContent(autoLayout(3), { width: 0, height: 0 })).toEqual({
    scale: 1,
    panX: 0,
    panY: 0,
  })
})

// --- zoomAbout: the "zoom toward the cursor" invariant ----------------------

/** The plane coordinate currently under a screen point. Inverse of the render
    transform screen = (plane + pan)*scale. */
function planeUnder(t: { scale: number; panX: number; panY: number }, sx: number, sy: number) {
  return { x: sx / t.scale - t.panX, y: sy / t.scale - t.panY }
}

test('zoomAbout keeps the plane point under the cursor fixed', () => {
  const start = { scale: 1, panX: 0, panY: 0 }
  const cursor = { x: 640, y: 300 }
  const before = planeUnder(start, cursor.x, cursor.y)
  const zoomed = zoomAbout(start, 1.1, cursor.x, cursor.y, 0.2, 2.5)
  const after = planeUnder(zoomed, cursor.x, cursor.y)
  expect(zoomed.scale).toBeCloseTo(1.1, 6)
  expect(after.x).toBeCloseTo(before.x, 4) // same plane point still under the cursor
  expect(after.y).toBeCloseTo(before.y, 4)
})

test('zoomAbout clamps and returns the SAME transform when the clamp bites', () => {
  const atMax = { scale: 2.5, panX: 10, panY: -5 }
  const r = zoomAbout(atMax, 1.1, 100, 100, 0.2, 2.5)
  expect(r).toBe(atMax) // unchanged reference — no spurious pan drift at the limit
})

test('zoomAbout out then in about the same point round-trips the transform', () => {
  const start = { scale: 1, panX: 30, panY: 12 }
  const out = zoomAbout(start, 1 / 1.25, 400, 250, 0.2, 2.5)
  const back = zoomAbout(out, 1.25, 400, 250, 0.2, 2.5)
  expect(back.scale).toBeCloseTo(start.scale, 6)
  expect(back.panX).toBeCloseTo(start.panX, 4)
  expect(back.panY).toBeCloseTo(start.panY, 4)
})
