/**
 * MB-1b — patternOps unit tests.
 *
 * The golden fixtures (grid-ops.json) are the REAL proof: they drive the same ops through the Swift
 * mutators and byte-compare. But `canonicalGridSubset` does not span every field these reducers
 * write — notably the five offset lanes `clearGrid` zeroes. Those are covered here, so the
 * un-spanned part of the contract is not simply unverified.
 *
 * The rule this file exists to enforce: a field a reducer writes is either in the canonical subset
 * or in a test here. Never neither.
 */
import { describe, expect, it } from "vitest";
import type { GridTrackState } from "../../protocol/schema";
import {
  applyClearGrid,
  applyClearPattern,
  applyGenerateEuclidean,
  applyGenerateInterval,
  applyRandomizePattern,
} from "./patternOps";
import { mulberry32 } from "./rng";

const N = 8;
const track = (over: Partial<GridTrackState> = {}): GridTrackState =>
  ({
    stepCount: N,
    steps: [true, false, true, false, true, false, true, false],
    pitchOffsets: [6, 0, -2, 0, 4, 0, 0, 0],
    accentLevels: [2, 0, 1, 0, 0, 0, 0, 0],
    cellLengths: [4, 1, 1, 1, 1, 1, 1, 1],
    wrapSourceStep: 6,
    flamCounts: [1, 1, 3, 1, 1, 1, 1, 1],
    glideSteps: [true, false, false, false, false, false, false, false],
    reverseSteps: [false, false, true, false, false, false, false, false],
    preSilenceMsOffsets: [10, 0, 0, 0, 0, 0, 0, 0],
    toneOffsets: [50, 0, 0, 0, 0, 0, 0, 0],
    chordIndices: [3, 0, 0, 0, 0, 0, 0, 0],
    cellChopIndices: [2, -1, -1, -1, -1, -1, -1, -1],
    // the five lanes clearGrid DOES zero, and which the canonical subset does not span:
    volumeOffsets: [0.5, 0, 0, 0, 0, 0, 0, 0],
    mixVolumeOffsets: [0.25, 0, 0, 0, 0, 0, 0, 0],
    panOffsets: [-0.75, 0, 0, 0, 0, 0, 0, 0],
    sampleStartMsOffsets: [120, 0, 0, 0, 0, 0, 0, 0],
    sampleEndMsOffsets: [-30, 0, 0, 0, 0, 0, 0, 0],
    ...over,
  }) as unknown as GridTrackState;

