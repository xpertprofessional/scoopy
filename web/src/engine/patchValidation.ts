/**
 * Edit-time Patch validation (routing.md §5): TS is the document owner, so
 * illegal worlds are refused HERE — the engine never sees one. P1 has no legal
 * cycles at all (the LoopbackBus and its ↺ cells arrive in P4); with busTap
 * absent the graph is structurally acyclic, so validation is about referential
 * integrity and phase-gating source kinds.
 */
import type { Patch } from '../../protocol/schema'

/** Source kinds the CURRENT phase can actually play. Binding a kind before its
    backend exists would put silent, unexplainable strips in the mix — the
    browser offers them only when the capability handshake says so. */
const PLAYABLE_KINDS = new Set(['none', 'deviceInput', 'deck'])

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
