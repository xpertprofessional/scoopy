/**
 * Strip — the ONE unified item on the plane (PD-CANVAS-02, D-WZ-PDCANVAS-01).
 *
 * Every current species is this same component in a different state: an input,
 * a tap, a loopback, or a deck that has recorded material. It is positioned on
 * the plane by its `cell` geometry; the Plane applies pan/zoom, so this only
 * lays out its own contents. "Essential first" (the signed first cut): name,
 * meter, level, pan, mute/solo, cue, record — plus, when the strip's source is a
 * deck with material, a waveform + transport + the signed varispeed thumb.
 * Precise settings (exact loop points, output bus, cue routing) move to the
 * Inspector in PD-CANVAS-03.
 */
import type { Channel } from '../../protocol/schema'
import { channelFieldIndex } from '../../protocol/schema'
import type { EngineLink } from '../engine/engineLink'
import { FADER_UNITY_POSITION, faderPositionToDb } from '../engine/faderCurve'
import { usePatchActions } from '../engine/usePatch'
import { MeterCanvas } from '../hotsurface/MeterCanvas'
import { useAppStore } from '../store/appStore'
import { VarispeedSlider } from '../panels/VarispeedSlider'
import { DeckWaveform } from '../panels/DeckWaveform'

const KIND_VAR: Record<string, string> = {
  deviceInput: 'var(--chan-device)',
  appTap: 'var(--chan-app-tap)',
  deck: 'var(--chan-deck)',
  virtualDeviceInput: 'var(--chan-virtual)',
  busTap: 'var(--chan-bus)',
  none: 'var(--chan-bus)',
}

const DECK_STATE_LABEL = ['idle', 'loop', 'shot', 'rec']
const RECORDING = 3

function faderLabel(position: number): string {
  if (position <= 0) return '−∞'
  const db = faderPositionToDb(position)
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`
}

export function Strip({
  channel,
  index,
  link,
}: {
  channel: Channel
  index: number
  link: EngineLink | null
}) {
  const actions = usePatchActions(link)
  // Deck-backed strips carry material; look it up by the source's deck index.
  const deckId = channel.source.kind === 'deck' ? Number(channel.source.id) : -1
  const deck = useAppStore((s) => s.patch.decks.find((d) => d.id === deckId))
  const deckState = useAppStore((s) => (deckId >= 0 ? (s.deckStates[deckId] ?? 0) : 0))
  const deckRevision = useAppStore((s) => (deckId >= 0 ? (s.deckRevisions[deckId] ?? 0) : 0))
  const deckLoading = useAppStore((s) => (deckId >= 0 ? (s.deckLoading[deckId] ?? false) : false))
  const unresolved = useAppStore((s) => (deckId >= 0 ? (s.deckUnresolved[deckId] ?? false) : false))
  const channelCount = useAppStore((s) => s.patch.channels.length)
  const takes = useAppStore((s) => s.takes)
  const deviceInfo = useAppStore((s) => s.deviceInfo)

  const cell = channel.cell
  const recording = deckState === RECORDING
  const hasMaterial = deck !== undefined && deck.sourcePath !== ''
  const inputName = deviceInfo?.inputs[0]?.name ?? 'input 1'

  return (
    <div
      className="plane-strip raised"
      style={{ left: cell.x, top: cell.y, width: cell.w }}
      data-testid={`strip-${channel.key}`}
    >
      <div className="plane-strip-name" style={{ color: KIND_VAR[channel.source.kind] }}>
        {channel.name}
        {deck && (
          <span className={`plane-strip-state deck-state-${deckState}`}>
            {DECK_STATE_LABEL[deckState] ?? '?'}
          </span>
        )}
      </div>

      {hasMaterial && deck && (
        <DeckWaveform
          link={link}
          deck={deck.id}
          channelCount={channelCount}
          revision={deckRevision}
          frames={
            takes.filter((t) => t.path === deck.sourcePath)[0]?.frames ??
            Math.max(deck.loopEndSample, 1)
          }
          loopStart={deck.loopStartSample}
          loopEnd={deck.loopEndSample}
          onSetLoop={(a, b) => actions.setDeckLoop(deck.id, a, b)}
        />
      )}
      {unresolved && (
        <div className="deck-unresolved" title="this strip's audio could not be found — kept and marked; restore the file to bring it back">
          audio missing
        </div>
      )}
      {deckLoading && <div className="plane-strip-loading">loading…</div>}

      <div className="plane-strip-meter">
        <MeterCanvas
          levels={(frame) => {
            const li = channelFieldIndex(index, 'peakL')
            const ri = channelFieldIndex(index, 'peakR')
            return frame.length > ri ? [frame[li]!, frame[ri]!] : null
          }}
        />
      </div>

      <label className="plane-strip-level">
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={channel.gain}
          onChange={(ev) => actions.setFader(index, Number(ev.target.value))}
          onDoubleClick={() => actions.setFader(index, FADER_UNITY_POSITION)}
        />
        <span className="value">{faderLabel(channel.gain)}</span>
      </label>

      <input
        className="plane-strip-pan"
        type="range"
        min={-1}
        max={1}
        step={0.01}
        value={channel.pan}
        onChange={(ev) => actions.setPan(index, Number(ev.target.value))}
        onDoubleClick={() => actions.setPan(index, 0)}
        title={`pan ${channel.pan.toFixed(2)}`}
      />

      {hasMaterial && deck && (
        <VarispeedSlider rate={deck.rate} onChange={(rate) => actions.setDeckRate(deck.id, rate)} />
      )}

      <div className="plane-strip-switches">
        <button
          type="button"
          className={channel.mute ? 'latched-hot' : ''}
          onClick={() => actions.setMute(index, !channel.mute)}
        >
          M
        </button>
        <button
          type="button"
          className={channel.solo ? 'latched-accent' : ''}
          onClick={() => actions.setSolo(index, !channel.solo)}
        >
          S
        </button>
        <button
          type="button"
          className={channel.toMonitor ? 'latched-signal' : ''}
          title="cue (monitor bus)"
          onClick={() => actions.setToMonitor(index, !channel.toMonitor)}
        >
          C
        </button>
        {deck && (
          <button
            type="button"
            className={recording ? 'latched-rec' : ''}
            title={recording ? 'stop — loops instantly (Law C-3)' : `record ${inputName}`}
            onClick={() =>
              recording
                ? void actions.deckRecordStop(deck.id)
                : void actions.deckRecordStart(deck.id, 0, -1, inputName)
            }
          >
            {recording ? '■' : '●'}
          </button>
        )}
      </div>

      {deck && (
        <div className="plane-strip-transport">
          <button type="button" onClick={() => actions.deckTrigger(deck.id, 'loop')} title="loop">
            ⟳
          </button>
          <button type="button" onClick={() => actions.deckTrigger(deck.id, 'oneShot')} title="one-shot">
            ▸
          </button>
          <button type="button" onClick={() => actions.deckTrigger(deck.id, 'stop')} title="stop">
            ■
          </button>
        </div>
      )}
    </div>
  )
}
