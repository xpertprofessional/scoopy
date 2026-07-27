/**
 * modShape — the modulation SHAPE math, mirrored from the native engine (MOD-4).
 *
 * Pure. No DOM, no React, no canvas. The Mod Lab draws from this; `modMath.ts` computes
 * what the shape DOES to a destination parameter.
 *
 * Every function here is a faithful port of `ScoopyLoops/NativeAudioEngineCore.cpp`:
 *   lfoWaveValue                 :76-95     → lfoWaveValue()
 *   evalBreakpointPreSustain     :101-116   → evalEnvelopePreSustain()
 *   evalBreakpointRelease        :121-139   → evalEnvelopeRelease()
 *   breakpointTotalMs / SustainMs (MOD-2)   → envelopeTotalMs() / envelopeSustainMs()
 *
 * Faithful means faithful — including the quirks. If native clamps symmetry to [0.001, 0.999]
 * for a triangle but NOT for a square, so do we. `modShape.test.ts` pins the ports against
 * values read out of the C++.
 *
 * Types are structural on purpose: the schema's `ModChannelState` satisfies `ShapeChannel`
 * once MOD-3 widens it, but this module does not import the schema, so it can be tested and
 * reasoned about on its own.
 */

export type LfoWaveformName = "sine" | "triangle" | "square" | "saw" | "random";

export type ModChannelKind = "lfo" | "envFollower" | "envelope";

/** One MSEG breakpoint. `timeMs` is the segment length INTO this node, not an absolute time. */
export interface EnvNode {
  timeMs: number;
  /** 0…1 as stored. A bipolar envelope reinterprets this as −1…1 via `unipolarToBipolar`. */
  value: number;
  /** Power-curve exponent applied as pow(frac, max(0.01, curve)). 1 = linear. */
  curve: number;
}

