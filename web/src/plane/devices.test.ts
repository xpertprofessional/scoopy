import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineLink } from '../engineLink.ts'
import { resetSendReporting } from './send.ts'
import {
  channelLabel,
  deviceSwitchNote,
  inputChoices,
  refreshDevices,
  setInputDevice,
  useDeviceStore,
  watchDeviceSwitches,
} from './devices.ts'

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

// ── P9-5c: the device-switch error must reach a person ──────────────────────
//
// The reason was produced correctly and read by NOTHING. These pin the sentence
// and the seam that carries it to the plane's note line; what they cannot see is
// the note line's own repaint — that is the real-host walk (P9-G1).

/** The two host strings P9-5b actually produces (`host/src/AudioIO.cpp:132`). */
const RATE_REFUSED = 'device does not support 48000 Hz'
const RATE_REFUSED_AND_LOST = `${RATE_REFUSED} (and the previous device did not come back)`

const replying = (reply: unknown): EngineLink =>
  ({ command: () => Promise.resolve(reply) }) as unknown as EngineLink

const throwing = {
  command: () => Promise.reject(new Error('this host has no device layer')),
} as unknown as EngineLink

describe('device switch notes (P9-5c)', () => {
  beforeEach(() => {
    useDeviceStore.setState({
      current: 'Built-in Microphone',
      devices: ['Built-in Microphone', 'BlackHole 2ch'],
      channels: ['In 1', 'In 2'],
      loaded: true,
      lastSwitch: null,
    })
  })
  afterEach(() => {
    resetSendReporting()
    vi.restoreAllMocks()
  })

  it('says nothing when no switch has been attempted', () => {
    expect(deviceSwitchNote(null)).toBeNull()
  })

  it('names the device AND the host’s reason', () => {
    const note = deviceSwitchNote({ name: 'BlackHole 2ch', error: RATE_REFUSED })
    expect(note).toContain('BlackHole 2ch')
    expect(note).toContain(RATE_REFUSED)
  })

  it('carries the host’s words VERBATIM, so P9-5b’s distinction survives', () => {
    // "your switch failed" and "your switch failed AND the old device is gone"
    // are different things to tell someone: the first costs you the change, the
    // second costs you all your audio. Any rewording here flattens them into
    // one message on the way to the screen.
    expect(deviceSwitchNote({ name: 'BlackHole 2ch', error: RATE_REFUSED })).not.toContain(
      'did not come back',
    )
    expect(
      deviceSwitchNote({ name: 'BlackHole 2ch', error: RATE_REFUSED_AND_LOST }),
    ).toContain('(and the previous device did not come back)')
  })

  it('a REFUSED switch reaches a note-line subscriber', async () => {
    const seen: string[] = []
    const off = watchDeviceSwitches((n) => seen.push(n))
    await setInputDevice(
      replying({ ok: false, error: RATE_REFUSED, current: 'Built-in Microphone', channels: [] }),
      'BlackHole 2ch',
    )
    off()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('BlackHole 2ch')
    expect(seen[0]).toContain(RATE_REFUSED)
  })

  it('names the device the person PICKED, not the one the host restored', () => {
    // P9-5b puts the previous device back on every failure path, so the reply's
    // `current` is the OLD device. Reporting that as the failure would say
    // "could not switch to Built-in Microphone" to someone who picked BlackHole
    // — an app apparently breaking the device they were already happily on.
    useDeviceStore.setState({
      lastSwitch: { name: 'BlackHole 2ch', error: RATE_REFUSED },
      current: 'Built-in Microphone',
    })
    const note = deviceSwitchNote(useDeviceStore.getState().lastSwitch)
    expect(note).toContain('BlackHole 2ch')
    expect(note).not.toContain('Built-in Microphone')
  })

  it('announces TWO identical failures twice — news, not state', async () => {
    // The note line is overwritten by every other outcome, so a second attempt
    // that fails the same way must say so again. A value-compared string would
    // announce the first and swallow the second.
    const link = replying({
      ok: false,
      error: RATE_REFUSED,
      current: 'Built-in Microphone',
      channels: [],
    })
    const seen: string[] = []
    const off = watchDeviceSwitches((n) => seen.push(n))
    await setInputDevice(link, 'BlackHole 2ch')
    await setInputDevice(link, 'BlackHole 2ch')
    off()
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })

  it('a SUCCESS replaces the stale failure rather than leaving it standing', async () => {
    const seen: string[] = []
    const off = watchDeviceSwitches((n) => seen.push(n))
    await setInputDevice(
      replying({ ok: false, error: RATE_REFUSED, current: 'Built-in Microphone', channels: [] }),
      'BlackHole 2ch',
    )
    await setInputDevice(
      replying({ ok: true, current: 'Scarlett 2i2', channels: ['In 1', 'In 2'] }),
      'Scarlett 2i2',
    )
    off()
    expect(seen).toHaveLength(2)
    expect(seen[1]).toContain('Scarlett 2i2')
    expect(seen[1]).not.toContain('could not')
  })

  it('a fresh device READ clears the last switch — a stale error must not outlive it', async () => {
    useDeviceStore.setState({ lastSwitch: { name: 'BlackHole 2ch', error: RATE_REFUSED } })
    const seen: string[] = []
    const off = watchDeviceSwitches((n) => seen.push(n))
    await refreshDevices(replying({ ok: true, current: 'Built-in Microphone', devices: [], channels: [] }))
    off()
    expect(useDeviceStore.getState().lastSwitch).toBeNull()
    expect(seen).toEqual([])
  })

  it('does NOT double-report a thrown refusal — that path is already P3-U6’s', async () => {
    // `ask` reports a rejection through `onRefusal`, which the plane renders as
    // `slDevices refused — …`. Recording it here too would put two lines on one
    // surface for one gesture. The `ok:false` REPLY is the case with no door.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    const off = watchDeviceSwitches((n) => seen.push(n))
    await setInputDevice(throwing, 'BlackHole 2ch')
    off()
    expect(seen).toEqual([])
    expect(useDeviceStore.getState().lastSwitch).toBeNull()
  })

  it('still reports when the host refuses without saying why', async () => {
    // An `ok:false` with no `error` used to fall through to an empty store
    // field. A refusal nobody can explain is still a refusal worth naming.
    const seen: string[] = []
    const off = watchDeviceSwitches((n) => seen.push(n))
    await setInputDevice(replying({ ok: false, current: 'Built-in Microphone' }), 'BlackHole 2ch')
    off()
    expect(seen[0]).toContain('BlackHole 2ch')
    expect(seen[0]).toContain('no reason')
  })
})
