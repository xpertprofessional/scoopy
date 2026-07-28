import { describe, expect, it } from 'vitest'
import { emptyMap, saveMap, type PlaneMap, type Strip } from './mapDocument.ts'
import { MAP_ENTRY, TAKES_DIR, packMap, referencedTakes, unpackMap } from './mapPackage.ts'
import { zipSync } from 'fflate'

const tapeStrip = (key: string, channel: number, takeRef: string | null): Strip => ({
  key,
  name: key.toUpperCase(),
  cell: { x: 0, y: 0, w: 340, h: 196 },
  channel,
  element: {
    kind: 'tape',
    index: channel,
    takeRef,
    stereo: false,
    loop: { enabled: true, start: 0, end: 1000 },
    rate: 1,
    bpm: null,
    syncToMaster: false,
    tempoMode: 'timePitch',
    pulseRelation: 'auto',
  },
  level: 1,
  mute: false,
  sends: [0, 0, 0, 0],
  recordArm: false,
  monitor: false,
  recordTap: null,
  sessionPerf: {},
})

const withTakes = (refs: Array<string | null>): PlaneMap => ({
  ...emptyMap(),
  strips: refs.map((r, i) => tapeStrip(`s${i}`, i, r)),
})

const audio = (n: number) => new Uint8Array([n, n + 1, n + 2, n + 3])

describe('collect-on-export', () => {
  it('copies every referenced take in and REWRITES the refs to point inside', () => {
    // Without the rewrite the document still names the old absolute paths and
    // the collected audio is dead weight — bigger AND still broken.
    const map = withTakes(['/takes/a.wav', '/takes/b.wav'])
    const r = packMap(map, (ref) => (ref.endsWith('a.wav') ? audio(1) : audio(9)))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.collected).toBe(2)

    const back = unpackMap(r.bytes)
    expect(back.ok).toBe(true)
    if (!back.ok) return
    const refs = back.map.strips.map((s) => (s.element.kind === 'tape' ? s.element.takeRef : null))
    expect(refs).toEqual([`${TAKES_DIR}a.wav`, `${TAKES_DIR}b.wav`])
    expect(back.takes.get('a.wav')).toEqual(audio(1))
    expect(back.takes.get('b.wav')).toEqual(audio(9))
  })

  it('de-duplicates a take two strips share', () => {
    // One take underlies a scrubbable tape AND any grid track carved from it,
    // so a naive walk would collect the same file twice.
    const map = withTakes(['/takes/same.wav', '/takes/same.wav'])
    expect(referencedTakes(map)).toEqual(['/takes/same.wav'])
    const r = packMap(map, () => audio(2))
    if (r.ok) expect(r.collected).toBe(1)
  })

  it('REPORTS a take it could not read instead of silently omitting it', () => {
    // A package quietly short one file fails on the other machine, at the worst
    // moment, with no way to know what went missing.
    const map = withTakes(['/takes/here.wav', '/takes/gone.wav'])
    const r = packMap(map, (ref) => (ref.endsWith('here.wav') ? audio(3) : null))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.collected).toBe(1)
    expect(r.missing).toEqual(['/takes/gone.wav'])
    // …and it still packs, because an incomplete package beats none and the
    // strip will say "audio missing" honestly.
    expect(unpackMap(r.bytes).ok).toBe(true)
  })

  it('packs a map with no takes at all', () => {
    const r = packMap(withTakes([null, null]), () => null)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.collected).toBe(0)
  })

  it('preserves everything else about the document', () => {
    const map: PlaneMap = {
      ...withTakes(['/takes/a.wav']),
      transport: { masterBpm: 174, masterLevel: 0.7 },
      routes: [
        {
          src: { kind: 'channelOut', index: 0, sub: null },
          dst: { kind: 'channelIn', index: 1 },
          gain: 0.5,
          feedback: true,
        },
      ],
    }
    const r = packMap(map, () => audio(4))
    if (!r.ok) return
    const back = unpackMap(r.bytes)
    if (!back.ok) return
    expect(back.map.transport).toEqual({ masterBpm: 174, masterLevel: 0.7 })
    expect(back.map.routes[0]?.feedback).toBe(true)
    expect(back.map.routes[0]?.gain).toBe(0.5)
  })
})

describe('unpacking is forgiving of how a package was made', () => {
  it('tolerates a Finder-zipped folder and its __MACOSX tree', () => {
    // Zip the folder and mail it is the one workflow a user without the export
    // button actually has.
    const inner = packMap(withTakes(['/takes/a.wav']), () => audio(5))
    if (!inner.ok) return
    const doc = unpackMap(inner.bytes)
    if (!doc.ok) return

    const wrapped = zipSync(
      {
        [`My Set/${MAP_ENTRY}`]: new TextEncoder().encode(JSON.stringify(saveMap(doc.map))),
        [`My Set/${TAKES_DIR}a.wav`]: audio(5),
        '__MACOSX/._My Set': new Uint8Array([0]),
      },
      { level: 0 },
    )
    const back = unpackMap(wrapped)
    expect(back.ok).toBe(true)
    if (back.ok) expect(back.takes.get('a.wav')).toEqual(audio(5))
  })

  it('does NOT strip a folder unless every entry shares it', () => {
    // Otherwise a package whose takes sit in a directory named like the map
    // would lose its document.
    const inner = packMap(withTakes([null]), () => null)
    if (!inner.ok) return
    const doc = unpackMap(inner.bytes)
    if (!doc.ok) return
    const mixed = zipSync(
      {
        [MAP_ENTRY]: new TextEncoder().encode(JSON.stringify(saveMap(doc.map))),
        'Elsewhere/note.txt': new Uint8Array([1]),
      },
      { level: 0 },
    )
    expect(unpackMap(mixed).ok).toBe(true)
  })

  it('refuses a package with no map in it', () => {
    const r = unpackMap(zipSync({ 'readme.txt': new Uint8Array([1]) }, { level: 0 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain(MAP_ENTRY)
  })

  it('refuses something that is not a zip at all', () => {
    expect(unpackMap(new Uint8Array([1, 2, 3, 4])).ok).toBe(false)
  })

  it('REFUSES a package carrying a newer map — a package is not a way around the version discipline', () => {
    const future = zipSync(
      {
        [MAP_ENTRY]: new TextEncoder().encode(
          JSON.stringify({ ...saveMap(emptyMap()), schemaVersion: 999 }),
        ),
      },
      { level: 0 },
    )
    const r = unpackMap(future)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('newer')
  })
})
