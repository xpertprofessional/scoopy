import { beforeEach, expect, test } from 'vitest'
import { useAppStore } from './appStore'

beforeEach(() => {
  useAppStore.setState({
    shellStatus: 'disconnected',
    capabilities: null,
    engineTimeSamples: 0,
    feedbackAlarm: false,
    mainPeakL: 0,
    mainPeakR: 0,
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

test('engine clock, feedback alarm and main peaks mirror from hotframe', () => {
  const s = useAppStore.getState()
  s.setEngineTimeSamples(48000)
  s.setFeedbackAlarm(true)
  s.setMainPeaks(0.5, 0.25)
  const now = useAppStore.getState()
  expect(now.engineTimeSamples).toBe(48000)
  expect(now.feedbackAlarm).toBe(true)
  expect(now.mainPeakL).toBe(0.5)
  expect(now.mainPeakR).toBe(0.25)
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
