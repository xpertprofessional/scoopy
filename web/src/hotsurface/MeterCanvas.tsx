/**
 * Stereo peak meter on the HotSurface path (P1-metering): one shared rAF loop
 * (hotSurface.ts) drives every instance imperatively from the latest HotFrame —
 * meter data NEVER passes through React state. Colors resolve from the token
 * custom properties at mount (canvas cannot read CSS vars per-fill).
 */
import { useEffect, useRef } from 'react'
import { registerHotDrawer } from './hotSurface'

/** Linear amplitude → 0..1 bar height over a −60 dB window. */
function ampToBar(amp: number): number {
  if (amp <= 0.001) return 0 // −60 dB floor
  const db = 20 * Math.log10(amp)
  return Math.min(1, (db + 60) / 66) // −60..+6 dB span
}

interface Props {
  /** Extract [peakL, peakR] (linear) from a HotFrame. Return null while the
      frame is too short (world/UI momentarily out of step during a publish). */
  levels: (frame: Float64Array) => [number, number] | null
  width?: number
  height?: number
}

export function MeterCanvas({ levels, width = 14, height = 96 }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    const css = getComputedStyle(document.documentElement)
    const bg = css.getPropertyValue('--bg-raised').trim()
    const signal = css.getPropertyValue('--signal').trim()
    const hot = css.getPropertyValue('--hot').trim()

    // Peak-hold decay state, drawer-local (render-loop owned, not React).
    let holdL = 0
    let holdR = 0

    return registerHotDrawer((frame) => {
      const lv = levels(frame)
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      if (!lv) return
      holdL = Math.max(lv[0], holdL * 0.92)
      holdR = Math.max(lv[1], holdR * 0.92)
      const w = canvas.width / 2 - dpr
      const draw = (x: number, amp: number) => {
        const h = ampToBar(amp) * canvas.height
        ctx.fillStyle = amp >= 1 ? hot : signal // over full scale reads hot
        ctx.fillRect(x, canvas.height - h, w, h)
      }
      draw(0, holdL)
      draw(canvas.width / 2 + dpr, holdR)
    })
  }, [levels, width, height])

  return <canvas ref={ref} style={{ width, height }} className="meter" />
}
