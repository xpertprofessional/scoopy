/**
 * The plane's decisions, as pure functions.
 *
 * Everything here is logic a component would otherwise bury in JSX: which
 * engine slot a new strip gets, what one line of status to show, whether the
 * transport is live. Extracted so it can be tested exhaustively with no DOM and
 * no engine — the same split `djProjection.ts` and `gridOps.ts` already use,
 * and the reason `Strip.tsx` can stay a rendering of state rather than a place
 * where state is decided.
 */
import { SL_TAPE_STATE } from '../../protocol/schema.ts'
import { DEFAULT_CELL, type Cell } from './planeLayout.ts'
import type { Element, PlaneMap, Route, Strip } from '../persist/mapDocument.ts'

/** Engine capacities. The document already bounds these (channel 0..7, tape
    0..7); named here so the allocators read as intent rather than magic. */
export const MAX_CHANNELS = 8
export const MAX_TAPES = 8
/** Grid decks the pinned core can hold at once (`sl_deck_count()` = kMaxDecks).
    Smaller than the tape and channel spaces, and not a preference — it is a
    property of the core the merge vendors. */
export const MAX_DECKS = 3

/* ── allocation ───────────────────────────────────────────────────────────── */

/**
 * The lowest engine channel no strip is using, or null when the mixer is full.
 *
 * LOWEST-FREE rather than next-highest: channels are a fixed set of eight
 * mixer lanes, not a growing list, so a plane that has had strips come and go
 * must reuse the holes or it runs out at eight lifetime strips instead of eight
 * simultaneous ones.
 */
export function freeChannel(map: PlaneMap): number | null {
  const used = new Set(map.strips.map((s) => s.channel))
  for (let c = 0; c < MAX_CHANNELS; c++) if (!used.has(c)) return c
  return null
}

/** The lowest tape index no strip's element occupies, or null when all eight
    are taken. Tapes are their OWN index space, independent of grid decks. */
export function freeTape(map: PlaneMap): number | null {
  const used = new Set(
    map.strips.flatMap((s) => (s.element.kind === 'tape' ? [s.element.index] : [])),
  )
  for (let t = 0; t < MAX_TAPES; t++) if (!used.has(t)) return t
  return null
}

/**
 * The lowest GRID DECK no strip holds, or null when all three are taken.
 *
 * A third index space, and a much smaller one: the pinned core holds three deck
 * worlds (`sl_deck_count()`), against eight tapes and eight channels. Lowest-free
 * for the same reason as the others — decks are a fixed set of engine slots, not
 * a growing list, so a plane that has had grid strips come and go must reuse the
 * holes or it runs out at three lifetime grid strips instead of three
 * simultaneous ones.
 */
export function freeDeck(map: PlaneMap): number | null {
  const used = new Set(
    map.strips.flatMap((s) => (s.element.kind === 'grid' ? [s.element.deck] : [])),
  )
  for (let d = 0; d < MAX_DECKS; d++) if (!used.has(d)) return d
  return null
}

let keySeq = 0
/** A stable, unique strip key. Keys must survive an element changing under a
    strip — that is what stops a strip remounting when it gains material, which
    is what makes the record→loop transition a repaint rather than a new object
    appearing. */
export function newStripKey(): string {
  keySeq += 1
  return `strip-${Date.now().toString(36)}-${keySeq}`
}

/**
 * A fresh, EMPTY strip at `at`.
 *
 * Empty is the correct resting state, not a half-built one: the strip model is
 * "a uniform channel with elements added on demand", and REC on an empty strip
 * is what gives it a tape. A strip that arrived with a dead tape element would
 * be the "form to fill in" the plane exists to avoid.
 */
/**
 * What a strip is CALLED after a session loads into it (P3-U2).
 *
 * A loaded strip used to keep reading "STRIP 1 · records: deck 0" — the
 * session's name appeared nowhere on the object, contrary to the strip menu's
 * own promise ("what stays on the object is the RESULT — … the status line
 * naming the session"). The rule: a name the USER typed wins; the DEFAULT
 * name and a PREVIOUS session's name follow the load. That keeps renames
 * sacred without leaving a strip anonymous.
 */
export function nameAfterSessionLoad(
  strip: Pick<Strip, 'name' | 'channel' | 'element'>,
  sessionId: string,
): string {
  const isDefault = strip.name === `STRIP ${strip.channel + 1}`
  const isPreviousSession =
    strip.element.kind === 'grid' && strip.name === strip.element.sessionId
  return isDefault || isPreviousSession ? sessionId : strip.name
}

