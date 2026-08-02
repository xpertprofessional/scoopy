/**
 * TAPE ROW — the looper, as a BLOCK (D-SL-STUDIO-01 L1).
 *
 * A face is a layout; a block is a component; faces compose blocks and a face
 * never rebuilds one. This is the first block carved for that law after
 * `studio/Transport.tsx`, and it exists because the looper lived in exactly two
 * products — ScoopyTape, where it IS the product, and the frozen plane's 48 px
 * lane — while `PluginTapePanel` was a hand-wired face that mounted no block at
 * all. Adding anything to that face builds it into the one product it already
 * has. Studio's step S8 wants this same tree as a bottom row, so carving it
 * hands S8 a finished block instead of a second implementation.
 *
 * ⚠️ THE BOX IS THE FACE'S, THE CONTENTS ARE THE BLOCK'S. `.plugin-tape-pane`
 * carries `height: 100vh` because a plugin window root has nothing above it to
 * supply a height; Studio's row is a fixed strip that collapses. Neither is this
 * block's business — it fills whatever box it is given and measures the wave
 * field from it, which is the same discipline `TapeWave`'s optional `height`
 * already follows. So there is no `collapsible` prop and no density switch here:
 * that would be layout leaking into a component, which is what L1 forbids.
 *
 * ⚠️ THE CSS CLASSES STILL SAY `plugin-tape-*`, and that is deliberate. They
 * predate the carve, `check:tokens` and the ScoopyTape walk both know them, and
 * renaming a stylesheet to match a file move is churn that buys nothing.
 *
 * WHAT IS DELIBERATELY NOT DRAWN, inherited from the face this came from.
 * DESIGN.md rule 7: never ship a control that reaches nothing. Scrub STYLES,
 * the multiply/divide pulse gesture, EXPORT and snapshot PERSISTENCE have no
 * verb behind them yet, so they are absent rather than drawn inert. Everything
 * below reaches a real engine call today:
 *
 *   ⟳ ▸ ↻ ◼   sl_tape_trigger modes 0/1/2/3
 *   REC        slRecord start/stop → the Law C-3 record→loop handoff
 *   the wave   sl_tape_waveform + scrub (the turntable law) + loop brace
 *   LEVEL      sl_channel_set_level via slChannel setLevel
 *   RATE       sl_tape_set_rate, signed, bipolar, double-click back to 1.0
 *   1‥8        the tape index every command above is addressed to
 */
import { useEffect, useRef, useState } from 'react'
import { SL_TAPE_STATE, slTapeIndex } from '../../protocol/schema.ts'
import { Button, GeoRange } from '../design/controls.tsx'
import type { EngineLink } from '../engineLink.ts'
import { useCapabilities } from '../state/capabilitiesStore.ts'
import { TapeWave } from '../plane/TapeWave.tsx'
import { ask, send } from '../plane/send.ts'
import '../plane/plane.css'

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

/** `sl_channel_set_source` kind 1 = tape. */
const SOURCE_KIND_TAPE = 1

export function TapeRow({ link }: { link: EngineLink | null }) {
  const caps = useCapabilities()
  const [slot, setSlot] = useState(0)
  const [state, setState] = useState<number>(SL_TAPE_STATE.idle)
  const [revision, setRevision] = useState(0)
  const [level, setLevel] = useState(1)
  const [rate, setRate] = useState(1)
  const [hostBpm, setHostBpm] = useState(0)
  const [hostPlaying, setHostPlaying] = useState(false)
  const [filled, setFilled] = useState<boolean[]>(() => new Array(SLOTS).fill(false))

  // ⚠️ BIND EVERY TAPE TO ITS OWN CHANNEL, OR THE BLOCK IS SILENT.
  //
  // A tape does not render to the main bus; it renders into a CHANNEL, and a
  // fresh channel's source is kind 0 = none. ScoopyTape's processor learned this
  // the expensive way — it shipped a looper that recorded perfectly, reported
  // `looping`, drew its waveform and put out nothing at all — and does the same
  // binding in its constructor. This is the web-tier half, and it is what makes
  // the block audible in a face whose host never bound anything.
  //
  // Safe in every face that mounts it, which is why it lives in the BLOCK:
  //   · ScoopyTape already bound the same 8 pairs in C++ — this is idempotent.
  //   · Studio binds NO channel sources at all. It reaches the engine through
  //     `setMap` + `applyTempo`; `applyMap` (the only thing that issues
  //     `channelSetSource`) is PlanePanel's, so channels 0-7 are free there and
  //     its map's `channel: 0` is a document field the tempo law reads, not a
  //     live audio binding.
  //   · The frozen plane owns its channels through strips and does NOT mount
  //     this block — `faces:check` R5 is what keeps that true.
  useEffect(() => {
    if (!link || !caps.tape) return
    for (let i = 0; i < SLOTS; ++i)
      send(link, 'slChannel', { action: 'setSource', channel: i, kind: SOURCE_KIND_TAPE, index: i })
  }, [link, caps.tape])

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
  }, [caps.tape])

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
  // Silent in Studio, which emits no `hostTransport` — hence the `host —` case.
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
    if (!link || !caps.tape) return
    void Promise.all(
      Array.from({ length: SLOTS }, (_, i) =>
        ask<{ frames?: number }>(link, 'slTape', { action: 'info', tape: i }).then(
          (r) => (r?.frames ?? 0) > 0,
        ),
      ),
    ).then(setFilled)
  }
  useEffect(refreshFilled, [link, caps.tape])

  // NO TAPE ON THIS HOST — inert WITH A STATED REASON (DESIGN.md §6/§7), never
  // broken and never absent. The browser companion's WASM engine has no tape at
  // all, and availability is `getCapabilities` rather than "which face am I in".
  if (!caps.tape)
    return (
      <div className="tape-row tape-row-inert">
        <span className="plugin-tape-note">
          {'tape — not on this host: the browser engine has no recorder or looper'}
        </span>
      </div>
    )

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
    <div className="tape-row">
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
              : 'record the input into this slot'
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
            hint="record the input to fill this slot"
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
          // ⚠️ slCHANNEL, not slTape. Level, mute, sends and the source binding
          // all belong to the CHANNEL a tape renders into — `slTape` has no
          // setLevel arm at all, so the first cut of this control addressed a
          // command that does not exist and was silently discarded. Same root
          // cause as the silence bug: a tape and its channel are two objects.
          // Channel i carries tape i (the binding effect above).
          onChange={(v) => {
            setLevel(v)
            send(link, 'slChannel', { action: 'setLevel', channel: slot, level: v })
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
