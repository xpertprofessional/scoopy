import type { GridTrackState } from "../../protocol/schema.ts";
import { deriveTrackState } from "./deriveTrackState.ts";

/**
 * Track-row control math + display formatters — pure ports of the Swift
 * display/scale logic (trackrow.md §8.2, sourced from ContentView.swift).
 * Kept separate from the React components so they can be fixture-tested
 * against the native formatting.
 */

// --- Track colour palette --------------------------------------------------
// Mirror of `BeatSequencer.palette` (BeatSequencer.swift) — the 8 identity
// colours the native ColorPickerBox cycled through. Kept here (a native data
// mirror, like RATIO_TABLE) so the compose-view swatch offers the same set;
// `setColor` accepts any #RRGGBB, so this is the menu, not a constraint.
export const TRACK_PALETTE: ReadonlyArray<{ name: string; hex: string }> = [
  { name: "Red", hex: "#ED5252" },
  { name: "Orange", hex: "#ED8F52" },
  { name: "Yellow", hex: "#EDCC52" },
  { name: "Lime", hex: "#99D952" },
  { name: "Teal", hex: "#52D9BA" },
  { name: "Blue", hex: "#528FED" },
  { name: "Violet", hex: "#8F52ED" },
  { name: "Magenta", hex: "#CC52ED" },
];

// --- Volume: internal 0…2, display 0–120 (default 80), non-linear slider ----
// Track.volumeToDisplay: v<=1 → v*80 ; v>1 → 80+(v-1)*40   (ContentView :5255)
export function volumeToDisplay(v: number): number {
  return v <= 1 ? v * 80 : 80 + (v - 1) * 40;
}
// Track.volumeToSliderFraction: breakpoint 2/3 (lower ⅔ = 0–80, top ⅓ = 80–120)
const VOL_BP = 2 / 3;
export function volumeToSliderFraction(v: number): number {
  return v <= 1 ? v * VOL_BP : VOL_BP + (v - 1) * (1 - VOL_BP);
}
export function sliderFractionToVolume(p: number): number {
  return p <= VOL_BP ? p / VOL_BP : 1 + (p - VOL_BP) / (1 - VOL_BP);
}
export function formatVolume(v: number): string {
  return String(Math.round(volumeToDisplay(v)));
}

// --- Gain: pre-clipper drive 0…2, %.2f (e.g. "1.27") ------------------------
export function formatGain(g: number): string {
  return g.toFixed(2);
}

// --- Pan: −1…1 → C / L## / R## ----------------------------------------------
export function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.01) return "C";
  return pan > 0 ? `R${Math.round(pan * 100)}` : `L${Math.round(-pan * 100)}`;
}

// --- Pitch: offset in quarter-tones (±96) + cents (±50), display semitones --
// displayPitchString (ContentView :5423): cents≠0 → %+.1f semis; whole → %+.0f;
// quarter-tone → %+.1f. (Active fine-tuning %+.2f case omitted — no live cents edit yet.)
export function pitchSemitones(offsetQuarterTones: number, cents: number): number {
  return offsetQuarterTones / 2 + cents / 100;
}
export function formatPitch(offsetQuarterTones: number, cents: number): string {
  const semis = pitchSemitones(offsetQuarterTones, cents);
  const sign = semis > 0 ? "+" : semis < 0 ? "" : "+"; // 0 → "+0"
  if (cents !== 0) return `${sign}${semis.toFixed(1)}`;
  if (offsetQuarterTones % 2 === 0) return `${sign}${semis.toFixed(0)}`;
  return `${sign}${semis.toFixed(1)}`;
}

// --- Tone / filter ----------------------------------------------------------
export function toneModeLabel(mode: string): string {
  switch (mode) {
    case "lowPass":
      return "LP";
    case "highPass":
      return "HP";
    case "bandPass":
      return "BP";
    case "notch":
      return "NO";
    default:
      return "TONE";
  }
}
export function formatTone(tone: number, mode: string): string {
  return mode === "tone" ? String(Math.round(tone)) : String(Math.round(Math.abs(tone)));
}

// --- Sends: 0…1 → 0…100 -----------------------------------------------------
export function formatSend(level: number): string {
  return String(Math.round(level * 100));
}

// --- Choke / voice / stereo labels ------------------------------------------
export function formatChoke(group: number): string {
  return group <= 0 ? "OFF" : String(group);
}
// Native shortLabel = single letter (M/P) — disambiguates from the stereo box
// (which reads MONO/STEREO/L/R) and keeps the tight DSP row compact.
export function voiceLabel(mode: string): string {
  return mode === "poly" ? "P" : "M";
}
export function stereoLabel(mode: number): string {
  return ["MONO", "STEREO", "L", "R"][mode] ?? "MONO";
}
// Per-track hard output routing (native `outputAssign` 0/1/2). 0 = follow pan
// (off); 1/2 = mono-sum straight onto physical output 1/2, ignoring pan. Compact
// label for the compose voice-architecture cluster.
export function outputAssignLabel(assign: number): string {
  return assign === 1 ? "OUT 1" : assign === 2 ? "OUT 2" : "OUT";
}

