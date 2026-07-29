import { describe, expect, it } from 'vitest'

import { TEMPO_MODE_ID, deckTempoIntent, formatSyncedBpm, inferTapeBpm, mapTapeRateOps, mapTempoIntents, tapeEffectiveRate } from './tempo.ts'
import { emptyMap, type PlaneMap, type Strip } from './mapDocument.ts'

const gridEl = (over: Record<string, unknown> = {}) =>
  ({
    kind: 'grid',
    deck: 0,
    sessionId: 's',
    bpm: 120,
    syncToMaster: true,
    tempoMode: 'timeStretch',
    pulseRelation: 'auto',
    transpose: 0,
    ...over,
  }) as Extract<Strip['element'], { kind: 'grid' }>

const strip = (element: Strip['element']): Strip => ({
  key: 'a',
  name: 'A',
  cell: { x: 0, y: 0, w: 340, h: 196 },
  channel: 0,
  element,
  level: 1,
  mute: false,
  sends: [0, 0, 0, 0],
  recordArm: false,
  monitor: false,
  recordTap: null,
  sessionPerf: {},
})

describe('deckTempoIntent', () => {
  it('leaves an unsynced deck at its own tempo', () => {
    const i = deckTempoIntent(gridEl({ syncToMaster: false }), 200)
    // 1.0 is a VALUE to send, not an absence. A deck can be carrying a ratio
    // from a previously loaded map, and omitting the call leaves it stretched.
    expect(i.syncRatio).toBe(1)
    expect(i.syncedBpm).toBeNull()
    expect(formatSyncedBpm(i)).toBe('—')
  })

  it('resolves `auto` to the nearest MUSICAL relation, not the raw quotient', () => {
    // The behaviour the plane was missing entirely. A 70 BPM deck under a 140
    // master is not "2×" — it is 1:2, the same pulse at half-time, and the deck
    // keeps its own tempo. This is the whole reason the law is worth calling.
    const i = deckTempoIntent(gridEl({ bpm: 70 }), 140)
    expect(i.pulse).toBe('1:2')
    expect(i.syncRatio).toBe(1)
    expect(i.syncedBpm).toBe(70)
  })

  it('takes an explicit relation over the resolver', () => {
    const i = deckTempoIntent(gridEl({ bpm: 70, pulseRelation: '1:1' }), 140)
    expect(i.pulse).toBe('1:1')
    expect(i.syncRatio).toBe(2)
    expect(i.syncedBpm).toBe(140)
  })

  it('puts a deck in three-against-two on request', () => {
    // 3:2 against a 128 master is 192 — a real musical relation the arithmetic
    // ratio has no way to express at all.
    const i = deckTempoIntent(gridEl({ bpm: 128, pulseRelation: '3:2' }), 128)
    expect(i.syncedBpm).toBeCloseTo(192, 4)
    expect(formatSyncedBpm(i)).toBe('192.0')
  })

  it('carries the nudge WITHOUT touching the document tempo', () => {
    // A hand on a pitch fader. It moves what the engine hears and nothing else:
    // the element's own bpm is untouched, so releasing snaps back to lock and
    // the map is not marked dirty by a gesture.
    const el = gridEl({ bpm: 100, pulseRelation: '1:1' })
    const nudged = deckTempoIntent(el, 100, 10)
    expect(nudged.syncedBpm).toBeCloseTo(110, 3)
    expect(el.bpm).toBe(100)
    expect(deckTempoIntent(el, 100).syncedBpm).toBeCloseTo(100, 4)
  })

  it('does not run away at an absurd master tempo', () => {
    // The law's 600 BPM ceiling. Without it a fat-fingered master tempo is a
    // deck at 40× and a burst of noise through the PA.
    const i = deckTempoIntent(gridEl({ bpm: 20, pulseRelation: '1:1' }), 5000)
    expect(i.syncedBpm!).toBeLessThanOrEqual(600.0001)
  })

  it('reports the deck, mode and transpose it was given', () => {
    const i = deckTempoIntent(gridEl({ deck: 2, tempoMode: 'timePitch', transpose: -3 }), 120)
    expect(i.deck).toBe(2)
    expect(i.tempoMode).toBe('timePitch')
    expect(i.transpose).toBe(-3)
  })
})

