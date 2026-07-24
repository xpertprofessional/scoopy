import { expect, test } from 'vitest'
import { DEFAULT_CELL, SCHEMA_VERSION, emptyPatch, makeChannel } from '../../protocol/schema'
import { loadSession, makeSession, serializeSession } from './session'

const NOW = '2026-07-24T03:00:00Z'

function fullPatch() {
  return {
    ...emptyPatch(),
    channels: [
      makeChannel('mic', 'Mic', { kind: 'deviceInput', id: '0,1', name: 'Built-in' }),
      { ...makeChannel('lb', '↺ main', { kind: 'busTap', id: '0', name: 'main bus' }), mute: true },
      {
        ...makeChannel('d0', 'Deck 1', { kind: 'deck', id: '0', name: 'Deck 1' }),
        outBus: 3,
        pan: -0.25,
        solo: true,
      },
    ],
    decks: [
      {
        id: 0,
        name: 'Deck 1',
        loopEnabled: true,
        loopStartSample: 1000,
        loopEndSample: 48000,
        rate: -2.5, // reverse varispeed must survive verbatim
        sourcePath: '/tmp/take1.wav',
      },
    ],
  }
}

test('round-trip is deep-equal AND byte-identical on re-save (golden corpus)', () => {
  const session = makeSession(fullPatch(), NOW)
  const text = serializeSession(session)
  const loaded = loadSession(text)
  expect(loaded.ok).toBe(true)
  if (!loaded.ok) return
  expect(loaded.patch).toEqual(fullPatch()) // nothing lost, nothing invented
  // Re-serializing the same document must produce the same bytes — that is what
  // makes a golden-corpus gate meaningful.
  expect(serializeSession(makeSession(loaded.patch, NOW))).toBe(text)
})

test('a NEWER session is refused loudly, never partially loaded', () => {
  const session = makeSession(emptyPatch(), NOW)
  const text = serializeSession({ ...session, schemaVersion: SCHEMA_VERSION + 5 })
  const r = loadSession(text)
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.reason).toBe('tooNew')
  // The message must explain WHY we refuse, not just that we did.
  expect(r.message).toContain('newer Wizard')
  expect(r.message).toContain('discard')
})

test('an unknown key is a loud failure — preserve-don\'t-drop', () => {
  const session = makeSession(emptyPatch(), NOW)
  const raw = JSON.parse(serializeSession(session))
  raw.somethingNewerWizardsKnow = { important: true }
  const r = loadSession(JSON.stringify(raw))
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.reason).toBe('corrupt') // refused, NOT silently dropped on re-save
})

test('an unknown key INSIDE the patch is equally loud', () => {
  const session = makeSession(emptyPatch(), NOW)
  const raw = JSON.parse(serializeSession(session))
  raw.patch.futureField = 42
  expect(loadSession(JSON.stringify(raw)).ok).toBe(false)
})

test('corrupt input never throws — it returns a typed reason', () => {
  for (const bad of ['', 'not json', '[]', 'null', '{}', '{"schemaVersion":"x"}']) {
    const r = loadSession(bad)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message.length).toBeGreaterThan(0)
  }
})

test('an older session with no migration path fails honestly', () => {
  // v1 predates sessions existing on disk: no real user can hold one, so it is
  // refused with an explanation rather than best-effort loaded.
  const session = makeSession(emptyPatch(), NOW)
  const text = serializeSession({ ...session, schemaVersion: 1 })
  const r = loadSession(text)
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.reason).toBe('unsupported')
  expect(r.message).toContain('v1')
})

test('the envelope carries provenance for support, not for logic', () => {
  const s = makeSession(emptyPatch(), NOW)
  expect(s.schemaVersion).toBe(SCHEMA_VERSION)
  expect(s.savedAt).toBe(NOW)
  expect(s.app).toContain('Wizard')
})

// --- v15 -> v16: the PD-CANVAS plane migration (D-WZ-PDCANVAS-01) -----------

/** A pre-plane (v15) session on disk: channels have no `cell`, patch has no
    `plane`. Built as a raw object because makeChannel now emits v16 shape. */
