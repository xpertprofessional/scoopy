/**
 * NAV-12 — the gate that decides whether a track-row edit moves the whole
 * selection or only the track it landed on.
 *
 * This is the web half of the contract. The other half is Swift's
 * `WebGridBinding.applySelectionFanOut`, which re-checks the same conditions
 * against `selectedTrackIds` rather than trusting the flag on the wire — these
 * tests pin the web's side of that agreement.
 */
import { describe, it, expect } from "vitest";
import { fansOutToSelection, SELECTION_FANOUT_OPS, VERIFIABLE_TRACK_OPS } from "./trackOps.ts";

describe("fansOutToSelection — which edits move the whole selection", () => {
  it("fans out an eligible op on a track inside a multi-selection", () => {
    expect(fansOutToSelection("setVolume", 2, [1, 2, 5])).toBe(true);
  });

  it("does NOT fan out to a track outside the selection (Finder's rule)", () => {
    // The whole point: editing an unselected track is an ordinary edit, never a
    // surprise mass-edit of tracks the user is not touching.
    expect(fansOutToSelection("setVolume", 7, [1, 2, 5])).toBe(false);
  });

  it("does NOT fan out when only one track is selected", () => {
    // Would be a no-op detour through the unmodeled path, losing the reducer.
    expect(fansOutToSelection("setVolume", 2, [2])).toBe(false);
  });

  it("does NOT fan out when nothing is selected", () => {
    expect(fansOutToSelection("setVolume", 2, [])).toBe(false);
  });

  it("does NOT fan out an op native does not fan out", () => {
    // setGain has no `updateMultipleTracksGain` in the native family, and the
    // sample window is meaningless across different samples.
    for (const op of ["setGain", "setSampleStart", "setChopCount", "setSwing"]) {
      expect(fansOutToSelection(op, 2, [1, 2, 5]), op).toBe(false);
    }
  });

  it("ignores a non-numeric trackIndex", () => {
    expect(fansOutToSelection("setVolume", undefined, [1, 2])).toBe(false);
    expect(fansOutToSelection("setVolume", "2", [1, 2])).toBe(false);
  });

  it("covers every op the row actually marks with a selectionIntent", () => {
    // Guards the wiring: these are the ops trackRowControls tags. If one is
    // dropped from the set the edit silently stops fanning out, which is
    // invisible until someone drags a multi-selection and only one track moves.
    for (const op of [
      "setVolume", "setPan", "setPitch", "setTone", "setSend",
      "setToneFilterMode", "setToneQ", "setFilterDrive", "setStereoMode",
    ]) {
      expect(fansOutToSelection(op, 0, [0, 1]), op).toBe(true);
    }
  });

  it("every fan-out op is one the single-track reducers also model", () => {
    // A fan-out op takes the UNMODELED path on purpose (Swift moves tracks this
    // per-track chain cannot see). But with ONE track selected it falls back to
    // the reducer — so every one of them must still be verifiable, or that
    // fallback would poison the shadow chain on ordinary single-track edits.
    for (const op of SELECTION_FANOUT_OPS) {
      expect(VERIFIABLE_TRACK_OPS.has(op), op).toBe(true);
    }
  });
});
