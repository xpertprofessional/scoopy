import { expect, test } from 'vitest'
import { SCHEMA_VERSION, emptyPatch, makeChannel } from '../../protocol/schema'
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
