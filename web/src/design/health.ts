/**
 * ENGINE HEALTH — what the master bar's readout says, as pure functions
 * (P11-5).
 *
 * The numbers are already published and already pinned: the core brackets the
 * whole of `render()` and publishes `callbackLoad` (SL_HF 9) plus a MONOTONIC
 * `deadlineMissCount` (SL_HF 10) — a compute-overrun counter, which is the
 * better number than a driver's dropout count because it isolates DSP cost from
 * the device. The gap P11-5 closes is a DOOR, not a measurement.
 *
 * The rules live here rather than in the component for the house reason: the
 * readout is painted on a rAF loop from the HotFrame and never through React
 * state, so the only way to pin it without jsdom is to pin the arithmetic
 * separately from the painting (the P11-0 precedent).
 *
 * TWO RULES, and both exist because of how a person actually uses this:
 *
 *  1. THE COUNT ONLY EVER GOES UP. A rate cannot answer "did it drop while I
 *     was not looking" — you have to be looking. A total can. The engine's own
 *     counter is monotonic, but it resets when the device reopens (a rate
 *     change, a device switch), and an overrun that happened must not
 *     un-happen because the driver restarted. So the UI latches the max.
 *  2. A DROPOUT IS STICKY-HOT. Load recovers on its own and the colour should
 *     follow it back down; an overrun did not recover — it was audible. It
 *     stays hot until someone acknowledges it, which is the whole point of
 *     keeping a total.
 *
 * What this deliberately does NOT show: the `48k · 512` the ledger sketched.
 * Neither is reachable from the web layer at HEAD — there is no sample-rate or
 * block-size scalar in `HOT_FRAME_SCALARS`, and `AudioIO::open`
 * (`host/src/AudioIO.cpp:27-29`) sets `setup.sampleRate` but never
 * `setup.bufferSize`, so the device's real block size is whatever CoreAudio
 * chose and nothing reads it back. Printing `512` would be a number that lies
 * about the one thing this readout exists to be trusted on. See the follow-up
 * row that publishes them.
 */

/** green → warn → hot. `hot` means it was audible. */
export type HealthTone = 'ok' | 'warn' | 'hot'

export interface HealthView {
  /** The whole glyph, e.g. `DSP 3%` · `DSP 94% ✕2` · `DSP —` before any frame. */
  text: string
  tone: HealthTone
  /** Overruns since the last acknowledge — what the ✕ count shows. */
  dropped: number
  /** The hover explanation. Says what the number is, not just what it reads. */
  title: string
}

/** Load above this is worth noticing; above HOT it is about to overrun. */
export const LOAD_WARN = 0.7
export const LOAD_HOT = 0.9

/**
 * The displayed overrun total, latched.
 *
 * `frame` is the engine's own monotonic count. It goes to zero when the device
 * reopens, and this is the function that refuses to follow it down — which is
 * exactly the gate line: *a forced overrun increments the counter and it never
 * decreases*.
 */
export function latchMisses(latched: number, frame: number): number {
  if (!Number.isFinite(frame) || frame <= latched) return latched
  return frame
}

/**
 * @param load        `callbackLoad`, 0..1 — compute time against the block deadline.
 * @param latched     the latched overrun total (see `latchMisses`).
 * @param acked       the total at the last acknowledge; the readout shows the difference.
 * @param seenAFrame  false before the first HotFrame — an engine that has said
 *                    nothing reads `—`, never `0%`, because "no load" and "no
 *                    engine" are the two states a health readout must not blur.
 */
export function healthView(
  load: number,
  latched: number,
  acked: number,
  seenAFrame: boolean,
): HealthView {
  const dropped = Math.max(0, latched - acked)
  if (!seenAFrame) {
    return {
      text: 'DSP —',
      tone: 'ok',
      dropped,
      title: 'audio engine load — no HotFrame yet (no engine on this host)',
    }
  }
  const pct = Math.round(Math.max(0, Math.min(load, 9.99)) * 100)
  const tone: HealthTone =
    dropped > 0 || load > LOAD_HOT ? 'hot' : load > LOAD_WARN ? 'warn' : 'ok'
  const text = dropped > 0 ? `DSP ${pct}% ✕${dropped}` : `DSP ${pct}%`
  const title =
    dropped > 0
      ? `audio engine load ${pct}% of the block deadline · ${dropped} overrun${
          dropped === 1 ? '' : 's'
        } — the audio broke up. Click to acknowledge and watch again.`
      : `audio engine load — ${pct}% of the block deadline is spent computing. Nothing has overrun.`
  return { text, tone, dropped, title }
}
