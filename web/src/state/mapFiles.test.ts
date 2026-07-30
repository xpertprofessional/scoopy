import { beforeEach, describe, expect, it } from 'vitest'
import { emptyMap, saveMap, type PlaneMap } from '../persist/mapDocument.ts'
import { listMaps, openMap, saveMapAs } from './mapFiles.ts'
import { useMapStore } from './mapStore.ts'
import type { EngineLink } from '../engineLink.ts'

/** A host that keeps maps in memory, so the round trip is real without a disk. */
function fakeHost(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed))
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const link = {
    command: (method: string, params: unknown) => {
      const p = (params ?? {}) as Partial<Record<string, string>>
      calls.push({ method, params: p })
      if (method === 'slRouteList') return Promise.resolve({ routes: [] })
      if (method !== 'slMap') return Promise.resolve({ ok: true })
      switch (p.action) {
        case 'save':
          files.set(p.name ?? '', p.json ?? '')
          return Promise.resolve({ ok: true })
        case 'open':
          return Promise.resolve(
            files.has(p.name ?? '') ? { ok: true, json: files.get(p.name ?? '') } : { ok: false },
          )
        case 'list':
          return Promise.resolve({
            ok: true,
            maps: [...files.keys()].map((name, i) => ({ name, savedAt: i })),
          })
        case 'delete':
          return Promise.resolve({ ok: files.delete(p.name ?? '') })
        default:
          return Promise.resolve({ ok: false })
      }
    },
    paramWrite: () => {},
    onHotFrame: () => () => {},
    onEvent: () => () => {},
    onUiState: () => () => {},
  } as unknown as EngineLink
  return { link, files, calls }
}

const populated = (): PlaneMap => ({
  ...emptyMap(),
  transport: { masterBpm: 174, masterLevel: 0.8 },
  strips: [
    {
      key: 'a',
      name: 'TAPE 1',
      cell: { x: 10, y: 20, w: 340, h: 196 },
      channel: 0,
      element: {
        kind: 'tape',
        index: 0,
        takeRef: '/takes/t.wav',
        stereo: false,
        loop: { enabled: true, start: 100, end: 900 },
        rate: -0.75,
        bpm: null,
        syncToMaster: false,
        tempoMode: 'timePitch' as const,
        pulseRelation: 'auto' as const,
      },
      level: 0.6,
      mute: false,
      sends: [0.2, 0, 0, 0.5],
      drive: { curve: 0, amount: 1 },
      recordArm: false,
      monitor: false,
      recordTap: null,
      sessionPerf: {},
    },
  ],
})

beforeEach(() => {
  useMapStore.setState({ map: emptyMap(), selectedKey: null, dirty: false, name: null })
})

describe('save and open', () => {
  it('round-trips a populated map through the host', async () => {
    const { link } = fakeHost()
    useMapStore.setState({ map: populated(), dirty: true })
    expect((await saveMapAs(link, 'set one')).ok).toBe(true)

    useMapStore.setState({ map: emptyMap(), name: null })
    const opened = await openMap(link, 'set one')
    expect(opened.ok).toBe(true)
    if (opened.ok) {
      // Deep equality, because a save/load that quietly drops one field is the
      // failure that only shows up on stage.
      expect(opened.map.strips[0]?.element).toEqual(populated().strips[0]?.element)
      expect(opened.map.transport).toEqual({ masterBpm: 174, masterLevel: 0.8 })
    }
  })

  it('captures the ROUTING GRAPH from the engine, not from the store', async () => {
    // The two drift the moment anything patches outside the document's view,
    // and the difference stays invisible until the reload.
    const { link, calls } = fakeHost()
    useMapStore.setState({ map: populated(), dirty: true })
    await saveMapAs(link, 'x')
    expect(calls.some((c) => c.method === 'slRouteList')).toBe(true)
  })

  it('clears `dirty` only on SUCCESS', async () => {
    // A failed save that cleared it would tell the user their work was safe
    // when it was not — the one lie a save indicator must never tell.
    const link = {
      command: (m: string) =>
        m === 'slRouteList' ? Promise.resolve({ routes: [] }) : Promise.resolve({ ok: false }),
      paramWrite: () => {},
      onHotFrame: () => () => {},
      onEvent: () => () => {},
      onUiState: () => () => {},
    } as unknown as EngineLink
    useMapStore.setState({ map: populated(), dirty: true })
    const r = await saveMapAs(link, 'doomed')
    expect(r.ok).toBe(false)
    expect(useMapStore.getState().dirty).toBe(true)
  })

  it('refuses a nameless save rather than inventing one', async () => {
    const { link, files } = fakeHost()
    expect((await saveMapAs(link, '   ')).ok).toBe(false)
    expect(files.size).toBe(0)
  })

  it('REFUSES a newer document instead of partially loading it', async () => {
    // Partially loading and re-saving destroys whatever the newer build knew.
    const future = JSON.stringify({ ...saveMap(emptyMap()), schemaVersion: 999 })
    const { link } = fakeHost({ future })
    const r = await openMap(link, 'future')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('newer version')
  })

  it('refuses a map that overspends the lane budget, with the count', async () => {
    // Loading it would leave strips the engine cannot render, with nothing on
    // screen explaining the silence.
    const over = populated()
    const stereoTape = (i: number) => ({
      key: `s${i}`,
      name: `S${i}`,
      cell: { x: 0, y: 0, w: 340, h: 196 },
      channel: i,
      element: {
        kind: 'tape' as const,
        index: i,
        takeRef: null,
        stereo: true,
        loop: { enabled: false, start: 0, end: 0 },
        rate: 1,
        bpm: null,
        syncToMaster: false,
        tempoMode: 'timePitch' as const,
        pulseRelation: 'auto' as const,
      },
      level: 1,
      mute: false,
      sends: [0, 0, 0, 0] as [number, number, number, number],
      drive: { curve: 0, amount: 1 },
      recordArm: false,
      monitor: false,
      recordTap: null,
      sessionPerf: {},
    })
    over.strips = [0, 1, 2, 3, 4].map(stereoTape) // 10 lanes, budget is 8
    const { link } = fakeHost({ big: JSON.stringify(saveMap(over)) })
    const r = await openMap(link, 'big')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('lanes')
  })

  it('reports a damaged file rather than throwing through the UI', async () => {
    const { link } = fakeHost({ junk: 'not json at all' })
    const r = await openMap(link, 'junk')
    expect(r.ok).toBe(false)
  })

  it('lists maps newest first', async () => {
    const { link } = fakeHost({ a: '{}', b: '{}', c: '{}' })
    const maps = await listMaps(link)
    expect(maps.map((m) => m.name)).toEqual(['c', 'b', 'a'])
  })
})