function v15Session() {
  const mk = (key: string, name: string) => {
    const c = makeChannel(key, name, { kind: 'deviceInput', id: '0', name: 'in' })
    // strip the v16-only fields to reproduce what a v15 file actually holds
    const { cell, ...v15Channel } = c as Record<string, unknown>
    void cell
    return v15Channel
  }
  const patch = emptyPatch() as unknown as Record<string, unknown>
  delete patch.plane
  return JSON.stringify({
    schemaVersion: 15,
    savedAt: NOW,
    app: 'Wizard 0.0.1',
    patch: { ...patch, channels: [mk('a', 'Mic'), mk('b', 'Line'), mk('c', 'Tap')] },
  })
}

test('a v15 session migrates: every strip gains a cell, the patch gains a plane', () => {
  const r = loadSession(v15Session())
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.migratedFrom).toBe(15)
  // The viewport default arrived.
  expect(r.patch.plane).toEqual({ scale: 1, panX: 0, panY: 0 })
  // Every channel got a valid cell (strict parse would have failed otherwise).
  expect(r.patch.channels).toHaveLength(3)
  for (const ch of r.patch.channels) expect(ch.cell.w).toBeGreaterThan(0)
})

test('the migration AUTO-LAYS-OUT channels into a grid, deterministically', () => {
  const r = loadSession(v15Session())
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const [a, b, c] = r.patch.channels
  // First row, left to right (matches the old rack's order), same y.
  expect(a!.cell.x).toBe(0)
  expect(b!.cell.x).toBeGreaterThan(a!.cell.x)
  expect(c!.cell.x).toBeGreaterThan(b!.cell.x)
  expect(a!.cell.y).toBe(b!.cell.y)
  expect(a!.cell.y).toBe(c!.cell.y)
  // Nothing invented beyond geometry: identities and sources survive verbatim.
  expect(a!.key).toBe('a')
  expect(a!.name).toBe('Mic')
  expect(a!.source.kind).toBe('deviceInput')
})

test('a migrated session then re-saves as clean v16 (no second migration)', () => {
  const first = loadSession(v15Session())
  expect(first.ok).toBe(true)
  if (!first.ok) return
  // Re-serialize at the current version and reload: no migration, byte-stable.
  const text = serializeSession(makeSession(first.patch, NOW))
  const second = loadSession(text)
  expect(second.ok).toBe(true)
  if (!second.ok) return
  expect(second.migratedFrom).toBeUndefined() // already current
  expect(second.patch).toEqual(first.patch) // idempotent
})

test('a v16 session is RE-LAID-OUT for the horizontal strip size', () => {
  // A v16 session carries cells at the old narrow rack width. v17 made the
  // Strip horizontal, so every cell must be re-placed at the new default size —
  // otherwise player-shaped contents render inside rack-shaped boxes.
  const patch = emptyPatch() as unknown as Record<string, unknown>
  const mk = (key: string) => ({
    ...(makeChannel(key, key, { kind: 'deviceInput', id: '0', name: 'in' }) as unknown as Record<
      string,
      unknown
    >),
    cell: { x: 0, y: 0, w: 150, h: 132 }, // the OLD narrow geometry
  })
  const text = JSON.stringify({
    schemaVersion: 16,
    savedAt: NOW,
    app: 'Wizard 0.0.1',
    patch: { ...patch, channels: [mk('a'), mk('b')] },
  })

  const r = loadSession(text)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.migratedFrom).toBe(16)
  // Re-placed at the CURRENT default width, not left at 150.
  expect(r.patch.channels[0]!.cell.w).toBe(DEFAULT_CELL.w)
  expect(r.patch.channels[1]!.cell.w).toBe(DEFAULT_CELL.w)
  // Still a left-to-right row, and identities survive.
  expect(r.patch.channels[1]!.cell.x).toBeGreaterThan(r.patch.channels[0]!.cell.x)
  expect(r.patch.channels[0]!.key).toBe('a')
})

test('v18 → v19 splits MATERIAL out of source without disturbing source', () => {
  // A pre-split deck strip encoded both facts in `source`. The engine still
  // renders from source, so the migration must derive material and leave source
  // untouched — rewriting it would silence every existing deck strip.
  const patch = emptyPatch() as unknown as Record<string, unknown>
  const strip = (key: string, kind: string, id: string) => {
    const c = makeChannel(key, key, { kind: 'deviceInput', id: '0', name: 'in' }) as unknown as
      Record<string, unknown>
    const { material, ...rest } = c
    void material
    return { ...rest, source: { kind, id, name: key } }
  }
  const text = JSON.stringify({
    schemaVersion: 18,
    savedAt: NOW,
    app: 'Wizard 0.0.1',
    patch: { ...patch, channels: [strip('mic', 'deviceInput', '0'), strip('d2', 'deck', '2')] },
  })

  const r = loadSession(text)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.migratedFrom).toBe(18)

  const [mic, deck] = r.patch.channels
  // A deck strip gains material pointing at its deck...
  expect(deck!.material).toEqual({ deckId: 2 })
  // ...and its source is LEFT ALONE, so the engine still renders it.
  expect(deck!.source.kind).toBe('deck')
  expect(deck!.source.id).toBe('2')
  // A non-deck strip gets null — the honest answer, not a guess.
  expect(mic!.material).toBeNull()
  expect(mic!.source.kind).toBe('deviceInput')
})

