/**
 * P5-06 step B — the two fields that belong to NEITHER side, derived TS-side.
 *
 * `renderGain` and `chopPointsMs` each mix a PATTERN input with a RUNTIME one, so neither
 * `gridPattern/<i>` nor `gridRuntime/<i>` can own them. Swift used to compute and push both.
 * That breaks the moment TS owns its pattern half:
 *
 *   renderGain = gain × samplePeakGain
 *                ^pattern (TS owns, edits live)   ^runtime (only Swift knows)
 *
 * Drag the gain box after the flip and Swift's pushed `renderGain` is stale — the waveform
 * amplitude (gridWave.ts) would quietly lie until something else triggered a re-push. So the
 * wire carries the PRIMITIVES and TS derives the products here, once, for every surface.
 *
 * Ports two Swift functions verbatim. If either drifts, waveforms and chop markers go subtly
 * wrong rather than obviously broken, so both are pinned by tests.
 */
import type { GridTrackState, GridWireState } from "../../protocol/schema";

/**
 * Resolved chop starts — mirror of `WebGridBinding.effectiveChopPoints`
 * (WebGridBinding.swift:1064-1073), which itself mirrors the native WaveformOverlay.
 *
 * A stored point of −1 means "not set": fall back to an equal slice of the sample. That
 * fallback needs the sample DURATION, which is runtime — which is exactly why the resolved
 * set could never be a pattern field.
 */
export function effectiveChopPoints(
  chopPoints: readonly number[],
  chopCount: number,
  sampleDurationMs: number,
): number[] {
  // Swift: `t.sampleDurationMs > 0 ? t.sampleDurationMs : 1.0` — a zero-length sample would
  // otherwise put every slice at 0.
  const duration = sampleDurationMs > 0 ? sampleDurationMs : 1.0;
  const count = Math.max(1, Math.min(8, chopCount));
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const stored = chopPoints[i];
    if (stored !== undefined && stored >= 0) out.push(stored);
    else out.push((duration * i) / count);
  }
  return out;
}

/** `renderGain` — mirror of WebGridBinding.swift:943: `(trackGain ?? 1.0) * samplePeakGain`. */
export function renderGain(gain: number, samplePeakGain: number): number {
  // `gain` already carries Swift's `?? 1.0` nil-coalesce (the wire field is non-optional).
  return gain * samplePeakGain;
}

/**
 * The locator's length — Track.swift:660, `max(1, min(euclideanSteps, end - start + 1))`.
 *
 * The wire carries START + END (the document's own fields) since C3b. It used to carry this
 * computed LENGTH instead, which lost information: the raw end MAY EXCEED the pattern (that is
 * how a wrapping locator is encoded), so the end could not be recovered from the clamped length
 * — and `setStepCount`'s locator re-fit, which reads the raw end, could not be reproduced.
 */
export function locatorLengthSteps(start: number, end: number, stepCount: number): number {
  const n = Math.max(1, stepCount);
  return Math.max(1, Math.min(n, end - start + 1));
}

/** Merge the two wire halves into the view every panel consumes. */
export function deriveTrackState(wire: GridWireState): GridTrackState {
  const len = locatorLengthSteps(wire.locatorStartStep, wire.locatorEndStep, wire.stepCount);
  return {
    ...wire,
    renderGain: renderGain(wire.gain, wire.samplePeakGain),
    chopPointsMs: effectiveChopPoints(wire.chopPoints, wire.chopCount, wire.sampleDurationMs),
    locatorLengthSteps: len,
    // The row's display values: null while the repeat is off (Swift gated these on the wire).
    locatorStart: wire.locatorRepeatActive ? wire.locatorStartStep : null,
    locatorLength: wire.locatorRepeatActive ? len : null,
  };
}
