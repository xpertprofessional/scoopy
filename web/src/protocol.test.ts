import { expect, test } from 'vitest'
import {
  SCHEMA_VERSION,
  HOT_FRAME_SCALARS,
  HOT_FRAME_LENGTH,
  CHANNEL_BLOCK_FIELDS,
  DECK_BLOCK_FIELDS,
  hotFrameLength,
  channelFieldIndex,
  deckFieldIndex,
  PARAM_IDS,
  COMMANDS,
  CapabilitiesSchema,
  CommandReplySchema,
  PatchSchema,
  emptyPatch,
  makeChannel,
} from '../protocol/schema'

test('hotframe scalar map is contiguous and length matches', () => {
  expect(HOT_FRAME_LENGTH).toBe(HOT_FRAME_SCALARS.length)
  // schemaVersion must be slot 0 — the shell echoes it so a stale pairing is
  // detectable from the very first published frame.
  expect(HOT_FRAME_SCALARS[0]).toBe('schemaVersion')
  expect(new Set(HOT_FRAME_SCALARS).size).toBe(HOT_FRAME_SCALARS.length)
})

test('param ids are unique', () => {
  expect(new Set(PARAM_IDS).size).toBe(PARAM_IDS.length)
  expect(PARAM_IDS).toContain('mainGain')
})

test('ping command result schema round-trips', () => {
  const parsed = COMMANDS.ping.result.parse({ pong: true })
  expect(parsed.pong).toBe(true)
  expect(() => COMMANDS.ping.result.parse({ pong: false })).toThrow()
})

test('capabilities schema is strict and versioned', () => {
  const caps = {
    schemaVersion: SCHEMA_VERSION,
    processCapture: false,
    virtualDevice: false,
    pluginHosting: false,
    fileSystem: true,
    audioDeviceSelection: true,
  }
  expect(CapabilitiesSchema.parse(caps).schemaVersion).toBe(SCHEMA_VERSION)
  // Unknown key = loud failure (preserve-don't-drop law).
  expect(() => CapabilitiesSchema.parse({ ...caps, extra: 1 })).toThrow()
})

test('command reply envelope accepts ok and error shapes', () => {
  expect(CommandReplySchema.parse({ id: 0, ok: true, result: {} }).ok).toBe(true)
  expect(CommandReplySchema.parse({ id: 1, ok: false, error: 'nope' }).ok).toBe(false)
})

test('hotframe block offsets: decks follow all channel blocks', () => {
  // 3 channels + 2 decks
  expect(hotFrameLength(3, 2)).toBe(
    HOT_FRAME_LENGTH + 3 * CHANNEL_BLOCK_FIELDS.length + 2 * DECK_BLOCK_FIELDS.length,
  )
  expect(channelFieldIndex(0, 'peakL')).toBe(HOT_FRAME_LENGTH)
  expect(channelFieldIndex(2, 'srcDriftPpm')).toBe(
    HOT_FRAME_LENGTH + 2 * CHANNEL_BLOCK_FIELDS.length + CHANNEL_BLOCK_FIELDS.indexOf('srcDriftPpm'),
  )
  expect(deckFieldIndex(3, 1, 'playhead')).toBe(
    HOT_FRAME_LENGTH +
      3 * CHANNEL_BLOCK_FIELDS.length +
      1 * DECK_BLOCK_FIELDS.length +
      DECK_BLOCK_FIELDS.indexOf('playhead'),
  )
  // With zero blocks the frame is exactly the scalar section (P0 compatibility).
  expect(hotFrameLength(0, 0)).toBe(HOT_FRAME_LENGTH)
})

test('Patch schema: empty patch validates; unknown key fails loudly', () => {
  const p = emptyPatch()
  expect(PatchSchema.parse(p).schemaVersion).toBe(SCHEMA_VERSION)
  expect(() => PatchSchema.parse({ ...p, mystery: 1 })).toThrow() // preserve-don't-drop
})

test('a strip carries its output bus; bus 0 is main (P4-10)', () => {
  const ch = makeChannel('c', 'x', { kind: 'none', id: '', name: '' })
  expect(ch.outBus).toBe(0) // main by default — no separate main path exists
  const patch = { ...emptyPatch(), channels: [{ ...ch, outBus: 7 }] }
  expect(PatchSchema.parse(patch).channels[0]!.outBus).toBe(7)
  // Out-of-range buses are refused at the boundary, not clamped silently.
  expect(() => PatchSchema.parse({ ...emptyPatch(), channels: [{ ...ch, outBus: 8 }] })).toThrow()
  expect(() => PatchSchema.parse({ ...emptyPatch(), channels: [{ ...ch, outBus: -1 }] })).toThrow()
})

test('makeChannel defaults follow the signed decisions', () => {
  const ch = makeChannel('ch-1', 'Mic', { kind: 'deviceInput', id: '0,1', name: 'Built-in' })
  expect(ch.gain).toBe(0.75) // unity detent (D-WZ-FADER-01)
  expect(ch.pan).toBe(0)
  expect(ch.sends).toEqual([0, 0, 0, 0]) // reserved until P6
  expect(ch.inserts).toEqual(['', '', '', ''])
  const patch = { ...emptyPatch(), channels: [ch] }
  expect(PatchSchema.parse(patch).channels).toHaveLength(1)
})

test('Patch rejects out-of-range strips and too many decks', () => {
  const ch = makeChannel('c', 'x', { kind: 'none', id: '', name: '' })
  expect(() => PatchSchema.parse({ ...emptyPatch(), channels: [{ ...ch, pan: 2 }] })).toThrow()
  const deck = (id: number) => ({
    id,
    name: `d${id}`,
    loopEnabled: false,
    loopStartSample: 0,
    loopEndSample: 0,
    rate: 1,
    sourcePath: '',
  })
  const nine = Array.from({ length: 9 }, (_, i) => deck(Math.min(i, 7)))
  expect(() => PatchSchema.parse({ ...emptyPatch(), decks: nine })).toThrow() // max 8
})
