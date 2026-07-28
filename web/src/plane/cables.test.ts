import { describe, expect, it } from 'vitest'
import { emptyMap, type PlaneMap, type Route, type Strip } from '../persist/mapDocument.ts'
import { cablePath, cablesOf, chipsOf, feedbackInto, hasOutput, inPoint, outPoint } from './cables.ts'
import { newStrip } from './stripOps.ts'

const strip = (key: string, channel: number): Strip => ({
  ...newStrip(channel, { x: channel * 400, y: 0 }),
  key,
})

const route = (over: Partial<Route> & Pick<Route, 'src' | 'dst'>): Route => ({
  gain: 1,
  feedback: false,
  ...over,
})

const mapWith = (strips: Strip[], routes: Route[]): PlaneMap => ({
  ...emptyMap(),
  strips,
  routes,
})

const chanOut = (i: number) => ({ kind: 'channelOut' as const, index: i, sub: null })
const chanIn = (i: number) => ({ kind: 'channelIn' as const, index: i })
const main = { kind: 'main' as const, index: 0 }

describe('which routes become cables', () => {
  it('draws NOTHING for the boot defaults', () => {
    // A fresh engine installs 40 of them (every channel → main, every send →
    // its FX bus). None is a graph edge, so a fresh plane has zero cables and
    // every cable you see is one you made. Excluded by CONSTRUCTION — nothing
    // has to know which routes were defaults, which is a distinction the
    // document deliberately does not carry.
    const defaults: Route[] = [
      route({ src: chanOut(0), dst: main }),
      route({ src: chanOut(1), dst: main }),
      route({ src: { kind: 'channelSend', index: 0, sub: 2 }, dst: { kind: 'sendBus', index: 2 } }),
    ]
    const map = mapWith([strip('a', 0), strip('b', 1)], defaults)
    expect(cablesOf(map)).toEqual([])
  })

  it('draws a cable for strip → strip', () => {
    const map = mapWith(
      [strip('a', 0), strip('b', 1)],
      [route({ src: chanOut(0), dst: chanIn(1) })],
    )
    const cables = cablesOf(map)
    expect(cables).toHaveLength(1)
    expect(cables[0]).toMatchObject({ fromKey: 'a', toKey: 'b', send: null })
  })

  it('distinguishes a SEND tap from an output tap', () => {
    // "send 3 drives that strip" is a different statement from "this strip
    // feeds that strip", and decision 5 makes it a real case: the channel owns
    // the send's level, the document owns where it goes.
    const map = mapWith(
      [strip('a', 0), strip('b', 1)],
      [route({ src: { kind: 'channelSend', index: 0, sub: 3 }, dst: chanIn(1) })],
    )
    expect(cablesOf(map)[0]).toMatchObject({ send: 3, fromKey: 'a', toKey: 'b' })
  })

  it('carries the feedback flag, which is a whole block of latency', () => {
    const map = mapWith(
      [strip('a', 0), strip('b', 1)],
      [route({ src: chanOut(1), dst: chanIn(0), feedback: true })],
    )
    expect(cablesOf(map)[0]?.feedback).toBe(true)
  })

  it('does not invent an endpoint for a channel no strip occupies', () => {
    // A cable to a channel with no strip is not drawable, and it is also not a
    // lie the view should paper over with a guessed position.
    const map = mapWith([strip('a', 0)], [route({ src: chanOut(0), dst: chanIn(5) })])
    expect(cablesOf(map)).toEqual([])
  })
})

describe('the chips — what a strip states about itself', () => {
  it('reports → main even though it is the default', () => {
    // A strip NOT on main is the interesting case, and you can only see that if
    // the normal case is visible too.
    const s = strip('a', 0)
    const map = mapWith([s], [route({ src: chanOut(0), dst: main })])
    expect(chipsOf(map, s).toMain).toBe(true)
  })

  it('says a strip has NO output — silent for a routing reason', () => {
    const s = strip('a', 0)
    expect(chipsOf(mapWith([s], []), s).toMain).toBe(false)
  })

  it('flags a send DIVERTED off its matching FX bus', () => {
    // A send fader that appears to do nothing is otherwise a mystery: the level
    // is moving, the effect is silent, and the reason is that send 1 goes to
    // FX 3. Naming it is the difference between a bug report and a glance.
    const s = strip('a', 0)
    const map = mapWith(
      [s],
      [
        route({ src: { kind: 'channelSend', index: 0, sub: 1 }, dst: { kind: 'sendBus', index: 3 } }),
        route({ src: { kind: 'channelSend', index: 0, sub: 2 }, dst: { kind: 'sendBus', index: 2 } }),
      ],
    )
    const chips = chipsOf(map, s)
    expect(chips.divertedSends).toContain(1)
    expect(chips.divertedSends).not.toContain(2) // 2 → FX 2 is the default
  })

  it('counts a send routed into a STRIP as diverted', () => {
    const s = strip('a', 0)
    const map = mapWith(
      [s, strip('b', 1)],
      [route({ src: { kind: 'channelSend', index: 0, sub: 0 }, dst: chanIn(1) })],
    )
    expect(chipsOf(map, s).divertedSends).toContain(0)
  })

  it('lists the device inputs arriving', () => {
    const s = strip('a', 0)
    const map = mapWith(
      [s],
      [route({ src: { kind: 'deviceInput', index: 2, sub: 3 }, dst: chanIn(0) })],
    )
    expect(chipsOf(map, s).inputs).toEqual([2])
  })
})

