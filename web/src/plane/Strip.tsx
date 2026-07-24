/**
 * Strip — the ONE unified item on the plane (PD-CANVAS-02, D-WZ-PDCANVAS-01).
 *
 * Every current species is this same component in a different state: an input,
 * a tap, a loopback, or a deck that has recorded material. It is positioned by
 * its `cell` geometry; the Plane applies pan/zoom, so this only lays out its own
 * contents.
 *
 * SHAPE: horizontal and player-like (the Parlante reference) — a header line, a
 * wide waveform, a transport row, then Layout-B parameter rows (label · bar ·
 * value) from the shared control idiom. The waveform is the centre of gravity,
 * as it is in a player, and it draws LIVE while recording.
 *
 * Precise settings (exact loop points, output bus, cue routing) move to the
 * Inspector in PD-CANVAS-03 — this stays what you touch while playing.
 */
import type { Channel } from '../../protocol/schema'
import { channelFieldIndex } from '../../protocol/schema'
import type { EngineLink } from '../engine/engineLink'
import { FADER_UNITY_POSITION, faderPositionToDb } from '../engine/faderCurve'
import { usePatchActions } from '../engine/usePatch'
import { MeterCanvas } from '../hotsurface/MeterCanvas'
import { useAppStore } from '../store/appStore'
import { DeckWaveform } from '../panels/DeckWaveform'
import { ParamRow } from '../design/controls'
import { rateToPosition, positionToRate, formatRate, snapUnity } from '../panels/VarispeedSlider'

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
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`
}

function panLabel(pan: number): string {
  if (Math.abs(pan) < 0.005) return 'C'
  const side = pan < 0 ? 'L' : 'R'
  return `${side}${Math.round(Math.abs(pan) * 100)}`
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
  // Number('') is 0, which would silently bind an id-less deck channel to deck 0.
  const parsedDeck = channel.source.kind === 'deck' ? Number.parseInt(channel.source.id, 10) : NaN
  const deckId = Number.isInteger(parsedDeck) && parsedDeck >= 0 ? parsedDeck : -1
  const deck = useAppStore((s) => s.patch.decks.find((d) => d.id === deckId))
  const deckState = useAppStore((s) => (deckId >= 0 ? (s.deckStates[deckId] ?? 0) : 0))
  const deckRevision = useAppStore((s) => (deckId >= 0 ? (s.deckRevisions[deckId] ?? 0) : 0))
  const deckLoading = useAppStore((s) => (deckId >= 0 ? (s.deckLoading[deckId] ?? false) : false))
  const loadProgress = useAppStore((s) => (deckId >= 0 ? (s.deckLoadProgress[deckId] ?? 0) : 0))
  const capped = useAppStore((s) => (deckId >= 0 ? (s.deckCapReached[deckId] ?? false) : false))
  const unresolved = useAppStore((s) => (deckId >= 0 ? (s.deckUnresolved[deckId] ?? false) : false))
  const channelCount = useAppStore((s) => s.patch.channels.length)
  // How many buses this device can actually carry — a strip routed past it is
  // built but NOT heard, which the chip must say rather than hide.
  const mappable = useAppStore((s) => s.deviceInfo?.mappableBuses ?? 1)
  const takes = useAppStore((s) => s.takes)
  const deviceInfo = useAppStore((s) => s.deviceInfo)

  const cell = channel.cell
  const recording = deckState === RECORDING
  const hasMaterial = deck !== undefined && deck.sourcePath !== ''
  const inputName = deviceInfo?.inputs[0]?.name ?? 'input 1'
  // The wave is shown for anything that HAS material or is capturing it now —
  // that is what makes recording feel like a player rather than a form.
  const showWave = deck !== undefined && (hasMaterial || recording)
  const waveWidth = Math.max(80, cell.w - 16)

  return (
    <div
      className="plane-strip raised"
      style={{ left: cell.x, top: cell.y, width: cell.w, height: cell.h }}
      data-testid={`strip-${channel.key}`}
    >
      <div className="plane-strip-head">
        {/* Kind rides a swatch, NOT the name's text colour: three of the five
            kind colours are aliases of chrome (deck=signal, virtual=accent,
            bus=textDim), so tinting the name both weakens its contrast and
            fights the bus chip for meaning. Kind is what it IS; bus is where it
            GOES — they must not share a hue. */}
        <span
          className="plane-strip-kind"
          style={{ background: KIND_VAR[channel.source.kind] }}
          title={`source: ${channel.source.kind} — ${channel.source.name}`}
        />
        <span className="plane-strip-name">{channel.name}</span>
        {deck && (
          <span className={`plane-strip-state deck-state-${deckState}`}>
            {DECK_STATE_LABEL[deckState] ?? '?'}
          </span>
        )}
        <span
          className={`plane-strip-bus${channel.outBus >= mappable ? ' plane-strip-bus-unmapped' : ''}`}
          title={
            channel.outBus >= mappable
              ? `routed to ${channel.outBus === 0 ? 'main' : `bus ${channel.outBus + 1}`}, which this device cannot carry — this strip is NOT heard`
              : 'output bus — bus 1 is main; a spatial layout is just strips on different buses'
          }
        >
          {channel.outBus === 0 ? 'main' : `bus ${channel.outBus + 1}`}
          {channel.outBus >= mappable ? ' ⚠' : ''}
        </span>
        <span className="plane-strip-meter">
          <MeterCanvas
            width={10}
            height={28}
            levels={(frame) => {
              const li = channelFieldIndex(index, 'peakL')
              const ri = channelFieldIndex(index, 'peakR')
              return frame.length > ri ? [frame[li]!, frame[ri]!] : null
            }}
          />
        </span>
      </div>

      {showWave && deck && (
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
          width={waveWidth}
          height={44}
          recording={recording}
        />
      )}
      {unresolved && (
        <div
          className="deck-unresolved"
          title="this strip's audio could not be found — kept and marked; restore the file to bring it back"
        >
          audio missing
        </div>
      )}
      {capped && (
        <div
          className="deck-cap"
          title="256 MB deck memory cap reached — recording stopped; the take is on disk and still loops"
        >
          cap
        </div>
      )}
      {deckLoading && (
        <div
          className="deck-loading"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={loadProgress}
          title="decoding on a background thread — the rest of the app stays live"
        >
          <div className="deck-loading-bar" style={{ width: `${loadProgress * 100}%` }} />
          <span className="deck-loading-label">decoding… {Math.round(loadProgress * 100)}%</span>
        </div>
      )}

      <div className="plane-strip-transport">
        {deck && (
          <>
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
            <button type="button" onClick={() => actions.deckTrigger(deck.id, 'loop')} title="loop">
              ⟳
            </button>
            <button
              type="button"
              onClick={() => actions.deckTrigger(deck.id, 'oneShot')}
              title="one-shot"
            >
              ▸
            </button>
            <button
              type="button"
              onClick={() => actions.deckTrigger(deck.id, 'retrigger')}
              title="retrigger — seek to the region start, keep playing"
            >
              ⟲
            </button>
            <button type="button" onClick={() => actions.deckTrigger(deck.id, 'stop')} title="stop">
              ◼
            </button>
          </>
        )}
        <span className="plane-strip-switches">
          <button
            type="button"
            className={channel.mute ? 'latched-hot' : ''}
            title="mute"
            onClick={() => actions.setMute(index, !channel.mute)}
          >
            M
          </button>
          <button
            type="button"
            className={channel.solo ? 'latched-accent' : ''}
            title="solo"
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
        </span>
      </div>

      <ParamRow
        label="level"
        value={channel.gain}
        display={faderLabel(channel.gain)}
        min={0}
        max={1}
        step={0.001}
        onChange={(v) => actions.setFader(index, v)}
        onDoubleClick={() => actions.setFader(index, FADER_UNITY_POSITION)}
        title="double-click for unity"
      />
      <ParamRow
        label="pan"
        value={channel.pan}
        display={panLabel(channel.pan)}
        min={-1}
        max={1}
        step={0.01}
        origin="center"
        onChange={(v) => actions.setPan(index, v)}
        onDoubleClick={() => actions.setPan(index, 0)}
        title="double-click to centre"
      />
      {hasMaterial && deck && (
        <ParamRow
          label="speed"
          value={rateToPosition(deck.rate)}
          display={formatRate(deck.rate)}
          min={-1}
          max={1}
          step={0.001}
          origin="center"
          // snapUnity keeps the engine's bit-exact identity path reachable by
          // DRAGGING — without it you can never quite land on exactly 1.0.
          onChange={(p) => actions.setDeckRate(deck.id, snapUnity(positionToRate(p)))}
          onDoubleClick={() => actions.setDeckRate(deck.id, 1)}
          title="signed varispeed — left of centre is reverse; double-click for 1.00×"
        />
      )}
    </div>
  )
}
