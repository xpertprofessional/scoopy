import { expect, test } from 'vitest'
import {
  formatRate,
  positionToRate,
  rateToPosition,
  snapUnity,
} from './VarispeedSlider'

test('unity sits mid-way along each direction of travel', () => {
  // Mid-way between the slowest (FLOOR_POS) and fastest (1) ends, in BOTH
  // directions — the dead zone shifts it slightly off 0.5, symmetrically.
  const unityFwd = rateToPosition(1)
  const slowest = rateToPosition(1 / 16)
  const fastest = rateToPosition(16)
  expect(unityFwd).toBeCloseTo((slowest + fastest) / 2, 12)
  expect(rateToPosition(-1)).toBeCloseTo(-unityFwd, 12)
  expect(positionToRate(unityFwd)).toBeCloseTo(1, 9)
  expect(positionToRate(-unityFwd)).toBeCloseTo(-1, 9)
})

test('travel is logarithmic — halving and doubling are symmetric gestures', () => {
  // 2× and 1/2× must sit the same distance either side of unity.
  const up = rateToPosition(2) - rateToPosition(1)
  const down = rateToPosition(1) - rateToPosition(0.5)
  expect(up).toBeCloseTo(down, 12)
  // ...and so must 4× / 1÷4.
  expect(rateToPosition(4) - rateToPosition(1)).toBeCloseTo(
    rateToPosition(1) - rateToPosition(0.25),
    12,
  )
})

test('the ends of the travel are the engine clamp, exactly', () => {
  expect(positionToRate(1)).toBeCloseTo(16, 9)
  expect(positionToRate(-1)).toBeCloseTo(-16, 9)
  expect(positionToRate(0.02)).toBeCloseTo(1 / 16, 9)
  expect(positionToRate(-0.02)).toBeCloseTo(-1 / 16, 9)
  // Out-of-range positions still clamp rather than producing absurd rates.
  expect(Math.abs(positionToRate(5))).toBeLessThanOrEqual(16)
})

test('the centre dead zone keeps reverse and forward from sharing a point', () => {
  // The slowest REVERSE speed must survive the round-trip: it maps to -0.02,
  // not to -0 (which would test as non-negative and silently flip direction).
  expect(rateToPosition(-1 / 16)).toBeLessThan(0)
  expect(positionToRate(rateToPosition(-1 / 16))).toBeCloseTo(-1 / 16, 9)
  // Inside the dead zone the sign still decides direction.
  expect(positionToRate(-0.01)).toBeCloseTo(-1 / 16, 9)
  expect(positionToRate(0.01)).toBeCloseTo(1 / 16, 9)
})

test('position ↔ rate round-trips across the range', () => {
  for (const rate of [-16, -4, -1, -0.5, -1 / 16, 1 / 16, 0.5, 1, 4, 16]) {
    expect(positionToRate(rateToPosition(rate))).toBeCloseTo(rate, 9)
  }
})

test('snapUnity makes the bit-exact identity path reachable by dragging', () => {
  // Without this a user could never quite land on exactly 1.0 — the same trap
  // the engine smoother had before its 1 ppm snap.
  expect(snapUnity(0.995)).toBe(1)
  expect(snapUnity(1.02)).toBe(1)
  expect(snapUnity(-0.99)).toBe(-1)
  // ...but a deliberate nearby speed is left alone.
  expect(snapUnity(1.5)).toBe(1.5)
  expect(snapUnity(0.9)).toBe(0.9)
})

test('reverse reads as reverse, not as a negative number', () => {
  expect(formatRate(1)).toBe('1.00×')
  expect(formatRate(2)).toBe('2.00×')
  expect(formatRate(-1)).toBe('◀ 1.00×')
  expect(formatRate(0.5)).toBe('1/2.00')
  expect(formatRate(-0.25)).toBe('◀ 1/4.00')
})
