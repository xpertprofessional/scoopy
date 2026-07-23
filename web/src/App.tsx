/**
 * Root component — P0 walking skeleton. Boots the EngineLink transport, shows
 * the shell connection status and the live engine clock streaming from
 * HotFrame, and offers a boot-tone toggle whose signal moves the main meter —
 * proving the whole device→engine→meter→UI path. The console/strip mixer
 * surface is built out in P1.
 */
import { useState } from 'react'
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
  const link = useEngineLink()
  const shellStatus = useAppStore((s) => s.shellStatus)
  const engineTimeSamples = useAppStore((s) => s.engineTimeSamples)
  const caps = useAppStore((s) => s.capabilities)
  const mainPeakL = useAppStore((s) => s.mainPeakL)
  const mainPeakR = useAppStore((s) => s.mainPeakR)
  const [tone, setTone] = useState(false)

  const toggleTone = () => {
    const next = !tone
    setTone(next)
    void link?.command('setTestTone', { enabled: next })
  }

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
      <button type="button" onClick={toggleTone} disabled={!link}>
        {tone ? 'Stop boot tone' : 'Play boot tone'}
      </button>
    </main>
  )
}