export function newStrip(channel: number, at: { x: number; y: number }): Strip {
  return {
    key: newStripKey(),
    name: `STRIP ${channel + 1}`,
    cell: { ...DEFAULT_CELL, x: at.x, y: at.y },
    channel,
    element: { kind: 'none' },
    // Unity, unmuted, audible the moment it exists (R-CREATE-2): a strip you
    // have to un-mute before it makes a sound teaches that the plane is a place
    // where you configure things.
    level: 1,
    mute: false,
    sends: [0, 0, 0, 0],
    // DRV off — amount 1 is a bypass branch in the engine, so a fresh strip
    // keeps the bit-exact identity path until someone reaches for character.
    drive: { curve: 0, amount: 1 },
    recordArm: false,
    // ⚠️ NOT LISTENING YET, and this is the one place R-CREATE-2's "audible the
    // moment it exists" is deliberately not applied.
    //
    // A strip arrives with its device input patched (inputRoute below), because
    // otherwise REC captures silence. It used to arrive MONITORING that input
    // too — so a strip created next to a live mic fed back instantly, and the
    // only control that stopped it (`M`) muted the whole channel and took the
    // tape with it. A strip that arrives listening is a strip that arrives
    // feeding back. REC opens the monitor by itself (D-WZ-MON-01), so the
    // first gesture still works with nothing to configure.
    monitor: false,
    recordTap: null,
    sessionPerf: {},
  }
}

/* ── what REC captures ────────────────────────────────────────────────────── */

/** The engine's record-source kinds (sl_tape_set_record_source). */
export const RECORD_SOURCE = { deviceInput: 0, mainMix: 1, channelBus: 2 } as const

/**
 * P3-R3 — the LINKED LOOPER for a grid strip: a tape strip whose bus this
 * strip already feeds and whose tap is the bus. REC on a grid strip targets
 * this (or spawns one) instead of overwriting its own element — one kind per
 * strip (D-SL-MORPH-01); "the looper records the deck's own output" is two
 * routed strips.
 */
export function linkedLooperFor(map: PlaneMap, src: Strip): Strip | null {
  // WHAT COUNTS AS "THIS STRIP FEEDS IT" depends on the source's kind, and
  // P3.5-E3 is why. A grid strip's channel bus is EMPTY by construction (the
  // core owns that deck's gain stage and already summed it), so the cable that
  // carries a grid strip is `deckOut` naming its DECK — a `channelOut` link
  // from a grid strip is the silent one this row replaced. Both are matched:
  // maps saved before the fix still hold the old cable, and the pair must still
  // read as a pair rather than silently spawning a second looper.
  const feeds = (r: PlaneMap['routes'][number], looperChannel: number) => {
    if (r.dst.index !== looperChannel || r.dst.kind !== 'channelIn') return false
    if (src.element.kind === 'grid' && r.src.kind === 'deckOut')
      return r.src.index === src.element.deck
    return r.src.kind === 'channelOut' && r.src.index === src.channel
  }
  return (
    map.strips.find(
      (s) =>
        s.element.kind === 'tape' &&
        s.recordTap === 'bus' &&
        map.routes.some((r) => feeds(r, s.channel)),
    ) ?? null
  )
}

export type RecordTap = { kind: number; chan0: number; chan1: number; label: string }

/**
 * WHERE THIS STRIP'S REC READS FROM.
 *
 * The default is a RULE, not a setting: a strip with a live input records that
 * INPUT, and a strip without one records its own CHANNEL BUS.
 *
 * ⚠️ THE INPUT CASE IS THE SPLIT TAP, and it costs the purity of "one tap, one
 * code path, every source" on purpose. Capturing the bus meant capture and
 * monitoring were the same signal path, so silencing an input to stop feedback
 * made REC record silence — record-without-hearing was impossible by
 * construction. Reading the input directly separates them, and the take is then
 * identical whether or not you were listening.
 *
 * `strip.recordTap` overrides the rule, because the rule alone silently deletes
 * a capability: a strip fed by another strip AND carrying an input would only
 * ever capture the input, with nothing saying where the chain went.
 */
