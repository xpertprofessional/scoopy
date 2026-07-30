/**
 * The deck transport laws, pinned against the donor's arithmetic.
 *
 * These are ported laws, not invented ones, so every case here answers "what
 * does `../../../scoopyloops` do" rather than "what seems reasonable". Where a
 * case exists only because the port could go wrong, it says so.
 */
import { describe, expect, it } from "vitest";

import {
  applyPitchModeExclusion,
  nudgeTranspose,
  oneShotStopStep,
  shiftBeatRepeatWindow,
} from "./deckTransport.ts";

describe("one-shot (BeatSequencer.playOnce)", () => {
  it("stops after one whole cycle from a standstill", () => {
    expect(oneShotStopStep(16, false, 0)).toBe(15);
    expect(oneShotStopStep(48, false, 0)).toBe(47);
  });

  it("lets the cycle IN FLIGHT finish rather than restarting it", () => {
    // Mid-way through the third cycle of 16 → stop at the end of that third
    // cycle (step 47), not at 15 and not by jumping back to 0. This is the case
    // the feature exists for: ▸¹ pressed while the loop is already running.
    expect(oneShotStopStep(16, true, 35)).toBe(47);
    // Exactly on a boundary counts as being IN the cycle that starts there.
    expect(oneShotStopStep(16, true, 32)).toBe(47);
    // The last step of a cycle still belongs to it — off by one here would stop
    // the deck a whole cycle early.
    expect(oneShotStopStep(16, true, 31)).toBe(31);
  });

  it("refuses a pattern with no cycle instead of arming a stop at -1", () => {
    // The donor's `guard lcmLength > 0`. Returning cycle-1 unguarded would arm
    // a stop at -1, which every step satisfies — the deck would stop instantly.
    expect(oneShotStopStep(0, false, 0)).toBeNull();
    expect(oneShotStopStep(-4, true, 10)).toBeNull();
    expect(oneShotStopStep(Number.NaN, false, 0)).toBeNull();
  });
});

describe("beat-repeat window shift (BeatSequencer.shiftBeatRepeat)", () => {
  const at = (startStep: number, startSubcell = 0) => ({ startStep, startSubcell });

  it("moves whole steps when there is no subdivision", () => {
    expect(shiftBeatRepeatWindow(at(4), 1, 1, 16)).toEqual({ startStep: 5, startSubcell: 0 });
    expect(shiftBeatRepeatWindow(at(4), -1, 1, 16)).toEqual({ startStep: 3, startSubcell: 0 });
  });

  it("walks sub-cells and carries whole steps at higher subdivisions", () => {
    // subdivision 4: three shifts right walk within step 4, the fourth rolls it.
    expect(shiftBeatRepeatWindow(at(4, 0), 1, 4, 16)).toEqual({ startStep: 4, startSubcell: 1 });
    expect(shiftBeatRepeatWindow(at(4, 3), 1, 4, 16)).toEqual({ startStep: 5, startSubcell: 0 });
  });

  it("carries DOWNWARD on a negative sub-cell — the floor, not a truncation", () => {
    // THE PORT'S SHARPEST EDGE. Math.trunc(-1/4) is 0, which would leave the
    // sub-cell at -1 and the step unmoved: the window would stick at the
    // boundary instead of walking left. Math.floor(-1/4) is -1, which is what
    // the donor's `.rounded(.down)` does.
    expect(shiftBeatRepeatWindow(at(4, 0), -1, 4, 16)).toEqual({ startStep: 3, startSubcell: 3 });
    expect(shiftBeatRepeatWindow(at(4, 0), -5, 4, 16)).toEqual({ startStep: 2, startSubcell: 3 });
  });

  it("wraps a negative start by a whole cycle, leaving the audible fold alone", () => {
    // The engine reads the start modulo the pattern, so +cycle is inaudible —
    // but the wire clamps negatives to 0, so the number must not go negative.
    expect(shiftBeatRepeatWindow(at(0), -1, 1, 16).startStep).toBe(15);
    // Many cycles negative still lands in range (a `while` loop and a modulo
    // agree here; the modulo is just not O(n) in how far you dragged).
    expect(shiftBeatRepeatWindow(at(0), -33, 1, 16).startStep).toBe(15);
  });

  it("clamps at 0 when there is no cycle to wrap by", () => {
    expect(shiftBeatRepeatWindow(at(0), -1, 1, 0).startStep).toBe(0);
  });
});

describe("TP mode: transpose ⊕ sync (WebToolbarBinding.handleDeckSectionCommand)", () => {
  it("lets both run together when pitch mode is OFF", () => {
    // The donor gates every exclusion on pitchModeEnabled. With it off, syncing
    // a transposed deck is legal and common.
    expect(
      applyPitchModeExclusion({ syncEnabled: true, transposeEnabled: true }, false, "sync"),
    ).toEqual({ syncEnabled: true, transposeEnabled: true });
  });

  it("drops transpose when sync is engaged in pitch mode", () => {
    expect(
      applyPitchModeExclusion({ syncEnabled: true, transposeEnabled: true }, true, "sync"),
    ).toEqual({ syncEnabled: true, transposeEnabled: false });
  });

  it("drops sync when transpose is engaged in pitch mode", () => {
    expect(
      applyPitchModeExclusion({ syncEnabled: true, transposeEnabled: true }, true, "transpose"),
    ).toEqual({ syncEnabled: false, transposeEnabled: true });
  });

  it("leaves a DISENGAGE alone — turning one off never turns the other on", () => {
    // Only engaging excludes. Switching sync off must not silently re-enable
    // transpose, which would be a control moving on its own.
    expect(
      applyPitchModeExclusion({ syncEnabled: false, transposeEnabled: false }, true, "sync"),
    ).toEqual({ syncEnabled: false, transposeEnabled: false });
  });
});

describe("TR nudge", () => {
  it("steps by a semitone and clamps to the donor's ±12", () => {
    expect(nudgeTranspose(0, 1)).toBe(1);
    expect(nudgeTranspose(11, 1)).toBe(12);
    expect(nudgeTranspose(12, 1)).toBe(12); // an octave up is the ceiling
    expect(nudgeTranspose(-12, -1)).toBe(-12);
  });
});
