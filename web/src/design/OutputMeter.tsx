import { useEffect, useRef } from "react";
import { HotFrameLayout } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";

/**
 * Canvas output meter — the first hot surface (ARCHITECTURE.md): painted
 * directly from HotFrame in its own rAF loop, never through React state.
 * Peak-hold with decay; clip latch bar at the right edge. Colors/sizes
 * read from token CSS vars at paint time so live theme edits apply.
 *
 * This is the app's ONE output meter (TB-1): it lives on the console's CAPTURE
 * channel, where the level it reads is also the level that gets recorded.
 *
 * Pass `className` to let CSS size it (the console strip is fluid); `widthPx`
 * is the fixed-width form used where the meter sits inline in a row.
 */
export function OutputMeter({
  link,
  widthPx = 160,
  className,
}: {
  link: EngineLink | null;
  widthPx?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !link) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let level = 0; // displayed level with decay
    let holdPeak = 0;
    let holdAge = 0;
    let clip = false;
    let raf = 0;

    const off = link.onHotFrame((frame) => {
      // The louder side, not the left one: a single bar that ignored R would
      // read clean through a one-channel overload.
      const peak = Math.max(
        frame[HotFrameLayout.outputPeakL] ?? 0,
        frame[HotFrameLayout.outputPeakR] ?? 0,
      );
      if (peak > level) level = peak;
      if (peak > holdPeak) {
        holdPeak = peak;
        holdAge = 0;
      }
      clip = (frame[HotFrameLayout.outputClip] ?? 0) > 0.5;
    });

    const css = (name: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();

    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // ~ -60 dB floor, log-ish mapping for a useful visual range.
      const norm = (v: number) =>
        v <= 0.001 ? 0 : Math.min(1, 1 + Math.log10(Math.min(v, 1.412)) / 3);

      const clipZone = 8;
      const barW = w - clipZone - 2;

      ctx.fillStyle = css("--bg-raised");
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = css("--line");
      ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

      const lw = norm(level) * barW;
      ctx.fillStyle = level > 0.999 ? css("--hot") : css("--signal");
      ctx.fillRect(1, 1, lw, h - 2);

      const hx = 1 + norm(holdPeak) * barW;
      if (holdPeak > 0.001) {
        ctx.fillStyle = css("--text");
        ctx.fillRect(hx - 1, 1, 2, h - 2);
      }

      ctx.fillStyle = clip ? css("--hot") : css("--bg");
      ctx.fillRect(w - clipZone, 1, clipZone - 1, h - 2);

      // Decay: display falls ~20 dB/s; peak-hold drops after ~1.5 s.
      level *= 0.93;
      holdAge += 1;
      if (holdAge > 45) holdPeak *= 0.9;

      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);

    return () => {
      cancelAnimationFrame(raf);
      off();
    };
  }, [link]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={className ? undefined : { width: widthPx, height: "var(--slider-bar-h)" }}
    />
  );
}
