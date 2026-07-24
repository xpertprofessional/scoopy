import { expect, test } from 'vitest'
import { recordChannels } from './Strip'

test('a mono input records ITS OWN channel, not a hardcoded input', () => {
  expect(recordChannels({ kind: 'deviceInput', id: '3' }, 0)).toEqual({ chan0: 3, chan1: -1 })
})

test('a stereo pair records both of its channels', () => {
  expect(recordChannels({ kind: 'deviceInput', id: '2,3' }, 0)).toEqual({ chan0: 2, chan1: 3 })
})

test('a bus tap cannot be recorded — the engine captures inputs only', () => {
  // Returning null is what makes the verb disable WITH a reason instead of
  // looking armed and doing nothing.
  expect(recordChannels({ kind: 'busTap', id: '0' }, 0)).toBeNull()
  expect(recordChannels({ kind: 'appTap', id: 'x' }, 0)).toBeNull()
})

test('a malformed input id records nothing rather than channel 0', () => {
  // Number('') is 0; a blind parse would silently capture the wrong input.
  expect(recordChannels({ kind: 'deviceInput', id: '' }, 0)).toBeNull()
  expect(recordChannels({ kind: 'deviceInput', id: 'x' }, 0)).toBeNull()
})

test('a deck strip with no named input falls back to the first input', () => {
  // Preserves what the deck rack always did, rather than regressing it.
  expect(recordChannels({ kind: 'deck', id: '0' }, 1)).toEqual({ chan0: 1, chan1: -1 })
  // ...but with no inputs at all there is nothing to fall back to.
  expect(recordChannels({ kind: 'deck', id: '0' }, null)).toBeNull()
})
