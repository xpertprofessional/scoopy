/**
 * What the plane DRAWS of the routing graph (merge P2 step 4, increment 4).
 *
 * THE RULE, and it is a decision rather than an optimisation:
 *
 *   Draw a cable only for a route that is genuinely a GRAPH — strip→strip and
 *   strip-send→strip. Everything terminal (→ main, send n → FX n, a device
 *   input arriving) is a CHIP on the strip, not a line.
 *
 * `pd-plane-playground.md` §3 argued for no cables at all, on the grounds that
 * wizard's graph was a STAR: every channel had one output-bus edge, so n lines
 * converging on one point was maximum ink for zero information. That reasoning
 * was correct then and does not survive the merge — `sl_route_*` made routing
 * genuinely strip→strip, and a chain A→B→C cannot be read from labels alone.
 * So the star half keeps its chips and the graph half gets its lines, which is
 * the same principle applied to a topology that changed underneath it.
 *
 * The payoff: a fresh engine installs 40 DEFAULT routes (every channel → main,
 * every send → its FX bus). None of them is a graph edge, so a fresh plane
 * draws ZERO cables — and every cable you see is one you made.
 */
import type { PlaneMap, Route, Strip } from '../persist/mapDocument.ts'

/** One block of latency, in ms, at the engine's block/rate. The honest price of
    a feedback edge, stated on the object rather than in a tooltip. */
export function feedbackMs(blockFrames = 512, sampleRate = 48000): number {
  return (blockFrames / sampleRate) * 1000
}

export type Cable = {
  /** The route this draws, for hit-testing and removal. */
  route: Route
  /** Source and destination strip keys — cables are drawn between OBJECTS, and
      a strip's channel is an engine detail the view should not carry around. */
  fromKey: string
  toKey: string
  /** Send index when the source is a `channelSend` tap, else null. A send
      cable is a different statement from an output cable: "this strip's send 3
      drives that strip" rather than "this strip feeds that strip". */
  send: number | null
  feedback: boolean
  gain: number
}

/**
 * The routes worth drawing.
 *
 * A route is drawn when BOTH ends are strips on this plane. That excludes the
 * boot defaults by construction (their destination is `main`, not a channel),
 * so nothing has to know which routes were defaults — a distinction the
 * document deliberately does not carry.
 */
export function cablesOf(map: PlaneMap): Cable[] {
  const byChannel = new Map<number, Strip>()
  for (const s of map.strips) byChannel.set(s.channel, s)
  // A `deckOut` cable's source index is a DECK, so it resolves through the grid
  // strip hosting that deck (P3.5-E3). Drawn like any other strip→strip cable —
  // a grid strip feeding its looper IS the pairing cables exist to show, and
  // leaving it undrawn would make the spawned looper look unconnected while it
  // records that deck.
  const byDeck = new Map<number, Strip>()
  for (const s of map.strips) if (s.element.kind === 'grid') byDeck.set(s.element.deck, s)

  const out: Cable[] = []
  for (const r of map.routes) {
    if (r.dst.kind !== 'channelIn') continue
    if (r.src.kind !== 'channelOut' && r.src.kind !== 'channelSend' && r.src.kind !== 'deckOut')
      continue
    const from =
      r.src.kind === 'deckOut' ? byDeck.get(r.src.index) : byChannel.get(r.src.index)
    const to = byChannel.get(r.dst.index)
    // A cable to or from a channel no strip occupies is not drawable — and it
    // is also not a lie the view should invent an endpoint for.
    if (!from || !to) continue
    out.push({
      route: r,
      fromKey: from.key,
      toKey: to.key,
      send: r.src.kind === 'channelSend' ? r.src.sub : null,
      feedback: r.feedback,
      gain: r.gain,
    })
  }
  return out
}

/**
 * The TERMINAL facts a strip states about itself — the chips.
 *
 * Everything that is not a graph edge. `→ main` is the resting state and is
 * deliberately reported even though it is the default: a strip that is NOT on
 * main is the interesting case, and you can only see that if the normal case is
 * also visible. A strip with no output at all is silent for a routing reason,
 * which is exactly what the console used to say and the plane once dropped.
 */
export type Chips = {
  toMain: boolean
  /** FX buses this strip's sends reach, by send index. */
  sends: number[]
  /** Device inputs arriving, as their route source indices. */
  inputs: number[]
  /** Sends re-pointed away from their matching FX bus — the case worth naming,
      because a send fader that appears to do nothing is otherwise a mystery. */
  divertedSends: number[]
}

