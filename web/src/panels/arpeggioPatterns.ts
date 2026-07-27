/**
 * Arpeggio pattern data, ported 1:1 from PaintModeSettingsView.swift
 * (`enum ArpeggioPattern`). Intervals are cumulative semitone offsets from
 * the anchor; linear/random/custom have empty tables (handled specially by
 * the paint engine, which stays Swift-side during view+command mode).
 */
export interface ArpeggioPatternDef {
  id: string;
  displayName: string;
  intervals: number[];
  description: string;
}

export const ARPEGGIO_PATTERNS: ArpeggioPatternDef[] = [
  { id: "custom", displayName: "Custom Preset", intervals: [], description: "Editable interval banks below" },
  { id: "linear", displayName: "Linear", intervals: [], description: "Uses interval setting above" },
  { id: "random", displayName: "Random", intervals: [], description: "Random pitches" },
  { id: "majorTriad", displayName: "Major Triad", intervals: [4, 7, 12, 16, 19, 24], description: "0 +4 +7 +12 +16 +19..." },
  { id: "minorTriad", displayName: "Minor Triad", intervals: [3, 7, 12, 15, 19, 24], description: "0 +3 +7 +12 +15 +19..." },
  { id: "major7", displayName: "Major 7th", intervals: [4, 7, 11, 12, 16, 19, 23, 24], description: "0 +4 +7 +11 +12..." },
  { id: "minor7", displayName: "Minor 7th", intervals: [3, 7, 10, 12, 15, 19, 22, 24], description: "0 +3 +7 +10 +12..." },
  { id: "dominant7", displayName: "Dominant 7th", intervals: [4, 7, 10, 12, 16, 19, 22, 24], description: "0 +4 +7 +10 +12..." },
  { id: "diminished", displayName: "Diminished", intervals: [3, 6, 9, 12, 15, 18, 21, 24], description: "0 +3 +6 +9 +12..." },
  { id: "augmented", displayName: "Augmented", intervals: [4, 8, 12, 16, 20, 24], description: "0 +4 +8 +12..." },
  { id: "sus4", displayName: "Sus4", intervals: [5, 7, 12, 17, 19, 24], description: "0 +5 +7 +12..." },
  { id: "pentatonicMajor", displayName: "Pentatonic Major", intervals: [2, 4, 7, 9, 12, 14, 16, 19, 21, 24], description: "0 +2 +4 +7 +9 +12..." },
  { id: "pentatonicMinor", displayName: "Pentatonic Minor", intervals: [3, 5, 7, 10, 12, 15, 17, 19, 22, 24], description: "0 +3 +5 +7 +10 +12..." },
  { id: "wholeTone", displayName: "Whole Tone", intervals: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24], description: "0 +2 +4 +6 +8 +10..." },
  { id: "chromatic", displayName: "Chromatic", intervals: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], description: "0 +1 +2 +3 +4 +5..." },
  { id: "octaves", displayName: "Octaves", intervals: [12, 24, 36, -12, -24, -36], description: "0 +12 +24 +36..." },
];

export const BANK_COUNT = 4;
export const INTERVALS_PER_BANK = 8;

/** Normalizes the pitchPresetBanks JSON blob to exactly 4×8 numbers. */
export function normalizeBanks(raw: unknown): number[][] {
  const banks: number[][] = [];
  const source = Array.isArray(raw) ? raw : [];
  for (let b = 0; b < BANK_COUNT; b++) {
    const bank = Array.isArray(source[b]) ? (source[b] as unknown[]) : [];
    banks.push(
      Array.from({ length: INTERVALS_PER_BANK }, (_, i) =>
        typeof bank[i] === "number" ? (bank[i] as number) : 0,
      ),
    );
  }
  return banks;
}
