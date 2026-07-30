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

/**
 * ⚠️ SCOPED TO THE TRANSPORT GROUP, REPOINTED BY P11-2 — not loosened.
 *
 * These two counted `disabled` across the WHOLE render as a proxy for "the six
 * deck verbs". P11-2 put INT and EXT on this bar, both disabled BY DESIGN and
 * neither a deck verb, so the proxy started answering a different question: the
 * count went 6 → 8 and "nothing is disabled with a deck loaded" became false
 * for a reason that is correct.
 *
 * The RULE they exist for is unchanged and still exactly asserted — the deck
 * verbs, and only those, follow `deckCount`. Widening them to "some things are
 * disabled" would have kept them green and stopped them meaning anything.
 */
const transportOf = (html: string) => {
  // Bounded by CLASS NAMES, which are stable, rather than by markup shape: a
  // boundary like `</span><label` silently returns nonsense the day the JSX is
  // reformatted, and a slice that quietly becomes empty makes both assertions
  // below pass while proving nothing.
  const from = html.indexOf('master-transport')
  const to = html.indexOf('plane-bpm')
  expect(from, 'the transport group must be findable').toBeGreaterThan(-1)
  expect(to, 'the tempo box follows the transport').toBeGreaterThan(from)
  return html.slice(from, to)
}

describe('master transport enablement (P3-U5)', () => {
  it('disables every deck verb with zero decks — no silent no-ops', () => {
    // They used to be always enabled and iterate an empty array: buttons that
    // "worked" and did nothing, which reads as a broken app. Six: the
    // transport trio + BR/length/REV (P3-M-1b).
    const html = render(0)
    expect(transportOf(html).match(/disabled/g)?.length).toBe(6)
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
    expect(transportOf(html)).not.toContain('disabled')
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

/**
 * P11-2 — the CLOCK cluster is actually ON the bar, and EXT is honestly dead.
 *
 * The maths is pinned in `masterClock.test.ts`; these are the DOOR. Rendered
 * markup, because "there is a control on the master bar" is a claim about the
 * screen, and the whole project's recurring failure is logic that works behind
 * a door nobody can reach.
 */
describe('P11-2 · the master clock has a door in the centre zone', () => {
  const centre = (html: string) =>
    html.slice(html.indexOf('plane-master'), html.indexOf('plane-output'))

  it('renders the cluster in the CENTRE zone, not the output one', () => {
    // It is a performance control: where the tempo comes from is something you
    // change during a set, so it belongs with the transport rather than with
    // the meters.
    const html = render(1)
    expect(centre(html)).toContain('master-clock')
    expect(html.slice(html.indexOf('plane-output'))).not.toContain('master-clock')
  })

  it('says CLOCK, never SYNC — the master owns no sync control', () => {
    // The row's headline. SYNC is deck scope and stays on the strip row; a
    // master SYNC would be a second source of truth about the decks, which is
    // the lie P11-0 had to unpick.
    const html = centre(render(1))
    expect(html).toContain('master clock source')
    expect(html).not.toContain('>SYNC<')
  })

  it('offers INT and EXT and a TAP', () => {
    const html = centre(render(1))
    expect(html).toContain('>INT<')
    expect(html).toContain('>EXT<')
    expect(html).toContain('>TAP<')
  })

  it('EXT is DISABLED and carries its reason on the control', () => {
    // Not hidden: a missing EXT teaches that the app cannot do it, a disabled
    // one that explains itself teaches that it is not built yet.
    const html = centre(render(1))
    const ext = html.slice(html.indexOf('EXT') - 400, html.indexOf('EXT'))
    expect(ext).toContain('disabled')
    expect(ext).toMatch(/title="[^"]*external clock[^"]*"/)
  })

  it('EXT is disabled even under FULL capabilities — the SSR path', () => {
    // This render never runs an effect, so `useCapabilities` returns the FULL
    // default with `midiHardware: true`. A control gated on that flag alone
    // would render LIVE right here. That is the exact case the gate is built
    // to survive, so it is asserted on the path that exposes it.
    expect(centre(render(1))).toContain('EXT')
    expect(centre(render(0))).toContain('disabled')
  })

  it('TAP is LIVE — the one control here that is not a readout', () => {
    // Every other member of this cluster is disabled by design, so an all-dead
    // cluster would look correct while being useless. TAP must not be dimmed.
    const html = centre(render(1))
    const tap = html.slice(html.lastIndexOf('clock-tap'), html.indexOf('>TAP<'))
    expect(tap).not.toContain('disabled')
  })

  it('the clock cluster survives a plane with no decks', () => {
    // The transport disables itself with zero decks (P3-U5); the master tempo
    // and its source do not depend on a deck existing.
    expect(centre(render(0))).toContain('master-clock')
  })
})
