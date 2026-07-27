import type { GridTrackState } from "../../protocol/schema.ts";
import { ARPEGGIO_PATTERNS } from "./arpeggioPatterns.ts";

/**
 * MB-1b — the PATTERN-MENU ops, as TS reducers.
 *
 * These are the Pattern menu's operations (Clear, Generate ▸ Step Patterns, Generate ▸ Melody
 * Patterns) rewritten as pure functions of one track's pattern, so that under THE FLIP they run in
 * TS and the document keeps exactly ONE writer. They are golden-pinned against the real Swift
 * mutators (`web/fixtures/grid-ops.json`, executed by both `gridOpsGolden.test.ts` and
 * `GridOpGoldenTests.swift`) — the only thing that can actually prove parity.
 *
 * They are also a Phase-8 requirement rather than a nicety: **in the browser there is no
 * `BeatSequencer` at all**, so an op that only exists as a Swift mutator simply does not exist in
 * the companion.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * PORTED FAITHFULLY, INCLUDING THE PARTS THAT LOOK WRONG. A port that silently "fixes" behaviour
 * is not a port, and the golden harness cannot tell you which of the two it did. Each surprise is
 * pinned by a fixture and left for a separate, deliberate decision (MIGRATION.md § MB-1b):
 *
 *   • `clearGrid` does NOT clear `cellLengths` or `wrapSourceStep` — so re-lighting a cleared step
 *     RESURRECTS its old multi-step cell. Nor does it clear tone/sends/flam/chord/glide/reverse/
 *     pre-silence/chop lanes. It clears the steps, the pitch, the accents and five offset lanes,
 *     and that is all (BeatSequencer.clearPattern :17792).
 *   • Pitch is in QUARTER-TONES throughout (2.0 = one semitone).
 *
 * ⚠️ THE MELODY GENERATORS ARE CUT (user decision, 2026-07-13) — do not re-add them.
 * Porting them is what proved they were never designed: all four stepped pitch by exactly one
 * SEMITONE, so "Ascending Scale" was a chromatic run, "Ascending Arpeggio" was a chromatic run every
 * 2nd step, and "Descending Arpeggio" was a FLAT LINE (descending starts at `(octaveRange-1)*12` and
 * the menu passed `octaveRange: 1`). No key, no scale, no chord tones — the names were lies. The
 * app already has per-track tuning, chord cells and a musical keyboard; generated chromatic ramps
 * were not how anyone writes. Cut, not fixed.
 *
 * The `generateInterval` reducer below is likewise on death row: `generateEuclidean` SUBSUMES it
 * (`pulses = stepCount / N` reproduces every "Every Nth" item, `rotation` reproduces both off-beat
 * ones). It stays only until the menu stops calling it (MB-7).
 *
 * NOT EXPRESSIBLE, and therefore deliberately absent (these fields are not in GRID_PATTERN_SHAPE,
 * i.e. TS does not own them): `euclideanBeats`, `euclideanOffset`, `phaseResetStep`, which Swift's
 * `clearPattern` also resets. Both euclid fields are legacy write-only state, and `phaseResetStep`
 * is transient launch state, so the divergence is inert — but it is REAL, and it is the reason
 * "Clear Grid + **Settings**" stays a Swift op (it zeroes LFO depths, which TS also does not own).
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */

const zeros = (n: number): number[] => new Array(n).fill(0);
const ones = (n: number): number[] => new Array(n).fill(1);
const fill = (n: number, v: number): number[] => new Array(n).fill(v);
const falses = (n: number): boolean[] => new Array(n).fill(false);

/**
 * Bresenham/Bjorklund Euclidean onset mask — `k` pulses spread as evenly as
 * possible over `n` steps, always landing an onset on step 0, optionally rotated
 * LATER by `rotation`. Extracted from `applyGenerateEuclidean` so the randomizer
 * (`applyRandomizePattern`) shares the exact same, well-tested distribution.
 */
