/**
 * Fader position → gain (D-WZ-FADER-01): −∞..+6 dB audio taper, unity at 0.75.
 *
 * IDENTICAL algorithm to engine/src/fader.cpp (Fritsch–Carlson monotone cubic
 * through the signed reference knots in dB-space, linear-in-dB tail below the
 * first knot, true zero at position 0). Both sides run in double precision;
 * the golden-table fixture pins them to the same 21 values at 1e-9. Change one
 * side and the fixture fails — that is the point.
 */

const POS = [0.05, 0.25, 0.5, 0.75, 1.0] as const
const DB = [-60.0, -24.0, -8.0, 0.0, 6.0] as const
const FLOOR_DB = -120.0
const N = POS.length

function computeTangents(): number[] {
  const d: number[] = []
  for (let i = 0; i < N - 1; i++) d.push((DB[i + 1]! - DB[i]!) / (POS[i + 1]! - POS[i]!))
  const m: number[] = new Array(N).fill(0)
  m[0] = d[0]!
  m[N - 1] = d[N - 2]!
  for (let i = 1; i < N - 1; i++) {
    if (d[i - 1]! * d[i]! <= 0) {
      m[i] = 0
    } else {
      // Weighted harmonic mean (Fritsch–Butland form) — monotone-safe.
      const w1 = 2 * (POS[i + 1]! - POS[i]!) + (POS[i]! - POS[i - 1]!)
      const w2 = POS[i + 1]! - POS[i]! + 2 * (POS[i]! - POS[i - 1]!)
      m[i] = (w1 + w2) / (w1 / d[i - 1]! + w2 / d[i]!)
    }
  }
  return m
}

const M = computeTangents()

/** dB at `position` ∈ (0, 1]. Callers treat position <= 0 as −∞. */
export function faderPositionToDb(position: number): number {
  if (position >= 1) return DB[N - 1]!
  if (position <= POS[0]!) {
    const f = position / POS[0]!
    return FLOOR_DB + f * (DB[0]! - FLOOR_DB)
  }
  let i = 0
  while (i < N - 2 && position >= POS[i + 1]!) i++
  const h = POS[i + 1]! - POS[i]!
  const s = (position - POS[i]!) / h
  const s2 = s * s
  const s3 = s2 * s
  const h00 = 2 * s3 - 3 * s2 + 1
  const h10 = s3 - 2 * s2 + s
  const h01 = -2 * s3 + 3 * s2
  const h11 = s3 - s2
  return h00 * DB[i]! + h10 * h * M[i]! + h01 * DB[i + 1]! + h11 * h * M[i + 1]!
}

/** Linear gain at `position` ∈ [0, 1]; exactly 0 at position <= 0 (true mute). */
export function faderPositionToLinear(position: number): number {
  if (position <= 0) return 0
  return Math.pow(10, faderPositionToDb(position) / 20)
}

/** Unity detent position (0 dB) — UI snap target. */
export const FADER_UNITY_POSITION = 0.75
