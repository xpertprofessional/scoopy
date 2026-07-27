import { describe, expect, it } from "vitest";
import { gestureTuning, isDoubleTap, twoFingerPanDelta } from "./touchGestures.ts";
import { zoneSizes } from "../panels/cellAffordances.ts";

// Touch composing math (mobile pass, 2026-07-21). The contract that matters
// most: MOUSE VALUES ARE BIT-IDENTICAL to the literals they replaced — the
// desktop feel must not move when the thresholds became a table.

describe("gestureTuning", () => {
  it("mouse/pen keep the original grid literals exactly", () => {
    for (const kind of ["mouse", "pen", ""]) {
      const t = gestureTuning(kind);
      expect(t.deadzonePx).toBe(6);
      expect(t.valueDragArmPx).toBe(8);
      expect(t.valueDragPxPerStep).toBe(6);
      expect(t.accentPxPerLevel).toBe(8);
    }
  });

  it("touch is looser on every axis (fingertip ≫ cursor)", () => {
    const m = gestureTuning("mouse");
    const t = gestureTuning("touch");
    expect(t.deadzonePx).toBeGreaterThan(m.deadzonePx);
    expect(t.valueDragArmPx).toBeGreaterThan(m.valueDragArmPx);
    expect(t.valueDragPxPerStep).toBeGreaterThan(m.valueDragPxPerStep);
    expect(t.accentPxPerLevel).toBeGreaterThan(m.accentPxPerLevel);
  });
});

describe("coarse zone sizes (finger hit-slop; visuals stay fine-geometry)", () => {
  const rect = { x: 0, y: 0, w: 60, h: 68 }; // ≈ compose cell on iPad
  it("coarse zones grow past their fine counterparts", () => {
    const fine = zoneSizes(rect);
    const coarse = zoneSizes(rect, true);
    expect(coarse.corner).toBeGreaterThan(fine.corner);
    expect(coarse.topBand).toBeGreaterThan(fine.topBand);
    expect(coarse.edgeGrab).toBeGreaterThan(fine.edgeGrab);
  });
  it("default (no flag) is the fine table — desktop unchanged", () => {
    expect(zoneSizes(rect)).toEqual(zoneSizes(rect, false));
    expect(zoneSizes(rect).corner).toBeLessThanOrEqual(12);
  });
  it("coarse corners clamp to the fingertip band [14, 20]", () => {
    expect(zoneSizes({ x: 0, y: 0, w: 24, h: 24 }, true).corner).toBe(14);
    expect(zoneSizes({ x: 0, y: 0, w: 120, h: 120 }, true).corner).toBe(20);
  });
});

describe("twoFingerPanDelta", () => {
  it("fingers moving up scrolls content down (positive delta)", () => {
    expect(twoFingerPanDelta([300, 400], [280, 380])).toBe(20);
  });
  it("fingers moving down scrolls content up (negative delta)", () => {
    expect(twoFingerPanDelta([300, 400], [330, 430])).toBe(-30);
  });
  it("empty input pans nothing", () => {
    expect(twoFingerPanDelta([], [200])).toBe(0);
    expect(twoFingerPanDelta([200], [])).toBe(0);
  });
});

describe("isDoubleTap", () => {
  it("two quick nearby taps qualify", () => {
    expect(isDoubleTap({ t: 1000, x: 50, y: 50 }, { t: 1300, x: 60, y: 45 })).toBe(true);
  });
  it("too slow, too far, or no prior tap does not", () => {
    expect(isDoubleTap({ t: 1000, x: 50, y: 50 }, { t: 1400, x: 50, y: 50 })).toBe(false);
    expect(isDoubleTap({ t: 1000, x: 50, y: 50 }, { t: 1200, x: 90, y: 50 })).toBe(false);
    expect(isDoubleTap(null, { t: 1000, x: 50, y: 50 })).toBe(false);
  });
});
