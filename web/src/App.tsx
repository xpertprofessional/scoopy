/**
 * Console mode v0 (ARCHITECTURE §7.1): top bar (status + engine clock), sources
 * rail, channel rack, monitor section, deck rack. Strip mode + the routing
 * matrix overlay land in P1-09/P4. Meters and playheads render on the
 * HotSurface canvas path — never through React state.
 */
import { useAppStore } from './store/appStore'
import { useEngineLink } from './engine/useEngineLink'
import { useAutosave } from './persist/useAutosave'
import { openPackage, savePackage } from './persist/packageIo'
import { publishPatch } from './engine/usePatch'
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

const nowIso = () => new Date().toISOString()

export function App() {
  const link = useEngineLink()
  useAutosave(link, nowIso)
  const shellStatus = useAppStore((s) => s.shellStatus)
  const engineTimeSamples = useAppStore((s) => s.engineTimeSamples)
  const deviceInfo = useAppStore((s) => s.deviceInfo)
  const sessionNotice = useAppStore((s) => s.sessionNotice)

  // Package save/open. The shell owns the dialog; packageIo owns the decisions.
  const onSave = async () => {
    if (!link) return
    const store = useAppStore.getState()
    const r = await savePackage(link, store.patch, nowIso())
    if (r.notice !== '') store.setSessionNotice(r.notice)
  }
  const onOpen = async () => {
    if (!link) return
    const store = useAppStore.getState()
    const r = await openPackage(
      link,
      (p) => {
        store.setPatch(p)
        publishPatch(link, p) // opening IS a publish, same path as any edit
      },
      store.setDeckUnresolved,
      store.bumpDeckRevision,
    )
    if (r.notice !== '') useAppStore.getState().setSessionNotice(r.notice)
  }

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
        <span className="topbar-actions">
          <button type="button" onClick={() => void onOpen()} disabled={!link}>
            Open package…
          </button>
          <button type="button" onClick={() => void onSave()} disabled={!link}>
            Save package…
          </button>
        </span>
      </header>
      {sessionNotice !== '' && (
        <div className="session-notice" role="status">
          session: {sessionNotice}
        </div>
      )}
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
