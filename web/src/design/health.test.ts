import { describe, expect, it } from 'vitest'
import { healthView, latchMisses } from './health.ts'

/**
 * P11-5's gate: *a forced overrun increments the counter and it never
 * decreases*, plus the readout rules the master bar paints from it.
 *
 * These are pure-function pins on purpose — the readout is painted on a rAF
 * loop straight from the HotFrame, never through React state, so the
 * arithmetic is the only part a test can hold still (the P11-0 precedent).
 */

describe('the overrun total never decreases (P11-5 gate)', () => {
  it('follows the engine counter up', () => {
    expect(latchMisses(0, 0)).toBe(0)
    expect(latchMisses(0, 1)).toBe(1)
    expect(latchMisses(1, 7)).toBe(7)
  })

  it('a forced overrun increments it', () => {
    // The whole gate, as a sequence: quiet, then the engine reports one
    // overrun, then another. Nothing else moves the number.
    let latched = 0
    for (const frame of [0, 0, 1, 1, 2]) latched = latchMisses(latched, frame)
    expect(latched).toBe(2)
  })

  it('REFUSES to follow the engine counter back down', () => {
    // `deadlineMissCount_` restarts at zero when the device reopens (a rate
    // change, a device switch). An overrun that happened was audible; it must
    // not un-happen because the driver restarted.
    let latched = 0
    for (const frame of [3, 5, 0, 0, 1]) latched = latchMisses(latched, frame)
    expect(latched).toBe(5)
  })

  it('ignores a garbage frame rather than latching it forever', () => {
    // A latch is permanent, so NaN/Infinity from a half-written frame would
    // poison the readout for the whole session.
    expect(latchMisses(4, Number.NaN)).toBe(4)
    expect(latchMisses(4, Number.POSITIVE_INFINITY)).toBe(4)
  })
})

describe('what the master bar reads', () => {
  it('says — rather than 0% before any HotFrame arrives', () => {
    // "no load" and "no engine" are the two states a health readout must not
    // blur: a confident 0% on a dead engine is the exact lie this row exists
    // to stop.
    const v = healthView(0, 0, 0, false)
    expect(v.text).toBe('DSP —')
    expect(v.tone).toBe('ok')
  })

  it('reads load as a percentage of the block deadline', () => {
    expect(healthView(0.03, 0, 0, true).text).toBe('DSP 3%')
    expect(healthView(0.5, 0, 0, true).text).toBe('DSP 50%')
  })

  it('flips colour on the way up and back down again', () => {
    expect(healthView(0.5, 0, 0, true).tone).toBe('ok')
    expect(healthView(0.8, 0, 0, true).tone).toBe('warn')
    expect(healthView(0.95, 0, 0, true).tone).toBe('hot')
    // Load recovers on its own, so the colour follows it back.
    expect(healthView(0.2, 0, 0, true).tone).toBe('ok')
  })

  it('shows the count only once something has actually dropped', () => {
    expect(healthView(0.1, 0, 0, true).text).toBe('DSP 10%')
    expect(healthView(0.1, 2, 0, true).text).toBe('DSP 10% ✕2')
  })

  it('STAYS hot after a dropout even when load has recovered', () => {
    // This is the whole reason the count is a total and not a rate: a glance
    // has to answer "did it drop while I was not looking".
    const v = healthView(0.05, 1, 0, true)
    expect(v.tone).toBe('hot')
    expect(v.dropped).toBe(1)
  })

  it('acknowledging clears the count without rewriting history', () => {
    // Ack moves the baseline, it does not reset the latch — so a LATER
    // overrun still shows up as one, not as the running total again.
    expect(healthView(0.05, 5, 5, true).text).toBe('DSP 5%')
    expect(healthView(0.05, 5, 5, true).tone).toBe('ok')
    expect(healthView(0.05, 6, 5, true).text).toBe('DSP 5% ✕1')
  })

  it('clamps a runaway load rather than printing a four-digit percentage', () => {
    // A blocked callback can report a load far over 1. The readout has a fixed
    // width in the bar; a number that shoves the tempo box off screen is worse
    // than a number that says "pinned".
    expect(healthView(50, 0, 0, true).text).toBe('DSP 999%')
    expect(healthView(-1, 0, 0, true).text).toBe('DSP 0%')
  })

  it('says what the number MEANS, because CPU% next to a UI meter taught nobody', () => {
    expect(healthView(0.1, 0, 0, true).title).toContain('block deadline')
    expect(healthView(0.1, 3, 0, true).title).toContain('acknowledge')
  })
})
