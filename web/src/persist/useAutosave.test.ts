import { expect, test } from 'vitest'
import { emptyPatch, makeChannel } from '../../protocol/schema'
import { interpretRestore, rehydrateDecks } from './useAutosave'
import type { EngineLink } from '../engine/engineLink'
import { makeSession, serializeSession } from './session'

const NOW = '2026-07-24T03:00:00Z'

function goodText() {
  const patch = {
    ...emptyPatch(),
    channels: [makeChannel('a', 'Mic', { kind: 'deviceInput', id: '0', name: 'in' })],
  }
  return serializeSession(makeSession(patch, NOW))
}

test('a good primary session restores', () => {
  const r = interpretRestore(goodText(), 'primary')
  expect(r.restored).toBe(true)
  expect(r.source).toBe('primary')
  expect(r.problem).toBe('') // nothing to report
  expect(r.patch?.channels).toHaveLength(1)
})

test('restoring from the BACKUP says so rather than pretending', () => {
  const r = interpretRestore(goodText(), 'backup')
  expect(r.restored).toBe(true)
  expect(r.source).toBe('backup')
  // The user must know they are one file behind — silently restoring the backup
  // would hide that the newest edits were lost.
  expect(r.problem).toContain('backup')
})

test('no session at all is not a problem, just an empty start', () => {
  const r = interpretRestore('', 'none')
  expect(r.restored).toBe(false)
  expect(r.problem).toBe('') // a first launch must not look like a failure
  expect(r.patch).toBeUndefined()
})

test('an unreadable session REPORTS why instead of starting silently empty', () => {
  const r = interpretRestore('{ this is not json', 'primary')
  expect(r.restored).toBe(false)
  expect(r.problem.length).toBeGreaterThan(0) // the whole point of the feature
  expect(r.patch).toBeUndefined()
})

test('a session from a newer Wizard reports the refusal, not a blank window', () => {
  const s = JSON.parse(goodText())
  s.schemaVersion = 9999
  const r = interpretRestore(JSON.stringify(s), 'primary')
  expect(r.restored).toBe(false)
  expect(r.problem).toContain('newer Wizard')
})

test('whitespace-only content counts as no session', () => {
  expect(interpretRestore('   \n', 'primary').problem).toBe('')
  expect(interpretRestore('   \n', 'primary').restored).toBe(false)
})

function deck(id: number, sourcePath: string) {
  return {
    id,
    name: `Deck ${id + 1}`,
    loopEnabled: true,
    loopStartSample: 0,
    loopEndSample: 0,
    rate: 1,
    sourcePath,
  }
}

/** A link whose deckLoadTake succeeds only for paths in `present`. */
function fakeLink(present: string[]): EngineLink {
  return {
    command: (async (_m: string, p: { path?: string }) => ({
      ok: present.includes(p.path ?? ''),
      channels: 1,
      engineFrames: 100,
      error: '',
    })) as unknown as EngineLink['command'],
    paramWrite: () => {},
    onHotFrame: () => () => {},
  }
}

test('restore rehydrates deck audio from its references', async () => {
  const patch = { ...emptyPatch(), decks: [deck(0, '/takes/a.wav'), deck(1, '/takes/b.wav')] }
  const marks: Array<[number, boolean]> = []
  const bumped: number[] = []
  const missing = await rehydrateDecks(
    fakeLink(['/takes/a.wav', '/takes/b.wav']),
    patch,
    (d, u) => marks.push([d, u]),
    (d) => bumped.push(d),
  )
  expect(missing).toBe(0)
  expect(marks).toEqual([[0, false], [1, false]])
  expect(bumped).toEqual([0, 1]) // both waveforms refetch
})

test('a missing take leaves its deck IN PLACE, marked — never dropped', async () => {
  const patch = { ...emptyPatch(), decks: [deck(0, '/takes/gone.wav'), deck(1, '/takes/here.wav')] }
  const marks: Array<[number, boolean]> = []
  const missing = await rehydrateDecks(
    fakeLink(['/takes/here.wav']),
    patch,
    (d, u) => marks.push([d, u]),
    () => {},
  )
  expect(missing).toBe(1)
  expect(marks).toContainEqual([0, true]) // marked unresolved
  expect(marks).toContainEqual([1, false])
  // The DOCUMENT is untouched: the reference survives, so restoring the file
  // brings the deck back (preserve-don't-drop).
  expect(patch.decks[0]!.sourcePath).toBe('/takes/gone.wav')
})

test('an empty deck is not an unresolved deck', async () => {
  const patch = { ...emptyPatch(), decks: [deck(0, '')] }
  const marks: Array<[number, boolean]> = []
  const missing = await rehydrateDecks(fakeLink([]), patch, (d, u) => marks.push([d, u]), () => {})
  expect(missing).toBe(0) // never recorded into ≠ lost its audio
  expect(marks).toEqual([[0, false]])
})
