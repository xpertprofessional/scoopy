import { describe, expect, it } from 'vitest'

import { captureRoutes, planApply, type EngineOp, type LiveRoute } from './mapApply'
import { emptyMap, rememberPerf, type PlaneMap, type Strip } from './mapDocument'

function strip(over: Partial<Strip> = {}): Strip {
  return {
    key: 'a',
    name: 'A',
    cell: { x: 0, y: 0, w: 340, h: 196 },
    channel: 0,
    element: { kind: 'none' },
    level: 1,
    mute: false,
    sends: [0, 0, 0, 0],
    recordArm: false,
    monitor: false,
    recordTap: null,
    sessionPerf: {},
    ...over,
  }
}

/** A grid element, spelled out here rather than imported from
    `plane/stripOps.newGridElement`: this is the persist tier, and taking its
    fixture from the plane would mean the document's apply plan was being
    checked against the plane's idea of a default. */
const gridEl = (deck: number, sessionId: string, bpm: number) =>
  ({
    kind: 'grid',
    deck,
    sessionId,
    bpm,
    syncToMaster: false,
    tempoMode: 'timeStretch',
    pulseRelation: 'auto',
    transpose: 0,
  }) as const

const indexOfOp = (ops: EngineOp[], pred: (o: EngineOp) => boolean) => ops.findIndex(pred)

