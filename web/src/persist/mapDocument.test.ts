import { describe, expect, it } from 'vitest'

import {
  LANE_BUDGET,
  MAP_SCHEMA_VERSION,
  elementLanes,
  emptyMap,
  lanesUsed,
  loadMap,
  saveMap,
  defaultGridPerf,
  perfFor,
  rememberPerf,
  type GridPerf,
  type PlaneMap,
  type Strip,
} from './mapDocument'

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
    drive: { curve: 0, amount: 1 },
    recordArm: false,
    monitor: false,
    recordTap: null,
    sessionPerf: {},
    ...over,
  }
}

const tape = (stereo: boolean, takeRef: string | null = null) => ({
  kind: 'tape' as const,
  index: 0,
  takeRef,
  stereo,
  loop: { enabled: true, start: 0, end: 48000 },
  rate: 1,
  bpm: null,
  syncToMaster: false,
  tempoMode: 'timePitch' as const,
  pulseRelation: 'auto' as const,
})

// Spelled out rather than built from `plane/stripOps.newGridElement`: this file
// tests the DOCUMENT, and reaching into the plane for a fixture would mean the
// schema's round-trip was being checked against the plane's idea of it.
const grid = () => ({
  kind: 'grid' as const,
  deck: 0,
  sessionId: 's1',
  bpm: 128,
  syncToMaster: true,
  tempoMode: 'timeStretch' as const,
  pulseRelation: 'auto' as const,
  transpose: 0,
})

