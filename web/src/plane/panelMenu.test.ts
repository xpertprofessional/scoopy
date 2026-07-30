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
import type { MenuItem } from '../design/ContextMenu.tsx'
import {
  FX_MENU_RETURNS,
  PANEL_MENU_SURFACES,
  SETTINGS_SURFACES,
  mapMenuItems,
  panelsMenuItems,
} from './PlanePanel.tsx'

const labelsOf = (items: MenuItem[]) =>
  items.flatMap((i) => (i.kind === 'item' ? [i.label] : []))

/** Select every row in a menu and record what each one actually asked for. */
function selectAll(items: MenuItem[]): void {
  for (const i of items) if (i.kind === 'item') i.onSelect()
}

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

/**
 * P11-1 — THE THREE ZONES, and the retirements that came with them.
 *
 * The row's gate is "every retired item still reachable somewhere". That is a
 * claim about the UNION of what the bar's two menus can open, so it is asserted
 * against the builders rather than read off the JSX — a source grep would pass
 * on a menu that renders a row and wires it to nothing.
 */
describe('P11-1 · map ▾ — the document verbs, in one menu', () => {
  const build = () => {
    const calls: string[] = []
    const items = mapMenuItems({
      save: () => calls.push('save'),
      exportPackage: () => calls.push('export'),
      open: () => calls.push('open'),
      settings: (panel) => calls.push(`settings:${panel}`),
    })
    return { calls, items }
  }

  it('carries the three file verbs that used to be their own bar buttons', () => {
    // save / export / open were three permanent buttons sitting in front of the
    // transport. They are one menu now; none of them was dropped in the fold.
    const { calls, items } = build()
    selectAll(items)
    expect(calls).toContain('save')
    expect(calls).toContain('export')
    expect(calls).toContain('open')
  })

  it('is where SETTINGS live now — the one rehome D-SL-TOPROW-01 names', () => {
    const { calls, items } = build()
    selectAll(items)
    for (const [panel] of SETTINGS_SURFACES) {
      expect(calls, `${panel} must be reachable from map ▾`).toContain(`settings:${panel}`)
    }
  })

  it('opens each settings panel by its own id — not by menu position', () => {
    // The P6-2b failure, one menu over: a row whose arg is its index addresses
    // whatever happens to sit at that index. Each row names its panel.
    const { calls, items } = build()
    selectAll(items)
    const opened = calls.filter((c) => c.startsWith('settings:')).map((c) => c.slice(9))
    expect(opened).toEqual(SETTINGS_SURFACES.map(([p]) => p))
  })

  it('reuses the ContextMenu shape rather than inventing a popover kind', () => {
    // The row is explicit about this. Every row is a MenuItem the shared
    // ContextMenu already renders — info headers, a separator, and items.
    const { items } = build()
    for (const i of items) expect(['item', 'info', 'sep']).toContain(i.kind)
    expect(items.some((i) => i.kind === 'sep')).toBe(true)
  })
})

describe('P11-1 · ≡ panels keeps exactly what has nowhere else to go', () => {
  const build = () => {
    const fx: string[] = []
    const surfaces: string[] = []
    const items = panelsMenuItems({
      fx: (arg) => fx.push(arg),
      surface: (panel) => surfaces.push(panel),
    })
    return { fx, surfaces, items }
  }

  it('SETTINGS LEFT — the departure half of the rehome', () => {
    // Checked at BOTH ends deliberately: a rehome verified only at the arrival
    // end leaves a duplicate, and only at the departure end leaves an orphan.
    const { surfaces, items } = build()
    selectAll(items)
    for (const [panel] of SETTINGS_SURFACES) {
      expect(surfaces, `${panel} moved to map ▾ and must not still be here`).not.toContain(panel)
    }
  })

  it('FX 1–4 STAYED — they wait on P7-MIX-0 and this is their only door', () => {
    // Conductor ruling: no interim home. A door that works today is not worth
    // trading for a tidier bar.
    const { fx, items } = build()
    selectAll(items)
    expect(fx).toEqual(['1', '2', '3', '4'])
  })

  it('the five surfaces STAYED — retiring the button would orphan them (P11-1-a)', () => {
    // Measured for P11-1: `openPanelWindow` has four call sites and all four are
    // in PlanePanel.tsx, so this menu is the ONLY door to these five.
    // D-SL-TOPROW-01 names a new home for settings alone.
    const { surfaces, items } = build()
    selectAll(items)
    expect(surfaces).toEqual(PANEL_MENU_SURFACES.map(([p]) => p))
  })
})

describe('P11-1 · nothing the bar used to open became unreachable', () => {
  it('the two menus together still reach every panel the four old buttons did', () => {
    // THE ROW'S GATE, as one assertion. Before P11-1 the bar could open: the
    // four FX returns, the five surfaces, the five settings panels. After it,
    // the same fifteen must be reachable from map ▾ or ≡ panels between them.
    const reached = new Set<string>()
    selectAll(
      mapMenuItems({
        save: () => {},
        exportPackage: () => {},
        open: () => {},
        settings: (panel) => void reached.add(panel),
      }),
    )
    selectAll(
      panelsMenuItems({
        fx: (arg) => void reached.add(`fxslot:${arg}`),
        surface: (panel) => void reached.add(panel),
      }),
    )

    const before = [
      ...FX_MENU_RETURNS.map(([, arg]) => `fxslot:${arg}`),
      ...PANEL_MENU_SURFACES.map(([p]) => p),
      ...SETTINGS_SURFACES.map(([p]) => p),
    ]
    for (const panel of before) {
      expect(reached, `${panel} lost its door in the re-zoning`).toContain(panel)
    }
    expect(reached.size).toBe(before.length)
  })

  it('every menu row is wired — a row that opens nothing is worse than no row', () => {
    for (const items of [
      mapMenuItems({ save: () => {}, exportPackage: () => {}, open: () => {}, settings: () => {} }),
      panelsMenuItems({ fx: () => {}, surface: () => {} }),
    ]) {
      for (const i of items) {
        if (i.kind === 'item') expect(typeof i.onSelect, `${i.label} has no handler`).toBe('function')
      }
      expect(labelsOf(items).length).toBeGreaterThan(0)
    }
  })
})
