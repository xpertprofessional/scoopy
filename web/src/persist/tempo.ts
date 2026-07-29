/**
 * THE PLANE'S TEMPO AUTHORITY — scoopy's law, finally wired to it.
 *
 * ⚠️ THE LAW WAS ALREADY HERE AND NOTHING CALLED IT. `panels/djMix.ts` is a
 * golden-pinned mirror of Swift's `BeatSequencer.applyDJMasterSync` — pulse
 * relations, the auto resolver, the nudge, the 600 BPM ceiling, Float32
 * discipline at every narrowing site, and per-mode routing to busRatio /
 * deckVarispeed / deckMasterSpeed. It has 33 fixture tests
 * (`djMixGolden.test.ts`) proving it agrees with the Swift original to six
 * decimals. And the plane computed `masterBpm / deck.bpm` instead.
 *
 * That is precisely the thing the merge exists to stop: scoopy is the more
 * developed app, and the merge is supposed to ADD a universal surface around
 * it, not reduce it to the simplest arithmetic that fits the surface. So this
 * module is deliberately thin — it resolves a strip into the law's input shape,
 * calls the law, and translates the answer into engine ops. There is no tempo
 * MATH here and there must not be; the moment there is, there are two laws.
 *
 * WHAT THE LAW GIVES YOU THAT THE DIVISION DID NOT:
 *
 *   pulse relations   a 70 BPM deck against a 140 master is not "2×". `auto`
 *                     resolves it to 1:2 — the same pulse, half-time feel —
 *                     which is what a musician means by synced. The division
 *                     could only ever say 2.
 *   a tempo MODE      whether following the master costs pitch. Three
 *                     mechanisms exist in the engine; the ratio alone cannot
 *                     say which one to use.
 *   the ceilings      a 5 BPM master does not produce a deck running at 0.04×
 *                     and a 600 BPM one does not run away.
 *
 * WHY IT LIVES IN `persist/` AND REACHES INTO `panels/`. This is a pure
 * function of the DOCUMENT — a strip plus a master tempo — which is what keeps
 * `mapApply.ts` able to plan the tempo ops without importing the plane's UI
 * tier. `djMix.ts` sits under `panels/` for historical reasons (it arrived with
 * the DJ panel) but it is a law module with no dependencies and no rendering;
 * importing it here is reaching for the law, not for a panel. Issuing the
 * resulting ops at a live engine needs the store and the link, so it lives in
 * `state/mapStore.ts` (`applyTempo` / `updateGridTempo`).
 */
import {
  djSyncLaw,
  resolvePulseRelation,
  type DJPulseRelation,
  type DJTempoMode,
} from '../panels/djMix.ts'
import type { PlaneMap, Strip } from './mapDocument.ts'

/** A grid element narrowed — the only element kind with a tempo. */
type GridElement = Extract<Strip['element'], { kind: 'grid' }>
type TapeElement = Extract<Strip['element'], { kind: 'tape' }>

/** `tempoMode`'s wire value. The engine keys it 0/1/2 (SL-ABI-V3 §3) and the
    document spells it, because a document should be readable and an ABI should
    be stable. One table, so the two can never drift apart silently. */
export const TEMPO_MODE_ID: Record<DJTempoMode, 0 | 1 | 2> = {
  timePitch: 0,
  timeStretch: 1,
  tempoOnly: 2,
}

export interface TempoIntent {
  deck: number
  /** target ÷ deck bpm, the MUSICAL ratio. The engine inverts it for the bus
      stretcher; nothing above the engine should know that. */
  syncRatio: number
  tempoMode: DJTempoMode
  transpose: number
  /** What this deck will actually run at, or null when it is free-running.
      For the UI: a resolved pulse and a resolved BPM are the difference between
      a sync control you can trust and one you have to test by ear. */
  syncedBpm: number | null
  /** The pulse `auto` chose, or the one that was asked for. */
  pulse: Exclude<DJPulseRelation, 'auto'>
}

/**
 * One grid strip's tempo, resolved through the law.
 *
 * `nudgeBpm` is a TRANSIENT offset — a hand on a pitch fader — and is
 * deliberately not part of the document: it must not mark the map dirty, and it
 * must not come back on load. Same rule `companionEngine.tempoOverrideBpm`
 * already follows for the performance tempo.
 */
export function deckTempoIntent(
  element: GridElement,
  masterBpm: number,
  nudgeBpm = 0,
): TempoIntent {
  const out = djSyncLaw({
    masterBpm,
    tempoMode: element.tempoMode,
    syncEnabled: element.syncToMaster,
    originalBpm: element.bpm,
    pulseRelation: element.pulseRelation,
    nudgeBpmDelta: nudgeBpm,
  })
  return {
    deck: element.deck,
    // The law returns 1 for an unsynced deck, which is exactly what must be
    // SENT — not omitted. A deck can be carrying a ratio from a previously
    // loaded map, and silence would leave it stretched with nothing in the
    // document explaining why (the rule `planApply` already documents).
    syncRatio: out.syncRatio,
    tempoMode: element.tempoMode,
    transpose: element.transpose,
    syncedBpm: out.syncedBpm,
    pulse: resolvePulseRelation(element.pulseRelation, element.bpm, masterBpm),
  }
}

