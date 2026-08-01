/**
 * THE DECK ROWS — that every control on them is live, and that the ones which
 * cannot act say why.
 *
 * The bundle exists because `TransportPanel`'s ported deck block speaks nine
 * verbs no host answers. So the property worth pinning is not "the buttons
 * render" — it is that each one reaches a lane that exists, and that a disabled
 * control TEACHES rather than just greying out. Rendered to static markup like
 * `Strip.test.tsx` does (no jsdom in this suite — P3.5-E8g-f).
 */
import { describe, expect, it, beforeEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  DeckSceneRow,
  DeckSyncRow,
  DeckToolbarRow,
  DeckViewRow,
  type DeckRowsProps,
} from './deckRows.tsx'
import { newGridElement } from './stripOps.ts'
import { MAX_DECKS, idleDeck, useCompanion } from '../store/companionEngine.ts'
import type { Strip as StripDoc } from '../persist/mapDocument.ts'

const element = () => newGridElement(0, 'ses', 120)

const strip = (over: Partial<StripDoc> = {}): StripDoc =>
  ({
    key: 'k',
    name: 'beach',
    channel: 0,
    level: 1,
    monitor: false,
    cell: { x: 0, y: 0, w: 692, h: 612 },
    drive: { curve: 0, amount: 1 },
    element: element(),
    sends: [0, 0, 0, 0],
    muted: false,
    input: null,
    recordTap: null,
    sessionPerf: {},
    ...over,
  }) as unknown as StripDoc

const props = (over: Partial<DeckRowsProps> = {}): DeckRowsProps => ({
  strip: strip(),
  element: element(),
  link: null,
  masterBpm: 120,
  ...over,
})

const html = (node: React.ReactElement) => renderToStaticMarkup(node)

beforeEach(() => {
  useCompanion.setState({ decks: Array.from({ length: MAX_DECKS }, idleDeck) })
})

describe('row 1 — the toolbar', () => {
  it('carries the donor block in the APP\'s transport vocabulary (⟳ ▸ ↻ ◼)', () => {
    const out = html(<DeckToolbarRow {...props()} />)
    for (const verb of ['OPEN', '⟳', '▸', '↻', '◼', '»', 'DBL', 'SAVE', '⏏'])
      expect(out).toContain(verb)
    // The first cut spelled stop/play as ■/▶ and one-shot as ▸¹ — a second
    // dialect for verbs the strip directly above already names. One vocabulary.
    expect(out).not.toContain('■')
    expect(out).not.toContain('▶')
  })

  it('uses the design system\'s bar for WIN, never a bare range input', () => {
    // pd-visual-language §2.5: label · geometric bar · value, painted with an
    // inline gradient so the value reads as a SHAPE — and sized from
    // `--control-h` so a button beside a bar shares its baseline. A raw
    // `<input type="range">` would have been the only one in the tree.
    const out = html(<DeckSyncRow {...props()} />)
    expect(out).toContain('ds-geo')
    expect(out).toContain('ds-range')
  })

  it('disables the transport verbs with NO SESSION rather than firing into nothing', () => {
    const out = html(<DeckToolbarRow {...props()} />)
    // Every deck verb needs a loaded deck; the store starts idle here.
    expect((out.match(/disabled=""/g) ?? []).length).toBeGreaterThanOrEqual(5)
  })

  it('says WHY DBL cannot fire, instead of offering a menu onto nothing', () => {
    // The empty-target case, which is the one the plane hands over most often
    // (every other grid strip playing, or none loaded). It must read as a
    // reason, not as a grey button.
    const out = html(<DeckToolbarRow {...props({ doubleTargets: [] })} />)
    expect(out).toMatch(/nothing loaded to double|DBL needs a free grid strip/)
  })

  it('locks every writing verb behind the compose window, and SAVE stays live', () => {
    const out = html(<DeckToolbarRow {...props({ locked: true })} />)
    expect(out).toContain('editing in the compose window')
    // SAVE flushes a pending write and publishes nothing, so it is the one verb
    // that is MORE useful under the lock, not less.
    expect(out.match(/<button[^>]*>SAVE<\/button>/)?.[0] ?? '').not.toContain('disabled')
  })
})

/**
 * ⚠️ WHAT THESE PINS CANNOT SEE, and why the store cases are pinned elsewhere.
 *
 * `renderToStaticMarkup` is a SERVER render, and zustand v5 answers a server
 * render from `getInitialState()` — not from the live store. So a
 * `useCompanion.setState` here is invisible to the component: every
 * store-derived title renders at its default no matter what the test sets.
 *
 * That is not worked around with a fake, because a fake thin enough to pass
 * either way is a green gate that cannot see the defect (the P3.5-E8g-c
 * lesson). The store-dependent halves are pinned where they are real instead:
 * one-shot's two branches in `audio/deckTransport.test.ts`, DBL's three
 * refusals in `store/companionDecks.test.ts`. What is left here is what the ROW
 * itself decides — presence, the teach-strings, and the lock.
 *
 * The real fix is a mount-level renderer, which this suite does not have
 * (P3.5-E8g-f, owner: user/conductor).
 */

