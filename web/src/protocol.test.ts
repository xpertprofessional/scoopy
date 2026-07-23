import { expect, test } from 'vitest'
import {
  SCHEMA_VERSION,
  HOT_FRAME_SCALARS,
  HOT_FRAME_LENGTH,
  PARAM_IDS,
  COMMANDS,
  CapabilitiesSchema,
  CommandReplySchema,
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
