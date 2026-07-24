/**
 * Monitor/master section v0: main fader (same curve family as strips), main +
 * monitor HotSurface meters, the feedback lamp (lights in P4 when the watchdog
 * engages), and the cue-availability note when the device lacks ≥4 outputs.
 */
import { HOT_FRAME_SCALARS } from '../../protocol/schema'
import type { EngineLink } from '../engine/engineLink'
import { FADER_UNITY_POSITION, faderPositionToDb } from '../engine/faderCurve'
import { usePatchActions } from '../engine/usePatch'
import { MeterCanvas } from '../hotsurface/MeterCanvas'
import { useAppStore } from '../store/appStore'

const MAIN_L = HOT_FRAME_SCALARS.indexOf('mainPeakL')
const MAIN_R = HOT_FRAME_SCALARS.indexOf('mainPeakR')
const MON_L = HOT_FRAME_SCALARS.indexOf('monitorPeakL')
const MON_R = HOT_FRAME_SCALARS.indexOf('monitorPeakR')

export function MasterSection({ link }: { link: EngineLink | null }) {
  const feedbackAlarm = useAppStore((s) => s.feedbackAlarm)
  const deviceInfo = useAppStore((s) => s.deviceInfo)
  const actions = usePatchActions(link)
  // The master level is DOCUMENT state, not component state: it was local
  // useState before, so it was forgotten on every reload.
  const mainFader = useAppStore((s) => s.patch.mainGain)

  const db = mainFader <= 0 ? '−∞' : faderPositionToDb(mainFader).toFixed(1)

  return (
    <aside className="master raised">
      <h2>Monitor</h2>
      <div className="master-meters">
        <div>
          <MeterCanvas levels={(f) => [f[MAIN_L]!, f[MAIN_R]!]} height={120} />
          <span className="value">main</span>
        </div>
        <div>
          <MeterCanvas levels={(f) => [f[MON_L]!, f[MON_R]!]} height={120} />
          <span className="value">cue</span>
        </div>
      </div>
      <input
        type="range"
        className="fader"
        min={0}
        max={1}
        step={0.001}
        value={mainFader}
        onChange={(ev) => {
          const v = Number(ev.target.value)
          actions.setMainFader(v)
        }}
        onDoubleClick={() => actions.setMainFader(FADER_UNITY_POSITION)}
      />
      <span className="value">main {db} dB</span>
      <div className={feedbackAlarm ? 'lamp lamp-on' : 'lamp'} title="feedback watchdog (P4)">
        FB
      </div>
      {deviceInfo && !deviceInfo.monitorAvailable && (
        <p className="dim">
          cue needs a ≥4-output device — monitor bus unmapped on “{deviceInfo.deviceName}”
        </p>
      )}
    </aside>
  )
}