describe('map document', () => {
  it('round-trips a populated map unchanged', () => {
    const map: PlaneMap = {
      ...emptyMap(),
      strips: [
        strip({ key: 'a', channel: 0, element: tape(true, 'take_0003') }),
        strip({ key: 'b', channel: 1, element: grid(), sends: [0.5, 0, 0, 0] }),
      ],
      routes: [
        {
          src: { kind: 'channelOut', index: 0, sub: null },
          dst: { kind: 'main', index: 0 },
          gain: 1,
          feedback: false,
        },
        // A send re-pointed at another strip's input — decision 5's whole point.
        {
          src: { kind: 'channelSend', index: 1, sub: 2 },
          dst: { kind: 'channelIn', index: 0 },
          gain: 1,
          feedback: false,
        },
        // A consented feedback edge.
        {
          src: { kind: 'channelOut', index: 1, sub: null },
          dst: { kind: 'channelIn', index: 0 },
          gain: 0.5,
          feedback: true,
        },
      ],
      transport: { masterBpm: 174, masterLevel: 0.8 },
    }

    const doc = saveMap(map)
    expect(doc.schemaVersion).toBe(MAP_SCHEMA_VERSION)

    const back = loadMap(JSON.parse(JSON.stringify(doc)))
    expect(back.ok).toBe(true)
    if (!back.ok) return
    // Deep equality is the assertion that matters: a save/load which quietly
    // drops one cable or one flag is the failure that only shows up on stage.
    expect(back.map).toEqual(map)
    expect(back.migratedFrom).toBeUndefined()
  })

  it('refuses a document from a newer build rather than partially loading it', () => {
    const doc = saveMap(emptyMap()) as Record<string, unknown>
    doc.schemaVersion = MAP_SCHEMA_VERSION + 1
    const r = loadMap(doc)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('tooNew')
    // Partially loading and re-saving would destroy whatever the newer version
    // knew about, so the refusal has to say so rather than look like a bug.
    expect(r.message).toMatch(/newer/i)
  })

  describe('the v2 → v3 migration (the split tap)', () => {
    /** A v2 document: a strip with neither `monitor` nor `recordTap`. Built by
        hand rather than by saveMap, which now emits v3. */
    const v2Doc = () => {
      const doc = saveMap({ ...emptyMap(), strips: [strip()] }) as unknown as {
        schemaVersion: number
        map: { strips: Record<string, unknown>[] }
      }
      doc.schemaVersion = 2
      for (const s of doc.map.strips) {
        delete s.monitor
        delete s.recordTap
      }
      return doc
    }

    it('opens a v2 map with the monitor CLOSED', () => {
      const r = loadMap(v2Doc())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.migratedFrom).toBe(2)
      // ⚠️ This migration deliberately does NOT preserve how a v2 map sounded,
      // which is the opposite of the masterLevel migration's rule. A v2 map
      // sounded like every input strip monitoring permanently with no way to
      // stop it — that is the bug v3 exists to fix, and restoring it faithfully
      // would reopen every saved map straight back into the feedback loop.
      expect(r.map.strips[0]?.monitor).toBe(false)
    })

    it('leaves the record tap on the RULE rather than pinning it', () => {
      const r = loadMap(v2Doc())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      // null = "the rule decides", which reproduces v2 behaviour exactly for a
      // strip with no live input (it still records its own channel bus) and
      // gives the input case the split tap. Writing 'bus' here would freeze
      // every migrated strip out of the fix.
      expect(r.map.strips[0]?.recordTap).toBeNull()
    })

    it('round-trips a v3 map without migrating it', () => {
      const saved = saveMap({ ...emptyMap(), strips: [strip({ monitor: true, recordTap: 'bus' })] })
      const r = loadMap(JSON.parse(JSON.stringify(saved)))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.migratedFrom).toBeUndefined()
      // The switch is a performance decision about a SET — restoring a map into
      // silence (or feedback) because it was not saved is the failure here.
      expect(r.map.strips[0]?.monitor).toBe(true)
      expect(r.map.strips[0]?.recordTap).toBe('bus')
    })
  })

  describe('the v3 → v4 migration (a grid strip gains its tempo intent)', () => {
    /** A v3 document: a grid strip with none of the tempo-intent fields. */
    const v3Doc = () => {
      const doc = saveMap({
        ...emptyMap(),
        strips: [strip({ element: grid() })],
      }) as unknown as {
        schemaVersion: number
        map: { strips: { element: Record<string, unknown> }[] }
      }
      doc.schemaVersion = 3
      for (const s of doc.map.strips) {
        delete s.element.tempoMode
        delete s.element.pulseRelation
        delete s.element.transpose
      }
      return doc
    }

    it('opens a v3 map SOUNDING THE SAME', () => {
      const r = loadMap(v3Doc())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.migratedFrom).toBe(3)
      const el = r.map.strips[0]?.element
      expect(el?.kind).toBe('grid')
      if (el?.kind !== 'grid') return
      // v3 had exactly ONE sync mechanism — the bus stretcher at a plain
      // master/deck ratio — so the faithful restatement is timeStretch, 1:1,
      // no transpose. This follows the masterLevel migration's rule, not the
      // split-tap migration's: nothing here was a bug to be corrected.
      expect(el.tempoMode).toBe('timeStretch')
      expect(el.transpose).toBe(0)
    })

    it('migrates to 1:1, NOT to the `auto` a new strip gets', () => {
      const r = loadMap(v3Doc())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const el = r.map.strips[0]?.element
      if (el?.kind !== 'grid') return
      // ⚠️ The one decision in this migration worth stating. `auto` is the right
      // default for a NEW strip and the wrong answer for an existing document:
      // it resolves to the nearest MUSICAL ratio, so a 70 BPM deck synced to a
      // 140 master would come back at 1:2 — half-timed — where v3 played it at
      // 2×. A migration that changes how a saved set plays is not a migration.
      expect(el.pulseRelation).toBe('1:1')
    })

    it('leaves a TAPE strip alone', () => {
      const doc = saveMap({
        ...emptyMap(),
        strips: [strip({ element: tape(true, 't1') })],
      }) as unknown as { schemaVersion: number }
      doc.schemaVersion = 3
      const r = loadMap(doc)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.map.strips[0]?.element.kind).toBe('tape')
    })
  })

  describe('the v4 → v5 migration (a tape strip gains its tempo identity, P3-2b-1)', () => {
    /** A v4 document: a tape strip with none of the tempo fields. */
    const v4Doc = () => {
      const doc = saveMap({
        ...emptyMap(),
        strips: [strip({ element: tape(false, 'take_0009') })],
      }) as unknown as {
        schemaVersion: number
        map: { strips: { element: Record<string, unknown> }[] }
      }
      doc.schemaVersion = 4
      for (const s of doc.map.strips) {
        delete s.element.bpm
        delete s.element.syncToMaster
        delete s.element.tempoMode
        delete s.element.pulseRelation
      }
      return doc
    }

    it('opens a v4 map SOUNDING THE SAME — sync off, bpm honestly unknown', () => {
      const r = loadMap(v4Doc())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.migratedFrom).toBe(4)
      const el = r.map.strips[0]?.element
      expect(el?.kind).toBe('tape')
      if (el?.kind !== 'tape') return
      // A v4 tape had no sync mechanism at all, so the faithful restatement is
      // sync OFF with an UNKNOWN bpm — never an inferred one, which could
      // differ between builds and change how a saved set plays.
      expect(el.syncToMaster).toBe(false)
      expect(el.bpm).toBeNull()
      // timePitch is the D-3 zero-latency default and is inert while sync is
      // off; a migrated tape that later syncs behaves like a new one.
      expect(el.tempoMode).toBe('timePitch')
      expect(el.pulseRelation).toBe('auto')
    })

    it('keeps the material fields untouched on the way', () => {
      const r = loadMap(v4Doc())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const el = r.map.strips[0]?.element
      if (el?.kind !== 'tape') return
      expect(el.takeRef).toBe('take_0009')
      expect(el.rate).toBe(1)
      expect(el.loop.enabled).toBe(true)
    })

    it('leaves a GRID strip alone', () => {
      const doc = saveMap({
        ...emptyMap(),
        strips: [strip({ element: grid() })],
      }) as unknown as { schemaVersion: number }
      doc.schemaVersion = 4
      const r = loadMap(doc)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.map.strips[0]?.element.kind).toBe('grid')
    })

    it('a migrated map re-saves as clean idempotent v5', () => {
      const r = loadMap(v4Doc())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const again = loadMap(JSON.parse(JSON.stringify(saveMap(r.map))))
      expect(again.ok).toBe(true)
      if (!again.ok) return
      expect(again.migratedFrom).toBeUndefined()
    })
  })

  describe('the v5 → v6 migration (strips gain the DRV stage, P3-X2)', () => {
    /** A v5 document: a strip with no drive field. */
    const v5Doc = () => {
      const doc = saveMap({
        ...emptyMap(),
        strips: [strip({ level: 0.7 })],
      }) as unknown as {
        schemaVersion: number
        map: { strips: Record<string, unknown>[] }
      }
      doc.schemaVersion = 5
      for (const s of doc.map.strips) delete s.drive
      return doc
    }

    it('opens a v5 map SOUNDING THE SAME — DRV off, and off is a bypass branch', () => {
      const r = loadMap(v5Doc())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.migratedFrom).toBe(5)
      // amount 1 = the engine's bypass BRANCH (bit-exact), so a v5 map plays
      // back identically — the house migration rule.
      expect(r.map.strips[0]?.drive).toEqual({ curve: 0, amount: 1 })
      // and the fields around it are untouched
      expect(r.map.strips[0]?.level).toBe(0.7)
    })

    it('a migrated map re-saves as clean idempotent v6', () => {
      const r = loadMap(v5Doc())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const again = loadMap(JSON.parse(JSON.stringify(saveMap(r.map))))
      expect(again.ok).toBe(true)
      if (!again.ok) return
      expect(again.migratedFrom).toBeUndefined()
    })

    it('refuses an out-of-range drive rather than clamping it silently', () => {
      const doc = saveMap({
        ...emptyMap(),
        strips: [strip({ drive: { curve: 2, amount: 8 } })],
      }) as unknown as { map: { strips: { drive: { amount: number } }[] } }
      doc.map.strips[0]!.drive.amount = 99
      expect(loadMap(doc).ok).toBe(false)
    })
  })

  describe('the v6 → v7 migration (a route may name a deck output, P3.5-E3)', () => {
    it('opens a v6 map unchanged — the source enum only WIDENED', () => {
      const doc = saveMap({ ...emptyMap(), strips: [strip({})] }) as unknown as {
        schemaVersion: number
      }
      doc.schemaVersion = 6
      const r = loadMap(doc)
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.migratedFrom).toBe(6)
      expect(r.map.strips[0]?.drive).toEqual({ curve: 0, amount: 1 })
    })

    it('round-trips a deckOut cable — index is the DECK, and it survives verbatim', () => {
      const map: PlaneMap = {
        ...emptyMap(),
        strips: [strip({})],
        routes: [
          {
            src: { kind: 'deckOut', index: 2, sub: null },
            dst: { kind: 'channelIn', index: 1 },
            gain: 1,
            feedback: false,
          },
        ],
      }
      const again = loadMap(JSON.parse(JSON.stringify(saveMap(map))))
      expect(again.ok).toBe(true)
      if (!again.ok) return
      expect(again.migratedFrom).toBeUndefined()
      expect(again.map.routes[0]?.src).toEqual({ kind: 'deckOut', index: 2, sub: null })
    })
  })

  describe('the v7 → v8 migration (the map remembers its FX plugins, P6-5b)', () => {
    const v7Doc = () => {
      const doc = saveMap({ ...emptyMap(), strips: [strip({})] }) as unknown as {
        schemaVersion: number
        map: Record<string, unknown>
      }
      doc.schemaVersion = 7
      delete doc.map.fx
      return doc
    }

    it('opens a v7 map SOUNDING THE SAME — four empty returns', () => {
      const r = loadMap(v7Doc())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.migratedFrom).toBe(7)
      // v7 had nowhere to store a plugin, so reopening one always came up with
      // bare returns. The house rule: an old map plays back as it did.
      expect(r.map.fx).toEqual([
        { identifier: null, state: null },
        { identifier: null, state: null },
        { identifier: null, state: null },
        { identifier: null, state: null },
      ])
    })

    it('round-trips a loaded plugin and its state blob verbatim', () => {
      const map: PlaneMap = {
        ...emptyMap(),
        fx: [
          { identifier: 'AudioUnit:Effects/aufx,dely,appl', state: 'YmFzZTY0' },
          { identifier: null, state: null },
          { identifier: 'VST3:some-reverb', state: null },
          { identifier: null, state: null },
        ],
      }
      const again = loadMap(JSON.parse(JSON.stringify(saveMap(map))))
      expect(again.ok).toBe(true)
      if (!again.ok) return
      expect(again.migratedFrom).toBeUndefined()
      // A state blob that came back altered is a plugin that restores wrong.
      expect(again.map.fx).toEqual(map.fx)
    })

    it('refuses a map whose fx is not exactly four returns', () => {
      // A tuple, not an array: three entries would silently leave FX 4 unwritten
      // on every load, which reads as "the plugin vanished".
      const doc = saveMap(emptyMap()) as unknown as { map: { fx: unknown } }
      doc.map.fx = [{ identifier: null, state: null }]
      expect(loadMap(doc).ok).toBe(false)
    })

    it('a migrated v7 map re-saves as clean idempotent v8', () => {
      const r = loadMap(v7Doc())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      const again = loadMap(JSON.parse(JSON.stringify(saveMap(r.map))))
      expect(again.ok).toBe(true)
      if (again.ok) expect(again.migratedFrom).toBeUndefined()
    })
  })

  it('treats an unknown key as a loud failure, never a silent coercion', () => {
    const doc = saveMap(emptyMap()) as unknown as { map: Record<string, unknown> }
    doc.map.mysteryField = 1
    expect(loadMap(doc).ok).toBe(false)
  })

  it.each([
    ['not an object', 42],
    ['no version', { map: emptyMap() }],
    ['bad version', { schemaVersion: 0, savedAt: '', app: 'x', map: emptyMap() }],
  ])('rejects %s as corrupt', (_label, input) => {
    const r = loadMap(input)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('corrupt')
  })

  describe('the lane budget', () => {
    it('counts a grid as stereo, a tape by its own width, an empty strip as nothing', () => {
      expect(elementLanes({ kind: 'none' })).toBe(0)
      expect(elementLanes(grid())).toBe(2)
      expect(elementLanes(tape(true))).toBe(2)
      expect(elementLanes(tape(false))).toBe(1)
    })

    it('admits the combinations the budget is meant to allow', () => {
      // 4 stereo decks exactly fills it...
      const four: PlaneMap = {
        ...emptyMap(),
        strips: [0, 1, 2, 3].map((i) => strip({ key: `s${i}`, channel: i, element: tape(true) })),
      }
      expect(lanesUsed(four)).toBe(LANE_BUDGET)
      expect(loadMap(saveMap(four)).ok).toBe(true)

      // ...and so does 3 stereo grids + 2 mono tapes, which is the mixed case
      // the budget exists to make expressible.
      const mixed: PlaneMap = {
        ...emptyMap(),
        strips: [
          strip({ key: 'g0', channel: 0, element: { ...grid(), deck: 0 } }),
          strip({ key: 'g1', channel: 1, element: { ...grid(), deck: 1 } }),
          strip({ key: 'g2', channel: 2, element: { ...grid(), deck: 2 } }),
          strip({ key: 't0', channel: 3, element: { ...tape(false), index: 0 } }),
          strip({ key: 't1', channel: 4, element: { ...tape(false), index: 1 } }),
        ],
      }
      expect(lanesUsed(mixed)).toBe(LANE_BUDGET)
      expect(loadMap(saveMap(mixed)).ok).toBe(true)
    })

    it('refuses an overspent map with the count, rather than loading a strip that cannot sound', () => {
      const over: PlaneMap = {
        ...emptyMap(),
        strips: [0, 1, 2, 3, 4].map((i) =>
          strip({ key: `s${i}`, channel: i, element: tape(true) }),
        ),
      }
      expect(lanesUsed(over)).toBe(10)
      const r = loadMap(saveMap(over))
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toBe('laneBudget')
      expect(r.message).toContain('10')
    })
  })

  it('keeps the feedback flag distinct from an ordinary cable', () => {
    // These two routes differ ONLY in `feedback`, and that single bit is the
    // difference between zero added latency and one block of delay. A loader
    // that defaulted it would silently change how a patch sounds.
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
        {
          src: { kind: 'channelOut', index: 1, sub: null },
          dst: { kind: 'channelIn', index: 0 },
          gain: 1,
          feedback: true,
        },
      ],
    }
    const back = loadMap(saveMap(map))
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.map.routes[0]!.feedback).toBe(false)
    expect(back.map.routes[1]!.feedback).toBe(true)
  })
})

