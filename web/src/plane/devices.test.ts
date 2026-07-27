import { describe, expect, it } from 'vitest'
import { channelLabel, inputChoices } from './devices.ts'

describe('input choices', () => {
  it('offers STEREO PAIRS before mono channels', () => {
    // Stereo is the common case; a picker that listed eight mono channels
    // before any pair would make the common case the hardest to find.
    const choices = inputChoices(['In 1', 'In 2', 'In 3', 'In 4'])
    expect(choices[0]).toMatchObject({ left: 0, right: 1 })
    expect(choices[1]).toMatchObject({ left: 2, right: 3 })
    expect(choices[2]).toMatchObject({ left: 0, right: null })
  })

  it('does not invent a pair from an odd channel count', () => {
    // A 3-in device has one pair and three monos, not two pairs — the second
    // "pair" would name a channel the device does not have.
    const choices = inputChoices(['In 1', 'In 2', 'In 3'])
    expect(choices.filter((c) => c.right !== null)).toHaveLength(1)
    expect(choices.filter((c) => c.right === null)).toHaveLength(3)
  })

  it('offers nothing at all when the device has no inputs', () => {
    // Distinct from "not asked yet" — the store's `loaded` flag carries that.
    expect(inputChoices([])).toEqual([])
  })

  it('indexes choices by ROUTE index, because the list is compacted to active inputs', () => {
    // A choice's `left` goes straight into a route's srcIndex. If these ever
    // stopped being the same number there would be a second mapping to keep in
    // step, which is the thing the compaction exists to avoid.
    const choices = inputChoices(['A', 'B'])
    expect(choices.map((c) => c.left)).toEqual([0, 0, 1])
  })
})

describe('channel labels', () => {
  it('names both sides of a stereo input', () => {
    expect(channelLabel(['Mic L', 'Mic R'], 0, 1)).toBe('Mic L + Mic R')
  })

  it('SAYS SO when the channel is not on this device', () => {
    // Switching from an 8-in interface to a 2-in one leaves routes pointing at
    // channels that no longer exist. A strip that silently claimed input 5
    // would be silent for a routing reason with nothing on the object saying
    // why — the exact failure the status line exists to prevent.
    expect(channelLabel(['In 1', 'In 2'], 5, null)).toContain('not on this device')
    expect(channelLabel(['In 1', 'In 2'], 0, 7)).toContain('right channel missing')
  })

  it('shortens long device names from the TAIL', () => {
    // "Scarlett 2i2 USB Input 1" and "…Input 2" differ only at the end, so
    // truncating the front keeps the part that distinguishes them.
    const label = channelLabel(['Scarlett 2i2 USB Input 1'], 0, null)
    expect(label.length).toBeLessThanOrEqual(14)
    expect(label).toContain('Input 1')
  })
})
