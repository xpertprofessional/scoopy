import type { GridTrackState } from "../../protocol/schema.ts";
import {
  applyCycleAccent,
  applyCycleFlam,
  applySetAccent,
  applySetCellLength,
  applySetFlam,
  applySetGlide,
  applySetPreSilence,
  applySetReverse,
  applyToggleStep,
} from "./gridModel.ts";
import { applyClearGrid, applyGenerateEuclidean, applyGenerateInterval } from "./patternOps.ts";

/**
 * Shared grid-op application + canonical per-step serialization (P5-03/04).
 * Used by the golden-fixture harness (gridOpsGolden.test.ts — byte-compared
 * against the Swift mutators) AND the shadow PatternStore (P5-04), so the
 * store's predictions are exactly the fixture-verified reducers.
 */

export interface GridOp {
  op: string;
  trackIndex?: number;
  step?: number;
  length?: number;
  wrapLength?: number;
  level?: number;
  count?: number;
  on?: boolean | number;
  ms?: number;
  [key: string]: unknown;
}

/** Ops whose effect the TS reducers fully model (fixture-verified). Ops
 *  outside this set (adjustParameter, paintCell, pasteCells — values are
 *  computed Swift-side) make the track's next authoritative push
 *  unverifiable for drift purposes. */
export const VERIFIABLE_GRID_OPS = new Set([
  "toggleStep",
  "setCellLength",
  "cycleAccent",
  "cycleFlam",
  "setAccent",
  "setFlam",
  "setGlide",
  "setReverse",
  "setPreSilenceCell",
  // MB-1b — the Pattern menu's whole-pattern ops. Membership here is what makes an op TS-OWNED
  // under the flip (GridPanel.sendEdit applies it and publishes the result instead of sending the
  // intent), so it is also the ownership declaration.
  "clearGrid",
  "generateInterval", // superseded by generateEuclidean; alive until the menu stops calling it (MB-7)
  "generateEuclidean",
]);

/** No-op bookkeeping ops: neither modeled nor state-changing. */
export const BOOKKEEPING_GRID_OPS = new Set(["beginUndo", "endUndo", "copyCells"]);

export function applyGridOp(t: GridTrackState, op: GridOp): GridTrackState {
  const on = typeof op.on === "number" ? op.on !== 0 : (op.on ?? false);
  switch (op.op) {
    case "toggleStep":
      return applyToggleStep(t, op.step!);
    case "setCellLength":
      return applySetCellLength(t, op.step!, op.length!, op.wrapLength ?? 0);
    case "cycleAccent":
      return applyCycleAccent(t, op.step!);
    case "cycleFlam":
      return applyCycleFlam(t, op.step!);
    case "setAccent":
      return applySetAccent(t, op.step!, op.level ?? 0);
    case "setFlam":
      return applySetFlam(t, op.step!, op.count ?? 1);
    case "setGlide":
      return applySetGlide(t, op.step!, on);
    case "setReverse":
      return applySetReverse(t, op.step!, on);
    case "setPreSilenceCell":
      return applySetPreSilence(t, op.step!, op.ms ?? 0);
    case "clearGrid":
      return applyClearGrid(t);
    case "generateInterval":
      return applyGenerateInterval(t, (op.interval as number) ?? 1, (op.startStep as number) ?? 0);
    case "generateEuclidean":
      return applyGenerateEuclidean(t, (op.pulses as number) ?? 4, (op.rotation as number) ?? 0);
    default:
      return t;
  }
}

/** Canonical serialization of the per-step subset the reducers own — MUST
 *  match GridOpGoldenTests.swift exactly: alphabetical keys, no whitespace,
 *  bools as 0/1, integral numbers as ints, arrays padded to stepCount.
 *
 *  MB-1b added `pitchOffsets` (alphabetically between glideSteps and preSilenceMsOffsets). It had
 *  to: the arpeggio generators exist ENTIRELY to write pitch, so a comparison that skipped it
 *  would have declared them verified while proving nothing about the one thing they do. Pitch is
 *  in QUARTER-TONES (2.0 = one semitone).
 *
 *  ⚠️ Still NOT spanned, and therefore still unproven by this harness: the five offset lanes
 *  `clearGrid` zeroes (volume/mixVolume/pan/sampleStart/sampleEnd). They are covered by unit tests
 *  in patternOps.test.ts instead. Widening the canonical to reach them means widening the fixture
 *  `initial` block too — a worthwhile follow-up, not a silent gap. */
export function canonicalGridSubset(t: GridTrackState): string {
  const n = t.stepCount;
  const num = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6));
  const pad = (a: number[], fill: number) => {
    const out = a.slice(0, n);
    while (out.length < n) out.push(fill);
    return out;
  };
  const b01 = (a: boolean[]) => pad(a.map((v) => (v ? 1 : 0)), 0);
  const arr = (a: number[]) => `[${a.map(num).join(",")}]`;
  return (
    `{"accentLevels":${arr(pad(t.accentLevels, 0))}` +
    `,"cellLengths":${arr(pad(t.cellLengths, 1))}` +
    `,"flamCounts":${arr(pad(t.flamCounts, 1))}` +
    `,"glideSteps":${arr(b01(t.glideSteps))}` +
    `,"pitchOffsets":${arr(pad(t.pitchOffsets, 0))}` +
    `,"preSilenceMsOffsets":${arr(pad(t.preSilenceMsOffsets, 0))}` +
    `,"reverseSteps":${arr(b01(t.reverseSteps))}` +
    `,"steps":${arr(b01(t.steps))}` +
    `,"wrapSourceStep":${t.wrapSourceStep === null ? "null" : String(t.wrapSourceStep)}}`
  );
}
