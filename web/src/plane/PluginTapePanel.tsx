/**
 * ScoopyTape's face — the looper strip as a DAW insert.
 * `window.__slPanel = "plugintape"`, injected by ScoopyTapeEditor.
 * Brief: docs/merge/TAPEPLUGIN-KICKOFF.md.
 *
 * THE DISPLAY IS THE PRODUCT. Everything else is an 18px row; the wave field
 * takes the entire remainder and is measured, not guessed, because "enough
 * ground to scrub precisely" is the whole reason this plugin is not just a
 * strip on the plane. That is also why `TapeWave` grew an optional `height`:
 * on the plane it is a 48px lane inside a strip, here it is the object.
 *
 * ⚠️ WHAT IS DELIBERATELY NOT DRAWN, and why that is a rule and not a gap.
 * DESIGN.md rule 7: never ship a control that reaches nothing. Scrub STYLES
 * (§5), the multiply/divide pulse gesture (§6), EXPORT (§7) and snapshot
 * PERSISTENCE (§3) have no verb behind them yet, so they are absent rather
 * than drawn inert. Everything below reaches a real engine call today:
 *
 *   ⟳ ▸ ↻ ◼   sl_tape_trigger modes 0/1/2/3
 *   REC        slRecord start/stop → the Law C-3 record→loop handoff
 *   the wave   sl_tape_waveform + scrub (the turntable law) + loop brace
 *   LEVEL      sl_channel_set_level via slTape setLevel
 *   RATE       sl_tape_set_rate, signed, bipolar, double-click back to 1.0
 *   1‥8        the tape index every command above is addressed to
 *
 * The slot row is A4's snapshot bank at its honest §1 depth: the engine really
 * does have 8 tapes and flipping really does re-address the face, so recording
 * into 1, flipping to 3 and recording again works right now. What §3 adds is
 * making them SURVIVE — audio + params in the state chunk and the shared bank.
 */
import { useEffect, useRef, useState } from 'react'
import { SL_TAPE_STATE, slTapeIndex } from '../../protocol/schema.ts'
import { Button, GeoRange } from '../design/controls.tsx'
import type { EngineLink } from '../engineLink.ts'
import { TapeWave } from './TapeWave.tsx'
import { ask, send } from './send.ts'
import './plane.css'

/** The engine's bank width (`kMaxTapes`), which is also the line's snapshot
    count — see PLUGIN-DESIGN-SYSTEM §5. The two agreeing is not a coincidence
    worth relying on silently, so it is named once here. */
const SLOTS = 8

/** `sl_tape_trigger` modes, and the four glyphs DESIGN.md §3 fixes. Not three,
    not five, and never ■/▶ — that is a second dialect. */
const TRANSPORT = [
  { glyph: '⟳', mode: 0, title: 'loop' },
  { glyph: '▸', mode: 1, title: 'one-shot' },
  { glyph: '↻', mode: 3, title: 'retrigger' },
  { glyph: '◼', mode: 2, title: 'stop' },
] as const

/** deviceInput — `RecordSourceKind` 0. An insert records what the DAW feeds it;
    mainMix and channelBus are the app's cases, not this product's. */
const RECORD_SOURCE_DEVICE_INPUT = 0

