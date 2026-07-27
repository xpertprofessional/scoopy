/**
 * The plane's view of the audio inputs (merge P2 step 4, increment 2).
 *
 * A strip's live input is a ROUTE from a `deviceInput` endpoint — index-based,
 * because that is what the engine patches. This turns those indices into names,
 * which is the whole of what a source picker needs and the reason every strip
 * was previously hard-wired to inputs 0/1 while claiming to record "this
 * strip's input" without being able to say which.
 *
 * `channels` arrives compacted to ACTIVE inputs, so a channel's position in
 * this list IS its `srcIndex` in a route. There is deliberately no second
 * mapping to keep in step.
 */
import { create } from 'zustand'
import type { EngineLink } from '../engineLink.ts'
import { ask } from './send.ts'

export type DeviceState = {
  /** The input device in use, or '' before the first read. */
  current: string
  /** Every input device this host could switch to. */
  devices: string[]
  /** Active input channel names, in route-index order. */
  channels: string[]
  /** True once a read has come back — so the UI can tell "no inputs" from
      "not asked yet", which look identical and mean opposite things. */
  loaded: boolean
  error: string | null
}

export const useDeviceStore = create<DeviceState>(() => ({
  current: '',
  devices: [],
  channels: [],
  loaded: false,
  error: null,
}))

type Reply = {
  ok?: boolean
  current?: string
  devices?: string[]
  channels?: string[]
  error?: string | null
}

/** Read the device layer. Safe to call repeatedly; a host without one leaves
    the store empty and `loaded` false rather than inventing inputs. */
export async function refreshDevices(link: EngineLink | null): Promise<void> {
  const r = await ask<Reply>(link, 'slDevices', { action: 'list' })
  if (!r?.ok) return
  useDeviceStore.setState({
    current: r.current ?? '',
    devices: r.devices ?? [],
    channels: r.channels ?? [],
    loaded: true,
    error: null,
  })
}

/**
 * Switch the input device.
 *
 * The device rebuild (D-WZ-RATE-01 stop→set→start) does NOT recreate the
 * engine, so tapes, routes and channel state all survive it — changing your
 * interface mid-set is safe rather than a reset. The channel LIST does change,
 * though, so a route pointing at input 5 on an 8-in device becomes a route
 * pointing at nothing on a 2-in device; `channelLabel` reports that rather than
 * letting the strip claim an input it no longer has.
 */
export async function setInputDevice(link: EngineLink | null, name: string): Promise<void> {
  const r = await ask<Reply>(link, 'slDevices', { action: 'setInput', name })
  if (!r) return
  useDeviceStore.setState({
    current: r.current ?? name,
    channels: r.channels ?? [],
    loaded: true,
    error: r.ok ? null : (r.error ?? 'could not switch input device'),
  })
}

/** Adjacent stereo pairs, plus every channel on its own — the shape a source
    picker offers. A pair is `(i, i+1)`; a mono source has `right: null`. */
export type InputChoice = { label: string; left: number; right: number | null }

export function inputChoices(channels: readonly string[]): InputChoice[] {
  const out: InputChoice[] = []
  // Pairs first: stereo is the common case, and a picker that listed eight mono
  // channels before any pair would make the common case the hardest to find.
  for (let i = 0; i + 1 < channels.length; i += 2)
    out.push({ label: `${short(channels[i])} + ${short(channels[i + 1])}`, left: i, right: i + 1 })
  for (let i = 0; i < channels.length; i++)
    out.push({ label: `${short(channels[i])} (mono)`, left: i, right: null })
  return out
}

/** What a strip's input row shows for a route at `left`/`right`.
    Names an input the device no longer has rather than pretending — a strip
    silently pointing at a channel that vanished is the "silent for a routing
    reason" failure the status line exists to prevent. */
export function channelLabel(
  channels: readonly string[],
  left: number,
  right: number | null,
): string {
  const l = channels[left]
  if (l === undefined) return `input ${left} — not on this device`
  if (right === null) return short(l)
  const r = channels[right]
  return r === undefined ? `${short(l)} — right channel missing` : `${short(l)} + ${short(r)}`
}

/** Device channel names are verbose ("Scarlett 2i2 USB Input 1"); the strip has
    34 px of label. Keep the tail, which is the part that differs. */
function short(name: string | undefined): string {
  if (!name) return '—'
  const trimmed = name.trim()
  return trimmed.length <= 14 ? trimmed : `…${trimmed.slice(-13)}`
}