describe('planApply', () => {
  it('clears routes FIRST, before anything else', () => {
    // The phantom-cable bug: a fresh engine boots with 40 default routes
    // (channel → main, send n → FX n). Applying a saved map without clearing
    // layers the document ON TOP of them, so the session gains cables on every
    // open and gets louder each time. First op, always.
    const map: PlaneMap = {
      ...emptyMap(),
      strips: [strip()],
      routes: [
        {
          src: { kind: 'channelOut', index: 0, sub: null },
          dst: { kind: 'main', index: 0 },
          gain: 1,
          feedback: false,
        },
      ],
    }
    const ops = planApply(map)
    expect(ops[0]).toEqual({ op: 'routeClearAll' })
    expect(ops.filter((o) => o.op === 'routeClearAll')).toHaveLength(1)
  })

  it('emits routeClearAll even for an empty map', () => {
    // An empty map still has to WIPE the boot wiring, or "load an empty map"
    // silently means "keep whatever was patched".
    expect(planApply(emptyMap())).toEqual([{ op: 'routeClearAll' }])
  })

  it('binds a channel source BEFORE writing its level and sends', () => {
    // Binding to a grid deck projects level/sends onto the core's per-deck
    // controls, so values written before the binding land on the wrong deck.
    const map: PlaneMap = {
      ...emptyMap(),
      strips: [
        strip({
          channel: 2,
          level: 0.5,
          sends: [0.25, 0, 0, 0],
          element: { ...gridEl(1, 's', 120), syncToMaster: false },
        }),
      ],
    }
    const ops = planApply(map)
    const bind = indexOfOp(ops, (o) => o.op === 'channelSetSource')
    const level = indexOfOp(ops, (o) => o.op === 'channelSetLevel')
    const send = indexOfOp(ops, (o) => o.op === 'channelSetSend')
    expect(bind).toBeGreaterThanOrEqual(0)
    expect(bind).toBeLessThan(level)
    expect(bind).toBeLessThan(send)
    expect(ops[bind]).toEqual({ op: 'channelSetSource', channel: 2, kind: 2, index: 1 })
  })

  it('applies the monitor EXPLICITLY, for both states', () => {
    // ⚠️ Emitted even when it is false, and that is the point. Loading a map
    // into a running engine inherits whatever the previous map left open, so a
    // strip that simply omitted the op would monitor because the LAST set did
    // — the feedback bug wearing a different hat, and invisible in the
    // document that is supposedly authoritative.
    const map: PlaneMap = {
      ...emptyMap(),
      strips: [
        strip({ key: 'a', channel: 0, monitor: false }),
        strip({ key: 'b', channel: 1, monitor: true }),
      ],
    }
    const ops = planApply(map).filter((o) => o.op === 'channelSetMonitor')
    expect(ops).toEqual([
      { op: 'channelSetMonitor', channel: 0, on: false },
      { op: 'channelSetMonitor', channel: 1, on: true },
    ])
  })

  it('adds every route AFTER all channel state', () => {
    const map: PlaneMap = {
      ...emptyMap(),
      strips: [strip({ key: 'a', channel: 0 }), strip({ key: 'b', channel: 1 })],
      routes: [
        {
          src: { kind: 'channelOut', index: 0, sub: null },
          dst: { kind: 'channelIn', index: 1 },
          gain: 1,
          feedback: false,
        },
      ],
    }
    const ops = planApply(map)
    const firstRoute = indexOfOp(ops, (o) => o.op === 'routeAdd')
    const lastChannel = ops.reduce(
      (last, o, i) => (o.op.startsWith('channel') || o.op.startsWith('tape') ? i : last),
      -1,
    )
    expect(firstRoute).toBeGreaterThan(lastChannel)
  })

  it('encodes every endpoint kind to the ABI numbers', () => {
    const map: PlaneMap = {
      ...emptyMap(),
      strips: [],
      routes: [
        {
          src: { kind: 'channelSend', index: 3, sub: 2 },
          dst: { kind: 'channelIn', index: 1 },
          gain: 0.5,
          feedback: false,
        },
        {
          src: { kind: 'deviceInput', index: 4, sub: 5 },
          dst: { kind: 'sendBus', index: 3 },
          gain: 1,
          feedback: false,
        },
        {
          src: { kind: 'fxReturn', index: 1, sub: null },
          dst: { kind: 'main', index: 0 },
          gain: 1,
          feedback: true,
        },
      ],
    }
    const routes = planApply(map).filter((o) => o.op === 'routeAdd')
    expect(routes[0]).toMatchObject({ srcKind: 1, srcIndex: 3, srcSub: 2, dstKind: 0, dstIndex: 1 })
    expect(routes[1]).toMatchObject({ srcKind: 2, srcIndex: 4, srcSub: 5, dstKind: 1, dstIndex: 3 })
    // A null sub becomes the engine's 0xFFFFFFFF sentinel, not 0 — 0 is a real
    // send index and a real input channel.
    expect(routes[2]).toMatchObject({ srcKind: 3, srcIndex: 1, srcSub: 0xffffffff, dstKind: 2 })
    expect(routes[2]).toMatchObject({ feedback: true })
  })

  it('resolves the sync ratio through the tempo LAW, not by dividing', () => {
    // ⚠️ THIS ASSERTION USED TO BE `ratio: 2`, and the change is the point of
    // P3-2. `planApply` computed `masterBpm / bpm`, which for a 70 BPM deck
    // under a 140 master says "run at 2×". Scoopy's law resolves the PULSE
    // RELATION first, and 1:2 is a perfect match here — same pulse, half-time
    // feel — so the deck stays at 70 and sits under the master rather than
    // doubling into it. That is what a musician means by synced, and it is the
    // developed behaviour the merge exists not to lose.
    const map: PlaneMap = {
      ...emptyMap(),
      transport: { masterBpm: 140, masterLevel: 1 },
      strips: [
        strip({
          key: 'a',
          channel: 0,
          element: { ...gridEl(0, 's', 70), syncToMaster: true }, // pulseRelation: 'auto'
        }),
      ],
    }
    expect(planApply(map).find((o) => o.op === 'deckSetTempoSync')).toEqual({
      op: 'deckSetTempoSync',
      deck: 0,
      ratio: 1,
    })
  })

  it('still doubles when 1:1 is asked for explicitly', () => {
    // The arithmetic answer is not gone, it is now a CHOICE. This is also what
    // the v3 → v4 migration pins every existing document to, so a saved map
    // keeps playing the way it did.
    const map: PlaneMap = {
      ...emptyMap(),
      transport: { masterBpm: 140, masterLevel: 1 },
      strips: [
        strip({
          key: 'a',
          channel: 0,
          element: { ...gridEl(0, 's', 70), syncToMaster: true, pulseRelation: '1:1' },
        }),
      ],
    }
    expect(planApply(map).find((o) => o.op === 'deckSetTempoSync')).toEqual({
      op: 'deckSetTempoSync',
      deck: 0,
      ratio: 2,
    })
  })

  it('carries the tempo MODE and the transpose beside the ratio', () => {
    // Three ops, because the ratio alone cannot say which of the engine's three
    // mechanisms it should drive. A ratio without a mode is the bug where a
    // deck stretches when it was asked to change key.
    const map: PlaneMap = {
      ...emptyMap(),
      strips: [
        strip({
          element: { ...gridEl(1, 's', 120), tempoMode: 'timePitch', transpose: -3 },
        }),
      ],
    }
    const ops = planApply(map)
    expect(ops).toContainEqual({ op: 'deckSetTempoMode', deck: 1, mode: 0 }) // timePitch
    expect(ops).toContainEqual({ op: 'deckSetTranspose', deck: 1, semitones: -3 })
  })

  it('sends ratio 1.0 for an UNSYNCED deck rather than omitting the call', () => {
    // Omitting it would leave the deck carrying a ratio from a previously
    // loaded map — a stretched deck with nothing in the document explaining it.
    const map: PlaneMap = {
      ...emptyMap(),
      transport: { masterBpm: 140, masterLevel: 1 },
      strips: [
        strip({
          element: { ...gridEl(2, 's', 70), syncToMaster: false },
        }),
      ],
    }
    expect(planApply(map).find((o) => o.op === 'deckSetTempoSync')).toEqual({
      op: 'deckSetTempoSync',
      deck: 2,
      ratio: 1,
    })
  })

  it('restores a tape element with its take, loop and rate', () => {
    const map: PlaneMap = {
      ...emptyMap(),
      strips: [
        strip({
          channel: 1,
          element: {
            kind: 'tape',
            index: 3,
            takeRef: 'take_0007',
            stereo: true,
            loop: { enabled: true, start: 100, end: 4900 },
            rate: -0.75,
            bpm: null,
            syncToMaster: false,
            tempoMode: 'timePitch',
            pulseRelation: 'auto',
          },
        }),
      ],
    }
    const ops = planApply(map)
    expect(ops).toContainEqual({ op: 'tapeLoadTake', tape: 3, takeRef: 'take_0007' })
    expect(ops).toContainEqual({ op: 'tapeSetLoop', tape: 3, enabled: true, start: 100, end: 4900 })
    expect(ops).toContainEqual({ op: 'tapeSetRate', tape: 3, rate: -0.75 })
  })

  it('does not load a take for a tape that has no material', () => {
    const map: PlaneMap = {
      ...emptyMap(),
      strips: [
        strip({
          element: {
            kind: 'tape',
            index: 0,
            takeRef: null,
            stereo: false,
            loop: { enabled: false, start: 0, end: 0 },
            rate: 1,
            bpm: null,
            syncToMaster: false,
            tempoMode: 'timePitch',
            pulseRelation: 'auto',
          },
        }),
      ],
    }
    expect(planApply(map).some((o) => o.op === 'tapeLoadTake')).toBe(false)
  })
})

