/**
 * Console mode v0 (ARCHITECTURE §7.1): top bar (status + engine clock), sources
 * rail, channel rack, monitor section, deck rack. Strip mode + the routing
 * matrix overlay land in P1-09/P4. Meters and playheads render on the
 * HotSurface canvas path — never through React state.
 */
import { useAppStore } from './store/appStore'
import { useEngineLink } from './engine/useEngineLink'
import { SourcesBrowser } from './panels/SourcesBrowser'
import { ChannelRack } from './panels/ChannelRack'
import { DeckRack } from './panels/DeckRack'
import { MasterSection } from './panels/MasterSection'
import { RoutingMatrix } from './panels/RoutingMatrix'
import { TakesPanel } from './panels/TakesPanel'

const STATUS_LABEL: Record<string, string> = {
  disconnected: 'disconnected',
  connecting: 'connecting…',
  connected: 'connected',
  'no-engine': 'no engine (browser/dev)',
}

export function App() {
  const link = useEngineLink()
  const shellStatus = useAppStore((s) => s.shellStatus)
  const engineTimeSamples = useAppStore((s) => s.engineTimeSamples)
  const deviceInfo = useAppStore((s) => s.deviceInfo)

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
      </header>
      <div className="console-body">
        <SourcesBrowser link={link} />
        <ChannelRack link={link} />
        <MasterSection link={link} />
      </div>
      <DeckRack link={link} />
      <TakesPanel link={link} />
      <RoutingMatrix link={link} />
    </div>
  )
}
