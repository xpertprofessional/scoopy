import { useEffect, useRef, useState } from "react";
import {
  HOT_FRAME_SPECTRUM_BASE,
  HotFrameLayout,
  SPECTRUM_BIN_COUNT,
} from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { Caption, PanelTitle } from "../design/controls.tsx";
import "./perf.css";

/**
 * P3-02 perf budget harness: 32 canvas meters + 16-bin spectrum + playhead
 * painted from ONE rAF loop (the HotSurfaceRegistry pattern all hot
 * surfaces will use). Measures paint cost; PASS = p95 < 2 ms/frame.
 * Without an engine link it synthesizes moving data, so the paint cost —
 * which is what the budget gates — is measured either way.
 */

const METER_COUNT = 32;
const BUDGET_MS = 2.0;
const WINDOW = 300; // rolling frames for stats

export function PerfPanel({ link }: { link: EngineLink | null }) {
  const meterRefs = useRef<(HTMLCanvasElement | null)[]>([]);
  const spectrumRef = useRef<HTMLCanvasElement | null>(null);
  const playheadRef = useRef<HTMLCanvasElement | null>(null);
  const [stats, setStats] = useState({ avg: 0, p95: 0, max: 0, fps: 0 });

  useEffect(() => {
    let levels = new Float64Array(METER_COUNT);
    let spectrum = new Float64Array(SPECTRUM_BIN_COUNT);
    let playheadStep = 0;
    let synthetic = true;

    const off = link?.onHotFrame((frame) => {
      synthetic = false;
      // Real feed: fan the mono peak across meters with per-index decay
      // offsets (stress-realistic); spectrum from the frame's bins.
      const peak = frame[HotFrameLayout.outputPeakL] ?? 0;
      for (let i = 0; i < METER_COUNT; i++) {
        const v = peak * (0.5 + 0.5 * Math.sin(i * 0.7 + performance.now() / 300));
        if (v > (levels[i] ?? 0)) levels[i] = v;
      }
      for (let b = 0; b < SPECTRUM_BIN_COUNT; b++) {
        spectrum[b] = frame[HOT_FRAME_SPECTRUM_BASE + b] ?? 0;
      }
      playheadStep = frame[HotFrameLayout.playheadStepDeck0] ?? 0;
    });

    const costs: number[] = [];
    let frames = 0;
    let lastStatsAt = performance.now();
    let raf = 0;

    const css = (name: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();

    const paint = () => {
      const t0 = performance.now();

      if (synthetic) {
        const t = t0 / 400;
        for (let i = 0; i < METER_COUNT; i++) {
          levels[i] = Math.abs(Math.sin(t + i * 0.37)) * 0.9;
        }
        for (let b = 0; b < SPECTRUM_BIN_COUNT; b++) {
          spectrum[b] = Math.abs(Math.sin(t * 1.3 + b * 0.6)) * 0.8;
        }
        playheadStep = Math.floor(t0 / 125) % 16;
      }

      const signal = css("--signal");
      const raised = css("--bg-raised");
      const accent = css("--accent");
      const dpr = window.devicePixelRatio || 1;

      for (let i = 0; i < METER_COUNT; i++) {
        const canvas = meterRefs.current[i];
        if (!canvas) continue;
        const ctx = canvas.getContext("2d");
        if (!ctx) continue;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
          canvas.width = w * dpr;
          canvas.height = h * dpr;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = raised;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = signal;
        ctx.fillRect(0, 0, (levels[i] ?? 0) * w, h);
        levels[i] = (levels[i] ?? 0) * 0.94;
      }

      const spec = spectrumRef.current;
      if (spec) {
        const ctx = spec.getContext("2d");
        if (ctx) {
          const w = spec.clientWidth;
          const h = spec.clientHeight;
          if (spec.width !== w * dpr || spec.height !== h * dpr) {
            spec.width = w * dpr;
            spec.height = h * dpr;
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.fillStyle = raised;
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = signal;
          const bw = w / SPECTRUM_BIN_COUNT;
          for (let b = 0; b < SPECTRUM_BIN_COUNT; b++) {
            const bh = (spectrum[b] ?? 0) * h;
            ctx.fillRect(b * bw + 1, h - bh, bw - 2, bh);
          }
        }
      }

      const ph = playheadRef.current;
      if (ph) {
        const ctx = ph.getContext("2d");
        if (ctx) {
          const w = ph.clientWidth;
          const h = ph.clientHeight;
          if (ph.width !== w * dpr || ph.height !== h * dpr) {
            ph.width = w * dpr;
            ph.height = h * dpr;
          }
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.fillStyle = raised;
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = accent;
          const cell = w / 16;
          ctx.fillRect((playheadStep % 16) * cell, 0, cell, h);
        }
      }

      const cost = performance.now() - t0;
      costs.push(cost);
      if (costs.length > WINDOW) costs.shift();
      frames++;

      if (t0 - lastStatsAt > 500 && costs.length > 30) {
        const sorted = [...costs].sort((a, b) => a - b);
        setStats({
          avg: costs.reduce((s, c) => s + c, 0) / costs.length,
          p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
          max: sorted[sorted.length - 1] ?? 0,
          fps: Math.round((frames * 1000) / (t0 - lastStatsAt)),
        });
        frames = 0;
        lastStatsAt = t0;
      }

      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);

    return () => {
      cancelAnimationFrame(raf);
      off?.();
    };
  }, [link]);

  const pass = stats.p95 > 0 && stats.p95 < BUDGET_MS;

  return (
    <main className="panel perf">
      <PanelTitle>Perf Budget (P3-02)</PanelTitle>
      <p className="mono">
        paint avg {stats.avg.toFixed(2)} ms · p95 {stats.p95.toFixed(2)} ms ·
        max {stats.max.toFixed(2)} ms · {stats.fps} fps ·{" "}
        <span style={{ color: pass ? "var(--signal)" : "var(--hot)" }}>
          {stats.p95 === 0 ? "warming up…" : pass ? "PASS" : "FAIL"}
        </span>{" "}
        (budget p95 &lt; {BUDGET_MS} ms)
      </p>
      <Caption>
        {link ? "live HotFrame feed" : "synthetic data (no engine link)"} — 32
        meters + 16-bin spectrum + playhead, one rAF loop.
      </Caption>

      <div className="meter-grid">
        {Array.from({ length: METER_COUNT }, (_, i) => (
          <canvas key={i} ref={(el) => { meterRefs.current[i] = el; }} />
        ))}
      </div>
      <canvas ref={spectrumRef} className="spectrum" />
      <canvas ref={playheadRef} className="playhead" />
    </main>
  );
}
