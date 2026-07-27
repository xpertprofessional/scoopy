import { describe, expect, it } from "vitest";
import type { GridTrackState } from "../../protocol/schema.ts";
import {
  cellLeadIn,
  computeCellSegments,
  flamCopySpan,
  gridStepMs,
  preSilenceOnsetFrac,
  stepAmplitude,
  stepRate,
} from "./gridWave.ts";

// Segment-mapping fixtures (grid.md §3 risk 2: TS vs Swift WaveformOverlay
// drift). Numbers chosen so consumption math is exact: bpm 120 → 125 ms grid
// step; sample 1000 ms.
const track = (over: Partial<GridTrackState>): GridTrackState => ({
  name: "T",
  colorHex: "#ff0000",
  trackType: "audio",
  playbackMode: "regular",
  stepCount: 16,
  muted: false,
  soloed: false,
  patternStartStep: null,
  locatorStart: null,
  locatorLength: null,
  steps: Array(16).fill(false),
  cellLengths: Array(16).fill(1),
  wrapSourceStep: null,
  pitchOffsets: Array(32).fill(0),
  accentLevels: Array(16).fill(0),
  flamCounts: Array(16).fill(1),
  glideSteps: Array(16).fill(false),
  reverseSteps: Array(16).fill(false),
  preSilenceMsOffsets: Array(16).fill(0),
  cellChopIndices: Array(16).fill(-1),
  chordIndices: Array(16).fill(0),
  volumeOffsets: Array(16).fill(0),
  mixVolumeOffsets: Array(16).fill(0),
  panOffsets: Array(16).fill(0),
  toneOffsets: Array(16).fill(0),
  sampleStartMsOffsets: Array(16).fill(0),
  sampleEndMsOffsets: Array(16).fill(0),
  activeCellParameterName: "pitch",
  sampleKey: "k",
  sampleDurationMs: 1000,
  sampleStartMs: 0,
  sampleEndMs: 0,
  swing: 0,
  globalPitchOffset: 0,
  speedMultiplier: 1,
  rateLockRatio: 1,
  pitchSyncMode: false,
  timeStretchMode: false,
  stretchToCell: false,
  loopEnabled: false,
  loopStartMs: 0,
  loopEndMs: 0,
  chopPointsMs: [],
  defaultChopIndex: -1,
  melodicPitchMode: false,
  isReversed: false,
  preSilenceMs: 0,
  rhythmicOffsetRatios: [],
  renderGain: 1,
  samplePeakGain: 1,
  chopPoints: [],
  chopCount: 1,
  gain: 1,
  volume: 1,
  pan: 0,
  tone: 0,
  toneFilterMode: "tone",
  toneQ: 0.707,
  filterDrive: 0,
  globalFineTuneCents: 0,
  chokeGroup: 0,
  voiceMode: "mono",
  stereoMode: 0,
  send1Level: 0,
  send2Level: 0,
  send3Level: 0,
  send4Level: 0,
  glidePercent: 0,
  freeRate: 1,
  freeRateEnabled: false,
  stretchTimeOnly: false,
  launchScheduled: false,
  isStopped: false,
  beatRepeatSteps: [],
  beatRepeatSubStep: -1,
  beatRepeatSubStart: 0,
  beatRepeatSubLen: 0,
  instrumentPresetIndex: null,
  instrumentPresetCount: null,
  instrumentPresetName: null,
  playbackDirectionReversed: false,
  ownerAttack: 0,
  ownerGate: 0,
  loopCrossfadeMs: 10,
  locatorStartStep: 0,
  locatorEndStep: 15,
  locatorLengthSteps: 16,
  locatorRepeatActive: false,
  modSlots: [],
  outputAssign: 0,
  tuning: 0,
  muteGroupMember: false,
  instrumentOutEnabled: false,
  midiOutEnabled: false,
  midiRootNote: 60,
  midiGatePercent: 100,
  midiVelocities: [],
  hasInstrument: false,
  instrumentName: null,
  midiInputPinned: false,
  ...over,
});