export function euclid(k: number, n: number, rotation = 0): boolean[] {
  if (n <= 0) return [];
  const kk = Math.max(0, Math.min(Math.trunc(k), n));
  const base = falses(n);
  for (let i = 0; i < n; i++) if (kk > 0 && (i * kk) % n < kk) base[i] = true;
  const r = ((Math.trunc(rotation) % n) + n) % n;
  if (r === 0) return base;
  const out = falses(n);
  for (let i = 0; i < n; i++) out[i] = base[(((i - r) % n) + n) % n] ?? false;
  return out;
}

/**
 * Pattern ▸ Clear ▸ Grid — `BeatSequencer.clearPattern(clearSettings: false)` (:17792).
 *
 * Note what survives, because it is load-bearing and not obvious: `cellLengths` and
 * `wrapSourceStep` are untouched, so a 4-step cell at step 3 leaves `cellLengths[3] == 4` behind
 * and re-lighting step 3 brings the long cell back. That is the native behaviour.
 */
export function applyClearGrid(t: GridTrackState): GridTrackState {
  const n = t.steps.length;
  return {
    ...t,
    steps: falses(n),
    pitchOffsets: zeros(n),
    accentLevels: zeros(n),
    sampleStartMsOffsets: zeros(n),
    sampleEndMsOffsets: zeros(n),
    volumeOffsets: zeros(n),
    mixVolumeOffsets: zeros(n),
    panOffsets: zeros(n),
  };
}

/**
 * Pattern ▸ Generate ▸ Step Patterns — `generateIntervalPattern(interval:startStep:)` (:17898).
 *
 * Lights every `interval`-th step from `startStep`. Clears ONLY steps/pitch/accents first — every
 * other lane (including `cellLengths`) survives, so a newly-lit step inherits whatever cell length
 * was already sitting at that index.
 *
 * `interval <= 0` traps in Swift (`stride(by: 0)`). We clamp instead of reproducing a crash: a
 * menu can only send 1/2/3/4/8, so the clamp is unreachable from the UI and exists so a malformed
 * command cannot hang the page.
 */
export function applyGenerateInterval(
  t: GridTrackState,
  interval: number,
  startStep = 0,
): GridTrackState {
  const n = t.steps.length;
  const step = Math.max(1, Math.trunc(interval));
  const steps = falses(n);
  for (let i = Math.max(0, startStep); i < n; i += step) steps[i] = true;
  return { ...t, steps, pitchOffsets: zeros(n), accentLevels: zeros(n) };
}

/**
 * MB-1f — **EUCLIDEAN generator.** The first Pattern op that was DESIGNED rather than ported.
 *
 * Replaces the seven "Every Nth step" items and subsumes them exactly: `pulses = stepCount / N`
 * reproduces every one, and `rotation` reproduces both off-beat variants. What it ADDS is
 * everything in between — E(3,8), E(5,16), E(7,16) — the distributions that are actually musical
 * and that "every Nth" structurally cannot express.
 *
 * Bresenham form of Bjorklund: step `i` is an onset iff `(i * k) % n < k`, which spreads `k` pulses
 * as evenly as possible across `n` steps. E(3,8) → `x..x..x.`, the tresillo.
 *
 * ⚠️ PHASE CONVENTION, deliberately chosen: this form always lands an onset on step 0. Textbooks
 * quote E(5,8) as `x.xx.xx.`; this yields `x.x.xx.x`, which is the same rhythm ROTATED (identical
 * interval multiset) — and it is the better default for a drum machine, because a generated pattern
 * that does not hit the downbeat is almost never what you wanted. `rotation` moves it anyway.
 *
 * `rotation` shifts the pattern LATER, so rotation 1 on E(4,16) yields 1/5/9/13 — exactly the old
 * "Off-beat (4th Step)" item.
 *
 * Clears steps/pitch/accents and NOTHING else, consistent with every other generator and with
 * Clear: `cellLengths` and the per-cell lanes survive.
 */
