/**
 * Patch edit + publish helpers. Topology edits go through here so the
 * republish can never be forgotten (ownership law: TS owns the document, the
 * engine follows). Live param moves (fader drags, mutes) use paramWrite and
 * update the local document WITHOUT republishing — the next publish carries
 * the same values, so the two paths cannot diverge.
 */
import type { Patch, SourceRef, Take } from '../../protocol/schema'
import { alignedStartSample } from './takeAlign'
import { useAppStore } from '../store/appStore'
import type { EngineLink } from './engineLink'
import { validatePatch } from './patchValidation'

export function publishPatch(link: EngineLink | null, patch: Patch): void {
  if (!link) return
  // Edit-time DAG/integrity guard (routing.md §5): the engine never sees an
  // illegal world. Store paths only build legal edits, so a hit here is a bug
  // worth being loud about.
  const errors = validatePatch(patch)
  if (errors.length > 0) {
    console.error('publish refused:', errors)
    return
  }
  // Output map v0 follows the device (routing.md §4): monitor → device 3/4
  // only when the hardware has the pair; never silently re-routed.
  const info = useAppStore.getState().deviceInfo
  const withMap: Patch = {
    ...patch,
    // MATERIAL WINS AT PUBLISH TIME (PD-CANVAS-06 + D-WZ-RECMODEL-01 step A).
    // The engine renders ONE source per channel, so a Strip that holds material
    // is published as a deck source — that is what makes it play. The document's
    // own `source` is left untouched, so the Strip never forgets what it records
    // FROM. This is why recording can become a verb on any Strip without an
    // engine change and without the rebind that would have erased provenance.
    // A Strip holding material plays it — UNLESS it is monitoring. `monitorSwitch`
    // is the user's own choice to listen to the input instead (P3-10,
    // D-WZ-MON-01); monitorIndex is the same thing forced during a take. Without
    // it, a mic strip that had recorded once could never be heard again: material
    // won permanently and the input was unreachable.
    channels: patch.channels.map((ch) =>
      ch.material && !ch.monitorSwitch
        ? { ...ch, source: { kind: 'deck' as const, id: String(ch.material.deckId), name: ch.name } }
        : ch,
    ),
    outputMap: { main: [0, 1], monitor: info?.monitorAvailable ? [2, 3] : null },
  }
  void link.command('publishWorld', { patch: withMap }).catch(() => {
    // A refused publish leaves the previous world running; the document stays
    // authoritative and the next successful publish reconciles.
  })
}

/** Load a take into a deck, carrying the loading/progress/unresolved posture.
    Shared so loading INTO A STRIP and loading into a deck cannot drift apart. */
async function loadTakeInto(
  link: EngineLink,
  deck: number,
  path: string,
  setDeckSourcePath: (id: number, p: string) => void,
  bumpDeckRevision: (id: number) => void,
): Promise<boolean> {
  const store = useAppStore.getState()
  store.setDeckLoadProgress(deck, 0)
  store.setDeckLoading(deck, true)
  try {
    const r = await link.command('deckLoadTake', { deck, path })
    useAppStore.getState().setDeckUnresolved(deck, !r.ok)
    if (r.ok) {
      setDeckSourcePath(deck, path)
      // The engine just told us how long the buffer actually is — keep it, or
      // the waveform and playhead have nothing true to scale against.
      useAppStore.getState().setDeckFrames(deck, r.engineFrames)
      bumpDeckRevision(deck)
    }
    return r.ok
  } finally {
    useAppStore.getState().setDeckLoading(deck, false)
  }
}

