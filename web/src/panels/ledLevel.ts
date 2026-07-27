/**
 * SIG-3 — meter FILL fraction (0..1) from the engine's decayed per-track output
 * peak. The well paints a fixed green→amber→red gradient; this fraction is how
 * far up the well the fill rises, so a hot track reveals the red top (green to
 * red for hot output). The level is a linear post-chain peak (0 = silent, ≥ 1 =
 * at/over 0 dBFS) that the ENGINE decays (~-60 dB in 300 ms), so no web-side
 * peak-hold is needed — this is a pure, stateless mapping:
 *
 *   - below -60 dB the fill is empty (0): the well shows its dim at-rest state,
 *     and an idle grid stays perfectly still (no shimmer from noise);
 *   - the instant a track is audible the fill shows at least a green sliver
 *     (0.12 floor) — a quiet ringing tail, the whole reason this exists, must
 *     be visible — and rises on a sqrt curve so the red zone is reached only
 *     when the track is genuinely hot (near/over 0 dBFS);
 *   - quantized to 2 decimals so the rAF loop can skip the style write on
 *     unchanged frames (compositor-friendly: ≤ ~30 writes/s per sounding row).
 */
export function levelToLedFill(level: number): number {
  if (!Number.isFinite(level) || level < 0.001) return 0;
  const f = Math.max(0.12, Math.sqrt(Math.min(level, 1)));
  return Math.round(f * 100) / 100;
}
