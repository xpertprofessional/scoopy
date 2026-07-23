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
  /** Topology edits — return the new Patch so the caller can publish it. */
  addChannel: (name: string, source: SourceRef) => Patch
  addDeck: () => Patch
  /** Remove a strip. A deck strip also removes its deck — only the HIGHEST
      deck id is removable (no id renumbering; matches add/remove-at-the-end).
      Returns the unchanged patch when the removal is not legal. */
  removeChannel: (index: number) => Patch
  /** Live param edits (caller also sends the ParamWrite; no republish). */
  setChannelParam: (
    index: number,
    key: 'gain' | 'pan' | 'mute' | 'solo' | 'toMonitor',
    value: number | boolean,
  ) => void
  setDeckSourcePath: (id: number, path: string) => void
}

let nextKey = 1

export const useAppStore = create<AppState>((set, get) => ({
  shellStatus: 'disconnected',
  capabilities: null,
  deviceInfo: null,
  engineTimeSamples: 0,
  feedbackAlarm: false,
  deckStates: [],
  patch: emptyPatch(),
  setShellStatus: (shellStatus) => set({ shellStatus }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setDeviceInfo: (deviceInfo) => set({ deviceInfo }),
  setEngineTimeSamples: (engineTimeSamples) => set({ engineTimeSamples }),
  setFeedbackAlarm: (feedbackAlarm) => set({ feedbackAlarm }),
  setDeckStates: (deckStates) => set({ deckStates }),

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

  setChannelParam: (index, key, value) => {
    const patch = get().patch
    const ch = patch.channels[index]
    if (!ch) return
    const nextCh: Channel = { ...ch, [key]: value }
    const channels = patch.channels.slice()
    channels[index] = nextCh
    set({ patch: { ...patch, channels } })
  },

  setDeckSourcePath: (id, path) => {
    const patch = get().patch
    const decks = patch.decks.map((d) => (d.id === id ? { ...d, sourcePath: path } : d))
    set({ patch: { ...patch, decks } })
  },
}))
