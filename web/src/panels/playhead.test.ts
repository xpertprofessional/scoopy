import { describe, expect, it } from "vitest";
import { sourceMsToCellFrac, type CellWaveform } from "./gridWave.ts";

/**
 * SIG-1 — the truthful playhead.
 *
 * The engine says "the voice is at frame N of the sample". The cell was already
 * DRAWN from those same source frames — through trim, chop, pitch, varispeed,
 * stretch, loop-wrap and lead-in silence. So the drawing is the coordinate
 * system: invert its segment map and you get the exact column the sounding audio
 * is standing on, with no shared assumptions about tempo and no re-deriving what
 * the engine did.
 *
 * The claim these tests pin is the one the whole feature rests on:
 * WHAT YOU SEE IS WHERE THE SOUND IS. A playhead that merely tracked the step
 * boundary would pass none of them — which is precisely the bug being fixed.
 */

const wave = (over: Partial<CellWaveform>): CellWaveform => ({
  segments: [],
  silenceFrac: 0,
  reversed: false,
  windowStartMs: 0,
  windowEndMs: 100,
  ...over,
});

const seg = (a0: number, a1: number, v0: number, v1: number, stepIndex = 0) => ({
  audioStartMs: a0,
  audioEndMs: a1,
  visualStartFrac: v0,
  visualEndFrac: v1,
  stepIndex,
});

describe("sourceMsToCellFrac", () => {
  it("maps a source position to the column it was drawn at", () => {
    const w = wave({ segments: [seg(0, 100, 0, 1)] });
    expect(sourceMsToCellFrac(w, 0)).toBeCloseTo(0);
    expect(sourceMsToCellFrac(w, 50)).toBeCloseTo(0.5);
    expect(sourceMsToCellFrac(w, 100)).toBeCloseTo(1);
  });

  it("follows a TRIMMED window — the cell shows only part of the sample", () => {
    // A cell playing 200–400 ms of a longer file. Position 300 ms is halfway
    // through what the cell draws, not 300/fileLength of it. A step-based
    // playhead cannot express this at all.
    const w = wave({ segments: [seg(200, 400, 0, 1)], windowStartMs: 200, windowEndMs: 400 });
    expect(sourceMsToCellFrac(w, 300)).toBeCloseTo(0.5);
    expect(sourceMsToCellFrac(w, 200)).toBeCloseTo(0);
    // Audio the cell does NOT draw returns null — the caller then draws nothing.
    // A playhead that guesses is worse than one that admits it doesn't know.
    expect(sourceMsToCellFrac(w, 150)).toBeNull();
    expect(sourceMsToCellFrac(w, 500)).toBeNull();
  });

  it("REVERSE composes — the case that proves the inversion is real", () => {
    // A reversed cell DRAWS the mirrored window (drawSeg reflects the slice
    // through [windowStart, windowEnd] and hands drawWave `reversed: true`),
    // while the voice still reports a plain forward buffer index counting DOWN.
    // Both flips have to be applied, or the mark runs the wrong way — and it
    // would still LOOK plausible, which is why this is a test and not an eyeball.
    const w = wave({ segments: [seg(0, 100, 0, 1)], reversed: true });
    // The voice starts at the END of the audio, and that is drawn on the LEFT.
    expect(sourceMsToCellFrac(w, 100)).toBeCloseTo(0);
    expect(sourceMsToCellFrac(w, 50)).toBeCloseTo(0.5);
    // …and finishes at frame 0, on the right.
    expect(sourceMsToCellFrac(w, 0)).toBeCloseTo(1);
  });

  it("REVERSE across multiple segments mirrors the segment ORDER too", () => {
    // Two steps of one reversed cell. Visually left→right must run source
    // 100→0, which means the FIRST visual half draws the LAST audio half.
    const w = wave({
      segments: [seg(0, 50, 0, 0.5), seg(50, 100, 0.5, 1)],
      reversed: true,
    });
    expect(sourceMsToCellFrac(w, 100)).toBeCloseTo(0); // newest audio, far left
    expect(sourceMsToCellFrac(w, 75)).toBeCloseTo(0.25);
    expect(sourceMsToCellFrac(w, 50)).toBeCloseTo(0.5); // the seam
    expect(sourceMsToCellFrac(w, 25)).toBeCloseTo(0.75);
    expect(sourceMsToCellFrac(w, 0)).toBeCloseTo(1);
  });

  it("follows a PITCHED voice consuming its buffer faster than the clock", () => {
    // Two steps, but the voice eats 300 ms of audio across them (rate > 1). The
    // step index says "step 1 of 2"; the audio is already 150 ms deep. The
    // playhead has to follow the AUDIO, and this is the disagreement that makes
    // the old flat rectangle a lie.
    const w = wave({
      segments: [seg(0, 150, 0, 0.5), seg(150, 300, 0.5, 1)],
      windowEndMs: 300,
    });
    expect(sourceMsToCellFrac(w, 150)).toBeCloseTo(0.5);
    expect(sourceMsToCellFrac(w, 225)).toBeCloseTo(0.75);
  });

  it("lands inside the right segment when a cell LOOP-WRAPS the same audio twice", () => {
    // A loop-wrapped cell draws the same source window more than once. The
    // FIRST segment that contains the position wins — the playhead cannot know
    // which repeat is sounding, and picking the first is at least stable rather
    // than flickering between them.
    const w = wave({
      segments: [seg(0, 50, 0, 0.5), seg(0, 50, 0.5, 1)],
      windowEndMs: 50,
    });
    expect(sourceMsToCellFrac(w, 25)).toBeCloseTo(0.25);
  });

  it("returns null for a cell with no segments (a note cell draws no waveform)", () => {
    expect(sourceMsToCellFrac(wave({ segments: [] }), 10)).toBeNull();
  });

  it("never escapes the cell, even on a degenerate segment", () => {
    const w = wave({ segments: [seg(0, 0, 0, 1)] }); // zero-length audio window
    expect(sourceMsToCellFrac(w, 0)).toBeNull();
  });
});
