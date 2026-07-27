/**
 * applyAdjustCellParameter — the TS port of Swift's adjustStepParameter
 * (BeatSequencer.swift:16528). The desktop runs the Swift mutator; the browser
 * companion runs THIS, so per-cell value-drag/ö-ä actually edits there. These
 * pin the exact per-parameter step sizes, clamps, and the delta-sign-vs-
 * magnitude split — the numbers must match Swift or the browser drifts from the
 * desktop.
 */
import { describe, expect, it } from "vitest";
import type { GridTrackState } from "../../protocol/schema";
import { applyAdjustCellParameter } from "./trackOps";

const N = 8;
const track = (over: Partial<GridTrackState> = {}): GridTrackState =>
  ({
    stepCount: N,
    trackType: "audio",
    activeCellParameterName: "pitch",
    steps: [true, false, true, false, true, false, true, false],
    cellLengths: [1, 1, 1, 1, 1, 1, 1, 1],
    wrapSourceStep: null,
    pitchOffsets: Array(N).fill(0),
    accentLevels: Array(N).fill(0),
    flamCounts: Array(N).fill(1),
    glideSteps: Array(N).fill(false),
    reverseSteps: Array(N).fill(false),
    preSilenceMsOffsets: Array(N).fill(0),
    cellChopIndices: Array(N).fill(-1),
    chordIndices: Array(N).fill(0),
    volumeOffsets: Array(N).fill(0),
    mixVolumeOffsets: Array(N).fill(0),
    panOffsets: Array(N).fill(0),
    toneOffsets: Array(N).fill(0),
    sampleStartMsOffsets: Array(N).fill(0),
    sampleEndMsOffsets: Array(N).fill(0),
    midiVelocities: Array(N).fill(100),
    // base scalars the offsets ride on
    volume: 1,
    gain: 1,
    pan: 0,
    tone: 0,
    toneFilterMode: "tone",
    preSilenceMs: 0,
    sampleStartMs: 0,
    sampleEndMs: 500,
    sampleDurationMs: 1000,
    midiRootNote: 60,
    ...over,
  }) as unknown as GridTrackState;

describe("pitch (sign-only, quarter-tones)", () => {
  it("one dial step = +2 qt (1 semitone), regardless of delta magnitude", () => {
    expect(applyAdjustCellParameter(track(), 2, 1, false).pitchOffsets[2]).toBe(2);
    // Swift collapses a multi-notch delta to its SIGN for pitch.
    expect(applyAdjustCellParameter(track(), 2, 5, false).pitchOffsets[2]).toBe(2);
    expect(applyAdjustCellParameter(track(), 2, -1, false).pitchOffsets[2]).toBe(-2);
  });
  it("fine (⌥) = 0.2 qt (0.1 semitone)", () => {
    expect(applyAdjustCellParameter(track(), 0, 1, true).pitchOffsets[0]).toBeCloseTo(0.2, 10);
  });
  it("clamps to ±96 qt", () => {
    expect(applyAdjustCellParameter(track({ pitchOffsets: fill(95) }), 0, 1, false).pitchOffsets[0]).toBe(96);
    expect(applyAdjustCellParameter(track({ pitchOffsets: fill(-95) }), 0, -1, false).pitchOffsets[0]).toBe(-96);
  });
  it("extends the array for a step past the pattern (extended cell)", () => {
    const t = applyAdjustCellParameter(track(), 10, 1, false);
    expect(t.pitchOffsets.length).toBe(11);
    expect(t.pitchOffsets[10]).toBe(2);
  });
});

describe("magnitude-scaled lanes store an offset over the base", () => {
  it("volume: 5% per step on mixVolumeOffsets, clamp abs 0…2", () => {
    const t = applyAdjustCellParameter(track({ activeCellParameterName: "volume" }), 0, 2, false);
    expect(t.mixVolumeOffsets[0]).toBeCloseTo(0.1, 6); // base 1 → 1.1 → offset 0.1
  });
  it("pan: 0.1 per step, clamp abs −1…1", () => {
    const t = applyAdjustCellParameter(track({ activeCellParameterName: "pan" }), 0, 3, false);
    expect(t.panOffsets[0]).toBeCloseTo(0.3, 6);
    const hi = applyAdjustCellParameter(track({ activeCellParameterName: "pan" }), 0, 100, false);
    expect(hi.panOffsets[0]).toBeCloseTo(1, 6); // clamped
  });
  it("tone: 2 per step, bipolar in tone mode", () => {
    const t = applyAdjustCellParameter(track({ activeCellParameterName: "tone" }), 0, 5, false);
    expect(t.toneOffsets[0]).toBeCloseTo(10, 5);
  });
  it("tone: filter mode stores |v| (any direction grows magnitude), clamp 0…100", () => {
    // base 0, lowPass: delta −3 → inc −6 → |−6| = 6.
    const t = applyAdjustCellParameter(
      track({ activeCellParameterName: "tone", toneFilterMode: "lowPass" }),
      0,
      -3,
      false,
    );
    expect(t.toneOffsets[0]).toBeCloseTo(6, 5);
    // clamps the magnitude at 100.
    const hi = applyAdjustCellParameter(
      track({ activeCellParameterName: "tone", toneFilterMode: "lowPass" }),
      0,
      60,
      false,
    );
    expect(hi.toneOffsets[0]).toBeCloseTo(100, 5);
  });
  it("sampleStart: 5ms per step; also clears the cell's chop", () => {
    const t = applyAdjustCellParameter(
      track({ activeCellParameterName: "sampleStart", cellChopIndices: fill(3) }),
      0,
      4,
      false,
    );
    expect(t.sampleStartMsOffsets[0]).toBeCloseTo(20, 6);
    expect(t.cellChopIndices[0]).toBe(-1);
  });
  it("preSilence: 5ms per step, clamp 0…1000", () => {
    const t = applyAdjustCellParameter(track({ activeCellParameterName: "preSilence" }), 0, -3, false);
    expect(t.preSilenceMsOffsets[0]).toBe(0); // base 0, can't go below 0
  });
});

