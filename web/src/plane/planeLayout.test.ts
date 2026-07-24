import { expect, test } from 'vitest'
import { autoLayout, fitToContent, LAYOUT } from './planeLayout'
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
