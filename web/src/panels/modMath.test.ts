import { describe, expect, it } from "vitest";
import type { ShapeChannel } from "./modShape.ts";
import {
  depthForEdge,
  depthScale,
  envVolScale,
  modulatedValue,
  sweepRange,
  targetKind,
  volModMax,
  type Routing,
} from "./modMath.ts";

/**
 * MOD-4. These pin the DESTINATION math against the per-voice block
 * (NativeAudioEngineCore.cpp:5798-5831) and the facade's depth pre-scaling
 * (AudioEngineFacade.swift:2098-2121).
 *
 * The tests that matter most are the ones covering the engine's ASYMMETRIES — the ×2 follower
 * boost that only applies to M1/M2, and the global volModMax. Those are exactly the places a
 * plausible-looking reimplementation would quietly diverge and the sweep band would start lying.
 */

const ch = (over: Partial<ShapeChannel> = {}): ShapeChannel => ({
  type: "lfo",
  waveform: "sine",
  symmetry: 0.5,
  phaseOffset: 0,
  depth: 1,
  slant: 0,
  ease: 1, // MOD-10: the sine preset
  jitter: 0,
  cyclic: 1,
  envelopeNodes: [],
  sustainNodeIndex: 0,
  bipolar: false,
  ...over,
});

const FOUR_LFOS: ShapeChannel[] = [ch(), ch(), ch(), ch()];
const TYPES_ALL_LFO = FOUR_LFOS.map((c) => c.type);

describe("depth pre-scaling (mirror the ENGINE, not the model)", () => {
  it("scales pitch ×24 and filter ×25; everything else passes RAW", () => {
    expect(depthScale("pitch")).toBe(24);
    expect(depthScale("filter")).toBe(25);
    // The model's `hardcodedAmount` says 0.5 for these — the engine never consults it.
    expect(depthScale("volume")).toBe(1);
    expect(depthScale("pan")).toBe(1);
    expect(depthScale("gain")).toBe(1);
  });

  it("volume and gain are multiplicative; the rest are additive", () => {
    expect(targetKind("volume")).toBe("multiplicative");
    expect(targetKind("gain")).toBe("multiplicative");
    expect(targetKind("pan")).toBe("additive");
    expect(targetKind("pitch")).toBe("additive");
    expect(targetKind("filter")).toBe("additive");
  });
});

describe("the two engine asymmetries", () => {
  it("the env-follower ×2 volume boost applies ONLY to M1/M2", () => {
    // cpp:5804-5807 multiplies lfo1Val/lfo2Val by envVolScale but adds env3Val/env4Val RAW.
    // So the same follower is quietly half as strong on M3 as on M1.
    expect(envVolScale(0, "envFollower")).toBe(2);
    expect(envVolScale(1, "envFollower")).toBe(2);
    expect(envVolScale(2, "envFollower")).toBe(1);
    expect(envVolScale(3, "envFollower")).toBe(1);
    // and it is a FOLLOWER-only boost — an LFO never gets it
    expect(envVolScale(0, "lfo")).toBe(1);
    expect(envVolScale(0, "envelope")).toBe(1);
  });

  it("volModMax is GLOBAL: a follower on M1 widens headroom for every channel", () => {
    // cpp:3905-3907 — (lfo1IsEnv || lfo2IsEnv) ? 3 : 2
    expect(volModMax(["lfo", "lfo", "lfo", "lfo"])).toBe(2);
    expect(volModMax(["envFollower", "lfo", "lfo", "lfo"])).toBe(3);
    expect(volModMax(["lfo", "envFollower", "lfo", "lfo"])).toBe(3);
    // a follower on M3/M4 does NOT widen it
    expect(volModMax(["lfo", "lfo", "envFollower", "envFollower"])).toBe(2);
  });
});

