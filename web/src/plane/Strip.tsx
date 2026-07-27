/**
 * Strip — the ONE player object on the plane (merge P2 step 4).
 *
 * Built to `apps/wizard/docs/specs/pd-strip-anatomy.md`, deliberately NOT
 * ported from wizard's own Strip.tsx, which that spec critiques with fourteen
 * numbered defects. Its thesis, and this file's:
 *
 *   A STRIP IS A PLAYER WHOSE MATERIAL MAY NOT EXIST YET — so it is drawn as a
 *   player from the first frame, not as a mixer strip that grows a player when
 *   you record into it.
 *
 * THE LAYOUT-STABILITY LAWS, which every change here must keep:
 *
 *   L1 THE BOX IS AUTHORITATIVE. The root sets width AND height from `cell`,
 *      with overflow hidden. Content is laid out to fit the box; the box is
 *      never laid out to fit the content. A strip that grows when it records
 *      silently invalidates `cell.h` — which fit-to-content frames against and
 *      the document persists — so every saved arrangement becomes wrong.
 *   L2 EVERY ROW ALWAYS EXISTS. State changes FILL, never PRESENCE. A control
 *      that is meaningless right now is disabled, not removed.
 *   L3 THE STATUS LINE IS ONE LINE with a priority ladder, never a stack.
 *   L4 NO FONT-SIZE CHANGES ON STATE.
 *   L5 CANVAS GEOMETRY IS A PURE FUNCTION of cell.w — never of state.
 *   L6 SELECTION IS AN OUTLINE, never a border (a border moves every child by
 *      a pixel on select).
 *
 * The test for any future addition: render the strip in two states and diff the
 * bounding box of every child. Any child that moves is a bug — and
 * `Strip.test.tsx` asserts exactly that, mechanically, across every state.
 */
import { useEffect, useRef, useState } from 'react'
import {
  HotFrameLayout,
  SL_TAPE_STATE,
  slChannelMonitorOn,
  slTapeIndex,
} from '../../protocol/schema.ts'
import type { EngineLink } from '../engineLink.ts'
import { Button, GeoRange } from '../design/controls.tsx'
import { semanticColor } from '../design/tokens.ts'
import type { SceneLetter } from '../audio/sceneProjection.ts'
import type { Strip as StripDoc } from '../persist/mapDocument.ts'
import {
  checkBudget,
  flushLiveEdits,
  getMap,
  liveSetLevel,
  liveSetRate,
  liveSetSend,
  noteMonitor,
  setMonitor,
  setMute,
  updateStrip,
} from '../state/mapStore.ts'
import { useContextMenu, type MenuItem } from '../design/ContextMenu.tsx'
import type { Chips } from './cables.ts'
import { channelLabel, inputChoices, setInputDevice, useDeviceStore } from './devices.ts'
import { ask, send } from './send.ts'
import { StripMeter, METER_W } from './StripMeter.tsx'
import { GridControls, GridScenes } from './GridElement.tsx'
import { TapeWave, WAVE_H } from './TapeWave.tsx'
import {
  IDLE_LIVE,
  enabledControls,
  freeTape,
  isRecording,
  mmss,
  newTapeElement,
  recordTapFor,
  stateWord,
  statusLine,
  type Live,
} from './stripOps.ts'

/** Interior padding and the meter gutter, from the §4.1 pixel budget. Geometry
    constants live here, not in tokens: `check:tokens` gates colour and type,
    and a layout number in a token file would be a number nobody can find. */
const PAD = 8
const GUTTER = 6

/** The wave canvas width, a pure function of the box (L5). Derived once per
    render rather than in the canvas, so nothing downstream can make it depend
    on state. */
export function waveWidth(cellW: number): number {
  return Math.max(80, cellW - PAD * 2 - GUTTER - METER_W)
}

/** Signed varispeed, displayed in a FIXED-WIDTH field so `−0.75×` and `+1.00×`
    occupy the same box and the row cannot reflow at the reverse crossing. */
export function formatRate(rate: number): string {
  const glyph = rate < 0 ? '◄' : '►'
  return `${glyph} ${Math.abs(rate).toFixed(2)}×`
}

