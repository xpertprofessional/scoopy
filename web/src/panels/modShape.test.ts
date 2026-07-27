import { describe, expect, it } from "vitest";
import {
  channelRange,
  applyEase,
  agitationValue,
  agitationLoopSteps,
  cyclicWaveShape,
  randomPathValue,
  easeShape,
  slantWarp,
  envelopeSustainMs,
  envelopeTotalMs,
  evalEnvelopePreSustain,
  evalEnvelopeRelease,
  lfoWaveValue,
  sampleShape,
  unipolarToBipolar,
  type EnvNode,
  type ShapeChannel,
} from "./modShape.ts";

/**
 * GOLDEN TEST (MOD-4). Every expected number below was produced by compiling the engine's own
 * math — `lfoWaveValue`, `evalBreakpointPreSustain`, `evalBreakpointRelease` copied VERBATIM out
 * of NativeAudioEngineCore.cpp (:76-95, :101-116, :121-139) — and printing a table. If a value
 * here disagrees with the C++, the WEB is wrong: a sweep band that lies is worse than no band.
 *
 * Tolerance is 1e-6, not exact: the C++ returns `float` (the envelope evaluators end in
 * `static_cast<float>`), so its 0.2 is really 0.2000000030 while our double is 0.2. Same class
 * of Float-vs-Double trap as the PatternFile byte-identity work.
 */

const P = 6; // ≈1e-6

describe("lfoWaveValue — ported from NativeAudioEngineCore.cpp:76-95", () => {
  it("sine ignores symmetry", () => {
    expect(lfoWaveValue(0, "sine", 0.5)).toBeCloseTo(0, P);
    expect(lfoWaveValue(0.125, "sine", 0.5)).toBeCloseTo(0.7071067812, P);
    expect(lfoWaveValue(0.25, "sine", 0.5)).toBeCloseTo(1, P);
    expect(lfoWaveValue(0.7, "sine", 0.5)).toBeCloseTo(-0.9510565163, P);
    // symmetry is not a term in the sine branch — same values at a different symmetry
    expect(lfoWaveValue(0.7, "sine", 0.2)).toBeCloseTo(-0.9510565163, P);
  });

  it("wraps phase like native (phase - floor(phase))", () => {
    // 2.25 must behave exactly as 0.25 — callers pass rawPhase + phaseOffset unwrapped.
    expect(lfoWaveValue(2.25, "sine", 0.5)).toBeCloseTo(1, P);
    expect(lfoWaveValue(-0.75, "sine", 0.5)).toBeCloseTo(1, P);
  });

  it("triangle starts at the trough and skews with symmetry", () => {
    expect(lfoWaveValue(0, "triangle", 0.5)).toBeCloseTo(-1, P);
    expect(lfoWaveValue(0.25, "triangle", 0.5)).toBeCloseTo(0, P);
    expect(lfoWaveValue(0.5, "triangle", 0.5)).toBeCloseTo(1, P);
    expect(lfoWaveValue(0.99, "triangle", 0.5)).toBeCloseTo(-0.96, P);
    // symmetry 0.2 moves the peak left — this is the gesture the Lab's peak-drag edits
    expect(lfoWaveValue(0.125, "triangle", 0.2)).toBeCloseTo(0.25, P);
    expect(lfoWaveValue(0.25, "triangle", 0.2)).toBeCloseTo(0.875, P);
    expect(lfoWaveValue(0.5, "triangle", 0.85)).toBeCloseTo(0.1764705882, P);
  });

  it("square: symmetry is pulse width and is NOT clamped (unlike triangle)", () => {
    expect(lfoWaveValue(0.25, "square", 0.5)).toBeCloseTo(1, P);
    expect(lfoWaveValue(0.5, "square", 0.5)).toBeCloseTo(-1, P);
    expect(lfoWaveValue(0.25, "square", 0.2)).toBeCloseTo(-1, P);
    expect(lfoWaveValue(0.7, "square", 0.85)).toBeCloseTo(1, P);
    // The quirk: triangle clamps symmetry to [0.001, 0.999]; square does not. At symmetry 0 the
    // square is permanently −1 (p < 0 is never true). Mirrored deliberately — do not "fix" it here.
    expect(lfoWaveValue(0, "square", 0)).toBeCloseTo(-1, P);
  });

  it("saw is a plain ramp, symmetry-independent", () => {
    expect(lfoWaveValue(0, "saw", 0.5)).toBeCloseTo(-1, P);
    expect(lfoWaveValue(0.5, "saw", 0.5)).toBeCloseTo(0, P);
    expect(lfoWaveValue(0.99, "saw", 0.85)).toBeCloseTo(0.98, P);
  });

  it("random returns the sample-and-hold value; envelopeFollower returns 0", () => {
    expect(lfoWaveValue(0.42, "random", 0.5, 0.31)).toBeCloseTo(0.31, P);
    expect(lfoWaveValue(0.42, "envelopeFollower", 0.5, 0.9)).toBe(0);
  });
});

