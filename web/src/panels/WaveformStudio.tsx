import { useEffect, useMemo, useRef, useState } from "react";
import type { EngineLink } from "../engineLink.ts";
import { type WaveColorMode, type WaveformStyle } from "../design/waveformStyle.ts";
import { Caption, FieldRow, ParamRow, SectionTitle, Select } from "../design/controls.tsx";
import { currentTokens, type DesignTokens } from "../design/tokens.ts";
import { drawWave, type Peaks } from "./waveRender.ts";
import { COMMANDS } from "../../protocol/schema.ts";

/**
 * Waveform settings (Appearance → Waveform).
 *
 * Small on purpose. There is ONE waveform — the traditional peak/RMS one, at a
 * device pixel per column — so the only real choices are what colour it carries
 * and how much detail it fetches. The preview draws the SAME renderer the grid
 * uses, over REAL peaks, at three cell widths, and reports what the chosen
 * detail costs a full 1024-cell grid.
 */

/** Cell widths the preview renders side by side (CSS px, real grid geometry). */
const PREVIEW_WIDTHS = [44, 88, 190];
const PREVIEW_H = 58;
/** Worst-case grid the perf estimate extrapolates to (grid.md §6: 16 × 64). */
const WORST_CASE_CELLS = 1024;

/** Fallback when no track has a sample: a decaying hit, brighter at the transient. */
function demoPeaks(points: number): Peaks {
  const minMax: number[] = [];
  const rms: number[] = [];
  const brightness: number[] = [];
  for (let i = 0; i < points; i++) {
    const t = i / points;
    const env = Math.exp(-3.2 * t) * (1 - Math.exp(-90 * t));
    // Deterministic pseudo-noise: the preview must not shimmer between redraws.
    const osc = Math.sin(t * 128) * 0.55 + Math.sin(t * 311 + 1.7) * 0.3 + Math.sin(t * 47) * 0.15;
    const v = env * osc;
    minMax.push(Math.min(0, v * 1.05), Math.max(0, v));
    rms.push(env * 0.42);
    // A real hit is bright at the transient and darkens as it decays; the
    // synthetic preview must too, or spectrum mode would preview as one flat
    // colour and teach you nothing about the palette.
    brightness.push(Math.max(0, 0.85 * Math.exp(-6 * t) + 0.12));
  }
  return { minMax, rms, brightness };
}

