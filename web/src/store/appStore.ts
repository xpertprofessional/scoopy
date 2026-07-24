import { create } from 'zustand'
import {
  emptyPatch,
  makeChannel,
  type Capabilities,
  type Channel,
  type Deck,
  type Patch,
  type Result,
  type SourceRef,
  type Take,
} from '../../protocol/schema'

// 'disconnected' until the EngineLink handshake (getCapabilities) succeeds;
// 'no-engine' when no JUCE shell is present (plain browser / dev).
export type ShellStatus = 'disconnected' | 'connecting' | 'connected' | 'no-engine'

export type DeviceInfo = Result<'getDeviceInfo'>

interface AppState {
  shellStatus: ShellStatus
  capabilities: Capabilities | null
  deviceInfo: DeviceInfo | null
  /** Mirrored from HotFrame slot 1 — the free-running engine sample clock. */
  engineTimeSamples: number
  /** Mirrored from HotFrame 'feedbackAlarm' — the watchdog lamp (P4). */
  feedbackAlarm: boolean
  /** Deck states mirrored from HotFrame deck blocks (rare-change values only —
      meters and playheads stay on the HotSurface canvas, never in React). */
  deckStates: number[]
  /** Per-deck 'the 256 MB cap stopped this recording' flags (D-WZ-DECK-01). */
  deckCapReached: boolean[]
  /** The session's takes, newest last (from listTakes / deckRecordStop). */
  takes: Take[]
  /** Which take the deck rack aligns others against (Law C-2 reference). */
  alignReferencePath: string | null
  /**
   * The Patch — the routing document. TS OWNS it (ownership law); the engine
   * follows whatever publishWorld hands it. ParamWrite covers live moves
   * between publishes; topology changes MUST republish (the caller's job —
   * usePatch.ts wraps these edits with the publish).
   */
  patch: Patch
  setShellStatus: (s: ShellStatus) => void
  setCapabilities: (c: Capabilities) => void
  setDeviceInfo: (d: DeviceInfo) => void
  setEngineTimeSamples: (n: number) => void
  setFeedbackAlarm: (a: boolean) => void
  setDeckStates: (s: number[]) => void
  setDeckCapReached: (c: boolean[]) => void
  setTakes: (t: Take[]) => void
  addTake: (t: Take) => void
  removeTake: (path: string) => void
  setAlignReference: (path: string | null) => void
  /** Topology edits — return the new Patch so the caller can publish it. */
  addChannel: (name: string, source: SourceRef) => Patch
  addDeck: () => Patch
  /** Create a LoopbackBus strip (busTap): the one legal cycle — it reads the
      named bus's PREVIOUS block, which is what makes record-own-output and
      resample-the-mix possible without an illegal zero-delay cycle. */
  addLoopback: (bus: number) => Patch
  /** Remove a strip. A deck strip also removes its deck — only the HIGHEST
      deck id is removable (no id renumbering; matches add/remove-at-the-end).
      Returns the unchanged patch when the removal is not legal. */
  removeChannel: (index: number) => Patch
  /** Live param edits (caller also sends the ParamWrite; no republish). */
  setChannelParam: (
    index: number,
    key: 'gain' | 'pan' | 'mute' | 'solo' | 'toMonitor' | 'outBus',
    value: number | boolean,
  ) => void
  setDeckSourcePath: (id: number, path: string) => void
  setDeckRate: (id: number, rate: number) => void
  setDeckLoopRegion: (id: number, startSample: number, endSample: number) => void
  /** Bumped whenever a deck's BUFFER changes (load/record), so the waveform
      refetches. Distinct from the Patch: the buffer is engine state. */
  deckRevisions: number[]
  bumpDeckRevision: (id: number) => void
}

let nextKey = 1

