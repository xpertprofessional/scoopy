import { currentTokens } from "../design/tokens.ts";
import {
  DEFAULT_WAVEFORM,
  type SpectrumPalette,
  type WaveformStyle,
} from "../design/waveformStyle.ts";

/**
 * THE waveform renderer — every cell waveform in the web UI comes through here.
 *
 * ONE FORM, the traditional one: for each DEVICE PIXEL column, a vertical line
 * from the true minimum to the true maximum of the audio under it, with a
 * brighter RMS core inside it. That is the whole drawing. It is the most
 * precise thing a pixel column can say (one column = one pixel = no invented
 * resolution), the fastest (one fillRect per column, no paths, no curves), and
 * the classic look.
 *
 * Drawn in DEVICE-PIXEL space (transform reset) so every column edge is
 * integer-crisp — sub-pixel blur is what makes a 1px waveform look like mud.
 *
 * PERF — never add: ctx.shadowBlur / ctx.filter (offscreen compositing pass per
 * cell), per-draw gradients (allocation per cell), bitmap tiles (tens of MB).
 * Those, not the geometry, are what kill a 1024-cell canvas.
 */

export type Peaks = {
  minMax: number[];
  rms: number[];
  /** Spectral centroid per column, 0…1. Empty unless a spectrum style asked. */
  brightness?: number[];
};

/**
 * Peaks are cached per (sample × resolution × spectrum) — each is a different
 * payload from Swift. `spectrum` is part of the key because the brightness
 * envelope is opt-in: without it in the key, turning spectrum colour ON would
 * hit the cached non-spectral entry and silently paint every cell one colour.
 */
export function peaksKey(sampleKey: string, points: number, spectrum = false): string {
  return `${sampleKey}#${points}${spectrum ? "#s" : ""}`;
}

export interface WaveDrawOpts {
  /** Audio window inside the sample, 0..1 of its duration. */
  startFrac: number;
  endFrac: number;
  reversed: boolean;
  /** Track colour — used unless the style colours by spectrum. */
  color: string;
  /** Per-step amplitude (renderGain + volumeOffset) × accent. */
  gain?: number;
  /** OWN audible tail past the cell — same data, low presence. */
  ghost?: boolean;
  /** Track presence (muted / solo-shadowed). */
  presence?: number;
}

