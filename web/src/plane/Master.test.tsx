// P3-U5 — the master bar tells the truth.
//
// House pattern (Strip.test.tsx): rendered server-side, asserted as markup.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Master } from './Master.tsx'

const render = (deckCount: number) =>
  renderToStaticMarkup(
    <Master
      link={null}
      level={1}
      masterBpm={120}
      synced={[]}
      onLevel={() => {}}
      onBpm={() => {}}
      onPlay={() => {}}
      onStop={() => {}}
      onRestart={() => {}}
      deckCount={deckCount}
    />,
  )

describe('master transport enablement (P3-U5)', () => {
  it('disables every deck verb with zero decks — no silent no-ops', () => {
    // They used to be always enabled and iterate an empty array: buttons that
    // "worked" and did nothing, which reads as a broken app. Six now: the
    // transport trio + BR/length/REV (P3-M-1b).
    const html = render(0)
    expect(html.match(/disabled/g)?.length).toBe(6)
    // …and the title says what would make them live.
    expect(html).toContain('load a session into a strip')
  })

  it('renders the folded verbs — BR, the fused-scale label, REV (P3-M-1b)', () => {
    const html = render(1)
    expect(html).toContain('>BR<')
    expect(html).toContain('>REV<')
    expect(html).toContain('beat-repeat length')
  })

  it('enables them the moment a deck exists', () => {
    const html = render(1)
    expect(html).not.toContain('disabled')
    expect(html).toContain('play every deck')
  })

  it('bpm steppers say what they are — document steps, not a transient nudge', () => {
    // The transient pitch-fader nudge (nudgeBpmDelta) is a D-4 design call;
    // until it lands the −/+ titles must not promise it.
    const html = render(1)
    expect(html).toContain('−1 BPM')
    expect(html).toContain('+1 BPM')
  })
})

/**
 * P11-1 / P11-5b — THE MASTER SECTION IS TWO ZONES, AND THE READOUT IS IN THE
 * RIGHT ONE.
 *
 * P11-5 put `HealthReadout` inside the undivided master cluster because these
 * zones did not exist yet, and P11-5b required that the split land it beside
 * LIM rather than wherever the cut happened to leave it — the two are read in
 * one glance and separating them costs the readout its context.
 *
 * Asserted against the RENDERED markup, not the source: "beside LIM" is a fact
 * about what ends up on screen, and a source grep would be satisfied by the two
 * merely being in the same file, which they were before and after.
 */
describe('P11-1 · the master splits into centre and output zones', () => {
  const zones = (html: string) => {
    const centre = html.indexOf('plane-master')
    const output = html.indexOf('plane-output')
    return { centre, output, centreHtml: html.slice(centre, output), outputHtml: html.slice(output) }
  }

  it('renders both zones, centre before output', () => {
    const { centre, output } = zones(render(1))
    expect(centre).toBeGreaterThanOrEqual(0)
    expect(output).toBeGreaterThan(centre)
  })

  it('P11-5b: the health readout rides the OUTPUT zone, beside LIM', () => {
    const { outputHtml } = zones(render(1))
    expect(outputHtml).toContain('master-lamp')
    expect(outputHtml).toContain('health-readout')
    // …and nothing between them but the lamp's own text: adjacent, not merely
    // both-present-somewhere-to-the-right.
    const lamp = outputHtml.indexOf('master-lamp')
    const dsp = outputHtml.indexOf('health-readout')
    expect(dsp).toBeGreaterThan(lamp)
    expect(outputHtml.slice(lamp, dsp)).not.toContain('master-transport')
  })

  it('the CENTRE zone carries the performance cluster and none of the output read', () => {
    // The zone a hand goes to during a set: transport, BR/REV, tempo. If the
    // meter or the readout drifted back in here, the centre stops being the
    // contiguous group D-SL-TOPROW-01 is about.
    const { centreHtml } = zones(render(1))
    expect(centreHtml).toContain('master-transport')
    expect(centreHtml).toContain('plane-bpm')
    expect(centreHtml).not.toContain('health-readout')
    expect(centreHtml).not.toContain('master-meter')
    expect(centreHtml).not.toContain('master-lamp')
  })

  it('the output zone is captioned for the zone it is, not the one beside it', () => {
    // `master` captioned the whole cluster when there was one cluster; with the
    // master transport and tempo now a zone of their own, the same word on the
    // right named the wrong group.
    const { outputHtml, centreHtml } = zones(render(1))
    expect(outputHtml).toContain('>out<')
    expect(centreHtml).not.toContain('>out<')
    // The fader still says what it controls — only the caption moved.
    expect(outputHtml).toContain('master output')
  })
})