export const useAppStore = create<AppState>((set, get) => ({
  shellStatus: 'disconnected',
  capabilities: null,
  deviceInfo: null,
  engineTimeSamples: 0,
  feedbackAlarm: false,
  deckStates: [],
  deckCapReached: [],
  takes: [],
  deckRevisions: [],
  alignReferencePath: null,
  patch: emptyPatch(),
  setShellStatus: (shellStatus) => set({ shellStatus }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setDeviceInfo: (deviceInfo) => set({ deviceInfo }),
  setEngineTimeSamples: (engineTimeSamples) => set({ engineTimeSamples }),
  setFeedbackAlarm: (feedbackAlarm) => set({ feedbackAlarm }),
  setDeckStates: (deckStates) => set({ deckStates }),
  setDeckCapReached: (deckCapReached) => set({ deckCapReached }),
  setTakes: (takes) => set({ takes }),
  addTake: (t) => set({ takes: [...get().takes, t] }),
  removeTake: (path) =>
    set({
      takes: get().takes.filter((t) => t.path !== path),
      // A deleted take can't stay the align reference.
      alignReferencePath: get().alignReferencePath === path ? null : get().alignReferencePath,
    }),
  setAlignReference: (alignReferencePath) => set({ alignReferencePath }),

  addChannel: (name, source) => {
    const patch = get().patch
    const ch = makeChannel(`ch-${nextKey++}`, name, source)
    const next = { ...patch, channels: [...patch.channels, ch] }
    set({ patch: next })
    return next
  },

  addDeck: () => {
    const patch = get().patch
    if (patch.decks.length >= 8) return patch
    const id = patch.decks.length
    const deck: Deck = {
      id,
      name: `Deck ${id + 1}`,
      loopEnabled: true, // Law C-3 posture: stop → instant loop is the default
      loopStartSample: 0,
      loopEndSample: 0,
      rate: 1,
      sourcePath: '',
    }
    const strip = makeChannel(`deck-${id}`, deck.name, {
      kind: 'deck',
      id: String(id),
      name: deck.name,
    })
    const next = {
      ...patch,
      decks: [...patch.decks, deck],
      channels: [...patch.channels, strip],
    }
    set({ patch: next })
    return next
  },

  removeChannel: (index) => {
    const patch = get().patch
    const ch = patch.channels[index]
    if (!ch) return patch
    let decks = patch.decks
    if (ch.source.kind === 'deck') {
      const deckId = Number(ch.source.id)
      const maxId = Math.max(...patch.decks.map((d) => d.id))
      if (deckId !== maxId) return patch // only the last deck is removable
      decks = patch.decks.filter((d) => d.id !== deckId)
    }
    const channels = patch.channels.filter((_, i) => i !== index)
    const next = { ...patch, channels, decks }
    set({ patch: next })
    return next
  },

  addLoopback: (bus) => {
    const patch = get().patch
    const label = bus === 0 ? 'main' : 'monitor'
    const strip = makeChannel(`loopback-${nextKey++}`, `↺ ${label}`, {
      kind: 'busTap',
      id: String(bus),
      name: `${label} bus`,
    })
    // A loopback defaults MUTED: an unmuted unity loopback of main is an
    // instant sustained feedback path. The user unmutes deliberately, with the
    // watchdog behind them.
    const next = { ...patch, channels: [...patch.channels, { ...strip, mute: true }] }
    set({ patch: next })
    return next
  },

  setChannelParam: (index, key, value) => {
    const patch = get().patch
    const ch = patch.channels[index]
    if (!ch) return
    const nextCh: Channel = { ...ch, [key]: value }
    const channels = patch.channels.slice()
    channels[index] = nextCh
    set({ patch: { ...patch, channels } })
  },

  setDeckLoopRegion: (id, startSample, endSample) => {
    const patch = get().patch
    const decks = patch.decks.map((d) =>
      d.id === id ? { ...d, loopStartSample: startSample, loopEndSample: endSample } : d,
    )
    set({ patch: { ...patch, decks } })
  },

  bumpDeckRevision: (id) => {
    const revs = get().deckRevisions.slice()
    revs[id] = (revs[id] ?? 0) + 1
    set({ deckRevisions: revs })
  },

  setDeckRate: (id, rate) => {
    const patch = get().patch
    const decks = patch.decks.map((d) => (d.id === id ? { ...d, rate } : d))
    set({ patch: { ...patch, decks } })
  },

  setDeckSourcePath: (id, path) => {
    const patch = get().patch
    const decks = patch.decks.map((d) => (d.id === id ? { ...d, sourcePath: path } : d))
    set({ patch: { ...patch, decks } })
  },
}))
