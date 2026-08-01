/**
 * The wave field — the strip's centre of gravity, and the reason a strip reads
 * as a PLAYER rather than as a mixer channel that grew a waveform.
 *
 * IT IS UNCONDITIONAL. A strip with no material draws a centre hairline and a
 * hint; a recording strip draws itself live, left-anchored, with the write head
 * at the right edge; a strip with material draws its envelope, loop brace and
 * playhead. Same rect, same canvas, same size, in every state — so
 * record→material is a REPAINT, not a remount, which is Law C-3 made visible.
 *
 * Painted on requestAnimationFrame from refs the HotFrame writes; the envelope
 * is fetched over the wire on a revision counter, and at ~8 Hz while recording
 * because the material is growing under it. React state is used ONLY for the
 * fetched envelope, never for the playhead.
 */
import { useEffect, useRef, useState } from 'react'
import { SL_TAPE_STATE, slTapeIndex } from '../../protocol/schema.ts'
import type { EngineLink } from '../engineLink.ts'
import { ask } from './send.ts'

export const WAVE_H = 48

/** How often to re-fetch the envelope while the tape is recording. Eight times
    a second is enough to read as "drawing itself" and cheap enough that eight
    strips recording at once is 64 small commands a second, not 480. */
const REC_REFETCH_MS = 125

type Envelope = { min: number[]; max: number[] }

