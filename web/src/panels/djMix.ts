/**
 * DJ mix laws — TS mirror of the pure statics on NativeDJCoordinator
 * (ScoopyLoops/DJModeView.swift): crossfadeGainLaw, xmixCarveLaw,
 * busStretchRatio / deckVarispeedRatio / deckMasterSpeedRatio, and the
 * BeatSequencer.applyDJMasterSync tempo computation (the "smart BPM" math).
 *
 * P6-01 golden-fixture surface (docs/migration/panels/djmode.md §6):
 * web/fixtures/dj-mix.json is executed against THIS module by
 * djMixGolden.test.ts and against the real Swift code by DJMixGoldenTests.
 * Divergence on either side = drift caught before it is audible on stage.
 *
 * Float discipline: Swift computes deck gains and the sync rate in Float32
 * (deckVolume is Float; rate = min(Float(...), Float(...))). Math.fround
 * mirrors every narrowing site — do not "clean up" a fround without checking
 * the Swift original.
 *
 * Domain Ownership: this math STAYS Swift-owned at runtime (ledger row 5) —
 * the web sends intents. This module exists for drift detection and for
 * cosmetic prediction (e.g. previewing the gain curve), never as the audio
 * authority.
 */

export type XfaderSide = "own" | "a" | "b";
export type DJTempoMode = "timePitch" | "timeStretch" | "tempoOnly";
export type DJPulseRelation =
  | "auto"
  | "1:3"
  | "1:2"
  | "2:3"
  | "1:1"
  | "3:2"
  | "2:1"
  | "3:1";

/** DJPulseRelation.musicalCases — Swift allCases order minus .auto. The auto
 * resolver's min(by:) keeps the FIRST minimal element, so order is semantic. */
export const MUSICAL_PULSE_CASES: Exclude<DJPulseRelation, "auto">[] = [
  "1:3",
  "1:2",
  "2:3",
  "1:1",
  "3:2",
  "2:1",
  "3:1",
];

export function pulseMultiplier(p: Exclude<DJPulseRelation, "auto">): number {
  switch (p) {
    case "1:3":
      return 1 / 3;
    case "1:2":
      return 0.5;
    case "2:3":
      return 2 / 3;
    case "1:1":
      return 1;
    case "3:2":
      return 1.5;
    case "2:1":
      return 2;
    case "3:1":
      return 3;
  }
}

/** BeatSequencer.resolvedPulseRelation — nearest musical ratio in log-tempo
 * distance; first minimum wins on a tie (Swift min(by: <) semantics). */
