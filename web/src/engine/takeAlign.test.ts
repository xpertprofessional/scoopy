import { expect, test } from 'vitest'
import type { Take } from '../../protocol/schema'
import {
  alignOffsetSamples,
  alignOffsetSeconds,
  alignedStartSample,
  formatOffset,
  relativeToEarliest,
  takesOverlap,
} from './takeAlign'

const RATE = 48000

function take(path: string, start: number, frames: number, deckId = 0): Take {
  return {
    deckId,
    path,
    startEngineSample: start,
    frames,
    sampleRate: RATE,
    channels: 1,
    sourceDesc: 'test',
  }
}

test('align is a subtraction of stamps — the whole of Law C-2', () => {
  const deck1 = take('a.wav', 48000, 96000) // starts at 1.0 s, runs 2.0 s
  const deck2 = take('b.wav', 120000, 48000) // starts at 2.5 s, runs 1.0 s
  // deck2 began 72000 samples (1.5 s) after deck1 — exactly, no rounding.
  expect(alignOffsetSamples(deck2, deck1)).toBe(72000)
  expect(alignOffsetSamples(deck1, deck2)).toBe(-72000)
  expect(alignOffsetSeconds(deck2, deck1, RATE)).toBeCloseTo(1.5, 12)
})

test('a take aligned to itself is in phase', () => {
  const t = take('a.wav', 1234567, 1000)
  expect(alignOffsetSamples(t, t)).toBe(0)
  expect(formatOffset(0, RATE)).toBe('in phase')
})

test('relativeToEarliest gives each take its leading silence from a common origin', () => {
  const takes = [
    take('late.wav', 200000, 1000),
    take('first.wav', 50000, 1000),
    take('mid.wav', 125000, 1000),
  ]
  const rel = relativeToEarliest(takes)
  expect(rel.get('first.wav')).toBe(0) // the origin
  expect(rel.get('mid.wav')).toBe(75000)
  expect(rel.get('late.wav')).toBe(150000)
  // Every offset is non-negative — they lay side by side on a common origin.
  for (const v of rel.values()) expect(v).toBeGreaterThanOrEqual(0)
  expect(relativeToEarliest([]).size).toBe(0)
})

test('overlap detects takes captured simultaneously (the C-2 use case)', () => {
  const deck1 = take('a.wav', 0, 96000) // 0 → 2 s
  const midTake = take('b.wav', 48000, 96000) // 1 → 3 s: started DURING deck1
  const later = take('c.wav', 200000, 1000) // well after both
  expect(takesOverlap(deck1, midTake)).toBe(true)
  expect(takesOverlap(midTake, deck1)).toBe(true) // symmetric
  expect(takesOverlap(deck1, later)).toBe(false)
  // Abutting takes (one ends exactly where the next begins) do NOT overlap.
  expect(takesOverlap(take('x', 0, 100), take('y', 100, 100))).toBe(false)
})

test('alignedStartSample shifts into an earlier take, never past its end', () => {
  const reference = take('ref.wav', 100000, 48000)
  const later = take('later.wav', 150000, 48000) // started after the reference
  expect(alignedStartSample(later, reference)).toBe(0) // plays from its own start

  const earlier = take('earlier.wav', 90000, 48000) // started 10000 before
  expect(alignedStartSample(earlier, reference)).toBe(10000) // skip in by the delta

  // A take that ended before the reference even began can't be aligned into:
  // the honest answer is its own start, not an out-of-range index.
  const wayEarlier = take('way.wav', 0, 1000)
  expect(alignedStartSample(wayEarlier, reference)).toBe(0)
})

test('offset formatting is signed and readable', () => {
  expect(formatOffset(72000, RATE)).toBe('+1.500 s')
  expect(formatOffset(-72000, RATE)).toBe('−1.500 s')
  expect(formatOffset(48, RATE)).toBe('+0.001 s')
  expect(formatOffset(100, 0)).toBe('100 spl') // no rate: honest sample count
})