describe("modulatedValue — the live dot", () => {
  it("returns the base untouched when nothing is routed to that target", () => {
    expect(modulatedValue(0.8, "volume", [], [1, 1, 1, 1], TYPES_ALL_LFO)).toBe(0.8);
    const other: Routing[] = [{ channelIndex: 0, target: "pan", depth: 1 }];
    expect(modulatedValue(0.8, "volume", other, [1, 1, 1, 1], TYPES_ALL_LFO)).toBe(0.8);
  });

  it("volume is base × (1 + Σ), floored at 0 — a big negative depth MUTES, it does not invert", () => {
    const r: Routing[] = [{ channelIndex: 0, target: "volume", depth: -1 }];
    // channel at +1, depth −1 → 1 + (−1) = 0 → silence
    expect(modulatedValue(0.8, "volume", r, [1, 0, 0, 0], TYPES_ALL_LFO)).toBeCloseTo(0, 6);
    // channel at −1, depth −1 → 1 + 1 = 2 → doubled
    expect(modulatedValue(0.8, "volume", r, [-1, 0, 0, 0], TYPES_ALL_LFO)).toBeCloseTo(1.6, 6);
    // clamped at volModMax=2, never negative
    const deep: Routing[] = [{ channelIndex: 0, target: "volume", depth: -1 }];
    expect(modulatedValue(1, "volume", deep, [-5, 0, 0, 0], TYPES_ALL_LFO)).toBeCloseTo(2, 6);
  });

  it("pan is additive and clamps to ±1", () => {
    const r: Routing[] = [{ channelIndex: 0, target: "pan", depth: 0.5 }];
    expect(modulatedValue(0, "pan", r, [1, 0, 0, 0], TYPES_ALL_LFO)).toBeCloseTo(0.5, 6);
    expect(modulatedValue(0, "pan", r, [-1, 0, 0, 0], TYPES_ALL_LFO)).toBeCloseTo(-0.5, 6);
    expect(modulatedValue(0.9, "pan", r, [1, 0, 0, 0], TYPES_ALL_LFO)).toBeCloseTo(1, 6); // clamped
  });

  it("pitch is additive in SEMITONES after the ×24 scale", () => {
    const r: Routing[] = [{ channelIndex: 0, target: "pitch", depth: 0.5 }];
    // 0.5 depth × 24 = ±12 semitones at full LFO swing
    expect(modulatedValue(0, "pitch", r, [1, 0, 0, 0], TYPES_ALL_LFO)).toBeCloseTo(12, 6);
    expect(modulatedValue(0, "pitch", r, [-1, 0, 0, 0], TYPES_ALL_LFO)).toBeCloseTo(-12, 6);
  });

  it("filter is additive after ×25 and clamps to ±100", () => {
    const r: Routing[] = [{ channelIndex: 0, target: "filter", depth: 1 }];
    expect(modulatedValue(0, "filter", r, [1, 0, 0, 0], TYPES_ALL_LFO)).toBeCloseTo(25, 6);
    expect(modulatedValue(90, "filter", r, [1, 0, 0, 0], TYPES_ALL_LFO)).toBeCloseTo(100, 6);
  });

  it("sums MULTIPLE channels onto one target", () => {
    const r: Routing[] = [
      { channelIndex: 0, target: "pan", depth: 0.5 },
      { channelIndex: 1, target: "pan", depth: 0.25 },
    ];
    expect(modulatedValue(0, "pan", r, [1, 1, 0, 0], TYPES_ALL_LFO)).toBeCloseTo(0.75, 6);
    // opposing channels cancel
    expect(modulatedValue(0, "pan", r, [1, -1, 0, 0], TYPES_ALL_LFO)).toBeCloseTo(0.25, 6);
  });

  it("a follower on M1 hits volume TWICE as hard as the same follower on M3", () => {
    const onM1: Routing[] = [{ channelIndex: 0, target: "volume", depth: 0.5 }];
    const onM3: Routing[] = [{ channelIndex: 2, target: "volume", depth: 0.5 }];
    const types = ["envFollower", "lfo", "envFollower", "lfo"] as const;
    const vals = [1, 0, 1, 0];
    // M1: 1 + 1*0.5*2 = 2.0   |   M3: 1 + 1*0.5*1 = 1.5
    expect(modulatedValue(0.5, "volume", onM1, vals, [...types])).toBeCloseTo(1.0, 6);
    expect(modulatedValue(0.5, "volume", onM3, vals, [...types])).toBeCloseTo(0.75, 6);
  });
});

