import { expect, test } from 'vitest'
import { emptyPatch, makeChannel } from '../../protocol/schema'
import { interpretRestore } from './useAutosave'
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
