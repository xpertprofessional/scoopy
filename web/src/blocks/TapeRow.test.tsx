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
import { TapeWave } from '../plane/TapeWave.tsx'
import { StudioPanel } from '../studio/StudioPanel.tsx'
import { getCaps, useCapabilitiesStore } from '../state/capabilitiesStore.ts'
import { SCRATCH_TECHNIQUES } from './scratchTechniques.ts'

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

describe('the SCRATCH row', () => {
  it('draws the technique choice, the division and DEPTH', () => {
    withTape(true)
    const html = renderToStaticMarkup(<TapeRow link={null} bpm={120} />)
    expect(html).toContain('SCRATCH')
    expect(html).toContain('DEPTH')
    // Every technique the one authority declares is offered — no hand-picked
    // subset, which would silently make some of the generated table dead.
    for (const t of SCRATCH_TECHNIQUES) expect(html).toContain(t.label)
    // Period is a musical division, and the default is 1/8 — the division the
    // measurements put record strokes at.
    expect(html).toContain('1/8')
  })

  it('THE TECHNIQUE IS THE PRESET: what it fixes is not drawn at all', () => {
    withTape(true)
    const html = renderToStaticMarkup(<TapeRow link={null} bpm={120} />)
    // DESIGN.md rule 7 — never a control that reaches nothing, and never one
    // drawn disabled where "absent" is the honest shape. Click width, click
    // positions, fader rest and stroke shape are all fixed by the choice, so
    // none of them gets a control.
    for (const absent of ['clickWidth', 'CLICKS', 'REST', 'SHAPE'])
      expect(html).not.toContain(absent)
  })

  it('depth 0 reads as FADER, because it is a setting rather than a floor', () => {
    withTape(true)
    // The display is what makes fader-only discoverable by turning the control
    // instead of by reading a spec, so it is worth pinning.
    const html = renderToStaticMarkup(<TapeRow link={null} bpm={120} />)
    expect(html).toMatch(/FADER ONLY/i) // the title says so at any depth
  })

  it('SCRATCH is a LATCH, and says what arming will do', () => {
    withTape(true)
    const html = renderToStaticMarkup(<TapeRow link={null} bpm={120} />)
    // Not "SCRATCH" alone — DESIGN.md, a control explains itself, and a latch
    // whose off state is silent about what it turns on is a puzzle.
    expect(html).toMatch(/arm the scratch/)
    expect(html).not.toMatch(/SCRATCH ARMED/)
  })

  // ⚠️ The waveform itself is NOT in this face's server-rendered markup: its
  // box is measured by a ResizeObserver, which does not run here, so `TapeRow`
  // renders the field empty. The gesture therefore has to be pinned on
  // `TapeWave` directly — asserting it through the block would silently assert
  // nothing, which is worse than not asserting it.
  it('the waveform means ONE thing at a time: scrub, or scratch when armed', () => {
    const scrubOnly = renderToStaticMarkup(
      <TapeWave link={null} tape={0} width={200} revision={0} canScrub
        onScrub={{ begin: () => {}, to: () => {}, end: () => {} }} />,
    )
    expect(scrubOnly).toMatch(/drag to scrub/)
    expect(scrubOnly).not.toMatch(/SCRATCH ARMED/)

    const armed = renderToStaticMarkup(
      <TapeWave link={null} tape={0} width={200} revision={0} canScrub
        onScrub={{ begin: () => {}, to: () => {}, end: () => {} }}
        onScratch={{ begin: () => {}, to: () => {}, fader: () => {}, end: () => {} }} />,
    )
    expect(armed).toMatch(/SCRATCH ARMED/)
    // The whole gesture is named, including the axis a person would never guess.
    expect(armed).toMatch(/drag down to cut the fader/)
    expect(armed).not.toMatch(/drag to scrub/)
  })

  it('VARY defaults to a real amount, not to strict', () => {
    withTape(true)
    const html = renderToStaticMarkup(<TapeRow link={null} bpm={120} />)
    expect(html).toContain('VARY')
    // ⚠️ NOT 0. One identical stroke repeated is not what anyone plays — the
    // sources say improvising is not "a series of perfectly performed basic
    // techniques" — so shipping the stale version as the default would make the
    // feature's first impression its worst one.
    expect(html).not.toContain('>strict<')
    // And 0 is a real setting with a name, not an absence.
    expect(html).toMatch(/0 is strict: every stroke identical/)
  })

  it('release policy is a visible switch, defaulting to PLAY OUT', () => {
    withTape(true)
    const html = renderToStaticMarkup(<TapeRow link={null} bpm={120} />)
    // The default is the turntable behaviour: let go and the record keeps
    // turning. The switch exists because a looper that always runs on after a
    // scratch is not always what you want.
    expect(html).toContain('PLAY OUT')
    expect(html).toMatch(/play on from where you left it/)
  })

  it('no tape: the scratch row goes with it', () => {
    withTape(false)
    const html = renderToStaticMarkup(<TapeRow link={null} bpm={120} />)
    expect(html).not.toContain('SCRATCH')
    expect(html).not.toContain('DEPTH')
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
