/**
 * The pattern cycle math — a TS mirror of the desktop's LCM clock, for the companion's LCM bar
 * and scheduled scene switches.
 *
 * A track's step is resolved as floor(masterStep · multiplier) % stepCount, so for a speed ratio
 * p/q (lowest terms) the whole pattern realigns to its downbeat every q·stepCount/gcd(p, stepCount)
 * master-steps — `BeatSequencer.calculatePatternLCM` (BeatSequencer.swift:17622-17651), ported
 * exactly, including the empty-session fallback of 16. Locators deliberately do NOT enter the LCM,
 * on either host.
 */
import type { PatternFileJson } from "../persist/patternFile.ts";
import { projectScene, type SceneLetter } from "./sceneProjection.ts";

export function gcd(a: number, b: number): number {
  a = Math.abs(Math.trunc(a));
  b = Math.abs(Math.trunc(b));
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
}

export function lcm(a: number, b: number): number {
  return Math.abs(a * b) / gcd(a, b);
}

/**
 * Recover the speed multiplier as an EXACT p/q in lowest terms — the mirror of
 * `BeatSequencer.rationalMultiplier` (:17675-17688): bounded-denominator search, q ≤ 64, which
 * covers the app's whole fixed ratio set (…2:3, 3:4, 5:4, 16:1…) exactly.
 */
export function rationalMultiplier(m: number): [p: number, q: number] {
  if (!Number.isFinite(m) || m <= 0) return [1, 1];
  let bestP = 1;
  let bestQ = 1;
  let bestErr = Infinity;
  for (let q = 1; q <= 64; q++) {
    const p = Math.max(1, Math.round(m * q));
    const err = Math.abs(m - p / q);
    if (err < bestErr - 1e-12) {
      bestErr = err;
      bestP = p;
      bestQ = q;
      if (err < 1e-9) break;
    }
  }
  const g = gcd(bestP, bestQ);
  return [bestP / g, bestQ / g];
}

/** One track's phrase period in master-steps, or null for an empty (0-step) track. */
export function trackCycleLength(stepCount: number, speedMultiplier: number): number | null {
  if (stepCount <= 0) return null;
  if (!(speedMultiplier > 0)) return stepCount;
  const [p, q] = rationalMultiplier(speedMultiplier);
  return Math.max(1, (q * stepCount) / gcd(p, stepCount));
}

/** The session cycle: LCM over all tracks' effective lengths; 16 when there are none. */
export function patternLCM(tracks: { stepCount: number; speedMultiplier: number }[]): number {
  const lengths = tracks
    .map((t) => trackCycleLength(t.stepCount, t.speedMultiplier))
    .filter((n): n is number => n !== null);
  if (lengths.length === 0) return 16;
  return lengths.reduce((a, b) => lcm(a, b), 1);
}

/** The cycle of a SCENE's projected pattern — what the LCM bar shows and switches align to. */
export function lcmForScene(pattern: PatternFileJson, scene: SceneLetter): number {
  const rows =
    (projectScene(pattern, scene).sectionA as
      | { steps?: boolean[]; speedMultiplier?: number }[]
      | undefined) ?? [];
  return patternLCM(
    rows.map((r) => ({
      stepCount: r.steps?.length ?? 0,
      speedMultiplier: typeof r.speedMultiplier === "number" ? r.speedMultiplier : 1,
    })),
  );
}

/**
 * The boundary a scheduled switch fires at — the desktop's NON-OWNER model
 * (BeatSequencer.swift:12008-12046): the next multiple of lcm(activeLCM, targetLCM) after `step`.
 * Using BOTH scenes' cycles is what lets the target enter on its own step 0 without the pattern
 * anchor the C ABI cannot move: a multiple of the joint LCM is a multiple of every target track's
 * period. (The desktop's park-owner path re-anchors natively instead — that is the sample-exact
 * variant a future ABI increment could adopt via the core's parked-world machinery.)
 */
export function switchBoundary(step: number, activeLCM: number, targetLCM: number): number {
  const period = Math.max(1, lcm(activeLCM, targetLCM));
  return (Math.floor(step / period) + 1) * period;
}