describe('the performance layer', () => {
  const perf = (over: Partial<GridPerf> = {}): GridPerf => ({
    ...defaultGridPerf(),
    ...over,
  })

  it('defaults a session this strip has never hosted', () => {
    // Not undefined: a fresh pairing starts at scene A, scheduled, empty queue.
    expect(perfFor(strip(), 'never-seen')).toEqual({
      currentScene: 'A',
      switchMode: 'scheduled',
      queuedScenes: [],
      queueLoop: false,
    })
  })

  it('remembers per (strip, SESSION) so a swap away and back restores it', () => {
    // The user's point: a strip is a SLOT, not a container. Swap A -> B -> A and
    // the scene state for A must come back, while B never inherits A's.
    let s = strip({ key: 'deck1' })
    s = rememberPerf(s, 'session-A', perf({ currentScene: 'C', queueLoop: true }))
    s = rememberPerf(s, 'session-B', perf({ currentScene: 'F' }))

    expect(perfFor(s, 'session-A').currentScene).toBe('C')
    expect(perfFor(s, 'session-A').queueLoop).toBe(true)
    expect(perfFor(s, 'session-B').currentScene).toBe('F')
    expect(perfFor(s, 'session-B').queueLoop).toBe(false) // NOT inherited from A
  })

  it('survives the round trip', () => {
    const map: PlaneMap = {
      ...emptyMap(),
      strips: [
        rememberPerf(
          strip({ element: grid() }),
          's1',
          perf({ currentScene: 'D', switchMode: 'restartImmediate', queuedScenes: ['E', 'F'], queueLoop: true }),
        ),
      ],
    }
    const back = loadMap(saveMap(map))
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.map).toEqual(map)
    expect(perfFor(back.map.strips[0]!, 's1').queuedScenes).toEqual(['E', 'F'])
  })

  it('refuses a switchMode the engine does not have', () => {
    // These three strings are scoopy's SceneUiState.switchMode. A typo here
    // would be a map that cannot be applied.
    const bad = saveMap({
      ...emptyMap(),
      strips: [rememberPerf(strip(), 's1', perf())],
    }) as unknown as { map: { strips: { sessionPerf: Record<string, GridPerf> }[] } }
    bad.map.strips[0]!.sessionPerf['s1']!.switchMode = 'teleport' as GridPerf['switchMode']
    expect(loadMap(bad).ok).toBe(false)
  })
})

describe('the v1 → v2 migration (masterLevel)', () => {
  it('defaults an old map to UNITY, because that is what it sounded like', () => {
    // v1 had no master fader, so its output was unattenuated. Defaulting to
    // anything else would change how an existing map plays the first time it
    // is opened — a migration that alters the sound is not a migration.
    const v1 = {
      schemaVersion: 1,
      savedAt: new Date().toISOString(),
      app: 'scoopy',
      map: {
        plane: { scale: 1, panX: 0, panY: 0 },
        strips: [],
        routes: [],
        transport: { masterBpm: 128 },
      },
    }
    const loaded = loadMap(v1)
    expect(loaded.ok).toBe(true)
    if (loaded.ok) {
      expect(loaded.map.transport.masterLevel).toBe(1)
      expect(loaded.map.transport.masterBpm).toBe(128)
      expect(loaded.migratedFrom).toBe(1)
    }
  })
})
