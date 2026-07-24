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
  /** Jump scrub: move the playhead at unchanged pitch (granular in feel). */
  onScrub?: (frame: number) => void
  /** TAPE scrub (turntable): pitch follows hand speed. Option-drag. */
  onTapeScrub?: (phase: 'begin' | 'to' | 'end', frame: number) => void
  /** The plane's zoom, so the head stays ~1 device px at any scale. */
  scale?: number
  /** Engine rate, so a scrub can say WHERE it is in time rather than samples. */
  sampleRate?: number
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
  onScrub,
  onTapeScrub,
  scale = 1,
  sampleRate = 0,
  width = 150,
  height = 40,
  recording = false,
}: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const envelopeRef = useRef<{ min: number[]; max: number[] } | null>(null)
  // The live region drag lives in a REF, not state: it is read by the drawer
  // every frame anyway, and as state it re-ran the drawer effect — rebuilding
  // the canvas context and re-reading every CSS token 60x a second mid-gesture.
  const dragRef = useRef<{ from: number; to: number } | null>(null)
  // Which gesture this pointer-down committed to. Locked once, so a drag can
  // never change its mind halfway (shift released mid-region-drag used to turn
  // it into a scrub).
  const gestureRef = useRef<'scrub' | 'tape' | 'region' | null>(null)
  // Optimistic head: where the user has dragged to, drawn immediately instead of
  // waiting for the engine's next HotFrame — otherwise the head lags the finger
  // by a round trip. Cleared on release so the head hands back to the engine.
  const scrubHeadRef = useRef<number | null>(null)
  // Coalesce scrub posts to one per animation frame: a pointer-move can fire far
  // faster than the engine consumes, and only the newest position matters.
  const pendingScrubRef = useRef<number | null>(null)
  const scrubRafRef = useRef(0)
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
    const textCol = css.getPropertyValue('--text').trim()
    const mono = css.getPropertyValue('--font-mono').trim() || 'monospace'

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
      const drag = dragRef.current
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
        // While scrubbing, the OPTIMISTIC head wins: it is under the finger now,
        // rather than one command round-trip behind it.
        const scrubbing = scrubHeadRef.current
        const pos = scrubbing !== null ? scrubbing : recording ? span : frame[phIdx]!
        const x = (pos / span) * w
        // Counter-scale so the head stays ~1 device px however far the plane is
        // zoomed out; doubled and accented while actively scrubbing.
        const hw = Math.max(1, dpr / scale)
        ctx.fillStyle = recording ? rec : brace
        ctx.fillRect(Math.min(x, w - hw), 0, scrubbing !== null ? hw * 2 : hw, h)

        // While scrubbing, SAY where you are. A 380px strip holding minutes of
        // audio is about half a second per pixel, so the head's position alone
        // cannot tell you — and this is drawn by the existing drawer, on the
        // canvas, so a per-frame readout still never touches React.
        if (scrubbing !== null && sampleRate > 0) {
          const secs = scrubbing / sampleRate
          const label =
            secs >= 60
              ? `${Math.floor(secs / 60)}:${(secs % 60).toFixed(1).padStart(4, '0')}`
              : `${secs.toFixed(2)}s`
          const fh = Math.max(9, 10 * dpr / scale)
          ctx.font = `${fh}px ${mono}`
          const tw = ctx.measureText(label).width
          // Flip to the other side near the right edge so it never clips off.
          const tx = x + 4 * dpr + tw > w ? x - tw - 4 * dpr : x + 4 * dpr
          ctx.fillStyle = bg
          ctx.fillRect(tx - 2 * dpr, 1, tw + 4 * dpr, fh + 2 * dpr)
          ctx.fillStyle = textCol
          ctx.fillText(label, tx, fh)
        }
      }
    })
  }, [deck, channelCount, frames, loopStart, loopEnd, width, height, recording, scale, sampleRate])

  /** Post at most one scrub per animation frame, always the newest position. */
  const postScrub = (frame: number) => {
    pendingScrubRef.current = frame
    if (scrubRafRef.current !== 0) return
    scrubRafRef.current = requestAnimationFrame(() => {
      scrubRafRef.current = 0
      const f = pendingScrubRef.current
      if (f !== null) onScrub?.(f)
    })
  }

  /** Tape posts share the scrub throttle: one per frame, newest position. */
  const postTape = (frame: number) => {
    pendingScrubRef.current = frame
    if (scrubRafRef.current !== 0) return
    scrubRafRef.current = requestAnimationFrame(() => {
      scrubRafRef.current = 0
      const f = pendingScrubRef.current
      if (f !== null) onTapeScrub?.('to', f)
    })
  }

  const endGesture = (ev: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current
    gestureRef.current = null
    // Release the capture in BOTH paths — neither did before, so a strip could
    // keep swallowing pointer events after the drag ended.
    ev.currentTarget.releasePointerCapture?.(ev.pointerId)
    if (gesture === 'region') {
      const d = dragRef.current
      dragRef.current = null
      if (!d) return
      const a = Math.min(d.from, d.to)
      const b = Math.max(d.from, d.to)
      // A click (no span) is not a loop edit — it would silently zero the region.
      if (b - a > 1) onSetLoop(a, b)
      return
    }
    if (gesture === 'tape') onTapeScrub?.('end', 0)
    // Hand the head back to the engine: from here the HotFrame is the truth.
    scrubHeadRef.current = null
  }

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
      title="drag to scrub · shift-drag to set the loop region · double-click for the whole take — alt-drag for TAPE scrub (pitch follows your hand, and it sounds even when stopped)"
      onPointerDown={(ev) => {
        // Nothing to aim at, or the buffer is being written: refuse outright
        // rather than scrub a moving target.
        if (frames === 0 || recording) return
        ev.currentTarget.setPointerCapture(ev.pointerId)
        const at = posToSample(ev)
        // LOCK the gesture now. Deciding per-move let a released shift key turn
        // a region drag into a scrub mid-gesture.
        // shift = set the loop region · alt/option = TAPE scrub (pitch follows
        // the hand) · plain = jump scrub (unchanged pitch, granular in feel).
        gestureRef.current = ev.shiftKey ? 'region' : ev.altKey ? 'tape' : 'scrub'
        if (gestureRef.current === 'region') {
          dragRef.current = { from: at, to: at }
        } else if (gestureRef.current === 'tape') {
          scrubHeadRef.current = at
          onTapeScrub?.('begin', at)
        } else {
          scrubHeadRef.current = at
          postScrub(at)
        }
      }}
      onPointerMove={(ev) => {
        // Driven by the captured gesture, not by ev.buttons: a capture can
        // outlive a button report, and buttons lies during some trackpad drags.
        if (gestureRef.current === null) return
        const at = posToSample(ev)
        if (gestureRef.current === 'region') {
          dragRef.current = { from: dragRef.current?.from ?? at, to: at }
        } else if (gestureRef.current === 'tape') {
          scrubHeadRef.current = at
          postTape(at)
        } else {
          scrubHeadRef.current = at
          postScrub(at)
        }
      }}
      onPointerUp={(ev) => endGesture(ev)}
      onPointerCancel={(ev) => endGesture(ev)}
      onDoubleClick={() => onSetLoop(0, frames)}
    />
  )
}
