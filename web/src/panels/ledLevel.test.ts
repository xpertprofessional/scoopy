import { describe, expect, it } from "vitest";
import { levelToLedFill } from "./ledLevel.ts";

describe("levelToLedFill (SIG-3)", () => {
  it("is empty below the -60 dB floor (an idle grid must not shimmer)", () => {
    expect(levelToLedFill(0)).toBe(0);
    expect(levelToLedFill(0.0009)).toBe(0);
    expect(levelToLedFill(-1)).toBe(0);
    expect(levelToLedFill(Number.NaN)).toBe(0);
    expect(levelToLedFill(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("shows at least a green sliver the moment a track is audible", () => {
    // The quiet ringing tail is the whole point — it must be visible, never a
    // zero-height fill hidden in the well.
    expect(levelToLedFill(0.001)).toBeGreaterThanOrEqual(0.12);
    expect(levelToLedFill(0.02)).toBeGreaterThanOrEqual(0.12);
  });

  it("reaches the red top only when the track is genuinely hot", () => {
    // A moderate level sits in the green/amber; the red zone (top ~20%) is for
    // a track near/over 0 dBFS.
    expect(levelToLedFill(0.1)).toBeLessThan(0.8);
    expect(levelToLedFill(1)).toBe(1);
    expect(levelToLedFill(4)).toBe(1); // clamped over 0 dBFS
  });

  it("climbs monotonically with level", () => {
    const out = [0.02, 0.05, 0.2, 0.5, 1].map(levelToLedFill);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1]!);
  });

  it("quantizes to 2 decimals (the rAF loop's write-skip key)", () => {
    for (const v of [0.001, 0.037, 0.42, 0.999]) {
      const o = levelToLedFill(v);
      expect(o).toBe(Math.round(o * 100) / 100);
    }
  });
});
