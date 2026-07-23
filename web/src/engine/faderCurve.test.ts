import { expect, test } from 'vitest'
import { FADER_UNITY_POSITION, faderPositionToDb, faderPositionToLinear } from './faderCurve'

/**
 * The SAME golden table is pinned in engine/tools/summing_test.cpp — the
 * web↔engine cross-pin (routing.md §10 fixture 2). If either implementation
 * drifts, its side of the pin fails: the fader you see is the gain you get.
 */
const GOLDEN: Array<[number, number]> = [
  [0.0, -120.0],
  [0.05, -60.0],
  [0.1, -50.213612485],
  [0.15, -39.902966625],
  [0.2, -30.640837454],
  [0.25, -24.0],
  [0.3, -19.601536053],
  [0.35, -15.931728059],
  [0.4, -12.86115204],
  [0.45, -10.260384013],
  [0.5, -8.0],
  [0.55, -6.022095238],
  [0.6, -4.306285714],
  [0.65, -2.779428571],
  [0.7, -1.368380952],
  [0.75, 0.0],
  [0.8, 1.309714286],
  [0.85, 2.523428571],
  [0.9, 3.682285714],
  [0.95, 4.827428571],
  [1.0, 6.0],
]

test('golden table matches to 1e-9 (cross-pinned with the engine)', () => {
  for (const [pos, db] of GOLDEN) {
    expect(Math.abs(faderPositionToDb(pos) - db)).toBeLessThan(1e-9)
  }
})

test('unity detent is exactly 0 dB at 0.75', () => {
  expect(Math.abs(faderPositionToDb(FADER_UNITY_POSITION))).toBeLessThan(1e-12)
  expect(Math.abs(faderPositionToLinear(FADER_UNITY_POSITION) - 1)).toBeLessThan(1e-12)
})

test('position 0 is a true zero (no denormal tail), top is +6 dB', () => {
  expect(faderPositionToLinear(0)).toBe(0)
  expect(faderPositionToLinear(-0.1)).toBe(0)
  expect(faderPositionToDb(1)).toBe(6)
  expect(faderPositionToDb(1.5)).toBe(6) // clamped above the throw
})

test('curve is monotone over the whole throw', () => {
  let prev = -Infinity
  for (let i = 0; i <= 1000; i++) {
    const db = faderPositionToDb(i / 1000)
    expect(db).toBeGreaterThanOrEqual(prev - 1e-12)
    prev = db
  }
})
