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
  /**
   * Per-deck 'its referenced audio could not be loaded' flags. RUNTIME truth,
   * deliberately NOT in the document: the Patch keeps the reference so a
   * re-save never drops it (preserve-don't-drop) — the deck stays, marked and
   * silent, exactly as a vanished source leaves its strip in place.
   */
  deckUnresolved: boolean[]
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
  /** Remember the picked device in the SESSION (P7-08). Only a non-empty side
      is written — setDevice's own idiom is '' = "leave that side alone". */
  setSessionDevice: (input: string, output: string) => void
  setShellStatus: (s: ShellStatus) => void
  setCapabilities: (c: Capabilities) => void
  setDeviceInfo: (d: DeviceInfo) => void
  setEngineTimeSamples: (n: number) => void
  setFeedbackAlarm: (a: boolean) => void
  setDeckStates: (s: number[]) => void
  /** Replace the whole document (session restore). */
  setPatch: (p: Patch) => void
  /** A user-visible note about persistence (restored-from-backup, autosave
      failed, unreadable session). Empty when there is nothing to say. */
  sessionNotice: string
  setSessionNotice: (n: string) => void
  setDeckCapReached: (c: boolean[]) => void
  setDeckUnresolved: (id: number, unresolved: boolean) => void
  setTakes: (t: Take[]) => void
  addTake: (t: Take) => void
  removeTake: (path: string) => void
  setAlignReference: (path: string | null) => void
  /** Topology edits — return the new Patch so the caller can publish it. */
  /** `at` places the new Strip on the map; omitted = the default cell origin. */
  addChannel: (name: string, source: SourceRef, at?: { x: number; y: number }) => Patch
  /** Give an existing Strip material: allocate a deck and point the Strip at it.
      This is what makes "recording is the verb that gives a Strip material" true
      without spawning a second object. Returns the deck id, or -1 if none free. */
  attachDeck: (index: number) => { patch: Patch; deckId: number }
  /** Flip which source a live strip listens to (routing matrix, inspector). */
  setChannelSource: (index: number, source: SourceRef) => Patch
  /** Remove a strip. A deck strip also removes its deck — only the HIGHEST
      deck id is removable (no id renumbering; matches add/remove-at-the-end).
      Returns the unchanged patch when the removal is not legal. */
  removeChannel: (index: number) => Patch
  /** Live param edits (caller also sends the ParamWrite; no republish). */
  setChannelParam: (
    index: number,
    key: 'gain' | 'pan' | 'mute' | 'solo' | 'toMonitor' | 'outBus' | 'monitorSwitch',
    value: number | boolean,
  ) => void
  /** Move a Strip on the map. Document-only: geometry NEVER crosses the ABI, so
      this deliberately does not republish — the engine has no opinion on where a
      strip is drawn. */
  setChannelCell: (index: number, x: number, y: number) => void
  /** Persist the map's viewport so a session reopens framed the way you left it.
      Document-only, like cell geometry: the engine has no opinion on where you
      are looking, so this never republishes. */
  setPlaneView: (scale: number, panX: number, panY: number) => void
  /** Which Strip the Inspector is showing. Runtime-only: what you have selected
      is not a property of the patch, and a session should not reopen with a
      stale selection ring on something you were merely looking at. */
  selectedKey: string | null
  setSelected: (key: string | null) => void
  setDeckSourcePath: (id: number, path: string) => void
  setDeckRate: (id: number, rate: number) => void
  setDeckLoopRegion: (id: number, startSample: number, endSample: number) => void
  /** Bumped whenever a deck's BUFFER changes (load/record), so the waveform
      refetches. Distinct from the Patch: the buffer is engine state. */
  deckRevisions: number[]
  bumpDeckRevision: (id: number) => void
  /** A deck's ACTUAL buffer length in frames, reported by the engine on load /
      record-stop. Runtime truth, not document: the waveform and the playhead are
      both scaled by it, and without it they were being scaled by a fallback of
      1 frame — which drew a flat line and put the playhead off-screen. */
  deckFrames: number[]
  setDeckFrames: (id: number, frames: number) => void
  /** True while a deck's audio is decoding on the shell's worker thread
      (P1-11). Runtime-only, never persisted — a load in flight is not a
      property of the document. */
  deckLoading: boolean[]
  setDeckLoading: (id: number, loading: boolean) => void
  /** 0..1 decode progress for a loading deck (P1-11a), pushed from the shell.
      Only meaningful while deckLoading[id] is true. */
  deckLoadProgress: number[]
  setDeckLoadProgress: (id: number, progress: number) => void
}

