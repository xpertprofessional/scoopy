import { useEffect, useRef } from "react";
import { HotFrameLayout } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";

/**
 * Audio CPU load — peak per-callback work against the audio deadline, painted
 * from the HotFrame in its own rAF loop (a hot surface, never React state).
 * green → warn → hot by threshold; red means an overrun, i.e. buffer noise.
 *
 * PROVISIONAL HOME (TB-1): this rode the tools row, and the tools row is gone.
 * It now sits in the console's global block until it earns a permanent spot —
 * it is a whole-engine read, so nothing narrower than the console fits it.
 */
export function CpuMeter({ link, className = "cpu-meter" }: {
  link: EngineLink | null;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !link) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let load = 0;
    let raf = 0;
    const off = link.onHotFrame((frame) => {
      load = frame[HotFrameLayout.callbackLoad] ?? 0;
    });
    const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = css("--bg-raised");
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = load > 0.9 ? css("--hot") : load > 0.7 ? css("--warn") : css("--signal");
      ctx.fillRect(0, 0, Math.min(load, 1) * w, h);
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(raf);
      off();
    };
  }, [link]);
  return <canvas ref={canvasRef} className={className} />;
}
