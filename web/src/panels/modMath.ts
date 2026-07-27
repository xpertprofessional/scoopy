/**
 * modMath — what a modulator DOES to a destination parameter (MOD-4).
 *
 * Pure. This is what makes the sweep band on a track-row slider *truthful*: the band spans the
 * range the modulation actually covers, and the dot sits at the value the engine actually
 * produces. Get this wrong and the UI lies confidently.
 *
 * Ported from the per-voice application block, `NativeAudioEngineCore.cpp:5798-5831`, plus the
 * depth scaling the facade applies on the way down (`AudioEngineFacade.swift:2023-2121`).
 *
 * ── THE FOUR THINGS THAT ARE NOT OBVIOUS ────────────────────────────────────────────────────
 *
 * 1. Targets do NOT share a formula. pitch/pan/tone are ADDITIVE; volume/gain are MULTIPLICATIVE
 *    (`base * (1 + Σ…)`), and their clamp floor of 0 means a big negative depth mutes rather than
 *    inverting.
 *
 * 2. Depths are pre-scaled before the engine sees them: pitch ×24 (→ semitones), filter ×25
 *    (→ tone units), everything else RAW. The model's `hardcodedAmount` of 0.5 for
 *    volume/pan/gain is never consulted by the engine — mirror the ENGINE, not the model.
 *
 * 3. The env-follower ×2 volume boost (`envVolScale`) applies ONLY to channels M1/M2 — the
 *    C++ multiplies `lfo1Val`/`lfo2Val` by it but adds `env3Val`/`env4Val` raw (:5804-5807).
 *    A follower on M3 is quietly half as strong as the same follower on M1. That is the engine's
 *    behaviour today, so it is ours.
 *
 * 4. `volModMax` is GLOBAL, not per-channel: 3.0 if *either* M1 or M2 is a follower, else 2.0
 *    (:3905-3907). So arming a follower on M1 widens the headroom of every other channel's
 *    volume modulation on every track.
 */

import { channelRange, type ModChannelKind, type ShapeChannel } from "./modShape.ts";

/** Mod destinations, matching `Track.LfoModifierTarget` raw order (Track.swift:680). */
export type ModTarget =
  | "pitch"
  | "filter"
  | "volume"
  | "pan"
  | "sampleStart"
  | "sampleEnd"
  | "gain"
  | "freeRate";

/** One mapped routing on a track: which channel drives which target, and how hard (−1…1). */
export interface Routing {
  channelIndex: number; // 0…3 → M1…M4
  target: ModTarget;
  depth: number; // −1…1 as the user set it (pre-scaling)
}

/** How the engine combines a target's modulation with its base value. */
export type TargetKind = "additive" | "multiplicative";

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * The facade's depth pre-scaling (AudioEngineFacade.swift:2098-2121).
 *
 * For M1/M2 this is really the per-track modifier AMOUNT (defaulting to 24/25); M3/M4 use the
 * literals unconditionally. The web has no amount editor, so the defaults are exact for every
 * routing the web can create — but if a session carries a hand-edited M1 amount, our band is
 * scaled by the default while the engine uses theirs. Known, bounded, and only reachable from
 * the native UI. (Closing it means shipping the amounts in `ModSlotState`.)
 */
export function depthScale(target: ModTarget): number {
  switch (target) {
    case "pitch":
      return 24; // semitones
    case "filter":
      return 25; // tone units
    default:
      return 1; // volume / pan / gain / start / end / freeRate pass RAW
  }
}

export function targetKind(target: ModTarget): TargetKind {
  return target === "volume" || target === "gain" ? "multiplicative" : "additive";
}

/** The clamp the engine applies to each target's final value. */
export function targetClamp(target: ModTarget, volModMax: number): { lo: number; hi: number } {
  switch (target) {
    case "volume":
    case "gain":
      return { lo: 0, hi: volModMax }; // clamps the MULTIPLIER, not the value
    case "pan":
      return { lo: -1, hi: 1 };
    case "filter":
      return { lo: -100, hi: 100 };
    default:
      return { lo: -Infinity, hi: Infinity }; // pitch is unclamped (feeds pow(2, x/12))
  }
}

/**
 * `volModMax` — 3.0 when M1 or M2 is an env-follower, else 2.0 (:3905-3907). Global by design
 * (see header note 4): pass the full 4-channel array, not one channel.
 */
export function volModMax(channelTypes: readonly ModChannelKind[]): number {
  const followerOnM1orM2 =
    channelTypes[0] === "envFollower" || channelTypes[1] === "envFollower";
  return followerOnM1orM2 ? 3 : 2;
}

/**
 * The env-follower ×2 volume/gain boost — ONLY on M1/M2 (header note 3).
 * Applies to the `volume` and `gain` targets only; pan/tone/pitch never get it.
 */
export function envVolScale(channelIndex: number, kind: ModChannelKind): number {
  return channelIndex < 2 && kind === "envFollower" ? 2 : 1;
}

/**
 * The modulation term a single routing contributes, given its channel's instantaneous output.
 * `channelValue` is the engine's live per-channel value (already depth-scaled at the source —
 * this is exactly what HotFrame's `modChannel0…3` carries, so feed it straight in).
 */
