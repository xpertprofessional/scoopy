/**
 * The strip's level meter — a 10 × 48 column in the wave row's right gutter.
 *
 * GEOMETRY IS EXPLICIT AND FIXED. Mounting a meter with no size inside a
 * 196 px strip is the single worst defect found in wizard's own Strip.tsx: the
 * default was 14 × 96, which made the HEADER the tallest element in the object,
 * six times the height of the transport row. The size here is derived from the
 * strip's pixel budget (pd-strip-anatomy §4.1) and does not vary with state.
 *
 * Painted on requestAnimationFrame from a ref the HotFrame writes — NEVER
 * through React state. At 30 frames a second across eight strips that would be
 * 240 re-renders a second of a component tree that has not changed; the house
 * rule (OutputMeter, MicMeter, DeckWaveform) is that meters and playheads own a
 * canvas and stay off the render path entirely.
 */
import { useEffect, useRef } from 'react'
import { slChanPeakIndex } from '../../protocol/schema.ts'
import type { EngineLink } from '../engineLink.ts'

export const METER_W = 10
export const METER_H = 48

/** Peak-hold fall, in units per second. Slow enough to read a transient, fast
    enough that the mark is never lying about the present. */
const HOLD_FALL = 1.2
/** How fast the bar itself falls. Faster than the hold: the bar is "now", the
    mark is "just now". */
const BAR_FALL = 4.0

export function StripMeter({ link, channel }: { link: EngineLink | null; channel: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const iL = slChanPeakIndex(channel, 'L')
    const iR = slChanPeakIndex(channel, 'R')
    // Frame values land here and are read by the paint loop. A plain object,
    // not state: the whole point is that nothing above this canvas re-renders.
    let peakL = 0
    let peakR = 0
    let barL = 0
    let barR = 0
    let holdL = 0
    let holdR = 0
    let last = 0
    let raf = 0

    const off = link?.onHotFrame((frame) => {
      // The engine's peaks are CONSUMING reads, so each frame carries the peak
      // since the previous one — take the max rather than the latest, in case
      // two frames arrive between two paints.
      peakL = Math.max(peakL, frame[iL] ?? 0)
      peakR = Math.max(peakR, frame[iR] ?? 0)
    })

    const css = (n: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim()

    const paint = (now: number) => {
      const dt = last === 0 ? 0 : Math.min(0.1, (now - last) / 1000)
      last = now

      // Rise instantly, fall smoothly: a meter that eased upward would under-
      // report every transient, which is the one thing a meter must not do.
      barL = Math.max(peakL, barL - BAR_FALL * dt)
      barR = Math.max(peakR, barR - BAR_FALL * dt)
      holdL = Math.max(peakL, holdL - HOLD_FALL * dt)
      holdR = Math.max(peakR, holdR - HOLD_FALL * dt)
      peakL = 0
      peakR = 0

      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== METER_W * dpr || canvas.height !== METER_H * dpr) {
        canvas.width = METER_W * dpr
        canvas.height = METER_H * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = css('--bg-raised')
      ctx.fillRect(0, 0, METER_W, METER_H)

      const half = Math.floor((METER_W - 1) / 2)
      const draw = (x: number, w: number, v: number, hold: number) => {
        const clipped = v >= 0.999
        const h = Math.round(Math.min(v, 1) * METER_H)
        ctx.fillStyle = clipped ? css('--hot') : css('--signal')
        ctx.fillRect(x, METER_H - h, w, h)
        if (hold > 0.001) {
          const y = METER_H - Math.round(Math.min(hold, 1) * METER_H)
          ctx.fillStyle = hold >= 0.999 ? css('--hot') : css('--accent')
          ctx.fillRect(x, Math.min(METER_H - 1, y), w, 1)
        }
      }
      draw(0, half, barL, holdL)
      draw(half + 1, METER_W - half - 1, barR, holdR)

      raf = requestAnimationFrame(paint)
    }
    raf = requestAnimationFrame(paint)

    return () => {
      cancelAnimationFrame(raf)
      off?.()
    }
  }, [link, channel])

  return (
    <canvas
      ref={canvasRef}
      className="strip-meter"
      style={{ width: METER_W, height: METER_H }}
      aria-hidden
    />
  )
}