describe("stepRate", () => {
  it("neutral track plays at rate 1", () => {
    expect(stepRate(track({}), 0)).toBe(1);
  });
  it("pitch offsets are quarter-tones: +24 qt = +1 octave = rate 2", () => {
    const t = track({ pitchOffsets: Object.assign(Array(32).fill(0), { 3: 24 }) });
    expect(stepRate(t, 3)).toBeCloseTo(2, 10);
  });
  it("melodic mode pins rate to 1 but keeps T+P speed pitch", () => {
    const t = track({ melodicPitchMode: true, pitchSyncMode: true, speedMultiplier: 2 });
    expect(stepRate(t, 0)).toBeCloseTo(2, 10);
  });
});

describe("computeCellSegments", () => {
  it("bpm 120 → 125ms grid step", () => {
    expect(gridStepMs(120)).toBeCloseTo(125, 10);
  });

  it("neutral 2-step cell consumes linearly (one segment per step)", () => {
    const w = computeCellSegments(track({}), 120, 0, 2, false)!;
    expect(w.segments).toHaveLength(2);
    expect(w.segments[0]).toMatchObject({ audioStartMs: 0, stepIndex: 0 });
    expect(w.segments[0]!.audioEndMs).toBeCloseTo(125, 6);
    expect(w.segments[1]!.audioStartMs).toBeCloseTo(125, 6);
    expect(w.segments[1]!.audioEndMs).toBeCloseTo(250, 6);
    expect(w.segments[1]!.visualStartFrac).toBeCloseTo(0.5, 6);
  });

  it("per-step pitch only affects consumption from that step forward", () => {
    // step 1 an octave up → consumes 250ms of audio in its 125ms slot.
    const t = track({ pitchOffsets: Object.assign(Array(32).fill(0), { 1: 24 }) });
    const w = computeCellSegments(t, 120, 0, 3, false)!;
    expect(w.segments[0]!.audioEndMs).toBeCloseTo(125, 6);
    expect(w.segments[1]!.audioEndMs).toBeCloseTo(125 + 250, 6);
    expect(w.segments[2]!.audioStartMs).toBeCloseTo(375, 6); // unaffected by step 1
  });

  it("stops when the trim window is exhausted (no loop)", () => {
    const t = track({ sampleEndMs: 150 });
    const w = computeCellSegments(t, 120, 0, 4, false)!;
    const last = w.segments[w.segments.length - 1]!;
    expect(last.audioEndMs).toBeCloseTo(150, 6);
    expect(last.visualEndFrac).toBeLessThan(0.5); // audio ran out in step 2
  });

  it("loop mode wraps the window instead of stopping", () => {
    const t = track({ sampleEndMs: 150, loopEnabled: true });
    const w = computeCellSegments(t, 120, 0, 4, false)!;
    const total = w.segments.reduce((s, x) => s + (x.audioEndMs - x.audioStartMs), 0);
    expect(total).toBeCloseTo(4 * 125, 4); // full cell filled via wrapping
    expect(w.segments.length).toBeGreaterThan(4); // split at wrap boundaries
    // segments[1] is the pre-wrap tail (125→150); [2] wraps home to 0.
    expect(w.segments[1]!.audioEndMs).toBeCloseTo(150, 6);
    expect(w.segments[2]!.audioStartMs).toBeCloseTo(0, 6);
  });

  it("stretch-to-cell spans the whole window across the whole cell", () => {
    const w = computeCellSegments(track({ stretchToCell: true }), 120, 0, 4, false)!;
    expect(w.segments).toHaveLength(1);
    expect(w.segments[0]).toMatchObject({ audioStartMs: 0, audioEndMs: 1000 });
    expect(w.segments[0]!.visualEndFrac).toBe(1);
  });

  it("chop slice selects its window (cell chop over default)", () => {
    const t = track({
      defaultChopIndex: 0,
      chopPointsMs: [0, 250, 500, 750],
      cellChopIndices: Object.assign(Array(16).fill(-1), { 0: 2 }),
    });
    const w = computeCellSegments(t, 120, 0, 1, false)!;
    expect(w.segments[0]!.audioStartMs).toBeCloseTo(500, 6);
  });

  it("pre-silence + swing on an off-beat step insets the audio", () => {
    const t = track({
      preSilenceMs: 50,
      swing: 0.4,
      steps: Object.assign(Array(16).fill(false), { 1: true }),
    });
    const w = computeCellSegments(t, 120, 1, 1, false)!;
    // 50ms pre-silence + 0.4·0.5·125ms swing = 75ms of a 125ms cell.
    expect(w.silenceFrac).toBeCloseTo(75 / 125, 6);
    expect(w.segments[0]!.visualStartFrac).toBeCloseTo(75 / 125, 6);
  });

  it("wrap continuation resumes where the source cell left off", () => {
    // REG consumption is per-step (native pitchIndex = currentStepIndex):
    // step 14 at octave-up rate eats 250ms, step 15 neutral eats 125ms.
    const t = track({
      steps: Object.assign(Array(16).fill(false), { 14: true }),
      cellLengths: Object.assign(Array(16).fill(1), { 14: 4 }),
      wrapSourceStep: 14,
      pitchOffsets: Object.assign(Array(32).fill(0), { 14: 24 }),
    });
    const w = computeCellSegments(t, 120, 0, 2, true)!;
    expect(w.segments[0]!.audioStartMs).toBeCloseTo(375, 6);
  });

  it("varispeed changes the step duration, not the consumed ratio", () => {
    // 2× speed → 62.5ms steps; neutral pitch keeps rate 1.
    const w = computeCellSegments(track({ speedMultiplier: 2 }), 120, 0, 2, false)!;
    expect(w.segments[0]!.audioEndMs).toBeCloseTo(62.5, 6);
  });

  it("reverse is flagged from track XOR owner step (engine parity)", () => {
    expect(computeCellSegments(track({ isReversed: true }), 120, 0, 1, false)!.reversed).toBe(true);
    const t = track({ reverseSteps: Object.assign(Array(16).fill(false), { 0: true }) });
    expect(computeCellSegments(t, 120, 0, 1, false)!.reversed).toBe(true);
    // Both reversed = plays FORWARD (toggles compose); OR drew it mirrored.
    const both = track({
      isReversed: true,
      reverseSteps: Object.assign(Array(16).fill(false), { 0: true }),
    });
    expect(computeCellSegments(both, 120, 0, 1, false)!.reversed).toBe(false);
  });
});