/** Per-drawn-column aggregate of the true peak data. */
export interface WaveColumns {
  /** Signed maxima (positive lobe). */
  mx: Float32Array;
  /** Signed minima (negative lobe). */
  mn: Float32Array;
  rms: Float32Array;
  /** Spectral centroid 0…1 (all zeros when the sample carries no brightness). */
  br: Float32Array;
  n: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Drawn columns for a window of the peak array.
 *
 * TRUTH RULE 1 — peak-preserving: when a drawn column covers MORE than one
 * source column, it takes the max/min over every one it covers (mean over RMS).
 * It never samples one and skips the rest, so a transient between two sample
 * points cannot vanish. When it covers fewer, columns repeat source data rather
 * than inventing it.
 */
export function aggregateColumns(
  pk: Peaks,
  startFrac: number,
  endFrac: number,
  reversed: boolean,
  n: number,
): WaveColumns {
  const columns = pk.minMax.length / 2;
  const c0 = Math.floor(clamp01(startFrac) * columns);
  const c1 = Math.max(c0 + 1, Math.ceil(clamp01(endFrac) * columns));
  const span = c1 - c0;
  const mx = new Float32Array(n);
  const mn = new Float32Array(n);
  const rms = new Float32Array(n);
  const br = new Float32Array(n);
  const noRms = pk.rms.length === 0;
  const bright = pk.brightness;
  for (let b = 0; b < n; b++) {
    const ci = c0 + Math.floor((b / n) * span);
    const cj = Math.max(ci + 1, c0 + Math.ceil(((b + 1) / n) * span));
    let hi = 0;
    let lo = 0;
    let r = 0;
    let cnt = 0;
    let brW = 0;
    let brSum = 0;
    for (let k = ci; k < cj; k++) {
      // Reverse mirrors the column index INSIDE the window (the sample plays
      // backwards; the window itself doesn't move).
      const col = reversed ? c1 - 1 - (k - c0) : k;
      const vMin = pk.minMax[col * 2] ?? 0;
      const vMax = pk.minMax[col * 2 + 1] ?? 0;
      if (vMax > hi) hi = vMax;
      if (vMin < lo) lo = vMin;
      const level = Math.abs(pk.rms[col] ?? 0);
      r += level;
      cnt++;
      if (bright) {
        // AMPLITUDE-WEIGHTED: a near-silent column has no meaningful centroid,
        // and a flat mean would let the silence between hits drag every colour
        // dark and wash the cell out. The audible part decides the hue.
        const w = Math.max(level, Math.max(vMax, -vMin) * 0.25);
        brSum += (bright[col] ?? 0) * w;
        brW += w;
      }
    }
    mx[b] = hi;
    mn[b] = lo;
    // Legacy peaks without an RMS array: derive a body from the peak so the
    // cell still reads as signal rather than going flat.
    rms[b] = noRms ? Math.max(hi, -lo) * 0.55 : cnt ? r / cnt : 0;
    br[b] = brW > 1e-9 ? brSum / brW : 0;
  }
  return { mx, mn, rms, br, n };
}

/** "#rgb"/"#rrggbb" → [r,g,b]. Falls back to mid-grey on anything unparseable. */
function parseHex(hex: string): [number, number, number] {
  const h = hex.trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const v = parseInt(full.slice(0, 6), 16);
  if (!Number.isFinite(v) || full.length < 6) return [128, 128, 128];
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/**
 * Spectral centroid (0…1) → colour, low → mid → high. Interpolated in plain
 * sRGB: the ramp is short and its endpoints are far apart, so a perceptual
 * space buys nothing the eye can see here.
 */
export function spectrumColor(t: number, palette: SpectrumPalette): string {
  const x = clamp01(t);
  const [aR, aG, aB] = parseHex(x < 0.5 ? palette.low : palette.mid);
  const [bR, bG, bB] = parseHex(x < 0.5 ? palette.mid : palette.high);
  const f = x < 0.5 ? x * 2 : (x - 0.5) * 2;
  const mix = (a: number, b: number) => Math.round(a + (b - a) * f);
  return `rgb(${mix(aR, bR)}, ${mix(aG, bG)}, ${mix(aB, bB)})`;
}

/**
 * Spectrum colour is quantized into buckets so consecutive columns of similar
 * timbre share one fillStyle. The eye cannot resolve finer hue steps on a 1px
 * column, and a fillStyle change per column would be the single most expensive
 * thing this renderer does at 1024 cells.
 */
const SPECTRUM_BUCKETS = 24;

/** One segment of one cell's waveform. */
export function drawWave(
  ctx: CanvasRenderingContext2D,
  pk: Peaks,
  rect: { x: number; y: number; w: number; h: number },
  opts: WaveDrawOpts,
  style: WaveformStyle = DEFAULT_WAVEFORM,
): void {
  const sourceColumns = pk.minMax.length / 2;
  if (sourceColumns < 2 || rect.w < 1 || rect.h < 4) return;
  const gain = opts.gain ?? 1;
  const dim = (opts.ghost ? currentTokens().surface.ghostTailAlpha : 1) * (opts.presence ?? 1);

  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0); // device pixels → crisp integer edges
  // Overlapping signals ADD light rather than occluding (see WaveBlend). Set
  // inside the save()/restore() so it can never leak into the affordance marks
  // the caller draws afterwards — a screened annotation would be a lie.
  if (style.blend === "screen") ctx.globalCompositeOperation = "screen";

  const L = Math.round(rect.x * dpr);
  const midY = Math.round((rect.y + rect.h / 2) * dpr);
  const amp = Math.max(1, Math.round((rect.h / 2 - 1) * dpr));
  // ONE COLUMN PER DEVICE PIXEL: maximum honest precision, and the reason this
  // needs no pitch/density dial at all.
  const n = Math.max(1, Math.round(rect.w * dpr));
  const cols = aggregateColumns(pk, opts.startFrac, opts.endFrac, opts.reversed, n);

  const spectrum = style.colorMode === "spectrum" && pk.brightness !== undefined;
  const baseColor = opts.color;

  if (style.axisAlpha > 0.001) {
    ctx.fillStyle = baseColor;
    ctx.globalAlpha = style.axisAlpha * dim;
    ctx.fillRect(L, midY, n, 1);
  }

  // Column heights, pre-computed so the two passes don't recompute them.
  const hUp = new Int32Array(n);
  const hDn = new Int32Array(n);
  const hRms = new Int32Array(n);
  for (let b = 0; b < n; b++) {
    const up = Math.min(1, cols.mx[b]! * gain);
    const dn = Math.min(1, -cols.mn[b]! * gain);
    const r = Math.min(1, cols.rms[b]! * gain);
    // A quiet-but-present column keeps a 1px mark: silence and "very quiet"
    // must never look identical.
    hUp[b] = cols.mx[b]! > 0.0008 ? Math.max(1, Math.round(up * amp)) : 0;
    hDn[b] = -cols.mn[b]! > 0.0008 ? Math.max(1, Math.round(dn * amp)) : 0;
    hRms[b] = Math.round(r * amp);
  }

  // Pass 1: peak-to-peak (the true extremes — transient reach).
  // Pass 2: the RMS core, brighter (perceived energy).
  //
  // Colour is set per RUN of columns sharing a bucket, not per column: with a
  // single track colour that is exactly one fillStyle for the whole cell.
  for (const pass of [0, 1] as const) {
    const alpha = (pass === 0 ? style.peakAlpha : style.rmsAlpha) * dim;
    if (alpha <= 0.001) continue;
    ctx.globalAlpha = alpha;
    let bucket = -1;
    if (!spectrum) ctx.fillStyle = baseColor;
    for (let b = 0; b < n; b++) {
      if (spectrum) {
        const bk = Math.min(SPECTRUM_BUCKETS - 1, Math.floor(cols.br[b]! * SPECTRUM_BUCKETS));
        if (bk !== bucket) {
          bucket = bk;
          ctx.fillStyle = spectrumColor((bk + 0.5) / SPECTRUM_BUCKETS, style.spectrum);
        }
      }
      if (pass === 0) {
        const up = hUp[b]!;
        const dn = hDn[b]!;
        if (up + dn <= 0) continue;
        ctx.fillRect(L + b, midY - up, 1, up + dn || 1);
      } else {
        const r = hRms[b]!;
        if (r <= 0) continue;
        ctx.fillRect(L + b, midY - r, 1, r * 2);
      }
    }
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}
