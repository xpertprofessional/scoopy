import { useEffect, useRef } from "react";
import { HotFrameLayout } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { healthView, latchMisses } from "./health.ts";

/**
 * THE ENGINE HEALTH READOUT (P11-5) — how loaded the audio thread is, and
 * whether it has ever overrun.
 *
 * This replaces `CpuMeter`, which was the same read with three problems. It was
 * a bare bar with no number and no dropout count; it was mounted only in
 * `DeckMixerPanel`, a surface P3-P1 RETIRED from the panels menu because it
 * hangs on "waiting for state" in the merged host; and it was called CPU, which
 * is the same word `PerfPanel` uses for a completely different thing (paint
 * cost, p95 < 2 ms/frame). So the app's one health-sounding door reported on the
 * UI while the audio thread's load had no door at all — and that is how a 12x
 * whole-DSP slowdown reached a user through nine green drift gates, 1523 vitest
 * and 43 ctest (P3.5-E10). It is labelled DSP now because that is what it
 * measures.
 *
 * PAINTED ON A rAF LOOP, never through React state — the house rule for every
 * meter here, and the reason it can sit in the always-on-screen master bar
 * without re-rendering the plane sixty times a second.
 *
 * It is a BUTTON because it takes a gesture: click to acknowledge the overrun
 * count. Without that the readout goes hot on the first dropout of a session
 * and stays hot forever, which reads as broken rather than as informative.
 */
export function HealthReadout({ link, className = "health-readout" }: {
  link: EngineLink | null;
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  /** The latched engine total — see `latchMisses`. Never goes down. */
  const latched = useRef(0);
  /** The total at the last acknowledge. The readout shows the difference. */
  const acked = useRef(0);

  useEffect(() => {
    let load = 0;
    let seen = false;
    let raf = 0;
    // Last painted values, so a steady engine touches the DOM zero times per
    // frame. Tracked separately because they do not move together: the load
    // number is quantised to a whole percent, so the tone can cross a
    // threshold while the text reads the same.
    let lastText = "";
    let lastTone = "";
    let lastTitle = "";

    const off = link?.onHotFrame((frame) => {
      load = frame[HotFrameLayout.callbackLoad] ?? 0;
      latched.current = latchMisses(
        latched.current,
        frame[HotFrameLayout.deadlineMissCount] ?? 0,
      );
      seen = true;
    });

    const paint = () => {
      const el = ref.current;
      if (el) {
        const v = healthView(load, latched.current, acked.current, seen);
        if (v.text !== lastText) {
          el.textContent = v.text;
          lastText = v.text;
        }
        if (v.tone !== lastTone) {
          el.className = `${className} mono tone-${v.tone}`;
          lastTone = v.tone;
        }
        if (v.title !== lastTitle) {
          el.title = v.title;
          lastTitle = v.title;
        }
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(raf);
      off?.();
    };
  }, [link, className]);

  return (
    <button
      ref={ref}
      type="button"
      className={`${className} mono tone-ok`}
      data-no-drag
      onClick={() => {
        acked.current = latched.current;
      }}
    >
      DSP —
    </button>
  );
}