export function usePatchActions(link: EngineLink | null) {
  const addChannel = useAppStore((s) => s.addChannel)
  const addDeck = useAppStore((s) => s.addDeck)
  const attachDeck = useAppStore((s) => s.attachDeck)
  const addLoopback = useAppStore((s) => s.addLoopback)
  const setChannelParam = useAppStore((s) => s.setChannelParam)
  const setDeckSourcePath = useAppStore((s) => s.setDeckSourcePath)
  const removeChannel = useAppStore((s) => s.removeChannel)
  const addTake = useAppStore((s) => s.addTake)
  const setTakes = useAppStore((s) => s.setTakes)
  const removeTake = useAppStore((s) => s.removeTake)
  const setDeckRate = useAppStore((s) => s.setDeckRate)
  const setDeckLoopRegion = useAppStore((s) => s.setDeckLoopRegion)
  const bumpDeckRevision = useAppStore((s) => s.bumpDeckRevision)

  return {
    /** Bind a source as a new strip and publish the new topology. */
    addSourceChannel(name: string, source: SourceRef, at?: { x: number; y: number }) {
      publishPatch(link, addChannel(name, source, at))
    },
    /** Add a deck + its strip and publish. */
    addDeckWithStrip(at?: { x: number; y: number }) {
      publishPatch(link, addDeck(at))
    },
    /** Add a LoopbackBus strip and publish. Arrives muted — see addLoopback. */
    addLoopbackStrip(bus: number, at?: { x: number; y: number }) {
      publishPatch(link, addLoopback(bus, at))
    },
    /**
     * RECORD INTO A STRIP (D-WZ-RECMODEL-01 step A) — recording is the verb that
     * gives a Strip material. If the Strip has no material yet, a deck is
     * allocated and attached to THIS Strip (never a second object), the new
     * topology is published, and capture begins from the Strip's OWN input
     * channels. Returns the deck now holding the material, or -1 if it could not.
     */
    async recordIntoStrip(index: number, chan0: number, chan1: number, sourceDesc: string) {
      if (!link) return -1
      const { patch, deckId } = attachDeck(index)
      if (deckId < 0) return -1
      // ARMED ⇒ MONITORING ON (D-WZ-MON-01). Set the document's own switch
      // rather than forcing it through a parallel publish argument: one
      // mechanism, and the user can SEE that the strip is listening to its input.
      useAppStore.getState().setChannelParam(index, 'monitorSwitch', true)
      publishPatch(link, useAppStore.getState().patch)
      await link.command('deckRecordStart', { deck: deckId, chan0, chan1, sourceDesc })
      return deckId
    },
    /**
     * LOAD MATERIAL INTO A STRIP — the Strip is where material lives, so this is
     * how a take reaches one without a takes panel. Attaches a deck first when
     * the Strip has none, exactly as recording does.
     */
    async loadIntoStrip(index: number, path: string) {
      if (!link) return
      const { patch, deckId } = attachDeck(index)
      if (deckId < 0) return
      publishPatch(link, patch)
      const ok = await loadTakeInto(link, deckId, path, setDeckSourcePath, bumpDeckRevision)
      if (!ok) return
      // Law C-2 survives the takes panel: with a reference take set, loading
      // ALSO aligns — the stamp DELTA becomes this deck's loop origin. Without
      // this, retiring the panel would quietly drop the align verb.
      const st = useAppStore.getState()
      const loaded = st.takes.find((t) => t.path === path)
      const reference = st.takes.find((t) => t.path === st.alignReferencePath)
      if (loaded && reference && reference.path !== loaded.path) {
        const start = alignedStartSample(loaded, reference)
        setDeckLoopRegion(deckId, start, loaded.frames)
        void link.command('deckSetLoop', {
          deck: deckId,
          enabled: true,
          startSample: start,
          endSample: loaded.frames,
        })
      }
    },
    /** Same, from a file the user picks in a native dialog. */
    async loadFileIntoStrip(index: number) {
      if (!link) return
      const { patch, deckId } = attachDeck(index)
      if (deckId < 0) return
      publishPatch(link, patch)
      useAppStore.getState().setDeckLoadProgress(deckId, 0)
      useAppStore.getState().setDeckLoading(deckId, true)
      try {
        const r = await link.command('deckLoadFile', { deck: deckId })
        if (r.ok) {
          setDeckSourcePath(deckId, r.path)
          useAppStore.getState().setDeckFrames(deckId, r.engineFrames)
          bumpDeckRevision(deckId)
        }
      } finally {
        useAppStore.getState().setDeckLoading(deckId, false)
      }
    },
    /** Remove a strip (and its deck when it is the last deck) and publish. */
    removeStrip(index: number) {
      publishPatch(link, removeChannel(index))
    },
    /** Live continuous move: document + coalesced ParamWrite, no republish. */
    setFader(index: number, value: number) {
      setChannelParam(index, 'gain', value)
      link?.paramWrite('gain', value, index)
    },
    setPan(index: number, value: number) {
      setChannelParam(index, 'pan', value)
      link?.paramWrite('pan', value, index)
    },
    setMute(index: number, on: boolean) {
      setChannelParam(index, 'mute', on)
      link?.paramWrite('mute', on ? 1 : 0, index)
    },
    setSolo(index: number, on: boolean) {
      setChannelParam(index, 'solo', on)
      link?.paramWrite('solo', on ? 1 : 0, index)
    },
    /** Output-bus assign is topology (it lives in the engine world) — republish.
        Bus 0 IS main; a spatial layout is simply strips on different buses. */
    setOutBus(index: number, bus: number) {
      setChannelParam(index, 'outBus', bus)
      publishPatch(link, useAppStore.getState().patch)
    },
    /** Rename a strip. The engine world carries channel names (they key the
        render state), so this republishes rather than being document-only. */
    renameStrip(index: number, name: string) {
      const st = useAppStore.getState()
      const ch = st.patch.channels[index]
      if (!ch) return
      const channels = st.patch.channels.slice()
      channels[index] = { ...ch, name }
      st.setPatch({ ...st.patch, channels })
      publishPatch(link, useAppStore.getState().patch)
    },
    /** Monitor the INPUT instead of the material (P3-10). Topology — republish. */
    setMonitorSwitch(index: number, on: boolean) {
      setChannelParam(index, 'monitorSwitch', on)
      publishPatch(link, useAppStore.getState().patch)
    },
    /** Cue assign is topology (the engine world carries it) — republish. */
    setToMonitor(index: number, on: boolean) {
      setChannelParam(index, 'toMonitor', on)
      publishPatch(link, useAppStore.getState().patch)
    },
    setMainFader(value: number) {
      link?.paramWrite('mainGain', value)
    },
    /** Signed varispeed — live control, document + command (no republish; the
        next publish carries the same rate, so the paths cannot diverge). */
    setDeckRate(deck: number, rate: number) {
      setDeckRate(deck, rate)
      void link?.command('deckSetRate', { deck, rate })
    },
    /** Loop region from a waveform drag: document + engine (seqlock-published,
        so the render thread never sees a torn pair). */
    setDeckLoop(deck: number, startSample: number, endSample: number) {
      // ORDER AND CLAMP THE PAIR HERE, once, rather than trusting every caller.
      // validatePatch refuses a whole publish when loopEnd < loopStart, so an
      // inverted pair — one typo in the Inspector's number fields — would not
      // just be a bad loop, it would silently block every later edit from
      // reaching the engine.
      const a = Math.max(0, Math.round(Math.min(startSample, endSample)))
      const b = Math.max(0, Math.round(Math.max(startSample, endSample)))
      setDeckLoopRegion(deck, a, b)
      void link?.command('deckSetLoop', { deck, enabled: true, startSample: a, endSample: b })
    },
    /**
     * ALIGN TO TAKE (Law C-2 as a verb): shift a deck's loop origin by the
     * stamp DELTA between its take and a reference take. No timeline, no edit —
     * a subtraction, exactly as CONCEPT promises.
     */
    alignDeckToTake(deck: number, take: Take, reference: Take) {
      const start = alignedStartSample(take, reference)
      setDeckLoopRegion(deck, start, take.frames)
      void link?.command('deckSetLoop', {
        deck,
        enabled: true,
        startSample: start,
        endSample: take.frames,
      })
    },
    /** SCRUB: drag the playhead (turntable-style). Fire-and-forget — the engine
        applies it at the top of its next block. */
    deckSeek(deck: number, frame: number) {
      void link?.command('deckSeek', { deck, frame: Math.max(0, Math.round(frame)) })
    },
    /**
     * OVERDUB (D-WZ-OVERDUB-01): keep playing and sum the input into the loop.
     * Works on ANY material — a loaded file layers exactly like a recorded take,
     * because a strip is a strip and every function belongs to every strip.
     * Monitoring stays OPEN while layering: hearing the input against the loop
     * is the point, and it is D-WZ-MON-02's one exception to the auto-close.
     */
    setOverdub(deck: number, on: boolean, mode: 'sum' | 'replace' = 'sum') {
      // Deliberately does NOT open the monitor any more. Doing so published the
      // INPUT in place of the material, which un-routed the very loop you are
      // layering against — you overdubbed blind. The deck's own output now
      // carries material + live input, which is what D-WZ-MON-02 actually meant
      // by "the input against the loop".
      void link?.command('deckOverdub', { deck, on, mode })
    },
    /** TAPE SCRUB (turntable): pitch follows hand speed, because the engine
        derives the rate from the gap. Distinct from deckSeek, which jumps at
        unchanged pitch — both are wanted, they are different instruments. */
    deckScrub(deck: number, phase: 'begin' | 'to' | 'end', frame = 0) {
      void link?.command('deckScrub', { deck, phase, frame: Math.max(0, frame) })
    },
    /** Deck transport intents; state truth returns via HotFrame. */
    deckTrigger(deck: number, mode: 'loop' | 'oneShot' | 'stop' | 'retrigger') {
      void link?.command('deckTrigger', { deck, mode })
    },
    /** Arm + start recording a deck from an engine input (Law C-3: on stop it
        loops instantly if the deck's loop is on). */
    async deckRecordStart(deck: number, chan0: number, chan1: number, sourceDesc: string) {
      if (!link) return
      await link.command('deckRecordStart', { deck, chan0, chan1, sourceDesc })
    },
    /** Stop recording; the reply carries the Law C-2 stamp + the finished Take. */
    async deckRecordStop(deck: number) {
      if (!link) return
      const r = await link.command('deckRecordStop', { deck })
      if (r.ok && r.take) {
        addTake(r.take)
        useAppStore.getState().setDeckFrames(deck, r.take.frames)
        // THE TAKE IS NOW THIS DECK'S MATERIAL. Law C-3 already has the engine
        // looping the captured buffer; this points the DOCUMENT at the file that
        // buffer came from. Without it the strip fell straight back to "empty"
        // the instant recording stopped — the wave vanished and the name read
        // empty — because material is defined as "has a sourcePath", and the
        // session would have had no reference to rehydrate the take from.
        setDeckSourcePath(deck, r.take.path)
      }
      bumpDeckRevision(deck) // a take just became this deck's buffer (Law C-3)
      // Hand the strip back to its material: it was monitoring its input during
      // the take, and Law C-3 means the capture is ALREADY looping in the engine.
      publishPatch(link, useAppStore.getState().patch)
    },
    async refreshTakes() {
      if (!link) return
      const r = await link.command('listTakes', {})
      setTakes(r.takes)
    },
    /** Discard a take — the files go to the Trash, so this is recoverable. */
    async deleteTake(path: string) {
      if (!link) return
      const r = await link.command('deleteTake', { path })
      if (r.ok) removeTake(path)
    },
    async revealTake(path: string) {
      if (!link) return
      await link.command('revealTake', { path })
    },
    /** Load a recorded take into any deck (CONCEPT: one click → any deck). */
    async deckLoadTake(deck: number, path: string) {
      if (!link) return
      // The decode runs on the shell's worker thread now (P1-11); mark the deck
      // busy so the UI shows it working instead of looking frozen.
      useAppStore.getState().setDeckLoadProgress(deck, 0)
      useAppStore.getState().setDeckLoading(deck, true)
      try {
        const r = await link.command('deckLoadTake', { deck, path })
        useAppStore.getState().setDeckUnresolved(deck, !r.ok)
        if (r.ok) {
          setDeckSourcePath(deck, path)
          useAppStore.getState().setDeckFrames(deck, r.engineFrames)
          bumpDeckRevision(deck)
        }
      } finally {
        useAppStore.getState().setDeckLoading(deck, false)
      }
    },
    async deckLoadFile(deck: number) {
      if (!link) return
      // The dialog itself is quick; the decode after it is the slow part, and
      // only starts once a file is chosen. Marking busy around the whole call is
      // harmless (the dialog is brief) and covers the decode.
      useAppStore.getState().setDeckLoadProgress(deck, 0)
      useAppStore.getState().setDeckLoading(deck, true)
      try {
        const r = await link.command('deckLoadFile', { deck })
        if (r.ok) {
          setDeckSourcePath(deck, r.path)
          bumpDeckRevision(deck) // the buffer changed → the waveform refetches
        }
      } finally {
        useAppStore.getState().setDeckLoading(deck, false)
      }
    },
  }
}
