/**
 * THE LAUNCH QUANTUM — the scale, and whose grid a launch waits on.
 *
 * Two halves, both pure:
 *   · the SCALE, ported from `LaunchQuantize` (DJModeView.swift:96-117);
 *   · the REFERENCE resolution, which is this app's own (D-SL-QUANTUM-01).
 *
 * The donor needed no resolution rule: `armQuantizedLaunch` took the first
 * audibly-playing deck out of a fixed A/B/C. D-SL-MORPH-01 left N strips of one
 * kind each, so "the other deck" names nothing — and the user's two facts
 * decide the shape: usually only TWO decks are active (so the default must cost
 * no setup) and LOOPERS launch too (so a strip spawned mid-set must land on the
 * beat without being configured first).
 */
import type { SceneLetter } from "./sceneProjection.ts";

/** The donor's scale, its own spellings. `cycle` is the reference's full LCM. */
export const LAUNCH_QUANTA = ["off", "1", "2", "4", "8", "16", "cycle"] as const;
export type LaunchQuantum = (typeof LAUNCH_QUANTA)[number];

/** The donor's default (`DJModeManager.globalLaunchQuantize = .cycle`). */
export const DEFAULT_QUANTUM: LaunchQuantum = "cycle";

/** Walk the scale — what the master bar's cycler does on each press. Wraps, so
    `off` is one press past `cycle` rather than a dead end at either edge. */
export function nextQuantum(q: LaunchQuantum): LaunchQuantum {
  return LAUNCH_QUANTA[(LAUNCH_QUANTA.indexOf(q) + 1) % LAUNCH_QUANTA.length]!;
}

/**
 * Steps per boundary, or null when the number is not a constant.
 *
 * `off` and `cycle` are both null and mean OPPOSITE things — `off` has no
 * boundary at all, `cycle` has one the caller must compute from the reference's
 * LCM. The donor's `steps` property collapses them the same way, which is safe
 * only because every caller checks `off` first. `quantumSteps` below is the
 * version that does not require remembering that.
 */
export function quantumStepsRaw(q: LaunchQuantum): number | null {
  switch (q) {
    case "off":
    case "cycle":
      return null;
    default:
      return Number(q);
  }
}

/**
 * Steps per boundary, resolved against the reference's cycle.
 *
 * Returns 0 for `off` — "no boundary, launch now" — so a caller can branch on
 * one number instead of on a null that means two things.
 */
export function quantumSteps(q: LaunchQuantum, referenceCycle: number): number {
  if (q === "off") return 0;
  if (q === "cycle") return referenceCycle > 0 ? referenceCycle : 0;
  const n = Number(q);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A strip, as the resolver needs to see it. Deliberately not the document
    type: this law does not care what an element is, only whether it can be a
    reference — which is exactly why a LOOPER can be one. */
export interface LaunchStrip {
  key: string;
  /** Position in the strip order — the tiebreak, and the reason it is stable. */
  index: number;
  playing: boolean;
  /** This strip's own reference: `auto`, or another strip's key. */
  launchRef: string;
  /** The engine deck behind it, or null for a strip with no deck (a tape). */
  deck: number | null;
}

export interface LaunchReference {
  /** The strip a launch should wait on, or null for "nothing to wait on". */
  key: string | null;
  /** Why — what a strip shows beside `auto` so the choice is never a mystery. */
  reason: "explicit" | "master" | "lowest-playing" | "none";
}

/**
 * WHAT `launcher` LAUNCHES AGAINST (D-SL-QUANTUM-01).
 *
 * Order, and each step earns its place:
 *
 *   1. an EXPLICIT reference on the strip — someone said so, so nothing may
 *      out-vote it. A reference naming a strip that is gone or not playing
 *      falls through rather than pinning the launch to nothing, because a
 *      deleted strip should not silently freeze a pad forever.
 *   2. the SYNC-MASTER strip, if one wears the badge and is playing — the
 *      whole-map answer, and the one `quantize.md` §4.2 recommended.
 *   3. the lowest-numbered PLAYING strip — the automatic answer, and with two
 *      decks running it is simply "the other one". Lowest-numbered rather than
 *      first-started because it does not change under you mid-set.
 *   4. nothing is playing → null, and the caller fires immediately. Waiting on
 *      a stopped grid is how the donor's arm-against-a-stopped-deck surprise
 *      happens; here it is a stated case.
 *
 * The launcher never references ITSELF: it is not running yet, so its boundary
 * would never arrive.
 */
export function resolveLaunchReference(
  strips: readonly LaunchStrip[],
  launcherKey: string,
  syncMasterKey: string | null,
): LaunchReference {
  const launcher = strips.find((s) => s.key === launcherKey);
  const candidates = strips
    .filter((s) => s.key !== launcherKey && s.playing)
    .sort((a, b) => a.index - b.index);

  if (launcher && launcher.launchRef !== "auto") {
    const named = candidates.find((s) => s.key === launcher.launchRef);
    if (named) return { key: named.key, reason: "explicit" };
    // Named but unusable — fall through to auto rather than refusing to launch.
  }
  if (syncMasterKey && syncMasterKey !== launcherKey) {
    const master = candidates.find((s) => s.key === syncMasterKey);
    if (master) return { key: master.key, reason: "master" };
  }
  const lowest = candidates[0];
  if (lowest) return { key: lowest.key, reason: "lowest-playing" };
  return { key: null, reason: "none" };
}

/** What a strip shows beside its reference, so `auto` is legible. */
export function launchReferenceLabel(ref: LaunchReference, nameOf: (key: string) => string): string {
  switch (ref.reason) {
    case "explicit":
      return nameOf(ref.key!);
    case "master":
      return `${nameOf(ref.key!)} (master)`;
    case "lowest-playing":
      return `${nameOf(ref.key!)} (auto)`;
    case "none":
      return "nothing playing — launches now";
  }
}

/** The cycle a `cycle` quantum resolves against: the REFERENCE's, not the
    launcher's. Two strips with different patterns do not share a boundary, and
    taking the launcher's own would arm against a grid nobody is playing. */
export function referenceCycleFor(
  cycleOf: (key: string, scene: SceneLetter) => number,
  ref: LaunchReference,
  sceneOf: (key: string) => SceneLetter,
): number {
  return ref.key ? cycleOf(ref.key, sceneOf(ref.key)) : 0;
}
