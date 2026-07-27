import { describe, expect, it } from "vitest";
import { aggregateColumns, spectrumColor, type Peaks } from "./waveRender.ts";

/**
 * The TRUTH CONTRACT under test (design/waveformStyle.ts). Not cosmetic
 * assertions: the premise of a waveform *style* is that no style can lie about
 * the audio. Each test below is one way this renderer could quietly start lying.
 */

/** Peaks with a single sharp transient at source column `spike`. */
const withSpike = (columns: number, spike: number, amp = 0.9): Peaks => {
  const minMax: number[] = [];
  const rms: number[] = [];
  for (let i = 0; i < columns; i++) {
    const v = i === spike ? amp : 0.05;
    minMax.push(-v, v);
    rms.push(v * 0.5);
  }
  return { minMax, rms };
};

describe("aggregateColumns — peak preservation (truth rule 1)", () => {
  it("keeps a transient that falls between drawn columns", () => {
    // 200 source columns → 8 drawn: 25 collapse into each. A renderer that
    // SAMPLED (took every 25th) would miss the spike at 37 entirely.
    const pk = withSpike(200, 37);
    const cols = aggregateColumns(pk, 0, 1, false, 8);
    expect(Math.max(...Array.from(cols.mx))).toBeCloseTo(0.9, 5);
    // …and it lands in the column that actually covers source 37 (37/25 = 1).
    expect(cols.mx[1]).toBeCloseTo(0.9, 5);
    expect(cols.mx[0]).toBeCloseTo(0.05, 5);
  });

  it("preserves the peak at every density, down to a single column", () => {
    const pk = withSpike(512, 300);
    for (const n of [1, 2, 5, 16, 64, 256]) {
      const cols = aggregateColumns(pk, 0, 1, false, n);
      expect(Math.max(...Array.from(cols.mx))).toBeCloseTo(0.9, 5);
    }
  });

  it("keeps the true signed extremes — a waveform is not symmetric", () => {
    const pk: Peaks = { minMax: [-0.2, 0.8, -0.7, 0.1], rms: [0.3, 0.3] };
    const cols = aggregateColumns(pk, 0, 1, false, 2);
    expect(cols.mx[0]).toBeCloseTo(0.8, 5);
    expect(cols.mn[0]).toBeCloseTo(-0.2, 5);
    expect(cols.mx[1]).toBeCloseTo(0.1, 5);
    expect(cols.mn[1]).toBeCloseTo(-0.7, 5);
  });

  it("mirrors the window when reversed, without leaving it", () => {
    const pk = withSpike(100, 10);
    const fwd = aggregateColumns(pk, 0, 1, false, 10);
    const rev = aggregateColumns(pk, 0, 1, true, 10);
    expect(fwd.mx[1]).toBeCloseTo(0.9, 5);
    expect(rev.mx[8]).toBeCloseTo(0.9, 5); // mirrored to the far end
    expect(rev.mx[1]).toBeCloseTo(0.05, 5);
  });

  it("aggregates only inside the requested window", () => {
    const pk = withSpike(100, 90);
    const cols = aggregateColumns(pk, 0, 0.5, false, 5); // first half only
    expect(Math.max(...Array.from(cols.mx))).toBeCloseTo(0.05, 5);
  });

  it("derives a body from the peak when the sample has no RMS array", () => {
    const pk: Peaks = { minMax: [-0.4, 0.4, -0.8, 0.8], rms: [] };
    const cols = aggregateColumns(pk, 0, 1, false, 2);
    expect(cols.rms[1]).toBeCloseTo(0.8 * 0.55, 5);
  });
});

describe("spectrum colour — hue carries the measured centroid", () => {
  const P = { low: "#000080", mid: "#00ff00", high: "#ff0000" };

  it("maps the ramp ends to the palette ends, and the middle to mid", () => {
    expect(spectrumColor(0, P)).toBe("rgb(0, 0, 128)");
    expect(spectrumColor(0.5, P)).toBe("rgb(0, 255, 0)");
    expect(spectrumColor(1, P)).toBe("rgb(255, 0, 0)");
  });

  it("is monotonic — a brighter sound never maps to a darker-end colour", () => {
    const redness = (t: number) => Number(spectrumColor(t, P).match(/\d+/)![0]);
    for (let t = 0.5; t < 1; t += 0.1) {
      expect(redness(t + 0.1)).toBeGreaterThanOrEqual(redness(t));
    }
  });

  it("clamps out-of-range input instead of producing garbage", () => {
    expect(spectrumColor(-3, P)).toBe(spectrumColor(0, P));
    expect(spectrumColor(9, P)).toBe(spectrumColor(1, P));
  });
});

describe("brightness aggregation — amplitude-weighted (the wash-out bug)", () => {
  it("lets the LOUD part decide the colour, not the silence around it", () => {
    // One loud bright column, three silent ones whose centroid reads 0. A flat
    // mean would give ≈0.22 (dark) and wash the cell out. What you HEAR is
    // bright, so the colour must be.
    const pk: Peaks = {
      minMax: [-0.9, 0.9, 0, 0, 0, 0, 0, 0],
      rms: [0.7, 0, 0, 0],
      brightness: [0.9, 0, 0, 0],
    };
    const cols = aggregateColumns(pk, 0, 1, false, 1);
    expect(cols.br[0]).toBeGreaterThan(0.85);
  });

  it("reports 0 brightness when the sample carries none (no spectrum fetched)", () => {
    const pk: Peaks = { minMax: [-0.5, 0.5, -0.5, 0.5], rms: [0.3, 0.3] };
    const cols = aggregateColumns(pk, 0, 1, false, 2);
    expect(Array.from(cols.br)).toEqual([0, 0]);
  });

  it("keeps per-column resolution: a dark column and a bright one stay apart", () => {
    const pk: Peaks = {
      minMax: [-0.8, 0.8, -0.8, 0.8],
      rms: [0.6, 0.6],
      brightness: [0.1, 0.95],
    };
    const cols = aggregateColumns(pk, 0, 1, false, 2);
    expect(cols.br[0]).toBeCloseTo(0.1, 3);
    expect(cols.br[1]).toBeCloseTo(0.95, 3);
  });
});