export function chipsOf(map: PlaneMap, strip: Strip): Chips {
  const chips: Chips = { toMain: false, sends: [], inputs: [], divertedSends: [] }
  for (const r of map.routes) {
    if (r.src.kind === 'channelOut' && r.src.index === strip.channel && r.dst.kind === 'main')
      chips.toMain = true
    if (r.src.kind === 'channelSend' && r.src.index === strip.channel && r.src.sub !== null) {
      if (r.dst.kind === 'sendBus') {
        chips.sends.push(r.src.sub)
        // The default wiring is send n → FX bus n. A send pointing anywhere
        // else is a deliberate choice and worth flagging.
        if (r.dst.index !== r.src.sub) chips.divertedSends.push(r.src.sub)
      } else if (r.dst.kind === 'channelIn') {
        chips.divertedSends.push(r.src.sub)
      }
    }
    if (r.src.kind === 'deviceInput' && r.dst.kind === 'channelIn' && r.dst.index === strip.channel)
      chips.inputs.push(r.src.index)
  }
  return chips
}

/**
 * Does ANYTHING carry this strip's output — main, cue, an FX bus, or another
 * strip's input? (P3-U4.) The chip names only the terminal facts (`toMain`),
 * so a strip chained into another strip would read `▸—` while being perfectly
 * audible; "silent for a routing reason" needs the whole answer, and it is the
 * fault a person is least likely to guess at.
 */
export function hasOutput(map: PlaneMap, strip: Strip): boolean {
  const deck = strip.element.kind === 'grid' ? strip.element.deck : null
  return map.routes.some(
    (r) =>
      ((r.src.kind === 'channelOut' || r.src.kind === 'channelSend') &&
        r.src.index === strip.channel) ||
      // A grid strip's output can also leave as its DECK (P3.5-E3) — the cable
      // that feeds a looper. Counting only channel-space cables would report
      // "no output" on a strip whose deck is plainly being recorded.
      (deck !== null && r.src.kind === 'deckOut' && r.src.index === deck),
  )
}

/** Does anything feed this strip through a consented feedback edge, and what
    does it cost? Drives the strip's status line, so the price is stated on the
    object rather than discovered. */
export function feedbackInto(map: PlaneMap, strip: Strip): number | null {
  const has = map.routes.some(
    (r) => r.feedback && r.dst.kind === 'channelIn' && r.dst.index === strip.channel,
  )
  return has ? feedbackMs() : null
}

/* ── geometry ─────────────────────────────────────────────────────────────── */

export type Point = { x: number; y: number }

/**
 * Where a cable attaches. Output leaves the RIGHT edge, input arrives at the
 * LEFT — the left-to-right convention `pd-plane-playground` §2.4 seeds and
 * never enforces, so a plane laid out that way reads as flow and one laid out
 * any other way still works.
 *
 * A send tap leaves LOWER than the output, so an output cable and a send cable
 * from the same strip are two visibly different statements rather than two
 * lines from one point.
 */
export function outPoint(cell: Strip['cell'], send: number | null): Point {
  return {
    x: cell.x + cell.w,
    y: send === null ? cell.y + cell.h / 2 : cell.y + cell.h * (0.62 + send * 0.08),
  }
}

export function inPoint(cell: Strip['cell']): Point {
  return { x: cell.x, y: cell.y + cell.h / 2 }
}

/**
 * A cubic bezier between two attachment points, with horizontal control arms.
 *
 * Horizontal arms are what make a cable READ as a cable: the line leaves the
 * source travelling right and arrives at the destination travelling right, so
 * direction is legible without an arrowhead at every scale. The arm length
 * grows with distance but is clamped, so a cable across the whole plane does
 * not bow into a circle and two adjacent strips do not get a flat line.
 */
export function cablePath(from: Point, to: Point): string {
  const dx = Math.abs(to.x - from.x)
  const arm = Math.min(160, Math.max(40, dx * 0.5))
  return `M ${from.x} ${from.y} C ${from.x + arm} ${from.y}, ${to.x - arm} ${to.y}, ${to.x} ${to.y}`
}

/** The bounding box every cable fits inside, so the SVG layer can be sized
    without measuring the DOM. Cables can run to negative coordinates — the
    plane is boundless and a strip may sit left of the origin — so the box
    carries an origin as well as a size. */
export function cableBounds(points: readonly Point[]): {
  x: number
  y: number
  w: number
  h: number
} {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 }
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}
