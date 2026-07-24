/**
 * Signed varispeed MATH (P4-07, playback-composer.md §1).
 *
 * The slider component itself is gone: the Strip renders speed with the shared
 * Layout-B ParamRow like every other parameter, so a bespoke control would be a
 * second idiom for no gain. These helpers are the part that carries the design —
 * the logarithmic travel, the reverse half, and snapUnity, which is what makes
 * the engine's bit-exact identity path reachable by dragging.
 *
 * ONE slider spanning reverse and forward, because the engine has one signed
 * rate — reverse is not a mode, it is the negative half of the same control
 * (CONCEPT: "reverse is first-class everywhere"). The travel is logarithmic so
 * halving and doubling are symmetric gestures, with a **unity detent** at the
 * centre-forward position and a marked reverse zone.
 *
 * DELIBERATELY STANDALONE: this component takes a rate and an onChange and
 * knows nothing about decks, racks or the store. PD-CANVAS reuses it inside a
 * Cell unchanged (docs/specs/pd-canvas.md §3) — the container changes, the
 * control does not.
 */

/** Slider travel is in "octaves" of speed: ±4 → ±16×, matching the engine clamp. */
const MAX_OCT = 4

/**
 * The slowest speed sits at ±FLOOR_POS rather than at 0, so reverse and forward
 * never share a boundary point. Without this the slowest REVERSE speed maps to
 * position -0, and `-0 < 0` is false in JS — the direction would be silently
 * lost at exactly one end of the travel. The gap also gives the centre a small
 * dead zone, which is a natural place for a slider to rest.
 */
const FLOOR_POS = 0.02

/** Signed rate → slider position in [-1, 1]. */
export function rateToPosition(rate: number): number {
  const mag = Math.min(16, Math.max(1 / 16, Math.abs(rate) || 1))
  const oct = Math.log2(mag) / MAX_OCT // -1 at 1/16×, 0 at 1×, +1 at 16×
  const forward = FLOOR_POS + ((oct + 1) / 2) * (1 - FLOOR_POS) // [FLOOR_POS, 1]
  return rate < 0 ? -forward : forward
}

/** Slider position in [-1, 1] → signed rate. */
export function positionToRate(pos: number): number {
  const span = Math.min(1, (Math.abs(pos) - FLOOR_POS) / (1 - FLOOR_POS))
  const oct = Math.max(0, span) * 2 - 1
  const mag = Math.pow(2, oct * MAX_OCT)
  const clamped = Math.min(16, Math.max(1 / 16, mag))
  return pos < 0 ? -clamped : clamped
}

/** Snap near-unity to EXACTLY 1 so the engine's bit-exact identity path is
    actually reachable by dragging — without this a user could never quite land
    on it (the same trap the engine's smoother had). */
export function snapUnity(rate: number): number {
  const mag = Math.abs(rate)
  if (mag > 0.97 && mag < 1.03) return rate < 0 ? -1 : 1
  return rate
}

export function formatRate(rate: number): string {
  const mag = Math.abs(rate)
  const body = mag >= 1 ? `${mag.toFixed(2)}×` : `1/${(1 / mag).toFixed(2)}`
  return rate < 0 ? `◀ ${body}` : body
}

interface Props {
  rate: number
  onChange: (rate: number) => void
  width?: number
}
