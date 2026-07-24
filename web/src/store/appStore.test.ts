import { beforeEach, expect, test } from 'vitest'
import { validatePatch } from '../engine/patchValidation'
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

test('material is attached to an existing strip, capped at 8 decks', () => {
  // There is no "create a deck" gesture any more: a strip GAINS material. The
  // 9th strip to record finds no deck free and is told so, rather than a ninth
  // deck appearing behind the engine's ceiling.
  const s = useAppStore.getState()
  for (let i = 0; i < 10; i++) s.addChannel(`s${i}`, { kind: 'none', id: '', name: '' })
  const ids = Array.from({ length: 10 }, (_, i) => s.attachDeck(i).deckId)
  expect(ids.slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  expect(ids.slice(8)).toEqual([-1, -1])
  const patch = useAppStore.getState().patch
  expect(patch.decks).toHaveLength(8)
  expect(patch.channels).toHaveLength(10) // the strips exist either way
  expect(patch.decks[0]!.loopEnabled).toBe(true) // Law C-3 posture: loop by default
  expect(patch.channels[0]!.material).toEqual({ deckId: 0 })
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

test('removeChannel frees the deck of a strip WITH MATERIAL, last one first', () => {
  const s = useAppStore.getState()
  s.addChannel('Mic', { kind: 'deviceInput', id: '0', name: '' })
  s.addChannel('A', { kind: 'deviceInput', id: '0', name: '' })
  s.addChannel('B', { kind: 'deviceInput', id: '1', name: '' })
  s.attachDeck(1) // deck 0
  s.attachDeck(2) // deck 1
  // These strips still LISTEN to their inputs — material is what owns the deck.
  // Keying off source.kind (as this once did) leaked the deck of every strip
  // that had recorded, until all 8 were gone and recording silently failed.
  expect(useAppStore.getState().patch.channels[1]!.source.kind).toBe('deviceInput')

  s.removeChannel(1) // deck 0 is not the highest: refused
  expect(useAppStore.getState().patch.decks).toHaveLength(2)

  s.removeChannel(2) // deck 1 is the last: strip and deck both go
  let patch = useAppStore.getState().patch
  expect(patch.decks).toHaveLength(1)
  expect(patch.channels.some((c) => c.name === 'B')).toBe(false)

  // Strips without material remove freely; out-of-range is a no-op.
  s.removeChannel(0)
  s.removeChannel(99)
  patch = useAppStore.getState().patch
  expect(patch.channels.some((c) => c.name === 'Mic')).toBe(false)
  expect(patch.decks).toHaveLength(1)
})

test('a strip listening to a bus is the one legal cycle, and arrives muted', () => {
  const s = useAppStore.getState()
  // Not a separate creation path any more — the same addChannel every strip uses.
  const next = s.addChannel('↺ main', { kind: 'busTap', id: '0', name: 'main bus' })
  expect(next.channels).toHaveLength(1)
  const lb = next.channels[0]!
  expect(lb.source.kind).toBe('busTap')
  expect(lb.source.id).toBe('0') // main
  // MUTED by default: an unmuted unity loopback of main is an instant sustained
  // feedback path. The user unmutes deliberately, with the watchdog behind them.
  expect(lb.mute).toBe(true)
  const cue = s.addChannel('↺ cue', { kind: 'busTap', id: '1', name: 'cue bus' })
  expect(cue.channels[1]!.source.id).toBe('1')
})

test('a restored session never has its keys reused by the next strip', () => {
  // THE INERT-APP BUG: the key counter restarted at 1 each launch, so the first
  // strip added after a restore took a `ch-1` the document already had.
  // validatePatch refuses a duplicate key, so from then on EVERY publish was
  // refused — the engine held no world, and nothing played or recorded.
  const s = useAppStore.getState()
  s.addChannel('A', { kind: 'none', id: '', name: '' })
  s.addChannel('B', { kind: 'none', id: '', name: '' })
  const restored = useAppStore.getState().patch
  useAppStore.setState({ patch: { ...restored, channels: [] } })
  s.setPatch(restored) // what restore does

  s.addChannel('C', { kind: 'none', id: '', name: '' })
  const keys = useAppStore.getState().patch.channels.map((c) => c.key)
  expect(new Set(keys).size).toBe(keys.length)
  expect(validatePatch(useAppStore.getState().patch)).toEqual([])
})
