/**
 * Root component — P0 walking skeleton. Boots the EngineLink transport, shows
 * the shell connection status and the live engine clock streaming from
 * HotFrame. The console/strip mixer surface is built out in P1.
 */
import { useAppStore } from './store/appStore'
import { useEngineLink } from './engine/useEngineLink'

const STATUS_LABEL: Record<string, string> = {
  disconnected: 'disconnected',
  connecting: 'connecting…',
  connected: 'connected',
  'no-engine': 'no engine (browser/dev)',
}

export function App() {
  useEngineLink()
  const shellStatus = useAppStore((s) => s.shellStatus)
  const engineTimeSamples = useAppStore((s) => s.engineTimeSamples)
  const caps = useAppStore((s) => s.capabilities)

  return (
    <main>
      <h1>Wizard</h1>
      <p>The patchbay-recorder — walking skeleton.</p>
      <dl>
        <dt>shell</dt>
        <dd data-testid="shell-status">{STATUS_LABEL[shellStatus] ?? shellStatus}</dd>
        <dt>engine clock</dt>
        <dd data-testid="engine-time">{engineTimeSamples.toLocaleString()} samples</dd>
        <dt>schema</dt>
        <dd>{caps ? `v${caps.schemaVersion}` : '—'}</dd>
      </dl>
    </main>
  )
}
