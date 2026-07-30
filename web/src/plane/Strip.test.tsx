import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Strip, formatGain, formatRate, inputDeviceMenuItems, waveWidth } from './Strip.tsx'
import type { MenuItem } from '../design/ContextMenu.tsx'
import { newGridElement, newStrip, newTapeElement } from './stripOps.ts'
import type { Strip as StripDoc } from '../persist/mapDocument.ts'

/**
 * The strip is rendered server-side and asserted on as markup — the house
 * convention (capture.test.tsx, semanticSurfaces.test.tsx, ScenePads.test.tsx).
 * There is no jsdom and no testing-library in this repo, deliberately: what
 * matters here is WHICH ELEMENTS EXIST, and static markup answers that exactly.
 *
 * The canvases render as empty <canvas> tags with no 2D context, which is fine
 * and is in fact the point — the meter and the wave are painted on rAF from
 * HotFrame refs and are not part of what React renders.
 */

const base = (over: Partial<StripDoc> = {}): StripDoc => ({
  ...newStrip(0, { x: 12, y: 34 }),
  ...over,
})

const withTape = (over: Partial<StripDoc> = {}) =>
  base({ element: newTapeElement(2, false), ...over })

const render = (strip: StripDoc, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(<Strip strip={strip} link={null} selected={false} {...props} />)

/** Every row the anatomy's pixel budget names. Presence of ALL of them, in
    EVERY state, is layout law L2 — the mechanical form of "open the strip in
    two states and diff the bounding box of every child". */
const ROWS = [
  'strip-kindbar',
  'strip-head',
  'strip-name',
  'strip-fb-slot',
  'strip-state',
  'strip-elapsed',
  'strip-waverow',
  'strip-wavefield',
  'strip-meter',
  'strip-transport',
  'strip-rec',
  'strip-verbs',
  'strip-switches',
  'strip-mon',
  'strip-status',
  'strip-params',
  'strip-sends',
]

/** One representative render per state the strip can be in. The engine-driven
    states (recording, looping) cannot be reached from props alone in a static
    render — they arrive over the HotFrame — so they are covered by
    stripOps.test.ts, which owns the logic that decides them. */
const STATES: Array<[string, string]> = [
  ['empty / unbound', render(base())],
  ['has material, idle', render(withTape())],
  ['muted', render(withTape({ mute: true }))],
  ['selected', render(withTape(), { selected: true })],
  ['audio missing', render(withTape({ element: { ...newTapeElement(2, false), takeRef: '/gone.wav' } }), { unresolvedRef: '/gone.wav' })],
  ['decoding', render(withTape(), { decoding: 0.4 })],
  ['feedback edge', render(withTape(), { feedbackMs: 10.7 })],
  ['reversed', render(withTape({ element: { ...newTapeElement(2, false), rate: -0.75 } }))],
  ['level at silence', render(withTape({ level: 0 }))],
  ['sends up', render(withTape({ sends: [0.5, 0, 1, 0.25] }))],
  ['wide box', render(withTape({ cell: { x: 0, y: 0, w: 720, h: 196 } }))],
  // NOTE: grid-strip states don't belong in this list — ROWS names the tape
  // face (`strip-wavefield`); a grid strip fills the same rect with the scene
  // field. The composing lock (P3-C2) has its own describe below.
]

describe('layout stability', () => {
  it.each(STATES)('L2 — every row is present in state: %s', (_name, html) => {
    // FILL, never PRESENCE. A control that is meaningless in a state is
    // disabled, not removed — because removing it changes the object's height,
    // which invalidates cell.h, which corrupts every saved arrangement.
    for (const row of ROWS) expect(html).toContain(row)
  })

  it.each(STATES)('L2 — all four transport verbs exist in state: %s', (_name, html) => {
    for (const glyph of ['⟳', '▸', '↻', '◼']) expect(html).toContain(glyph)
  })

  it.each(STATES)('L2 — all four sends exist in state: %s', (_name, html) => {
    for (let i = 1; i <= 4; i++) expect(html).toContain(`send ${i}`)
  })

  it('L1 — the box takes BOTH dimensions from the document', () => {
    // Wizard's D1 was setting width only, so five different states resized the
    // box and silently corrupted fit-to-content.
    const html = render(base({ cell: { x: 12, y: 34, w: 420, h: 196 } }))
    expect(html).toContain('width:420px')
    expect(html).toContain('height:196px')
    expect(html).toContain('left:12px')
    expect(html).toContain('top:34px')
  })

  it('L6 — selection changes ONE class and nothing else', () => {
    // A border would move every child by a pixel the moment you clicked, so
    // selecting a strip must be a zero-layout-cost outline. The strongest form
    // of that assertion: the markup is byte-identical apart from the class.
    // Note the SAME document is rendered twice — a second newStrip() would
    // differ by its generated key and mask the thing under test.
    const doc = withTape()
    const plain = render(doc)
    const chosen = render(doc, { selected: true })
    expect(chosen).toContain('selected')
    expect(chosen.replace(' selected', '')).toBe(plain)
  })

  it('L5 — the wave canvas is a pure function of the box width', () => {
    expect(waveWidth(340)).toBe(340 - 16 - 6 - 10) // pad·2 + gutter + meter
    expect(waveWidth(720)).toBe(720 - 16 - 6 - 10)
    // Never collapses, however narrow the box gets.
    expect(waveWidth(40)).toBe(80)
  })
})

describe('the object is a player from the first frame', () => {
  it('draws a full-size wave field with NO material (D4)', () => {
    // The deepest defect in the donor: the object was not a player until it had
    // a deck, so an input strip rendered as a different species.
    const html = render(base())
    expect(html).toContain('strip-wavefield')
    expect(html).toContain('press REC to give this strip material')
  })

  it('offers REC on a strip with no material (D5)', () => {
    // "Recording is the verb that gives a strip material" has to be true in the
    // implementation, not only in the prose.
    const html = render(base())
    expect(html).toContain('● REC')
    expect(html).not.toContain('<button type="button" class="strip-rec" disabled')
  })

  it('keeps REC enabled when the audio is MISSING — recording over it is the repair', () => {
    const html = render(withTape(), { unresolvedRef: '/gone.wav' })
    expect(html).toContain('audio missing')
    expect(html).not.toMatch(/class="strip-rec"[^>]*disabled/)
  })

  it('disables REC only while decoding', () => {
    expect(render(withTape(), { decoding: 0.3 })).toMatch(/class="strip-rec"[^>]*disabled/)
  })
})

describe('a grid strip has a transport (P3-1)', () => {
  const gridDoc = () =>
    base({ element: newGridElement(0, 'beach', 120) })

  it('renders the SAME transport row a tape strip has', () => {
    // One species, one vocabulary. A grid strip that were missing verbs would
    // be a different object wearing the same box.
    const html = render(gridDoc())
    for (const glyph of ['⟳', '▸', '↻', '◼']) expect(html).toContain(glyph)
    expect(html).toContain('strip-transport')
  })

  it('leaves ⟳ ↻ ◼ LIVE and ▸ inert', () => {
    // A scoopy deck used to ignore every verb on its own strip. One-shot stays
    // disabled because a sequenced pattern has no one-shot — rendered, not
    // faked (L2).
    const html = render(gridDoc())
    const buttons = html.match(/<button[^>]*>[⟳▸↻◼]<\/button>/g) ?? []
    expect(buttons).toHaveLength(4)
    const [loop, shot] = buttons
    expect(loop).not.toContain('disabled')
    expect(shot).toContain('disabled')
  })

  it('shows the DECK\'s state, not a tape\'s', () => {
    expect(render(gridDoc(), { gridPlaying: true })).toContain('play')
    expect(render(gridDoc(), { gridPlaying: false })).toContain('idle')
  })
})

describe('a grid strip carries its tempo MODE (P3-2)', () => {
  const gridDoc = (over: Record<string, unknown> = {}) =>
    base({ element: { ...newGridElement(0, 'beach', 120), ...over } })

  it('renders the mode beside SYNC', () => {
    // The per-element half of the tempo domain: the master sets the tempo, this
    // says what following it COSTS. On the object rather than the Inspector
    // because you flip it mid-set and hear the answer immediately.
    const html = render(gridDoc())
    expect(html).toContain('strip-tempomode')
    expect(html).toContain('STR') // timeStretch, the default
  })

  it('shows which mode is actually selected', () => {
    expect(render(gridDoc({ tempoMode: 'timePitch' }))).toContain('T+P')
    expect(render(gridDoc({ tempoMode: 'tempoOnly' }))).toContain('TMP')
  })

  it('lights the mode only while SYNCED', () => {
    // With the deck free-running there is no master to follow, so the choice
    // costs nothing and must not read as engaged.
    expect(render(gridDoc({ syncToMaster: false }))).toContain('class="strip-tempomode"')
    expect(render(gridDoc({ syncToMaster: true }))).toContain('class="strip-tempomode active"')
  })

  it('SYNC states what the deck will ACTUALLY run at', () => {
    // ⚠️ Not the ratio that was asked for. `auto` resolves a 70 BPM deck under
    // a 140 master to 1:2 — it stays at 70, half-timed under the master — and a
    // SYNC control that does not say so is one you have to test by ear.
    const html = render(
      base({
        element: { ...newGridElement(0, 'beach', 70), syncToMaster: true },
      }),
      { masterBpm: 140 },
    )
    expect(html).toContain('synced at 1:2')
    expect(html).toContain('70.0 BPM')
  })
})

describe('MON and M are two controls, not one (the split tap)', () => {
  it('renders BOTH switches, always', () => {
    // ⚠️ THE BUG THIS WHOLE INCREMENT IS FOR. A strip arrived with its device
    // input permanently patched and audible, and `M` — which mutes the CHANNEL
    // — was the only control that could stop the feedback, so silencing a
    // howling mic also silenced the tape. They are now separate: MON is the
    // strip's INPUT, M is its OUTPUT.
    const html = render(withTape())
    expect(html).toContain('MON')
    expect(html).toContain('>M<')
  })

  it('MON is OFF on a fresh strip — a strip that arrives listening feeds back', () => {
    // `live.monitor` starts false and the engine agrees (sl_channel monitor
    // defaults to 0), so the button must not render latched.
    const html = render(base())
    expect(html).not.toMatch(/class="ds-button active"[^>]*>MON</)
  })

  it('MUTING the strip does not touch the MON button', () => {
    // The two used to be the same decision. A muted strip must still show
    // whatever its monitor is doing, or the fix is invisible on the object.
    const muted = render(withTape({ mute: true }))
    const plain = render(withTape())
    const monOf = (html: string) => html.slice(html.indexOf('strip-mon'), html.indexOf('strip-mon') + 120)
    expect(monOf(muted)).toBe(monOf(plain))
  })

  it('says what each switch does, in words, in its tooltip', () => {
    // These are the two controls most likely to be confused, and the object is
    // where the answer belongs.
    const html = render(withTape())
    expect(html).toContain('still recorded')
    // The apostrophe is HTML-escaped in static markup, so match either side of it.
    expect(html).toMatch(/silences this strip.{0,8}s OUTPUT/)
  })
})

describe('hierarchy', () => {
  it('gives REC a text label; the verbs stay glyph-only (D8)', () => {
    // Seven identically-sized buttons is what makes an object read as a form.
    const html = render(withTape())
    expect(html).toContain('● REC')
    expect(html).toContain('strip-verbs')
  })

  it('carries kind on the bar, not on the name text (D9)', () => {
    // Small coloured text is the weakest carrier of a category AND it costs
    // contrast on the one string you read while scanning.
    const html = render(withTape())
    expect(html).toContain('strip-kindbar')
    expect(html).toContain('--sem-color')
  })
})

describe('readouts are fixed-width', () => {
  it('formats rate identically forwards and backwards', () => {
    // −0.75× and +1.00× must occupy the same box, or the row reflows at the
    // reverse crossing.
    expect(formatRate(1).length).toBe(formatRate(-0.75).length)
    expect(formatRate(-0.75)).toBe('◄ 0.75×')
    expect(formatRate(1)).toBe('► 1.00×')
  })

  it('shows −∞ at silence rather than a large negative dB', () => {
    // "−60.0" would suggest the fader still passes something.
    expect(formatGain(0)).toContain('−∞')
    expect(formatGain(1)).toBe('+0.0')
    expect(formatGain(0.5)).toBe('−6.0')
  })
})

describe('the status line', () => {
  it('is present even when it has nothing to say', () => {
    expect(render(base({ element: { kind: 'none' } }))).toContain('strip-status')
  })

  it('shows the missing path, and marks it hot', () => {
    const html = render(withTape(), { unresolvedRef: '/takes/gone.wav' })
    expect(html).toContain('/takes/gone.wav')
    expect(html).toContain('strip-status mono hot')
  })

  it('states the feedback cost on the object, not in a tooltip', () => {
    expect(render(withTape(), { feedbackMs: 10.7 })).toContain('+10.7 ms')
  })
})

describe('the composing lock (P3-C2)', () => {
  const gridStrip = () => base({ element: newGridElement(0, 'ses', 120) })

  it('locks the publish lanes with the reason named, and says COMP', () => {
    const html = render(gridStrip(), { composing: true })
    // The scene field greys as a unit, and the state word owns the why.
    expect(html).toContain('strip-scenefield locked')
    expect(html).toContain('editing in the compose window')
    // `>COMP<`, the word — 'COMP' alone would match COMPOSE ⇱ on every strip.
    expect(html).toMatch(/>COMP</)
    // The tempo row's controls read disabled — fill, not presence.
    expect(html).toMatch(/strip-sync[^>]*disabled|disabled[^>]*strip-sync/)
  })

  it('a strip that is NOT composing renders none of the lock', () => {
    const html = render(gridStrip())
    expect(html).not.toContain('strip-scenefield locked')
    expect(html).not.toMatch(/>COMP</)
  })

  it('the lock is a GRID concern — a tape strip ignores the flag', () => {
    const html = render(withTape(), { composing: true })
    expect(html).not.toContain('locked')
    expect(html).not.toMatch(/>COMP</)
  })
})

describe('record from another strip (P3-R2)', () => {
  it('a bus tap with named sources says WHO feeds it', () => {
    const html = render(withTape({ recordTap: 'bus' }), { busSources: ['LOOPER 2', 'STRIP 3'] })
    expect(html).toContain('LOOPER 2 + STRIP 3 → this bus')
  })

  it('a bus tap nobody feeds keeps the generic label — no invented sources', () => {
    const html = render(withTape({ recordTap: 'bus' }))
    expect(html).not.toContain('→ this bus')
  })

  it('named sources without the bus tap change nothing — the tap decides', () => {
    const html = render(withTape(), { busSources: ['STRIP 3'] })
    expect(html).not.toContain('→ this bus')
  })
})

describe('the deck tile (P3-D4-1, D-SL-MORPH-01)', () => {
  const gridAt = (cell: Partial<StripDoc['cell']> = {}) =>
    base({
      element: newGridElement(0, 'ses', 120),
      cell: { x: 0, y: 0, w: 340, h: 196, ...cell },
    })

  it('a collapsed grid strip offers the expand door and NO deck face', () => {
    const html = render(gridAt())
    expect(html).toContain('strip-expand')
    expect(html).toContain('⤢')
    expect(html).not.toContain('strip-deckface')
  })

  it('the deck-tile cell reveals the REAL GridPanel between pads and channel row', () => {
    const html = render(gridAt({ w: 692, h: 612 }))
    expect(html).toContain('strip-deckface')
    // The actual GridPanel mount — its root class, not a projection of ours.
    expect(html).toContain('grid-panel')
    // …and the way back.
    expect(html).toContain('⤡')
    // The compact chrome never left: expand is a reveal, not a mode. Every
    // anatomy row is still present around the face.
    for (const row of ROWS) {
      if (row === 'strip-wavefield') continue // the grid face fills that rect with pads
      expect(html).toContain(row)
    }
  })

  it('expansion IS the geometry — one big dimension alone is not a tile', () => {
    // The pre-existing 'wide box' state (w 720, default h) must NOT grow a
    // deck face: both dimensions carry the decision, so a hand-resized strip
    // cannot half-expand.
    expect(render(gridAt({ w: 720 }))).not.toContain('strip-deckface')
    expect(render(gridAt({ h: 640 }))).not.toContain('strip-deckface')
  })

  it('a tape strip never expands — a looper has no deck rows (one kind per strip)', () => {
    const html = render(withTape({ cell: { x: 0, y: 0, w: 692, h: 612 } }))
    expect(html).not.toContain('strip-expand')
    expect(html).not.toContain('strip-deckface')
  })
})

describe('the classic deck rows in the tile (P3-D4-2, rebuilt by B1)', () => {
  const tile = (over: Partial<StripDoc> = {}, props: Record<string, unknown> = {}) =>
    render(
      base({
        element: newGridElement(0, 'ses', 120),
        cell: { x: 0, y: 0, w: 692, h: 612 },
        ...over,
      }),
      props,
    )

  it('the expanded tile carries the deck rows — the donor block, every verb live', () => {
    const html = tile()
    // The verbs moved OUT of the header span (`strip-deckverbs`) and into three
    // rows of their own when the tile grew from seven controls to eighteen.
    expect(html).toContain('deckrow')
    expect(html).not.toContain('strip-deckverbs')
    // Row 1's transport, row 2's hand controls, row 3's view switches.
    for (const verb of ['OPEN', '■', '▶', '▸¹', '»', 'DBL', 'SAVE', '⏏']) expect(html).toContain(verb)
    for (const verb of ['TR', 'TP', 'WIN', 'BR', 'REV', '‹', '›']) expect(html).toContain(verb)
    for (const verb of ['GRID', 'PERF']) expect(html).toContain(verb)
    // …and the LCM bar still sits in the tile.
    expect(html).toContain('strip-lcm')
  })

  it('the collapsed strip carries NONE of it — the master bar already fans BR/REV', () => {
    const html = render(base({ element: newGridElement(0, 'ses', 120) }))
    expect(html).not.toContain('deckrow')
    expect(html).not.toContain('strip-deckverbs')
    expect(html).not.toContain('strip-lcm')
  })

  it('nudge on a FREE deck is disabled and TEACHES — the law bends the synced target', () => {
    const html = tile() // newGridElement defaults syncToMaster: false
    expect(html).toContain('nudge bends the SYNCED tempo — turn SYNC on first')
  })

  it('nudge on a SYNCED deck is armed with the hold-to-bend title', () => {
    const el = { ...newGridElement(0, 'ses', 120), syncToMaster: true }
    const html = tile({ element: el })
    expect(html).toContain('snaps back on release')
  })

  it('the composing lock disables the verbs — one publisher at a time', () => {
    const html = tile({}, { composing: true })
    // Every deck-row button except SAVE renders disabled under the lock. The
    // count is a floor rather than an equality on purpose: the rows grow, and a
    // pin that has to be re-counted every time one does would be re-fitted to
    // whatever shipped instead of asserting the property.
    const disabledCount = (html.match(/class="dr mono[^"]*" disabled=""/g) ?? []).length
    expect(disabledCount).toBeGreaterThanOrEqual(10)
    // …and it SAYS why, wherever it is met.
    expect(html).toContain('editing in the compose window')
  })

  it('SAVE stays live under the lock — flushing publishes nothing', () => {
    // The one deliberate exception: a pending write is exactly what you want
    // flushed while another window is editing, and SAVE cannot race a publisher
    // because it does not publish.
    const html = tile({}, { composing: true })
    const saveButton = html.match(/<button[^>]*>SAVE<\/button>/)?.[0] ?? ''
    expect(saveButton).not.toContain('disabled')
  })
})

/**
 * P9-5a — the hint in the input picker.
 *
 * ⚠️ WHAT THESE PINS CANNOT SEE. The menu is built inside `openSourceMenu`'s
 * event handler and rendered by `useContextMenu`'s portal, so no static render
 * can reach it — there is no jsdom here. These assert the pure section builder
 * only. That the ⋯ menu on a real strip actually shows the section is a
 * REAL-HOST claim and rides P9-G1's walk, not this file.
 */
describe('P9-5a · the input device section', () => {
  const labels = (items: MenuItem[]) => items.map((i) => (i.kind === 'sep' ? '—' : i.label))
  const HINT = 'another app’s audio → a virtual device (BlackHole/Loopback)'

  it('names the virtual-device path with ONE device — the case the old gate hid', () => {
    // The whole defect: `devices.length > 1` meant the person who has installed
    // nothing, and therefore has exactly one device, saw no section at all.
    const items = inputDeviceMenuItems(['Built-in Microphone'], 'Built-in Microphone', () => {})
    expect(labels(items)).toContain('input device')
    expect(labels(items)).toContain(HINT)
  })

  it('names it with NO devices too — an empty list is not a reason to say nothing', () => {
    expect(labels(inputDeviceMenuItems([], '', () => {}))).toContain(HINT)
  })

  it('carries the hint ABOVE the list when there is more than one', () => {
    const items = inputDeviceMenuItems(['Built-in', 'BlackHole 2ch'], 'Built-in', () => {})
    const l = labels(items)
    expect(l.indexOf(HINT)).toBeLessThan(l.indexOf('BlackHole 2ch'))
    expect(l).toEqual(['—', 'input device', HINT, 'Built-in', 'BlackHole 2ch'])
  })

  it('offers no pickable row unless there is a choice to make', () => {
    const pickable = (d: string[]) =>
      inputDeviceMenuItems(d, d[0] ?? '', () => {}).filter((i) => i.kind === 'item')
    expect(pickable([])).toHaveLength(0)
    expect(pickable(['Built-in'])).toHaveLength(0)
    expect(pickable(['Built-in', 'BlackHole 2ch'])).toHaveLength(2)
  })

  it('the one-device line names the relaunch caveat — the OTHER reason the list is short', () => {
    // `refreshDevices` runs once at boot and `slDevices` has no rescan, so a
    // driver installed while the app is open cannot appear (spec §2c).
    const l = labels(inputDeviceMenuItems(['Built-in'], 'Built-in', () => {}))
    expect(l.some((s) => s.includes('relaunch'))).toBe(true)
  })

  it('ticks the current device and picks by name', () => {
    const picked: string[] = []
    const items = inputDeviceMenuItems(['Built-in', 'BlackHole 2ch'], 'BlackHole 2ch', (d) =>
      picked.push(d),
    )
    const rows = items.flatMap((i) => (i.kind === 'item' ? [i] : []))
    expect(rows.map((r) => r.checked)).toEqual([false, true])
    for (const r of rows) r.onSelect()
    expect(picked).toEqual(['Built-in', 'BlackHole 2ch'])
  })
})
