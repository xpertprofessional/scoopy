/**
 * Applying a `.scoopyMap` to the engine, and capturing it back out.
 *
 * WHY THIS IS A PLANNER AND NOT A CALLER. It turns a map into an ORDERED LIST
 * OF OPERATIONS rather than issuing them itself. Three reasons, in order of how
 * much they matter:
 *
 *  1. The ordering rules below are the load-bearing part, and a pure function
 *     lets them be tested exhaustively without an engine, a device or a shell —
 *     the same discipline the engine side uses (headless first, GUI verified by
 *     a run-pass).
 *  2. The `sl_route_*` / `sl_channel_*` surface is not on the SLP wire yet.
 *     A module that called `link.command('routeAdd', …)` today would be calling
 *     a method that does not exist; a module that RETURNS ops is correct now and
 *     stays correct when the wire lands, at which point applying is a `for`
 *     loop over this list.
 *  3. It keeps wizard's law intact — TS owns the document, the engine follows.
 *     The document layer decides WHAT should be true; nothing here decides when.
 */
import { perfFor, type PlaneMap, type Route, type Strip } from './mapDocument'
import { TEMPO_MODE_ID, deckTempoIntent } from './tempo'

/** One engine call, named for the ABI entry point it becomes. */
export type EngineOp =
  | { op: 'routeClearAll' }
  | { op: 'channelSetSource'; channel: number; kind: 0 | 1 | 2; index: number }
  | { op: 'channelSetLevel'; channel: number; level: number }
  | { op: 'channelSetMute'; channel: number; muted: boolean }
  | { op: 'channelSetMonitor'; channel: number; on: boolean }
  | { op: 'channelSetSend'; channel: number; send: number; level: number }
  | { op: 'tapeLoadTake'; tape: number; takeRef: string }
  | { op: 'tapeSetLoop'; tape: number; enabled: boolean; start: number; end: number }
  | { op: 'tapeSetRate'; tape: number; rate: number }
  /** The deck's tempo axis (SL-ABI-V3 §3). Three ops rather than one because
      they are three engine params: the ratio, the MODE that decides which
      mechanism the ratio drives, and a pitch offset independent of both. */
  | { op: 'deckSetTempoSync'; deck: number; ratio: number }
  | { op: 'deckSetTempoMode'; deck: number; mode: 0 | 1 | 2 }
  | { op: 'deckSetTranspose'; deck: number; semitones: number }
  /** The performance layer going back on. NOT composition: these restore which
      scene is running and how scenes launch, which is all a map owns of a
      session (see GridPerfSchema for why it is this narrow). */
  | { op: 'sceneSelect'; deck: number; scene: string }
  | {
      op: 'sceneSetSwitch'
      deck: number
      switchMode: 'scheduled' | 'seamlessImmediate' | 'restartImmediate'
      queuedScenes: string[]
      queueLoop: boolean
    }
  | {
      op: 'routeAdd'
      srcKind: number
      srcIndex: number
      srcSub: number
      dstKind: number
      dstIndex: number
      gain: number
      feedback: boolean
    }

/** The ABI's numeric encodings. Kept here, once, rather than spelled inline —
    a wrong number is a cable patched somewhere nobody asked for. */
const SRC_KIND: Record<Route['src']['kind'], number> = {
  channelOut: 0,
  channelSend: 1,
  deviceInput: 2,
  fxReturn: 3,
}
const DST_KIND: Record<Route['dst']['kind'], number> = {
  channelIn: 0,
  sendBus: 1,
  main: 2,
}
const NO_INDEX = 0xffffffff

/** Source kind for a strip's channel binding: none | tape | gridDeck. */
function sourceKindOf(strip: Strip): { kind: 0 | 1 | 2; index: number } {
  switch (strip.element.kind) {
    case 'none':
      return { kind: 0, index: 0 }
    case 'tape':
      return { kind: 1, index: strip.element.index }
    case 'grid':
      return { kind: 2, index: strip.element.deck }
  }
}

/**
 * The ops that make the engine match `map`, in the order they must be issued.
 *
 * THE ORDERING RULES, each of which is a bug if broken:
 *
 *  1. **routeClearAll FIRST.** A fresh engine installs 40 default routes (every
 *     channel → main, every send → its FX bus) so a new strip is audible
 *     without ceremony. They are ordinary routes. Adding a saved map's routes
 *     without clearing first LAYERS the document on top of the boot wiring, so
 *     the session gains phantom cables — and gains them again on every open,
 *     getting louder each time. This is the single rule most likely to be
 *     forgotten, so it is first and it is tested.
 *
 *  2. **Sources before their channel state.** Binding a channel to a grid deck
 *     PROJECTS its level and sends onto the core's per-deck controls, so the
 *     binding has to exist before the values are written or they land on the
 *     old deck (or nowhere).
 *
 *  3. **Element state with its element.** A tape's take, loop and rate belong
 *     to the tape, not the strip, so they are emitted per element.
 *
 *  4. **Routes last.** They reference channels, and a channel that does not yet
 *     carry what it should would make an ordered route carry silence for a
 *     block. Cheap to avoid by simply going last.
 *
 * Replay order WITHIN the route list does not matter, which is worth knowing:
 * a feedback edge never participates in cycle detection, so a saved graph
 * cannot refuse itself halfway through being restored.
 */
