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
    outputMap: { main: [0, 1], monitor: info?.monitorAvailable ? [2, 3] : null },
  }
  void link.command('publishWorld', { patch: withMap }).catch(() => {
    // A refused publish leaves the previous world running; the document stays
    // authoritative and the next successful publish reconciles.
  })
}

export function usePatchActions(link: EngineLink | null) {
  const addChannel = useAppStore((s) => s.addChannel)
  const addDeck = useAppStore((s) => s.addDeck)
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
    addSourceChannel(name: string, source: SourceRef) {
      publishPatch(link, addChannel(name, source))
    },
    /** Add a deck + its strip and publish. */
    addDeckWithStrip() {
      publishPatch(link, addDeck())
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
      setDeckLoopRegion(deck, startSample, endSample)
      void link?.command('deckSetLoop', { deck, enabled: true, startSample, endSample })
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
      if (r.ok && r.take) addTake(r.take)
      bumpDeckRevision(deck) // a take just became this deck's buffer (Law C-3)
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
      const r = await link.command('deckLoadTake', { deck, path })
      if (r.ok) {
        setDeckSourcePath(deck, path)
        bumpDeckRevision(deck)
      }
    },
    async deckLoadFile(deck: number) {
      if (!link) return
      const r = await link.command('deckLoadFile', { deck })
      if (r.ok) {
        setDeckSourcePath(deck, r.path)
        bumpDeckRevision(deck) // the buffer changed → the waveform refetches
      }
    },
  }
}
