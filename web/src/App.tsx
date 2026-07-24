/**
 * Console mode v0 (ARCHITECTURE §7.1): top bar (status + engine clock), sources
 * rail, channel rack, monitor section, deck rack. Strip mode + the routing
 * matrix overlay land in P1-09/P4. Meters and playheads render on the
 * HotSurface canvas path — never through React state.
 */
import { useAppStore } from './store/appStore'
import { useEngineLink } from './engine/useEngineLink'
import { useAutosave } from './persist/useAutosave'
import { SourcesBrowser } from './panels/SourcesBrowser'
import { ChannelRack } from './panels/ChannelRack'
import { DeckRack } from './panels/DeckRack'
import { MasterSection } from './panels/MasterSection'
import { RoutingMatrix } from './panels/RoutingMatrix'
import { TakesPanel } from './panels/TakesPanel'
import { Plane } from './plane/Plane'
import { Settings } from './panels/Settings'

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
  const view = useAppStore((s) => s.view)
  const setView = useAppStore((s) => s.setView)

  const seconds = deviceInfo && deviceInfo.sampleRate > 0
    ? (engineTimeSamples / deviceInfo.sampleRate).toFixed(1) + ' s'
    : engineTimeSamples.toLocaleString() + ' spl'

  return (
    <div className="console">
      <header className="topbar">
        <h1>Wizard</h1>
        <span className="value" data-testid="shell-status">
          {STATUS_LABEL[shellStatus] ?? shellStatus}
        </span>
        <span className="value" data-testid="engine-time">{seconds}</span>
        <span className="view-toggle" role="group" aria-label="view">
          <button
            type="button"
            className={view === 'console' ? 'latched-accent' : ''}
            onClick={() => setView('console')}
          >
            Console
          </button>
          <button
            type="button"
            className={view === 'plane' ? 'latched-accent' : ''}
            onClick={() => setView('plane')}
          >
            Plane
          </button>
        </span>
      </header>
      {sessionNotice !== '' && (
        <div className="session-notice" role="status">
          session: {sessionNotice}
        </div>
      )}
      {view === 'console' ? (
        <>
          <div className="console-body">
            <SourcesBrowser link={link} />
            <ChannelRack link={link} />
            <MasterSection link={link} />
          </div>
          <DeckRack link={link} />
        </>
      ) : (
        <div className="console-body">
          <Plane link={link} />
          <MasterSection link={link} />
        </div>
      )}
      <TakesPanel link={link} />
      <RoutingMatrix link={link} />
      <Settings link={link} />
    </div>
  )
}
