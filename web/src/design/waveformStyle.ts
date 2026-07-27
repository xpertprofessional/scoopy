/**
 * Waveform style — a small design token group (DESIGN-SYSTEM.md §4c), theme
 * data, edited live in Appearance → Waveform and persisted under `theme.tokens`.
 * `panels/waveRender.ts` is the one renderer that consumes it.
 *
 * ONE FORM: the traditional peak/RMS waveform, drawn at ONE DEVICE PIXEL per
 * column. No lobes, no smoothing, no glow, no motion (all tried and cut,
 * 2026-07-12 — the user's call: "something just very precise instead, a
 * traditional waveform, raw, aesthetic… no animation any longer, just pure
 * performance and information"). Everything that remains is either information
 * or the colour it is drawn in.
 *
 * THE TRUTH CONTRACT — the reason a *style* can exist at all:
 *   1. One drawn column = one device pixel. It spans the peak-preserving
 *      max/min of every source column it covers, so a transient can never be
 *      stepped over, and no resolution is claimed that the data doesn't have.
 *   2. Amplitude is linear — (renderGain + volumeOffset) × accent. No display
 *      gamma: a peak's height IS its level.
 *   3. Colour, when it carries the spectrum, carries a real measurement (the
 *      FFT centroid from Swift), never a decorative ramp.
 */

/** `track` = the track's own colour (session identity). `spectrum` = colour BY SOUND. */
export type WaveColorMode = "track" | "spectrum";

/**
 * The spectrum ramp: low → mid → high. Hue carries the **spectral centroid**
 * — where the energy actually sits in the spectrum, measured by FFT in Swift
 * (WaveformCache.brightnessEnvelope) on a LOG frequency scale, because pitch
 * perception is logarithmic.
 *
 * So a cell states two true things at once: **height = level, hue = timbre.**
 * A kick reads deep, a hat reads bright, and a pattern's texture is legible
 * without hearing it.
 */
export interface SpectrumPalette {
  low: string;
  mid: string;
  high: string;
}

/**
 * How two signals sharing a cell composite.
 *
 * `normal` — the later column occludes the earlier one.
 * `screen` — they ADD light, which is what an oscilloscope does and what the
 *   audio itself does: a ghost tail overlapping the next cell's attack is two
 *   sounds summing, and screen is the optically correct way to say so.
 *
 * This is NOT the glow that was cut in 2026-07-12 — glow invents light around a
 * column that has none. Screen only changes how two REAL columns combine, so it
 * adds no information the data doesn't already carry, and it costs one
 * globalCompositeOperation assignment (no shadowBlur, no filter, no per-draw
 * gradient — the three things waveRender's perf contract forbids outright).
 */
export type WaveBlend = "normal" | "screen";

export interface WaveformStyle {
  colorMode: WaveColorMode;
  spectrum: SpectrumPalette;
  /** Peak-to-peak column (the true extremes). */
  peakAlpha: number;
  /** The brighter RMS core inside the peaks — perceived energy vs transient reach. */
  rmsAlpha: number;
  /** The zero line. 0 = off. */
  axisAlpha: number;
  /** Peak resolution fetched per sample (getSamplePeaks clamps 16…1024). */
  points: number;
  /** How overlapping signals combine. See WaveBlend. */
  blend: WaveBlend;
}

/** Deep indigo → cyan → hot magenta: legible on light and dark, and the LOW end
    stays visible (a black low end would hide bass-heavy material on a dark grid). */
export const DEFAULT_SPECTRUM: SpectrumPalette = {
  low: "#3d5afe",
  mid: "#18ffd5",
  high: "#ff4fd8",
};

export const DEFAULT_WAVEFORM: WaveformStyle = {
  colorMode: "track",
  spectrum: DEFAULT_SPECTRUM,
  peakAlpha: 0.55,
  rmsAlpha: 1,
  axisAlpha: 0.12,
  points: 1024,
  blend: "normal",
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Range-clamps a stored/edited style so a bad value can't wedge the canvas. */
export function normalizeWaveform(s: WaveformStyle): WaveformStyle {
  return {
    colorMode: s.colorMode === "spectrum" ? "spectrum" : "track",
    spectrum: { ...DEFAULT_SPECTRUM, ...(s.spectrum ?? {}) },
    peakAlpha: clamp(s.peakAlpha, 0, 1),
    rmsAlpha: clamp(s.rmsAlpha, 0, 1),
    axisAlpha: clamp(s.axisAlpha, 0, 1),
    points: Math.round(clamp(s.points, 64, 1024)),
    blend: s.blend === "screen" ? "screen" : "normal",
  };
}