describe('TEMPO_MODE_ID', () => {
  it('matches the engine ids in SL-ABI-V3 §3', () => {
    // Hand-checked against `kDeckParamNames` / applyDeckParams in
    // slengine/src/sl_engine.cpp. If these ever disagree, a strip asking for
    // pitch-preserving stretch gets varispeed instead — audible, and with
    // nothing on screen saying why.
    expect(TEMPO_MODE_ID).toEqual({ timePitch: 0, timeStretch: 1, tempoOnly: 2 })
  })
})

describe('mapTempoIntents', () => {
  it('covers every grid strip and no others', () => {
    const map: PlaneMap = {
      ...emptyMap(),
      strips: [
        strip(gridEl({ deck: 0 })),
        strip({ kind: 'none' }),
        strip(gridEl({ deck: 2, bpm: 90 })),
      ],
    }
    expect(mapTempoIntents(map).map((i) => i.deck)).toEqual([0, 2])
  })

  it('resolves against the map’s master, not each strip’s', () => {
    const map: PlaneMap = {
      ...emptyMap(),
      transport: { masterBpm: 90, masterLevel: 1 },
      strips: [strip(gridEl({ bpm: 90, pulseRelation: '1:1' }))],
    }
    expect(mapTempoIntents(map)[0]?.syncedBpm).toBeCloseTo(90, 4)
  })

  it('folds the per-deck nudge in — and only for the deck under the hand (P3-D4-2)', () => {
    const map: PlaneMap = {
      ...emptyMap(),
      transport: { masterBpm: 120, masterLevel: 1 },
      strips: [
        strip(gridEl({ deck: 0, bpm: 120, pulseRelation: '1:1' })),
        strip(gridEl({ deck: 1, bpm: 120, pulseRelation: '1:1' })),
      ],
    }
    const nudged = mapTempoIntents(map, (deck) => (deck === 0 ? 4 : 0))
    expect(nudged[0]?.syncedBpm).toBeCloseTo(124, 3)
    expect(nudged[1]?.syncedBpm).toBeCloseTo(120, 3)
    // No hand = the pre-nudge behaviour, exactly (map load must not change).
    const clean = mapTempoIntents(map)
    expect(clean[0]?.syncedBpm).toBeCloseTo(120, 3)
  })
})

describe('inferTapeBpm (P3-2b-2, provisional D-2)', () => {
  const sr = 48000

  it('an exact 4-beat loop at the stamped tempo comes back at that tempo', () => {
    // 4 beats at 120 = 2 s = 96000 frames.
    expect(inferTapeBpm(96000, sr, 120)).toBe(120)
  })

  it('a hand-stopped loop snaps to the nearest power of two and re-derives', () => {
    // ~4.1 beats' worth of audio at 128: snapped to 4 beats, so the tape's own
    // bpm is slightly LOW of 128 — the audio is a touch long for 4 at 128.
    const frames = Math.round((4.1 * 60 / 128) * sr)
    const bpm = inferTapeBpm(frames, sr, 128)
    expect(bpm).not.toBeNull()
    expect(bpm!).toBeGreaterThan(124)
    expect(bpm!).toBeLessThan(128)
  })

  it('snapping is unambiguous across the guard band — neighbours are 2× apart', () => {
    // 8.3 beats at 120 → snaps to 8, never 4 or 16.
    const frames = Math.round((8.3 * 60 / 120) * sr)
    const bpm = inferTapeBpm(frames, sr, 120)!
    const seconds = frames / sr
    expect(Math.round((seconds * bpm) / 60)).toBe(8)
  })

  it('refuses a loop that is not near ANY musical length', () => {
    // 2.9 beats: 45% off 2 and 27% off 4 — outside the guard both ways.
    const frames = Math.round((2.9 * 60 / 120) * sr)
    expect(inferTapeBpm(frames, sr, 120)).toBeNull()
  })

  it('refuses garbage rather than guessing', () => {
    expect(inferTapeBpm(0, sr, 120)).toBeNull()
    expect(inferTapeBpm(96000, 0, 120)).toBeNull()
    expect(inferTapeBpm(96000, sr, 0)).toBeNull()
  })

  it('a long-form recording still resolves (32 beats)', () => {
    // 32 beats at 90 — a 21.3 s phrase. Inference is not just for one-bar loops.
    const frames = Math.round((32 * 60 / 90) * sr)
    expect(inferTapeBpm(frames, sr, 90)).toBe(90)
  })
})