export function applyGenerateEuclidean(
  t: GridTrackState,
  pulses: number,
  rotation = 0,
): GridTrackState {
  const n = t.steps.length;
  if (n === 0) return t;
  const steps = euclid(pulses, n, rotation);
  return { ...t, steps, pitchOffsets: zeros(n), accentLevels: zeros(n) };
}

// ────────────────────────────────────────────────────────────────────────────
// TR-RND — the per-track TOOL ops (RANDOMIZE + CLEAR), TS-owned and web-only.
//
// Unlike the generators above these are NOT ported from Swift: `applyClearPattern`
// deliberately wipes MORE than native's parity-locked `clearPattern` (which keeps
// `cellLengths`, resurrecting stale multi-step cells), and `applyRandomizePattern`
// is a fresh, musical generator (Euclidean backbone + metric accents + in-scale
// pitch) that replaces the deleted, naive Swift `randomizePattern`. Both publish
// the whole pattern via the owner write path, so they need no `gridEdit` op and
// no Swift golden fixture (randomize is non-deterministic — it takes an injected
// RNG so the unit test can pin it).
// ────────────────────────────────────────────────────────────────────────────

/**
 * CLEAR (per track) — a genuinely clean slate. Wipes every per-step / per-cell
 * lane AND the cell geometry (`cellLengths`/`wrapSourceStep`), so re-lighting a
 * cleared step can never resurrect an old extended cell (the trap `applyClearGrid`
 * leaves for native parity). Preserves all TRACK settings — sample, gain, volume,
 * pan, tone, sends, playback mode, stepCount — it clears the pattern, not the sound.
 */
export function applyClearPattern(t: GridTrackState): GridTrackState {
  const n = t.steps.length;
  return {
    ...t,
    steps: falses(n),
    cellLengths: ones(n),
    wrapSourceStep: null,
    pitchOffsets: zeros(n),
    accentLevels: zeros(n),
    flamCounts: ones(n),
    glideSteps: falses(n),
    reverseSteps: falses(n),
    preSilenceMsOffsets: zeros(n),
    cellChopIndices: fill(n, -1),
    chordIndices: zeros(n),
    rhythmicOffsetRatios: zeros(n),
    volumeOffsets: zeros(n),
    mixVolumeOffsets: zeros(n),
    panOffsets: zeros(n),
    toneOffsets: zeros(n),
    sampleStartMsOffsets: zeros(n),
    sampleEndMsOffsets: zeros(n),
  };
}

export interface RandomizeOpts {
  /** Target onset fraction (0…1). Default: a random pick in a musical band. */
  density?: number;
  /** ARPEGGIO_PATTERNS id for the pitch scale. Default "pentatonicMinor". */
  scaleId?: string;
  /** Force melodic pitch on/off. Default: derived from the track (explicit signal). */
  melodic?: boolean;
  /**
   * RESERVED for the future musical-randomization menu (amount-of-change morph
   * from the current pattern). Ignored this increment — every roll is a fresh
   * regenerate.
   */
  intensity?: number;
}

/** Scale degrees in SEMITONES from the root, e.g. minor pentatonic → [0,3,5,7,10,…]. */
function scaleDegrees(scaleId: string): number[] {
  const def = ARPEGGIO_PATTERNS.find((p) => p.id === scaleId);
  const intervals = def?.intervals ?? [];
  // The tables list offsets ABOVE the root; the root (0) is implicit.
  return intervals.length ? [0, ...intervals] : [0, 3, 5, 7, 10, 12];
}

/**
 * RANDOMIZE (per track) — a fresh, musical pattern each call. Starts from a clean
 * slate (see `applyClearPattern`) then lays:
 *   • rhythm  — a Euclidean backbone (downbeat-anchored, never clumpy) at a random
 *               musical density, lightly jittered, capped at 2 consecutive onsets;
 *   • accents — metric, not random (downbeats/backbeats hit hardest);
 *   • pitch   — in-scale (default minor pentatonic) small-step walk, but ONLY on a
 *               melodic track (explicit `melodicPitchMode`/midi/instrument signal);
 *               a drum track stays at pitch 0 bar the odd tiny detune;
 *   • flam    — a rare roll.
 * Keyed to `stepCount` (no 16-step truncation). `rng` is injected for testability.
 */
