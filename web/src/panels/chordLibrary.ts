/**
 * Chord library mirror (TR-4f) — display side ONLY.
 *
 * The authoritative library is Swift (`ScoopyLoops/ChordLibrary.swift`): it
 * resolves an index to its interval stack before streaming to the native
 * engine. A cell stores an INDEX into that table (0 = OFF), and the web only
 * ever moves that index (via the existing `adjustParameter` op with
 * `mode: "chord"` — Swift's `adjustStepParameter` .chord clamps the range).
 *
 * ⚠️ THAT CHANGED IN THE BROWSER (P8-10a). The companion has no Swift, so nothing
 * else can resolve an index into a voicing — this file now carries the INTERVALS
 * too, and `packedIntervals()` is what the WASM engine is actually fed. A drift
 * between this table and `ChordLibrary.swift` is therefore no longer a mislabel;
 * it is a WRONG CHORD, played.
 *
 * So the mirror is no longer pinned by hand: `chordLibrary.test.ts` PARSES
 * `ScoopyLoops/ChordLibrary.swift` and fails if a single interval differs. Append an
 * entry in Swift and the test tells you to append it here. Entries are append-only
 * on the Swift side (indices persist in sessions).
 */

/** In-cell / chip labels, index-aligned with `ChordLibrary.entries`. */
export const CHORD_SHORT_LABELS = [
  "", // 0 = Off
  "OCT",
  "5TH",
  "OC5",
  "MIN",
  "MAJ",
  "SU2",
  "SU4",
  "DIM",
  "M7",
  "MA7",
  "DM7",
  "AD9",
] as const;

/** Menu / tooltip names, index-aligned with `ChordLibrary.entries`. */
export const CHORD_NAMES = [
  "Off",
  "Octave",
  "Fifth",
  "Fifth+Oct",
  "Minor",
  "Major",
  "Sus2",
  "Sus4",
  "Dim",
  "Minor 7",
  "Major 7",
  "Dom 7",
  "Add 9",
] as const;

export const CHORD_COUNT = CHORD_SHORT_LABELS.length;

/** In-cell label for a stored chord index ("" for OFF or out-of-range). */
export function chordShortLabel(index: number): string {
  if (index <= 0 || index >= CHORD_COUNT) return "";
  return CHORD_SHORT_LABELS[index]!;
}

/** Long name for a stored chord index ("Off" for OFF or out-of-range). */
export function chordName(index: number): string {
  if (index <= 0 || index >= CHORD_COUNT) return "Off";
  return CHORD_NAMES[index]!;
}

/**
 * Semitones above the root, index-aligned with `ChordLibrary.entries` (`ChordLibrary.swift:19`).
 * Never contains 0 — the root is the note itself — and never more than `MAX_CHORD_NOTES - 1`.
 */
export const CHORD_INTERVALS: readonly (readonly number[])[] = [
  [], // 0 = Off
  [12], // Octave
  [7], // Fifth
  [7, 12], // Fifth+Oct
  [3, 7], // Minor
  [4, 7], // Major
  [2, 7], // Sus2
  [5, 7], // Sus4
  [3, 6], // Dim
  [3, 7, 10], // Minor 7
  [4, 7, 11], // Major 7
  [4, 7, 10], // Dom 7
  [4, 7, 14], // Add 9
];

/** `kMaxChordNotes` — ChordLibrary.swift:5. The root plus up to three added voices. */
export const MAX_CHORD_NOTES = 4;

/**
 * Per-step chord indices → the flat interval array the engine wants: `MAX_CHORD_NOTES - 1` slots
 * per step, zero-padded. An exact mirror of `ChordLibrary.packedIntervals` (ChordLibrary.swift:46).
 *
 * Index 0 (OFF) and any out-of-range index leave their slots at 0, which the engine reads as "no
 * added voices" — so an unknown chord plays the root alone rather than a wrong voicing.
 */
export function packedIntervals(chordIndices: readonly number[]): number[] {
  const slots = MAX_CHORD_NOTES - 1;
  const packed = new Array<number>(chordIndices.length * slots).fill(0);
  chordIndices.forEach((index, step) => {
    if (index <= 0 || index >= CHORD_INTERVALS.length) return;
    const intervals = CHORD_INTERVALS[index]!;
    for (let k = 0; k < Math.min(slots, intervals.length); k++) {
      packed[step * slots + k] = intervals[k]!;
    }
  });
  return packed;
}