// --- R1 cell-tools + pattern (native display formats) -----------------------
/** Accent selector: count of accented cells → "»N" (else "Ac"). */
export function accentToolLabel(accentLevels: number[]): string {
  const n = accentLevels.filter((a) => a > 0).length;
  return n > 0 ? `»${n}` : "Ac";
}
/** Glide selector: count of glide cells → "↝N" (else "Gl"). */
export function glideToolLabel(glideSteps: boolean[]): string {
  const n = glideSteps.filter(Boolean).length;
  return n > 0 ? `↝${n}` : "Gl";
}
/** Flam selector: count of cells with flam>1 → "×N" (else "Fl"). */
export function flamToolLabel(flamCounts: number[]): string {
  const n = flamCounts.filter((f) => f > 1).length;
  return n > 0 ? `×${n}` : "Fl";
}
/** Chop selector: count of cells with an explicit chop (≥0) → "#N" (else "Ch"). */
export function chopToolLabel(cellChopIndices: number[]): string {
  const n = cellChopIndices.filter((c) => c >= 0).length;
  return n > 0 ? `#${n}` : "Ch";
}
/** Chord selector: count of cells carrying a chord (>0) → "♭N" (else "Ch♭"). */
export function chordToolLabel(chordIndices: number[]): string {
  const n = chordIndices.filter((c) => c > 0).length;
  return n > 0 ? `♪${n}` : "Chd";
}
/** Glide length percent: "%" when 0, else "NN%". */
export function formatGlidePercent(pct: number): string {
  return pct === 0 ? "%" : `${Math.round(pct)}%`;
}
/** Swing: 0…100 integer (amount is 0…1). */
export function formatSwing(amount: number): string {
  return String(Math.round(amount * 100));
}
/** Speed ratio stepper label passthrough ("1:4"…"4:1"). */
export function speedRatioLabel(label: string): string {
  return label || "1:1";
}
/** Stretch quality: T (time-only) / T+P. */
export function stretchQualityLabel(timeOnly: boolean): string {
  return timeOnly ? "T" : "T+P";
}

// --- Free-rate tape (native FreeRateTapeSlider port, ContentView :145-167) ---
// Log magnitude domain per side; center 0.5 = tape stop. maxMag caps the
// SLIDER at 16× (the box still reaches ±64); rates beyond ±16 pin the ends.
const FR_MIN_MAG = 0.05;
const FR_MAX_MAG = 16.0;
const FR_LOG_SPAN = Math.log(FR_MAX_MAG / FR_MIN_MAG);
/** signed rate → slider position [0,1] (0.5 = centre / ~0). */
export function freeRatePct(rate: number): number {
  const mag = Math.min(FR_MAX_MAG, Math.max(FR_MIN_MAG, Math.abs(rate)));
  const u = Math.log(mag / FR_MIN_MAG) / FR_LOG_SPAN;
  return rate >= 0 ? 0.5 + 0.5 * u : 0.5 - 0.5 * u;
}
/** slider position [0,1] → signed rate. */
export function freeRateFromPct(pct: number): number {
  const p = Math.max(0, Math.min(1, pct));
  const u = Math.abs(p - 0.5) / 0.5;
  if (u < 0.0005) return 0; // dead centre = tape stop
  const mag = FR_MIN_MAG * Math.pow(FR_MAX_MAG / FR_MIN_MAG, u);
  return p >= 0.5 ? mag : -mag;
}
/** Signed tape label: ◀ reverse / ▶ forward, ×%.2f under 9.95 else ×%.0f. */
export function freeRateLabel(rate: number): string {
  const mag = Math.abs(rate);
  const arrow = rate < 0 ? "◀" : "▶";
  return mag < 9.95 ? `${arrow}×${mag.toFixed(2)}` : `${arrow}×${mag.toFixed(0)}`;
}

