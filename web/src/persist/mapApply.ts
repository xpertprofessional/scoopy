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
import { TEMPO_MODE_ID, deckTempoIntent, tapeEffectiveRate } from './tempo'

/** One engine call, named for the ABI entry point it becomes. */
export type EngineOp =
  | { op: 'routeClearAll' }
  | { op: 'channelSetSource'; channel: number; kind: 0 | 1 | 2; index: number }
  | { op: 'channelSetLevel'; channel: number; level: number }
  | { op: 'channelSetMute'; channel: number; muted: boolean }
  | { op: 'channelSetMonitor'; channel: number; on: boolean }
  | { op: 'channelSetSend'; channel: number; send: number; level: number }
  | { op: 'channelSetDrive'; channel: number; curve: number; amount: number }
  /** An FX return's plugin (P6-5b). `identifier` null = unload that return.
      `state` is the plugin's own blob, applied at instantiation. */
  | { op: 'fxSelect'; returnIndex: number; identifier: string | null; state: string | null }
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
    a wrong number is a cable patched somewhere nobody asked for.
    EXPORTED because `unpatch` must look a cable up on the engine by the same
    encoding that issued it — it used to infer the kind from the cable's shape
    and got `deckOut` wrong (see Plane.tsx). One table, both directions. */
export const SRC_KIND: Record<Route['src']['kind'], number> = {
  channelOut: 0,
  channelSend: 1,
  deviceInput: 2,
  fxReturn: 3,
  // ⚠️ index is a DECK here, not a channel (P3.5-E3). See RouteSourceSchema.
  deckOut: 4,
}
export const DST_KIND: Record<Route['dst']['kind'], number> = {
  channelIn: 0,
  sendBus: 1,
  main: 2,
}
export const NO_INDEX = 0xffffffff

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
      // The EFFECTIVE rate (P3-2b-3): a synced tape opens synced — restoring
      // the manual rate and waiting for some later tempo pass would play the
      // first bars at the wrong speed, which on a reload mid-set is audible.
      ops.push({
        op: 'tapeSetRate',
        tape: t.index,
        rate: tapeEffectiveRate(t, map.transport.masterBpm),
      })
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
    // DRV applied explicitly for the same reason as the monitor: a running
    // engine inherits the previous map's drive, and a strip arriving quietly
    // DRIVEN because the last set was is the same bug at a different knob.
    // (For a grid strip this is a no-op at the channel tier — its deck's drive
    // rides the session document — but the channel still shapes routed input.)
    ops.push({
      op: 'channelSetDrive',
      channel: strip.channel,
      curve: strip.drive.curve,
      amount: strip.drive.amount,
    })
    strip.sends.forEach((level, send) =>
      ops.push({ op: 'channelSetSend', channel: strip.channel, send, level }),
    )
  }

  // THE FX RETURNS' PLUGINS (P6-5b), emitted for all four EXPLICITLY — including
  // the empty ones, and for the same reason the monitor and DRV are: a running
  // engine inherits whatever the previous map left loaded, so a return this map
  // says nothing about must be actively emptied rather than left holding someone
  // else's reverb. Ordered before the routes only for readability; fx slots and
  // cables do not constrain each other.
  map.fx.forEach((slot, i) =>
    ops.push({
      op: 'fxSelect',
      returnIndex: i + 1, // the ABI and the schema are both 1-based here
      identifier: slot.identifier,
      state: slot.state,
    }),
  )

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

/**
 * The read direction, DERIVED from the write maps rather than written twice.
 *
 * This was two hand-written literals, and they drifted the day `deckOut` (kind
 * 4, P3.5-E3) was added to `SRC_KIND` above and not to its twin below: an
 * unknown kind is deliberately SKIPPED by `captureRoutes`, so every save — and
 * every 4 s autosave — silently erased the one cable that carries a grid deck
 * into a looper. The write maps are exhaustive over the route-kind unions BY
 * TYPE, so inverting them means a kind that can be issued is a kind that can be
 * captured, by construction, and no future kind can repeat this.
 */
function invertKinds<K extends string>(m: Record<K, number>): Record<number, K> {
  const out: Record<number, K> = {}
  for (const name of Object.keys(m) as K[]) out[m[name]] = name
  return out
}
const SRC_KIND_NAME = invertKinds(SRC_KIND)
const DST_KIND_NAME = invertKinds(DST_KIND)

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

/** What the engine reports for one return (`getFxSlotState`). */
export type LiveFxSlot = {
  returnIndex?: number
  identifier?: string | null
  state?: string | null
}

/**
 * The FX returns as they should be SAVED (P6-5b).
 *
 * The engine is the truth about what is loaded and what its state is — that is
 * the whole reason this is captured rather than remembered (a plugin's settings
 * are made in its own editor, which the document never sees).
 *
 * ⚠️ EXCEPT WHERE THE PLUGIN COULD NOT BE LOADED HERE, and this is the case that
 * makes a portable map safe. Open a map on a machine that lacks one of its
 * plugins: that return is EMPTY in the engine, honestly so. If a save then took
 * the engine's word, the map would ERASE the plugin it remembers — carry a set
 * to a different rig, open it, save it, and the original machine has lost it
 * too. So identifiers the restore could not resolve (`preserve`) keep their
 * stored entry verbatim, blob included.
 *
 * That is deliberately NOT "keep whatever the document had whenever the engine
 * reads empty" — which would make unloading a plugin on purpose unsavable. The
 * distinction is knowledge the restore has and nobody else does: it tried, and
 * this machine does not have it.
 */
export function captureFxSlots(
  live: readonly LiveFxSlot[],
  current: PlaneMap['fx'],
  preserve: ReadonlySet<string> = new Set(),
): PlaneMap['fx'] {
  const out = current.map((stored, i) => {
    if (stored.identifier !== null && preserve.has(stored.identifier)) return stored
    // Match by returnIndex rather than array position: the reply is a list and
    // trusting its order would silently put FX 3's plugin on FX 1.
    const reported = live.find((s) => s.returnIndex === i + 1)
    if (reported === undefined) return stored // said nothing about this return
    return {
      identifier: reported.identifier ?? null,
      state: reported.state ?? null,
    }
  })
  return [out[0]!, out[1]!, out[2]!, out[3]!]
}
