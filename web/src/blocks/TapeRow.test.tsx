// TapeRow — the looper as a BLOCK (D-SL-STUDIO-01 L1).
//
// House pattern (Strip.test.tsx, Inspector.test.tsx): rendered server-side,
// asserted as markup. What this file pins is the CARVE and the one behaviour
// that is genuinely new with it:
//
//   · the block draws the looper's controls, wherever it is mounted;
//   · a host with no tape gets an INERT row THAT SAYS WHY — the browser
//     companion loads this same bundle and its WASM engine has no tape at all,
//     so the alternative was eight slot pads that refuse every command;
//   · both faces MOUNT it rather than containing it, which is the whole point
//     and is otherwise only enforced by `faces:check` R5 reading for a marker.
//
// The engine wire itself is not re-pinned here — `slTape`'s shapes ride the
// schema and the shell's dispatch tests, and duplicating them would be a second
// authority for the same thing.
import { describe, expect, it, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { TapeRow } from './TapeRow.tsx'
import { PluginTapePanel } from '../plane/PluginTapePanel.tsx'
import { StudioPanel } from '../studio/StudioPanel.tsx'
import { getCaps, useCapabilitiesStore } from '../state/capabilitiesStore.ts'

const withTape = (tape: boolean) =>
  useCapabilitiesStore.setState({ caps: { ...getCaps(), tape } })

afterEach(() => withTape(true))

describe('TapeRow — the block', () => {
  it('draws the looper: the four transport glyphs, REC, LEVEL, RATE and eight slots', () => {
    withTape(true)
    const html = renderToStaticMarkup(<TapeRow link={null} />)
    // DESIGN.md §3 fixes these four and only these four. Asserting the glyphs
    // rather than the titles is deliberate: a second dialect (■/▶) is exactly
    // the drift worth catching, and it would keep every title intact.
    for (const glyph of ['⟳', '▸', '↻', '◼']) expect(html).toContain(glyph)
    expect(html).toContain('REC')
    expect(html).toContain('LEVEL')
    expect(html).toContain('RATE')
    // The bank is eight because the ENGINE's is eight (kMaxTapes).
    for (const n of ['1', '2', '3', '4', '5', '6', '7', '8'])
      expect(html).toContain(`>${n}<`)
  })

  it('no tape on this host: inert, and it SAYS WHY', () => {
    withTape(false)
    const html = renderToStaticMarkup(<TapeRow link={null} />)
    expect(html).toContain('tape-row-inert')
    // DESIGN.md §7 — a disabled control must say why, and "the browser engine
    // has no recorder or looper" is a fact about the host, not an apology.
    expect(html).toMatch(/not on this host/)
    // AND NOTHING THAT REACHES NOWHERE. The failure this guards is the tempting
    // one: draw the row greyed out, so it looks like it might work later.
    expect(html).not.toContain('REC')
    expect(html).not.toContain('LEVEL')
    for (const glyph of ['⟳', '▸', '↻', '◼']) expect(html).not.toContain(glyph)
  })
})

describe('the faces MOUNT it — they do not contain it', () => {
  it('ScoopyTape: the face is the box, the block is the contents', () => {
    withTape(true)
    const html = renderToStaticMarkup(<PluginTapePanel link={null} />)
    // The face's own contribution is the window-root height; everything a
    // person sees comes from the block.
    expect(html).toContain('plugin-tape-pane')
    expect(html).toContain('tape-row')
    expect(html).toContain('REC')
  })

  it('Studio: collapsed by default, and the toggle is the door', () => {
    withTape(true)
    const html = renderToStaticMarkup(<StudioPanel link={null} />)
    expect(html).toContain('studio-tape-dock')
    expect(html).toContain('studio-tape-toggle')
    // OPTIONAL BY DECISION (D-SL-STUDIO-01: "an optional Scoopy Tape bottom
    // row"), so it starts shut — and the fourth of the four rules means shut
    // must still be REACHABLE, which is what the toggle is.
    expect(html).not.toContain('class="tape-row"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('tape')
  })
})