/** Every grid strip's tempo intent, in strip order. `nudgeOf` supplies the
    TRANSIENT per-deck bend (P3-D4-2, hold-to-bend) — omitted = no hand on the
    fader, which keeps every pre-nudge caller (map load) exact. */
export function mapTempoIntents(
  map: PlaneMap,
  nudgeOf?: (deck: number) => number,
): TempoIntent[] {
  return map.strips.flatMap((s) =>
    s.element.kind === 'grid'
      ? [deckTempoIntent(s.element, map.transport.masterBpm, nudgeOf?.(s.element.deck) ?? 0)]
      : [],
  )
}

/** How a strip's tempo reads on screen: "128.0" when synced, "—" when free.
    Rounded to one decimal because the law's output is a Float32 ratio times a
    bpm and its last digits are noise, not information. */
export function formatSyncedBpm(intent: TempoIntent): string {
  return intent.syncedBpm === null ? '—' : intent.syncedBpm.toFixed(1)
}

/**
 * A TAPE'S BPM, inferred from its loop and the sidecar stamp (P3-2b-2,
 * PROVISIONAL under D-2 — the recommendation built, logged, re-tunable).
 *
 * A tape knows frames; music knows beats. The bridge is the take's
 * `bpmAtStart` — the master tempo when capture began: the loop's length in
 * seconds at that tempo gives a raw beat count, which is SNAPPED to the
 * nearest power of two (in log space — musical loop lengths are 1/2/4/8/…
 * beats, and neighbours are a factor of two apart, so a hand-stopped loop
 * lands unambiguously). The tape's own bpm is then whatever tempo makes the
 * snapped count exact over the actual audio.
 *
 * THE HONESTY GUARD: a loop more than ~20% off every power of two was not cut
 * near a musical length, and `null` (unknown — the Inspector's field stays
 * empty for the hand to fill) beats a confidently wrong number that would
 * stretch the tape to nonsense the moment sync engages.
 */
export function inferTapeBpm(
  loopFrames: number,
  sampleRate: number,
  bpmAtStart: number,
): number | null {
  if (loopFrames <= 0 || sampleRate <= 0 || bpmAtStart <= 0) return null
  const seconds = loopFrames / sampleRate
  const rawBeats = (seconds * bpmAtStart) / 60
  if (rawBeats <= 0) return null
  const snappedLog = Math.round(Math.log2(rawBeats))
  const beats = 2 ** snappedLog
  const ratio = rawBeats / beats
  if (ratio > 1.2 || ratio < 1 / 1.2) return null // not near a musical length
  // The bpm that makes `beats` exact over the audio that actually exists.
  return Math.round((beats * 60 / seconds) * 100) / 100
}

/**
 * A TAPE'S EFFECTIVE RATE under the master (P3-2b-3 — tape sync v1, timePitch).
 *
 * The first "every element" half of the mission's sync domain made audible,
 * with ZERO new DSP: the varispeed path (`sl_tape_set_rate`) has been built
 * and wired end-to-end since the tape transplant; this only computes the
 * number — through the LAW, not by dividing, for the same reasons the grid
 * branch was moved onto it (pulse relations, the ceilings).
 *
 * Sync owns the MAGNITUDE; the hand keeps the SIGN — a reversed tape stays
 * reversed while synced, because reverse is a musical choice sync has no
 * business overriding. Unsynced (or bpm honestly unknown), the document's own
 * rate stands.
 *
 * BOTH modes take the same ratio (P3-2b-5): the engine's `tempoMode` decides
 * what the number DRIVES — varispeed (pitch moves) or the stretcher (pitch
 * held). `applyTempo` sends the mode alongside the rate.
 */
export function tapeEffectiveRate(element: TapeElement, masterBpm: number): number {
  if (!element.syncToMaster || element.bpm === null) return element.rate
  const out = djSyncLaw({
    masterBpm,
    tempoMode: 'timePitch',
    syncEnabled: true,
    originalBpm: element.bpm,
    pulseRelation: element.pulseRelation,
    nudgeBpmDelta: 0,
  })
  return element.rate < 0 ? -out.syncRatio : out.syncRatio
}

/** Every tape strip's effective rate AND mode, in strip order — what
    `applyTempo` pushes. Unsynced tapes are INCLUDED at their manual rate, for
    the same reason the grid branch sends ratio 1: un-syncing must restore the
    hand's rate, not leave the engine carrying the last synced one. */
export function mapTapeRateOps(
  map: PlaneMap,
): { tape: number; rate: number; mode: 0 | 1 }[] {
  return map.strips.flatMap((s) =>
    s.element.kind === 'tape'
      ? [
          {
            tape: s.element.index,
            rate: tapeEffectiveRate(s.element, map.transport.masterBpm),
            mode: (s.element.tempoMode === 'timeStretch' ? 1 : 0) as 0 | 1,
          },
        ]
      : [],
  )
}
