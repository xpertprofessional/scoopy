/**
 * THE MASTER CLOCK (P11-2) — where the plane's tempo comes from, and the tap
 * that sets it by hand.
 *
 * ⚠️ THE WORD IS **CLOCK**, NEVER **SYNC**, and that is the row's whole reason
 * for existing. Two different things were both being called sync:
 *
 *   CLOCK  (master scope) — where the MASTER's tempo comes from. This file.
 *   SYNC   (deck scope)   — whether THIS deck follows the master. Stays on the
 *                           strip/deck row exactly as `TransportPanel.tsx:25`
 *                           has it, and the master never gains one.
 *
 * P11-0 is what that confusion already cost once: a master control that kept
 * its own copy of a deck's truth and lit a lamp that lied. Sharing a word is
 * how it breeds, so the two scopes no longer share one.
 *
 * Pure functions, pinned as such (the no-jsdom house rule — P11-0's and
 * P11-5's precedent): the tap maths is the part that can be wrong in ways no
 * amount of clicking would reveal.
 */

/** Taps kept in the rolling window: four taps, so three intervals. Enough for
    a median to out-vote ONE bad tap, few enough that the readout follows you
    when you change tempo rather than averaging in the old one. */
export const TAP_WINDOW = 4

/** A longer gap than this starts a NEW series rather than extending the old
    one. Without it, a tap two minutes after the last one averages against
    ancient intervals and produces a tempo nobody asked for. 2.5 s is just
    past the slowest interval that could still be meant as a beat (24 BPM). */
export const TAP_TIMEOUT_MS = 2500

/** The same range the master's own number box accepts. A tap series that
    implies something outside it is a mis-tap, not a tempo — reported as
    "cannot say" rather than clamped, because clamping would silently set 20
    when you fumbled and teach you the button is erratic. */
export const TAP_MIN_BPM = 20
export const TAP_MAX_BPM = 300

export interface TapResult {
  /** The series after this tap. Hand it back in on the next one. */
  taps: number[]
  /** The tempo this series implies, or null while it cannot honestly say. */
  bpm: number | null
}

/**
 * Fold one tap into a series.
 *
 * Deliberately a PURE function over the timestamps rather than a stateful
 * tapper: the caller keeps the array, so the maths can be tested with a
 * hand-written series and no clock at all.
 */
export function tapTempo(previous: readonly number[], now: number): TapResult {
  const last = previous[previous.length - 1]
  const continues = last !== undefined && now - last <= TAP_TIMEOUT_MS
  const taps = (continues ? [...previous, now] : [now]).slice(-TAP_WINDOW)
  return { taps, bpm: bpmOf(taps) }
}

/**
 * Drop the intervals that cannot belong to the beat the others describe.
 *
 * THE TWO REAL MIS-TAPS, and they are why a plain mean is not good enough: a
 * MISSED tap makes one interval ~2x its neighbours, and a DOUBLE tap makes one
 * ~0.5x. Either one drags a three-interval mean far enough to matter — a single
 * doubled interval in a 120 BPM series pulls the mean to 90.
 *
 * The median is the reference because it is the statistic a single bad value
 * cannot move. Below three intervals nothing is rejected: with two there is no
 * majority, so "which of these is wrong" has no honest answer and dropping
 * either would be a guess.
 */
export function rejectOutliers(intervals: readonly number[]): number[] {
  if (intervals.length < 3) return [...intervals]
  const mid = median(intervals)
  const kept = intervals.filter((i) => i >= mid * 0.6 && i <= mid * 1.6)
  // If the window is so ragged that everything is an outlier, the median was
  // not describing a beat either. Keep the lot and let the BPM range decide.
  return kept.length > 0 ? kept : [...intervals]
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function bpmOf(taps: readonly number[]): number | null {
  const intervals: number[] = []
  for (let i = 1; i < taps.length; i++) intervals.push(taps[i]! - taps[i - 1]!)
  if (intervals.length === 0) return null // one tap says nothing about tempo

  const kept = rejectOutliers(intervals)
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length
  if (!(mean > 0)) return null // two taps inside the same millisecond

  // One decimal, matching the steppers — the master tempo is a document value
  // and tapping must not accumulate float dust into it.
  const bpm = Math.round((60000 / mean) * 10) / 10
  return bpm >= TAP_MIN_BPM && bpm <= TAP_MAX_BPM ? bpm : null
}

export interface ExternalClockState {
  /** May the EXT control be operated? */
  enabled: boolean
  /** Why not — shown on the control itself. Never null while disabled. */
  reason: string
}

/**
 * Can this host take its tempo from an EXTERNAL clock?
 *
 * **MEASURED 2026-07-30, and the answer is NO at three independent layers** —
 * which matters, because the row proposed gating this on `midiHardware` alone
 * and that one flag is not the whole truth:
 *
 *   1. The shell answers `midiHardware: false` — `SlDispatch.cpp:93`, whose own
 *      comment is "not built", asserted by `sl_dispatch_test.cpp:78`.
 *   2. The shell implements NO clock method at all. `getMidiClockStatus` is
 *      fully specified in `protocol/schema.ts:605` (locked / bpm / tickCount)
 *      and `SlDispatch.cpp` handles it zero times. The protocol promises a
 *      surface nothing answers — P11-5's disease, one domain over.
 *   3. It is not in `MergedLink.NATIVE_METHODS`, so even a shell that DID
 *      implement it would not be asked: the call falls through to the browser
 *      companion, which refuses it by name.
 *
 * ⚠️ SO THE GATE IS NOT `caps.midiHardware`, AND THAT IS DELIBERATE. Capabilities
 * default to FULL (`capabilitiesStore.ts:16` — every flag true until a host
 * narrows them), so a control gated on that flag alone renders LIVE for the
 * frames before the handshake lands, and renders live forever in any render
 * path that never runs the effect. A control that is briefly operable and
 * permanently useless is precisely the failure the four rules exist for. EXT is
 * unavailable in this build unconditionally; the flag only chooses which true
 * sentence to show.
 *
 * When the shell grows a real clock this is the ONE place to change, and its
 * test says what has to become true first.
 */
export function externalClockState(caps: { midiHardware: boolean }): ExternalClockState {
  return {
    enabled: false,
    reason: caps.midiHardware
      ? 'external clock — this host has no MIDI clock in yet (getMidiClockStatus is unimplemented)'
      : 'external clock — no MIDI hardware in this build, so there is nothing to follow',
  }
}
