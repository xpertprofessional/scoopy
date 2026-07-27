import { describe, expect, it } from 'vitest'
import { emptyMap, type PlaneMap, type Route, type Strip } from '../persist/mapDocument.ts'
import { newGridElement, newStrip, newTapeElement } from './stripOps.ts'
import { summarise, summaryLines } from './summary.ts'

const strip = (key: string, channel: number, over: Partial<Strip> = {}): Strip => ({
  ...newStrip(channel, { x: 0, y: 0 }),
  key,
  ...over,
})

const mapWith = (strips: Strip[], routes: Route[] = []): PlaneMap => ({
  ...emptyMap(),
  strips,
  routes,
})

const toMain = (i: number): Route => ({
  src: { kind: 'channelOut', index: i, sub: null },
  dst: { kind: 'main', index: 0 },
  gain: 1,
  feedback: false,
})

describe('the plane summary — the Inspector with nothing selected', () => {
  it('is never empty, even for an empty plane', () => {
    // 260 px of dead space teaches that the Inspector is usually useless.
    const lines = summaryLines(summarise(emptyMap()))
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => l.value.length > 0)).toBe(true)
  })

  it('separates strips from strips WITH MATERIAL', () => {
    // Eight empty strips and eight loaded ones are the same number and a
    // completely different session.
    const s = summarise(
      mapWith([
        strip('a', 0),
        strip('b', 1, { element: { ...newTapeElement(0, false), takeRef: '/t.wav' } }),
        strip('c', 2, {
          element: newGridElement(0, 'x', 120),
        }),
      ]),
    )
    expect(s.strips).toBe(3)
    expect(s.withMaterial).toBe(2)
    expect(s.tapes).toBe(1)
    expect(s.grids).toBe(1)
  })

  it('counts LANES against the budget, and warns at the ceiling', () => {
    // Finding out you are full from a refused click is worse than seeing it
    // coming. Four stereo tapes = 8 lanes = the whole budget.
    const stereo = { ...newTapeElement(0, true) }
    const s = summarise(
      mapWith([0, 1, 2, 3].map((i) => strip(`s${i}`, i, { element: { ...stereo, index: i } }))),
    )
    expect(s.lanes).toBe(8)
    expect(summaryLines(s).find((l) => l.label === 'lanes')?.warn).toBe(true)
  })

  it('counts only cables you MADE, not the 40 boot routes', () => {
    // "41 cables" on a fresh plane would make the number useless for the
    // question it answers.
    const s = summarise(mapWith([strip('a', 0), strip('b', 1)], [toMain(0), toMain(1)]))
    expect(s.cables).toBe(0)
    expect(summaryLines(s).find((l) => l.label === 'cables')?.value).toContain('none')
  })

  it('names feedback cables separately — they cost a block', () => {
    const s = summarise(
      mapWith(
        [strip('a', 0), strip('b', 1)],
        [
          {
            src: { kind: 'channelOut', index: 0, sub: null },
            dst: { kind: 'channelIn', index: 1 },
            gain: 1,
            feedback: false,
          },
          {
            src: { kind: 'channelOut', index: 1, sub: null },
            dst: { kind: 'channelIn', index: 0 },
            gain: 1,
            feedback: true,
          },
        ],
      ),
    )
    expect(s.cables).toBe(2)
    expect(s.feedbackCables).toBe(1)
    expect(summaryLines(s).find((l) => l.label === 'cables')?.value).toContain('feedback')
  })

  it('WARNS about strips that go nowhere — the most valuable thing it can say', () => {
    // Silent for a routing reason, with nothing on the object explaining it,
    // is the hardest fault on the plane to guess at.
    const s = summarise(mapWith([strip('a', 0), strip('b', 1)], [toMain(0)]))
    expect(s.silent).toBe(1)
    const line = summaryLines(s).find((l) => l.label === 'silent')
    expect(line?.warn).toBe(true)
    expect(line?.value).toContain('1 strip')
  })

  it('says nothing about silence when everything is routed', () => {
    const s = summarise(mapWith([strip('a', 0)], [toMain(0)]))
    expect(summaryLines(s).find((l) => l.label === 'silent')).toBeUndefined()
  })

  it('counts takes the library cannot find', () => {
    // An unresolved ref is PRESERVED rather than dropped, so the plane can
    // carry it silently — which is exactly why the count belongs here.
    const map = mapWith([
      strip('a', 0, { element: { ...newTapeElement(0, false), takeRef: '/gone.wav' } }),
      strip('b', 1, { element: { ...newTapeElement(1, false), takeRef: '/here.wav' } }),
    ])
    const s = summarise(map, new Set(['/gone.wav']))
    expect(s.takeRefs).toBe(2)
    expect(s.unresolvedRefs).toBe(1)
    expect(s.withMaterial).toBe(1) // the missing one does not count as material
    expect(summaryLines(s).find((l) => l.label === 'missing')?.warn).toBe(true)
  })
})