/** The subset of a mod channel the shape math needs. */
export interface ShapeChannel {
  type: ModChannelKind;
  waveform: string;
  /** LEGACY — superseded by `slant` (MOD-10). Kept on the wire; no longer shapes anything. */
  symmetry: number;
  phaseOffset: number;
  // --- MOD-12 AGITATION: these four shape the random step-and-ramp (GRM model) ---
  slant: number;
  ease: number;
  jitter: number;
  cyclic: number;
  /** Segment length in grid steps (resolved effective cycle) — a new random target each `stepsPerCycle`. */
  stepsPerCycle?: number;
  /** Pattern LCM length in steps — sets the repeat period L = round(lcmSteps / stepsPerCycle). */
  lcmSteps?: number;
  // --- MOD-11 SHAPES (retired; still on the wire, no longer drawn — inert) ---
  warp?: number;
  curve?: number;
  fold?: number;
  quant?: number;
  chaos?: number;
  stageCount?: number;
  stageLevels?: readonly number[];
  stageGlide?: number;
  /** Per-channel master depth 0…1. At 0 the engine silences the channel, so the shape draws flat. */
  depth: number;
  envelopeNodes: EnvNode[];
  sustainNodeIndex: number;
  bipolar: boolean;
  /** Which channel this is — the jitter contour is seeded from it, so M1 and M3 differ. */
  channelIndex?: number;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Bipolar envelope mapping (MOD-2, user decision): a node's stored 0…1 value is reinterpreted
 * so that **0.5 is the centre** — 0 → −1, 0.5 → 0, 1 → +1. Chosen over "idle at −1" because it
 * lets an envelope push a parameter DOWN and then up, and leaves no discontinuity when the
 * release finishes (the envelope simply returns to its own first-node value).
 */
export const unipolarToBipolar = (v: number) => v * 2 - 1;

/**
 * Mirror of `lfoWaveValue` (NativeAudioEngineCore.cpp:76-95). Bipolar, −1…1.
 *
 * `phase` is NOT pre-wrapped — native does `phase - floor(phase)`, so callers may pass
 * `rawPhase + phaseOffset` and let it wrap, exactly as the engine does.
 *
 * `randVal` is the engine's per-cycle sample-and-hold value; a caller drawing a static shape
 * has no meaningful random stream, so `random` renders as a flat line at `randVal` (default 0).
 */
export function lfoWaveValue(
  phase: number,
  waveform: string,
  symmetry: number,
  randVal = 0,
): number {
  const p = phase - Math.floor(phase); // 0–1
  switch (waveform) {
    case "sine":
      return Math.sin(2 * Math.PI * p);
    case "triangle": {
      // Native clamps symmetry here (and only here) to avoid a divide-by-zero at the extremes.
      const s = clamp(symmetry, 0.001, 0.999);
      return p < s ? (p / s) * 2 - 1 : ((1 - p) / (1 - s)) * 2 - 1;
    }
    case "square":
      // NOTE: native does NOT clamp symmetry for square — at 0 it is permanently −1. Mirrored.
      return p < symmetry ? 1 : -1;
    case "saw":
      return 2 * (p - 0.5);
    case "random":
      return randVal;
    case "envelopeFollower":
      return 0; // native returns 0 — the follower value arrives by a different path
    default:
      return 0;
  }
}

/**
 * `applyEase` — the ENVELOPE-segment curve macro (mirrors the C++ helper the breakpoint envelope
 * uses). The LFO no longer calls it (the LFO is the Agitation engine below); it survives for the
 * envelope's `envEase`. ease ≥ 0 rounds a ramp toward a cosine; ease < 0 hardens it toward a step.
 */
export function applyEase(u: number, ease: number, slant: number): number {
  u = clamp(u, 0, 1);
  if (ease >= 0) {
    const smooth = (1 - Math.cos(Math.PI * u)) * 0.5;
    return u + (smooth - u) * clamp(ease, 0, 1);
  }
  const hard = clamp(-ease, 0, 1);
  const c = 1 / Math.max(0.02, 1 - hard); // 1 → 50
  const thr = 0.5 - clamp(slant, -1, 1) * 0.4 * hard;
  return clamp(0.5 + (u - thr) * c, 0, 1);
}

// ─── MOD-12 AGITATION — the LFO is a grid-locked random step-and-ramp engine ────────────────────
//
// Byte-faithful port of the C++ `agitationValue` family (NativeAudioEngineCore.cpp). GRM Atelier
// model: each segment picks a new random target and ramps to it. Ease shapes the ramp (smooth↔step),
// Slant its up/down asymmetry, Cyclic morphs random↔alternating (periodic LFO), Jitter loosens the
// step timing. Seeded by segment index mod L (= lcmSteps/seg), so it repeats at the LCM boundary.

const U64 = (1n << 64n) - 1n;
const TWO53 = 9007199254740992; // 2^53

/** splitmix64 — mirrors the C++ hash exactly (all products masked to 64 bits). */
function splitmix64(x: bigint): bigint {
  x = (x + 0x9e3779b97f4a7c15n) & U64;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & U64;
  return (x ^ (x >> 31n)) & U64;
}

/** Deterministic value in −1…1 from (channel, index≥0, salt). Mirrors C++ `agitationRand`. */
function agitationRand(channel: number, index: number, salt: bigint): number {
  const seed =
    ((BigInt(index) * 0x9e3779b97f4a7c15n) & U64) ^
    ((BigInt(channel + 1) * 0xd1b54a32d192ed03n) & U64) ^
    salt;
  const h = splitmix64(seed & U64);
  return (Number(h >> 11n) / TWO53) * 2 - 1;
}

/** The ramp curve [EASE]: 0 sine-smooth · +1 step at start (S&H) · −1 step at end. Mirror of C++. */
export function easeShape(u: number, ease: number): number {
  u = clamp(u, 0, 1);
  const e = clamp(ease, -1, 1);
  const w = Math.max(1e-4, 1 - Math.abs(e)); // window width (never 0)
  const a = e >= 0 ? 0 : 1 - w; // window start slides to the end as e→−1
  const b = a + w;
  if (u <= a) return 0;
  if (u >= b) return 1;
  return (1 - Math.cos((Math.PI * (u - a)) / w)) * 0.5;
}

/** Warp local ramp phase asymmetrically by direction [SLANT]. slant 0 = identity. Mirror of C++. */
export function slantWarp(u: number, slant: number, dir: number): number {
  const s = clamp(slant, -1, 1);
  if (s === 0) return u;
  return Math.pow(clamp(u, 0, 1), Math.pow(2, s * dir));
}

/** The mod's period in grid steps — the ModCanvas draws exactly this many cells. */
export function agitationLoopSteps(periodSteps: number): number {
  return Math.max(1, Math.round(periodSteps));
}

/** The CYCLIC path — one shaped wave over the period. Mirror of C++ `cyclicWaveShape`. */
export function cyclicWaveShape(phase: number, ease: number, slant: number): number {
  phase -= Math.floor(phase);
  const r = clamp(0.5 + clamp(slant, -1, 1) * 0.49, 0.02, 0.98);
  if (phase < r) return -1 + 2 * easeShape(phase / r, ease); // rising half
  return 1 - 2 * easeShape((phase - r) / (1 - r), ease); // falling half
}

/** The RANDOM path — a per-step S&H sequence of period `n`. Mirror of C++ `randomPathValue`. */
export function randomPathValue(
  gridPos: number,
  n: number,
  ease: number,
  slant: number,
  jitter: number,
  channel: number,
): number {
  const jit = clamp(jitter, 0, 1);
  const tgt = (i: number) => agitationRand(channel, ((i % n) + n) % n, 0n);
  const bnd = (i: number) => i + jit * 0.49 * agitationRand(channel, ((i % n) + n) % n, 0x51edn);
  let s = Math.floor(gridPos);
  while (bnd(s) > gridPos) s--;
  while (bnd(s + 1) <= gridPos) s++;
  const u = clamp((gridPos - bnd(s)) / Math.max(1e-6, bnd(s + 1) - bnd(s)), 0, 1);
  const tA = tgt(s);
  const tB = tgt(s + 1);
  const dir = tB >= tA ? 1 : -1;
  return tA + (tB - tA) * easeShape(slantWarp(u, slant, dir), ease);
}

/**
 * One Agitation sample in −1…1. A per-step value sequence of period `periodSteps` (the "Length");
 * `cyclic` crossfades one smooth wave across the n cells (1) with n random per-step values (0). Both
 * shaped by ease/slant; jitter loosens the random path's timing. Repeats every n. Byte-faithful to C++.
 */
export function agitationValue(
  gridPos: number,
  periodSteps: number,
  ease: number,
  slant: number,
  cyclic: number,
  jitter: number,
  channel: number,
): number {
  const n = Math.max(1, Math.round(periodSteps));
  const cyc = clamp(cyclic, 0, 1);
  let phaseC = gridPos / n;
  phaseC -= Math.floor(phaseC);
  const cyclicV = cyclicWaveShape(phaseC, ease, slant);
  if (cyc >= 1) return cyclicV;
  const randomV = randomPathValue(gridPos, n, ease, slant, jitter, channel);
  return randomV + (cyclicV - randomV) * cyc;
}

/**
 * The LFO's output at an absolute grid position (steps), with the channel's period / shape /
 * phase-offset / depth applied. The single evaluation the drawing uses across all cells/rows.
 */
export function lfoValueAt(ch: ShapeChannel, gridPos: number): number {
  const n = Math.max(1, Math.round(ch.stepsPerCycle ?? 8));
  const shift = (ch.phaseOffset ?? 0) * n; // phase offsets by a fraction of the period
  const d = clamp(ch.depth, 0, 1);
  return agitationValue(gridPos + shift, n, ch.ease, ch.slant, ch.cyclic, ch.jitter, ch.channelIndex ?? 0) * d;
}

/** Total length of the envelope's drawn timeline. Node 0 contributes nothing (no segment into it). */
export function envelopeTotalMs(nodes: readonly EnvNode[]): number {
  let t = 0;
  for (let i = 1; i < nodes.length; i++) t += Math.max(0, nodes[i]!.timeMs);
  return t;
}

/** Cumulative time up to the sustain node — where the pre-sustain walk ends and the hold begins. */
export function envelopeSustainMs(nodes: readonly EnvNode[], sustainNodeIndex: number): number {
  const sus = clamp(sustainNodeIndex, 0, Math.max(0, nodes.length - 1));
  let t = 0;
  for (let i = 1; i <= sus; i++) t += Math.max(0, nodes[i]!.timeMs);
  return t;
}

/**
 * Mirror of `evalBreakpointPreSustain` (:101-116). Walks node[0] → node[sustainIndex] and holds
 * at the sustain value once `elapsedMs` passes it. Returns the raw stored value (0…1).
 */
export function evalEnvelopePreSustain(
  nodes: readonly EnvNode[],
  sustainNodeIndex: number,
  elapsedMs: number,
): number {
  const n = nodes.length;
  if (n <= 0) return 0;
  const sus = clamp(sustainNodeIndex, 0, n - 1);
  let t = 0;
  for (let i = 1; i <= sus; i++) {
    const seg = Math.max(0, nodes[i]!.timeMs);
    if (seg > 0 && elapsedMs < t + seg) {
      const frac = clamp((elapsedMs - t) / seg, 0, 1);
      const shaped = Math.pow(frac, Math.max(0.01, nodes[i]!.curve));
      return nodes[i - 1]!.value + (nodes[i]!.value - nodes[i - 1]!.value) * shaped;
    }
    t += seg;
  }
  return nodes[sus]!.value; // reached / holding the sustain node
}

/**
 * Mirror of `evalBreakpointRelease` (:121-139). Walks node[sustainIndex] → node[last] over
 * `releaseMs`, starting from `startValue` (the value captured when the gate closed — which is
 * what makes an early gate-close release from wherever the envelope actually was).
 */
export function evalEnvelopeRelease(
  nodes: readonly EnvNode[],
  sustainNodeIndex: number,
  releaseMs: number,
  startValue: number,
): { value: number; finished: boolean } {
  const n = nodes.length;
  if (n <= 0) return { value: 0, finished: true };
  const sus = clamp(sustainNodeIndex, 0, n - 1);
  if (sus >= n - 1) return { value: nodes[n - 1]!.value, finished: true }; // no release segments
  let t = 0;
  for (let i = sus + 1; i < n; i++) {
    const seg = Math.max(0, nodes[i]!.timeMs);
    if (seg > 0 && releaseMs < t + seg) {
      const frac = clamp((releaseMs - t) / seg, 0, 1);
      const shaped = Math.pow(frac, Math.max(0.01, nodes[i]!.curve));
      const from = i === sus + 1 ? startValue : nodes[i - 1]!.value;
      return { value: from + (nodes[i]!.value - from) * shaped, finished: false };
    }
    t += seg;
  }
  return { value: nodes[n - 1]!.value, finished: true };
}

/**
 * The output RANGE this channel can produce — what a destination's sweep band is built from,
 * and the single most load-bearing asymmetry in the whole design:
 *
 *   • LFO             → −1…1 (bipolar, symmetric around the base value)
 *   • Envelope        → 0…1, or −1…1 when `bipolar`
 *   • Env-Follower    → 0…1 (unipolar — it only ever pushes one way)
 *
 * So a follower's sweep band is ASYMMETRIC about the base value while an LFO's is centred.
 * Showing that honestly is the point of the band.
 *
 * Scaled by the channel's master `depth`, because the engine applies depth at the SOURCE
 * (`NativeAudioEngineCore.cpp` mod loop) — at depth 0 the channel genuinely emits nothing.
 */
export function channelRange(ch: ShapeChannel): { lo: number; hi: number } {
  const d = clamp(ch.depth, 0, 1);
  // `-0` is a real hazard here, not pedantry: at depth 0, `-d` is negative zero, which survives
  // arithmetic into band geometry and compares false against 0 under Object.is.
  const neg = d === 0 ? 0 : -d;
  switch (ch.type) {
    case "lfo":
      return { lo: neg, hi: d };   // the macro LFO is always bipolar
    case "envelope":
      return ch.bipolar ? { lo: neg, hi: d } : { lo: 0, hi: d };
    case "envFollower":
      return { lo: 0, hi: d };
  }
}

/**
 * Sample the channel's STATIC shape for drawing: `points` values in −1…1, left to right.
 *
 * LFO      → one full cycle, with `phaseOffset` baked in (so a playhead at the engine's RAW
 *            phase lands on the correct y — which is exactly why the native phase read-back
 *            publishes raw phase, not phase+offset).
 * Envelope → the whole MSEG across its cumulative timeline, sustain segment included.
 * Follower → null: it has no static shape. The Lab scrolls a history for it instead, because
 *            for a follower the history IS the shape. Inventing a curve here would be a lie.
 */
export function sampleShape(ch: ShapeChannel, points: number): Float64Array | null {
  if (ch.type === "envFollower") return null;
  const out = new Float64Array(points);
  const d = clamp(ch.depth, 0, 1);

  if (ch.type === "lfo") {
    // MOD-12: draw ONE period of the sequence (its n cells). Single-row form (strip thumbnails); the
    // Mod Lab wraps the same n cells into a step grid via `lfoValueAt` directly.
    const n = Math.max(1, Math.round(ch.stepsPerCycle ?? 8));
    for (let i = 0; i < points; i++) {
      out[i] = lfoValueAt(ch, (i / (points - 1)) * n);
    }
    return out;
  }

  // Envelope: walk the drawn timeline. Past the sustain node the pre-sustain walk holds, and the
  // release segments continue from the sustain value — which is what the editor draws.
  const nodes = ch.envelopeNodes;
  const total = envelopeTotalMs(nodes);
  if (total <= 0 || nodes.length === 0) return out; // degenerate → flat
  const sustainMs = envelopeSustainMs(nodes, ch.sustainNodeIndex);
  const sustainValue = evalEnvelopePreSustain(nodes, ch.sustainNodeIndex, sustainMs);

  for (let i = 0; i < points; i++) {
    const ms = (i / (points - 1)) * total;
    const raw =
      ms <= sustainMs
        ? evalEnvelopePreSustain(nodes, ch.sustainNodeIndex, ms)
        : evalEnvelopeRelease(nodes, ch.sustainNodeIndex, ms - sustainMs, sustainValue).value;
    out[i] = (ch.bipolar ? unipolarToBipolar(raw) : raw) * d;
  }
  return out;
}
