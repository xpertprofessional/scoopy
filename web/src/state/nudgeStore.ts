/**
 * THE NUDGE (P3-D4-2) — the pitch-fader hand gesture, at last.
 *
 * TRANSIENT per-deck tempo offsets: hold-to-bend, snap-back on release, and
 * NEVER the document (the U5 lesson — the ±1 steppers are honest document
 * steps precisely because this store exists for the other gesture). The law
 * (`djSyncLaw.nudgeBpmDelta`) has carried the input since the desktop; this is
 * its first producer in the merged app.
 *
 * The law applies nudge only to a SYNCED deck — it bends the synced target
 * (the desktop's semantics, golden-fixture-mirrored, not this store's to
 * change). The UI therefore offers NUDGE only while SYNC is on.
 *
 * A zustand store rather than a module array so every display of the resolved
 * tempo (the tile MasterRow's strike-through, the grid row's synced label)
 * follows the bend live.
 */
import { create } from 'zustand'

import type { EngineLink } from '../engineLink.ts'
import { applyTempo } from './mapStore.ts'

interface NudgeState {
  /** BPM delta per deck index. Missing = 0. */
  deltas: Record<number, number>
}

export const useNudge = create<NudgeState>(() => ({ deltas: {} }))

/** The delta applyTempo folds into the law for `deck`. */
export function nudgeOf(deck: number): number {
  return useNudge.getState().deltas[deck] ?? 0
}

/** Bend (delta ≠ 0) or release (delta 0) — pushes the re-resolved ratios to
    the engine immediately; the document is never touched. */
export function setNudge(link: EngineLink | null, deck: number, delta: number): void {
  const cur = nudgeOf(deck)
  if (cur === delta) return
  useNudge.setState((s) => ({ deltas: { ...s.deltas, [deck]: delta } }))
  void applyTempo(link)
}