export function planApply(map: PlaneMap): EngineOp[] {
  const ops: EngineOp[] = [{ op: 'routeClearAll' }]

  for (const strip of map.strips) {
    const src = sourceKindOf(strip)
    ops.push({ op: 'channelSetSource', channel: strip.channel, kind: src.kind, index: src.index })

    if (strip.element.kind === 'tape') {
      const t = strip.element
      if (t.takeRef !== null) ops.push({ op: 'tapeLoadTake', tape: t.index, takeRef: t.takeRef })
      ops.push({
        op: 'tapeSetLoop',
        tape: t.index,
        enabled: t.loop.enabled,
        start: t.loop.start,
        end: t.loop.end,
      })
      ops.push({ op: 'tapeSetRate', tape: t.index, rate: t.rate })
    } else if (strip.element.kind === 'grid') {
      // The engine takes a RATIO; the document stores the intent, so the ratio
      // is RESOLVED here — through scoopy's tempo law, not by dividing.
      //
      // ⚠️ THIS WAS `masterBpm / g.bpm`, and the difference is musical, not
      // cosmetic. The law resolves a pulse relation first: a 70 BPM deck synced
      // to a 140 master is 1:2 — the same pulse, half-time — where the division
      // could only say 2×. It also carries the tempo MODE, which decides which
      // of the engine's three mechanisms the ratio reaches, and the ceilings
      // that stop a 5 BPM master producing a deck at 0.04×.
      //
      // A deck that is not synced still gets ratio 1.0 — NOT "no call", because
      // the deck may be carrying a ratio from a previously loaded map.
      const g = strip.element
      const intent = deckTempoIntent(g, map.transport.masterBpm)
      ops.push({ op: 'deckSetTempoMode', deck: g.deck, mode: TEMPO_MODE_ID[g.tempoMode] })
      ops.push({ op: 'deckSetTempoSync', deck: g.deck, ratio: intent.syncRatio })
      ops.push({ op: 'deckSetTranspose', deck: g.deck, semitones: g.transpose })
      // The performance layer for THIS pairing. A strip that has hosted this
      // session before gets its scene state back; one that has not starts at
      // the defaults rather than inheriting another session's.
      const perf = perfFor(strip, g.sessionId)
      ops.push({ op: 'sceneSelect', deck: g.deck, scene: perf.currentScene })
      ops.push({
        op: 'sceneSetSwitch',
        deck: g.deck,
        switchMode: perf.switchMode,
        queuedScenes: perf.queuedScenes,
        queueLoop: perf.queueLoop,
      })
    }

    ops.push({ op: 'channelSetLevel', channel: strip.channel, level: strip.level })
    ops.push({ op: 'channelSetMute', channel: strip.channel, muted: strip.mute })
    // The monitor is applied like any other channel value. It matters that it
    // is applied EXPLICITLY rather than left at the engine's default: loading a
    // map into a running engine inherits whatever the previous map left open,
    // and an input strip silently monitoring because the last set did is the
    // feedback bug wearing a different hat.
    ops.push({ op: 'channelSetMonitor', channel: strip.channel, on: strip.monitor })
    strip.sends.forEach((level, send) =>
      ops.push({ op: 'channelSetSend', channel: strip.channel, send, level }),
    )
  }

  for (const r of map.routes) {
    ops.push({
      op: 'routeAdd',
      srcKind: SRC_KIND[r.src.kind],
      srcIndex: r.src.index,
      srcSub: r.src.sub ?? NO_INDEX,
      dstKind: DST_KIND[r.dst.kind],
      dstIndex: r.dst.index,
      gain: r.gain,
      feedback: r.feedback,
    })
  }

  return ops
}

/** What a live engine reports for one route slot (the `sl_route_*` getters). */
export type LiveRoute = {
  active: boolean
  srcKind: number
  srcIndex: number
  srcSub: number
  dstKind: number
  dstIndex: number
  gain: number
  feedback: boolean
}

const SRC_KIND_NAME: Record<number, Route['src']['kind']> = {
  0: 'channelOut',
  1: 'channelSend',
  2: 'deviceInput',
  3: 'fxReturn',
}
const DST_KIND_NAME: Record<number, Route['dst']['kind']> = {
  0: 'channelIn',
  1: 'sendBus',
  2: 'main',
}

/**
 * Turn what the engine reports back into document routes, so a save captures
 * the graph that EXISTS rather than the one the UI believes it issued. Those
 * two drift the moment anything edits routing outside the document's view, and
 * the difference stays silent until a reload.
 *
 * Inactive slots are skipped. An unknown kind is skipped rather than guessed —
 * a cable we cannot name is one we must not pretend to have saved.
 */
export function captureRoutes(live: readonly LiveRoute[]): Route[] {
  const out: Route[] = []
  for (const r of live) {
    if (!r.active) continue
    const srcKind = SRC_KIND_NAME[r.srcKind]
    const dstKind = DST_KIND_NAME[r.dstKind]
    if (srcKind === undefined || dstKind === undefined) continue
    out.push({
      src: {
        kind: srcKind,
        index: r.srcIndex,
        sub: r.srcSub === NO_INDEX ? null : r.srcSub,
      },
      dst: { kind: dstKind, index: r.dstIndex },
      gain: r.gain,
      feedback: r.feedback,
    })
  }
  return out
}
