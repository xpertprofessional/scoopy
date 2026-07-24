import { beforeEach, expect, test } from 'vitest'
import { emptyPatch } from '../../protocol/schema'
import { useAppStore } from './appStore'

beforeEach(() => {
  useAppStore.setState({
    shellStatus: 'disconnected',
    capabilities: null,
    deviceInfo: null,
    engineTimeSamples: 0,
    feedbackAlarm: false,
    deckStates: [],
    patch: emptyPatch(),
  })
})

test('shell status transitions through the handshake states', () => {
  const s = useAppStore.getState()
  expect(s.shellStatus).toBe('disconnected')
  s.setShellStatus('connecting')
  expect(useAppStore.getState().shellStatus).toBe('connecting')
  s.setShellStatus('connected')
  expect(useAppStore.getState().shellStatus).toBe('connected')
})

test('engine clock and feedback alarm mirror from hotframe', () => {
  const s = useAppStore.getState()
  s.setEngineTimeSamples(48000)
  s.setFeedbackAlarm(true)
  const now = useAppStore.getState()
  expect(now.engineTimeSamples).toBe(48000)
  expect(now.feedbackAlarm).toBe(true)
})

test('addChannel appends a strip with signed-decision defaults', () => {
  const next = useAppStore
    .getState()
    .addChannel('Mic', { kind: 'deviceInput', id: '0,1', name: 'Built-in' })
  expect(next.channels).toHaveLength(1)
  expect(next.channels[0]!.gain).toBe(0.75) // unity detent (D-WZ-FADER-01)
  expect(next.channels[0]!.source.kind).toBe('deviceInput')
  // The returned Patch is what the caller publishes — same as the stored one.
  expect(useAppStore.getState().patch).toEqual(next)
})

test('addDeck creates the deck AND its strip, capped at 8', () => {
  const s = useAppStore.getState()
  for (let i = 0; i < 10; i++) s.addDeck()
  const patch = useAppStore.getState().patch
  expect(patch.decks).toHaveLength(8)
  expect(patch.channels).toHaveLength(8)
  expect(patch.decks[0]!.loopEnabled).toBe(true) // Law C-3 posture: loop by default
  expect(patch.channels[0]!.source).toEqual({ kind: 'deck', id: '0', name: 'Deck 1' })
})

test('setChannelParam updates one strip without touching neighbours', () => {
  const s = useAppStore.getState()
  s.addChannel('A', { kind: 'none', id: '', name: '' })
  s.addChannel('B', { kind: 'none', id: '', name: '' })
  s.setChannelParam(1, 'gain', 0.5)
  s.setChannelParam(1, 'mute', true)
  s.setChannelParam(7, 'gain', 0.1) // out of range: no-op, no crash
  const patch = useAppStore.getState().patch
  expect(patch.channels[0]!.gain).toBe(0.75)
  expect(patch.channels[1]!.gain).toBe(0.5)
  expect(patch.channels[1]!.mute).toBe(true)
})

test('capabilities are stored from the handshake', () => {
  useAppStore.getState().setCapabilities({
    schemaVersion: 1,
    processCapture: false,
    virtualDevice: false,
    pluginHosting: false,
    fileSystem: true,
    audioDeviceSelection: false,
  })
  expect(useAppStore.getState().capabilities?.fileSystem).toBe(true)
})

test('removeChannel removes strips; deck strips only from the end', () => {
  const s = useAppStore.getState()
  s.addChannel('Mic', { kind: 'deviceInput', id: '0', name: '' })
  s.addDeck() // deck 0 + strip
  s.addDeck() // deck 1 + strip
  // Removing deck 0's strip is refused (not the highest deck id).
  let patch = useAppStore.getState().patch
  const deck0Strip = patch.channels.findIndex((c) => c.source.kind === 'deck' && c.source.id === '0')
  s.removeChannel(deck0Strip)
  patch = useAppStore.getState().patch
  expect(patch.decks).toHaveLength(2)
  // Removing deck 1 (the last) removes deck + strip.
  const deck1Strip = patch.channels.findIndex((c) => c.source.kind === 'deck' && c.source.id === '1')
  s.removeChannel(deck1Strip)
  patch = useAppStore.getState().patch
  expect(patch.decks).toHaveLength(1)
  expect(patch.channels.some((c) => c.source.id === '1' && c.source.kind === 'deck')).toBe(false)
  // Plain strips remove freely; out-of-range is a no-op.
  s.removeChannel(0)
  s.removeChannel(99)
  expect(useAppStore.getState().patch.channels.some((c) => c.name === 'Mic')).toBe(false)
})

test('a loopback strip is the one legal cycle, and arrives muted', () => {
  const next = useAppStore.getState().addLoopback(0)
  expect(next.channels).toHaveLength(1)
  const lb = next.channels[0]!
  expect(lb.source.kind).toBe('busTap')
  expect(lb.source.id).toBe('0') // main
  // MUTED by default: an unmuted unity loopback of main is an instant sustained
  // feedback path. The user unmutes deliberately, with the watchdog behind them.
  expect(lb.mute).toBe(true)
  const cue = useAppStore.getState().addLoopback(1)
  expect(cue.channels[1]!.source.id).toBe('1')
})