describe('captureRoutes', () => {
  const live = (over: Partial<LiveRoute> = {}): LiveRoute => ({
    active: true,
    srcKind: 0,
    srcIndex: 0,
    srcSub: 0xffffffff,
    dstKind: 2,
    dstIndex: 0,
    gain: 1,
    feedback: false,
    ...over,
  })

  it('reads the live graph back into document routes', () => {
    const got = captureRoutes([
      live({ srcKind: 1, srcIndex: 2, srcSub: 3, dstKind: 0, dstIndex: 4, gain: 0.5 }),
      live({ srcKind: 0, srcIndex: 1, dstKind: 0, dstIndex: 0, feedback: true }),
    ])
    expect(got).toEqual([
      {
        src: { kind: 'channelSend', index: 2, sub: 3 },
        dst: { kind: 'channelIn', index: 4 },
        gain: 0.5,
        feedback: false,
      },
      {
        src: { kind: 'channelOut', index: 1, sub: null },
        dst: { kind: 'channelIn', index: 0 },
        gain: 1,
        feedback: true,
      },
    ])
  })

  it('skips inactive slots', () => {
    // The engine's route table is a fixed array of slots; most are empty.
    expect(captureRoutes([live({ active: false }), live()])).toHaveLength(1)
  })

  it('skips a cable it cannot name rather than guessing one', () => {
    // A kind this build does not know is a cable a NEWER build patched. Saving
    // a guess would rewrite it into something else entirely.
    expect(captureRoutes([live({ srcKind: 99 })])).toHaveLength(0)
    expect(captureRoutes([live({ dstKind: 99 })])).toHaveLength(0)
  })

  it('round-trips: capture what was planned, and plan it again unchanged', () => {
    // The contract that matters. A save/load which drops or mangles one cable
    // is the failure that only shows up on stage.
    const map: PlaneMap = {
      ...emptyMap(),
      routes: [
        {
          src: { kind: 'channelOut', index: 0, sub: null },
          dst: { kind: 'main', index: 0 },
          gain: 1,
          feedback: false,
        },
        {
          src: { kind: 'channelSend', index: 1, sub: 2 },
          dst: { kind: 'channelIn', index: 0 },
          gain: 0.75,
          feedback: false,
        },
        {
          src: { kind: 'channelOut', index: 2, sub: null },
          dst: { kind: 'channelIn', index: 1 },
          gain: 0.25,
          feedback: true,
        },
      ],
    }
    const planned = planApply(map).filter((o) => o.op === 'routeAdd')
    const asLive: LiveRoute[] = planned.map((o) =>
      o.op === 'routeAdd'
        ? {
            active: true,
            srcKind: o.srcKind,
            srcIndex: o.srcIndex,
            srcSub: o.srcSub,
            dstKind: o.dstKind,
            dstIndex: o.dstIndex,
            gain: o.gain,
            feedback: o.feedback,
          }
        : (undefined as never),
    )
    expect(captureRoutes(asLive)).toEqual(map.routes)
  })
})