export function recordTapFor(
  strip: Strip,
  input: { left: number; right: number | null } | null,
  inputLabel?: string | null,
): RecordTap {
  const bus: RecordTap = {
    kind: RECORD_SOURCE.channelBus,
    chan0: strip.channel,
    chan1: -1,
    label: 'this strip’s bus',
  }
  const mainMix: RecordTap = {
    kind: RECORD_SOURCE.mainMix,
    chan0: 0,
    chan1: 1,
    label: 'the main mix',
  }
  const fromInput = (): RecordTap | null =>
    input === null
      ? null
      : {
          kind: RECORD_SOURCE.deviceInput,
          chan0: input.left,
          chan1: input.right ?? -1,
          label: inputLabel ?? 'this strip’s input',
        }

  switch (strip.recordTap) {
    case 'input':
      // An explicit choice that is no longer possible falls back to the bus
      // rather than refusing: the input was unplugged, and a strip that cannot
      // record at all is worse than one that records what it still has.
      return fromInput() ?? bus
    case 'bus':
      return bus
    case 'mainMix':
      return mainMix
    default:
      return fromInput() ?? bus
  }
}

/** A tape element, narrowed. The return type is the tape MEMBER rather than the
    `Element` union so callers can spread it (`{...newTapeElement(0,false),
    rate: -1}`) without the union collapsing to its common fields. */
export type TapeElement = Extract<Element, { kind: 'tape' }>

/** The tape element a strip gets when REC gives it material. Loop ENABLED, so
    stopping a recording plays it back immediately — Law C-3, and the single
    strongest antidote to "I couldn't figure out how to make it loop". */
export function newTapeElement(index: number, stereo: boolean): TapeElement {
  return {
    kind: 'tape',
    index,
    takeRef: null,
    stereo,
    loop: { enabled: true, start: 0, end: 0 },
    rate: 1,
    // Tempo identity (P3-2b-1): unknown until a take's bpmAtStart stamp or
    // the user supplies it; sync off; timePitch = the D-3 zero-latency default.
    bpm: null,
    syncToMaster: false,
    tempoMode: 'timePitch',
    pulseRelation: 'auto',
    // A looper launches too (D-SL-QUANTUM-01) — `auto` so one spawned mid-set
    // lands on the beat with nothing to configure first.
    launchRef: 'auto',
  }
}

/** A grid element, narrowed — same reason as `TapeElement`. */
export type GridElement = Extract<Element, { kind: 'grid' }>

/**
 * The grid element a strip gets when a session is loaded into it.
 *
 * UNSYNCED, at the session's own tempo. "Decks load into strips, each with its
 * own BPM" is the mission sentence, so a session arriving locked to the plane's
 * master would be the opposite of it — sync is a thing you ask for, per strip,
 * and the SYNC control on the strip is where you ask.
 *
 * The tempo intent is carried anyway, unsynced, so that turning SYNC on is one
 * decision rather than three: `timeStretch` because pitch-preserving is what
 * "sync" means to most material, and `auto` because the pulse relation is the
 * one of the three a human should not have to compute. (The v3→v4 migration
 * deliberately uses 1:1 instead — see MIGRATIONS: `auto` is the right default
 * for a NEW strip and the wrong answer for an existing document.)
 */
export function newGridElement(deck: number, sessionId: string, bpm: number): GridElement {
  return {
    kind: 'grid',
    deck,
    sessionId,
    bpm,
    syncToMaster: false,
    tempoMode: 'timeStretch',
    pulseRelation: 'auto',
    transpose: 0,
    // TP mode OFF, the donor's own default: sync and transpose coexist until
    // someone asks for the exclusion. A new strip and the v8→v9 migration agree.
    pitchMode: false,
    // AUTO: no setup, and with two decks running it simply means "the other
    // one" (D-SL-QUANTUM-01).
    launchRef: 'auto',
  }
}

/* ── what the engine says this strip is doing ─────────────────────────────── */

/** The live, per-frame truth about a strip, read from the HotFrame. Never from
    the document: the ENGINE owns what is playing, and a document that thinks a
    tape is looping while it stopped is exactly the drift the record→material
    transition produces. */
export type Live = {
  /** sl_tape_state: idle · loop · oneShot · recording. */
  tapeState: number
  /** Playhead in frames; fractional while varispeeding. */
  playhead: number
  /** The 256 MB record cap stopped this tape by itself. */
  capReached: boolean
  peakL: number
  peakR: number
  /** Is this strip's monitor open, ACCORDING TO THE ENGINE? Here rather than
      read from the document because the engine moves it itself at record-start
      and at the Law C-3 handoff — the same reason `tapeState` is here. */
  monitor: boolean
}