/** The default ADSR: (0,0) → (5ms,1) → sustain(0ms,1) → (200ms,0). ModulationModel.defaultShape. */
const ADSR: EnvNode[] = [
  { timeMs: 0, value: 0, curve: 1 },
  { timeMs: 5, value: 1, curve: 1 },
  { timeMs: 0, value: 1, curve: 1 },
  { timeMs: 200, value: 0, curve: 1 },
];
const ADSR_SUSTAIN = 2;

describe("envelope evaluation — ported from NativeAudioEngineCore.cpp:101-139", () => {
  it("pre-sustain walks the attack then HOLDS at the sustain node", () => {
    expect(evalEnvelopePreSustain(ADSR, ADSR_SUSTAIN, 0)).toBeCloseTo(0, P);
    expect(evalEnvelopePreSustain(ADSR, ADSR_SUSTAIN, 1)).toBeCloseTo(0.2, P);
    expect(evalEnvelopePreSustain(ADSR, ADSR_SUSTAIN, 2.5)).toBeCloseTo(0.5, P);
    expect(evalEnvelopePreSustain(ADSR, ADSR_SUSTAIN, 5)).toBeCloseTo(1, P);
    // held open past the attack — this is the gate-still-open case (a multi-step source cell)
    expect(evalEnvelopePreSustain(ADSR, ADSR_SUSTAIN, 10)).toBeCloseTo(1, P);
    expect(evalEnvelopePreSustain(ADSR, ADSR_SUSTAIN, 10_000)).toBeCloseTo(1, P);
  });

  it("release walks from the captured start value and reports `finished`", () => {
    const at = (ms: number, start = 1) => evalEnvelopeRelease(ADSR, ADSR_SUSTAIN, ms, start);
    expect(at(0).value).toBeCloseTo(1, P);
    expect(at(0).finished).toBe(false);
    expect(at(50).value).toBeCloseTo(0.75, P);
    expect(at(100).value).toBeCloseTo(0.5, P);
    expect(at(199).value).toBeCloseTo(0.005, P);
    // past the end: pinned to the last node, and finished
    expect(at(250).value).toBeCloseTo(0, P);
    expect(at(250).finished).toBe(true);
  });

  it("an EARLY gate-close releases from wherever the envelope actually was", () => {
    // Not from 1.0 — from 0.25. This is why `modEnvReleaseStartValue` exists in the engine.
    const curved: EnvNode[] = [
      { timeMs: 0, value: 0, curve: 1 },
      { timeMs: 100, value: 1, curve: 2 },
      { timeMs: 100, value: 0, curve: 0.5 },
    ];
    expect(evalEnvelopeRelease(curved, 1, 50, 0.25).value).toBeCloseTo(0.0732233077, P);
    expect(evalEnvelopeRelease(curved, 1, 50, 1).value).toBeCloseTo(0.2928932309, P);
  });

  it("honours per-node CURVE (the segment-bend gesture the engine already supports)", () => {
    const curved: EnvNode[] = [
      { timeMs: 0, value: 0, curve: 1 },
      { timeMs: 100, value: 1, curve: 2 }, // ease-in: pow(frac, 2)
      { timeMs: 100, value: 0, curve: 0.5 }, // ease-out: pow(frac, 0.5)
    ];
    // curve 2 → quarter-way in time is only 1/16th of the way in value
    expect(evalEnvelopePreSustain(curved, 1, 25)).toBeCloseTo(0.0625, P);
    expect(evalEnvelopePreSustain(curved, 1, 50)).toBeCloseTo(0.25, P);
    expect(evalEnvelopePreSustain(curved, 1, 75)).toBeCloseTo(0.5625, P);
    // curve 0.5 on release → falls fast then flattens
    expect(evalEnvelopeRelease(curved, 1, 25, 1).value).toBeCloseTo(0.5, P);
    expect(evalEnvelopeRelease(curved, 1, 75, 1).value).toBeCloseTo(0.1339745969, P);
  });

  it("degenerate envelopes do not throw", () => {
    expect(evalEnvelopePreSustain([], 0, 10)).toBe(0);
    expect(evalEnvelopeRelease([], 0, 10, 1)).toEqual({ value: 0, finished: true });
    // sustain on the LAST node → there are no release segments at all
    const noRelease: EnvNode[] = [
      { timeMs: 0, value: 0, curve: 1 },
      { timeMs: 10, value: 1, curve: 1 },
    ];
    expect(evalEnvelopeRelease(noRelease, 1, 5, 1)).toEqual({ value: 1, finished: true });
  });
});

