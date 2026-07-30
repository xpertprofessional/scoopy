/**
 * P6-2b — an addressed window that was addressed WRONG must say so.
 *
 * The defect this pins: the plane's ≡ menu passed the 0-based menu ROW as the
 * panel's arg, and FxSlotPanel reads that arg as a 1-based `returnIndex`. `FX 1`
 * therefore sent "0", the panel indexed `fxSlots[-1]`, got `undefined`, and fell
 * through to `WaitingForState` — which renders "waiting for state" FOREVER.
 *
 * That is the worst shape of failure for an addressed window: it is
 * indistinguishable from a slow engine, so a person waits instead of reporting
 * it. The shipped real-host walk for P6-2/P6-3 ("≡ FX 1 → RESCAN → pick a
 * plugin") would have died on its first step with nothing to explain it — and
 * `FX 2`…`FX 4` would have quietly driven returns 1…3 while return 4 had no
 * door at all.
 *
 * Two halves, pinned in two places: the menu's labels-match-args property lives
 * in plane/panelMenu.test.ts; the panel's own refusal lives here. The panel is
 * the half that failed SILENTLY, so it validates rather than trusting callers.
 */
import { describe, expect, it } from 'vitest'
import { addressedReturn } from './FxSlotPanel.tsx'

describe('P6-2b · which return a window is addressed to', () => {
  it('takes 1–4 verbatim — the arg IS the return index', () => {
    expect(addressedReturn('1')).toBe(1)
    expect(addressedReturn('2')).toBe(2)
    expect(addressedReturn('3')).toBe(3)
    expect(addressedReturn('4')).toBe(4)
  })

  it('REFUSES 0 — the exact value the ≡ menu used to send for FX 1', () => {
    // Before the fix this resolved to 0, and `fxSlots[-1]` is undefined, so the
    // window waited on the engine for a slot that could never arrive.
    expect(addressedReturn('0')).toBeNull()
  })

  it('refuses a return past the last one, rather than reading off the end', () => {
    expect(addressedReturn('5')).toBeNull()
    expect(addressedReturn('99')).toBeNull()
  })

  it('refuses negatives and non-integers instead of rendering NaN at people', () => {
    expect(addressedReturn('-1')).toBeNull()
    expect(addressedReturn('2.5')).toBeNull()
    expect(addressedReturn('banana')).toBeNull()
  })

  it('treats ABSENT as return 1 — an unaddressed window is usable, not broken', () => {
    // The old `?? 1` fallback, kept deliberately: only a PRESENT-but-invalid
    // address is a refusal. This is the browser dev host's normal case.
    expect(addressedReturn(null)).toBe(1)
    expect(addressedReturn(undefined)).toBe(1)
    expect(addressedReturn('')).toBe(1)
  })

  it('never returns a value that would index outside fxSlots', () => {
    // The property the panel actually depends on: whatever comes back is either
    // null (refused) or a valid `fxSlots[n - 1]` subscript.
    for (const raw of ['0', '1', '4', '5', '-2', 'x', '', null, undefined, '3.0001']) {
      const n = addressedReturn(raw)
      if (n === null) continue
      expect(n - 1).toBeGreaterThanOrEqual(0)
      expect(n - 1).toBeLessThanOrEqual(3)
    }
  })
})