export const IDLE_LIVE: Live = {
  tapeState: SL_TAPE_STATE.idle,
  playhead: 0,
  capReached: false,
  peakL: 0,
  peakR: 0,
  monitor: false,
}

export const isRecording = (live: Live): boolean =>
  live.tapeState === SL_TAPE_STATE.recording

export const isPlaying = (live: Live): boolean =>
  live.tapeState === SL_TAPE_STATE.loop || live.tapeState === SL_TAPE_STATE.oneShot

/** The one word in the strip head. Fixed vocabulary, fixed width band — never a
    sentence, because the head must not reflow (layout law L4). */
export function stateWord(strip: Strip, live: Live, deckPlaying = false): string {
  // A GRID STRIP READS ITS DECK, not the tape bank. `live.tapeState` describes
  // tape N, and a grid strip owns no tape — before the deck axis it therefore
  // showed whatever tape happened to share its index, which was either "idle"
  // forever or another strip's state.
  if (strip.element.kind === 'grid') return deckPlaying ? 'play' : 'idle'
  if (isRecording(live)) return 'rec'
  switch (live.tapeState) {
    case SL_TAPE_STATE.loop:
      return 'loop'
    case SL_TAPE_STATE.oneShot:
      return 'shot'
    default:
      return strip.element.kind === 'none' ? '----' : 'idle'
  }
}

/* ── the status line ──────────────────────────────────────────────────────── */

export type StatusTone = 'normal' | 'warn' | 'hot'
export type Status = { text: string; tone: StatusTone }

/** Seconds as `m:ss`, in a FIXED-WIDTH shape so a counter ticking past 0:59
    cannot widen the head. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * THE PRIORITY LADDER (pd-strip-anatomy L3). Exactly ONE message renders, and
 * it is a LADDER rather than a stack because a stack of messages changes the
 * strip's height, which changes `cell.h`, which corrupts every saved
 * arrangement. Ordered most-urgent first:
 *
 *   audio missing > cap reached > decoding > feedback > recording > take > records
 *
 * "Audio missing" outranks everything because it is the only one that says the
 * strip cannot make the sound you are expecting.
 */
export function statusLine(
  strip: Strip,
  live: Live,
  ctx: {
    /** The take this strip references could not be found in the library. */
    unresolvedRef?: string | null
    /** 0..1 while a take is decoding into the tape. */
    decoding?: number | null
    /** This strip is fed by a consented feedback edge, and what it costs. */
    feedbackMs?: number | null
    /** Nothing carries this strip's output anywhere. */
    noOutput?: boolean
    /** What REC would capture — a device name, another strip, the mix. */
    recordSource?: string | null
    /** The resolved take's display name and length, once it has material. */
    takeName?: string | null
    takeSeconds?: number | null
    /** Elapsed recording time, seconds. */
    recSeconds?: number | null
  } = {},
): Status {
  if (ctx.unresolvedRef)
    return { text: `audio missing — ${ctx.unresolvedRef}`, tone: 'hot' }
  // SILENT FOR A ROUTING REASON. pd-strip-anatomy state 15: a strip whose
  // output goes nowhere is inaudible, and the console said so while the plane
  // dropped it (defect D7). Ranked just under "audio missing" because it is the
  // same class of fault — the strip cannot make the sound you are expecting —
  // and it is the one a person is least likely to guess at.
  if (ctx.noOutput) return { text: 'no output — this strip goes nowhere', tone: 'warn' }
  if (live.capReached)
    return { text: 'cap — 256 MB, take is on disk', tone: 'warn' }
  if (ctx.decoding != null && ctx.decoding < 1)
    return { text: `decoding ${Math.round(ctx.decoding * 100)}%`, tone: 'normal' }
  if (ctx.feedbackMs != null)
    return { text: `↺ +${ctx.feedbackMs.toFixed(1)} ms (one block)`, tone: 'warn' }
  if (isRecording(live)) {
    const tape = strip.element.kind === 'tape' ? strip.element.index : 0
    const elapsed = ctx.recSeconds != null ? ` · ${mmss(ctx.recSeconds)}` : ''
    return {
      text: `recording ${ctx.recordSource ?? 'input'} → tape ${tape}${elapsed}`,
      tone: 'normal',
    }
  }
  if (ctx.takeName)
    return {
      text:
        ctx.takeSeconds != null
          ? `${ctx.takeName} · ${mmss(ctx.takeSeconds)}`
          : ctx.takeName,
      tone: 'normal',
    }
  if (ctx.recordSource) return { text: `records: ${ctx.recordSource}`, tone: 'normal' }
  // NEVER an empty string: the line is reserved whether or not it has something
  // to say (layout law L2), and a non-breaking space keeps its box.
  return { text: ' ', tone: 'normal' }
}

