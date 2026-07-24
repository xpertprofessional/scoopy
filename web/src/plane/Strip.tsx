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
import { useRef, useState } from 'react'
import type { Channel } from '../../protocol/schema'
import { channelFieldIndex } from '../../protocol/schema'
import type { EngineLink } from '../engine/engineLink'
import { FADER_UNITY_POSITION, faderPositionToDb } from '../engine/faderCurve'
import { usePatchActions } from '../engine/usePatch'
import { MeterCanvas } from '../hotsurface/MeterCanvas'
import { useAppStore } from '../store/appStore'
import { DeckWaveform } from '../panels/DeckWaveform'
import { ParamRow } from '../design/controls'
import { StripLoad } from './StripLoad'
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

/**
 * Which ENGINE INPUT channels a Strip records. The engine captures input
 * channels only (wz_engine.h: "records `channels` ENGINE-input channels"), so
 * this is also the honest test of whether a Strip can record at all.
 *   deviceInput "3"   -> mono   {3, -1}
 *   deviceInput "0,1" -> stereo {0, 1}
 * A bus tap or an app tap has no input channel to name, so it returns null and
 * the record verb is disabled WITH the reason rather than silently doing
 * nothing.
 */
export function recordChannels(
  source: { kind: string; id: string },
  fallbackInput: number | null,
): { chan0: number; chan1: number } | null {
  if (source.kind === 'deviceInput') {
    const parts = source.id.split(',').map((p) => Number.parseInt(p, 10))
    const a = parts[0]
    if (a === undefined || !Number.isInteger(a) || a < 0) return null
    const b = parts[1]
    return { chan0: a, chan1: Number.isInteger(b) && b! >= 0 ? b! : -1 }
  }
  // A Strip that already holds material but names no input (a deck added empty)
  // records the first available input, which is what the deck rack always did.
  if (source.kind === 'deck' && fallbackInput !== null)
    return { chan0: fallbackInput, chan1: -1 }
  return null
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
  scale = 1,
}: {
  channel: Channel
  index: number
  link: EngineLink | null
  /** The plane's zoom, so a screen drag converts to the right plane distance. */
  scale?: number
}) {
  const actions = usePatchActions(link)
  // MATERIAL is the authority for what a Strip plays (PD-CANVAS-06). Reading it
  // from `source.kind === 'deck'` was the old conflation: source says what a
  // Strip captures FROM, material says what it PLAYS. The engine still renders
  // from source, so both are present on a deck strip — but the UI asks the
  // field that actually means "has material".
  const deckId = channel.material?.deckId ?? -1
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
  const deckFrames = useAppStore((s) => (deckId >= 0 ? (s.deckFrames[deckId] ?? 0) : 0))
  const deviceInfo = useAppStore((s) => s.deviceInfo)

  const setChannelCell = useAppStore((s) => s.setChannelCell)
  const selected = useAppStore((s) => s.selectedKey === channel.key)
  const setSelected = useAppStore((s) => s.setSelected)
  // Overdub is a live engine mode, not document state: it is armed and dropped
  // in the moment, and nothing about it should survive a save.
  const [overdubbing, setOverdubbing] = useState(false)
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null)

  const cell = channel.cell

  /**
   * Drag the Strip to move it. Grabbing a CONTROL must never move the Strip —
   * otherwise nudging a fader would relocate the thing you are playing — so any
   * pointer-down that lands on an interactive element is left alone. The plane
   * ignores pointer-downs on a Strip, so without this handler a drag on a Strip
   * fell through to the pan and appeared to move every Strip at once.
   */
  const onPointerDown = (e: React.PointerEvent) => {
    // Selecting on pointer-DOWN (not click) means the Inspector follows you even
    // when the gesture turns into a drag — you are working on the thing you just
    // grabbed, which is what you would expect.
    setSelected(channel.key)
    if ((e.target as HTMLElement).closest('button, input, select, textarea, canvas, label')) return
    e.stopPropagation()
    dragRef.current = { px: e.clientX, py: e.clientY, x: cell.x, y: cell.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d) return
    e.stopPropagation()
    // Screen delta -> plane delta is a division by the zoom.
    setChannelCell(
      index,
      Math.round(d.x + (e.clientX - d.px) / scale),
      Math.round(d.y + (e.clientY - d.py) / scale),
    )
  }
  const endDrag = (e: React.PointerEvent) => {
    if (!dragRef.current) return
    dragRef.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
  }
  const recording = deckState === RECORDING
  const hasMaterial = deck !== undefined && deck.sourcePath !== ''
  // The wave is shown for anything that HAS material or is capturing it now —
  // that is what makes recording feel like a player rather than a form.
  const showWave = deck !== undefined && (hasMaterial || recording)
  // What this Strip would record, and whether it can at all.
  const firstInput = deviceInfo?.inputs[0]?.index ?? null
  const rec = recordChannels(channel.source, firstInput)
  const canRecord = rec !== null
  const waveWidth = Math.max(80, cell.w - 16)
  const sampleRate = deviceInfo?.sampleRate ?? 0
  const blockMs = sampleRate > 0 ? ((512 / sampleRate) * 1000).toFixed(1) : null
  const materialName = hasMaterial
    ? (deck?.sourcePath.split('/').pop() ?? '')
    : recording
      ? 'recording…'
      : 'empty'

  return (
    <div
      className={`plane-strip raised${selected ? ' plane-strip-selected' : ''}`}
      style={{ left: cell.x, top: cell.y, width: cell.w, height: cell.h }}
      data-testid={`strip-${channel.key}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
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
        {/* The bus chip is EDITABLE, not just a badge: routing is a live
            decision, and the chip is where the plan says it opens (pd-merge §3).
            A bus the device cannot carry is still offered — you should be able
            to BUILD a spatial patch on a stereo laptop and see honestly what
            will not be heard, rather than find the option missing. */}
        <select
          className={`plane-strip-bus${channel.outBus >= mappable ? ' plane-strip-bus-unmapped' : ''}`}
          value={channel.outBus}
          title={
            channel.outBus >= mappable
              ? 'routed to a bus this device cannot carry — this strip is NOT heard'
              : 'output bus — bus 1 is main; a spatial layout is just strips on different buses'
          }
          onChange={(ev) => actions.setOutBus(index, Number(ev.target.value))}
        >
          {Array.from({ length: 8 }, (_, b) => (
            <option key={b} value={b}>
              {b === 0 ? 'main' : `bus ${b + 1}`}
              {b >= mappable ? ' ⚠' : ''}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="plane-strip-remove"
          title="remove this strip"
          onClick={() => actions.removeStrip(index)}
        >
          ×
        </button>
      </div>

      {/* The LoopbackBus costs exactly one engine block. playback-composer.md §2
          calls that "the honest price, stated in the UI, not hidden" — so it is
          stated here, in ms at the real device rate. */}
      {channel.source.kind === 'busTap' && (
        <div
          className="plane-strip-loopback"
          title="a loopback reads the bus one block behind — that delay is what makes the cycle legal and the schedule acyclic"
        >
          ↺ {blockMs ? `+${blockMs} ms` : 'one block'}
        </div>
      )}

      {showWave && deck && (
        <DeckWaveform
          link={link}
          deck={deck.id}
          channelCount={channelCount}
          revision={deckRevision}
          // The ENGINE's reported length first. A loaded FILE is not a take, so
          // the take lookup missed and this fell back to max(loopEnd,1) = 1 —
          // one frame — which drew a flat line and scaled the playhead off
          // screen, making playback look dead when it was fine.
          frames={
            deckFrames ||
            takes.filter((t) => t.path === deck.sourcePath)[0]?.frames ||
            Math.max(deck.loopEndSample, 1)
          }
          loopStart={deck.loopStartSample}
          loopEnd={deck.loopEndSample}
          onSetLoop={(a, b) => actions.setDeckLoop(deck.id, a, b)}
          onScrub={(frame) => actions.deckSeek(deck.id, frame)}
          onTapeScrub={(phase, frame) => actions.deckScrub(deck.id, phase, frame)}
          scale={scale}
          width={waveWidth}
          height={44}
          recording={recording}
        />
      )}
      <div className="plane-strip-file dim" title={deck?.sourcePath || 'no material yet'}>
        {materialName}
      </div>
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
        {/* RECORD IS ON EVERY STRIP (D-WZ-RECMODEL-01 step A): recording is the
            verb that gives a Strip material, so it cannot be a privilege of
            Strips that already have some. Where the engine cannot capture the
            source, it is disabled WITH the reason — never silently inert. */}
        <button
          type="button"
          className={recording ? 'latched-rec' : ''}
          disabled={!canRecord && !recording}
          title={
            recording
              ? 'stop — the take loops instantly (Law C-3)'
              : canRecord
                ? `record ${channel.source.name} into this strip`
                : `this strip cannot be recorded: the engine captures input channels, and “${channel.source.kind}” names none`
          }
          onClick={() => {
            if (recording && deck) return void actions.deckRecordStop(deck.id)
            if (rec) void actions.recordIntoStrip(index, rec.chan0, rec.chan1, channel.source.name)
          }}
        >
          {recording ? '■' : '●'}
        </button>
        {/* Transport is ALWAYS present, disabled until there is material to
            play. A Strip is a player whose material may not exist yet — growing
            the controls in later would make it two different objects, which is
            exactly what this phase exists to abolish. */}
        <button
          type="button"
          disabled={!hasMaterial}
          onClick={() => deck && actions.deckTrigger(deck.id, 'loop')}
          title={hasMaterial ? 'loop' : 'loop — nothing recorded or loaded yet'}
        >
          ⟳
        </button>
        <button
          type="button"
          disabled={!hasMaterial}
          onClick={() => deck && actions.deckTrigger(deck.id, 'oneShot')}
          title={hasMaterial ? 'one-shot' : 'one-shot — nothing recorded or loaded yet'}
        >
          ▸
        </button>
        <button
          type="button"
          disabled={!hasMaterial}
          onClick={() => deck && actions.deckTrigger(deck.id, 'retrigger')}
          title="retrigger — seek to the region start, keep playing"
        >
          ⟲
        </button>
        <button
          type="button"
          disabled={!hasMaterial}
          onClick={() => deck && actions.deckTrigger(deck.id, 'stop')}
          title="stop"
        >
          ◼
        </button>
        <StripLoad index={index} link={link} />
        {/* OVR — sound-on-sound. Available on ANY strip that HAS material and a
            capturable source: a loaded file layers exactly like a recorded take,
            because a strip is a strip. Monitoring stays open while layering
            (D-WZ-MON-02's one exception), since hearing yourself against the
            loop is the entire point. */}
        {hasMaterial && canRecord && deck && (
          <button
            type="button"
            className={overdubbing ? 'latched-rec' : ''}
            title={
              overdubbing
                ? 'overdubbing — layering into the loop; click to stop'
                : `overdub ${channel.source.name} into this loop (sound-on-sound)`
            }
            onClick={() => {
              const next = !overdubbing
              setOverdubbing(next)
              actions.setOverdub(index, deck.id, next)
            }}
          >
            OVR
          </button>
        )}
        {/* IN — listen to the source instead of the material. Only meaningful
            when the Strip has BOTH: without material there is nothing else to
            hear, and without a capturable source there is nothing to switch to.
            Before this, a mic strip that had recorded once could never be
            monitored again — material won permanently. */}
        {hasMaterial && canRecord && (
          <button
            type="button"
            className={channel.monitorSwitch ? 'latched-signal' : ''}
            title={
              channel.monitorSwitch
                ? `listening to ${channel.source.name} — click to hear the recorded material instead`
                : `listening to the recorded material — click to hear ${channel.source.name} instead`
            }
            onClick={() => actions.setMonitorSwitch(index, !channel.monitorSwitch)}
          >
            IN
          </button>
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
      {deck && hasMaterial && (
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