describe('tapeEffectiveRate (P3-2b-3 — tape sync v1, timePitch)', () => {
  const tapeEl = (over: Record<string, unknown> = {}) => ({
    kind: 'tape' as const,
    index: 0,
    takeRef: 't',
    stereo: false,
    loop: { enabled: true, start: 0, end: 96000 },
    rate: 1,
    bpm: 64 as number | null,
    syncToMaster: true,
    tempoMode: 'timePitch' as const,
    pulseRelation: '1:1' as const,
    ...over,
  })

  it('a synced tape resolves through the LAW — 64 under 128 at 1:1 runs 2×', () => {
    expect(tapeEffectiveRate(tapeEl(), 128)).toBeCloseTo(2, 5)
  })

  it('auto resolves the PULSE first — 70 under 140 lands at 1:2, rate ~1', () => {
    // The whole reason this goes through djSyncLaw and not a division: a
    // 70 BPM loop under a 140 master is the same pulse at half time, not a
    // chipmunk at 2×.
    expect(tapeEffectiveRate(tapeEl({ bpm: 70, pulseRelation: 'auto' }), 140)).toBeCloseTo(1, 5)
  })

  it('sync owns the MAGNITUDE, the hand keeps the SIGN — reverse survives', () => {
    expect(tapeEffectiveRate(tapeEl({ rate: -1 }), 128)).toBeCloseTo(-2, 5)
  })

  it('unsynced and unknown-bpm tapes keep the manual rate', () => {
    expect(tapeEffectiveRate(tapeEl({ syncToMaster: false, rate: 0.5 }), 128)).toBe(0.5)
    // No bpm = cannot sync; the intent stays, the rate stays honest.
    expect(tapeEffectiveRate(tapeEl({ bpm: null, rate: 0.5 }), 128)).toBe(0.5)
  })

  it('timeStretch takes the SAME ratio — the engine mode decides what it drives (P3-2b-5)', () => {
    // One number, two mechanisms: varispeed moves pitch with it, the
    // stretcher holds pitch. The mode travels beside the rate in applyTempo.
    expect(tapeEffectiveRate(tapeEl({ tempoMode: 'timeStretch' }), 128)).toBeCloseTo(2, 5)
  })

  it('mapTapeRateOps includes UNSYNCED tapes at their manual rate', () => {
    // Un-syncing must RESTORE the hand's rate — omission would leave the
    // engine carrying the last synced ratio with the UI showing FREE.
    const map = {
      ...emptyMap(),
      strips: [
        {
          key: 'a',
          name: 'A',
          cell: { x: 0, y: 0, w: 340, h: 196 },
          channel: 0,
          element: tapeEl({ syncToMaster: false, rate: 0.75 }),
          level: 1,
          mute: false,
          sends: [0, 0, 0, 0] as [number, number, number, number],
          monitor: false,
          recordArm: false,
          recordTap: null,
          sessionPerf: {},
        },
      ],
    }
    expect(mapTapeRateOps(map)).toEqual([{ tape: 0, rate: 0.75, mode: 0 }])
  })
})
