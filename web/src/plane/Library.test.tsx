/**
 * P3-L1 — the library popover's honesty rules, SSR (the house pattern).
 *
 * The interesting property is the LOADED gate: a session open in a deck must
 * refuse rename/delete, because the autosaver holds the open WorkingSession by
 * name — renaming under it would re-create the old directory on the next
 * autosave, and deleting would leave a deck playing a ghost.
 *
 * Props, not store reads: under `renderToStaticMarkup` a store hook serves the
 * SERVER snapshot (the initial state), so a store-reading component is
 * untestable this way — which is why Strip/Master take props too.
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Library, loadedDeckOf } from './Library.tsx'
import type { SessionSummary } from '../store/sessionStore.ts'

const render = (
  sessions: SessionSummary[],
  decks: ReadonlyArray<{ session: { name: string } | null }> = [],
) =>
  renderToStaticMarkup(
    <Library sessions={sessions} decks={decks} refresh={() => Promise.resolve()} onNote={() => {}} />,
  )

describe('P3-L1 · the library popover', () => {
  it('offers New and import over an honest empty state', () => {
    const html = render([])
    expect(html).toContain('New')
    expect(html).toContain('import')
    expect(html).toContain('no sessions yet')
  })

  it('lists sessions with live rename/delete verbs', () => {
    const html = render([
      { name: 'Beach', modifiedMs: 2 },
      { name: 'Untitled 2', modifiedMs: 1 },
    ])
    expect(html).toContain('Beach')
    // The "Untitled 2" name class renders verbatim — the byte-round-trip rule
    // at the surface tier.
    expect(html).toContain('Untitled 2')
    expect(html).toContain('✎')
    expect(html).toContain('✕')
    expect(html).not.toContain('disabled')
  })

  it('locks rename/delete for a session loaded in a deck, and says which deck', () => {
    const html = render(
      [{ name: 'Beach', modifiedMs: 1 }],
      [{ session: null }, { session: { name: 'Beach' } }],
    )
    expect(html).toContain('deck 2')
    expect(html).toContain('unload it')
    expect(html).toMatch(/disabled/)
  })
})

describe('loadedDeckOf', () => {
  it('finds the deck holding a session, -1 otherwise', () => {
    const decks = [
      { session: null },
      { session: { name: 'A' } },
      { session: { name: 'B' } },
    ]
    expect(loadedDeckOf(decks, 'B')).toBe(2)
    expect(loadedDeckOf(decks, 'C')).toBe(-1)
  })
})