describe('row 2 — sync, pulse, TR, TP, WIN, BR, REV', () => {
  it('carries every hand control', () => {
    const out = html(<DeckSyncRow {...props()} />)
    for (const verb of ['FREE', 'TR', 'TP', 'WIN', 'BR', 'REV']) expect(out).toContain(verb)
  })

  it('reads FREE unsynced and SYNC synced — the state IS the label', () => {
    expect(html(<DeckSyncRow {...props()} />)).toContain('FREE')
    const synced = { ...element(), syncToMaster: true }
    const out = html(<DeckSyncRow {...props({ element: synced, strip: strip({ element: synced }) })} />)
    expect(out).toContain('SYNC')
  })

  it('teaches that TP mode is what makes SYNC and TR exclusive', () => {
    expect(html(<DeckSyncRow {...props()} />)).toContain('SYNC and TR may both run')
    const tp = { ...element(), pitchMode: true }
    const out = html(<DeckSyncRow {...props({ element: tp, strip: strip({ element: tp }) })} />)
    expect(out).toContain('SYNC and TR exclude each other')
  })

  it('the BR shift TEACHES its two preconditions rather than only greying out', () => {
    // Both donor guards are no-ops, so the control stays put (L2: fill, never
    // presence) — which only works if it says what it is waiting for.
    const out = html(<DeckSyncRow {...props()} />)
    expect(out).toContain('latch BR first')
  })

  it('nudge on a FREE deck explains that the law bends the SYNCED target', () => {
    expect(html(<DeckSyncRow {...props()} />)).toContain('turn SYNC on first')
  })
})

describe('row 3 — the scene controls (B2 completes P7-T3)', () => {
  it('wears the switch mode as a CYCLER, not three buttons', () => {
    // The donor holds ONE three-way choice (SCHED · RUN · START) plus a
    // separate clean-cut boolean. P7-T3's "S · R · CU" sketch had three letters
    // for four states, and the one it dropped was START.
    const out = html(<DeckSceneRow {...props()} />)
    expect(out).toContain('SCHED')
    expect(out).toContain('CU')
    expect(out).toContain('SCN')
  })

  it("carries the donor's help text verbatim, because that sentence IS the mode", () => {
    const out = html(<DeckSceneRow {...props()} />)
    expect(out).toContain(
      'Scene clicks schedule during playback and switch immediately when stopped.',
    )
  })

  it('locks with the compose window like every other writing control', () => {
    expect(html(<DeckSceneRow {...props({ locked: true })} />)).toContain(
      'editing in the compose window',
    )
  })

  it('carries MUTE, and points at the pin door for what is not a row control', () => {
    // A pin belongs to the parameter, not to this row — it rides each DragBox's
    // right-click menu, where the donor puts it too. MUTE is a row control
    // because the group is a deck-level gesture.
    const out = html(<DeckSceneRow {...props()} />)
    expect(out).toContain('MUTE')
    expect(out).toContain('right-click any value to pin it to this scene')
  })

  it('teaches how a mute group is BUILT when it is still empty', () => {
    // An empty group silences nothing, so the control has to say what to do
    // next rather than looking broken when pressing it changes nothing.
    const out = html(<DeckSceneRow {...props()} />)
    expect(out).toContain('engage the group, then a track')
  })
})

describe('row 4 — the view switch', () => {
  it('carries GRID, and NOT PERF', () => {
    // PERF moved to the SYNC row (user, 2026-08-01). It is a POINTER MODE —
    // drag a track to set its locator window live — not a view, and sitting
    // beside GRID is what made it look like somewhere a view change could be
    // hung: it briefly drove a reduced control density too, which is exactly
    // the overreach that got rejected ("abused for view changes we did not
    // request"). This row is the view axis; PERF is not on it.
    const out = html(
      <DeckViewRow {...props({ onToggleCells: () => {}, onTogglePerform: () => {} })} />,
    )
    expect(out).toContain('GRID')
    expect(out).not.toContain('PERF')
  })
})

describe('row 2 — PERF rides with the live gestures', () => {
  it('the sync row carries PERF, beside BR and REV', () => {
    // Its neighbours are the point: BR (beat repeat) and REV are the other
    // gestures that change what PLAYS without editing the document, armed and
    // released mid-set. PERF is one of those.
    const out = html(<DeckSyncRow {...props({ onTogglePerform: () => {} })} />)
    expect(out).toContain('PERF')
    expect(out).toContain('BR')
    expect(out).toContain('REV')
  })
})
