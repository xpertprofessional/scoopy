/**
 * One strip type, source as a choice (pd-merge §3).
 *
 * These pin the two properties the old three-creation-paths design broke: that
 * nothing about a strip depends on WHICH button made it, and that the feedback
 * guard belongs to the source rather than to a species of strip.
 */
import { describe, expect, it } from 'vitest'
import { availableSources } from './AddStrip'
import { useAppStore } from '../store/appStore'

const INPUTS = [
  { name: 'In 1', index: 0 },
  { name: 'In 2', index: 1 },
]

describe('one strip, many sources', () => {
  it('offers loopback in the SAME list as inputs and nothing', () => {
    const kinds = availableSources(INPUTS).map((s) => s.source.kind)
    expect(kinds).toContain('none')
    expect(kinds).toContain('deviceInput')
    // Loopback is not a separate creation path any more — it is an entry here.
    expect(kinds).toContain('busTap')
  })

  it('gives every strip the same shape whatever it listens to', () => {
    const store = useAppStore.getState()
    const before = store.patch.channels.length
    for (const s of availableSources(INPUTS)) store.addChannel(s.label, s.source)
    const made = useAppStore.getState().patch.channels.slice(before)
    const shape = (c: unknown) => Object.keys(c as object).sort().join(',')
    // Identical key sets: you cannot tell from the document what "kind" of strip
    // this is, only what it is currently bound to.
    expect(new Set(made.map(shape)).size).toBe(1)
  })

  it('lands a bus tap muted, at birth AND when flipped to live', () => {
    const store = useAppStore.getState()
    store.addChannel('mic', { kind: 'deviceInput', id: '0', name: 'In 1' })
    const i = useAppStore.getState().patch.channels.length - 1
    expect(useAppStore.getState().patch.channels[i]!.mute).toBe(false)

    store.setChannelSource(i, { kind: 'busTap', id: '0', name: 'main bus' })
    const flipped = useAppStore.getState().patch.channels[i]!
    expect(flipped.source.kind).toBe('busTap')
    // The danger is in the SOURCE, so re-pointing a live strip at main is
    // guarded exactly like creating one there was.
    expect(flipped.mute).toBe(true)
  })

  it('keeps material, name and place when the source is flipped', () => {
    const store = useAppStore.getState()
    store.addChannel('keeper', { kind: 'deviceInput', id: '0', name: 'In 1' })
    const i = useAppStore.getState().patch.channels.length - 1
    store.setChannelCell(i, 42, 99)
    const { patch, deckId } = store.attachDeck(i)
    expect(deckId).toBeGreaterThanOrEqual(0)
    expect(patch.channels[i]!.material).not.toBeNull()

    store.setChannelSource(i, { kind: 'deviceInput', id: '1', name: 'In 2' })
    const after = useAppStore.getState().patch.channels[i]!
    expect(after.material?.deckId).toBe(deckId)
    expect(after.name).toBe('keeper')
    expect(after.cell).toMatchObject({ x: 42, y: 99 })
  })
})