// Strip keys must be unique: `validatePatch` refuses a patch with a duplicate,
// and React lists them. This counter used to restart at 1 on every launch, so
// the first strip added after RESTORING a session collided with a `ch-1` already
// in it — and from that moment every publish was refused and the engine had no
// world at all. Nothing played, nothing recorded, and the only trace was a
// console.error inside a WebView. `setPatch` now seeds it past whatever the
// document already contains.
let nextKey = 1

/** Advance the key counter past every `ch-N` in this patch. */
function seedKeyCounter(patch: Patch): void {
  for (const ch of patch.channels) {
    const m = /^ch-(\d+)$/.exec(ch.key)
    if (m) nextKey = Math.max(nextKey, Number(m[1]) + 1)
  }
}

export const useAppStore = create<AppState>((set, get) => ({
  shellStatus: 'disconnected',
  capabilities: null,
  deviceInfo: null,
  engineTimeSamples: 0,
  feedbackAlarm: false,
  deckStates: [],
  deckCapReached: [],
  deckUnresolved: [],
  takes: [],
  deckRevisions: [],
  deckFrames: [],
  deckLoading: [],
  deckLoadProgress: [],
  alignReferencePath: null,
  sessionNotice: '',
  patch: emptyPatch(),
  selectedKey: null,
  setSelected: (selectedKey) => set({ selectedKey }),
  setSessionDevice: (input, output) => {
    const p = get().patch
    set({
      patch: {
        ...p,
        device: {
          input: input !== '' ? input : p.device.input,
          output: output !== '' ? output : p.device.output,
        },
      },
    })
  },
  setShellStatus: (shellStatus) => set({ shellStatus }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setDeviceInfo: (deviceInfo) => set({ deviceInfo }),
  setEngineTimeSamples: (engineTimeSamples) => set({ engineTimeSamples }),
  setFeedbackAlarm: (feedbackAlarm) => set({ feedbackAlarm }),
  setDeckStates: (deckStates) => set({ deckStates }),
  setPatch: (patch) => {
    seedKeyCounter(patch) // never mint a key the loaded document already uses
    set({ patch })
  },
  setSessionNotice: (sessionNotice) => set({ sessionNotice }),
  setDeckCapReached: (deckCapReached) => set({ deckCapReached }),
  setDeckUnresolved: (id, unresolved) => {
    const flags = get().deckUnresolved.slice()
    flags[id] = unresolved
    set({ deckUnresolved: flags })
  },
  setDeckFrames: (id, frames) => {
    const f = get().deckFrames.slice()
    f[id] = frames
    set({ deckFrames: f })
  },
  setDeckLoading: (id, loading) => {
    const flags = get().deckLoading.slice()
    flags[id] = loading
    set({ deckLoading: flags })
  },
  setDeckLoadProgress: (id, progress) => {
    const p = get().deckLoadProgress.slice()
    p[id] = progress
    set({ deckLoadProgress: p })
  },
  setTakes: (takes) => set({ takes }),
  addTake: (t) => set({ takes: [...get().takes, t] }),
  removeTake: (path) =>
    set({
      takes: get().takes.filter((t) => t.path !== path),
      // A deleted take can't stay the align reference.
      alignReferencePath: get().alignReferencePath === path ? null : get().alignReferencePath,
    }),
  setAlignReference: (alignReferencePath) => set({ alignReferencePath }),

  addChannel: (name, source, at) => {
    const patch = get().patch
    const base = makeChannel(`ch-${nextKey++}`, name, source)
    const placed = at ? { ...base, cell: { ...base.cell, x: at.x, y: at.y } } : base
    // A strip listening to a BUS arrives MUTED. An unmuted unity tap of main is
    // an instant sustained feedback path, and that danger belongs to the SOURCE,
    // not to some separate "loopback strip" species — so the guard lives on the
    // one creation path where every strip is born. Unmuting stays deliberate,
    // with the watchdog behind it.
    const ch = placed.source.kind === 'busTap' ? { ...placed, mute: true } : placed
    const next = { ...patch, channels: [...patch.channels, ch] }
    set({ patch: next })
    return next
  },

  removeChannel: (index) => {
    const patch = get().patch
    const ch = patch.channels[index]
    if (!ch) return patch
    let decks = patch.decks
    // MATERIAL, not source kind, is what owns a deck. A strip that recorded or
    // loaded keeps listening to its input, so the old `source.kind === 'deck'`
    // test missed every normal case and leaked the deck — until all 8 were gone
    // and recording started failing with no explanation.
    if (ch.material) {
      const deckId = ch.material.deckId
      const maxId = Math.max(...patch.decks.map((d) => d.id))
      if (deckId !== maxId) return patch // only the last deck is removable
      decks = patch.decks.filter((d) => d.id !== deckId)
    }
    const channels = patch.channels.filter((_, i) => i !== index)
    const next = { ...patch, channels, decks }
    set({ patch: next })
    return next
  },

  attachDeck: (index) => {
    const patch = get().patch
    const ch = patch.channels[index]
    if (!ch) return { patch, deckId: -1 }
    if (ch.material) return { patch, deckId: ch.material.deckId } // already has one
    const id = patch.decks.length
    if (id > 7) return { patch, deckId: -1 } // 8 decks is the engine's ceiling
    const deck = {
      id,
      name: ch.name,
      loopEnabled: true,
      loopStartSample: 0,
      loopEndSample: 0,
      rate: 1,
      sourcePath: '',
    }
    const channels = patch.channels.slice()
    channels[index] = { ...ch, material: { deckId: id } }
    const next = { ...patch, decks: [...patch.decks, deck], channels }
    set({ patch: next })
    return { patch: next, deckId: id }
  },

  /** Re-point a strip at a different source, live. Sources are a CHOICE, not a
      species (pd-merge §3), so this is an ordinary edit — the same strip keeps
      its material, geometry, routing and name. Republished by the caller because
      the engine DOES have an opinion here, unlike geometry. */
  setChannelSource: (index, source) => {
    const patch = get().patch
    const ch = patch.channels[index]
    if (!ch) return patch
    // Same feedback guard as birth: pointing a live strip at a bus is exactly as
    // dangerous as creating it there, so it lands muted too.
    const nextCh = { ...ch, source, mute: source.kind === 'busTap' ? true : ch.mute }
    const channels = patch.channels.map((c, i) => (i === index ? nextCh : c))
    const next = { ...patch, channels }
    set({ patch: next })
    return next
  },

  setChannelCell: (index, x, y) => {
    const patch = get().patch
    const ch = patch.channels[index]
    if (!ch) return
    const channels = patch.channels.slice()
    channels[index] = { ...ch, cell: { ...ch.cell, x, y } }
    set({ patch: { ...patch, channels } })
  },

  setPlaneView: (scale, panX, panY) => {
    const p = get().patch
    const cur = p.plane
    // Only write on a real change: the autosave is debounced off the patch, and
    // rewriting an identical viewport would keep re-arming it for nothing.
    if (cur.scale === scale && cur.panX === panX && cur.panY === panY) return
    set({ patch: { ...p, plane: { scale, panX, panY } } })
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
