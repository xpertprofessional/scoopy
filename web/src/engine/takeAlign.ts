/**
 * Law C-2 — multitrack from timestamps, not a timeline.
 *
 * Every take is stamped with the engine sample at which its recording began.
 * Two takes therefore carry an exact relative offset: their stamp DELTA. There
 * is no shared timeline (Law C-1) and no editing session involved — "align deck
 * 2 to deck 1" is a subtraction.
 *
 * All functions here are pure integer sample math (no floats, no rate
 * conversion): every take is at the engine rate by construction
 * (D-WZ-RATE-01/D-WZ-DECKSRC-01), so a delta in samples is meaningful across
 * takes without any per-take rate bookkeeping.
 */
import type { Take } from '../../protocol/schema'

/**
 * Signed offset of `take` relative to `reference`, in engine samples.
 * Positive = `take` started LATER than the reference (it needs that much
 * leading silence to line up); negative = it started earlier.
 */
export function alignOffsetSamples(take: Take, reference: Take): number {
  return take.startEngineSample - reference.startEngineSample
}

/** The offset as seconds at the engine rate (display only — math stays integer). */
export function alignOffsetSeconds(take: Take, reference: Take, engineRate: number): number {
  if (engineRate <= 0) return 0
  return alignOffsetSamples(take, reference) / engineRate
}

/**
 * Where a take sits on a common origin, given a set of takes: the origin is the
 * EARLIEST stamp among them, so every returned offset is >= 0 — the leading
 * silence each take needs when they are laid side by side. This is what a
 * "reconstruct the session" export walks (Law C-2's promise that the true
 * relative timing is always recoverable).
 */
export function relativeToEarliest(takes: readonly Take[]): Map<string, number> {
  const out = new Map<string, number>()
  if (takes.length === 0) return out
  let origin = takes[0]!.startEngineSample
  for (const t of takes) if (t.startEngineSample < origin) origin = t.startEngineSample
  for (const t of takes) out.set(t.path, t.startEngineSample - origin)
  return out
}

/**
 * Do two takes overlap in real time? (Both are at the engine rate, so this is
 * pure sample arithmetic.) Used by the UI to show which takes were captured
 * simultaneously — the "I recorded deck 2 while deck 1 was running" case that
 * Law C-2 exists to make reconstructible.
 */
export function takesOverlap(a: Take, b: Take): boolean {
  const aEnd = a.startEngineSample + a.frames
  const bEnd = b.startEngineSample + b.frames
  return a.startEngineSample < bEnd && b.startEngineSample < aEnd
}

/**
 * The loop-region shift that aligns `take` to `reference` inside a deck: a deck
 * playing `take` should start reading at this sample to be in phase with the
 * reference. Clamped to the take's own length — an offset larger than the take
 * means they never overlapped, and 0 (its own start) is the honest answer.
 */
export function alignedStartSample(take: Take, reference: Take): number {
  const delta = alignOffsetSamples(take, reference)
  if (delta >= 0) return 0 // take started later: it plays from its own start
  const shift = -delta // take started earlier: skip into it
  return shift < take.frames ? shift : 0
}

/** Human label for a stamp delta, e.g. "+1.250 s" / "−0.500 s" / "in phase". */
export function formatOffset(samples: number, engineRate: number): string {
  if (samples === 0) return 'in phase'
  if (engineRate <= 0) return `${samples} spl`
  const s = samples / engineRate
  const sign = s > 0 ? '+' : '−'
  return `${sign}${Math.abs(s).toFixed(3)} s`
}
