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

/**
 * THE OUTCOME OF ONE SWITCH GESTURE (P9-5c) — news, not standing state.
 *
 * `error` carries the host's own words VERBATIM. P9-5b made that load-bearing:
 * a plain refusal costs you the change and leaves the previous device playing,
 * while one ending in `"(and the previous device did not come back)"` means
 * there is no audio at all. Those are different things to tell someone, and
 * rewording the reason on the way to the screen would flatten the difference.
 */
export type DeviceSwitch = {
  /** The device the person PICKED — deliberately not `current`. On a failure
      the host has already put the previous device back, so `current` names the
      OLD device; reporting that as the thing that failed would name the wrong
      one and read as though the app broke the device you were already on. */
  name: string
  /** null when the switch landed; the host's reason when it did not. */
  error: string | null
}

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
  /** The last switch gesture's outcome, or null when none has happened since
      the last full read. A NEW object per gesture — see `setInputDevice`. */
  lastSwitch: DeviceSwitch | null
}

export const useDeviceStore = create<DeviceState>(() => ({
  current: '',
  devices: [],
  channels: [],
  loaded: false,
  lastSwitch: null,
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
    // A fresh read of the device layer supersedes any earlier switch outcome.
    // A stale "could not switch" that outlives the condition it described is
    // its own defect — it would keep re-announcing on a surface that re-reads.
    lastSwitch: null,
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
  // A THROWN refusal is already news: `ask` reports it through `onRefusal` and
  // the plane's note line renders it as `slDevices refused — …` (P3-U6). It is
  // the `ok:false` REPLY that had no door, because it resolves like a success
  // and so slips past every error path the plane already has.
  if (!r) return
  useDeviceStore.setState({
    current: r.current ?? name,
    channels: r.channels ?? [],
    loaded: true,
    // A NEW object on every gesture, including two identical failures in a row:
    // subscribers compare by identity, and picking the same broken device twice
    // is two pieces of news. A value-compared string would announce the first
    // and swallow the second, which is the same silence one layer up.
    lastSwitch: r.ok
      ? { name: r.current ?? name, error: null }
      : { name, error: r.error ?? 'the host gave no reason' },
  })
}

/**
 * One sentence for a switch outcome, or null when there is nothing to say.
 *
 * Pure, and rendered by the plane's note line — the `silenceNote` shape
 * (P3.5-E9a), so there is one wording and one truth rather than a second error
 * channel invented for devices.
 *
 * A SUCCESS gets a line too. Not noise: this only ever follows a deliberate
 * pick from the ⋯ menu, and without it a failure note would sit on the note
 * line unchallenged after the next switch worked — saying the change failed
 * while the device plainly changed.
 */
export function deviceSwitchNote(s: DeviceSwitch | null): string | null {
  if (!s) return null
  return s.error === null
    ? `input device → “${s.name}”`
    : `could not switch input to “${s.name}” — ${s.error}`
}

/**
 * P9-5c — A REFUSED DEVICE SWITCH REACHES A PERSON.
 *
 * The reason has always been produced correctly — `SlDispatch.cpp:1016-1019`
 * returns it and this module stored it — and **read by nothing**: every
 * consumer of this store took `channels`/`devices`/`current`. The schema
 * comment on the field says what it was for (`schema.ts:1972-1973`, *"a picker
 * that silently fails leaves the user staring at a device that did not
 * change"*). Until P9-5b it was worse than that: the failed switch also left
 * the app with no render callback, so the user got a device that did not
 * change, the audio off, and nothing on any screen.
 *
 * ⚠️ WHY THE NOTE LINE AND NOT THE ⋯ MENU (the P9-5a-b alternative). The menu
 * is gone by the time the answer exists. `ContextMenu` runs `onSelect()` then
 * `onClose()` synchronously (`design/ContextMenu.tsx:165-168`) while
 * `setInputDevice` is a `void`ed promise, so the surface that took the gesture
 * has already closed when the host replies. A menu can only show this on the
 * NEXT open, which is a report you have to go looking for. The note line is
 * `role="status"`, persistent, and already where every other outcome on this
 * plane lands (P3-U6 refusals, E9a's silence report) — one error surface, not
 * two.
 *
 * A `subscribe` rather than a selector + effect on purpose: this is news, and a
 * mount must not replay an outcome that happened before it existed.
 */
export function watchDeviceSwitches(onNote: (note: string) => void): () => void {
  return useDeviceStore.subscribe((s, prev) => {
    if (s.lastSwitch === prev.lastSwitch) return
    const note = deviceSwitchNote(s.lastSwitch)
    if (note) onNote(note)
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
