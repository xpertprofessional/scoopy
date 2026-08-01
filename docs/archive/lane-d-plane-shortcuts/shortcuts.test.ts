/**
 * P7-K4 — what the shortcut window is allowed to claim.
 *
 * ⚠️ WHAT THESE PINS CANNOT SEE, stated first because it is the whole risk of
 * this row: **none of them proves the overlay is reachable.** There is no
 * renderer here and no DOM — "the overlay appeared when I clicked `? keys`" is
 * a real-host walk and nothing else. What they do prove is the half a walk is
 * bad at: that the 57 parked rows can never be presented as working, whatever
 * the JSX around them does.
 *
 * That split is why `shortcutSections` is a pure builder rather than inline
 * JSX — the same reason, in the same words, as `panelMenu.test.ts`: a gate that
 * has to grep the render proves nothing.
 */
import { describe, expect, it } from 'vitest'
import { KEYMAP } from '../commands/keymap.ts'
import { DISPATCH_CAVEAT, keymapTally, shortcutSections } from './Shortcuts.tsx'

const all = shortcutSections({ includeParked: true })
const live = shortcutSections({ includeParked: false })
const rowsOf = (s: ReturnType<typeof shortcutSections>) => s.flatMap((x) => x.rows)

describe('P7-K4 · the tally is counted, never typed', () => {
  it('agrees with the keymap itself', () => {
    const entries = KEYMAP.flatMap((s) => s.entries)
    const t = keymapTally()
    expect(t.rows).toBe(entries.length)
    expect(t.parked).toBe(entries.filter((e) => e.parked !== undefined).length)
    expect(t.live).toBe(t.rows - t.parked)
    expect(t.slots).toBe(entries.reduce((n, e) => n + e.chords.length, 0))
  })

  it('is the ratio NAV-SHORTCUTS §6 measured — 42 of 99, 216 chord slots', () => {
    // Pinned as NUMBERS deliberately. If a later row un-parks something, this
    // goes red and the window's header sentence gets re-read rather than
    // quietly re-counted — the count is the promise this window makes.
    expect(keymapTally()).toEqual({ rows: 99, live: 42, parked: 57, slots: 216 })
  })
})

describe('P7-K4 · a parked row can never look like a working one', () => {
  it('carries every row through in order, with its reason intact', () => {
    // Positional, not keyed by display string: "⌥← / ⌥→" is declared in both
    // Cell Editing and File Browser, so a lookup by `keys` would compare the
    // wrong two rows and pass while doing it.
    const entries = KEYMAP.flatMap((s) => s.entries)
    const rows = rowsOf(all)
    expect(rows).toHaveLength(entries.length)
    rows.forEach((row, i) => {
      const entry = entries[i]
      expect(row.keys).toBe(entry?.keys)
      expect(row.label).toBe(entry?.label)
      expect(row.parked).toBe(entry?.parked)
    })
    const parked = rows.filter((r) => r.parked !== undefined)
    expect(parked).toHaveLength(57)
    // `park()` makes a reasonless parked row unexpressible upstream; this is
    // the render end of the same guarantee.
    for (const r of parked) expect(r.parked).not.toBe('')
  })

  it('never lets a parked row through when they are hidden', () => {
    expect(rowsOf(live)).toHaveLength(42)
    expect(rowsOf(live).every((r) => r.parked === undefined)).toBe(true)
  })

  it('drops a section that is entirely parked rather than leaving a bare heading', () => {
    // Five of the twenty are wholly parked — the common case, not an edge one.
    const gone = KEYMAP.filter((s) => s.entries.every((e) => e.parked !== undefined)).map(
      (s) => s.title,
    )
    expect(gone).toEqual([
      'Speed Multipliers (selected track)',
      'Pattern Shift',
      'Recording',
      'Musical Keyboard Mode',
      'Sample Pads & Chops',
    ])
    for (const title of gone) expect(live.map((s) => s.title)).not.toContain(title)
    expect(live.every((s) => s.rows.length > 0)).toBe(true)
  })
})

describe('P7-K4 · the donor render, followed', () => {
  it('keeps Help-window section order and every section', () => {
    expect(all.map((s) => s.title)).toEqual(KEYMAP.map((s) => s.title))
  })

  it('carries the section notes the donor rendered under their entries', () => {
    const withNotes = all.filter((s) => s.note !== undefined).map((s) => s.title)
    expect(withNotes).toEqual(
      KEYMAP.filter((s) => s.note !== undefined).map((s) => s.title),
    )
    expect(all.find((s) => s.title === 'Pattern Scenes')?.note).toContain('When stopped')
  })

  it('shows the display chord as declared — a range stays a range', () => {
    const keys = rowsOf(all).map((r) => r.keys)
    expect(keys).toContain('⌃1–8')
    expect(keys).toContain('ö')
    // The 35-character piano row the donor's 22-column pad would have clipped.
    expect(keys).toContain("A W S E D F T G Y H U J K O L P ; '")
  })

  it('gives every row a unique expand id', () => {
    const ids = rowsOf(all).map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('P7-K4 · the caveat that stops the OTHER overclaim', () => {
  it('says un-parked is not the same as bound', () => {
    // NAV-SHORTCUTS §6 splits the 42: only 3 LIVE + 12 DECLARED-LIVE fire, and
    // the 12 fire in GridPanel — `browserKeymap` mounts on a BrowserLink only,
    // so the merged host's plane answers no chord at all today. The window has
    // to say so or it promises 42 where it can keep 15.
    expect(DISPATCH_CAVEAT).toContain('DECLARED')
    expect(DISPATCH_CAVEAT).toContain('compose grid')
  })
})
