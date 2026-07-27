import { describe, expect, it } from "vitest";
import {
  gcd,
  lcm,
  lcmForScene,
  patternLCM,
  rationalMultiplier,
  switchBoundary,
  trackCycleLength,
} from "./patternClock.ts";
import type { PatternFileJson } from "../persist/patternFile.ts";

/**
 * TS mirror of BeatSequencer.calculatePatternLCM (:17622) + rationalMultiplier (:17675) +
 * the non-owner switch boundary (:12008-12046). A wrong period here is a scene switch that
 * fires mid-phrase — the exact thing the scheduled mode exists to prevent.
 */
describe("rationalMultiplier — exact p/q recovery", () => {
  it("recovers the app's fixed ratio set exactly", () => {
    expect(rationalMultiplier(1)).toEqual([1, 1]);
    expect(rationalMultiplier(2)).toEqual([2, 1]);
    expect(rationalMultiplier(0.5)).toEqual([1, 2]);
    expect(rationalMultiplier(2 / 3)).toEqual([2, 3]);
    expect(rationalMultiplier(3 / 4)).toEqual([3, 4]);
    expect(rationalMultiplier(5 / 4)).toEqual([5, 4]);
    expect(rationalMultiplier(16)).toEqual([16, 1]);
    expect(rationalMultiplier(1.25)).toEqual([5, 4]);
  });

  it("degenerate inputs fall back to 1:1", () => {
    expect(rationalMultiplier(0)).toEqual([1, 1]);
    expect(rationalMultiplier(-2)).toEqual([1, 1]);
    expect(rationalMultiplier(Number.NaN)).toEqual([1, 1]);
  });
});

describe("track cycle + session LCM (the Swift formula)", () => {
  it("cycle = q·stepCount/gcd(p, stepCount)", () => {
    expect(trackCycleLength(16, 1)).toBe(16);
    // ×2 (p=2,q=1): realigns every 16/gcd(2,16)=8 master-steps.
    expect(trackCycleLength(16, 2)).toBe(8);
    // 2:3 (p=2,q=3): 3·16/gcd(2,16) = 24.
    expect(trackCycleLength(16, 2 / 3)).toBe(24);
    // 12 steps at 3:4 → 4·12/gcd(3,12) = 16.
    expect(trackCycleLength(12, 3 / 4)).toBe(16);
    expect(trackCycleLength(0, 1)).toBeNull(); // empty track contributes nothing
    expect(trackCycleLength(16, 0)).toBe(16); // non-positive multiplier → stepCount (Swift guard)
  });

  it("session LCM reduces over tracks; empty session → 16", () => {
    expect(patternLCM([])).toBe(16);
    expect(
      patternLCM([
        { stepCount: 16, speedMultiplier: 1 },
        { stepCount: 12, speedMultiplier: 1 },
      ]),
    ).toBe(lcm(16, 12)); // 48
    expect(
      patternLCM([
        { stepCount: 16, speedMultiplier: 2 }, // 8
        { stepCount: 16, speedMultiplier: 2 / 3 }, // 24
      ]),
    ).toBe(24);
    expect(gcd(0, 5)).toBe(5);
  });
});

describe("switchBoundary — the non-owner model", () => {
  it("fires at the next multiple of lcm(active, target)", () => {
    // active 16, target 12 → joint 48: at step 20 the next boundary is 48, where BOTH patterns
    // sit on their own step 0 — the property that replaces the anchor the ABI cannot move.
    expect(switchBoundary(20, 16, 12)).toBe(48);
    expect(switchBoundary(48, 16, 12)).toBe(96); // exactly ON a boundary → the NEXT one
    expect(switchBoundary(0, 16, 16)).toBe(16);
    expect(switchBoundary(15, 16, 16)).toBe(16);
  });
});

describe("lcmForScene — over the scene's PROJECTION", () => {
  const row = (stepCount: number, speedMultiplier: number) => ({
    id: `T${stepCount}`,
    steps: Array(stepCount).fill(false),
    speedMultiplier,
  });

  it("scene B's step counts (pattern-scoped) drive scene B's cycle", () => {
    const pattern = {
      bpm: 120,
      sectionA: [row(16, 1)],
      sectionB: [{ ...row(16, 1), steps: Array(12).fill(false) }],
      sectionC: [],
      sectionD: [],
      sectionE: [],
      sectionF: [],
      sectionG: [],
      sectionH: [],
    } as PatternFileJson;
    expect(lcmForScene(pattern, "A")).toBe(16);
    expect(lcmForScene(pattern, "B")).toBe(12); // the scene row's steps, via projectScene
    expect(lcmForScene(pattern, "C")).toBe(16); // empty scene inherits A
  });
});
