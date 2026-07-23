import { beforeEach, expect, test } from 'vitest'
import { useAppStore } from './appStore'

beforeEach(() => {
  useAppStore.setState({
    shellStatus: 'disconnected',
    capabilities: null,
    engineTimeSamples: 0,
    feedbackAlarm: false,
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
