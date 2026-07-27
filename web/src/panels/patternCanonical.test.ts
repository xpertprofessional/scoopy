/**
 * P5-06 step C — the full-pattern comparison the drift detector runs on.
 *
 * The detector previously compared nine hand-listed cell arrays, so a `trackEdit` reducer could
 * get `gain` wrong and be reported CLEAN. Comparing the whole pattern fixes that — but only if
 * the comparison itself is trustworthy, and there is one way it very easily is not: floats.
 */
import { describe, expect, it } from "vitest";
import type { GridPatternState } from "../../protocol/schema";
import { canonicalPatternState, patternDiffFields } from "./patternCanonical";

const pat = (over: Record<string, unknown>): GridPatternState =>
  ({ gain: 1, volume: 1, steps: [true, false], ...over }) as unknown as GridPatternState;

describe("canonicalPatternState", () => {
  it("is INSENSITIVE to key order (two equal patterns must serialize identically)", () => {
    const a = { gain: 1, volume: 2 } as unknown as GridPatternState;
    const b = { volume: 2, gain: 1 } as unknown as GridPatternState;
    expect(canonicalPatternState(a)).toBe(canonicalPatternState(b));
  });

  it("SURVIVES the Float32 round-trip — the trap that would drift on every edit", () => {
    // TS predicts `gain: 0.3`. Swift stores it as a Float and pushes back the float32 value.
    // Without normalization the detector would report drift on literally every gain edit and
    // the evidence gate would be pure noise.
    const predicted = pat({ gain: 0.3 });
    const authoritative = pat({ gain: 0.30000001192092896 }); // Float(0.3) as a Double

    expect(canonicalPatternState(predicted)).toBe(canonicalPatternState(authoritative));
  });

  it("still catches a REAL difference (normalization must not blind it)", () => {
    // The fear with fround: that it papers over genuine divergence. It only collapses
    // differences below float32 epsilon — anything a user could hear or save still shows.
    expect(canonicalPatternState(pat({ gain: 0.3 }))).not.toBe(
      canonicalPatternState(pat({ gain: 0.31 })),
    );
    expect(canonicalPatternState(pat({ steps: [true, false] }))).not.toBe(
      canonicalPatternState(pat({ steps: [true, true] })),
    );
  });

  it("treats -0 as 0 (Swift prints 0; JS would print -0)", () => {
    expect(canonicalPatternState(pat({ pan: -0 }))).toBe(canonicalPatternState(pat({ pan: 0 })));
  });

  it("distinguishes null from absent-but-zero", () => {
    expect(canonicalPatternState(pat({ wrapSourceStep: null }))).not.toBe(
      canonicalPatternState(pat({ wrapSourceStep: 0 })),
    );
  });
});

describe("patternDiffFields — a drift report must NAME the field", () => {
  it("names exactly the diverged fields, not the whole payload", () => {
    const a = pat({ gain: 1, volume: 1, pan: 0 });
    const b = pat({ gain: 2, volume: 1, pan: 0.5 });
    expect(patternDiffFields(a, b)).toEqual(["gain", "pan"]);
  });

  it("reports nothing when only float noise differs", () => {
    expect(patternDiffFields(pat({ gain: 0.3 }), pat({ gain: 0.30000001192092896 }))).toEqual([]);
  });
});

describe("why the comparison was widened (the gate was green about the wrong thing)", () => {
  it("the OLD nine-array subset would call a gain corruption CLEAN", () => {
    // This is the whole argument for step C. `canonicalGridSubset` compared steps, cellLengths,
    // accents, flams, glides, reverses, preSilence and wrapSourceStep — and nothing else. A
    // reducer that got the cells perfectly right but also clobbered `gain`, `stepCount` or
    // `chopPoints` was reported as a CLEAN verification, and the flip's evidence gate counted
    // it toward green. The detector never looked at the field that broke.
    const a = pat({ gain: 1, steps: [true, false] });
    const b = pat({ gain: 999, steps: [true, false] }); // cells identical, gain destroyed

    // The full-pattern comparison sees it, and says exactly where:
    expect(canonicalPatternState(a)).not.toBe(canonicalPatternState(b));
    expect(patternDiffFields(a, b)).toEqual(["gain"]);
  });
});
