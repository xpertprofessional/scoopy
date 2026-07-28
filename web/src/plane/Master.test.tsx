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
  it('disables all three verbs with zero decks — no silent no-ops', () => {
    // They used to be always enabled and iterate an empty array: three
    // buttons that "worked" and did nothing, which reads as a broken app.
    const html = render(0)
    expect(html.match(/disabled/g)?.length).toBe(3)
    // …and the title says what would make them live.
    expect(html).toContain('load a session into a strip')
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