describe("flamCopySpan (pre-silence rides along with the flam)", () => {
  // The engine spaces sub-hits evenly across the step (NativeAudioEngineCore
  // :4575) and then delays EVERY sub-hit voice by the full pre-silence (:5382).
  // Hit k therefore sounds at k·slot + preSilence — the group moves later by the
  // whole lead-in, and the gap in front of each stroke stays the same size.
  const onsets = (silenceLocal: number, flam: number, stepFrac = 1) =>
    Array.from({ length: flam }, (_, f) =>
      flamCopySpan(silenceLocal, 1, silenceLocal, stepFrac, flam, f),
    ).map((c) => (c === null ? null : c.v0));

  it("delays every stroke by the FULL pre-silence, not preSilence/N", () => {
    // 4 hits, lead-in = 10% of the step → onsets at 0.10 / 0.35 / 0.60 / 0.85,
    // i.e. k·0.25 + 0.10. The old draw compressed the gap to 0.025 and shifted
    // the group by a quarter of the delay it actually gets.
    expect(onsets(0.1, 4)).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(0.35, 6),
      expect.closeTo(0.6, 6),
      expect.closeTo(0.85, 6),
    ]);
  });

  it("keeps the gap the same size in every sub-slot", () => {
    const gaps = onsets(0.08, 3).map((v, f) => v! - f / 3);
    for (const g of gaps) expect(g).toBeCloseTo(0.08, 6);
  });

  it("the stroke narrows as the lead-in eats its slot (the next trigger cuts it)", () => {
    const c = flamCopySpan(0.1, 1, 0.1, 1, 4, 0)!;
    expect(c.v1 - c.v0).toBeCloseTo(0.15, 6); // slot 0.25 − gap 0.10
  });

  it("drops the stroke once the lead-in fills the whole sub-slot", () => {
    // 4 hits = 0.25 slots; a 0.3 lead-in swallows each hit before it sounds.
    expect(onsets(0.3, 4)).toEqual([null, null, null, null]);
  });

  it("is identical to the plain mapping when there is no lead-in", () => {
    const c = flamCopySpan(0, 1, 0, 1, 4, 2)!;
    expect(c.v0).toBeCloseTo(0.5, 6);
    expect(c.v1).toBeCloseTo(0.75, 6);
  });

  it("scales into a multi-step cell's owner step", () => {
    // span 2 → the owner step is the left half of the cell.
    const c = flamCopySpan(0.2, 1, 0.2, 0.5, 2, 1)!;
    expect(c.v0).toBeCloseTo((0.5 + 0.2) * 0.5, 6);
    expect(c.v1).toBeCloseTo(1 * 0.5, 6);
  });
});

