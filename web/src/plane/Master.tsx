/**
 * THE MASTER SECTION (merge P2 step 4, increment 5).
 *
 * Front-of-house: level, the output meter, the watchdog lamp, and the plane's
 * master tempo. It lives in the plane's bar rather than as a strip on the
 * plane, and that is a decision:
 *
 *   A STRIP IS SOMETHING YOU PLACE. The master is not — there is exactly one,
 *   it is never routed anywhere, and it has no element. Making it a strip would
 *   mean an object you could drag away from, delete, or fail to find, in
 *   exchange for a consistency the eye does not need. `pd-master-as-strip.md`
 *   proposed the opposite; what changed is that the plane got a BAR, so the
 *   master has a home that is always on screen and never in the way.
 *
 * The level meter and the watchdog lamp are painted on the shared rAF loop from
 * HotFrame scalars, never through React state — the same rule every meter here
 * follows.
 */
import { useEffect, useRef } from 'react'
import { HotFrameLayout } from '../../protocol/schema.ts'
import type { EngineLink } from '../engineLink.ts'
import { GeoRange } from '../design/controls.tsx'
import { send } from './send.ts'

const METER_W = 90
const METER_H = 10

export function Master({
  link,
  level,
  masterBpm,
  onLevel,
  onBpm,
}: {
  link: EngineLink | null
  level: number
  masterBpm: number
  onLevel: (v: number) => void
  onBpm: (v: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const lampRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let peakL = 0
    let peakR = 0
    let barL = 0
    let barR = 0
    let engaged = 0
    let gain = 1
    let last = 0
    let raf = 0

    const off = link?.onHotFrame((frame) => {
      peakL = Math.max(peakL, frame[HotFrameLayout.outputPeakL] ?? 0)
      peakR = Math.max(peakR, frame[HotFrameLayout.outputPeakR] ?? 0)
      engaged = frame[HotFrameLayout.slWatchdogEngaged] ?? 0
      gain = frame[HotFrameLayout.slWatchdogGain] ?? 1
    })

    const css = (n: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim()

    const paint = (now: number) => {
      const dt = last === 0 ? 0 : Math.min(0.1, (now - last) / 1000)
      last = now
      barL = Math.max(peakL, barL - 4 * dt)
      barR = Math.max(peakR, barR - 4 * dt)
      peakL = 0
      peakR = 0

      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== METER_W * dpr || canvas.height !== METER_H * dpr) {
        canvas.width = METER_W * dpr
        canvas.height = METER_H * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = css('--bg')
      ctx.fillRect(0, 0, METER_W, METER_H)
      const half = Math.floor((METER_H - 1) / 2)
      const draw = (y: number, h: number, v: number) => {
        ctx.fillStyle = v >= 0.999 ? css('--hot') : css('--signal')
        ctx.fillRect(0, y, Math.min(v, 1) * METER_W, h)
      }
      draw(0, half, barL)
      draw(half + 1, METER_H - half - 1, barR)

      // THE WATCHDOG LAMP. Not decoration: the limiter HOLDS the output rather
      // than muting it, so without a lamp a session that is being limited
      // sounds merely quiet and compressed with nothing saying why. The gain is
      // shown too, because "engaged" alone does not distinguish a graze from a
      // runaway.
      const lamp = lampRef.current
      if (lamp) {
        const on = engaged > 0.5
        lamp.className = `master-lamp mono${on ? ' engaged' : ''}`
        lamp.textContent = on ? `LIM ${(20 * Math.log10(Math.max(gain, 1e-6))).toFixed(1)}` : 'LIM'
      }

      raf = requestAnimationFrame(paint)
    }
    raf = requestAnimationFrame(paint)
    return () => {
      cancelAnimationFrame(raf)
      off?.()
    }
  }, [link])

  return (
    <div className="plane-master" data-no-drag>
      <span className="mono dim">master</span>
      <span className="master-fader">
        <GeoRange
          value={level}
          min={0}
          max={1.5}
          step={0.01}
          onChange={(v) => {
            onLevel(v)
            send(link, 'slMaster', { action: 'setLevel', level: v })
          }}
          onDoubleClick={() => {
            onLevel(1)
            send(link, 'slMaster', { action: 'setLevel', level: 1 })
          }}
          title="master output — double-click for unity"
        />
      </span>
      <span className="master-db mono">{formatDb(level)}</span>
      <canvas ref={canvasRef} className="master-meter" style={{ width: METER_W, height: METER_H }} />
      <span ref={lampRef} className="master-lamp mono" title="the output limiter (guard G1)">
        LIM
      </span>
      <label className="plane-bpm mono">
        <input
          type="number"
          min={20}
          max={300}
          step={0.1}
          value={masterBpm}
          aria-label="master tempo"
          onChange={(e) => {
            const v = Number(e.target.value)
            if (Number.isFinite(v) && v > 0) onBpm(v)
          }}
          title="the plane's master tempo — what a synced deck's ratio is computed against"
        />
        bpm
      </label>
    </div>
  )
}

/** Linear gain as dB, fixed width. `−∞` at silence, because a large negative
    number would suggest the fader still passes something. */
export function formatDb(level: number): string {
  if (level <= 0.0001) return ' −∞ '
  const db = 20 * Math.log10(level)
  return `${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(1)}`
}
