// P3-X2 — the Inspector's DRV section: one surface, two backings.
//
// House pattern (Strip.test.tsx): rendered server-side, asserted as markup.
// The two write lanes are pinned where they live — liveSetDrive's wire shape
// rides mapStore/mapApply tests, the grid document verb rides
// companionDecks.test.ts (setMasterDriveCurve). What THIS file pins is the
// door: the section exists on a strip, and a grid strip without its session
// says so instead of rendering knobs that write nowhere.
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Inspector } from './Inspector.tsx'
import { emptyMap, type PlaneMap, type Strip } from '../persist/mapDocument.ts'

const strip = (over: Partial<Strip>): Strip => ({
  key: 'a',
  name: 'A',
  cell: { x: 0, y: 0, w: 340, h: 196 },
  channel: 0,
  element: { kind: 'none' },
  level: 1,
  mute: false,
  sends: [0, 0, 0, 0],
  drive: { curve: 0, amount: 1 },
  recordArm: false,
  monitor: false,
  recordTap: null,
  sessionPerf: {},
  ...over,
})

const render = (s: Strip) => {
  const map: PlaneMap = { ...emptyMap(), strips: [s] }
  return renderToStaticMarkup(
    <Inspector link={null} map={map} selectedKey={s.key} onRemove={() => {}} />,
  )
}

describe('the DRV section (P3-X2)', () => {
  it('exists on a tape strip — curve select and amount, the visible door', () => {
    const html = render(
      strip({
        element: {
          kind: 'tape',
          index: 0,
          takeRef: null,
          stereo: false,
          loop: { enabled: true, start: 0, end: 0 },
          rate: 1,
          bpm: null,
          syncToMaster: false,
          tempoMode: 'timePitch',
          pulseRelation: 'auto',
          launchRef: 'auto',
        },
        drive: { curve: 1, amount: 8 },
      }),
    )
    expect(html).toContain('drive')
    expect(html).toContain('tanh — tube saturation')
    expect(html).toContain('fold — sine folder')
    // The stored amount reaches the input.
    expect(html).toContain('value="8"')
  })

  it('exists on an EMPTY strip too — the stage shapes routed input, so a strip with no element still owns its DRV', () => {
    const html = render(strip({}))
    expect(html).toContain('drive')
    expect(html).toContain('curve')
  })

  it('says so on a grid strip whose session is not loaded, rather than rendering knobs that write nowhere', () => {
    const html = render(
      strip({
        element: {
          kind: 'grid',
          sessionId: 'sess',
          deck: 0,
          bpm: 120,
          syncToMaster: false,
          tempoMode: 'timeStretch',
          pulseRelation: '1:1',
          transpose: 0, pitchMode: false, launchRef: 'auto',
        },
      }),
    )
    // The DRV of a grid strip is its SESSION document's clipper block; with no
    // session open on that deck there is no document to edit, and the section
    // must say so (the honesty rule) instead of writing into the void.
    expect(html).toContain('session not loaded')
  })
})
