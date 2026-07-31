/**
 * ⌥-STRETCH (P3.5-E8c + E8g-h-a) — the donor's algorithm, transcribed.
 *
 * Every case here answers "what does `configureTrackAsStretch` do"
 * (BeatSequencer.swift:15693-15719), not "what seems reasonable". The row that
 * routed the flag deliberately did NOT build this half and said so — the
 * warning was that the shape is the donor's to state, not ours to invent.
 */
import { describe, expect, it } from "vitest";

import { stretchRow } from "./stretchImport.ts";

const row = (over: Record<string, unknown> = {}) => ({
  steps: [true, true, true, true],
  playbackMode: 0,
  ...over,
});

describe("the stretch shape", () => {
  it("triggers ONCE — every step cleared, then step 0", () => {
    // A stretched track spans the bar; retriggering on every step is exactly
    // the behaviour it exists to replace.
    expect(stretchRow(row()).steps).toEqual([true, false, false, false]);
  });

  it("switches to the stretch playback mode", () => {
    // Index 1 of PLAYBACK_MODES (`TrackPlaybackMode.stretch`, Track.swift:40).
    expect(stretchRow(row()).playbackMode).toBe(1);
  });

  it("spans the single cell across the WHOLE pattern", () => {
    expect(stretchRow(row()).cellLengths).toEqual([4, 1, 1, 1]);
  });

  it("releases that cell in full", () => {
    expect(stretchRow(row()).fullReleaseSteps).toEqual([true, false, false, false]);
  });

  it("GROWS the support arrays rather than replacing them", () => {
    // The donor appends until each array reaches stepCount. A track whose
    // arrays are shorter was written before the array existed; truncating —
    // or rebuilding from scratch — would silently drop the tail a longer row
    // carries.
    const out = stretchRow(
      row({ cellLengths: [2, 3], fullReleaseAutoExtend: [true] }),
    );
    expect(out.cellLengths).toEqual([4, 3, 1, 1]); // [0] spans; [1] survives
    expect(out.fullReleaseAutoExtend).toEqual([true, false, false, false]);
  });

  it("leaves a row with NO steps untouched", () => {
    // There is no pattern to span, and inventing a step count would fabricate a
    // bar length nobody chose.
    const empty = row({ steps: [] });
    expect(stretchRow(empty)).toBe(empty);
  });

  it("returns a FRESH row, never editing in place", () => {
    // The document is immutable-update shaped, and the undo entries hold
    // patterns BY REFERENCE — an in-place edit would rewrite history.
    const before = row();
    const after = stretchRow(before);
    expect(after).not.toBe(before);
    expect(before.steps).toEqual([true, true, true, true]);
    expect(before.playbackMode).toBe(0);
  });
});
