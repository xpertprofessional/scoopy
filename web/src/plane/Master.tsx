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
import { HealthReadout } from '../design/HealthReadout.tsx'
import { send } from './send.ts'

const METER_W = 90
const METER_H = 10

export function Master({
  link,
  level,
  masterBpm,
  synced = [],
  onLevel,
  onBpm,
  onPlay,
  onStop,
  onRestart,
  deckCount = 0,
  brActive = false,
  brLabel = '2',
  revActive = false,
  onToggleBeatRepeat,
  onCycleBeatRepeat,
  onToggleReverse,
}: {
  link: EngineLink | null
  level: number
  masterBpm: number
  /** The synced elements' resolved relation and tempo, for the readout. Given
      rather than derived: the master owns no strips, and a component that went
      looking through the map for them would be reaching past its own job. */
  synced?: { pulse: string; bpm: string }[]
  onLevel: (v: number) => void
  onBpm: (v: number) => void
  onPlay: () => void
  onStop: () => void
  onRestart: () => void
  /** How many grid decks the transport would reach. Zero disables the verbs —
      three enabled buttons iterating an empty array are silent no-ops, and a
      control that does nothing teaches that the transport is broken (P3-U5). */
  deckCount?: number
  /** BEAT REPEAT + REV (P3-M-1b) — scoopy's transport verbs, folded in. The
      panel owns the fused-scale state; this renders it. */
  brActive?: boolean
  brLabel?: string
  revActive?: boolean
  onToggleBeatRepeat?: () => void
  onCycleBeatRepeat?: () => void
  onToggleReverse?: () => void
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
      {/* ENGINE HEALTH (P11-5). Beside LIM because they are the same KIND of
          fact and a person checks them in the same glance: LIM says the output
          is being held, DSP says the audio thread is running out of time. Both
          are conditions you can only find out about from the app — the limiter
          just sounds quiet, and an overrunning engine just sounds broken.

          THE MASTER BAR IS THE HOME because it is the only surface that is
          always on screen and never in the way (the reason the master lives
          here at all, above). This read had a widget, a published scalar and a
          ctest — and its only mount was `DeckMixerPanel`, a surface P3-P1
          retired from the panels menu. Built, published, pinned, unreachable:
          rule four exactly. */}
      <HealthReadout link={link} />
      {/* THE MASTER TRANSPORT (P3-2). The same four verbs a strip carries, one
          level up: what a strip's ⟳ ▸ ↻ ◼ do to one deck, these do to every
          deck at once. Deliberately the SAME vocabulary — a transport that
          meant something different here would be a second thing to learn for
          no gain, and "one transport vocabulary for every element" is the
          domain P3-1 opened.

          ▸ one-shot is absent rather than inert: on the master it has no
          meaning at all (there is no single thing to fire once), which is a
          different case from a grid strip, where it is a verb the element
          genuinely lacks and so is rendered disabled. */}
      <span className="master-transport" role="group" aria-label="master transport" data-no-drag>
        <button
          type="button"
          onClick={onPlay}
          disabled={deckCount === 0}
          title={deckCount === 0 ? 'no deck to play — load a session into a strip' : 'play every deck'}
        >
          ⟳
        </button>
        <button
          type="button"
          onClick={onRestart}
          disabled={deckCount === 0}
          title={
            deckCount === 0
              ? 'no deck to restart — load a session into a strip'
              : 'stop and restart every deck from the top'
          }
        >
          ↻
        </button>
        <button
          type="button"
          onClick={onStop}
          disabled={deckCount === 0}
          title={deckCount === 0 ? 'no deck to stop — load a session into a strip' : 'stop every deck'}
        >
          ◼
        </button>
        {/* BEAT REPEAT (P3-M-1b): scoopy's signature performance verb, folded
            into the master. BR latches the window; the number cycles the fused
            scale (16…2 whole steps, then 1/2…1/32 re-triggering rolls) and is
            live while latched. REV runs the whole session backwards — true
            tape reverse, composing with any track's own direction. */}
        <button
          type="button"
          className={`master-br mono${brActive ? ' latched' : ''}`}
          disabled={deckCount === 0}
          onClick={onToggleBeatRepeat}
          title={
            deckCount === 0
              ? 'no deck — load a session into a strip'
              : brActive
                ? 'release the beat repeat'
                : 'beat repeat — loop the window on every deck'
          }
        >
          BR
        </button>
        <button
          type="button"
          className="master-br mono"
          disabled={deckCount === 0}
          onClick={onCycleBeatRepeat}
          title="beat-repeat length — 16…2 whole steps, then 1/2…1/32 rolls"
        >
          {brLabel}
        </button>
        <button
          type="button"
          className={`master-br mono${revActive ? ' latched' : ''}`}
          disabled={deckCount === 0}
          onClick={onToggleReverse}
          title={
            deckCount === 0
              ? 'no deck — load a session into a strip'
              : revActive
                ? 'play forward again'
                : 'REV — the whole session backwards, true tape reverse'
          }
        >
          REV
        </button>
      </span>
      <label className="plane-bpm mono">
        {/* −/+ STEPPERS on the DOCUMENT tempo — a ±1 the number box also
            offers, made one-click. This is deliberately NOT the pitch-fader
            nudge: that gesture is TRANSIENT (never the document, snaps back on
            release), the law already takes it as `nudgeBpmDelta`, and its
            feel — hold-to-bend, how it releases — is a D-4 design call. Until
            that lands, these buttons say what they do and do what they say. */}
        <button
          type="button"
          className="bpm-nudge"
          onClick={() => onBpm(round1(masterBpm - 1))}
          aria-label="master tempo down"
          title="−1 BPM"
        >
          −
        </button>
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
          title="the plane's master tempo — every synced element resolves against this"
        />
        <button
          type="button"
          className="bpm-nudge"
          onClick={() => onBpm(round1(masterBpm + 1))}
          aria-label="master tempo up"
          title="+1 BPM"
        >
          +
        </button>
        bpm
      </label>
      {/* WHAT THE MASTER IS ACTUALLY DOING TO THE DECKS. A master tempo with no
          readout is a number you have to trust; this says which decks are
          following it and at what relation, which is the difference between a
          sync system and a bpm box. Empty when nothing is synced — a row of
          zeroes would teach that the readout is usually noise. */}
      {synced.length > 0 && (
        <span className="master-sync mono dim" title="synced elements — pulse relation and tempo">
          {synced.map((s) => `${s.pulse} ${s.bpm}`).join('  ')}
        </span>
      )}
    </div>
  )
}

/** One decimal, so a nudge off a fractional tempo does not accumulate float
    dust into the number box. */
function round1(v: number): number {
  return Math.round(v * 10) / 10
}

/** Linear gain as dB, fixed width. `−∞` at silence, because a large negative
    number would suggest the fader still passes something. */
export function formatDb(level: number): string {
  if (level <= 0.0001) return ' −∞ '
  const db = 20 * Math.log10(level)
  return `${db >= 0 ? '+' : '−'}${Math.abs(db).toFixed(1)}`
}
