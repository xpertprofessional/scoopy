/**
 * Bind ONE deck's session to this WebView's grid backend — the three effects
 * that make `GridPanel` a composer for a deck, extracted from `Composer.tsx`
 * (P3-C1) so the in-window overlay and the separate compose window share one
 * implementation. A drifted copy here is an edit that lands in the document
 * and never reaches the engine — which looks exactly like a broken grid.
 */
import { useEffect } from 'react'

import type { EngineLink } from '../engineLink.ts'
import { BrowserLink } from '../browserLink.ts'
import { registerSampleDoors } from '../panels/sampleDoors.ts'
import { projectScene } from '../audio/sceneProjection.ts'
import {
  applyGridRow,
  gridPeakPaths,
  gridRuntimeInfos,
  toggleLocatorRepeatTrack,
  useCompanion,
} from '../store/companionEngine.ts'

export function useComposeBinding(link: EngineLink | null, deck: number) {
  const session = useCompanion((c) => c.decks[deck]?.session ?? null)
  const scene = useCompanion((c) => c.decks[deck]?.scene ?? 'A')
  const playing = useCompanion((c) => c.decks[deck]?.playing ?? false)
  const browserLink = link instanceof BrowserLink ? link : null

  useEffect(() => {
    if (!browserLink) return
    // Every edit the grid publishes is folded into THIS deck's session. Without
    // the deck argument an edit made in a strip's composer would land in deck
    // 0's document — silently, and visible only on the other strip.
    browserLink.setGridEditHandler((trackIndex, row) => applyGridRow(trackIndex, row, deck))
    browserLink.setLaunchToggleHandler((trackIndex) => {
      useCompanion.getState().toggleLaunch(trackIndex, deck)
      browserLink.gridBackend.updateRuntime(gridRuntimeInfos(deck))
    })
    browserLink.setSoloToggleHandler((trackIndex) => {
      useCompanion.getState().toggleSoloTrack(trackIndex, deck)
      browserLink.gridBackend.updateRuntime(gridRuntimeInfos(deck))
    })
    browserLink.setLocatorRepeatHandler((trackIndex) => toggleLocatorRepeatTrack(trackIndex, deck))
    // P3.5-E8a — THE DOORS THIS BINDING NEVER REGISTERED. `GridPanel` draws a
    // LOAD button on every audio row and takes a browser row dropped on it, but
    // both are intents `BrowserLink` forwards to a handler; with none
    // registered, `trackEdit` falls through to a silent `{ok:true}`. So in the
    // compose window — the surface a person reaches for a sample IN — LOAD
    // accepted the click and did nothing. Compose-scoped (this grid has no deck
    // axis) but written into THIS deck's document, like every handler above.
    registerSampleDoors(browserLink, deck, 'compose')
  }, [browserLink, deck])

  useEffect(() => {
    if (!browserLink) return
    if (!session) {
      browserLink.gridBackend.clear()
      return
    }
    browserLink.setGridPeakPaths(gridPeakPaths(deck))
    // The grid shows (and edits) the ACTIVE SCENE's PROJECTION — what you see is
    // what you hear; the write path splits the edited row back into the scene's
    // section vs sectionA (applyGridRow). `scene` is a dependency for that
    // reason: without a reload the grid would show scene A's pattern while the
    // engine played scene C.
    browserLink.gridBackend.load(
      projectScene(session.pattern, scene) as Record<string, unknown>,
      gridRuntimeInfos(deck),
    )
  }, [browserLink, session, scene, deck])

  useEffect(() => {
    browserLink?.gridBackend.setPlaying(playing)
  }, [browserLink, playing])

  return { session, playing }
}