// --- Unified rate (TR-FT-9): one slider drives multiply detents + free rate --
// Engine model (NativeAudioEngineCore :3888-3892): effective pattern-read
// speed = speedMultiplier × freeRate, so the slider value decomposes into
// EITHER a bar-locked detent (speedMultiplier = detent, freeRate = 1) OR a
// free tape rate (freeRate = value, speedMultiplier = 1) — the product always
// equals the slider value. Detents = SpeedRatioTiming.orderedRatios.
// TR-FT-14 detent table: classic ratios + polyrhythmic feels (3:4 / 5:4 /
// 7:4 / 5:2) + high multiples up to the tape slider's 16× cap. Mirror of
// SpeedRatioTiming.ratioTable (Track.swift) — keep both in sync.
const RATIO_TABLE: readonly { ratio: number; name: string }[] = [
  { ratio: 0.25, name: "1:4" },
  { ratio: 1 / 3, name: "1:3" },
  { ratio: 0.5, name: "1:2" },
  { ratio: 2 / 3, name: "2:3" },
  { ratio: 0.75, name: "3:4" },
  { ratio: 1, name: "1:1" },
  { ratio: 1.25, name: "5:4" },
  { ratio: 1.5, name: "3:2" },
  { ratio: 1.75, name: "7:4" },
  { ratio: 2, name: "2:1" },
  { ratio: 2.5, name: "5:2" },
  { ratio: 3, name: "3:1" },
  { ratio: 4, name: "4:1" },
  { ratio: 6, name: "6:1" },
  { ratio: 8, name: "8:1" },
  { ratio: 12, name: "12:1" },
  { ratio: 16, name: "16:1" },
];
export const SPEED_RATIOS: readonly number[] = RATIO_TABLE.map((e) => e.ratio);
/** Port of SpeedRatioTiming.ratioLabel (nearest detent's name). */
export function speedRatioName(mult: number): string {
  let best = "1:1";
  let bestD = Infinity;
  for (const e of RATIO_TABLE) {
    const d = Math.abs(mult - e.ratio);
    if (d < bestD) {
      bestD = d;
      best = e.name;
    }
  }
  return best;
}
/**
 * Nearest SIGNED detent by slider-position (log tape) distance. The ratios
 * mirror onto the reverse side (negative = pattern plays backwards at that
 * ratio, via the absolute playbackDirection — the bar-locked cousin of a
 * negative freeRate: the engine XORs direction into grain reversal exactly
 * like freeReverse, NativeAudioEngineCore :4493).
 */
export function nearestSpeedRatio(rate: number): number {
  const p = freeRatePct(rate);
  let best = 1;
  let bestD = Infinity;
  for (const r of SPEED_RATIOS) {
    for (const s of [r, -r]) {
      const d = Math.abs(freeRatePct(s) - p);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
  }
  return best;
}
/** The mirrored detents in TAPE ORDER (reverse 16:1 … 1:4 · 1:4 … 16:1). */
export const SIGNED_SPEED_RATIOS: readonly number[] = [
  ...[...SPEED_RATIOS].reverse().map((r) => -r),
  ...SPEED_RATIOS,
];
/**
 * Walk ONE detent along the tape (ö/ä on the rate box, and the ratio keyboard
 * step generally). A value step is useless here: the detents are log-spaced, so
 * a fixed +0.05 lands back inside the SAME detent's snap zone above ~2× and the
 * write early-outs — the keyboard has to move by INDEX, like the ear does.
 * Ends pin (no wrap); crossing the centre flips to the mirrored (backwards) side.
 */
export function stepSpeedRatio(rate: number, dir: number): number {
  const cur = nearestSpeedRatio(rate);
  const idx = SIGNED_SPEED_RATIOS.indexOf(cur);
  const next = Math.max(
    0,
    Math.min(SIGNED_SPEED_RATIOS.length - 1, idx + (dir > 0 ? 1 : -1)),
  );
  return SIGNED_SPEED_RATIOS[next] ?? cur;
}
/** Effective signed read rate shown by the unified slider (engine product;
    direction contributes the sign in the detent domain). */
export function unifiedRate(
  speedMultiplier: number,
  freeRate: number,
  backward = false,
): number {
  return speedMultiplier * freeRate * (backward ? -1 : 1);
}
/** Detent domain (freeRate disengaged) shows the ratio (◀-prefixed when the
    pattern runs backwards); free shows the tape label. */
export function unifiedRateLabel(
  speedMultiplier: number,
  freeRate: number,
  backward = false,
): string {
  if (freeRate === 1) {
    const name = speedRatioName(speedMultiplier);
    return backward ? `◀${name}` : name;
  }
  return freeRateLabel(unifiedRate(speedMultiplier, freeRate, backward));
}

// --- Optimistic-echo reducers (grid feel pattern): apply an edit to the -----
// local render state instantly; the authoritative gridPattern/<i> push overwrites
// ~35 ms later. Pure — return a new track object.
export function withField<K extends keyof GridTrackState>(
  t: GridTrackState,
  key: K,
  value: GridTrackState[K],
): GridTrackState {
  // RE-DERIVE, don't just copy.
  //
  // `renderGain` and `chopPointsMs` are computed from other fields (P5-06 step B) rather than
  // pushed. Setting `gain` with a plain spread leaves the OLD renderGain in place, so the
  // waveform keeps drawing at the previous amplitude for the whole drag and only snaps when
  // Swift's push lands — the box moves, the waveform doesn't, and the row feels broken.
  //
  // This was invisible before step B only because Swift pushed `renderGain` itself; the
  // optimistic echo was equally stale, it just had nothing to be stale ABOUT locally.
  return deriveTrackState({ ...t, [key]: value });
}