describe("envelope timeline", () => {
  it("totals every segment; node 0 contributes nothing", () => {
    expect(envelopeTotalMs(ADSR)).toBe(205);
    expect(envelopeSustainMs(ADSR, ADSR_SUSTAIN)).toBe(5);
    expect(envelopeTotalMs([])).toBe(0);
  });
});

const lfoCh = (over: Partial<ShapeChannel> = {}): ShapeChannel => ({
  type: "lfo",
  waveform: "sine",
  symmetry: 0.5,
  phaseOffset: 0,
  depth: 1,
  slant: 0,
  ease: 0, // MOD-12: 0 = smooth ramp (the sine-ish default); +1 = S&H
  jitter: 0,
  cyclic: 1, // fully cyclic (alternating ±) = a clean periodic LFO
  stepsPerCycle: 16, // wavelength = the whole 16-step loop → one clean wave across it
  lcmSteps: 16,
  envelopeNodes: ADSR,
  sustainNodeIndex: ADSR_SUSTAIN,
  bipolar: false,
  ...over,
});

describe("channelRange — the asymmetry the sweep band is built on", () => {
  it("an LFO is bipolar; an envelope and a follower are not", () => {
    expect(channelRange(lfoCh())).toEqual({ lo: -1, hi: 1 });
    expect(channelRange(lfoCh({ type: "envelope" }))).toEqual({ lo: 0, hi: 1 });
    expect(channelRange(lfoCh({ type: "envFollower" }))).toEqual({ lo: 0, hi: 1 });
  });

  it("a bipolar envelope regains the negative half", () => {
    expect(channelRange(lfoCh({ type: "envelope", bipolar: true }))).toEqual({ lo: -1, hi: 1 });
  });

  it("channel depth scales the range — depth 0 means the channel emits NOTHING", () => {
    expect(channelRange(lfoCh({ depth: 0.5 }))).toEqual({ lo: -0.5, hi: 0.5 });
    expect(channelRange(lfoCh({ depth: 0 }))).toEqual({ lo: 0, hi: 0 });
  });
});

describe("bipolar mapping (MOD-2 decision: 0.5 is centre)", () => {
  it("maps 0 → −1, 0.5 → 0, 1 → +1", () => {
    expect(unipolarToBipolar(0)).toBe(-1);
    expect(unipolarToBipolar(0.5)).toBe(0);
    expect(unipolarToBipolar(1)).toBe(1);
  });
});

