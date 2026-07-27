import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { GridTrackState } from "../../protocol/schema.ts";
import { applyGridOp, canonicalGridSubset } from "./gridOps.ts";

/**
 * P5-03 golden-fixture harness, TS half (grid.md §5). The SAME fixture file
 * (web/fixtures/grid-ops.json) is executed by GridOpGoldenTests.swift through
 * the real BeatSequencer mutators and here through the TS reducers; both
 * canonicalize the shared per-step state and byte-compare against the
 * checked-in `expected`. A fixture with `deviatesFromSwift` documents a
 * DELIBERATE divergence from a legacy native code path (both runners still
 * agree with `expected` — the note names the native path not ported).
 */

interface GridOpFixture {
  name: string;
  description: string;
  deviatesFromSwift?: string;
  initial: {
    stepCount: number;
    playbackMode: "regular" | "owner";
    activeSteps?: number[];
    /** MB-1b: seeded pitch, so a fixture can prove `clearGrid` actually zeroes it. Quarter-tones. */
    pitchOffsets?: Record<string, number>;
    cellLengths?: Record<string, number>;
    accentLevels?: Record<string, number>;
    flamCounts?: Record<string, number>;
    wrapSourceStep?: number | null;
    glidePercent?: number;
    preSilenceMs?: number;
    legacyEmptyGlide?: boolean;
  };
  ops: {
    op: string;
    step?: number;
    length?: number;
    wrapLength?: number;
    level?: number;
    count?: number;
    on?: number;
    ms?: number;
    interval?: number;
    startStep?: number;
    pulses?: number;
    rotation?: number;
  }[];
  expected: CanonicalState;
}

interface CanonicalState {
  steps: number[];
  cellLengths: number[];
  accentLevels: number[];
  flamCounts: number[];
  glideSteps: number[];
  /** MB-1b. Optional: no pre-MB-1b op writes pitch, so an omitted block means all-zeros. */
  pitchOffsets?: number[];
  reverseSteps: number[];
  preSilenceMsOffsets: number[];
  wrapSourceStep: number | null;
}

const fixtures: GridOpFixture[] = JSON.parse(
  readFileSync(new URL("../../fixtures/grid-ops.json", import.meta.url), "utf8"),
);

function trackFromInitial(init: GridOpFixture["initial"]): GridTrackState {
  const n = init.stepCount;
  const bools = () => Array(n).fill(false);
  const zeros = () => Array(n).fill(0);
  const sparse = (over: Record<string, number> | undefined, fill: number) => {
    const a = Array(n).fill(fill);
    for (const [k, v] of Object.entries(over ?? {})) a[Number(k)] = v;
    return a;
  };
  const steps = bools();
  for (const s of init.activeSteps ?? []) steps[s] = true;
  return {
    name: "T",
    colorHex: "#ffffff",
    trackType: "audio",
    playbackMode: init.playbackMode,
    stepCount: n,
    muted: false,
    soloed: false,
    patternStartStep: null,
    locatorStart: null,
    locatorLength: null,
    steps,
    cellLengths: sparse(init.cellLengths, 1),
    wrapSourceStep: init.wrapSourceStep ?? null,
    pitchOffsets: sparse(init.pitchOffsets, 0),
    accentLevels: sparse(init.accentLevels, 0),
    flamCounts: sparse(init.flamCounts, 1),
    glideSteps: init.legacyEmptyGlide ? [] : bools(),
    reverseSteps: bools(),
    preSilenceMsOffsets: zeros(),
    cellChopIndices: Array(n).fill(-1),
    chordIndices: Array(n).fill(0),
    volumeOffsets: zeros(),
    mixVolumeOffsets: zeros(),
    panOffsets: zeros(),
    toneOffsets: zeros(),
    sampleStartMsOffsets: zeros(),
    sampleEndMsOffsets: zeros(),
    activeCellParameterName: "pitch",
    sampleKey: null,
    sampleDurationMs: 0,
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
    preSilenceMs: init.preSilenceMs ?? 0,
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
    glidePercent: init.glidePercent ?? 0,
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
    locatorLengthSteps: n,
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
  } as GridTrackState;
}

/** Canonical string for the fixture's `expected` block — same shape as
 *  canonicalGridSubset (which the Swift half mirrors byte-for-byte). */
function canonicalExpected(s: CanonicalState): string {
  const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6));
  const arr = (a: number[]) => `[${a.map(num).join(",")}]`;
  return (
    `{"accentLevels":${arr(s.accentLevels)}` +
    `,"cellLengths":${arr(s.cellLengths)}` +
    `,"flamCounts":${arr(s.flamCounts)}` +
    `,"glideSteps":${arr(s.glideSteps)}` +
    `,"pitchOffsets":${arr(s.pitchOffsets ?? new Array(s.steps.length).fill(0))}` +
    `,"preSilenceMsOffsets":${arr(s.preSilenceMsOffsets)}` +
    `,"reverseSteps":${arr(s.reverseSteps)}` +
    `,"steps":${arr(s.steps)}` +
    `,"wrapSourceStep":${s.wrapSourceStep === null ? "null" : String(s.wrapSourceStep)}}`
  );
}

describe("grid-ops golden fixtures (TS reducers vs checked-in Swift ground truth)", () => {
  for (const f of fixtures) {
    it(f.name, () => {
      let t = trackFromInitial(f.initial);
      for (const op of f.ops) t = applyGridOp(t, op);
      expect(canonicalGridSubset(t)).toBe(canonicalExpected(f.expected));
    });
  }
});
