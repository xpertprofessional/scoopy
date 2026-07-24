import { expect, test } from 'vitest'
import { emptyPatch, makeChannel } from '../../protocol/schema'
import { validatePatch } from './patchValidation'

const deck0 = {
  id: 0,
  name: 'Deck 1',
  loopEnabled: true,
  loopStartSample: 0,
  loopEndSample: 0,
  rate: 1,
  sourcePath: '',
}

test('an empty patch and a well-formed patch validate clean', () => {
  expect(validatePatch(emptyPatch())).toEqual([])
  const patch = {
    ...emptyPatch(),
    decks: [deck0],
    channels: [
      makeChannel('a', 'Mic', { kind: 'deviceInput', id: '0,1', name: 'in' }),
      makeChannel('b', 'Deck 1', { kind: 'deck', id: '0', name: 'Deck 1' }),
    ],
  }
  expect(validatePatch(patch)).toEqual([])
})

test('duplicate keys, dangling deck refs and bad input ids are refused', () => {
  const patch = {
    ...emptyPatch(),
    channels: [
      makeChannel('x', 'A', { kind: 'deviceInput', id: '0', name: '' }),
      makeChannel('x', 'B', { kind: 'deck', id: '3', name: '' }), // dup key + no deck 3
      makeChannel('y', 'C', { kind: 'deviceInput', id: '0,1,2', name: '' }), // 3 chans
    ],
  }
  const errors = validatePatch(patch)
  expect(errors.some((e) => e.includes('duplicate channel key'))).toBe(true)
  expect(errors.some((e) => e.includes('deck 3 does not exist'))).toBe(true)
  expect(errors.some((e) => e.includes('bad deviceInput id'))).toBe(true)
})

test('phase-gated kinds are refused until their backend exists', () => {
  const patch = {
    ...emptyPatch(),
    channels: [makeChannel('t', 'Spotify', { kind: 'appTap', id: 'com.spotify', name: '' })],
  }
  expect(validatePatch(patch).some((e) => e.includes('no backend yet'))).toBe(true)
})

test('degenerate deck loops are refused', () => {
  const patch = {
    ...emptyPatch(),
    decks: [{ ...deck0, loopStartSample: 100, loopEndSample: 50 }],
  }
  expect(validatePatch(patch).some((e) => e.includes('loop end before start'))).toBe(true)
})

test('a busTap is the one legal cycle — valid buses only', () => {
  const ok = {
    ...emptyPatch(),
    channels: [makeChannel('lb', 'Loopback', { kind: 'busTap', id: '0', name: 'main' })],
  }
  expect(validatePatch(ok)).toEqual([]) // main loopback is legal (P4-03)
  const cue = {
    ...emptyPatch(),
    channels: [makeChannel('lb', 'Cue loop', { kind: 'busTap', id: '1', name: 'monitor' })],
  }
  expect(validatePatch(cue)).toEqual([])
  const bad = {
    ...emptyPatch(),
    channels: [makeChannel('lb', 'Nowhere', { kind: 'busTap', id: '9', name: '' })],
  }
  expect(validatePatch(bad).some((e) => e.includes('unknown bus'))).toBe(true)
})
