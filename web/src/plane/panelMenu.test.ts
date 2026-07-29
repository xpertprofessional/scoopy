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
import { PANEL_MENU_SURFACES } from './PlanePanel.tsx'

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
