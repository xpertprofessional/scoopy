/**
 * THE MOTORISED MASTER TEMPO (S3 · ported from the donor, `DJModeView.swift:268`).
 *
 * A tempo move is not a jump. Dragging the master from 120 to 140 — and above
 * all dragging it toward 0 — should ride there like a platter spinning up or a
 * tape stopping, in every tempo mode. That behaviour is the donor's and this is
 * its port; the maths below is its exponential approach, not a new invention.
 *
 * TWO VALUES, WHICH IS THE WHOLE DESIGN:
 *
 *   TARGET  `map.transport.masterBpm` — what the box shows and what persists.
 *           Set instantly, so typing 140 reads 140 immediately.
 *   LIVE    this module — what the ENGINE follows, approaching the target.
 *
 * Keeping the box on the target is deliberate rather than incidental: a box
 * that animated to 137.4 while you typed 140 would be reporting the mechanism
 * instead of your intent, and every intermediate value would land in the
 * document and the autosave path.
 *
 * ⚠️ THE IMPORT CYCLE IS THE HOUSE PATTERN, not an accident. This module calls
 * `applyTempo` and `mapStore` reads `liveMasterBpm()` — deferred on both sides,
 * exactly as `nudgeStore` does, and `mapStore`'s own comment describes: "neither
 * touches the other at module scope."
 */
import type { EngineLink } from '../engineLink.ts'
import { applyTempo, getMap } from './mapStore.ts'

/** 25 Hz, the donor's rate. Fine enough that a ramp is heard as motion rather
    than as steps, cheap enough to run for seconds. */
const TICK_MS = 40

/** Seconds. 0 = no ramp (the tempo snaps, as it did before this existed); the
    ceiling is a long tape stop. Its OWN number, and the donor is explicit about
    why: it used to follow the shared slider-glide time, but "a turntable stop
    wants seconds where a fader morph wants milliseconds. One number could not
    serve both." */
export const RAMP = { def: 0.3, min: 0, max: 5 } as const

/** Below this the ramp is over — snapping the last hundredth avoids a tail of
    ever-smaller steps that never quite arrive. The donor's 0.02. */
const ARRIVED = 0.02

/**
 * ONE TICK of the exponential approach. Pure, and the reason the rest of this
 * file needs no test of its own: everything that can be wrong about a ramp is
 * in here.
 *
 * `tau = duration / 3`, so the nominal ramp time covers ~95% of the jump — the
 * donor's sizing, kept because "0.3 s" should mean the same thing to a person
 * here as it does there.
 */
export function glideStep(from: number, to: number, tickMs: number, rampSeconds: number): number {
  // A floor on the duration, because it divides: a 0 arriving here (rather than
  // being caught as "no ramp" before the timer starts) would otherwise be an
  // infinity in the exponent.
  const duration = Math.max(0.02, rampSeconds)
  const k = 1 - Math.exp((-tickMs / 1000) * 3 / duration)
  const next = from + (to - from) * k
  return Math.abs(next - to) < ARRIVED ? to : next
}

let live: number | null = null // null = not gliding; the target IS the live value
let timer: ReturnType<typeof setInterval> | null = null
let ramp: number = RAMP.def

/** What the engine should currently be following. `null` while at rest, so
    `mapStore` falls back to the document and nothing changes when idle. */
export function liveMasterBpm(): number | null {
  return live
}

/** The ramp length, in seconds. Read LIVE on every tick, so changing it
    mid-glide takes effect immediately rather than at the next move. */
export function setTempoRamp(seconds: number): void {
  ramp = Math.min(RAMP.max, Math.max(RAMP.min, seconds))
}

export function tempoRamp(): number {
  return ramp
}

function stop(): void {
  if (timer !== null) clearInterval(timer)
  timer = null
  live = null
}

/**
 * Begin (or redirect) a glide toward the document's current master tempo.
 *
 * A RUNNING GLIDE FOLLOWS A MOVING TARGET rather than restarting — the donor's
 * `guard tempoGlideTimer == nil`. Restarting on every drag pixel would reset
 * the approach constantly and the tempo would crawl instead of ride.
 */
export function glideToMaster(link: EngineLink | null, fromBpm: number): void {
  const target = getMap().transport.masterBpm

  // NO RAMP, or already there: snap. Checked here rather than in the tick, so
  // no timer is ever scheduled for a move that does not need one.
  if (ramp <= 0.001 || (live !== null && Math.abs(live - target) <= ARRIVED)) {
    stop()
    void applyTempo(link)
    return
  }

  if (timer !== null) return // already gliding; it will find the new target

  // THE CALLER SAYS WHERE IT STARTS, and that is deliberate. This module could
  // remember the last value it applied, but then a document change made by
  // anything else (opening a session, installing the map) would leave that
  // memory stale and the next glide would ramp from a tempo the engine had
  // long left. The one caller that knows the true starting point is the one
  // about to overwrite it.
  if (live === null) live = fromBpm
  if (Math.abs(live - target) <= ARRIVED) {
    stop()
    void applyTempo(link)
    return
  }

  timer = setInterval(() => {
    const to = getMap().transport.masterBpm // re-read: the target may have moved
    const from = live ?? to
    const next = glideStep(from, to, TICK_MS, ramp)
    live = next
    void applyTempo(link)
    if (next === to) stop()
  }, TICK_MS)
}

/** For tests and teardown — a glide must not outlive the surface that started it. */
export function stopGlide(): void {
  stop()
}
