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
  updateGridTempo,
  updateStrip,
  updateTapeTempo,
} from '../state/mapStore.ts'
import { tapeEffectiveRate } from '../persist/tempo.ts'
import { flushAutosave, useCompanion } from '../store/companionEngine.ts'
import { useContextMenu, type MenuItem } from '../design/ContextMenu.tsx'
import type { Chips } from './cables.ts'
import { channelLabel, inputChoices, setInputDevice, useDeviceStore } from './devices.ts'
import { ask, send } from './send.ts'
import { StripMeter, METER_W } from './StripMeter.tsx'
import { DeckFace } from './deckTile.tsx'
import { DECK_CELL, DEFAULT_CELL, isDeckCell } from './planeLayout.ts'
import { GridControls, GridScenes, nextTempoMode } from './GridElement.tsx'
import { TapeWave, WAVE_H } from './TapeWave.tsx'
import {
  BR_SCALE,
  brScaleIndex,
  IDLE_LIVE,
  enabledControls,
  freeTape,
  isRecording,
  mmss,
  newTapeElement,
  RECORD_SOURCE,
  recordTapFor,
  stateWord,
  statusLine,
  type Live,
} from './stripOps.ts'
import { setNudge, useNudge } from '../state/nudgeStore.ts'

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

/**
 * THE INPUT DEVICE SECTION of the ⋯ menu (P9-5a).
 *
 * ⚠️ THE SECTION IS ALWAYS RENDERED, and — exactly as with the session list
 * above — the empty case is the reason. It used to be gated on
 * `devices.length > 1`, so a machine with one input device showed no device
 * section at all, no heading and no hint. **The gate WAS the defect**: the
 * person who needs to hear about a virtual device is precisely the one who has
 * installed nothing and therefore has one device, so the gate hid the answer
 * from everybody who had the question. A control that is absent teaches
 * nothing; one that says what it needs teaches the next step.
 *
 * The info line is the whole of the interim other-app-audio path
 * (`docs/specs/other-app-audio.md`, D-WZ-VDEV-02): route another app into a
 * virtual device and pick it here. Nothing downstream knows the device is
 * virtual, which is why that path costs a sentence rather than code.
 *
 * The one-device line names the relaunch caveat because it is the other half of
 * why the list is short: `refreshDevices` runs once from the plane's boot
 * effect (`PlanePanel.tsx:453-458`) and `slDevices` has no rescan action, so a
 * driver installed while the app is open is invisible until it restarts
 * (spec §2c).
 *
 * Exported and pure so the section is assertable without a DOM — the same
 * shape `panelsMenuItems`/`mapMenuItems` use in `PlanePanel.tsx`, and the only
 * way a menu built inside an event handler can be tested at all.
 */
export function inputDeviceMenuItems(
  devices: readonly string[],
  currentDevice: string,
  onPick: (name: string) => void,
): MenuItem[] {
  const items: MenuItem[] = [
    { kind: 'sep' },
    { kind: 'info', label: 'input device' },
    { kind: 'info', label: 'another app’s audio → a virtual device (BlackHole/Loopback)' },
  ]
  if (devices.length > 1) {
    for (const d of devices)
      items.push({ kind: 'item', label: d, checked: d === currentDevice, onSelect: () => onPick(d) })
  } else if (devices.length === 1) {
    items.push({ kind: 'info', label: `only “${devices[0]}” — install one, then relaunch` })
  } else {
    // Empty means the host answered with nothing OR was never asked — the
    // browser dev host has no device layer at all (spec §1) and its refusal
    // leaves the store empty. `useDeviceStore.loaded` is the field that tells
    // those apart; this line is deliberately true of both, because neither can
    // be picked from and guessing which would be the kind of confident wrong
    // label the status line exists to prevent.
    items.push({ kind: 'info', label: 'no input devices reported' })
  }
  return items
}