/* ── which controls are live ──────────────────────────────────────────────── */

/**
 * What this strip can do right now. Every transport control is RENDERED in
 * every state and merely disabled here — presence never changes, only fill
 * (layout law L2), so no control ever migrates to a different pixel.
 */
export type Enabled = {
  record: boolean
  play: boolean
  /** ▸ one-shot. SEPARATE from `play` because a sequenced pattern has no
      one-shot: a grid deck runs its pattern, which repeats by nature. Splitting
      the two is what lets a grid strip light ⟳ ↻ ◼ and leave ▸ inert, rather
      than either faking a verb or greying out the whole row. */
  oneShot: boolean
  stop: boolean
  rate: boolean
  scrub: boolean
}

export function enabledControls(
  strip: Strip,
  live: Live,
  ctx: { unresolvedRef?: string | null; decoding?: number | null } = {},
): Enabled {
  const decoding = ctx.decoding != null && ctx.decoding < 1
  const hasMaterial = strip.element.kind === 'tape' && !ctx.unresolvedRef && !decoding
  const recording = isRecording(live)
  // A GRID STRIP CAN BE TRANSPORTED — the whole point of P3-1. A deck's
  // material is its session, which is present the moment the element exists, so
  // there is no "has material" question to ask of it.
  const isGrid = strip.element.kind === 'grid'
  return {
    // REC IS ALMOST ALWAYS LIVE — including on an unresolved strip, where
    // recording over a dead reference is a REPAIR rather than a loss. It goes
    // inert only while a decode is in flight, which is the one moment the tape
    // is genuinely not ready to be written.
    record: !decoding,
    play: (hasMaterial || isGrid) && !recording,
    oneShot: hasMaterial && !recording,
    stop: (hasMaterial || isGrid) && !recording,
    // Varispeed and scrub stay TAPE-ONLY. A deck's rate is its tempo, which is
    // the bpm field on the strip — a second speed control would be two ways to
    // do one thing, with different units.
    rate: hasMaterial && !recording,
    scrub: hasMaterial && !recording,
  }
}

/* ── placement ────────────────────────────────────────────────────────────── */

/** Where a newly-created strip lands: the centre of what you are looking at,
    converted screen → plane (plane = screen/scale − pan), nudged by a small
    cascade so successive additions do not stack exactly on top of each other. */
export function spawnPoint(
  viewport: { width: number; height: number },
  plane: PlaneMap['plane'],
  existing: number,
): { x: number; y: number } {
  const cascade = (existing % 6) * 24
  return {
    x: Math.round(viewport.width / 2 / plane.scale - plane.panX - DEFAULT_CELL.w / 2 + cascade),
    y: Math.round(viewport.height / 2 / plane.scale - plane.panY - DEFAULT_CELL.h / 2 + cascade),
  }
}

/** Strip cells, for fitToContent. */
export const cellsOf = (map: PlaneMap): Cell[] => map.strips.map((s) => s.cell)

/* ── the input route ──────────────────────────────────────────────────────── */

/**
 * A device input, patched into a strip.
 *
 * ⚠️ THIS IS WHAT MAKES REC WORK AT ALL, and its absence is the defect
 * `plane_audio_test` was written to catch. A strip records its own CHANNEL BUS
 * — one tap, one code path, every source — and a channel carries its element
 * plus everything ROUTED INTO IT. So a strip with no element and no input route
 * carries silence, and pressing REC on it records silence perfectly, forever,
 * with nothing anywhere saying why.
 *
 * "A device input is just a route into a strip" is what lets an input element
 * need no special case. It is also what makes an input strip IMPOSSIBLE until
 * something creates the route — and nothing did.
 *
 * A fresh strip therefore arrives WITH its input patched: audible the moment it
 * exists, and recordable the moment you press the one enabled verb. That is the
 * plane's stated antidote to "I couldn't figure out how to make it work"
 * applied to the very first gesture.
 */