test('a malformed deck id migrates to NO material rather than deck 0', () => {
  // Number('') is 0; a blind parse would bind an id-less strip to someone
  // else's audio.
  const patch = emptyPatch() as unknown as Record<string, unknown>
  const c = makeChannel('x', 'x', { kind: 'deviceInput', id: '0', name: 'in' }) as unknown as
    Record<string, unknown>
  const { material, ...rest } = c
  void material
  const text = JSON.stringify({
    schemaVersion: 18,
    savedAt: NOW,
    app: 'Wizard 0.0.1',
    patch: { ...patch, channels: [{ ...rest, source: { kind: 'deck', id: '', name: 'x' } }] },
  })
  const r = loadSession(text)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.patch.channels[0]!.material).toBeNull()
})

test('v19 → v20 grows strip height but PRESERVES dragged positions', () => {
  // The v16→v17 relayout was safe only because strips could not be dragged yet.
  // They can now, so a hand-made arrangement exists and must survive a size
  // change — this is the caveat v16→v17 recorded, honoured.
  const patch = emptyPatch() as unknown as Record<string, unknown>
  const c = makeChannel('a', 'a', { kind: 'deviceInput', id: '0', name: 'in' }) as unknown as
    Record<string, unknown>
  const moved = { ...c, cell: { x: 917, y: 431, w: 340, h: 196 } }
  const text = JSON.stringify({
    schemaVersion: 19,
    savedAt: NOW,
    app: 'Wizard 0.0.1',
    patch: { ...patch, channels: [moved] },
  })
  const r = loadSession(text)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const cell = r.patch.channels[0]!.cell
  expect(cell.h).toBe(DEFAULT_CELL.h) // grown
  expect(cell.x).toBe(917) // where the user put it
  expect(cell.y).toBe(431)
})

test('v20 → v21 REMOVES uiMode rather than ignoring it', () => {
  // The parse is strict, so a retired field left in place would come back as an
  // unknown key and fail the load — preserve-don't-drop firing on our own
  // dead field. The migration must delete it.
  const patch = emptyPatch() as unknown as Record<string, unknown>
  const text = JSON.stringify({
    schemaVersion: 20,
    savedAt: NOW,
    app: 'Wizard 0.0.1',
    patch: { ...patch, uiMode: 'console' },
  })
  const r = loadSession(text)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect('uiMode' in (r.patch as unknown as Record<string, unknown>)).toBe(false)
})

test('v28 -> v29 closes a monitor switch stuck open by a take', () => {
  // The stuck switch is what made ⟳ look dead on any strip that had recorded,
  // and it lived in the SESSION — so a fixed binary alone would still have
  // opened a broken document.
  const base = JSON.parse(serializeSession(makeSession(emptyPatch(), '2026-07-24T00:00:00Z')))
  const withMaterial = makeChannel('a', 'Rec', { kind: 'deviceInput', id: '0', name: 'In' })
  const without = makeChannel('b', 'Mic', { kind: 'deviceInput', id: '1', name: 'In 2' })
  base.schemaVersion = 28
  base.patch.channels = [
    { ...withMaterial, material: { deckId: 0 }, monitorSwitch: true },
    { ...without, material: null, monitorSwitch: true },
  ]
  base.patch.decks = [
    { id: 0, name: 'a', loopEnabled: true, loopStartSample: 0, loopEndSample: 0, rate: 1, sourcePath: '/t.wav' },
  ]
  const r = loadSession(JSON.stringify(base))
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.patch.channels[0]!.monitorSwitch).toBe(false) // has material: repaired
  // No material means the open switch is a deliberate "listen to my input" —
  // repairing that would break the control this migration exists to protect.
  expect(r.patch.channels[1]!.monitorSwitch).toBe(true)
})
