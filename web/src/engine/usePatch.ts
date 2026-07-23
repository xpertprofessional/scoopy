/**
 * Patch edit + publish helpers. Topology edits go through here so the
 * republish can never be forgotten (ownership law: TS owns the document, the
 * engine follows). Live param moves (fader drags, mutes) use paramWrite and
 * update the local document WITHOUT republishing — the next publish carries
 * the same values, so the two paths cannot diverge.
 */
import type { Patch, SourceRef } from '../../protocol/schema'
import { useAppStore } from '../store/appStore'
import type { EngineLink } from './engineLink'

export function publishPatch(link: EngineLink | null, patch: Patch): void {
  if (!link) return
  void link.command('publishWorld', { patch }).catch(() => {
    // A refused publish leaves the previous world running; the document stays
    // authoritative and the next successful publish reconciles.
  })
}

export function usePatchActions(link: EngineLink | null) {
  const addChannel = useAppStore((s) => s.addChannel)
  const addDeck = useAppStore((s) => s.addDeck)
  const setChannelParam = useAppStore((s) => s.setChannelParam)
  const setDeckSourcePath = useAppStore((s) => s.setDeckSourcePath)

  return {
    /** Bind a source as a new strip and publish the new topology. */
    addSourceChannel(name: string, source: SourceRef) {
      publishPatch(link, addChannel(name, source))
    },
    /** Add a deck + its strip and publish. */
    addDeckWithStrip() {
      publishPatch(link, addDeck())
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
    /** Deck transport intents; state truth returns via HotFrame. */
    deckTrigger(deck: number, mode: 'loop' | 'oneShot' | 'stop' | 'retrigger') {
      void link?.command('deckTrigger', { deck, mode })
    },
    async deckLoadFile(deck: number) {
      if (!link) return
      const r = await link.command('deckLoadFile', { deck })
      if (r.ok) setDeckSourcePath(deck, r.path)
    },
  }
}