export function WaveformStudio({
  link,
  tokens,
  update,
}: {
  link: EngineLink | null;
  tokens: DesignTokens;
  update: (next: DesignTokens) => void;
}) {
  const style = tokens.waveform;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [real, setReal] = useState<Peaks | null>(null);
  const [costMs, setCostMs] = useState<number | null>(null);

  const setStyle = (patch: Partial<WaveformStyle>) =>
    update({ ...tokens, waveform: { ...style, ...patch } });

  const fallback = useMemo(() => demoPeaks(style.points), [style.points]);
  const peaks = real ?? fallback;
  const color = tokens.dataPalette[0] ?? tokens.chrome.accent;
  const spectrum = style.colorMode === "spectrum";

  // Real peaks at the CURRENT detail — the preview must show what is being
  // tuned, and must ask for brightness exactly when the style paints with it.
  useEffect(() => {
    if (!link) return;
    let cancelled = false;
    (async () => {
      for (let i = 0; i < 8; i++) {
        try {
          const raw = await link.command("getSamplePeaks", {
            trackIndex: i,
            points: style.points,
            spectrum,
          });
          const parsed = COMMANDS.getSamplePeaks.result.parse(raw);
          if (parsed.sampleKey && parsed.minMax.length >= 4) {
            if (!cancelled) {
              setReal({
                minMax: parsed.minMax,
                rms: parsed.rms,
                brightness: spectrum ? parsed.brightness : undefined,
              });
            }
            return;
          }
        } catch {
          // no sample on that track — keep looking
        }
      }
      if (!cancelled) setReal(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [link, style.points, spectrum]);

  // Static preview: it repaints when the style changes, not on a rAF loop —
  // nothing here moves.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const t0 = performance.now();
    let x = 0;
    for (const cw of PREVIEW_WIDTHS) {
      const rect = { x, y: 2, w: cw, h: PREVIEW_H - 4 };
      ctx.fillStyle = color;
      // The preview IS a grid cell — it must use the cell's own tint token, or it
      // stops being a preview of anything.
      ctx.globalAlpha = currentTokens().surface.cellTintAlpha;
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.globalAlpha = 1;
      drawWave(
        ctx,
        peaks,
        { x: rect.x + 1, y: rect.y + 2, w: rect.w - 2, h: rect.h - 4 },
        { startFrac: 0, endFrac: 0.92, reversed: false, color },
        style,
      );
      x += cw + 8;
    }
    // Extrapolate the three preview cells to the worst-case grid. Rough by
    // construction (real cells vary in width) — it exists to make an expensive
    // setting VISIBLE while you choose it, not to certify a build.
    const perCell = (performance.now() - t0) / PREVIEW_WIDTHS.length;
    setCostMs(perCell * WORST_CASE_CELLS);
  }, [peaks, style, color]);

  return (
    <>
      <SectionTitle>Waveform</SectionTitle>
      <Caption>
        {real
          ? "Live preview on a real sample, at three cell widths."
          : "No sample loaded — previewing a synthetic hit. Load a sample to tune against real audio."}{" "}
        One device pixel per column: the peak-to-peak extremes, with the RMS core
        inside them. Nothing is smoothed, interpolated or animated.
      </Caption>
      <canvas ref={canvasRef} className="wave-preview" height={PREVIEW_H} />
      <FieldRow label="Est. full-grid redraw">
        <span className="dim role-hint">
          {costMs === null
            ? "…"
            : `≈${costMs.toFixed(1)} ms for ${WORST_CASE_CELLS} cells (budget 8 ms)`}
        </span>
      </FieldRow>

      <FieldRow label="Colour by">
        <Select
          value={style.colorMode}
          options={[
            { value: "track", label: "Track colour" },
            { value: "spectrum", label: "Spectrum (timbre)" },
          ]}
          onChange={(v) => setStyle({ colorMode: v as WaveColorMode })}
        />
      </FieldRow>
      {spectrum && (
        <>
          <Caption>
            Hue = where the energy actually sits in the spectrum (FFT centroid,
            log scale). Height stays level, hue becomes timbre — a kick reads
            deep, a hat reads bright.
          </Caption>
          {(["low", "mid", "high"] as const).map((k) => (
            <FieldRow key={k} label={k === "low" ? "Low" : k === "mid" ? "Mid" : "High"}>
              <span className="dim role-hint">
                {k === "low" ? "bass / dark" : k === "mid" ? "body" : "air / transients"}
              </span>
              <input
                type="color"
                className="color-swatch"
                value={style.spectrum[k]}
                onChange={(e) => setStyle({ spectrum: { ...style.spectrum, [k]: e.target.value } })}
              />
            </FieldRow>
          ))}
        </>
      )}
      <ParamRow
        label="Peaks"
        value={style.peakAlpha}
        display={style.peakAlpha.toFixed(2)}
        min={0}
        max={1}
        step={0.05}
        onChange={(v) => setStyle({ peakAlpha: v })}
      />
      <ParamRow
        label="RMS core"
        value={style.rmsAlpha}
        display={style.rmsAlpha === 0 ? "off" : style.rmsAlpha.toFixed(2)}
        min={0}
        max={1}
        step={0.05}
        onChange={(v) => setStyle({ rmsAlpha: v })}
      />
      <ParamRow
        label="Zero line"
        value={style.axisAlpha}
        display={style.axisAlpha === 0 ? "off" : style.axisAlpha.toFixed(2)}
        min={0}
        max={1}
        step={0.02}
        onChange={(v) => setStyle({ axisAlpha: v })}
      />
      <ParamRow
        label="Detail"
        value={style.points}
        display={`${style.points} pts`}
        min={64}
        max={1024}
        step={64}
        onChange={(v) => setStyle({ points: Math.round(v) })}
      />
    </>
  );
}