export function Strip({
  strip,
  link,
  selected,
  unresolvedRef = null,
  decoding = null,
  feedbackMs = null,
  noOutput = false,
  takeName = null,
  takeSeconds = null,
  input = null,
  onPickInput,
  peerStrips = [],
  busSources = [],
  onRecordFromStrip,
  onRecordIntoLooper,
  chips,
  gridScene = 'A',
  gridQueued = null,
  gridEnabledScenes,
  onAddScene,
  composing = false,
  masterBpm = 120,
  onSelectScene,
  onCompose,
  sessions = [],
  onLoadSession,
  onDropElement,
  gridPlaying = false,
  onGridTransport,
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
  /** Nothing carries this strip's output anywhere (P3-U4) — supplied by the
      plane, which owns the routing graph. */
  noOutput?: boolean
  /** The resolved take's display name and length, once it has material. */
  takeName?: string | null
  takeSeconds?: number | null
  /** The device input patched into this strip, if any — what REC will capture.
      Supplied by the plane, which owns the map, rather than read here: a strip
      must not go looking through the routing graph for itself. */
  input?: { left: number; right: number | null } | null
  /** Re-point this strip's input route. */
  onPickInput?: (left: number, right: number | null) => void
  /** P3-R2: the OTHER strips, offered as record sources in the ⋯ menu. */
  peerStrips?: { key: string; name: string }[]
  /** Names of strips whose output is routed into this one — the status line's
      answer to "what will a bus-tap REC actually capture". */
  busSources?: string[]
  /** Patch that strip's output into this one (consent flow included) — the
      other half of the one-gesture "record from ▸ STRIP N". */
  onRecordFromStrip?: (srcKey: string, at: { x: number; y: number }) => void
  /** P3-R3: REC on a GRID strip records into its linked looper strip instead
      of overwriting the grid element (one kind per strip). */
  onRecordIntoLooper?: () => void
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
  /** The session's enabled scene prefix — the pads render THESE (P3-U8).
      Undefined = session not arrived; GridScenes falls back to all eight. */
  gridEnabledScenes?: readonly SceneLetter[]
  /** Enable one more scene (the pad row's `+`). */
  onAddScene?: () => void
  /** P3-C2: a compose window owns this strip's deck — the plane's publish
      lanes for it (scenes, grid transport, tempo) lock until it closes. The
      channel tier (level, sends, mute, MON) stays live: it never publishes. */
  composing?: boolean
  /** The plane's master tempo. GRID strips only, and passed in for the same
      reason `chips` is: one subscription in the plane beats one per strip to a
      value every strip shares. It is what the strip resolves its SYNC readout
      against — a synced deck showing its own bpm and not the one it will run at
      is a control you have to test by ear. */
  masterBpm?: number
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
  /** GRID strips: is this strip's DECK running? From the session store, not the
      HotFrame — a deck's transport is the world's `isPlaying`, which the store
      owns and publishes; the HotFrame's tape state says nothing about it. */
  gridPlaying?: boolean
  /** GRID strips: the transport verbs, in the vocabulary a deck actually has. */
  onGridTransport?: (action: 'play' | 'stop' | 'restart') => void
}) {
  const tape = strip.element.kind === 'tape' ? strip.element.index : null
  const channels = useDeviceStore((d) => d.channels)
  const devices = useDeviceStore((d) => d.devices)
  const currentDevice = useDeviceStore((d) => d.current)
  const { openMenu } = useContextMenu()
  const isGrid = strip.element.kind === 'grid'
  // THE DECK TILE (P3-D4-1): expansion IS the cell size — the document carries
  // only geometry, so the predicate is the one definition and a saved map
  // reopens exactly as arranged. Collapse restores DEFAULT_CELL to the pixel:
  // nothing built is lost, expand is a reveal, not a mode.
  const expanded = isGrid && isDeckCell(strip.cell)
  // DECK VERB STATE (P3-D4-2): the per-deck TRUTH for the header lamps — BR and
  // REV live in DeckState since this row precisely so a master fan-out and a
  // tile's own hand read the same fact. Hooks run unconditionally (deck −1 on
  // non-grid strips just selects the idle defaults).
  const verbDeck = strip.element.kind === 'grid' ? strip.element.deck : -1
  const deckBr = useCompanion((c) => (verbDeck >= 0 ? (c.decks[verbDeck]?.beatRepeat ?? null) : null))
  const deckRev = useCompanion((c) => (verbDeck >= 0 ? (c.decks[verbDeck]?.reverse ?? false) : false))
  const nudge = useNudge((s) => (verbDeck >= 0 ? (s.deltas[verbDeck] ?? 0) : 0))
  // The scale the NEXT latch will use; while latched, the window's own scale
  // wins the label (a master fan-out may have set a different one).
  const [brIdx, setBrIdx] = useState(3) // '2' — the classic window
  const latchedIdx = brScaleIndex(deckBr)
  const brLabel = (deckBr && latchedIdx >= 0 ? BR_SCALE[latchedIdx] : BR_SCALE[brIdx])?.label ?? '2'
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
    noOutput,
    takeName,
    takeSeconds,
    // NAMES THE ACTUAL INPUT. "records: this strip's input" was true and
    // useless — the strip could not say which input, because nothing could turn
    // a route's channel index into a name. Now it can, so the object answers
    // "what will REC capture?" with an answer you can act on.
    // P3-R2: a bus tap with named sources says WHO feeds it — "this strip's
    // bus" was true and anonymous; "STRIP 2 → this bus" is an answer.
    recordSource:
      strip.recordTap === 'bus' && busSources.length > 0
        ? `${busSources.join(' + ')} → this bus`
        : input
          ? channelLabel(channels, input.left, input.right)
          : recordSourceLabel(strip),
    recSeconds: recording ? recSeconds : null,
  }
  const status = statusLine(strip, live, ctx)
  // P3-C2: one publisher at a time. While a compose window owns this deck the
  // grid's publish verbs read as disabled-with-a-reason (L2: fill, not
  // presence); everything channel-tier keeps working.
  const lock = composing && strip.element.kind === 'grid'
  const canBase = enabledControls(strip, live, ctx)
  const can = lock ? { ...canBase, play: false, oneShot: false, stop: false, record: false } : canBase
  const word = lock ? 'COMP' : stateWord(strip, live, gridPlaying)
  const w = waveWidth(strip.cell.w)

  /* ── tape sync (P3-2b-3) ─────────────────────────────────────────────── */
  const tapeEl = strip.element.kind === 'tape' ? strip.element : null
  const tapeBpmForSync = tapeEl?.bpm ?? null
  // "Synced" on screen means EFFECTIVE — intent on + a bpm to resolve against.
  const tapeSynced = tapeEl?.syncToMaster === true && tapeBpmForSync !== null
  // What the rate row SHOWS: the effective rate under the master while synced,
  // the hand's own rate otherwise — the readout must never disagree with what
  // the engine was sent.
  const tapeShownRate = tapeEl ? tapeEffectiveRate(tapeEl, masterBpm) : 1

  /* ── overdub punch (P3-U3 / D-WZ-OVERDUB-01) ─────────────────────────── */
  // UI-side latch: the engine has no overdub HotFrame flag (deliberately — the
  // tape genuinely stays `looping` while layering), so the lamp is ours.
  const [punching, setPunching] = useState(false)
  // The punch layers this strip's INPUT into the loop (D-WZ-MON-02's "the
  // input AGAINST the loop") — the engine's overdub taps device-input channels
  // only, so a strip without an input has nothing to layer and the button says
  // so instead of arming a punch that would sum silence.
  const canPunch =
    tapeEl !== null && input !== null && !recording && live.tapeState === SL_TAPE_STATE.loop
  const onPunch = async (replace: boolean) => {
    if (!link || tape === null) return
    if (punching) {
      // Punch OUT closes the pass's take — the RAM mix is destructive; the
      // file is what preserves this pass.
      await ask(link, 'slTape', { action: 'overdubStop', tape })
      setPunching(false)
      setRevision((v) => v + 1) // the material changed under the wave
      return
    }
    if (!canPunch || !input) return
    const r = await ask(link, 'slTape', {
      action: 'overdubStart',
      tape,
      mode: replace ? 1 : 0, // SUM layers; ⌥ REPLACE erases what was under it
      sourceKind: RECORD_SOURCE.deviceInput,
      chan0: input.left,
      chan1: input.right ?? -1,
      sourceDesc: `overdub ${channelLabel(channels, input.left, input.right)}`,
      bpmAtStart: masterBpm,
    })
    if (r) setPunching(true)
  }

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
      // P3-R3: a GRID strip's REC never overwrites the grid — one kind per
      // strip (D-SL-MORPH-01, retiring P3-X1's recorded defect where capture
      // worked and the session silently fell out of the document). The plane
      // spawns (or targets) a looper strip patched from this strip's bus and
      // the capture happens THERE; this strip's element does not move.
      if (strip.element.kind === 'grid') {
        onRecordIntoLooper?.()
        return
      }
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
      // P3-2b-1: stamp the master tempo into the take's sidecar. The recorded
      // loop's own bpm derives from this — it is what makes a tape syncable
      // later without guessing.
      bpmAtStart: masterBpm,
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
    // Ask the disk again as the menu opens — the library can change from
    // ANOTHER window (the sessions panel), and a menu built from a stale list
    // reads as "there are no sessions" (found in the first real-host walk).
    // The refresh is async; the focus-refresh in PlanePanel usually got there
    // first, and the re-render updates the list for the next open regardless.
    void useCompanion.getState().refresh()
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
    // P3-R2: OTHER STRIPS as record sources — one gesture for "loop that
    // strip". Selecting one patches that strip's output into this one (with
    // the wouldCycle consent flow, in the plane's hands) AND sets the tap to
    // the bus, so the very next REC captures the chain. This is the signed
    // one-kind-per-strip model's own gesture: a looper strip records a session
    // strip by ROUTING, not by sharing a box.
    if (onRecordFromStrip && peerStrips.length > 0) {
      for (const p of peerStrips) {
        items.push({
          kind: 'item',
          label: `${p.name} → this strip’s bus`,
          checked: strip.recordTap === 'bus' && busSources.includes(p.name),
          onSelect: () => {
            updateStrip(strip.key, (s) => ({ ...s, recordTap: 'bus' }))
            onRecordFromStrip(p.key, { x: ev.clientX, y: ev.clientY })
          },
        })
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
    // ⚠️ THE SECTION IS ALWAYS RENDERED, and the empty case is the reason. It
    // used to be gated on `sessions.length > 0`, so an empty library made the
    // whole thing VANISH — no heading, no hint, nothing naming what was
    // missing. Combined with the merged app having had no door to the session
    // library at all, that made a grid deck (and therefore the entire grid
    // transport and tempo surface) unreachable, with the UI silent about why.
    // A control that is absent teaches nothing; one that says what it needs
    // teaches the next step.
    if (onLoadSession) {
      items.push({ kind: 'sep' })
      items.push({ kind: 'info', label: 'load a session' })
      if (sessions.length === 0)
        items.push({ kind: 'info', label: 'none yet — make one in "library ▾"' })
      // P3-C2: while a compose window owns this deck, swapping or dropping its
      // session under the window would split the document in two. The rows
      // stay visible (fill, not presence) but inert, with the reason named.
      if (composing)
        items.push({ kind: 'info', label: 'editing in the compose window — close it first' })
      for (const s of sessions) {
        items.push({
          kind: 'item',
          label: s.name,
          checked: strip.element.kind === 'grid' && strip.element.sessionId === s.name,
          disabled: composing,
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
          disabled: composing,
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

    if (onPickInput)
      items.push(
        ...inputDeviceMenuItems(devices, currentDevice, (d) => void setInputDevice(link, d)),
      )
    openMenu(items, ev.clientX, ev.clientY)
  }

  /**
   * THE TRANSPORT, FOR WHATEVER THIS STRIP HOSTS (P3-1).
   *
   * One vocabulary, every element. This used to reach `slTape` unconditionally
   * and return early without a tape — so a scoopy deck sat in a strip and
   * IGNORED every verb on it, which is the gap the four-domain goal names as
   * "deck transport, controlled universally".
   *
   * A deck needs no new ABI point: `sl_snapshot_begin(e, deck, bpm, is_playing,
   * start_step)` already carries the flag per deck, and publishing a world is
   * how it is set. `companionEngine.play(deck)/stop(deck)` do exactly that.
   *
   * ⚠️ The verbs are not all 1:1, and pretending otherwise would be the lie.
   * A tape has loop / one-shot / retrigger / stop. A sequenced pattern REPEATS
   * BY NATURE, so ⟳ is simply "play" and ▸ has no meaning — it stays rendered
   * and inert (layout law L2) rather than being given a fake behaviour.
   */
  const trigger = (mode: number) => {
    if (isGrid) {
      switch (mode) {
        case 0: // ⟳ — a pattern loops by nature, so this is play
          onGridTransport?.('play')
          return
        case 3: // ↻ — retrigger: back to step 0 without leaving the transport
          onGridTransport?.('restart')
          return
        case 2: // ◼
          onGridTransport?.('stop')
          return
        default: // ▸ one-shot has no sequencer meaning; the button is inert
          return
      }
    }
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
        {/* ⚠️ A VISIBLE DOOR TO THE STRIP'S MENU, and it is not a convenience.
            This menu is the ONLY route to loading a scoopy session, a session is
            the only route to a grid deck, and every control P3-1 and P3-2 built
            lives on a grid strip. All of that hung on RIGHT-CLICK — an invisible
            gesture that turned out not to reach the page at all in the JUCE
            WKWebView host, which made two phases of work unreachable in the
            shipped app while every gate stayed green.

            Right-click still works (and is still the fast path for anyone who
            knows it). But the only route to a feature must not be a gesture that
            a host can silently swallow, and "you cannot discover it" and "your
            host does not deliver it" have exactly the same symptom. */}
        {(onPickInput || onLoadSession) && (
          <button
            type="button"
            className="strip-menu"
            aria-label="strip menu"
            title="this strip’s source, session and record tap"
            onClick={openSourceMenu}
          >
            ⋯
          </button>
        )}
        <span
          className="strip-name mono"
          title={
            onPickInput
              ? `${strip.name} — ⋯ or right-click to choose the input this strip records`
              : strip.name
          }
        >
          {strip.name}
        </span>
        {/* EXPAND ⇄ COLLAPSE (P3-D4-1, D-SL-MORPH-01): the strip becomes the
            deck — the expanded tile hosts the REAL GridPanel at DJ density.
            A visible button, not a gesture, for the same reason the ⋯ menu is
            one: the only route to a feature must not be swallowable. Grid
            strips only — a looper strip has no deck rows to reveal. */}
        {isGrid && (
          <button
            type="button"
            className="strip-expand"
            aria-label={expanded ? 'collapse strip' : 'expand strip'}
            title={
              expanded
                ? 'collapse — back to the compact strip'
                : 'expand — this deck’s real DJ rows (waveforms, trim, M/S, DSP) inside the strip'
            }
            onClick={() =>
              updateStrip(strip.key, (s) => ({
                ...s,
                cell: expanded
                  ? { ...s.cell, w: DEFAULT_CELL.w, h: DEFAULT_CELL.h }
                  : { ...s.cell, w: DECK_CELL.w, h: DECK_CELL.h },
              }))
            }
          >
            {expanded ? '⤡' : '⤢'}
          </button>
        )}
        {/* DECK VERBS (P3-D4-2, the STRIP-DECK sketch's header row): scoopy's
            own transport hand — ▶ · REV · BR+scale · nudge · SAVE · ⏏ — at
            deck scope, in the expanded tile only (the collapsed 340px header
            has no room, and the master bar already fans BR/REV everywhere).
            SYNC is deliberately NOT here: the tile's own grid row carries it
            (one control, one home). */}
        {expanded && verbDeck >= 0 && (
          <span className="strip-deckverbs" data-no-drag>
            <button
              type="button"
              className={`sdv mono${gridPlaying ? ' latched' : ''}`}
              disabled={lock}
              onClick={() => onGridTransport?.(gridPlaying ? 'stop' : 'play')}
              title={gridPlaying ? 'stop this deck' : 'play this deck'}
            >
              ▶
            </button>
            <button
              type="button"
              className={`sdv mono${deckRev ? ' latched' : ''}`}
              disabled={lock}
              onClick={() => useCompanion.getState().setReverse(verbDeck, !deckRev)}
              title={deckRev ? 'play forward again' : 'REV — this session backwards, true tape reverse'}
            >
              REV
            </button>
            <button
              type="button"
              className={`sdv mono${deckBr ? ' latched' : ''}`}
              disabled={lock}
              onClick={() => {
                const sc = BR_SCALE[brIdx] ?? BR_SCALE[3]!
                useCompanion
                  .getState()
                  .setBeatRepeat(
                    verbDeck,
                    deckBr ? null : { startStep: 0, length: sc.length, subdivision: sc.subdivision },
                  )
              }}
              title={deckBr ? 'release the beat repeat' : 'beat repeat — loop the window on this deck'}
            >
              BR
            </button>
            <button
              type="button"
              className="sdv mono"
              disabled={lock}
              onClick={() => {
                const cur = deckBr && latchedIdx >= 0 ? latchedIdx : brIdx
                const next = (cur + 1) % BR_SCALE.length
                setBrIdx(next)
                if (deckBr) {
                  const sc = BR_SCALE[next]!
                  useCompanion
                    .getState()
                    .setBeatRepeat(verbDeck, { startStep: 0, length: sc.length, subdivision: sc.subdivision })
                }
              }}
              title="beat-repeat length — 16…2 whole steps, then 1/2…1/32 rolls (live while latched)"
            >
              {brLabel}
            </button>
            {/* NUDGE — the pitch-fader hand: hold to bend, release to snap
                back, NEVER the document (the U5 distinction made flesh). The
                law bends the SYNCED target, so a free deck honestly offers
                nothing to bend. */}
            {(['‹', '›'] as const).map((glyph) => {
              const delta = glyph === '‹' ? -4 : 4
              const synced = strip.element.kind === 'grid' && strip.element.syncToMaster
              return (
                <button
                  key={glyph}
                  type="button"
                  className={`sdv mono${nudge === delta ? ' latched' : ''}`}
                  disabled={lock || !synced}
                  onPointerDown={() => setNudge(link, verbDeck, delta)}
                  onPointerUp={() => setNudge(link, verbDeck, 0)}
                  onPointerLeave={() => setNudge(link, verbDeck, 0)}
                  onPointerCancel={() => setNudge(link, verbDeck, 0)}
                  title={
                    synced
                      ? `nudge — hold to bend ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} BPM, snaps back on release`
                      : 'nudge bends the SYNCED tempo — turn SYNC on first'
                  }
                >
                  {glyph}
                </button>
              )
            })}
            <button
              type="button"
              className="sdv mono"
              onClick={() => void flushAutosave()}
              title="save now — edits autosave; this flushes the pending write immediately"
            >
              SAVE
            </button>
            <button
              type="button"
              className="sdv mono"
              disabled={lock || !onDropElement}
              onClick={() => onDropElement?.()}
              title="eject — drop this session from the strip (the library keeps it)"
            >
              ⏏
            </button>
          </span>
        )}
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
          <div
            className={`strip-scenefield${lock ? ' locked' : ''}`}
            style={{ width: w, height: WAVE_H }}
            title={lock ? 'editing in the compose window ⇱ — close it to play scenes here' : undefined}
          >
            <GridScenes
              strip={strip}
              scene={gridScene}
              queued={gridQueued}
              enabledScenes={gridEnabledScenes}
              onAddScene={lock ? undefined : onAddScene}
              onSelectScene={(sc, immediate) => {
                if (!lock) onSelectScene?.(sc, immediate)
              }}
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
            // SCRUB (P3-U3): `can.scrub` finally has its consumer — the wave's
            // unmodified drag, per pd-scrub-interaction. The engine owns the
            // physics (rate from the gap) and arms the cue on release.
            canScrub={can.scrub}
            onScrub={{
              begin: (frame) => {
                if (tape === null) return
                send(link, 'slTape', { action: 'scrubBegin', tape })
                send(link, 'slTape', { action: 'scrubTo', tape, frame })
              },
              to: (frame) => {
                if (tape !== null) send(link, 'slTape', { action: 'scrubTo', tape, frame })
              },
              end: () => {
                if (tape !== null) send(link, 'slTape', { action: 'scrubEnd', tape })
              },
            }}
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

      {/* THE DECK'S OWN ROWS (P3-D4-1): the real GridPanel at DJ density,
          revealed by the expanded cell. Sits between the pads and the channel
          row per the signed sketch; scrolls in its own overflow, never the
          plane's. Only in the expanded box — presence follows the GEOMETRY the
          document carries, so the collapsed strip is byte-identical to before. */}
      {expanded && strip.element.kind === 'grid' && (
        <DeckFace link={link} element={strip.element} masterBpm={masterBpm} />
      )}

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
                ? strip.element.kind === 'grid'
                  ? 'record — captures this deck into its looper strip (spawned beside it; press ■ there)'
                  : 'record — captures this strip’s own output into a new tape'
                : 'record — replaces this tape’s material'
          }
        >
          {recording ? '■ STOP' : '● REC'}
        </button>
        <span className="strip-verbs">
          <Button
            label="⟳"
            disabled={!can.play}
            active={isGrid ? gridPlaying : live.tapeState === SL_TAPE_STATE.loop}
            onClick={() => trigger(0)}
            title="loop — plays the region between the braces, forever"
          />
          <Button
            label="▸"
            disabled={!can.oneShot}
            active={!isGrid && live.tapeState === SL_TAPE_STATE.oneShot}
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
          {/* OVR (P3-U3): sound-on-sound into the playing loop, the wizard
              power the merge exists to keep. A raw button because ⌥ chooses
              REPLACE for this punch and the shared Button drops the event. */}
          {!isGrid && (
            <button
              type="button"
              className={`strip-ovr mono${punching ? ' latched' : ''}`}
              disabled={!punching && !canPunch}
              onClick={(e) => void onPunch(e.altKey)}
              title={
                punching
                  ? 'punch OUT — the pass lands as its own take'
                  : !canPunch
                    ? input === null
                      ? 'overdub layers this strip’s INPUT into the loop — patch an input first (⋯)'
                      : 'overdub needs a LOOPING tape — press ⟳ first'
                    : 'punch IN — layers the input into the loop (sound-on-sound) · ⌥ replaces instead'
              }
            >
              OVR
            </button>
          )}
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
            locked={lock}
            masterBpm={masterBpm}
            nudgeBpm={nudge}
            // ⚠️ `updateGridTempo`, not `updateStrip`. Every one of these has to
            // reach the ENGINE as well as the document — they used to write the
            // document only, and appeared to work because an unrelated
            // publish-time re-assert happened to re-send the ratio afterwards.
            onSetBpm={(bpm) => updateGridTempo(strip.key, link, { bpm })}
            onToggleSync={() =>
              updateGridTempo(strip.key, link, {
                syncToMaster: !(strip.element.kind === 'grid' && strip.element.syncToMaster),
              })
            }
            onCycleTempoMode={() =>
              updateGridTempo(strip.key, link, {
                tempoMode:
                  strip.element.kind === 'grid'
                    ? nextTempoMode(strip.element.tempoMode)
                    : 'timeStretch',
              })
            }
            onCompose={() => onCompose?.()}
          />
        ) : (
        <div className={`ds-row strip-row${can.rate ? '' : ' ds-row-disabled'}`}>
          {/* SYNC, ON A TAPE (P3-2b-3) — the mission's "a deck syncs like a
              loop does", from the loop's side, with the SAME control the grid
              row carries. timePitch/varispeed: pitch moves with rate, which is
              honest tape behaviour and the D-3 zero-latency default; the
              pitch-preserving stretch is P3-2b-5. Dim without a bpm — a tape
              that cannot state its tempo cannot sync, and the title says where
              the bpm comes from. */}
          {strip.element.kind === 'tape' && (
            <button
              type="button"
              className={`strip-sync${tapeSynced ? ' active' : ''}`}
              disabled={!can.rate || tapeBpmForSync === null}
              title={
                tapeBpmForSync === null
                  ? 'sync needs a bpm — recorded takes infer one; set it in the inspector otherwise'
                  : tapeSynced
                    ? `synced — this tape runs at ${formatRate(tapeShownRate)} against the plane’s master (varispeed: pitch moves too)`
                    : 'free — this tape runs at its own rate'
              }
              onClick={() =>
                // The raw INTENT field, not the effective state: toggling off a
                // sync whose bpm went missing must actually clear the intent.
                updateTapeTempo(strip.key, link, {
                  syncToMaster: !(tapeEl?.syncToMaster === true),
                })
              }
            >
              {tapeSynced ? 'SYNC' : 'FREE'}
            </button>
          )}
          {/* HOW following costs (P3-2b-5): T+P = varispeed (pitch moves,
              zero latency — the tape default) · STR = the stretcher (pitch
              held, group delay accepted). Two modes only: tempoOnly is a
              step-clock concept a tape has no steps for. */}
          {strip.element.kind === 'tape' && (
            <button
              type="button"
              className={`strip-tempomode${tapeSynced ? ' active' : ''}`}
              aria-label="tape tempo mode"
              title={
                tapeEl?.tempoMode === 'timeStretch'
                  ? 'stretch — follows tempo with the pitch left where it is (adds ~0.1 s of latency)'
                  : 'time + pitch — varispeed, like a turntable: tempo and pitch move together'
              }
              onClick={() =>
                updateTapeTempo(strip.key, link, {
                  tempoMode: tapeEl?.tempoMode === 'timeStretch' ? 'timePitch' : 'timeStretch',
                })
              }
            >
              {tapeEl?.tempoMode === 'timeStretch' ? 'STR' : 'T+P'}
            </button>
          )}
          <GeoRange
            value={tapeShownRate}
            min={RATE_MIN}
            max={RATE_MAX}
            step={0.01}
            origin="center"
            // Sync OWNS the rate: a drag that fought the sync engine would snap
            // back on the next tempo pass and teach that the control is broken.
            disabled={!can.rate || tapeSynced}
            onChange={(v) => liveSetRate(link, strip, snapUnity(v))}
            onDoubleClick={() => {
              if (tapeSynced) return
              liveSetRate(link, strip, 1)
              flushLiveEdits()
            }}
            title={
              tapeSynced
                ? 'rate is owned by SYNC — free the tape to set it by hand'
                : 'rate — negative runs it backwards; double-click for 1.00×'
            }
          />
          <span className={`ds-value mono${tapeShownRate < 0 ? ' warn' : ''}`}>
            {formatRate(tapeShownRate)}
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
      // The session BY NAME — "deck 0" is an engine slot, not a provenance.
      return `${strip.element.sessionId} · deck ${strip.element.deck}`
  }
}
