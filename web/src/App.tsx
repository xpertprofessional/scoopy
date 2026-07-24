/**
 * Wizard — the map is the app (PD-MERGE §1).
 *
 * Four surfaces and no more: the MAP (every Strip lives there), the MASTER strip
 * beside it, and the ROUTING MATRIX and SETTINGS summoned below. The console —
 * sources rail, channel rack, deck rack, takes panel — is deleted, not hidden:
 * everything it did now happens on a Strip or in Settings.
 *
 * Meters and playheads render on the HotSurface canvas path, never through
 * React state.
 */
import { useAppStore } from './store/appStore'
import { useEngineLink } from './engine/useEngineLink'
import { useAutosave } from './persist/useAutosave'
import { MasterSection } from './panels/MasterSection'
import { RoutingMatrix } from './panels/RoutingMatrix'
import { Settings } from './panels/Settings'
import { Plane } from './plane/Plane'
import { Inspector } from './plane/Inspector'

const STATUS_LABEL: Record<string, string> = {
  disconnected: 'disconnected',
  connecting: 'connecting…',
  connected: 'connected',
  'no-engine': 'no engine (browser/dev)',
}

const nowIso = () => new Date().toISOString()

export function App() {
  const link = useEngineLink()
  useAutosave(link, nowIso)
  const shellStatus = useAppStore((s) => s.shellStatus)
  const engineTimeSamples = useAppStore((s) => s.engineTimeSamples)
  const deviceInfo = useAppStore((s) => s.deviceInfo)
  const sessionNotice = useAppStore((s) => s.sessionNotice)

  const seconds =
    deviceInfo && deviceInfo.sampleRate > 0
      ? (engineTimeSamples / deviceInfo.sampleRate).toFixed(1) + ' s'
      : engineTimeSamples.toLocaleString() + ' spl'

  return (
    <div className="console">
      <header className="topbar">
        <h1>Wizard</h1>
        <span className="value" data-testid="shell-status">
          {STATUS_LABEL[shellStatus] ?? shellStatus}
        </span>
        <span className="value" data-testid="engine-time">
          {seconds}
        </span>
      </header>
      {/* Loud, unmissable failure states. These were silent before: with no
          bridge the whole app looked like a styling problem, and with no input
          device every Strip was inert for no stated reason. Silence with no
          explanation is the worst outcome this app can produce. */}
      {shellStatus !== 'connected' && (
        <div className="banner banner-bad" role="alert">
          {shellStatus === 'no-engine'
            ? 'NOT CONNECTED to the audio engine — nothing on this page can make or record sound. (Are you running the built app, not a browser?)'
            : 'connecting to the audio engine…'}
        </div>
      )}
      {shellStatus === 'connected' && deviceInfo && deviceInfo.error !== '' && (
        <div className="banner banner-bad" role="alert">
          audio device: {deviceInfo.error}
        </div>
      )}
      {shellStatus === 'connected' && deviceInfo && deviceInfo.inputs.length === 0 && (
        <div className="banner banner-warn" role="status">
          No audio INPUTS available{deviceInfo.inputDeviceName ? ` on “${deviceInfo.inputDeviceName}”` : ''} —
          strips cannot record or show input level. Pick an input device in Settings.
        </div>
      )}
      {sessionNotice !== '' && (
        <div className="session-notice" role="status">
          session: {sessionNotice}
        </div>
      )}
      <div className="console-body">
        <Plane link={link} />
        <Inspector link={link} />
        <MasterSection link={link} />
      </div>
      <RoutingMatrix link={link} />
      <Settings link={link} />
    </div>
  )
}
