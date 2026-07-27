import { describe, expect, it } from 'vitest'

import {
  alignmentSamples,
  alignmentSeconds,
  buildLibrary,
  parseSidecar,
  referencedTakeIds,
  resolveTake,
  takeSeconds,
  unreferencedTakes,
  type Take,
} from './takeLibrary'

/**
 * BYTE SAMPLE, copied verbatim from the printf in
 * `host/src/WavWriter.cpp::writeSidecar` (merged repo). This is the pin on a
 * hand-mirrored boundary: the sidecar has no schema to generate from, so if the
 * C++ side renames a field this test fails instead of the parser silently
 * returning nothing for every take in the library.
 */
const REAL_SIDECAR = `{
  "deckId": 2,
  "startEngineSample": 480000,
  "wallClock": "2026-07-25T18:30:00Z",
  "sourceDesc": "Built-in Mic 1",
  "sampleRate": 48000.000000,
  "channels": 1,
  "frames": 96000
}
`

const take = (over: Partial<Take> = {}): Take => ({
  id: 'take_0001',
  path: '/Takes/deck1_1000.wav',
  deckId: 0,
  startEngineSample: 0,
  wallClock: '2026-07-25T18:00:00Z',
  sourceDesc: 'Mic',
  sampleRate: 48000,
  channels: 1,
  frames: 48000,
  ...over,
})

describe('sidecar parsing', () => {
  it('parses exactly what the C++ writer emits', () => {
    const r = parseSidecar(JSON.parse(REAL_SIDECAR))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sidecar).toEqual({
      deckId: 2,
      startEngineSample: 480000,
      wallClock: '2026-07-25T18:30:00Z',
      sourceDesc: 'Built-in Mic 1',
      sampleRate: 48000,
      channels: 1,
      frames: 96000,
    })
  })

  it('survives the escaping the writer applies to sourceDesc', () => {
    // writeSidecar escapes " and \ and turns newlines into \n — the only
    // free-text field, and the only one that can break the document.
    const raw = JSON.parse('{"deckId":0,"startEngineSample":0,"wallClock":"t",' +
      '"sourceDesc":"a \\"quoted\\" \\\\ path\\nline2","sampleRate":48000,"channels":2,"frames":10}')
    const r = parseSidecar(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.sidecar.sourceDesc).toBe('a "quoted" \\ path\nline2')
  })

  it('reports WHY a bad sidecar failed instead of skipping it', () => {
    // A take whose sidecar is corrupt must surface as a broken take, not as a
    // take that quietly ceased to exist.
    const r = parseSidecar({ deckId: 0 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason.length).toBeGreaterThan(0)
  })

  it('rejects an unknown field rather than ignoring it', () => {
    const raw = { ...JSON.parse(REAL_SIDECAR), somethingNew: 1 }
    expect(parseSidecar(raw).ok).toBe(false)
  })

  it('rejects a negative stamp — the clock is monotonic from zero', () => {
    const raw = { ...JSON.parse(REAL_SIDECAR), startEngineSample: -1 }
    expect(parseSidecar(raw).ok).toBe(false)
  })
})

describe('Law C-2 alignment', () => {
  it('offsets two takes by the exact sample gap', () => {
    // The payoff for one monotonic clock: drop both at 0:00 in a DAW, offset
    // each by this, and the session reproduces.
    const a = take({ id: 'a', startEngineSample: 480000 })
    const b = take({ id: 'b', startEngineSample: 528000 }) // 1 s later at 48k
    expect(alignmentSamples(b, a)).toBe(48000)
    expect(alignmentSeconds(b, a)).toBeCloseTo(1.0, 9)
  })

  it('is signed — the origin need not be the earliest take', () => {
    const a = take({ startEngineSample: 480000 })
    const b = take({ startEngineSample: 240000 })
    expect(alignmentSamples(b, a)).toBe(-240000)
  })

  it('aligns a take against itself at zero', () => {
    const a = take({ startEngineSample: 12345 })
    expect(alignmentSamples(a, a)).toBe(0)
  })

  it('does not divide by a zero rate', () => {
    const a = take({ startEngineSample: 100, sampleRate: 0 as unknown as number })
    expect(alignmentSeconds(a, take({ startEngineSample: 0 }))).toBe(0)
    expect(takeSeconds({ frames: 100, sampleRate: 0 })).toBe(0)
  })

  it('reports duration from frames and rate', () => {
    expect(takeSeconds({ frames: 96000, sampleRate: 48000 })).toBe(2)
  })
})

describe('the library', () => {
  it('resolves a reference to its take', () => {
    const lib = buildLibrary([take({ id: 'take_0003' })])
    const r = resolveTake(lib, 'take_0003')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.take.path).toBe('/Takes/deck1_1000.wav')
  })

  it('reports a missing take WITHOUT losing the reference', () => {
    // "audio missing" keeps the strip, the reference and the record button —
    // recording over a dead reference is a repair. Dropping the ref would
    // destroy the only record of what the strip was meant to play.
    const r = resolveTake(buildLibrary([]), 'take_0009')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.ref).toBe('take_0009')
  })

  it('collects the take ids a map still refers to', () => {
    const strips = [
      { element: { kind: 'tape', takeRef: 'take_0001' } },
      { element: { kind: 'tape', takeRef: null } }, // armed but never recorded
      { element: { kind: 'grid' } },
      { element: { kind: 'none' } },
      { element: { kind: 'tape', takeRef: 'take_0002' } },
    ]
    expect(referencedTakeIds(strips)).toEqual(new Set(['take_0001', 'take_0002']))
  })

  it('counts ONE take referenced twice only once', () => {
    // The carve invariant: a scrubbable tape and a grid track carved from it
    // point at the SAME take, which is what stops a session duplicating audio.
    const strips = [
      { element: { kind: 'tape', takeRef: 'take_0001' } },
      { element: { kind: 'tape', takeRef: 'take_0001' } },
    ]
    expect(referencedTakeIds(strips).size).toBe(1)
  })

  it('lists unreferenced takes as RECLAIMABLE, not as garbage', () => {
    // A carve frees the tape LAYER while the full take stays in the library on
    // purpose, so "unreferenced" means "not currently loaded" — it may be
    // exactly what the user reloads next. This list is for showing, never for
    // deleting behind their back.
    const lib = buildLibrary([take({ id: 'a' }), take({ id: 'b' }), take({ id: 'c' })])
    const loose = unreferencedTakes(lib, new Set(['b']))
    expect(loose.map((t) => t.id).sort()).toEqual(['a', 'c'])
  })
})