export function routingTerm(
  r: Routing,
  channelValue: number,
  kind: ModChannelKind,
): number {
  const scale = depthScale(r.target);
  const boost =
    r.target === "volume" || r.target === "gain" ? envVolScale(r.channelIndex, kind) : 1;
  return channelValue * r.depth * scale * boost;
}

/**
 * The live modulated value of a parameter — what the dot on the sweep band shows.
 *
 * `base` is in the target's own units (volume 0…1+, pan −1…1, tone −100…100, pitch semitones).
 * `channelValues[i]` is M(i+1)'s current output; `channelTypes[i]` its type.
 *
 * Multiplicative targets return `base * clamp(1 + Σterms, 0, volModMax)`; additive ones return
 * `clamp(base + Σterms, …)`. Pitch returns the modulated SEMITONE value (the engine turns that
 * into a rate via pow(2, x/12) — the UI wants semitones, so we stop here).
 */
export function modulatedValue(
  base: number,
  target: ModTarget,
  routings: readonly Routing[],
  channelValues: readonly number[],
  channelTypes: readonly ModChannelKind[],
): number {
  const forTarget = routings.filter((r) => r.target === target);
  if (forTarget.length === 0) return base;

  let sum = 0;
  for (const r of forTarget) {
    const v = channelValues[r.channelIndex] ?? 0;
    const kind = channelTypes[r.channelIndex] ?? "lfo";
    sum += routingTerm(r, v, kind);
  }

  const max = volModMax(channelTypes);
  const { lo, hi } = targetClamp(target, max);

  if (targetKind(target) === "multiplicative") {
    return base * clamp(1 + sum, lo, hi);
  }
  return clamp(base + sum, lo, hi);
}

/**
 * The SWEEP BAND: the full range the modulation can drive this parameter through, given every
 * routing on it. This is the translucent span drawn on the slider — and dragging its edge is how
 * depth gets edited (MOD-7).
 *
 * The extremes are found by pushing every channel to the end of ITS range (see
 * `channelRange` — bipolar for an LFO, unipolar for an envelope/follower) in the direction that
 * maximises, then minimises, the sum. Because each routing's term is linear in the channel's
 * output, the sum's extremes occur at the channels' extremes — no sampling needed.
 *
 * Returns the band in the target's own units. `min === max === base` means "no modulation here".
 */
export function sweepRange(
  base: number,
  target: ModTarget,
  routings: readonly Routing[],
  channels: readonly ShapeChannel[],
): { min: number; max: number } {
  const forTarget = routings.filter((r) => r.target === target);
  if (forTarget.length === 0) return { min: base, max: base };

  const types = channels.map((c) => c.type);
  let sumLo = 0;
  let sumHi = 0;

  for (const r of forTarget) {
    const ch = channels[r.channelIndex];
    if (!ch) continue;
    const kind = types[r.channelIndex] ?? "lfo";
    const { lo, hi } = channelRange(ch);
    // The routing's own depth may be negative, which SWAPS which channel extreme is the max.
    const a = routingTerm(r, lo, kind);
    const b = routingTerm(r, hi, kind);
    sumLo += Math.min(a, b);
    sumHi += Math.max(a, b);
  }

  const max = volModMax(types);
  const { lo, hi } = targetClamp(target, max);

  if (targetKind(target) === "multiplicative") {
    return {
      min: base * clamp(1 + sumLo, lo, hi),
      max: base * clamp(1 + sumHi, lo, hi),
    };
  }
  return { min: clamp(base + sumLo, lo, hi), max: clamp(base + sumHi, lo, hi) };
}

/**
 * Inverse of the band's upper/lower edge → the depth that would put the edge THERE. This is what
 * an edge-drag writes (MOD-7).
 *
 * Only defined for a single routing on the target — with two or more, the split between them is
 * ambiguous, and MOD-7 disables edge-drag in that case and sends the user to the M-slots. Returns
 * null when it cannot be solved (no routing, zero-width channel range, zero base on a
 * multiplicative target).
 */
export function depthForEdge(
  base: number,
  target: ModTarget,
  routing: Routing,
  channel: ShapeChannel,
  edgeValue: number,
): number | null {
  const kind = channel.type;
  const { lo, hi } = channelRange(channel);
  // Solve at whichever channel extreme has the larger magnitude — the edge the user is dragging.
  const extreme = Math.abs(hi) >= Math.abs(lo) ? hi : lo;
  if (extreme === 0) return null; // depth 0 channel: nothing to solve against

  const scale = depthScale(target);
  const boost =
    target === "volume" || target === "gain" ? envVolScale(routing.channelIndex, kind) : 1;
  const unit = extreme * scale * boost; // the term at depth = 1
  if (unit === 0) return null;

  let neededSum: number;
  if (targetKind(target) === "multiplicative") {
    if (base === 0) return null; // base*(1+x) can never leave 0
    neededSum = edgeValue / base - 1;
  } else {
    neededSum = edgeValue - base;
  }

  return clamp(neededSum / unit, -1, 1);
}