export function PluginTapePanel({ link }: { link: EngineLink | null }) {
  const [slot, setSlot] = useState(0)
  const [state, setState] = useState<number>(SL_TAPE_STATE.idle)
  const [revision, setRevision] = useState(0)
  const [level, setLevel] = useState(1)
  const [rate, setRate] = useState(1)
  const [hostBpm, setHostBpm] = useState(0)
  const [hostPlaying, setHostPlaying] = useState(false)
  const [filled, setFilled] = useState<boolean[]>(() => new Array(SLOTS).fill(false))

  // Measured, never assumed: the canvas needs device-real numbers and L1 says
  // the box is authoritative — content fits the box, not the reverse.
  const fieldRef = useRef<HTMLDivElement | null>(null)
  const [field, setField] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = fieldRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setField({ w: el.clientWidth, h: el.clientHeight })
    })
    ro.observe(el)
    setField({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  // The selected tape's transport state, for the REC latch and the readout.
  useEffect(() => {
    if (!link) return
    const iState = slTapeIndex(slot, 'State')
    return link.onHotFrame((frame) => {
      const s = frame[iState] ?? SL_TAPE_STATE.idle
      setState((prev) => (prev === s ? prev : s))
    })
  }, [link, slot])

  // THE HOST IS THE CLOCK. Same reasoning as the deck's face: there is no
  // transport slot in the HotFrame, so without this the UI would mirror the
  // last transport it COMMANDED and quietly lie about what the DAW is doing.
  useEffect(() => {
    if (!link) return
    return link.onEvent((evt) => {
      const e = evt as { type?: string; bpm?: number; playing?: boolean }
      if (e?.type !== 'hostTransport') return
      if (typeof e.bpm === 'number') setHostBpm(e.bpm)
      if (typeof e.playing === 'boolean') setHostPlaying(e.playing)
    })
  }, [link])

  // Which slots hold material — the `filled` flag the line's snapshot bank
  // carries, read from the engine rather than remembered, so it cannot drift
  // from what is actually in the bank.
  const refreshFilled = () => {
    if (!link) return
    void Promise.all(
      Array.from({ length: SLOTS }, (_, i) =>
        ask<{ frames?: number }>(link, 'slTape', { action: 'info', tape: i }).then(
          (r) => (r?.frames ?? 0) > 0,
        ),
      ),
    ).then(setFilled)
  }
  useEffect(refreshFilled, [link])

  const recording = state === SL_TAPE_STATE.recording

  const trigger = (mode: number) => send(link, 'slTape', { action: 'trigger', tape: slot, mode })

  const toggleRecord = async () => {
    if (recording) {
      await ask(link, 'slRecord', { action: 'stop', tape: slot })
      // Law C-3 hands the same chunks over as the playback buffer in the same
      // block, so there is material the instant this returns — repaint and
      // re-read `filled` rather than waiting for a HotFrame to imply it.
      setRevision((r) => r + 1)
      refreshFilled()
      return
    }
    await ask(link, 'slRecord', {
      action: 'start',
      tape: slot,
      sourceKind: RECORD_SOURCE_DEVICE_INPUT,
      chan0: 0,
      chan1: 1,
    })
    setRevision((r) => r + 1)
  }

  const stateLabel = recording
    ? 'REC'
    : state === SL_TAPE_STATE.loop
      ? 'LOOP'
      : state === SL_TAPE_STATE.oneShot
        ? 'ONCE'
        : 'IDLE'

  return (
    <div className="plugin-tape-pane">
      <div className="strip-row plugin-tape-bar">
        {TRANSPORT.map((t) => (
          <Button
            key={t.mode}
            label={t.glyph}
            title={t.title}
            hot
            onClick={() => trigger(t.mode)}
          />
        ))}
        <Button
          label="REC"
          hot
          active={recording}
          title={
            recording
              ? 'stop recording — the loop starts in the same block'
              : 'record the DAW input into this slot'
          }
          onClick={() => void toggleRecord()}
        />
        <span className="plugin-tape-state">{stateLabel}</span>
        <span className="plugin-tape-host">
          {hostBpm > 0
            ? `host ${hostBpm.toFixed(1)} ${hostPlaying ? '▶' : '·'}`
            : 'host —'}
        </span>
      </div>

      <div className="plugin-tape-field" ref={fieldRef}>
        {field.w > 0 && field.h > 0 && (
          <TapeWave
            link={link}
            tape={slot}
            width={field.w}
            height={field.h}
            revision={revision}
            canScrub
            hint="record the DAW input to fill this slot"
            onScrub={{
              begin: (frame) => send(link, 'slTape', { action: 'scrubBegin', tape: slot, frame }),
              to: (frame) => send(link, 'slTape', { action: 'scrubTo', tape: slot, frame }),
              end: () => send(link, 'slTape', { action: 'scrubEnd', tape: slot }),
            }}
            onLoopDrag={(start, end) =>
              send(link, 'slTape', { action: 'setLoop', tape: slot, enabled: true, start, end })
            }
          />
        )}
      </div>

      <div className="strip-row plugin-tape-bar">
        <GeoRange
          label="LEVEL"
          value={level}
          min={0}
          max={1}
          step={0.01}
          display={level.toFixed(2)}
          onChange={(v) => {
            setLevel(v)
            send(link, 'slTape', { action: 'setLevel', tape: slot, level: v })
          }}
        />
        <GeoRange
          label="RATE"
          value={rate}
          min={-4}
          max={4}
          step={0.01}
          // Bipolar because the sign IS the direction: a negative rate is
          // reverse through the same reader (sl_tape.cpp), not a second mode.
          origin="center"
          display={`${rate > 0 ? '' : '−'}${Math.abs(rate).toFixed(2)}×`}
          title="playback rate — negative is reverse; double-click for exactly 1.00"
          onDoubleClick={() => {
            setRate(1)
            send(link, 'slTape', { action: 'setRate', tape: slot, rate: 1 })
          }}
          onChange={(v) => {
            setRate(v)
            send(link, 'slTape', { action: 'setRate', tape: slot, rate: v })
          }}
        />
      </div>

      <div className="plugin-tape-slots">
        {Array.from({ length: SLOTS }, (_, i) => (
          <Button
            key={i}
            label={String(i + 1)}
            hot
            active={i === slot}
            title={
              filled[i]
                ? `slot ${i + 1} — holds a loop`
                : `slot ${i + 1} — empty; REC fills it`
            }
            onClick={() => setSlot(i)}
          />
        ))}
        <span className="plugin-tape-note">
          {filled[slot] ? `slot ${slot + 1}` : `slot ${slot + 1} · empty`}
        </span>
      </div>
    </div>
  )
}
