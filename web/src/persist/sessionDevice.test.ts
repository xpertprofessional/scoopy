import { expect, test } from 'vitest'
import { resolveSessionDevice } from './sessionDevice'

const AVAIL = {
  inputs: ['Built-in Mic', 'Scarlett 2i2'],
  outputs: ['Built-in Output', 'Scarlett 2i2'],
  currentInput: 'Built-in Mic',
  currentOutput: 'Built-in Output',
}

test('no recorded preference changes nothing and says nothing', () => {
  const r = resolveSessionDevice({ input: '', output: '' }, AVAIL)
  expect(r).toEqual({ applyInput: '', applyOutput: '', notice: '' })
})

test('an available device is applied, silently', () => {
  const r = resolveSessionDevice({ input: 'Scarlett 2i2', output: 'Scarlett 2i2' }, AVAIL)
  expect(r.applyInput).toBe('Scarlett 2i2')
  expect(r.applyOutput).toBe('Scarlett 2i2')
  expect(r.notice).toBe('') // getting what you asked for is not news
})

test('a device already current is NOT re-applied', () => {
  const r = resolveSessionDevice({ input: 'Built-in Mic', output: 'Built-in Output' }, AVAIL)
  // Nothing to switch — avoid a pointless device re-open on every restore.
  expect(r.applyInput).toBe('')
  expect(r.applyOutput).toBe('')
  expect(r.notice).toBe('')
})

test('an ABSENT device falls back and NAMES what it wanted vs got', () => {
  const r = resolveSessionDevice({ input: 'Scarlett 2i2', output: 'Apogee Duet' }, AVAIL)
  // Never silently switch to something the session did not ask for.
  expect(r.applyOutput).toBe('')
  expect(r.notice).toContain('Apogee Duet')
  expect(r.notice).toContain('Built-in Output') // what it got
  // The input WAS available, so it still applies.
  expect(r.applyInput).toBe('Scarlett 2i2')
})

test('both sides missing are reported together, not just the first', () => {
  const r = resolveSessionDevice({ input: 'Ghost In', output: 'Ghost Out' }, AVAIL)
  expect(r.applyInput).toBe('')
  expect(r.applyOutput).toBe('')
  expect(r.notice).toContain('Ghost In')
  expect(r.notice).toContain('Ghost Out')
})

test('a missing device on a machine with no current device still reads sensibly', () => {
  const bare = { inputs: [], outputs: [], currentInput: '', currentOutput: '' }
  const r = resolveSessionDevice({ input: 'Scarlett 2i2', output: '' }, bare)
  expect(r.applyInput).toBe('')
  expect(r.notice).toContain('the default') // not an empty-quotes nonsense string
})
