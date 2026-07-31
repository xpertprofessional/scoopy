/**
 * ARMING A LAUNCH (P11-3c) — the decision between "start now" and "wait for the
 * boundary", and the one place it is made.
 *
 * Everything upstream of this is pure: the scale and the reference resolution
 * live in `audio/launchQuantum.ts`. This is where they meet the engine, and it
 * exists as its own module because the answer has FOUR ways of coming out "play
 * now", and a caller that inlined it would end up implying only one.
 */
import type { EngineLink } from '../engineLink.ts'
import { lcmForScene } from '../audio/patternClock.ts'
import {
  quantumSteps,
  resolveLaunchReference,
  type LaunchStrip,
} from '../audio/launchQuantum.ts'
import type { PlaneMap } from '../persist/mapDocument.ts'
import { deckOf, useCompanion } from '../store/companionEngine.ts'
import { send } from './send.ts'

/** Why a launch did what it did — the caller turns this into a note. */
export type LaunchOutcome =
  | { armed: true; refDeck: number; steps: number; refName: string }
  | {
      armed: false
      reason: 'quantumOff' | 'nothingPlaying' | 'referenceHasNoDeck' | 'noCycle' | 'didNotStart'
    }

/** The strips, as the resolver wants them. Kept here so both the arm path and
    the strip menu build the same view of the map from the same code. */
export function launchStripsOf(map: PlaneMap): LaunchStrip[] {
  const decks = useCompanion.getState().decks
  return map.strips.map((st, i) => ({
    key: st.key,
    index: i,
    launchRef: st.element.kind === 'none' ? 'auto' : st.element.launchRef,
    deck: st.element.kind === 'grid' ? st.element.deck : null,
    playing: st.element.kind === 'grid' ? (decks[st.element.deck]?.playing ?? false) : false,
  }))
}

/**
 * Start `deck`'s strip, on the beat when there is a beat to be on.
 *
 * ⚠️ FOUR WAYS THIS ENDS UP PLAYING IMMEDIATELY, and they are different
 * statements — which is why the outcome names them rather than returning a
 * bare boolean:
 *
 *   quantumOff          the quantum is OFF. Asked for; not a fallback.
 *   nothingPlaying      no other strip is running, so there is no grid to wait
 *                       on. The donor arms anyway here and fires instantly,
 *                       which reads as a bug; saying it is the fix.
 *   referenceHasNoDeck  the resolved reference is a TAPE. `sl_deck_request_
 *                       quantized_launch` takes GRID deck indices on both
 *                       sides, so a looper can be neither reference nor
 *                       launcher yet — the seam D-SL-QUANTUM-01 flagged. Named
 *                       rather than hidden, because "I nominated my loop as the
 *                       master and nothing quantizes" is otherwise unexplainable.
 *   noCycle             the reference has no resolvable cycle (an empty
 *                       pattern). Waiting on a boundary that cannot be computed
 *                       would hold the deck forever.
 */
export function armOrPlay(
  link: EngineLink | null,
  map: PlaneMap,
  stripKey: string,
  deck: number,
): LaunchOutcome {
  const play = () => useCompanion.getState().play(deck)
  const quantum = map.transport.launchQuantum

  if (quantum === 'off') {
    play()
    return { armed: false, reason: 'quantumOff' }
  }

  const ref = resolveLaunchReference(launchStripsOf(map), stripKey, map.transport.syncMasterKey)
  if (!ref.key) {
    play()
    return { armed: false, reason: 'nothingPlaying' }
  }

  const refStrip = map.strips.find((st) => st.key === ref.key)
  if (!refStrip || refStrip.element.kind !== 'grid') {
    play()
    return { armed: false, reason: 'referenceHasNoDeck' }
  }

  const refDeck = refStrip.element.deck
  const refSession = deckOf(useCompanion.getState(), refDeck).session
  const cycle = refSession
    ? lcmForScene(refSession.pattern, deckOf(useCompanion.getState(), refDeck).scene)
    : 0
  const steps = quantumSteps(quantum, cycle)
  if (steps <= 0) {
    play()
    return { armed: false, reason: 'noCycle' }
  }

  // ORDER: publish the deck as playing FIRST, then arm. The core holds a deck
  // whose world says active+launchArmed — it renders silence with the stretcher
  // warm and releases at the boundary — so the world has to say "playing"
  // before the request, or there is nothing for the hold to hold.
  play()
  // ⚠️ AND CHECK THAT IT TOOK. `companionEngine.play` returns early with no
  // session or no running engine, silently. Arming after a no-op play would
  // hand the core a deck its world does not say is playing: nothing to hold,
  // nothing to release, and a pad that waits forever with no error anywhere.
  if (!deckOf(useCompanion.getState(), deck).playing) {
    return { armed: false, reason: 'didNotStart' }
  }
  send(link, 'slDeck', {
    action: 'requestQuantizedLaunch',
    deck,
    refDeck,
    quantizeSteps: steps,
  })
  return { armed: true, refDeck, steps, refName: refStrip.name }
}

/** Stop, and disarm anything pending. Unconditional: a UI that stops a deck
    must not have to know whether a launch was waiting, and cancelling nothing
    is safe by the ABI's own contract. */
export function stopAndDisarm(link: EngineLink | null, deck: number): void {
  send(link, 'slDeck', { action: 'cancelQuantizedLaunch', deck })
  useCompanion.getState().stop(deck)
}

/** The note a fallback deserves, or null when the launch armed (or when the
    quantum is simply off, which is not news). */
export function launchNote(outcome: LaunchOutcome): string | null {
  if (outcome.armed) return `waiting for ${outcome.refName} — ${outcome.steps} steps`
  switch (outcome.reason) {
    case 'quantumOff':
      return null
    case 'nothingPlaying':
      return null // starting the first strip of a set is the normal case
    case 'referenceHasNoDeck':
      return 'quantized launch needs a grid strip as its reference — a looper cannot be one yet'
    case 'noCycle':
      return 'that reference has no cycle to wait for — started now'
    case 'didNotStart':
      // Not a quantum failure at all — the deck never started. Said plainly,
      // because "nothing happened" is the least actionable message there is.
      return 'nothing to play on that strip'
  }
}
