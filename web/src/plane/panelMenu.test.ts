/**
 * P3-P1 — the dead doors are retired (D-SL-MORPH-01, user 2026-07-29).
 *
 * djmode / deckmixer / transport windows hang on "waiting for state" in the
 * merged host: they wait on pushed UiState topics (`attachDj`/`attachToolbar`)
 * that only the carved-off Swift shell ever served. A menu row that opens a
 * tombstone is worse than none — their jobs live on the plane (master bar
 * verbs P3-M-1b, the deck tile P3-D4). The panels themselves stay routed in
 * App.tsx: retired means no door, not deleted code.
 */
import { describe, expect, it } from 'vitest'
import { FX_MENU_RETURNS, PANEL_MENU_SURFACES } from './PlanePanel.tsx'

describe('P3-P1 · the ≡ menu surfaces', () => {
  it('no longer offers the WaitingForState tombstones', () => {
    const panels = PANEL_MENU_SURFACES.map(([p]) => p)
    expect(panels).not.toContain('djmode')
    expect(panels).not.toContain('deckmixer')
    expect(panels).not.toContain('transport')
  })

  it('keeps every mechanical surface that actually works in the merged host', () => {
    expect(PANEL_MENU_SURFACES.map(([p]) => p)).toEqual([
      'spectral',
      'paintmode',
      'midi',
      'perf',
      'capture',
    ])
  })
})

describe('P6-2b · the FX rows address the return they NAME', () => {
  it('sends the 1-based returnIndex, not the row position', () => {
    // The defect: the rows were built from [0,1,2,3] and labelled slot+1, so
    // `FX 1` opened the panel with arg "0". FxSlotPanel indexes
    // `fxSlots[returnIndex - 1]`, so that read fxSlots[-1] → undefined → an
    // ETERNAL "waiting for state", and FX 2…4 addressed returns 1…3 while
    // return 4 had no door at all.
    expect(FX_MENU_RETURNS).toEqual([
      ['FX 1 ⇱', '1'],
      ['FX 2 ⇱', '2'],
      ['FX 3 ⇱', '3'],
      ['FX 4 ⇱', '4'],
    ])
  })

  it('every label and its arg are the SAME number — the property that cannot drift', () => {
    for (const [label, arg] of FX_MENU_RETURNS) {
      expect(label).toContain(arg)
      const n = Number(arg)
      expect(Number.isInteger(n) && n >= 1 && n <= 4).toBe(true)
    }
  })

  it('covers all four returns, so none is unreachable', () => {
    expect(FX_MENU_RETURNS.map(([, a]) => a)).toEqual(['1', '2', '3', '4'])
  })
})
