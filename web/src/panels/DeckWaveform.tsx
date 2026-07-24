/**
 * Deck waveform + loop brace (P4-06).
 *
 * The envelope is fetched once per buffer change (not per frame) and drawn to a
 * canvas; the PLAYHEAD rides the HotSurface loop on top, so nothing per-frame
 * ever touches React. Dragging across the waveform sets the loop region —
 * direct-on-object manipulation rather than a far-off pair of number fields
 * (the GRM lesson: act on the thing itself).
 *
 * DELIBERATELY STANDALONE, like VarispeedSlider: it takes a deck id + geometry
 * and knows nothing about racks. PD-CANVAS reuses it inside a Cell unchanged
 * (docs/specs/pd-canvas.md §3).
 */
import { useEffect, useRef, useState } from 'react'
import { DECK_BLOCK_FIELDS, deckFieldIndex } from '../../protocol/schema'
import type { EngineLink } from '../engine/engineLink'
import { registerHotDrawer } from '../hotsurface/hotSurface'

interface Props {
  link: EngineLink | null
  deck: number
  channelCount: number
  /** Bumped by the caller whenever the deck's buffer changes (load / record). */
  revision: number
  frames: number
  loopStart: number
  loopEnd: number
  onSetLoop: (startSample: number, endSample: number) => void
  width?: number
  height?: number
}

export function DeckWaveform({
  link,
  deck,
  channelCount,
  revision,
  frames,
  loopStart,
  loopEnd,
  onSetLoop,
  width = 150,
  height = 40,
}: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const envelopeRef = useRef<{ min: number[]; max: number[] } | null>(null)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)

  // Fetch the envelope when the buffer changes — a view-change cost, not a
  // per-frame one.
  useEffect(() => {
    let cancelled = false
    if (!link || frames === 0) {
      envelopeRef.current = null
      return
    }
    void link
      .command('deckWaveform', {
        deck,
        channel: 0,
        startFrame: 0,
        endFrame: frames,
        columns: Math.max(1, Math.round(width)),
      })
      .then((r) => {
        if (!cancelled) envelopeRef.current = { min: r.min, max: r.max }
      })
      .catch(() => {
        if (!cancelled) envelopeRef.current = null
      })
    return () => {
      cancelled = true
    }
  }, [link, deck, revision, frames, width])

  // One drawer on the shared rAF loop: waveform + loop brace + live playhead.
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
    const wave = css.getPropertyValue('--chan-deck').trim()
    const brace = css.getPropertyValue('--accent').trim()
    const line = css.getPropertyValue('--line').trim()

    return registerHotDrawer((frame) => {
      const w = canvas.width
      const h = canvas.height
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, w, h)

      const env = envelopeRef.current
      if (env && env.min.length > 0) {
        ctx.fillStyle = wave
        const cols = env.min.length
        for (let c = 0; c < cols; c++) {
          const x = (c / cols) * w
          const cw = Math.max(1, w / cols)
          const lo = env.min[c] ?? 0
          const hi = env.max[c] ?? 0
          const y0 = ((1 - hi) / 2) * h
          const y1 = ((1 - lo) / 2) * h
          ctx.fillRect(x, y0, cw, Math.max(1, y1 - y0))
        }
      } else {
        ctx.strokeStyle = line
        ctx.beginPath()
        ctx.moveTo(0, h / 2)
        ctx.lineTo(w, h / 2)
        ctx.stroke()
      }

      // Loop brace — the live drag wins over the committed region so the
      // gesture is visible before it is applied.
      if (frames > 0) {
        const a = drag ? Math.min(drag.from, drag.to) : loopStart
        const b = drag ? Math.max(drag.from, drag.to) : loopEnd
        if (b > a) {
          ctx.strokeStyle = brace
          ctx.lineWidth = Math.max(1, dpr)
          const xa = (a / frames) * w
          const xb = (b / frames) * w
          ctx.strokeRect(xa, 0.5, Math.max(1, xb - xa), h - 1)
        }
      }

      // Playhead from HotFrame — never through React state.
      const phIdx = deckFieldIndex(channelCount, deck, DECK_BLOCK_FIELDS[1]!)
      if (frames > 0 && frame.length > phIdx) {
        const x = (frame[phIdx]! / frames) * w
        ctx.fillStyle = brace
        ctx.fillRect(x, 0, Math.max(1, dpr), h)
      }
    })
  }, [deck, channelCount, frames, loopStart, loopEnd, drag, width, height])

  const posToSample = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect()
    const t = (ev.clientX - rect.left) / Math.max(1, rect.width)
    return Math.max(0, Math.min(frames, Math.round(t * frames)))
  }

  return (
    <canvas
      ref={ref}
      className="deck-waveform"
      style={{ width, height }}
      title="drag to set the loop region · double-click for the whole take"
      onPointerDown={(ev) => {
        if (frames === 0) return
        ev.currentTarget.setPointerCapture(ev.pointerId)
        const s = posToSample(ev)
        setDrag({ from: s, to: s })
      }}
      onPointerMove={(ev) => {
        if (drag) setDrag({ ...drag, to: posToSample(ev) })
      }}
      onPointerUp={() => {
        if (!drag) return
        const a = Math.min(drag.from, drag.to)
        const b = Math.max(drag.from, drag.to)
        setDrag(null)
        // A click (no span) is not a loop edit — it would silently zero the region.
        if (b - a > 1) onSetLoop(a, b)
      }}
      onDoubleClick={() => onSetLoop(0, frames)}
    />
  )
}