export function inputRoute(channel: number, left = 0, right = 1): Route {
  return {
    src: { kind: 'deviceInput', index: left, sub: right },
    dst: { kind: 'channelIn', index: channel },
    gain: 1,
    feedback: false,
  }
}

/** The device input feeding this strip, if any — what REC will capture, and
    what the status line names before you press it. */
export function inputFor(map: PlaneMap, strip: Strip): Route | null {
  return (
    map.routes.find(
      (r) => r.src.kind === 'deviceInput' && r.dst.kind === 'channelIn' && r.dst.index === strip.channel,
    ) ?? null
  )
}

/** The beat-repeat FUSED SCALE (P3-M-1b, shared with the deck tile at D4-2):
    16…2 whole steps, then 1 and the 1/N re-triggering rolls. One table for the
    master bar's fan-out AND each strip's own BR — two copies would drift into
    two different instruments. */
export const BR_SCALE: { label: string; length: number; subdivision?: number }[] = [
  { label: '16', length: 16 },
  { label: '8', length: 8 },
  { label: '4', length: 4 },
  { label: '2', length: 2 },
  { label: '1', length: 1 },
  { label: '1/2', length: 1, subdivision: 2 },
  { label: '1/4', length: 1, subdivision: 4 },
  { label: '1/8', length: 1, subdivision: 8 },
  { label: '1/16', length: 1, subdivision: 16 },
  { label: '1/32', length: 1, subdivision: 32 },
]

/**
 * The beat-repeat length readout — ONE fused scale, two notations.
 *
 * `nudgeBeatRepeatScale` walks 16…2, 1, then 1/2…1/32, where the tail is a re-triggering roll:
 * length pins to 1 and the SUBDIVISION carries the value (BeatSequencer:19436). So the number on
 * screen comes from whichever half of the scale is live — read `beatRepeatLength` alone and the
 * six micro settings all render "1", which is why the subdivision had to join the wire.
 */
export function beatRepeatLabel(s: {
  beatRepeatLength: number;
  beatRepeatSubdivision: number;
}): string {
  return s.beatRepeatSubdivision > 1 ? `1/${s.beatRepeatSubdivision}` : `${s.beatRepeatLength}`;
}

/** The scale row a beat-repeat window is wearing, for the cycler + label.
    −1 = not on the scale (a hand-built window) — cycling starts from '2'. */
export function brScaleIndex(br: { length: number; subdivision?: number } | null): number {
  if (!br) return -1
  return BR_SCALE.findIndex(
    (sc) => sc.length === br.length && (sc.subdivision ?? 1) === (br.subdivision ?? 1),
  )
}

/** A beat-repeat window as a deck reports it. */
export type BrWindow = { length: number; subdivision?: number } | null

/**
 * What the MASTER's beat-repeat control shows, and what its next press does.
 *
 * ⚠️ THE SCOPE LAW (P11-0): BR · TR · WIN · REV · SYNC are DECK controls. The
 * master row FEEDS them and owns none of them — original scoopyloops puts every
 * one in the DECK block's row 2 (`TransportPanel.tsx:25`), reading
 * `DeckSectionState`, while its master row carries the tempo REFERENCE.
 *
 * The master used to keep its own `brOn` boolean, synced from nothing. So
 * engaging BR on a strip left the master lamp DARK while that deck repeated,
 * and the master's next press computed `!brOn` from the stale value — one press
 * could re-engage what was already on. Everything here is DERIVED instead; the
 * only thing the master still owns is `pendingIdx`, the scale it will SEND,
 * which is an intent rather than a claim about any deck.
 */
export function masterBrView(
  activeDecks: readonly number[],
  brOf: (deck: number) => BrWindow,
  pendingIdx: number,
): { active: boolean; label: string; nextOn: boolean } {
  const latched = activeDecks.map(brOf).find((b) => b != null) ?? null
  const latchedIdx = brScaleIndex(latched)
  // A latched deck's ACTUAL window wins the label — a strip's own BR may have
  // set a different scale, and the master should report what is happening
  // rather than what it last asked for. An off-scale (hand-built) window falls
  // back to the pending label rather than showing nothing.
  const shown = latched && latchedIdx >= 0 ? BR_SCALE[latchedIdx] : BR_SCALE[pendingIdx]
  return {
    active: latched != null,
    label: shown?.label ?? '2',
    // The press completes the gesture the LAMP is showing, whoever started it.
    nextOn: latched == null,
  }
}