describe('the feedback price', () => {
  it('is stated on the object, in ms', () => {
    const s = strip('a', 0)
    const map = mapWith(
      [s, strip('b', 1)],
      [route({ src: chanOut(1), dst: chanIn(0), feedback: true })],
    )
    // One block at 512/48k ≈ 10.7 ms — the honest price ROUTING-MATRIX names.
    expect(feedbackInto(map, s)).toBeCloseTo(10.666, 2)
  })

  it('is null when nothing loops into the strip', () => {
    const s = strip('a', 0)
    const map = mapWith(
      [s, strip('b', 1)],
      [route({ src: chanOut(1), dst: chanIn(0) })], // ordinary, zero-latency
    )
    expect(feedbackInto(map, s)).toBeNull()
  })
})

describe('cable geometry', () => {
  it('leaves the RIGHT edge and arrives at the LEFT', () => {
    const cell = { x: 100, y: 200, w: 340, h: 196 }
    expect(outPoint(cell, null)).toEqual({ x: 440, y: 298 })
    expect(inPoint(cell)).toEqual({ x: 100, y: 298 })
  })

  it('drops a SEND tap below the output, so two cables are two statements', () => {
    const cell = { x: 0, y: 0, w: 340, h: 196 }
    expect(outPoint(cell, 0).y).toBeGreaterThan(outPoint(cell, null).y)
    expect(outPoint(cell, 1).y).toBeGreaterThan(outPoint(cell, 0).y)
  })

  it('uses horizontal control arms, clamped at both ends', () => {
    // Horizontal arms make direction legible without an arrowhead. Clamped so a
    // plane-wide cable does not bow into a circle and adjacent strips do not
    // get a flat line.
    const near = cablePath({ x: 0, y: 0 }, { x: 10, y: 0 })
    const far = cablePath({ x: 0, y: 0 }, { x: 4000, y: 0 })
    expect(near).toContain('C 40 0')   // floor
    expect(far).toContain('C 160 0')   // ceiling
  })
})
describe('hasOutput (P3-U4)', () => {
  it('a defaulted strip has output (channelOut → main)', () => {
    const map = mapWith([strip('a', 0)], [route({ src: chanOut(0), dst: main })])
    expect(hasOutput(map, map.strips[0]!)).toBe(true)
  })

  it('a strip CHAINED into another strip counts as routed — the chip alone would lie', () => {
    // chipsOf only reports terminal facts; a chained strip reads `▸—` while
    // being perfectly audible through its carrier. "No output" must consult
    // the whole graph, not the chip.
    const map = mapWith([strip('a', 0)], [route({ src: chanOut(0), dst: chanIn(3) })])
    expect(hasOutput(map, map.strips[0]!)).toBe(true)
  })

  it('a send alone is still an output (it reaches an FX bus)', () => {
    const map = mapWith(
      [strip('a', 2)],
      [route({ src: { kind: 'channelSend', index: 2, sub: 1 }, dst: { kind: 'sendBus', index: 1 } })],
    )
    expect(hasOutput(map, map.strips[0]!)).toBe(true)
  })

  it('a fully unpatched strip has NO output — the state 15 warning is earned', () => {
    const map = mapWith([strip('a', 0)], [])
    expect(hasOutput(map, map.strips[0]!)).toBe(false)
  })

  it("another channel's routes do not count", () => {
    const map = mapWith([strip('a', 0)], [route({ src: chanOut(5), dst: main })])
    expect(hasOutput(map, map.strips[0]!)).toBe(false)
  })
})
