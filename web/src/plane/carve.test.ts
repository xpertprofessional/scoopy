import { describe, expect, it } from 'vitest'
import type { Strip } from '../persist/mapDocument.ts'
import { carve, stillReferenced } from './carve.ts'
import { newStrip, newTapeElement } from './stripOps.ts'

const RATE = 48000

const taped = (over: Partial<ReturnType<typeof newTapeElement>> = {}): Strip => ({
  ...newStrip(0, { x: 5, y: 7 }),
  key: 'a',
  name: 'TAKE 3',
  level: 0.6,
  sends: [0.1, 0, 0, 0.4],
  element: {
    ...newTapeElement(2, false),
    takeRef: '/takes/deck0_1730000000.wav',
    loop: { enabled: true, start: 48000, end: 96000 }, // 1.0s → 2.0s
    ...over,
  },
})

describe('carve', () => {
  it('points the track at the SAME take — a carve copies no audio', () => {
    // The invariant takeLibrary already tests. A carve that copied would grow
    // the session by the length of the take every time, and it would take a
    // full disk to notice.
    const r = carve(taped(), RATE)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.track.takeRef).toBe('/takes/deck0_1730000000.wav')
  })

  it('expresses the region as a TRIM in ms, which the pattern already understands', () => {
    const r = carve(taped(), RATE)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.track.sampleStartMs).toBe(1000)
      expect(r.track.sampleEndMs).toBe(2000)
    }
  })

  it('names the track with its REGION, not just the take', () => {
    // Four carves of one take are otherwise four tracks with the same label.
    const r = carve(taped(), RATE)
    if (r.ok) {
      expect(r.track.name).toContain('deck0_1730000000.wav')
      expect(r.track.name).toContain('1.0s')
      expect(r.track.name).toContain('2.0s')
    }
  })

  it('FREES THE TAPE LAYER and keeps everything else about the strip', () => {
    // "Freeing = clearing the layer, not destroying the audio." The object you
    // were looking at is still there, ready for the next capture, rather than
    // vanishing and reappearing.
    const before = taped()
    const r = carve(before, RATE)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.strip.element.kind).toBe('none')
      expect(r.strip.key).toBe(before.key)
      expect(r.strip.name).toBe(before.name)
      expect(r.strip.cell).toEqual(before.cell)
      expect(r.strip.level).toBe(0.6)
      expect(r.strip.sends).toEqual([0.1, 0, 0, 0.4])
      expect(r.strip.channel).toBe(before.channel)
    }
  })

  it('does not mutate the strip it was given', () => {
    const before = taped()
    carve(before, RATE)
    expect(before.element.kind).toBe('tape')
  })
})

describe('carve refuses rather than producing a silent track', () => {
  it('with no tape', () => {
    const r = carve({ ...newStrip(0, { x: 0, y: 0 }), key: 'a' }, RATE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('no tape')
  })

  it('with a tape that has never recorded', () => {
    const r = carve(taped({ takeRef: null }), RATE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('nothing recorded')
  })

  it('with the loop OFF — carving what you cannot see is worse than declining', () => {
    const r = carve(taped({ loop: { enabled: false, start: 0, end: 48000 } }), RATE)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('loop')
  })

  it('with an empty or inverted region', () => {
    expect(carve(taped({ loop: { enabled: true, start: 100, end: 100 } }), RATE).ok).toBe(false)
    expect(carve(taped({ loop: { enabled: true, start: 900, end: 100 } }), RATE).ok).toBe(false)
  })

  it('with no sample rate to convert against', () => {
    expect(carve(taped(), 0).ok).toBe(false)
  })
})

describe('what a carved take is still referenced by', () => {
  it('counts the SESSION track, not just the plane', () => {
    // A carved take is unreferenced by the plane BY DESIGN — the tape layer was
    // cleared. Reporting it as reclaimable would offer to delete audio a grid
    // track is playing.
    const ref = '/takes/t.wav'
    expect(stillReferenced(ref, [], [ref])).toBe(true)
    expect(stillReferenced(ref, [], [])).toBe(false)
  })

  it('counts a tape still holding it', () => {
    const ref = '/takes/t.wav'
    expect(stillReferenced(ref, [taped()], ['/other.wav'])).toBe(false)
    expect(stillReferenced('/takes/deck0_1730000000.wav', [taped()], [])).toBe(true)
  })
})
