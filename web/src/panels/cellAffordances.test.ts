import { describe, expect, it } from "vitest";
import type { GridTrackState } from "../../protocol/schema.ts";
import {
  accentScrubLevel,
  affordanceHit,
  fanCount,
  leadInPxToPreMs,
  ownerContext,
  preMsToOnsetFrac,
  zoneSizes,
} from "./cellAffordances.ts";

// P5-PCE in-cell affordances (incell-affordance-ux.md §4.4). Pure-function
// zone + mapping fixtures — the arbitration is geometry, tested here so the
// pointer machine stays dumb.
const rect = (w: number, h: number) => ({ x: 100, y: 50, w, h });
const ctxNoJunction = { hasLeftJunction: false, onsetFrac: 0, hasSample: true };

describe("zoneSizes clamps (min-cell hittability)", () => {
  it("floors at the 24px cell and scales up", () => {
    expect(zoneSizes(rect(24, 24)).corner).toBe(8);
    expect(zoneSizes(rect(24, 24)).topBand).toBe(5);
    expect(zoneSizes(rect(80, 46)).corner).toBe(12); // clamped to max
    expect(zoneSizes(rect(46, 46)).topBand).toBe(6);
  });
});

describe("affordanceHit priority (corner > band > edge > body)", () => {
  const r = rect(46, 46); // corner 12, topBand 6

  it("top-right corner = reverse (beats the accent band)", () => {
    expect(affordanceHit(r, r.x + r.w - 3, r.y + 3, ctxNoJunction)).toBe("reverse");
  });

  it("lower-left corner = flam", () => {
    expect(affordanceHit(r, r.x + 3, r.y + r.h - 3, ctxNoJunction)).toBe("flam");
  });

  it("top band away from the reverse corner = accent", () => {
    expect(affordanceHit(r, r.x + 20, r.y + 3, ctxNoJunction)).toBe("accent");
  });

  it("center body = null (falls to the pointer machine)", () => {
    expect(affordanceHit(r, r.x + 23, r.y + 23, ctxNoJunction)).toBeNull();
  });

  it("left junction strip = glide only when a junction exists", () => {
    const withJ = { hasLeftJunction: true, onsetFrac: 0, hasSample: true };
    expect(affordanceHit(r, r.x + 2, r.y + 20, withJ)).toBe("glide");
    // no junction, no lead-in: the left strip is pre-silence
    expect(affordanceHit(r, r.x + 2, r.y + 20, ctxNoJunction)).toBe("preSilence");
  });

  it("a track with no sample exposes no glide/pre-silence strips", () => {
    const noSample = { hasLeftJunction: false, onsetFrac: 0, hasSample: false };
    expect(affordanceHit(r, r.x + 2, r.y + 20, noSample)).toBeNull();
  });
});

describe("mapping math", () => {
  it("fanCount: rightward drag raises the count, clamps 1…16, 8px floor", () => {
    expect(fanCount(0, 46, 1)).toBe(1);
    expect(fanCount(40, 46, 1)).toBe(6); // 46/8≈5.75→notch clamp… floor(40/8)=5 → +5 = 6
    expect(fanCount(1000, 46, 1)).toBe(16); // clamp
    expect(fanCount(-100, 12, 4)).toBe(1); // back-left → off, narrow step floors notch at 8
  });

  it("accentScrubLevel: up = louder, clamp 0…2, no wrap", () => {
    expect(accentScrubLevel(0, 0)).toBe(0);
    expect(accentScrubLevel(8, 0)).toBe(1);
    expect(accentScrubLevel(100, 0)).toBe(2); // clamps, no wrap to 0
    expect(accentScrubLevel(-8, 2)).toBe(1);
  });

  it("leadInPxToPreMs ⇄ preMsToOnsetFrac round-trip with a lead-in floor", () => {
    // 500ms cell, 40px region, 100ms non-editable floor (swing/rhythmic).
    const preMs = leadInPxToPreMs(20, 40, 500, 100); // 20/40*500=250 → −100 = 150
    expect(preMs).toBe(150);
    const frac = preMsToOnsetFrac(150, 100, 500); // (150+100)/500 = 0.5
    expect(frac).toBeCloseTo(0.5, 5);
  });

  it("leadInPxToPreMs clamps at 0 and 1000", () => {
    expect(leadInPxToPreMs(-5, 40, 500, 0)).toBe(0);
    expect(leadInPxToPreMs(40, 40, 5000, 0)).toBe(1000); // cellDur huge → clamp 1000
  });
});

describe("ownerContext (owner resolution + junction detection)", () => {
  const base = (over: Partial<GridTrackState>): GridTrackState =>
    ({
      stepCount: 16,
      steps: Array(16).fill(false),
      cellLengths: Array(16).fill(1),
      wrapSourceStep: null,
      ...over,
    }) as GridTrackState;

  it("resolves a covered step to its owner", () => {
    const t = base({
      steps: Object.assign(Array(16).fill(false), { 4: true }),
      cellLengths: Object.assign(Array(16).fill(1), { 4: 4 }),
    });
    expect(ownerContext(t, 6)?.owner).toBe(4);
  });

  it("flags a left junction when the previous step is another cell", () => {
    const t = base({
      steps: Object.assign(Array(16).fill(false), { 3: true, 4: true }),
    });
    expect(ownerContext(t, 4)?.hasLeftJunction).toBe(true); // step 3 is a cell
    expect(ownerContext(t, 3)?.hasLeftJunction).toBe(false); // step 2 empty
  });

  it("wrap-continuation cells expose no zones (null)", () => {
    const t = base({
      steps: Object.assign(Array(16).fill(false), { 14: true }),
      cellLengths: Object.assign(Array(16).fill(1), { 14: 4 }), // wraps past 16
      wrapSourceStep: 14,
    });
    expect(ownerContext(t, 0)).toBeNull(); // step 0 via wrap
  });
});
