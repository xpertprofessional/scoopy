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

/** Every grid strip's tempo intent, in strip order. */
export function mapTempoIntents(map: PlaneMap): TempoIntent[] {
  return map.strips.flatMap((s) =>
    s.element.kind === 'grid' ? [deckTempoIntent(s.element, map.transport.masterBpm)] : [],
  )
}

/** How a strip's tempo reads on screen: "128.0" when synced, "—" when free.
    Rounded to one decimal because the law's output is a Float32 ratio times a
    bpm and its last digits are noise, not information. */
export function formatSyncedBpm(intent: TempoIntent): string {
  return intent.syncedBpm === null ? '—' : intent.syncedBpm.toFixed(1)
}