const RATE_MIN = -2
const RATE_MAX = 2
/** Snap to exactly 1.0 near unity. The engine's identity path is BIT-EXACT at
    1.0, so a slider that could only ever reach 0.998 would quietly resample
    material that should pass through untouched. */
function snapUnity(rate: number): number {
  if (Math.abs(rate - 1) < 0.02) return 1
  if (Math.abs(rate + 1) < 0.02) return -1
  return rate
}

export function Strip({
  strip,
  link,
  selected,
  unresolvedRef = null,
  decoding = null,
  feedbackMs = null,
  input = null,
  onPickInput,
  chips,
  gridScene = 'A',
  gridQueued = null,
  onSelectScene,
  onCompose,
  sessions = [],
  onLoadSession,
  onDropElement,
}: {
  strip: StripDoc
  link: EngineLink | null
  selected: boolean
  /**
   * This strip's `takeRef` could not be found in the take library. Supplied by
   * the owner rather than derived here, because RESOLUTION is the library's job
   * (`persist/takeLibrary.ts`) and a strip must not guess at it — a strip that
   * decided for itself would call every reference missing until the library had
   * loaded, and flash "audio missing" on every open.
   */
  unresolvedRef?: string | null
  /** 0..1 while a take decodes into this tape. */
  decoding?: number | null
  /** This strip is fed by a consented feedback edge, and what it costs in ms. */
  feedbackMs?: number | null
  /** The device input patched into this strip, if any — what REC will capture.
      Supplied by the plane, which owns the map, rather than read here: a strip
      must not go looking through the routing graph for itself. */
  input?: { left: number; right: number | null } | null
  /** Re-point this strip's input route. */
  onPickInput?: (left: number, right: number | null) => void
  /** GRID strips only. The scene actually RUNNING and one armed for the next
      cycle boundary — from the session store, not the map: the map remembers a
      scene per (strip, session), the engine is what is playing one, and those
      differ the moment anything else selects. */
  /** What this strip states about its own routing — the CHIPS half of the
      routing decision (cables for graph edges, chips for terminal facts).
      Supplied by the plane, which owns the map: a strip must not go reading the
      routing graph looking for itself. */
  chips?: Chips
  gridScene?: SceneLetter
  gridQueued?: SceneLetter | null
  onSelectScene?: (scene: SceneLetter, immediate: boolean) => void
  onCompose?: () => void
  /** The session library, for the creation gesture. Passed in rather than read
      from the store here so the strip stays a rendering of state — and so a
      strip in a test needs no session store at all. */
  sessions?: { name: string }[]
  /** Load a session into this strip: allocate a deck, bind the channel, publish.
      The plane owns deck allocation because it owns the map. */
  onLoadSession?: (sessionId: string) => void
  /** Give up this strip's element, freeing the deck (or tape) it held. */
  onDropElement?: () => void
}) {
  const tape = strip.element.kind === 'tape' ? strip.element.index : null
  const channels = useDeviceStore((d) => d.channels)
  const devices = useDeviceStore((d) => d.devices)
  const currentDevice = useDeviceStore((d) => d.current)
  const { openMenu } = useContextMenu()
  const isGrid = strip.element.kind === 'grid'
  const [live, setLive] = useState<Live>(IDLE_LIVE)
  const [revision, setRevision] = useState(0)
  const recStartedAt = useRef<number | null>(null)
  const [recSeconds, setRecSeconds] = useState(0)

  /* ── the engine's truth about this strip, at frame rate ───────────────────
   * Sampled down to ~6 Hz before it reaches React. The canvases read the
   * HotFrame directly at 30 Hz for the playhead and the meter; the STRIP only
   * re-renders for things a person reads as text — the state word, whether a
   * button is enabled, the status line — and those do not need 30 Hz.
   */
  useEffect(() => {
    if (!link) return
    const iState = tape !== null ? slTapeIndex(tape, 'State') : -1
    const iCap = tape !== null ? slTapeIndex(tape, 'Cap') : -1
    const iHead = tape !== null ? slTapeIndex(tape, 'Playhead') : -1
    let last = 0
    return link.onHotFrame((frame) => {
      const now = performance.now()
      if (now - last < 160) return
      last = now
      const next: Live = {
        tapeState: iState >= 0 ? (frame[iState] ?? SL_TAPE_STATE.idle) : SL_TAPE_STATE.idle,
        playhead: iHead >= 0 ? (frame[iHead] ?? 0) : 0,
        capReached: iCap >= 0 ? (frame[iCap] ?? 0) > 0.5 : false,
        peakL: 0,
        peakR: 0,
        // THE ENGINE'S monitor state, not the document's. The engine opens this
        // switch at record-start and closes it at the Law C-3 handoff
        // (D-WZ-MON-01/02), so a MON lamp drawn from `strip.monitor` would sit
        // lit over a closed gate the moment a loop closed.
        monitor: slChannelMonitorOn(frame[HotFrameLayout.slChanMonitorMask] ?? 0, strip.channel),
      }
      // …and the DOCUMENT follows it, so a save stores what was true rather
      // than an intent the engine already overruled.
      noteMonitor(strip, next.monitor)
      setLive((prev) =>
        // Only re-render when something a READER can see changed. The playhead
        // is excluded deliberately: it moves every frame and it is the
        // canvas's, not React's.
        prev.tapeState === next.tapeState &&
        prev.capReached === next.capReached &&
        prev.monitor === next.monitor
          ? prev
          : next,
      )
    })
  }, [link, tape, strip])

  const recording = isRecording(live)

  // The elapsed counter. Ticks only while recording, and at 1 Hz — the display
  // is m:ss, so anything faster is re-rendering to show the same string.
  useEffect(() => {
    if (!recording) {
      recStartedAt.current = null
      setRecSeconds(0)
      return
    }
    recStartedAt.current ??= performance.now()
    const id = setInterval(() => {
      if (recStartedAt.current !== null)
        setRecSeconds((performance.now() - recStartedAt.current) / 1000)
    }, 250)
    return () => clearInterval(id)
  }, [recording])

  // When recording STOPS, the material changed in a way the wave cannot see.
  const wasRecording = useRef(false)
  useEffect(() => {
    if (wasRecording.current && !recording) setRevision((r) => r + 1)
    wasRecording.current = recording
  }, [recording])

  /* ── derived state ───────────────────────────────────────────────────── */
  // A strip that is CURRENTLY recording is never "missing audio": it is making
  // some. Suppressed here so a re-record over a dead reference — which is the
  // repair — does not keep showing the failure it is fixing.
  const missing = recording ? null : unresolvedRef
  const ctx = {
    unresolvedRef: missing,
    decoding,
    feedbackMs,
    // NAMES THE ACTUAL INPUT. "records: this strip's input" was true and
    // useless — the strip could not say which input, because nothing could turn
    // a route's channel index into a name. Now it can, so the object answers
    // "what will REC capture?" with an answer you can act on.
    recordSource: input
      ? channelLabel(channels, input.left, input.right)
      : recordSourceLabel(strip),
    recSeconds: recording ? recSeconds : null,
  }
  const status = statusLine(strip, live, ctx)
  const can = enabledControls(strip, live, ctx)
  const word = stateWord(strip, live)
  const w = waveWidth(strip.cell.w)

  /* ── transport ───────────────────────────────────────────────────────── */

  /**
   * REC. The hinge between the two lives of the object, and the reason the
   * strip can claim to be one species.
   *
   * On a strip with NO element it allocates a tape, points it at this strip's
   * own channel bus and starts — so "recording is the verb that gives a strip
   * material" is true in the implementation and not just in the prose. On stop
   * the tape becomes this strip's element while `key`, `name`, `cell`, `level`,
   * `mute` and `sends` are all kept, so the box you were watching starts
   * looping without remounting. That is Law C-3 made visible.
   */
  const onRecord = async () => {
    if (!link) return
    if (recording) {
      const reply = await ask<{ path?: string }>(link, 'slRecord', {
        action: 'stop',
        tape: tape ?? 0,
      })
      // The take's path becomes this strip's `takeRef`. Without it the audio
      // exists on disk and the document has no idea, so reopening the map finds
      // an empty tape and the recording is lost to everything but a file
      // browser. One assignment, and it is the whole of "the take library
      // holds the full take, reloadable later".
      if (reply?.path)
        updateStrip(strip.key, (s) =>
          s.element.kind === 'tape'
            ? { ...s, element: { ...s.element, takeRef: reply.path as string } }
            : s,
        )
      setRevision((r) => r + 1)
      return
    }

    let index = tape
    if (index === null) {
      const free = freeTape(getMap())
      if (free === null) return // every tape is spoken for; nothing to say yet
      const element = newTapeElement(free, /* stereo */ false)
      if (!checkBudget(strip.key, element).ok) return
      updateStrip(strip.key, (s) => ({ ...s, element }))
      // Bind the channel to the new tape BEFORE recording into it: the record
      // source is this strip's channel bus, and a channel carrying nothing
      // would capture silence.
      await ask(link, 'slChannel', {
        action: 'setSource',
        channel: strip.channel,
        kind: 1,
        index: free,
      })
      index = free
    }

    // WHERE REC READS FROM — the rule, or this strip's explicit override.
    //
    // This used to be hardcoded to the channel bus, on the argument that
    // recording is always "capture this strip's bus" — one tap, one code path,
    // every source. That argument is still right for a strip with no live
    // input, and it was WRONG for one with an input: it made capture and
    // monitoring the same signal path, so silencing an input to stop feedback
    // made REC record silence. See `recordTapFor`.
    const tap = recordTapFor(
      strip,
      input,
      input ? channelLabel(channels, input.left, input.right) : null,
    )
    await ask(link, 'slRecord', {
      action: 'start',
      tape: index,
      sourceKind: tap.kind,
      chan0: tap.chan0,
      chan1: tap.chan1,
      sourceDesc: tap.label,
    })
  }

  /**
   * WHERE THIS STRIP LISTENS. A menu rather than a control on the object,
   * because picking a source is a DECISION FROM A LIST — it fails
   * pd-strip-anatomy §3.1's test ("would you do this one-handed, with sound
   * running, without reading?") — while the RESULT of the decision stays on the
   * object, in the status line, where you can see it without selecting.
   *
   * The device itself is here too: it is the same question one level up, and
   * splitting them across two surfaces would mean discovering that your inputs
   * are missing in one place and fixing it in another.
   */
  const openSourceMenu = (ev: React.MouseEvent) => {
    // The menu now carries more than the input picker (the session library, the
    // record tap), so it opens whenever ANY of its sections has an owner.
    if (!onPickInput && !onLoadSession) return
    ev.preventDefault()
    const items: MenuItem[] = []
    if (onPickInput) {
      if (channels.length === 0) {
        items.push({ kind: 'info', label: 'no inputs on this device' })
      } else {
        items.push({ kind: 'info', label: 'record from' })
        for (const c of inputChoices(channels)) {
          items.push({
            kind: 'item',
            label: c.label,
            checked: input?.left === c.left && (input?.right ?? null) === c.right,
            onSelect: () => onPickInput(c.left, c.right),
          })
        }
      }
    }
    // ⚠️ THE GRID CREATION GESTURE — how a scoopy session gets into a strip,
    // and the thing the whole per-deck session map existed to unblock.
    //
    // It belongs in this menu rather than on the object for the same reason the
    // input picker does (pd-strip-anatomy §3.1): choosing from a list of
    // sessions is not something you do one-handed with sound running. What
    // stays on the object is the RESULT — the scene pads, the tempo, and the
    // status line naming the session.
    if (onLoadSession && sessions.length > 0) {
      items.push({ kind: 'sep' })
      items.push({ kind: 'info', label: 'load a session' })
      for (const s of sessions) {
        items.push({
          kind: 'item',
          label: s.name,
          checked: strip.element.kind === 'grid' && strip.element.sessionId === s.name,
          onSelect: () => onLoadSession(s.name),
        })
      }
      // Letting go is part of the gesture. Without it a strip that took a
      // session could never become anything else, and the deck it holds is one
      // of only three.
      if (strip.element.kind === 'grid' && onDropElement) {
        items.push({
          kind: 'item',
          label: 'drop this session',
          onSelect: () => onDropElement(),
        })
      }
    }

    // WHAT REC CAPTURES. Normally the rule answers this and the menu never
    // needs looking at — but the rule cannot know that you patched another
    // strip into this one in order to record the CHAIN, and a strip that
    // silently captured only its own input would give you a take with the
    // interesting half missing. So the tap is stated, and overridable.
    items.push({ kind: 'sep' })
    items.push({ kind: 'info', label: 'REC captures' })
    const taps: { value: StripDoc['recordTap']; label: string }[] = [
      { value: null, label: input ? 'this strip’s input (default)' : 'this strip’s bus (default)' },
      { value: 'bus', label: 'this strip’s bus — everything routed in' },
      { value: 'mainMix', label: 'the main mix — what leaves the app' },
    ]
    if (input) taps.splice(1, 0, { value: 'input', label: 'this strip’s input only' })
    for (const t of taps) {
      items.push({
        kind: 'item',
        label: t.label,
        checked: strip.recordTap === t.value,
        onSelect: () => updateStrip(strip.key, (s) => ({ ...s, recordTap: t.value })),
      })
    }

    if (devices.length > 1) {
      items.push({ kind: 'sep' })
      items.push({ kind: 'info', label: 'input device' })
      for (const d of devices) {
        items.push({
          kind: 'item',
          label: d,
          checked: d === currentDevice,
          onSelect: () => void setInputDevice(link, d),
        })
      }
    }
    openMenu(items, ev.clientX, ev.clientY)
  }

  const trigger = (mode: number) => {
    if (tape === null) return
    send(link, 'slTape', { action: 'trigger', tape, mode })
  }

  return (
    <section
      className={`plane-strip sem sem-fill${selected ? ' selected' : ''}${
        strip.mute ? ' muted' : ''
      }${recording ? ' recording' : ''}`}
      data-key={strip.key}
      data-kind={strip.element.kind}
      style={{
        // L1: BOTH dimensions from the document. The single most important
        // line in this file.
        left: strip.cell.x,
        top: strip.cell.y,
        width: strip.cell.w,
        height: strip.cell.h,
        // The kind bar and every fill below inherit this one colour.
        ['--sem-color' as string]: semanticColor('deck', strip.channel),
      }}
      tabIndex={0}
      aria-label={strip.name}
    >
      {/* The 3 px full-height kind bar. Kind is carried by a large saturated
          area, never by tinting 11 px text — small coloured text is the weakest
          possible carrier of a category AND it costs contrast on the one string
          you read while scanning a plane. */}
      <span className="strip-kindbar" aria-hidden />

      <header className="strip-head" onContextMenu={onPickInput || onLoadSession ? openSourceMenu : undefined}>
        <span
          className="strip-name mono"
          title={
            onPickInput
              ? `${strip.name} — right-click to choose the input this strip records`
              : strip.name
          }
        >
          {strip.name}
        </span>
        {/* The feedback lamp's slot is reserved at all times (L2), so an alarm
            cannot shift the state word sideways. */}
        {/* THE OUT CHIP — where this strip's signal goes, stated on the object.
            `→ main` is the resting state and is shown ANYWAY: a strip that is
            not on main is the interesting case, and you can only see that if
            the normal case is visible too. Terminal routes are chips precisely
            because drawing 8 lines converging on one point would be maximum ink
            for zero information (see cables.ts). */}
        <span
          className={`strip-out mono${chips && !chips.toMain ? ' warn' : ''}`}
          title={
            chips?.toMain
              ? 'this strip reaches the main output'
              : 'this strip does NOT reach the main output'
          }
        >
          {chips?.toMain ? '▸main' : '▸—'}
        </span>
        <span className="strip-fb-slot" aria-hidden />
        <span className={`strip-state mono${recording ? ' rec' : ''}`}>{word}</span>
        {/* Fixed-width m:ss, always present: a counter that appeared on record
            would widen the head at the worst moment. */}
        <span className="strip-elapsed mono">{recording ? mmss(recSeconds) : ''}</span>
      </header>

      {/* THE ELEMENT'S OWN ROWS. A grid strip and a tape strip are the SAME
          object with different material: same box, same row heights, same
          transport and switches — only what fills the wave rect and the last
          param row differs. A grid strip that were a different size would break
          the one-species claim on sight. */}
      {/* ONE wave row, whichever element fills it. Two rows behind a ternary
          would be two boxes to keep in step, and the moment they diverged the
          two strip kinds would stop being the same object. */}
      <div className="strip-waverow">
        {isGrid ? (
          <div className="strip-scenefield" style={{ width: w, height: WAVE_H }}>
            <GridScenes
              strip={strip}
              scene={gridScene}
              queued={gridQueued}
              onSelectScene={(sc, immediate) => onSelectScene?.(sc, immediate)}
            />
          </div>
        ) : (
          <TapeWave
            link={link}
            tape={tape}
            width={w}
            revision={revision}
            loop={strip.element.kind === 'tape' ? strip.element.loop : undefined}
            missing={Boolean(missing)}
            hint={tape === null ? 'press REC to give this strip material' : undefined}
            onLoopDrag={(start, end) =>
              updateStrip(strip.key, (s) =>
                s.element.kind === 'tape'
                  ? { ...s, element: { ...s.element, loop: { enabled: true, start, end } } }
                  : s,
              )
            }
          />
        )}
        <StripMeter link={link} channel={strip.channel} />
      </div>

      {/* THE TRANSPORT ROW has a rhythm — record · verbs · switches — and that
          rhythm is its only structure. REC is 56 px with a text label and a
          lamp; the verbs are 26 px glyphs; the switches sit in a right group.
          Seven identically-sized buttons is what makes an object read as a
          form, and it is what this row exists not to be. */}
      <div className="strip-transport" data-no-drag>
        <button
          type="button"
          className={`strip-rec${recording ? ' latched' : ''}`}
          disabled={!can.record}
          onClick={() => void onRecord()}
          title={
            recording
              ? 'stop — loops instantly (Law C-3)'
              : tape === null
                ? 'record — captures this strip’s own output into a new tape'
                : 'record — replaces this tape’s material'
          }
        >
          {recording ? '■ STOP' : '● REC'}
        </button>
        <span className="strip-verbs">
          <Button
            label="⟳"
            disabled={!can.play}
            active={live.tapeState === SL_TAPE_STATE.loop}
            onClick={() => trigger(0)}
            title="loop — plays the region between the braces, forever"
          />
          <Button
            label="▸"
            disabled={!can.play}
            active={live.tapeState === SL_TAPE_STATE.oneShot}
            onClick={() => trigger(1)}
            title="one-shot — plays through once and stops"
          />
          <Button
            label="↻"
            disabled={!can.play}
            onClick={() => trigger(3)}
            title="retrigger — jumps back to the start without stopping"
          />
          <Button
            label="◼"
            disabled={!can.stop}
            onClick={() => trigger(2)}
            title="stop — leaves the playhead where it is"
          />
        </span>
        {/* TWO switches, and keeping them separate is the whole of the fix.
            MON is the strip's INPUT (does what you are recording also reach the
            channel); M is the strip's OUTPUT (does the strip reach the mix at
            all). They were conflated: `M` was the only way to stop an input
            feeding back, and it silenced the tape along with it. */}
        <span className="strip-switches">
          {/* MON is wider than the 22px switch square because it is a WORD.
              "M" and a glyph would fit the square and would also be the two
              controls this fix exists to stop people confusing — the label
              earns its pixels. */}
          <span className="strip-mon">
          <Button
            label="MON"
            active={live.monitor}
            onClick={() => setMonitor(link, strip, !live.monitor)}
            title={
              live.monitor
                ? 'monitor ON — you hear this strip’s input. Click to silence it without affecting what REC captures'
                : 'monitor OFF — the input is silent but still recorded. REC opens this by itself'
            }
          />
          </span>
          <Button
            label="M"
            active={strip.mute}
            onClick={() => setMute(link, strip, !strip.mute)}
            title="mute — silences this strip's OUTPUT, and everything routed from it"
          />
        </span>
      </div>

      {/* L3: ONE line, always present, chosen by the priority ladder. Reserved
          even when there is nothing to say. */}
      <div className={`strip-status mono ${status.tone}`} title={status.text}>
        {status.text}
      </div>

      <div className="strip-params">
        <div className="ds-row strip-row">
          <span className="ds-label mono">level</span>
          <GeoRange
            value={strip.level}
            min={0}
            max={1.5}
            step={0.01}
            onChange={(v) => liveSetLevel(link, strip, v)}
            onDoubleClick={() => {
              liveSetLevel(link, strip, 1)
              flushLiveEdits()
            }}
            title="level — double-click for unity"
          />
          <span className="ds-value mono">{formatGain(strip.level)}</span>
        </div>

        {/* The four sends. One row of micro-faders rather than four rows: the
            channel owns the send LEVEL, and where each send GOES is a route in
            the document — so this is four values, not four decisions. */}
        <div className="ds-row strip-row strip-sends" role="group" aria-label="FX sends">
          <span className="ds-label mono">send</span>
          {strip.sends.map((value, i) => (
            <span
              key={i}
              className="strip-micro sem sem-fill"
              style={{ ['--sem-color' as string]: semanticColor('send', i) }}
            >
              <input
                className="ch-micro"
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={value}
                aria-label={`send ${i + 1}`}
                title={`send ${i + 1}`}
                style={{
                  background: `linear-gradient(to top, var(--fill) ${value * 100}%, var(--bg-raised) ${value * 100}%)`,
                }}
                onChange={(e) => liveSetSend(link, strip, i, Number(e.target.value))}
                onDoubleClick={() => {
                  liveSetSend(link, strip, i, 0)
                  flushLiveEdits()
                }}
              />
            </span>
          ))}
        </div>

        {/* The LAST PARAM ROW. Varispeed on a tape, sync/tempo/compose on a
            grid — the same 18 px slot either way. PRESENT AND INERT when there
            is no material (L2) rather than conditionally rendered: this row
            appearing would move nothing above it but WOULD change the object's
            height, and the box is authoritative. */}
        {isGrid ? (
          <GridControls
            strip={strip}
            onSetBpm={(bpm) =>
              updateStrip(strip.key, (x) =>
                x.element.kind === 'grid' ? { ...x, element: { ...x.element, bpm } } : x,
              )
            }
            onToggleSync={() =>
              updateStrip(strip.key, (x) =>
                x.element.kind === 'grid'
                  ? { ...x, element: { ...x.element, syncToMaster: !x.element.syncToMaster } }
                  : x,
              )
            }
            onCompose={() => onCompose?.()}
          />
        ) : (
        <div className={`ds-row strip-row${can.rate ? '' : ' ds-row-disabled'}`}>
          <span className="ds-label mono">rate</span>
          <GeoRange
            value={strip.element.kind === 'tape' ? strip.element.rate : 1}
            min={RATE_MIN}
            max={RATE_MAX}
            step={0.01}
            origin="center"
            disabled={!can.rate}
            onChange={(v) => liveSetRate(link, strip, snapUnity(v))}
            onDoubleClick={() => {
              liveSetRate(link, strip, 1)
              flushLiveEdits()
            }}
            title="rate — negative runs it backwards; double-click for 1.00×"
          />
          <span
            className={`ds-value mono${
              strip.element.kind === 'tape' && strip.element.rate < 0 ? ' warn' : ''
            }`}
          >
            {formatRate(strip.element.kind === 'tape' ? strip.element.rate : 1)}
          </span>
        </div>
        )}
      </div>
    </section>
  )
}

/** Linear gain as dB, in a fixed-width field. `−∞` at silence, because "−60.0"
    would suggest the fader still passes something. */
export function formatGain(level: number): string {
  if (level <= 0.0001) return '  −∞ '
  const db = 20 * Math.log10(level)
  return `${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(1)}`
}

/**
 * What REC would capture, in words. The strip must be able to answer "what am I
 * listening to?" in every state — a player that cannot state its provenance
 * becomes an anonymous buffer the moment it has material.
 */
function recordSourceLabel(strip: StripDoc): string | null {
  switch (strip.element.kind) {
    case 'none':
      return 'this strip’s input'
    case 'tape':
      return `tape ${strip.element.index}`
    case 'grid':
      return `deck ${strip.element.deck}`
  }
}
