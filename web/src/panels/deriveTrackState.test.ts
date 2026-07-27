/**
 * P5-06 step B — the two derived fields.
 *
 * `renderGain` and `chopPointsMs` used to be computed in Swift and pushed. They are now
 * computed here, because each mixes a PATTERN input with a RUNTIME one and so belongs to
 * neither topic. That makes this file the seam where the port can silently drift from the
 * Swift original — and the symptom would be subtly wrong waveform amplitudes and chop
 * markers, not a crash. Hence these.
 *
 * Swift originals: WebGridBinding.swift:943 (renderGain) and its `effectiveChopPoints`
 * (deleted in step B; the native WaveformOverlay remains the reference).
 */
import { describe, expect, it } from "vitest";
import type { GridTrackState } from "../../protocol/schema";
import { deriveTrackState, effectiveChopPoints, renderGain } from "./deriveTrackState";
import { withField } from "./trackControls";

describe("renderGain — gain × samplePeakGain", () => {
  it("multiplies the pattern gain by the runtime peak gain", () => {
    expect(renderGain(1.5, 2)).toBe(3);
  });

  it("is why the product could not be a pushed field", () => {
    // THE BUG THIS PREVENTS: after the flip TS owns `gain` and edits it live, while
    // `samplePeakGain` stays Swift's. A pushed `renderGain` would still hold the OLD gain
    // until Swift re-pushed — the waveform amplitude would lie mid-drag. Deriving it means
    // a gain edit is reflected immediately, with no round-trip.
    const samplePeak = 1 / 0.5; // a sample peaking at −6 dBFS
    expect(renderGain(1, samplePeak)).toBe(2);
    expect(renderGain(0.5, samplePeak)).toBe(1); // user drags gain down → derived instantly
  });
});

describe("effectiveChopPoints — resolved chop starts", () => {
  it("keeps a stored point when it is set (>= 0)", () => {
    expect(effectiveChopPoints([0, 250, 500, 750], 4, 1000)).toEqual([0, 250, 500, 750]);
  });

  it("falls back to an EQUAL SLICE for an unset (−1) point — which needs the duration", () => {
    // This fallback is the whole reason the resolved set is not a pattern field: it depends on
    // sampleDurationMs, which only Swift knows.
    expect(effectiveChopPoints([-1, -1, -1, -1], 4, 1000)).toEqual([0, 250, 500, 750]);
  });

  it("mixes stored and unset points per index", () => {
    expect(effectiveChopPoints([-1, 300, -1, -1], 4, 1000)).toEqual([0, 300, 500, 750]);
  });

  it("clamps the count to 1…8, as Swift does", () => {
    expect(effectiveChopPoints([], 0, 800)).toHaveLength(1); // max(1, …)
    expect(effectiveChopPoints([], 99, 800)).toHaveLength(8); // min(8, …)
  });

  it("treats a zero-length sample as duration 1, not 0", () => {
    // Swift: `t.sampleDurationMs > 0 ? t.sampleDurationMs : 1.0`. Without this guard every
    // slice would land on 0 and the chop markers would all stack at the sample's start.
    expect(effectiveChopPoints([-1, -1], 2, 0)).toEqual([0, 0.5]);
  });

  it("survives a chopPoints array SHORTER than the count (Swift bounds-checks too)", () => {
    // Swift's guard is `t.chopPoints.count > i && t.chopPoints[i] >= 0`. A short array must
    // fall through to the slice, not produce undefined.
    expect(effectiveChopPoints([100], 4, 1000)).toEqual([100, 250, 500, 750]);
  });
});

describe("the optimistic echo must RE-DERIVE (the gain box → waveform bug)", () => {
  // Reported on hardware: dragging the gain box moved the number but the waveform amplitude
  // never followed. `withField` did a plain `{...t, gain}` spread, so the DERIVED `renderGain`
  // kept its old value and the waveform redrew at the previous amplitude for the whole drag —
  // only snapping when Swift's push landed ~35 ms later, if at all.
  //
  // Invisible before step B, because Swift PUSHED renderGain: the optimistic echo was just as
  // stale, but it had nothing to be stale about locally. Deriving the field is what made the
  // staleness bite. Any future derived field inherits this trap.
  const base = { gain: 1, samplePeakGain: 2, chopPoints: [], chopCount: 1, sampleDurationMs: 1000 };
  const track = deriveTrackState(base as unknown as Parameters<typeof deriveTrackState>[0]);

  it("recomputes renderGain when the optimistic echo sets gain", () => {
    expect(track.renderGain).toBe(2); // 1 × 2

    const dragged = withField(track as GridTrackState, "gain", 0.5);

    expect(dragged.gain).toBe(0.5);
    expect(dragged.renderGain).toBe(1); // 0.5 × 2 — NOT the stale 2
  });

  it("recomputes chopPointsMs when the optimistic echo moves a chop", () => {
    const t = deriveTrackState({
      ...base,
      chopPoints: [-1, -1],
      chopCount: 2,
    } as unknown as Parameters<typeof deriveTrackState>[0]);
    expect(t.chopPointsMs).toEqual([0, 500]);

    const moved = withField(t as GridTrackState, "chopPoints", [-1, 900]);

    expect(moved.chopPointsMs).toEqual([0, 900]); // the dragged boundary, not the old slice
  });
});
