import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Strip, formatGain, formatRate, waveWidth } from './Strip.tsx'
import { newStrip, newTapeElement } from './stripOps.ts'
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
    base({ element: { kind: 'grid', deck: 0, sessionId: 'beach', bpm: 120, syncToMaster: false } })

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
