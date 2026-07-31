/**
 * ARMING A LAUNCH (P11-3c) — and above all, the four different ways it ends up
 * playing immediately.
 *
 * A bare boolean would collapse them, and they are not the same statement: one
 * was asked for, one is the normal start of a set, and two are limitations that
 * have to be sayable or they read as the feature being broken.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { armOrPlay, launchNote, stopAndDisarm } from './launch.ts'
import { emptyMap, type PlaneMap, type Strip } from '../persist/mapDocument.ts'
import { newGridElement, newStrip, newTapeElement } from './stripOps.ts'
import { MAX_DECKS, idleDeck, useCompanion } from '../store/companionEngine.ts'
import type { WorkingSession } from '../store/sessionStore.ts'

const sent: { method: string; params: Record<string, unknown> }[] = []
const link = {
  command: vi.fn(async (method: string, params: Record<string, unknown>) => {
    sent.push({ method, params })
    return { ok: true }
  }),
} as never

const session = (): WorkingSession =>
  ({
    name: 's',
    // Two 16-step tracks → a 16-step cycle, so `cycle` resolves to a real number.
    pattern: { bpm: 120, sectionA: [{ steps: new Array(16).fill(false) }] },
    kit: { id: 'k', name: 'kit', samples: [] },
    extras: new Map(),
  }) as unknown as WorkingSession

const gridStrip = (key: string, name: string, deck: number): Strip => ({
  ...newStrip(deck, { x: 0, y: 0 }),
  key,
  name,
  element: newGridElement(deck, 'ses', 120),
})

const mapOf = (strips: Strip[], over: Partial<PlaneMap['transport']> = {}): PlaneMap => ({
  ...emptyMap(),
  strips,
  transport: { ...emptyMap().transport, ...over },
})

beforeEach(() => {
  sent.length = 0
  useCompanion.setState({ decks: Array.from({ length: MAX_DECKS }, idleDeck) })
})

/** Deck `d` loaded and running — the thing a launch can wait on. */
function running(d: number) {
  useCompanion.setState((s) => ({
    decks: s.decks.map((x, i) => (i === d ? { ...x, session: session(), playing: true } : x)),
  }))
}

describe('arming', () => {
  it('waits on the reference, with the quantum resolved to real steps', () => {
    running(0)
    running(1) // the launcher needs material of its own, or play() no-ops
    const map = mapOf([gridStrip('a', 'DECK A', 0), gridStrip('b', 'DECK B', 1)])
    const out = armOrPlay(link, map, 'b', 1)

    expect(out).toMatchObject({ armed: true, refDeck: 0, refName: 'DECK A' })
    const arm = sent.find((c) => c.params.action === 'requestQuantizedLaunch')
    expect(arm).toBeTruthy()
    // `cycle` against a 16-step pattern — the REFERENCE's cycle, not the
    // launcher's: two strips with different patterns share no boundary.
    expect(arm!.params).toMatchObject({ deck: 1, refDeck: 0, quantizeSteps: 16 })
  })

  it('REFUSES to arm when the play did not take', () => {
    // `companionEngine.play` returns early with no session or no running
    // engine, silently. Arming after a no-op play hands the core a deck its
    // world does not say is playing: nothing to hold, nothing to release, and a
    // pad that waits forever with no error anywhere. Found by this test.
    running(0)
    const map = mapOf([gridStrip('a', 'DECK A', 0), gridStrip('b', 'DECK B', 1)])
    const out = armOrPlay(link, map, 'b', 1) // deck 1 has no session
    expect(out).toEqual({ armed: false, reason: 'didNotStart' })
    expect(sent.some((c) => c.params.action === 'requestQuantizedLaunch')).toBe(false)
    expect(launchNote(out)).toContain('nothing to play')
  })

  it('uses a FIXED quantum verbatim rather than the cycle', () => {
    running(0)
    running(1)
    const map = mapOf([gridStrip('a', 'A', 0), gridStrip('b', 'B', 1)], { launchQuantum: '4' })
    armOrPlay(link, map, 'b', 1)
    expect(sent.find((c) => c.params.action === 'requestQuantizedLaunch')!.params.quantizeSteps).toBe(4)
  })
})