describe("cycles + toggles (sign-only)", () => {
  it("accent cycles off→soft→hard→off", () => {
    let t = track({ activeCellParameterName: "accent" });
    t = applyAdjustCellParameter(t, 0, 1, false);
    expect(t.accentLevels[0]).toBe(1);
    t = applyAdjustCellParameter(t, 0, 1, false);
    expect(t.accentLevels[0]).toBe(2);
    t = applyAdjustCellParameter(t, 0, 1, false);
    expect(t.accentLevels[0]).toBe(0);
  });
  it("flam clamps 1…16 (no wrap)", () => {
    expect(applyAdjustCellParameter(track({ activeCellParameterName: "flam" }), 0, -1, false).flamCounts[0]).toBe(1);
    expect(applyAdjustCellParameter(track({ activeCellParameterName: "flam", flamCounts: fill(16) }), 0, 1, false).flamCounts[0]).toBe(16);
  });
  it("reverse/glide set by delta sign", () => {
    expect(applyAdjustCellParameter(track({ activeCellParameterName: "reverse" }), 0, 1, false).reverseSteps[0]).toBe(true);
    expect(applyAdjustCellParameter(track({ activeCellParameterName: "reverse" }), 0, -1, false).reverseSteps[0]).toBe(false);
    expect(applyAdjustCellParameter(track({ activeCellParameterName: "glide" }), 0, 1, false).glideSteps[0]).toBe(true);
  });
  it("chord clamps at 0 (no wrap below OFF)", () => {
    expect(applyAdjustCellParameter(track({ activeCellParameterName: "chord" }), 0, -1, false).chordIndices[0]).toBe(0);
    expect(applyAdjustCellParameter(track({ activeCellParameterName: "chord" }), 0, 1, false).chordIndices[0]).toBe(1);
  });
  it("chop cycles through active chops + the off slot", () => {
    // chopCount 2 → options {-1, 0, 1}. From -1, +1 → 0.
    const t = applyAdjustCellParameter(track({ activeCellParameterName: "chop", chopCount: 2 }), 0, 1, false);
    expect(t.cellChopIndices[0]).toBe(0);
  });
});

describe("MIDI lanes", () => {
  it("midiNote shares the pitch lane", () => {
    const t = applyAdjustCellParameter(track({ activeCellParameterName: "midiNote", trackType: "midi" }), 0, 1, false);
    expect(t.pitchOffsets[0]).toBe(2);
  });
  it("midiVelocity: 5 per step (⌥ = 1), clamp 0…127", () => {
    expect(applyAdjustCellParameter(track({ activeCellParameterName: "midiVelocity" }), 0, 1, false).midiVelocities[0]).toBe(105);
    expect(applyAdjustCellParameter(track({ activeCellParameterName: "midiVelocity" }), 0, 1, true).midiVelocities[0]).toBe(101);
  });
  it("cellLength: ±1 step, clamped to the pattern tail", () => {
    expect(applyAdjustCellParameter(track({ activeCellParameterName: "cellLength" }), 2, 1, false).cellLengths[2]).toBe(2);
    // step 6, stepCount 8 → maxLength 2; growing past clamps.
    expect(applyAdjustCellParameter(track({ activeCellParameterName: "cellLength", cellLengths: fill(2) }), 6, 1, false).cellLengths[6]).toBe(2);
  });
});

it("does not mutate its input", () => {
  const before = track({ activeCellParameterName: "pan" });
  const snapshot = JSON.stringify(before);
  applyAdjustCellParameter(before, 0, 3, false);
  expect(JSON.stringify(before)).toBe(snapshot);
});

it("a negative step index is a no-op", () => {
  const t = track();
  expect(applyAdjustCellParameter(t, -1, 1, false)).toBe(t);
});

function fill(v: number): number[] {
  return Array(N).fill(v);
}