describe("sampleShape — what the Lab draws", () => {
  it("returns null for an env-follower (it has no static shape; the Lab scrolls it)", () => {
    expect(sampleShape(lfoCh({ type: "envFollower" }), 32)).toBeNull();
  });

  it("draws one LCM loop; wavelength = loop, cyclic 1 + ease 0 = one raised cosine; depth 0 → FLAT", () => {
    // lfoCh: wavelength 16, lcm 16 → one clean wave across [0,16]: trough, mid, peak, mid, trough.
    const full = sampleShape(lfoCh(), 5)!; // g = 0, 4, 8, 12, 16
    expect(full[0]).toBeCloseTo(-1, P); // trough at the start
    expect(full[2]).toBeCloseTo(1, P); // peak at half a wavelength
    expect(full[4]).toBeCloseTo(-1, P); // trough again (loop repeats)

    const silent = sampleShape(lfoCh({ depth: 0 }), 16)!;
    expect([...silent].every((v) => v === 0)).toBe(true);
  });

  it("bakes phaseOffset (a fraction of a WAVELENGTH) into the curve", () => {
    // offset 0.5 shifts by half a wavelength (8 steps) → x=0 now lands on the peak.
    const shifted = sampleShape(lfoCh({ phaseOffset: 0.5 }), 5)!;
    expect(shifted[0]).toBeCloseTo(1, P);
  });

  it("draws the envelope across its whole timeline, sustain included", () => {
    const env = sampleShape(lfoCh({ type: "envelope" }), 42)!;
    expect(env[0]).toBeCloseTo(0, P); // starts at 0
    expect(env[env.length - 1]).toBeCloseTo(0, P); // ends at 0 (release floor)
    expect(Math.max(...env)).toBeCloseTo(1, P); // reaches the sustain peak
  });
});

/**
 * MOD-12 AGITATION — the LFO is a per-step value sequence of period `n`. `cyclic 1` is one smooth
 * wave over the n cells (deterministic, pinnable); `cyclic 0` is n random per-step values (structural
 * bounds + repeat/determinism). If these drift from the C++, the LFO you SEE ≠ the LFO you HEAR.
 */
