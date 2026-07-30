/**
 * DECK TRANSPORT LAWS — the arithmetic behind the classic deck rows, ported from
 * the donor and kept pure so it can be pinned without an audio device.
 *
 * The precedent is deliberate: the donor does the same thing with
 * `LocatorRepeatMath.swift` (31 lines of pure reference math beside a 20k-line
 * sequencer), and this tier already does it with `patternClock.ts`. A law that
 * lives inside a store method can only be tested through the store, and the
 * store needs a running engine — so the law would go untested exactly where it
 * is subtlest (negative carries, cycle wraps).
 *
 * Sources, all `../../../scoopyloops/ScoopyLoops/`:
 *   · `BeatSequencer.swift:3573-3587`   playOnce()
 *   · `BeatSequencer.swift:4220-4225`   the stopTargetStep consumption
 *   · `BeatSequencer.swift:20390-20427` shiftBeatRepeat(by:)
 */

/**
 * ONE-SHOT: which step the deck should stop itself at.
 *
 * Two cases, and the difference between them is the whole feature:
 *   · STOPPED  → `cycle - 1`, i.e. one full cycle from the top.
 *   · PLAYING  → the end of the cycle ALREADY IN FLIGHT, so pressing ▸¹ mid-loop
 *     lets the current pass finish instead of restarting it.
 *
 * `cycle <= 0` means there is no pattern to play once (the donor's
 * `guard lcmLength > 0`), and returns null rather than arming a stop at -1,
 * which would stop the deck instantly.
 */
export function oneShotStopStep(
  cycle: number,
  playing: boolean,
  currentStep: number,
): number | null {
  if (!Number.isFinite(cycle) || cycle <= 0) return null;
  if (!playing) return cycle - 1;
  const step = Number.isFinite(currentStep) && currentStep > 0 ? currentStep : 0;
  return (Math.floor(step / cycle) + 1) * cycle - 1;
}

/** A beat-repeat window's position: an absolute start step plus, at subdivisions
    above 1, which sub-cell of that step the window opens on. */
export interface BeatRepeatWindow {
  startStep: number;
  startSubcell: number;
}

/**
 * Walk a latched beat-repeat window by `delta` slots.
 *
 * At `subdivision === 1` a slot is a whole step. Above it, a slot is a SUB-CELL
 * and whole steps are carried — that is what makes the micro stutter walk
 * smoothly instead of jumping a step at a time.
 *
 * ⚠️ The carry is a FLOOR, not a truncation (the donor's `.rounded(.down)`).
 * `Math.trunc(-1 / 4)` is 0 and would leave the sub-cell negative; `Math.floor`
 * gives -1 and lands the sub-cell back in 0..sub-1. That single character is the
 * difference between walking left smoothly and sticking at the step boundary.
 *
 * A negative start wraps by a WHOLE `cycle`, which leaves the audible fold
 * exactly where it was — the engine reads the start modulo the pattern — while
 * keeping the number non-negative, because the wire clamps negatives to 0.
 * With no cycle to wrap by, it clamps at 0 rather than going negative.
 */
export function shiftBeatRepeatWindow(
  window: BeatRepeatWindow,
  delta: number,
  subdivision: number,
  cycle: number,
): BeatRepeatWindow {
  const sub = Math.max(1, Math.floor(subdivision) || 1);
  let startStep = window.startStep;
  let startSubcell = window.startSubcell;

  if (sub > 1) {
    const raw = startSubcell + delta;
    const carry = Math.floor(raw / sub);
    startSubcell = raw - carry * sub;
    startStep += carry;
  } else {
    startStep += delta;
    startSubcell = 0;
  }

  if (startStep < 0) {
    if (cycle > 0) {
      // Modulo, expressed so a start many cycles negative still lands in range.
      startStep = ((startStep % cycle) + cycle) % cycle;
    } else {
      startStep = 0;
    }
  }
  return { startStep, startSubcell };
}

/**
 * TRANSPOSE ⊕ SYNC — the donor's TP-mode exclusivity, as one function.
 *
 * In the donor this is spread across three call sites in
 * `WebToolbarBinding.handleDeckSectionCommand` (:398-441): `setSync` clears
 * transpose, `toggleTranspose` clears sync, and `cyclePulse` turns sync ON via
 * `setSync`. All three are gated on `DJModeManager.shared.pitchModeEnabled` —
 * a GLOBAL flag there, per-strip here (D-SL-MORPH-01 retired the fixed deck
 * slots the global belonged to, so a per-strip switch is the closest honest
 * successor; ruled by the user 2026-07-31).
 *
 * With pitch mode OFF both may be on at once, exactly as in the donor.
 */
export function applyPitchModeExclusion(
  next: { syncEnabled: boolean; transposeEnabled: boolean },
  pitchMode: boolean,
  changed: "sync" | "transpose",
): { syncEnabled: boolean; transposeEnabled: boolean } {
  if (!pitchMode) return next;
  if (changed === "sync" && next.syncEnabled && next.transposeEnabled)
    return { ...next, transposeEnabled: false };
  if (changed === "transpose" && next.transposeEnabled && next.syncEnabled)
    return { ...next, syncEnabled: false };
  return next;
}

/** Semitone bounds on the deck's TR control — the donor's
    `min(max(t ± 1, -12), 12)` (WebToolbarBinding.swift:444-446). */
export const TRANSPOSE_MIN = -12;
export const TRANSPOSE_MAX = 12;

export function nudgeTranspose(semitones: number, delta: number): number {
  return Math.min(Math.max(semitones + delta, TRANSPOSE_MIN), TRANSPOSE_MAX);
}
