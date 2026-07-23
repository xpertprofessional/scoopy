/**
 * Root component — P0 walking skeleton. Boots the EngineLink transport, shows
 * the shell connection status and the live engine clock streaming from
 * HotFrame. The boot tone is gone (P1-04): the main meter now shows the real
 * summed main bus. The console/strip mixer surface is built out in P1-08.
 */
import { useAppStore } from './store/appStore'
import { useEngineLink } from './engine/useEngineLink'

const STATUS_LABEL: Record<string, string> = {
  disconnected: 'disconnected',
  connecting: 'connecting…',
  connected: 'connected',
  'no-engine': 'no engine (browser/dev)',
}

/** Linear amplitude → dBFS string; −∞ for silence. */
function dbfs(amp: number): string {
  if (amp <= 0) return '−∞ dB'
  return `${(20 * Math.log10(amp)).toFixed(1)} dB`
}

export function App() {
  useEngineLink()
  const shellStatus = useAppStore((s) => s.shellStatus)
  const engineTimeSamples = useAppStore((s) => s.engineTimeSamples)
  const caps = useAppStore((s) => s.capabilities)
  const mainPeakL = useAppStore((s) => s.mainPeakL)
  const mainPeakR = useAppStore((s) => s.mainPeakR)

  const peak = Math.max(mainPeakL, mainPeakR)

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
        <dt>main peak</dt>
        <dd data-testid="main-peak">{dbfs(peak)}</dd>
      </dl>
    </main>
  )
}