export function resolvePulseRelation(
  selected: DJPulseRelation,
  actualBpm: number,
  masterBpm: number,
): Exclude<DJPulseRelation, "auto"> {
  if (selected !== "auto") return selected;
  if (!(actualBpm > 0) || !(masterBpm > 0)) return "1:1";
  let best: Exclude<DJPulseRelation, "auto"> = "1:1";
  let bestDist = Infinity;
  for (const p of MUSICAL_PULSE_CASES) {
    const dist = Math.abs(Math.log((masterBpm * pulseMultiplier(p)) / actualBpm));
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  return best;
}

/** NativeDJCoordinator.crossfadeGainLaw — constant-power curve riding ON TOP
 * of the deck's own volume fader. fullerCurve (X-MIX): γ = 0.5 root ≈ −1.5 dB
 * at mid instead of −3 dB. Swift returns Float. */
export function crossfadeGainLaw(
  side: XfaderSide,
  engaged: boolean,
  position: number,
  deckVolume: number,
  fullerCurve: boolean,
): number {
  const vol = Math.fround(deckVolume);
  if (!engaged) return vol;
  const gamma = fullerCurve ? 0.5 : 1.0;
  switch (side) {
    case "own":
      return vol;
    case "a":
      return Math.fround(vol * Math.fround(Math.pow(Math.cos((position * Math.PI) / 2), gamma)));
    case "b":
      return Math.fround(vol * Math.fround(Math.pow(Math.sin((position * Math.PI) / 2), gamma)));
  }
}

export interface CarveEntry {
  amount: number;
  mask: number;
  shimmer: number;
}

/** NativeDJCoordinator.xmixCarveLaw — per deck (A,B,C order): carve depth,
 * source bitmask (the OPPOSITE side's deck indices), shimmer. The fader
 * position is raised to a <1 power to front-load the carve vs. the volume
 * curve. Shimmer is resolved independently of `enabled` (historical publish
 * behaviour preserved). */
export function xmixCarveLaw(
  enabled: boolean,
  position: number,
  strength: number,
  shimmerOn: boolean,
  shimmerAmount: number,
  sides: XfaderSide[],
): CarveEntry[] {
  const shimmer = shimmerOn ? shimmerAmount : 0;
  const carvePosA = Math.pow(position, 0.6);
  const carvePosB = Math.pow(1 - position, 0.6);
  const sideMask = (side: XfaderSide) => {
    let mask = 0;
    sides.forEach((s, i) => {
      if (s === side) mask |= 1 << i;
    });
    return mask;
  };
  const maskA = sideMask("a");
  const maskB = sideMask("b");
  return sides.map((side): CarveEntry => {
    if (!enabled) return { amount: 0, mask: 0, shimmer };
    switch (side) {
      case "a":
        return { amount: strength * carvePosA, mask: maskB, shimmer };
      case "b":
        return { amount: strength * carvePosB, mask: maskA, shimmer };
      case "own":
        return { amount: 0, mask: 0, shimmer };
    }
  });
}

/** NativeDJCoordinator.busStretchRatio — TS mode: bus is the sole tempo
 * authority, ratio is OUTPUT/INPUT duration = 1/rate. No snap-to-neutral near
 * zero: a ~0 rate must yield a huge ratio (freeze ceiling), the floor only
 * guards division. */
export function busStretchRatio(tempoMode: DJTempoMode, deckSyncRatio: number): number {
  if (tempoMode !== "timeStretch") return 1;
  return 1 / Math.max(deckSyncRatio, 1e-6);
}

/** NativeDJCoordinator.deckVarispeedRatio — TP mode passes the deck's own
 * external varispeed multiplier; neutral otherwise. */
export function deckVarispeedRatio(tempoMode: DJTempoMode, externalVarispeed: number): number {
  if (tempoMode !== "timePitch") return 1;
  return externalVarispeed;
}

/** NativeDJCoordinator.deckMasterSpeedRatio — tempo-only mode scales the
 * native step clock by the sync rate; neutral in TP/TS. */
export function deckMasterSpeedRatio(tempoMode: DJTempoMode, deckSyncRatio: number): number {
  if (tempoMode !== "tempoOnly") return 1;
  return deckSyncRatio > 0.0001 ? deckSyncRatio : 1;
}

// ── Smart-BPM tempo computation ─────────────────────────────────────────────

export interface DJSyncInput {
  masterBpm: number;
  tempoMode: DJTempoMode;
  /** deckState.isSyncEnabled */
  syncEnabled: boolean;
  /** djOriginalBpm — the deck's own session tempo */
  originalBpm: number;
  pulseRelation: DJPulseRelation;
  /** djNudgeBpmDelta — transient offset on top of the target BPM */
  nudgeBpmDelta?: number;
  /** deckState.transposeEnabled / transposeSemitones — only consumed by the
   * sync-OFF TP branch (manual turntable pitch); TS transpose rides the
   * realtime per-deck bus path, outside this law. */
  transposeEnabled?: boolean;
  transposeSemitones?: number;
}

export interface DJSyncOutput {
  /** engine.lastDJSyncRatio after applyDJMasterSync (Double(Float rate)) */
  syncRatio: number;
  /** currentSyncedBpm — null when sync is off */
  syncedBpm: number | null;
  busRatio: number;
  deckVarispeed: number;
  deckMasterSpeed: number;
}

/**
 * BeatSequencer.applyDJMasterSync — the smart-BPM interpolation — plus the
 * per-mode routing republishNow derives from its result. Mirrors the Swift
 * order exactly: tempo-only clamps the master to ≥20 BPM (its step clock has
 * a hard 0.1× engine floor and cannot freeze), a sub-20 master forces a
 * literal 1:1 pulse (the auto resolver would re-multiply a 5 BPM master back
 * toward the session tempo, defeating the deliberate extreme slow-down), the
 * nudged target floors at 0.001 BPM, and the rate ceiling keeps the effective
 * tempo ≤ 600 BPM. Rate is computed in Float32 (Swift `min(Float, Float)`).
 */
export function djSyncLaw(input: DJSyncInput): DJSyncOutput {
  const { masterBpm, tempoMode, syncEnabled, originalBpm, pulseRelation } = input;
  const nudge = input.nudgeBpmDelta ?? 0;

  if (!syncEnabled) {
    if (tempoMode === "timePitch" && (input.transposeEnabled ?? false)) {
      // Manual deck-pitch: 2^(semis/12) as Float, driven through varispeed.
      const mult = Math.fround(Math.pow(2, (input.transposeSemitones ?? 0) / 12));
      return {
        syncRatio: mult,
        syncedBpm: null,
        busRatio: busStretchRatio(tempoMode, mult),
        deckVarispeed: deckVarispeedRatio(tempoMode, mult),
        deckMasterSpeed: deckMasterSpeedRatio(tempoMode, mult),
      };
    }
    return { syncRatio: 1, syncedBpm: null, busRatio: 1, deckVarispeed: 1, deckMasterSpeed: 1 };
  }

  const actualBpm = Math.max(0.001, originalBpm);
  const effectiveMasterBpm = tempoMode === "tempoOnly" ? Math.max(20, masterBpm) : masterBpm;
  const resolvedPulse =
    effectiveMasterBpm < 20
      ? "1:1"
      : resolvePulseRelation(pulseRelation, actualBpm, effectiveMasterBpm);
  const targetDeckBpm = effectiveMasterBpm * pulseMultiplier(resolvedPulse);
  const nudgedTargetBpm = Math.max(0.001, targetDeckBpm + nudge);
  const maxRate = Math.fround(600 / Math.max(1, actualBpm));
  const rate = Math.min(Math.fround(nudgedTargetBpm / actualBpm), maxRate);

  return {
    syncRatio: rate,
    syncedBpm: rate * actualBpm,
    busRatio: busStretchRatio(tempoMode, rate),
    deckVarispeed: deckVarispeedRatio(tempoMode, rate),
    deckMasterSpeed: deckMasterSpeedRatio(tempoMode, rate),
  };
}

// ── Fixture runners + canonical serialization (shared by djMixGolden.test.ts
//    and the fixture generator; mirrored exactly by DJMixGoldenTests.swift) ──

export interface CrossfadeFixtureInput {
  position: number;
  engaged: boolean;
  /** A,B,C order */
  sides: XfaderSide[];
  /** A,B,C order */
  deckVolumes: number[];
  xmixEnabled: boolean;
  xmixStrength: number;
  xmixFullerCurve: boolean;
  xmixShimmer: boolean;
  xmixShimmerAmount: number;
}

export interface CrossfadeFixtureOutput {
  gains: number[];
  carve: CarveEntry[];
}

/** Derives the two production gates exactly as the Swift call sites do:
 * gain fullerCurve = xmixEnabled && xmixFullerCurve (audibleDeckGain);
 * carve enabled = engaged && xmixEnabled (republishNow's xmixOn). */
export function runCrossfadeFixture(input: CrossfadeFixtureInput): CrossfadeFixtureOutput {
  const fuller = input.xmixEnabled && input.xmixFullerCurve;
  const gains = input.sides.map((side, i) =>
    crossfadeGainLaw(side, input.engaged, input.position, input.deckVolumes[i] ?? 0, fuller),
  );
  const xmixOn = input.engaged && input.xmixEnabled;
  const carve = xmixCarveLaw(
    xmixOn,
    input.position,
    input.xmixStrength,
    input.xmixShimmer,
    input.xmixShimmerAmount,
    input.sides,
  );
  return { gains, carve };
}

/** Canonical number: fixed 6 decimals, trailing zeros trimmed. Locked to this
 * form because plain String() diverges between Swift ("8e-06") and JS
 * ("0.000008") in the exponent zone the DJ ratios actually reach. */
export function canonNum(v: number): string {
  let s = v.toFixed(6);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
}

export function canonicalCrossfade(out: CrossfadeFixtureOutput): string {
  const carve = out.carve
    .map(
      (e) =>
        `{"amount":${canonNum(e.amount)},"mask":${e.mask},"shimmer":${canonNum(e.shimmer)}}`,
    )
    .join(",");
  return `{"carve":[${carve}],"gains":[${out.gains.map(canonNum).join(",")}]}`;
}

export function canonicalTempo(out: DJSyncOutput): string {
  return (
    `{"busRatio":${canonNum(out.busRatio)}` +
    `,"deckMasterSpeed":${canonNum(out.deckMasterSpeed)}` +
    `,"deckVarispeed":${canonNum(out.deckVarispeed)}` +
    `,"syncRatio":${canonNum(out.syncRatio)}` +
    `,"syncedBpm":${out.syncedBpm === null ? "null" : canonNum(out.syncedBpm)}}`
  );
}