describe('the four ways it plays immediately', () => {
  const armSent = () => sent.some((c) => c.params.action === 'requestQuantizedLaunch')

  it('quantum OFF — asked for, so no note', () => {
    running(0)
    const map = mapOf([gridStrip('a', 'A', 0), gridStrip('b', 'B', 1)], { launchQuantum: 'off' })
    const out = armOrPlay(link, map, 'b', 1)
    expect(out).toEqual({ armed: false, reason: 'quantumOff' })
    expect(armSent()).toBe(false)
    expect(launchNote(out)).toBeNull()
  })

  it('NOTHING PLAYING — the normal start of a set, so no note either', () => {
    // The donor arms anyway here and fires instantly, which reads as a bug.
    const map = mapOf([gridStrip('a', 'A', 0), gridStrip('b', 'B', 1)])
    const out = armOrPlay(link, map, 'b', 1)
    expect(out).toEqual({ armed: false, reason: 'nothingPlaying' })
    expect(armSent()).toBe(false)
    expect(launchNote(out)).toBeNull()
  })

  /**
   * ⚠️ `referenceHasNoDeck` IS CURRENTLY UNREACHABLE, and that is worth stating
   * rather than covering with a test that passes for the wrong reason.
   *
   * A tape strip never reports `playing` to the resolver (it has no engine deck
   * to read a transport from), so it never becomes a candidate — every path
   * that would reach a tape reference falls out at `nothingPlaying` first. The
   * branch stays because it is the honest guard for the day tapes DO carry a
   * transport, and because a resolver returning a tape is a legitimate answer
   * to a musical question even when the ABI cannot act on it.
   *
   * This is the seam D-SL-QUANTUM-01 flagged: quantized LOOPER launch needs
   * `launchArmed` for tapes in the engine before any of it can be exercised.
   */
  it('falls out at nothingPlaying when only a LOOPER could be the reference', () => {
    const tape: Strip = {
      ...newStrip(2, { x: 0, y: 0 }),
      key: 't',
      name: 'LOOP',
      element: newTapeElement(0, false),
    }
    running(1) // the launcher itself has material
    const out = armOrPlay(link, mapOf([tape, gridStrip('b', 'B', 1)], { syncMasterKey: 't' }), 'b', 1)
    // NOT `referenceHasNoDeck` — a tape is never a candidate in the first place.
    expect(out).toEqual({ armed: false, reason: 'nothingPlaying' })
    expect(sent.some((c) => c.params.action === 'requestQuantizedLaunch')).toBe(false)
  })

  it('a reference with NO CYCLE is not waited on — that would hold forever', () => {
    // ⚠️ MEASURED: `lcmForScene` never returns 0 for a loaded session — an
    // empty pattern still answers 16 (`patternClock.ts`'s own floor). So the
    // reachable no-cycle case is a reference deck marked playing with NO
    // SESSION at all, which is what this builds. The guard stays regardless:
    // `quantumSteps` can return 0, and waiting on a boundary that cannot be
    // computed would hold the deck forever.
    running(1)
    useCompanion.setState((s) => ({
      decks: s.decks.map((x, i) => (i === 0 ? { ...x, playing: true, session: null } : x)),
    }))
    const map = mapOf([gridStrip('a', 'A', 0), gridStrip('b', 'B', 1)])
    const out = armOrPlay(link, map, 'b', 1)
    expect(out).toEqual({ armed: false, reason: 'noCycle' })
    expect(launchNote(out)).toContain('no cycle')
  })
})

describe('stopping', () => {
  it('disarms unconditionally — a stop must not have to know what was pending', () => {
    stopAndDisarm(link, 1)
    expect(sent.some((c) => c.params.action === 'cancelQuantizedLaunch')).toBe(true)
  })
})
