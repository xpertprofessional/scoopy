/**
 * Channel rack v0: one strip per Patch channel. Fader (unity detent at 0.75,
 * D-WZ-FADER-01), pan, mute/solo, cue assign, and a HotSurface meter fed from
 * the strip's HotFrame block. Fixed strip width (Scoopy's learned constraint:
 * no resize on state change). Kind accent from the Wizard-local token group.
 */
import { channelFieldIndex } from '../../protocol/schema'
import type { EngineLink } from '../engine/engineLink'
import { FADER_UNITY_POSITION, faderPositionToDb } from '../engine/faderCurve'
import { usePatchActions } from '../engine/usePatch'
import { MeterCanvas } from '../hotsurface/MeterCanvas'
import { useAppStore } from '../store/appStore'

const KIND_VAR: Record<string, string> = {
  deviceInput: 'var(--chan-device)',
  appTap: 'var(--chan-app-tap)',
  deck: 'var(--chan-deck)',
  virtualDeviceInput: 'var(--chan-virtual)',
  busTap: 'var(--chan-bus)',
  none: 'var(--chan-bus)',
}

function faderLabel(position: number): string {
  if (position <= 0) return '−∞'
  const db = faderPositionToDb(position)
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`
}

export function ChannelRack({ link }: { link: EngineLink | null }) {
  const channels = useAppStore((s) => s.patch.channels)
  const actions = usePatchActions(link)

  return (
    <section className="rack">
      {channels.map((ch, i) => (
        <div className="strip raised" key={ch.key}>
          <div className="strip-head">
            <div className="strip-name" style={{ color: KIND_VAR[ch.source.kind] }}>
              {ch.name}
            </div>
            <button
              type="button"
              className="strip-remove"
              title="remove strip"
              onClick={() => actions.removeStrip(i)}
            >
              ×
            </button>
          </div>
          <div className="strip-body">
            <div className="fader-col">
              <input
                type="range"
                className="fader"
                min={0}
                max={1}
                step={0.001}
                value={ch.gain}
                onChange={(ev) => actions.setFader(i, Number(ev.target.value))}
                onDoubleClick={() => actions.setFader(i, FADER_UNITY_POSITION)}
              />
              <span className="value">{faderLabel(ch.gain)}</span>
            </div>
            <MeterCanvas
              levels={(frame) => {
                const li = channelFieldIndex(i, 'peakL')
                const ri = channelFieldIndex(i, 'peakR')
                return frame.length > ri ? [frame[li]!, frame[ri]!] : null
              }}
            />
          </div>
          <input
            type="range"
            className="pan"
            min={-1}
            max={1}
            step={0.01}
            value={ch.pan}
            onChange={(ev) => actions.setPan(i, Number(ev.target.value))}
            onDoubleClick={() => actions.setPan(i, 0)}
            title={`pan ${ch.pan.toFixed(2)}`}
          />
          <div className="strip-switches">
            <button
              type="button"
              className={ch.mute ? 'latched-hot' : ''}
              onClick={() => actions.setMute(i, !ch.mute)}
            >
              M
            </button>
            <button
              type="button"
              className={ch.solo ? 'latched-accent' : ''}
              onClick={() => actions.setSolo(i, !ch.solo)}
            >
              S
            </button>
            <button
              type="button"
              className={ch.toMonitor ? 'latched-signal' : ''}
              title="cue (monitor bus)"
              onClick={() => actions.setToMonitor(i, !ch.toMonitor)}
            >
              C
            </button>
          </div>
        </div>
      ))}
      {channels.length === 0 && (
        <p className="dim">No channels — bind a source on the left.</p>
      )}
    </section>
  )
}