describe('the performance layer goes back on', () => {
  it('restores the scene and how it switches, per (strip, session)', () => {
    const s = rememberPerf(
      strip({ element: { ...gridEl(1, 's1', 120), syncToMaster: false } }),
      's1',
      { currentScene: 'D', switchMode: 'seamlessImmediate', queuedScenes: ['E'], queueLoop: true },
    )
    const ops = planApply({ ...emptyMap(), strips: [s] })
    expect(ops).toContainEqual({ op: 'sceneSelect', deck: 1, scene: 'D' })
    expect(ops).toContainEqual({
      op: 'sceneSetSwitch',
      deck: 1,
      switchMode: 'seamlessImmediate',
      queuedScenes: ['E'],
      queueLoop: true,
    })
  })

  it('uses the DEFAULTS for a session this strip has not hosted', () => {
    // The strip remembers session A; it is currently carrying B, so B must not
    // inherit A's scene — that is the whole point of keying per pairing.
    const s = rememberPerf(
      strip({ element: { ...gridEl(0, 'B', 120), syncToMaster: false } }),
      'A',
      { currentScene: 'H', switchMode: 'restartImmediate', queuedScenes: [], queueLoop: true },
    )
    const ops = planApply({ ...emptyMap(), strips: [s] })
    expect(ops).toContainEqual({ op: 'sceneSelect', deck: 0, scene: 'A' }) // the default letter
    expect(ops).toContainEqual({
      op: 'sceneSetSwitch',
      deck: 0,
      switchMode: 'scheduled',
      queuedScenes: [],
      queueLoop: false,
    })
  })

  it('emits nothing scene-shaped for a tape or an empty strip', () => {
    // Scenes are a grid concept; a tape has no scenes to recall.
    const ops = planApply({
      ...emptyMap(),
      strips: [strip({ key: 'x', element: { kind: 'none' } })],
    })
    expect(ops.some((o) => o.op === 'sceneSelect' || o.op === 'sceneSetSwitch')).toBe(false)
  })
})