export function applyRandomizePattern(
  t: GridTrackState,
  opts: RandomizeOpts,
  rng: () => number,
): GridTrackState {
  const base = applyClearPattern(t);
  const n = t.stepCount;
  if (n <= 0) return base;

  // --- density → Euclidean backbone ---------------------------------------
  const density =
    opts.density !== undefined
      ? Math.max(0, Math.min(1, opts.density))
      : 0.18 + rng() * 0.32; // musical band ~0.18…0.5
  const k = Math.max(1, Math.min(n, Math.round(density * n)));
  const steps = euclid(k, n, 0); // downbeat-anchored

  // --- light jitter: nudge a few onsets into an empty neighbour -----------
  for (let i = 1; i < n; i++) {
    if (!steps[i] || rng() >= 0.2) continue;
    const dir = rng() < 0.5 ? -1 : 1;
    const j = i + dir;
    if (j <= 0 || j >= n || steps[j]) continue; // never move onto step 0 or a hit
    steps[i] = false;
    steps[j] = true;
  }

  // --- anti-cluster: forbid runs of >2 consecutive onsets -----------------
  let run = 0;
  for (let i = 0; i < n; i++) {
    if (steps[i]) {
      run += 1;
      if (run > 2) steps[i] = false;
    } else {
      run = 0;
    }
  }

  // --- metric weighting for accents ---------------------------------------
  const stepsPerBeat = Math.max(1, Math.round(n / 4)); // 4 beats/bar
  const isBeat = (i: number) => i % stepsPerBeat === 0;
  const isBackbeat = (i: number) => {
    const beat = Math.floor(i / stepsPerBeat);
    return isBeat(i) && (beat === 1 || beat === 3);
  };

  const melodic =
    opts.melodic ??
    (t.melodicPitchMode || t.trackType === "midi" || t.hasInstrument);
  const degrees = scaleDegrees(opts.scaleId ?? "pentatonicMinor");

  const pitchOffsets = zeros(n);
  const accentLevels = zeros(n);
  const flamCounts = ones(n);
  let degreeIdx = 0; // walk position within the scale

  for (let i = 0; i < n; i++) {
    if (!steps[i]) continue;

    // Accents — downbeat/backbeat hit hardest.
    if (i === 0 || isBackbeat(i)) accentLevels[i] = rng() < 0.6 ? 2 : 1;
    else if (isBeat(i)) accentLevels[i] = rng() < 0.4 ? 1 : 0;
    else accentLevels[i] = rng() < 0.3 ? 1 : 0;

    // Pitch — in-scale small-step walk (melodic), else ≈0 (drum).
    if (melodic) {
      const roll = rng();
      if (roll < 0.6) degreeIdx += rng() < 0.5 ? -1 : 1; // small step
      else if (roll < 0.9) {
        /* repeat */
      } else degreeIdx += rng() < 0.5 ? -2 : 2; // occasional leap
      degreeIdx = Math.max(-degrees.length, Math.min(degrees.length - 1, degreeIdx));
      const octave = Math.floor(degreeIdx / degrees.length);
      const within = ((degreeIdx % degrees.length) + degrees.length) % degrees.length;
      const semitones = (degrees[within] ?? 0) + octave * 12;
      pitchOffsets[i] = Math.max(-24, Math.min(24, semitones)) * 2; // quarter-tones
    } else if (rng() < 0.08) {
      pitchOffsets[i] = rng() < 0.5 ? -2 : 2; // rare ±1-semitone detune
    }

    // Flam — a rare roll, never on the downbeat.
    if (i !== 0 && rng() < 0.04) flamCounts[i] = 2 + Math.floor(rng() * 3); // 2…4
  }

  return { ...base, steps, pitchOffsets, accentLevels, flamCounts };
}
