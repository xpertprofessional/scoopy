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
  /** While true the take is still being captured: the envelope is re-fetched on
      a slow timer against the deck's LIVE committed length (HotFrame's
      `recordLengthSamples`), so you watch the wave draw itself as you record
      instead of waiting for the stop. */
  recording?: boolean
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
  recording = false,
}: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const envelopeRef = useRef<{ min: number[]; max: number[] } | null>(null)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  /** The deck's live committed length, harvested from the HotFrame by the
      drawer below — never through React state (it changes every frame). */
  const liveFramesRef = useRef(0)

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

  // While RECORDING the buffer is still growing, so the once-per-buffer-change
  // fetch above never fires. Re-fetch on a slow timer against the live length
  // instead — deliberately ~8 Hz, not per frame: an envelope fetch is a command
  // round-trip, and the wave only needs to look alive, not be frame-accurate.
  useEffect(() => {
    if (!link || !recording) return
    let cancelled = false
    const id = setInterval(() => {
      const n = Math.floor(liveFramesRef.current)
      if (n <= 0) return
      void link
        .command('deckWaveform', {
          deck,
          channel: 0,
          startFrame: 0,
          endFrame: n,
          columns: Math.max(1, Math.round(width)),
        })
        .then((r) => {
          if (!cancelled) envelopeRef.current = { min: r.min, max: r.max }
        })
        .catch(() => {})
    }, 120)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [link, recording, deck, width])

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
    const rec = css.getPropertyValue('--rec-lamp').trim()

    const recIdx = deckFieldIndex(channelCount, deck, 'recordLengthSamples')

    return registerHotDrawer((frame) => {
      const w = canvas.width
      const h = canvas.height
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, w, h)

      // Harvest the live record length every frame (ref, never state).
      if (frame.length > recIdx) liveFramesRef.current = frame[recIdx]!
      // While recording, the x axis is the GROWING buffer, not the committed
      // `frames` (which is still whatever was there before the take).
      const span = recording && liveFramesRef.current > 0 ? liveFramesRef.current : frames

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
      // gesture is visible before it is applied. Not drawn while recording:
      // there is no loop region to speak of until the take is committed.
      if (span > 0 && !recording) {
        const a = drag ? Math.min(drag.from, drag.to) : loopStart
        const b = drag ? Math.max(drag.from, drag.to) : loopEnd
        if (b > a) {
          ctx.strokeStyle = brace
          ctx.lineWidth = Math.max(1, dpr)
          const xa = (a / span) * w
          const xb = (b / span) * w
          ctx.strokeRect(xa, 0.5, Math.max(1, xb - xa), h - 1)
        }
      }

      // Playhead from HotFrame — never through React state. While recording the
      // "playhead" is the write head, which is the right edge of the wave.
      const phIdx = deckFieldIndex(channelCount, deck, DECK_BLOCK_FIELDS[1]!)
      if (span > 0 && frame.length > phIdx) {
        const pos = recording ? span : frame[phIdx]!
        const x = (pos / span) * w
        ctx.fillStyle = recording ? rec : brace
        ctx.fillRect(Math.min(x, w - Math.max(1, dpr)), 0, Math.max(1, dpr), h)
      }
    })
  }, [deck, channelCount, frames, loopStart, loopEnd, drag, width, height, recording])

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