describe("sweepRange — the band", () => {
  it("is symmetric about the base for an LFO", () => {
    const r: Routing[] = [{ channelIndex: 0, target: "pan", depth: 0.5 }];
    expect(sweepRange(0, "pan", r, FOUR_LFOS)).toEqual({ min: -0.5, max: 0.5 });
  });

  it("is ASYMMETRIC for an envelope or follower — they only push ONE way", () => {
    const chans = [ch({ type: "envelope" }), ch(), ch(), ch()];
    const r: Routing[] = [{ channelIndex: 0, target: "pan", depth: 0.5 }];
    // range 0…1 (not −1…1) → the band sits entirely ABOVE the base
    expect(sweepRange(0, "pan", r, chans)).toEqual({ min: 0, max: 0.5 });
    // a NEGATIVE depth flips which side it sweeps
    const neg: Routing[] = [{ channelIndex: 0, target: "pan", depth: -0.5 }];
    expect(sweepRange(0, "pan", neg, chans)).toEqual({ min: -0.5, max: 0 });
  });

  it("a bipolar envelope sweeps both ways again", () => {
    const chans = [ch({ type: "envelope", bipolar: true }), ch(), ch(), ch()];
    const r: Routing[] = [{ channelIndex: 0, target: "pan", depth: 0.5 }];
    expect(sweepRange(0, "pan", r, chans)).toEqual({ min: -0.5, max: 0.5 });
  });

  it("collapses to a point when the channel's depth is 0 (no modulation drawn)", () => {
    const chans = [ch({ depth: 0 }), ch(), ch(), ch()];
    const r: Routing[] = [{ channelIndex: 0, target: "pan", depth: 1 }];
    expect(sweepRange(0.3, "pan", r, chans)).toEqual({ min: 0.3, max: 0.3 });
  });

  it("respects the target clamp — the band never extends past the control's own range", () => {
    const r: Routing[] = [{ channelIndex: 0, target: "pan", depth: 1 }];
    const band = sweepRange(0.8, "pan", r, FOUR_LFOS);
    expect(band.min).toBeCloseTo(-0.2, 6); // 0.8 − 1, with the usual float dust
    expect(band.max).toBe(1); // top clipped by the pan clamp
  });

  it("volume band is multiplicative around the base", () => {
    const r: Routing[] = [{ channelIndex: 0, target: "volume", depth: 0.5 }];
    // base 0.6 × (1 ± 0.5) → 0.3 … 0.9
    const band = sweepRange(0.6, "volume", r, FOUR_LFOS);
    expect(band.min).toBeCloseTo(0.3, 6);
    expect(band.max).toBeCloseTo(0.9, 6);
  });

  it("stacks multiple routings on one target into ONE band", () => {
    const r: Routing[] = [
      { channelIndex: 0, target: "pan", depth: 0.3 },
      { channelIndex: 1, target: "pan", depth: 0.2 },
    ];
    expect(sweepRange(0, "pan", r, FOUR_LFOS)).toEqual({ min: -0.5, max: 0.5 });
  });
});

describe("depthForEdge — dragging the band edge writes a depth", () => {
  it("round-trips against sweepRange for an additive target", () => {
    const r: Routing = { channelIndex: 0, target: "pan", depth: 0.5 };
    // Drag the top edge to 0.8 → solve the depth, then confirm the band lands there.
    const d = depthForEdge(0, "pan", r, FOUR_LFOS[0]!, 0.8)!;
    expect(d).toBeCloseTo(0.8, 6);
    const band = sweepRange(0, "pan", [{ ...r, depth: d }], FOUR_LFOS);
    expect(band.max).toBeCloseTo(0.8, 6);
  });

  it("round-trips for a multiplicative target", () => {
    const r: Routing = { channelIndex: 0, target: "volume", depth: 0.5 };
    const d = depthForEdge(0.6, "volume", r, FOUR_LFOS[0]!, 0.9)!;
    const band = sweepRange(0.6, "volume", [{ ...r, depth: d }], FOUR_LFOS);
    expect(band.max).toBeCloseTo(0.9, 6);
  });

  it("clamps the solved depth to ±1", () => {
    const r: Routing = { channelIndex: 0, target: "pan", depth: 0 };
    expect(depthForEdge(0, "pan", r, FOUR_LFOS[0]!, 99)).toBe(1);
    expect(depthForEdge(0, "pan", r, FOUR_LFOS[0]!, -99)).toBe(-1);
  });

  it("returns null where it cannot be solved", () => {
    const r: Routing = { channelIndex: 0, target: "pan", depth: 0.5 };
    // channel depth 0 → the channel emits nothing; no depth can move the edge
    expect(depthForEdge(0, "pan", r, ch({ depth: 0 }), 0.5)).toBeNull();
    // multiplicative target with a base of 0 → base × anything is still 0
    const v: Routing = { channelIndex: 0, target: "volume", depth: 0.5 };
    expect(depthForEdge(0, "volume", v, FOUR_LFOS[0]!, 0.5)).toBeNull();
  });
});