describe("clearGrid — what it clears, and what it deliberately does NOT", () => {
  it("zeroes the five offset lanes the golden canonical cannot see", () => {
    const t = applyClearGrid(track());
    expect(t.volumeOffsets).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(t.mixVolumeOffsets).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(t.panOffsets).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(t.sampleStartMsOffsets).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(t.sampleEndMsOffsets).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("clears steps, pitch and accents", () => {
    const t = applyClearGrid(track());
    expect(t.steps.every((s) => !s)).toBe(true);
    expect(t.pitchOffsets.every((p) => p === 0)).toBe(true);
    expect(t.accentLevels.every((a) => a === 0)).toBe(true);
  });

  it("LEAVES cellLengths and wrapSourceStep — so a re-lit step resurrects its old long cell", () => {
    // Native behaviour (clearPattern :17792), pinned rather than corrected. It is the single most
    // surprising thing about Clear, and the reason a "clean" pattern can start playing 4-step cells.
    const t = applyClearGrid(track());
    expect(t.cellLengths).toEqual([4, 1, 1, 1, 1, 1, 1, 1]);
    expect(t.wrapSourceStep).toBe(6);
  });

  it("LEAVES tone / flam / chord / glide / reverse / pre-silence / chop lanes", () => {
    const t = applyClearGrid(track());
    expect(t.toneOffsets[0]).toBe(50);
    expect(t.flamCounts[2]).toBe(3);
    expect(t.chordIndices[0]).toBe(3);
    expect(t.glideSteps[0]).toBe(true);
    expect(t.reverseSteps[2]).toBe(true);
    expect(t.preSilenceMsOffsets[0]).toBe(10);
    expect(t.cellChopIndices[0]).toBe(2);
  });

  it("does not mutate its input", () => {
    const before = track();
    const snapshot = JSON.stringify(before);
    applyClearGrid(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("generateInterval", () => {
  it("lights every Nth step from startStep", () => {
    const t = applyGenerateInterval(track(), 3, 1);
    expect(t.steps).toEqual([false, true, false, false, true, false, false, true]);
  });

  it("clears pitch and accents but keeps cellLengths (a lit step inherits its old cell)", () => {
    const t = applyGenerateInterval(track(), 4, 0);
    expect(t.pitchOffsets.every((p) => p === 0)).toBe(true);
    expect(t.accentLevels.every((a) => a === 0)).toBe(true);
    expect(t.cellLengths[0]).toBe(4);
  });

  it("clamps interval 0 rather than hanging (Swift traps on stride(by: 0))", () => {
    const t = applyGenerateInterval(track(), 0, 0);
    expect(t.steps.every((s) => s)).toBe(true); // clamped to 1 → every step
  });
});

describe("generateEuclidean — the designed one", () => {
  const show = (t: { steps: boolean[] }) => t.steps.map((s) => (s ? "x" : ".")).join("");

  it("E(3,8) is the tresillo", () => {
    const t = applyGenerateEuclidean(track(), 3, 0);
    expect(show(t)).toBe("x..x..x.");
  });

  it("SUBSUMES 'every Nth': E(n/N, n) reproduces it exactly", () => {
    // This is the claim that justifies deleting seven menu items. It has to be true, not plausible.
    expect(show(applyGenerateEuclidean(track(), 4, 0))).toBe(show(applyGenerateInterval(track(), 2)));
    expect(show(applyGenerateEuclidean(track(), 2, 0))).toBe(show(applyGenerateInterval(track(), 4)));
    expect(show(applyGenerateEuclidean(track(), 8, 0))).toBe(show(applyGenerateInterval(track(), 1)));
  });

  it("rotation reproduces the old off-beat items (it shifts the pattern LATER)", () => {
    expect(show(applyGenerateEuclidean(track(), 4, 1))).toBe(show(applyGenerateInterval(track(), 2, 1)));
  });

  it("expresses what 'every Nth' structurally cannot: 5-in-8", () => {
    // Five onsets across eight steps — no interval setting can produce this, because 5 does not
    // divide 8. Note the PHASE: the textbook writes E(5,8) as `x.xx.xx.`; this is the same rhythm
    // rotated (identical interval multiset), because our form always lands an onset on step 0 —
    // a generated pattern that misses the downbeat is almost never what you wanted.
    expect(show(applyGenerateEuclidean(track(), 5, 0))).toBe("x.x.xx.x");
  });

  it("always lands an onset on the downbeat at rotation 0", () => {
    for (const k of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(applyGenerateEuclidean(track(), k, 0).steps[0]).toBe(true);
    }
  });

  it("clamps: 0 pulses empties, pulses > stepCount saturates", () => {
    expect(show(applyGenerateEuclidean(track(), 0, 0))).toBe("........");
    expect(show(applyGenerateEuclidean(track(), 99, 0))).toBe("xxxxxxxx");
  });

  it("clears pitch and accents, keeps cellLengths — same contract as every other generator", () => {
    const t = applyGenerateEuclidean(track(), 3, 0);
    expect(t.pitchOffsets.every((p) => p === 0)).toBe(true);
    expect(t.accentLevels.every((a) => a === 0)).toBe(true);
    expect(t.cellLengths[0]).toBe(4);
  });
});

// ── TR-RND — the per-track TOOL reducers ──────────────────────────────────

describe("clearPattern — a genuinely clean slate (unlike clearGrid)", () => {
  const dirty = () =>
    track({
      // settings that MUST survive a pattern clear
      sampleKey: "kit/kick.wav",
      gain: 1.4,
      volume: 0.9,
      send1Level: 0.3,
    } as Partial<GridTrackState>);

  it("wipes cell geometry — cellLengths → 1 and wrapSourceStep → null", () => {
    const t = applyClearPattern(dirty());
    expect(t.cellLengths).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(t.wrapSourceStep).toBeNull();
  });

  it("wipes every per-cell lane clearGrid deliberately leaves behind", () => {
    const t = applyClearPattern(dirty());
    expect(t.flamCounts).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(t.glideSteps.every((g) => !g)).toBe(true);
    expect(t.reverseSteps.every((r) => !r)).toBe(true);
    expect(t.preSilenceMsOffsets.every((p) => p === 0)).toBe(true);
    expect(t.cellChopIndices).toEqual([-1, -1, -1, -1, -1, -1, -1, -1]);
    expect(t.chordIndices.every((c) => c === 0)).toBe(true);
    expect(t.toneOffsets.every((v) => v === 0)).toBe(true);
  });

  it("wipes steps, pitch, accents and all offset lanes", () => {
    const t = applyClearPattern(dirty());
    expect(t.steps.every((s) => !s)).toBe(true);
    expect(t.pitchOffsets.every((p) => p === 0)).toBe(true);
    expect(t.accentLevels.every((a) => a === 0)).toBe(true);
    for (const lane of [
      t.volumeOffsets,
      t.mixVolumeOffsets,
      t.panOffsets,
      t.sampleStartMsOffsets,
      t.sampleEndMsOffsets,
    ]) {
      expect(lane.every((v) => v === 0)).toBe(true);
    }
  });

  it("PRESERVES track settings — it clears the pattern, not the sound", () => {
    const t = applyClearPattern(dirty());
    expect(t.sampleKey).toBe("kit/kick.wav");
    expect(t.gain).toBe(1.4);
    expect(t.volume).toBe(0.9);
    expect(t.send1Level).toBe(0.3);
    expect(t.stepCount).toBe(N);
  });

  it("does not mutate its input", () => {
    const before = dirty();
    const snapshot = JSON.stringify(before);
    applyClearPattern(before);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe("randomizePattern — a fresh, musical pattern", () => {
  const M = 32;
  const dense = new Array(M).fill(0);
  const bigTrack = (over: Partial<GridTrackState> = {}) =>
    track({
      stepCount: M,
      steps: new Array(M).fill(false),
      pitchOffsets: [...dense],
      accentLevels: [...dense],
      cellLengths: new Array(M).fill(1),
      flamCounts: new Array(M).fill(1),
      glideSteps: new Array(M).fill(false),
      reverseSteps: new Array(M).fill(false),
      preSilenceMsOffsets: [...dense],
      toneOffsets: [...dense],
      chordIndices: [...dense],
      cellChopIndices: new Array(M).fill(-1),
      volumeOffsets: [...dense],
      mixVolumeOffsets: [...dense],
      panOffsets: [...dense],
      sampleStartMsOffsets: [...dense],
      sampleEndMsOffsets: [...dense],
      wrapSourceStep: null,
      ...over,
    } as Partial<GridTrackState>);

  it("is deterministic for a fixed injected RNG", () => {
    const a = applyRandomizePattern(bigTrack(), {}, mulberry32(1234));
    const b = applyRandomizePattern(bigTrack(), {}, mulberry32(1234));
    expect(a.steps).toEqual(b.steps);
    expect(a.pitchOffsets).toEqual(b.pitchOffsets);
    expect(a.accentLevels).toEqual(b.accentLevels);
  });

  it("honors stepCount — no 16-step truncation on a 32-step track", () => {
    const t = applyRandomizePattern(bigTrack(), {}, mulberry32(7));
    expect(t.steps.length).toBe(M);
    // a musical density over 32 steps lands onsets in the second half too
    expect(t.steps.slice(16).some((s) => s)).toBe(true);
  });

  it("always anchors an onset on the downbeat", () => {
    for (const seed of [1, 2, 3, 42, 999]) {
      expect(applyRandomizePattern(bigTrack(), {}, mulberry32(seed)).steps[0]).toBe(true);
    }
  });

  it("never leaves a run of more than 2 consecutive onsets", () => {
    for (const seed of [1, 5, 17, 88, 12345]) {
      const t = applyRandomizePattern(bigTrack(), {}, mulberry32(seed));
      let run = 0;
      for (const s of t.steps) {
        run = s ? run + 1 : 0;
        expect(run).toBeLessThanOrEqual(2);
      }
    }
  });

  it("writes accents only in {0,1,2} and cellLengths all 1", () => {
    const t = applyRandomizePattern(bigTrack(), {}, mulberry32(3));
    expect(t.accentLevels.every((a) => a === 0 || a === 1 || a === 2)).toBe(true);
    expect(t.cellLengths.every((c) => c === 1)).toBe(true);
  });

  it("pitch is always an even quarter-tone value (in-scale, no micro-detune drift)", () => {
    const t = applyRandomizePattern(bigTrack({ melodicPitchMode: true } as Partial<GridTrackState>), {}, mulberry32(9));
    expect(t.pitchOffsets.every((p) => Number.isInteger(p) && p % 2 === 0)).toBe(true);
  });

  it("a drum track (no melodic signal) keeps pitch near 0; a melodic track moves it", () => {
    const drum = applyRandomizePattern(
      bigTrack({ trackType: "audio", melodicPitchMode: false, hasInstrument: false } as Partial<GridTrackState>),
      {},
      mulberry32(21),
    );
    expect(drum.pitchOffsets.every((p) => Math.abs(p) <= 2)).toBe(true);

    const melodic = applyRandomizePattern(
      bigTrack({ melodicPitchMode: true } as Partial<GridTrackState>),
      {},
      mulberry32(21),
    );
    expect(melodic.pitchOffsets.some((p) => Math.abs(p) >= 4)).toBe(true);
  });

  it("does not mutate its input", () => {
    const before = bigTrack();
    const snapshot = JSON.stringify(before);
    applyRandomizePattern(before, {}, mulberry32(5));
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