describe("agitationValue — per-step value sequence (ported from NativeAudioEngineCore.cpp)", () => {
  // period 4, cyclic 1, jitter 0, channel 0 → one clean raised-cosine wave over 4 cells.
  const cyc = (g: number, ease = 0, slant = 0) => agitationValue(g, 4, ease, slant, 1, 0, 0);

  it("cyclic 1 + ease 0 is one raised-cosine wave over the period", () => {
    expect(cyc(0)).toBeCloseTo(-1, P); // trough
    expect(cyc(1)).toBeCloseTo(0, P); // rising mid
    expect(cyc(2)).toBeCloseTo(1, P); // peak at half the period
    expect(cyc(3)).toBeCloseTo(0, P); // falling mid
    expect(cyc(4)).toBeCloseTo(-1, P); // repeats every period
  });

  it("ease +1 turns the wave into a square (instant steps)", () => {
    expect(cyc(1, 1)).toBeCloseTo(1, P); // risen
    expect(cyc(3, 1)).toBeCloseTo(-1, P); // fallen
  });

  it("stays inside ±1 for any params (random values included)", () => {
    for (let g = 0; g < 40; g += 0.37) {
      for (const [e, s, cy, j] of [
        [0, 0, 1, 0],
        [1, 0, 0, 0.5],
        [-0.6, 0.8, 0.4, 1],
        [0.3, -0.5, 0, 0],
      ] as const) {
        const v = agitationValue(g, 8, e, s, cy, j, 1);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it("repeats EXACTLY every period (its own loop)", () => {
    const n = 6;
    expect(agitationLoopSteps(n)).toBe(6);
    for (const g of [0.4, 2.1, 3.9, 5.3]) {
      const a = agitationValue(g, n, 0.2, 0.3, 0.4, 0.6, 2); // wave+random blend
      const b = agitationValue(g + n, n, 0.2, 0.3, 0.4, 0.6, 2);
      expect(b).toBeCloseTo(a, 9);
    }
  });

  it("is deterministic — same inputs, same output (stateless hash, not a live RNG)", () => {
    expect(agitationValue(7.3, 8, 0.1, 0.2, 0.0, 0.5, 3)).toBe(
      agitationValue(7.3, 8, 0.1, 0.2, 0.0, 0.5, 3),
    );
  });

  it("cyclic 0 = per-step random values; different channels differ", () => {
    // ease +1 (S&H) at a step centre reads that step's random target — channel-dependent.
    const a = agitationValue(0.5, 8, 1, 0, 0, 0, 0);
    const b = agitationValue(0.5, 8, 1, 0, 0, 0, 1);
    expect(a).not.toBeCloseTo(b, 6);
    expect(a).toBeGreaterThanOrEqual(-1);
    expect(a).toBeLessThanOrEqual(1);
  });

  it("cyclicWaveShape is a bipolar wave: trough at 0, peak at 0.5", () => {
    expect(cyclicWaveShape(0, 0, 0)).toBeCloseTo(-1, P);
    expect(cyclicWaveShape(0.5, 0, 0)).toBeCloseTo(1, P);
    expect(randomPathValue(2.5, 8, 1, 0, 0, 0)).toBeGreaterThanOrEqual(-1);
  });
});

describe("easeShape — the ramp curve between targets", () => {
  it("ease 0 is the raised cosine across the whole segment", () => {
    for (const u of [0.25, 0.5, 0.75])
      expect(easeShape(u, 0)).toBeCloseTo((1 - Math.cos(Math.PI * u)) / 2, 12);
  });
  it("ease +1 jumps at the start; ease −1 holds until the end", () => {
    expect(easeShape(0.001, 1)).toBeCloseTo(1, P); // +1: at target immediately
    expect(easeShape(0.5, 1)).toBeCloseTo(1, P);
    expect(easeShape(0.5, -1)).toBeCloseTo(0, P); // −1: still holding at mid-segment
    expect(easeShape(0.99995, -1)).toBeGreaterThan(0.4); // jumps right at the very end
  });
});

describe("slantWarp — up/down asymmetry", () => {
  it("is identity at slant 0", () => {
    for (const u of [0, 0.3, 0.7, 1]) {
      expect(slantWarp(u, 0, 1)).toBe(u);
      expect(slantWarp(u, 0, -1)).toBe(u);
    }
  });
  it("warps rising and falling ramps in opposite directions", () => {
    expect(slantWarp(0.5, 1, 1)).toBeLessThan(0.5); // rising (dir +1) → exponent 2
    expect(slantWarp(0.5, 1, -1)).toBeGreaterThan(0.5); // falling (dir −1) → exponent 0.5
  });
});

describe("applyEase", () => {
  it("is exactly linear at ease 0, so `triangle` stays a true triangle", () => {
    for (const u of [0, 0.13, 0.5, 0.87, 1]) {
      expect(applyEase(u, 0, 0)).toBeCloseTo(u, 12);
      expect(applyEase(u, 0, 0.9)).toBeCloseTo(u, 12); // slant must not leak in at ease 0
    }
  });

  it("rounds toward a cosine as ease rises", () => {
    expect(applyEase(0.5, 1, 0)).toBeCloseTo(0.5, P);
    expect(applyEase(0.25, 1, 0)).toBeCloseTo((1 - Math.cos(Math.PI * 0.25)) / 2, P);
  });

  it("hardens toward a step as ease falls", () => {
    expect(applyEase(0.45, -1, 0)).toBeCloseTo(0, P);
    expect(applyEase(0.55, -1, 0)).toBeCloseTo(1, P);
  });
});