describe("preSilenceOnsetFrac (note cells)", () => {
  it("is the delay against the cell's real duration, not a fixed 500ms scale", () => {
    // bpm 120 → 125ms step; a 2-step cell is 250ms, so 50ms = 20% of the cell.
    expect(preSilenceOnsetFrac(track({ preSilenceMs: 50 }), 120, 0, 2)).toBeCloseTo(0.2, 6);
    // Tempo-relative: the same 50ms is a bigger slice of a faster cell.
    expect(preSilenceOnsetFrac(track({ preSilenceMs: 50 }), 240, 0, 2)).toBeCloseTo(0.4, 6);
  });

  it("adds the per-cell offset and clamps inside the cell (native :1636)", () => {
    const t = track({
      preSilenceMs: 20,
      preSilenceMsOffsets: Object.assign(Array(16).fill(0), { 3: 15 }),
    });
    expect(preSilenceOnsetFrac(t, 120, 3, 1)).toBeCloseTo(35 / 125, 6);
    expect(preSilenceOnsetFrac(track({ preSilenceMs: 900 }), 120, 0, 1)).toBe(0.98);
  });
});

describe("cellLeadIn (pre-silence onset-drag math)", () => {
  // bpm 120 → 125ms/step; a 2-step cell = 250ms.
  it("cellDurationMs = span × step; floor excludes editable pre-silence", () => {
    const t = track({ preSilenceMs: 30 });
    const l = cellLeadIn(t, 120, 0, 2);
    expect(l.cellDurationMs).toBe(250);
    expect(l.floorMs).toBe(0); // no swing/rhythmic/neg-start here
    expect(l.preSilenceAbsMs).toBe(30);
  });

  it("swing on an odd step adds to the non-editable floor", () => {
    const t = track({ swing: 0.5 }); // 0.5 × 0.5 × 125 = 31.25ms on odd steps
    expect(cellLeadIn(t, 120, 1, 1).floorMs).toBeCloseTo(31.25, 4);
    expect(cellLeadIn(t, 120, 0, 1).floorMs).toBe(0); // even step: no swing
  });

  it("per-cell pre-silence offset rides on top of the base", () => {
    const t = track({
      preSilenceMs: 20,
      preSilenceMsOffsets: Object.assign(Array(16).fill(0), { 3: 15 }),
    });
    expect(cellLeadIn(t, 120, 3, 1).preSilenceAbsMs).toBe(35);
  });
});

describe("stepAmplitude", () => {
  it("base gain × accent, plus per-step volume offset", () => {
    const t = track({
      renderGain: 0.8,
      samplePeakGain: 1,
      chopPoints: [],
      chopCount: 1,
      accentLevels: Object.assign(Array(16).fill(0), { 0: 2 }),
      volumeOffsets: Object.assign(Array(16).fill(0), { 1: 0.2 }),
    });
    expect(stepAmplitude(t, 0, 0)).toBeCloseTo(0.8 * 1.5, 6);
    expect(stepAmplitude(t, 1, 0)).toBeCloseTo(1.0 * 1.5, 6);
    expect(stepAmplitude(track({}), 0, 0)).toBe(1);
  });
});
