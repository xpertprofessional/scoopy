/**
 * P11-2 — the master CLOCK: the tap maths and the honestly-dead EXT control.
 *
 * The row's gate names this file: "vitest on the tap-interval math (outlier
 * rejection, a 4-tap window)". Pure functions, no jsdom (the house rule) —
 * tempo derived from a hand-written series of timestamps, so every case is
 * exact and none of it depends on a real clock.
 */
import { describe, expect, it } from 'vitest'
import {
  TAP_MAX_BPM,
  TAP_MIN_BPM,
  TAP_TIMEOUT_MS,
  TAP_WINDOW,
  externalClockState,
  rejectOutliers,
  tapTempo,
} from './masterClock.ts'

/** Tap a whole series through, as a hand would. Returns the last result. */
function tapAll(times: readonly number[]) {
  let taps: number[] = []
  let bpm: number | null = null
  for (const t of times) ({ taps, bpm } = tapTempo(taps, t))
  return { taps, bpm }
}

/** A steady series of `count` taps at `ms` apart, starting at 1000. */
const steady = (ms: number, count: number) =>
  Array.from({ length: count }, (_, i) => 1000 + i * ms)

describe('P11-2 · tap tempo — the interval maths', () => {
  it('says NOTHING from a single tap', () => {
    // One tap has no interval. Reporting a tempo here would be inventing one.
    const { bpm } = tapAll([1000])
    expect(bpm).toBeNull()
  })

  it('answers from the SECOND tap, so the button responds rather than waiting', () => {
    // 500 ms apart = 120 BPM. Requiring the full window before saying anything
    // would make the first two presses look dead.
    expect(tapAll(steady(500, 2)).bpm).toBe(120)
  })

  it('derives the tempo of a steady four-tap series', () => {
    expect(tapAll(steady(500, 4)).bpm).toBe(120)
    expect(tapAll(steady(400, 4)).bpm).toBe(150)
    expect(tapAll(steady(1000, 4)).bpm).toBe(60)
  })

  it('keeps only a FOUR-TAP window — the row names the number', () => {
    const { taps } = tapAll(steady(500, 9))
    expect(taps).toHaveLength(TAP_WINDOW)
  })

  it('FOLLOWS a tempo change instead of averaging in the old one', () => {
    // The window is what makes this work: tap 120 for a while, then 150, and
    // the old intervals fall out the back rather than dragging the answer.
    let taps: number[] = []
    let bpm: number | null = null
    for (const t of steady(500, 6)) ({ taps, bpm } = tapTempo(taps, t))
    expect(bpm).toBe(120)
    let t = taps[taps.length - 1]!
    for (let i = 0; i < 4; i++) ({ taps, bpm } = tapTempo(taps, (t += 400)))
    expect(bpm).toBe(150)
  })
})

describe('P11-2 · tap tempo — outlier rejection', () => {
  it('rejects a MISSED tap — one interval at double the others', () => {
    // The realistic fumble: your hand skips a beat, so one gap is ~2x. A plain
    // mean of [500,1000,500] is 666 ms = 90 BPM, a third off. The median says
    // 500 and the doubled interval is out-voted.
    expect(tapAll([1000, 1500, 2500, 3000]).bpm).toBe(120)
  })

  it('rejects a DOUBLE tap — one interval at half the others', () => {
    // [500, 250, 500] → a mean of 416 ms = 144 BPM. Rejected the same way.
    expect(tapAll([1000, 1500, 1750, 2250]).bpm).toBe(120)
  })

  it('keeps BOTH intervals when there are only two — no majority, no guess', () => {
    // With two intervals a median is just their mean, so "which is wrong" has
    // no honest answer. Dropping either would be a coin toss dressed as maths.
    expect(rejectOutliers([500, 1000])).toEqual([500, 1000])
  })

  it('rejects nothing from a steady series', () => {
    expect(rejectOutliers([500, 500, 500])).toEqual([500, 500, 500])
    expect(rejectOutliers([500, 510, 490])).toEqual([500, 510, 490])
  })

  it('keeps the whole window when EVERY interval is an outlier', () => {
    // A series too ragged to have a beat: the median was not describing one
    // either, so returning nothing would be a false precision. Keep them and
    // let the BPM range refuse it.
    const kept = rejectOutliers([100, 1000, 5000])
    expect(kept.length).toBeGreaterThan(0)
  })
})

describe('P11-2 · tap tempo — the series boundaries', () => {
  it('starts a NEW series after a long gap, rather than extending the old', () => {
    const first = tapAll(steady(500, 4))
    const { taps, bpm } = tapTempo(first.taps, first.taps[3]! + TAP_TIMEOUT_MS + 1)
    expect(taps).toHaveLength(1) // the old series is abandoned…
    expect(bpm).toBeNull() // …and one tap says nothing
  })

  it('continues the series at exactly the timeout', () => {
    const first = tapAll(steady(500, 2))
    const { taps } = tapTempo(first.taps, first.taps[1]! + TAP_TIMEOUT_MS)
    expect(taps).toHaveLength(3)
  })

  it('refuses a tempo outside the range the tempo box accepts', () => {
    // Reported as "cannot say" rather than clamped: clamping would silently set
    // 20 when you fumbled, and teach that the button is erratic.
    expect(tapAll([1000, 1000 + 60000 / TAP_MIN_BPM + 500]).bpm).toBeNull()
    expect(tapAll([1000, 1010]).bpm).toBeNull() // 6000 BPM
    expect(TAP_MAX_BPM).toBe(300)
  })

  it('survives two taps in the same millisecond without dividing by zero', () => {
    expect(tapAll([1000, 1000]).bpm).toBeNull()
  })

  it('rounds to one decimal, like the steppers — no float dust in the document', () => {
    const { bpm } = tapAll(steady(437, 4))
    expect(bpm).not.toBeNull()
    expect(bpm).toBe(Math.round(bpm! * 10) / 10)
  })
})

describe('P11-2 · EXT is honestly dead, whatever the capabilities say', () => {
  it('is DISABLED even when the host claims MIDI hardware', () => {
    // THE POINT OF THE FUNCTION. Capabilities default to FULL (every flag true
    // until a host narrows them), so a control gated on `midiHardware` alone
    // renders LIVE before the handshake lands — and stays live in any render
    // path whose effect never runs. Briefly operable and permanently useless is
    // exactly what the four rules exist to stop.
    expect(externalClockState({ midiHardware: true }).enabled).toBe(false)
    expect(externalClockState({ midiHardware: false }).enabled).toBe(false)
  })

  it('always carries a reason, and the two hosts get DIFFERENT true sentences', () => {
    const withMidi = externalClockState({ midiHardware: true })
    const without = externalClockState({ midiHardware: false })
    expect(withMidi.reason).toBeTruthy()
    expect(without.reason).toBeTruthy()
    expect(withMidi.reason).not.toBe(without.reason)
    // The no-hardware sentence must not blame an unimplemented method, and the
    // has-hardware one must not claim there is no hardware.
    expect(without.reason).toContain('no MIDI hardware')
    expect(withMidi.reason).toContain('getMidiClockStatus')
  })
})