export function TapeWave({
  link,
  tape,
  width,
  /** Bumped by the owner whenever the material changed for a reason the wave
      cannot see — a take loaded, a record finished, a splice. */
  revision,
  loop,
  onLoopDrag,
  onScrub,
  canScrub = false,
  hint,
  missing,
  height = WAVE_H,
}: {
  link: EngineLink | null
  /** null when the strip has no tape — the field still draws, at full size. */
  tape: number | null
  width: number
  /** Field height. Defaults to the plane's WAVE_H, which is the strip's budget
      and must stay that on the plane (a saved `cell.h` is arithmetic over it).
      ScoopyTape passes a much larger number: there the display is not a lane in
      a strip, it IS the product, and precise scrubbing wants ground to aim at.
      Optional-with-a-default deliberately, so the plane needs no edit. */
  height?: number
  revision: number
  loop?: { enabled: boolean; start: number; end: number }
  onLoopDrag?: (start: number, end: number) => void
  /** SCRUB (P3-U3): the unmodified wave drag, per pd-scrub-interaction. The
      wave reports positions in FRAMES; the engine derives the rate from the
      gap (the turntable law). */
  onScrub?: { begin: (frame: number) => void; to: (frame: number) => void; end: () => void }
  canScrub?: boolean
  hint?: string
  /** The referenced take could not be found. Draw the field, say so in it. */
  missing?: boolean
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [env, setEnv] = useState<Envelope | null>(null)
  const [frames, setFrames] = useState(0)

  // Live values, written by the HotFrame and read by the paint loop. Refs, not
  // state: the playhead moves 30 times a second and must not re-render a tree.
  const live = useRef<{ playhead: number; state: number; frames: number }>({
    playhead: 0,
    state: SL_TAPE_STATE.idle,
    frames: 0,
  })

  /* ── the envelope, over the wire ──────────────────────────────────────── */
  useEffect(() => {
    if (!link || tape === null || width <= 0) {
      setEnv(null)
      return
    }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const fetchEnv = async () => {
      try {
        const info = await ask<{ frames?: number; state?: number }>(link, 'slTape', {
          action: 'info',
          tape,
        })
        if (cancelled) return
        const n = info?.frames ?? 0
        setFrames(n)
        live.current.frames = n
        if (n > 0) {
          const raw = await ask<Partial<Envelope>>(link, 'slTape', {
            action: 'waveform',
            tape,
            channel: 0,
            startFrame: 0,
            endFrame: n,
            // One column per pixel; the canvas cannot show more, and asking for
            // more would be paying the engine to reduce data we then throw away.
            columns: Math.max(1, Math.round(width)),
          })
          if (cancelled) return
          if (Array.isArray(raw?.min) && Array.isArray(raw?.max))
            setEnv({ min: raw.min, max: raw.max })
        } else {
          setEnv(null)
        }
      } catch {
        // A host that cannot answer leaves the field empty rather than throwing
        // through the render — the strip is still a strip.
        if (!cancelled) setEnv(null)
      }
      if (!cancelled && live.current.state === SL_TAPE_STATE.recording)
        timer = setTimeout(fetchEnv, REC_REFETCH_MS)
    }

    void fetchEnv()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [link, tape, width, revision])

  /* ── the HotFrame lane ────────────────────────────────────────────────── */
  useEffect(() => {
    if (!link || tape === null) return
    const iHead = slTapeIndex(tape, 'Playhead')
    const iState = slTapeIndex(tape, 'State')
    return link.onHotFrame((frame) => {
      live.current.playhead = frame[iHead] ?? 0
      live.current.state = frame[iState] ?? SL_TAPE_STATE.idle
    })
  }, [link, tape])

  /* ── paint ────────────────────────────────────────────────────────────── */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    const css = (n: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim()

    const paint = () => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(width))
      if (canvas.width !== w * dpr || canvas.height !== height * dpr) {
        canvas.width = w * dpr
        canvas.height = height * dpr
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.fillStyle = css('--bg')
      ctx.fillRect(0, 0, w, height)

      const mid = height / 2
      const recording = live.current.state === SL_TAPE_STATE.recording

      if (missing) {
        // State 9. The field stays FULL SIZE and says what is wrong inside
        // itself — the strip is not removed, not shrunk, not greyed away.
        ctx.strokeStyle = css('--line')
        ctx.beginPath()
        ctx.moveTo(0, mid)
        ctx.lineTo(w, mid)
        ctx.stroke()
        raf = requestAnimationFrame(paint)
        return
      }

      if (env && env.max.length > 0) {
        // The envelope. While RECORDING the x-axis spans what has been captured
        // so far, so the wave draws itself left to right at a constant scale
        // instead of squashing as it grows.
        ctx.fillStyle = recording ? css('--hot') : css('--signal')
        const n = env.max.length
        for (let x = 0; x < w; x++) {
          const i = Math.min(n - 1, Math.floor((x / w) * n))
          const lo = env.min[i] ?? 0
          const hi = env.max[i] ?? 0
          const yTop = mid - Math.max(0, hi) * mid
          const yBot = mid - Math.min(0, lo) * mid
          ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop))
        }
      } else {
        // Empty: a centre hairline, so the field reads as a player waiting for
        // material rather than as a hole in the object.
        ctx.strokeStyle = css('--line')
        ctx.beginPath()
        ctx.moveTo(0, mid)
        ctx.lineTo(w, mid)
        ctx.stroke()
      }

      const total = frames || live.current.frames
      if (loop?.enabled && total > 0 && loop.end > loop.start) {
        // The loop brace, drawn OVER the envelope. Dragging it is the
        // performance, so it has to be visible at a glance.
        const x0 = (loop.start / total) * w
        const x1 = (loop.end / total) * w
        ctx.strokeStyle = css('--accent')
        ctx.beginPath()
        ctx.moveTo(x0 + 0.5, 0)
        ctx.lineTo(x0 + 0.5, height)
        ctx.moveTo(x1 - 0.5, 0)
        ctx.lineTo(x1 - 0.5, height)
        ctx.stroke()
      }

      if (recording) {
        // The write head at the right edge — where the material is arriving.
        ctx.fillStyle = css('--hot')
        ctx.fillRect(w - 2, 0, 2, height)
      } else if (total > 0) {
        const x = Math.round((live.current.playhead / total) * w)
        if (x >= 0 && x <= w) {
          ctx.fillStyle = css('--accent')
          ctx.fillRect(Math.min(w - 1, x), 0, 1, height)
        }
      }

      raf = requestAnimationFrame(paint)
    }
    raf = requestAnimationFrame(paint)
    return () => cancelAnimationFrame(raf)
  }, [width, env, frames, loop?.enabled, loop?.start, loop?.end, missing])

  /* ── the wave drag: SCRUB, or ⇧ for the loop brace (P3-U3) ────────────── */
  //
  // pd-scrub-interaction's law, applied: the WAVEFORM owns the unmodified
  // drag, and it is SCRUB — the turntable hand, the thing a tape is for. The
  // loop brace moves to ⇧-drag, the spec's one modifier. The gesture is
  // decided ONCE at pointerdown and owns the whole drag (the WaveformView
  // lock, copied): a drag that could change meaning mid-flight is two bugs.
  const onPointerDown = (e: React.PointerEvent) => {
    if (frames <= 0) return
    const scrub = !e.shiftKey && canScrub && onScrub !== undefined
    if (!scrub && !onLoopDrag) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const at = (clientX: number) =>
      Math.round(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * frames)
    const anchor = at(e.clientX)
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    if (scrub) onScrub!.begin(anchor)

    const move = (ev: PointerEvent) => {
      const here = at(ev.clientX)
      if (scrub) {
        // Position, not velocity: the engine derives the rate from the gap
        // (sl_tape's turntable law), so pixels never pretend to be physics.
        onScrub!.to(here)
      } else {
        // Drag in either direction from the anchor; the brace is a span, not a
        // handle, so which end you started from is not a mode.
        onLoopDrag!(Math.min(anchor, here), Math.max(anchor, here))
      }
    }
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture?.(ev.pointerId)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      // Letting go arms the cue (D-WZ-SCRUBCUE-01) engine-side; nothing to do
      // here but say the drag is over.
      if (scrub) onScrub!.end()
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  return (
    <div
      className={`strip-wavefield${missing ? ' missing' : ''}`}
      style={{ width, height: height }}
      onPointerDown={onPointerDown}
      title={
        canScrub
          ? 'drag to scrub — the tape follows your hand, release arms the cue · ⇧-drag sets the loop region'
          : onLoopDrag
            ? 'drag to set the loop region'
            : undefined
      }
      data-no-drag
    >
      <canvas ref={canvasRef} style={{ width, height: height }} aria-hidden />
      {missing && <span className="strip-wave-note hot mono">audio missing</span>}
      {!missing && !env && hint && <span className="strip-wave-note dim mono">{hint}</span>}
    </div>
  )
}
