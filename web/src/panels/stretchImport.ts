/**
 * ⌥-STRETCH IMPORT (P3.5-E8c + P3.5-E8g-h-a) — what holding ⌥ on a sample load
 * actually DOES once the flag arrives.
 *
 * ⚠️ Two rows, and the split between them is the point. E8c routed the flag and
 * stopped; this is the half the ledger warned not to invent — "the row routes
 * the flag and stops; the donor is what the flag must DO on arrival". So it is
 * a transcription of `BeatSequencer.configureTrackAsStretch(trackIndex:)`
 * (:15693-15719), step for step:
 *
 *     playbackMode = .stretch
 *     clear every step, then steps[0] = true
 *     grow cellLengths / fullReleaseSteps / fullReleaseAutoExtend to stepCount
 *     cellLengths[0] = stepCount
 *     fullReleaseSteps[0] = true
 *
 * The MEANING: one cell, spanning the whole pattern, released in full — a
 * sample stretched across the bar rather than retriggered on every step. That is
 * why the arrays are GROWN rather than replaced: a track whose support arrays
 * are shorter than its step count is one the desktop wrote before the array
 * existed, and truncating it would silently drop the tail.
 *
 * Pure, and over the DOCUMENT rows rather than the projection, because it is a
 * document edit — the same tier `applyGridRow` writes.
 */

/** `TrackPlaybackMode.stretch` — index 1 of `PLAYBACK_MODES` (Track.swift:40). */
const PLAYBACK_MODE_STRETCH = 1;

type Row = Record<string, unknown>;

/** Grow `arr` to `n` with `fill`, never truncating. The donor's `while … append`. */
function grown(arr: unknown, n: number, fill: unknown): unknown[] {
  const out = Array.isArray(arr) ? [...arr] : [];
  while (out.length < n) out.push(fill);
  return out;
}

/**
 * The stretch shape, applied to one document row. Returns a FRESH row — the
 * document is immutable-update shaped, and a mutator that edited in place would
 * defeat the undo entries that hold patterns by reference.
 *
 * A row with no steps is returned untouched: there is no pattern to span, and
 * inventing a step count would fabricate a bar length nobody chose.
 */
export function stretchRow(row: Row): Row {
  const steps = row.steps;
  if (!Array.isArray(steps) || steps.length === 0) return row;
  const stepCount = steps.length;

  return {
    ...row,
    playbackMode: PLAYBACK_MODE_STRETCH,
    // Clear every step, then step 0 alone — a stretched track triggers ONCE.
    steps: steps.map((_, i) => i === 0),
    cellLengths: (() => {
      const a = grown(row.cellLengths, stepCount, 1);
      a[0] = stepCount; // the single cell spans the pattern
      return a;
    })(),
    fullReleaseSteps: (() => {
      const a = grown(row.fullReleaseSteps, stepCount, false);
      a[0] = true; // …and is released in full
      return a;
    })(),
    // Grown but not otherwise touched, exactly as the donor leaves it: it is
    // sized so the arrays stay parallel, and its VALUES are the track's own.
    fullReleaseAutoExtend: grown(row.fullReleaseAutoExtend, stepCount, false),
  };
}
