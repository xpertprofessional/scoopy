/**
 * Edit-time Patch validation (routing.md §5): TS is the document owner, so
 * illegal worlds are refused HERE — the engine never sees one. P1 has no legal
 * cycles except through the LoopbackBus (P4-03): a busTap strip reads a bus's
 * PREVIOUS block, so the render schedule stays acyclic by construction and no
 * cycle detection is needed here — there simply is no edge type that can create
 * a zero-delay cycle. Validation is therefore about referential integrity,
 * phase-gating source kinds, and checking a loopback names a real bus.
 */
import type { Patch } from '../../protocol/schema'

/** Source kinds the CURRENT phase can actually play. Binding a kind before its
    backend exists would put silent, unexplainable strips in the mix — the
    browser offers them only when the capability handshake says so.
    `busTap` joined at P4-03: it is the LoopbackBus — the one legal cycle. */
const PLAYABLE_KINDS = new Set(['none', 'deviceInput', 'deck', 'busTap'])

/** Buses a busTap may read (playback-composer.md §2). 0 = main, 1 = monitor. */
const LOOPBACK_BUSES = new Set(['0', '1'])

export function validatePatch(patch: Patch): string[] {
  const errors: string[] = []

  const keys = new Set<string>()
  for (const ch of patch.channels) {
    if (keys.has(ch.key)) errors.push(`duplicate channel key "${ch.key}"`)
    keys.add(ch.key)
    if (!PLAYABLE_KINDS.has(ch.source.kind))
      errors.push(`channel "${ch.name}": source kind "${ch.source.kind}" has no backend yet`)
    if (ch.source.kind === 'deck') {
      const deckId = Number(ch.source.id)
      if (!Number.isInteger(deckId) || !patch.decks.some((d) => d.id === deckId))
        errors.push(`channel "${ch.name}": deck ${ch.source.id} does not exist`)
    }
    if (ch.source.kind === 'busTap') {
      // The LoopbackBus is the ONLY legal cycle, and it is never implicit: the
      // id names which bus is tapped, and the one-block delay is what keeps the
      // render schedule acyclic. Any other cycle is still refused by
      // construction — there is no edge type that can create one.
      if (!LOOPBACK_BUSES.has(ch.source.id))
        errors.push(`channel "${ch.name}": loopback taps an unknown bus "${ch.source.id}"`)
    }
    if (ch.source.kind === 'deviceInput') {
      const parts = ch.source.id.split(',')
      if (parts.length < 1 || parts.length > 2 || parts.some((p) => !/^\d+$/.test(p)))
        errors.push(`channel "${ch.name}": bad deviceInput id "${ch.source.id}"`)
    }
  }

  const deckIds = new Set<number>()
  for (const d of patch.decks) {
    if (deckIds.has(d.id)) errors.push(`duplicate deck id ${d.id}`)
    deckIds.add(d.id)
    if (d.loopEndSample < d.loopStartSample)
      errors.push(`deck ${d.id}: loop end before start`)
  }

  return errors
}
