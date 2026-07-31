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
import { attachScenePins } from '../state/scenePins.ts'
import { projectScene } from '../audio/sceneProjection.ts'
import {
  applyGridRow,
  gridDocument,
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
    // ↻ locator repeat — the PATTERN-wire member of this family (P3.5-E8g-d). The two
    // above push `updateRuntime`; `locatorRepeatActive` is not on the runtime wire at
    // all, so this one republishes the row's document topic instead.
    browserLink.setLocatorRepeatHandler((trackIndex) => {
      toggleLocatorRepeatTrack(trackIndex, deck)
      browserLink.gridBackend.updatePatternRow(trackIndex, gridDocument(deck))
    })
    browserLink.setMuteGroupHandler((trackIndex) => {
      useCompanion.getState().toggleMuteGroupMember(trackIndex, deck)
      browserLink.gridBackend.updateRuntime(gridRuntimeInfos(deck))
    })
    // THE SINGLE-SPACE RULE (B1): Space in the compose window starts the deck
    // this window is composing. Compose-scoped like the handlers above (this
    // grid has no deck axis of its own) but aimed at THIS deck, the same
    // distinction every registration here makes.
    browserLink.setTransportHandler((op) => {
      const c = useCompanion.getState()
      if (op === 'play') c.play(deck)
      else if (op === 'stop') c.stop(deck)
      else {
        c.stop(deck)
        c.play(deck)
      }
    })
    // B2: the pin state follows the grid being EDITED, and in this window that
    // is unambiguous — one compose window, one deck.
    const offPins = attachScenePins(deck)
    // P3.5-E8a — THE DOORS THIS BINDING NEVER REGISTERED. `GridPanel` draws a
    // LOAD button on every audio row and takes a browser row dropped on it, but
    // both are intents `BrowserLink` forwards to a handler; with none
    // registered, `trackEdit` falls through to a silent `{ok:true}`. So in the
    // compose window — the surface a person reaches for a sample IN — LOAD
    // accepted the click and did nothing. Compose-scoped (this grid has no deck
    // axis) but written into THIS deck's document, like every handler above.
    registerSampleDoors(browserLink, deck, 'compose')
    return offPins
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
    // `session.name` is the DOCUMENT'S IDENTITY (P3.5-E8g-e) — this effect re-runs on every
    // document edit, and without it the reload sent the grid cursor home to track 0 each time.
    // A scene switch keeps the cursor deliberately: same document, same tracks.
    browserLink.gridBackend.load(
      projectScene(session.pattern, scene) as Record<string, unknown>,
      gridRuntimeInfos(deck),
      session.name,
    )
  }, [browserLink, session, scene, deck])

  useEffect(() => {
    browserLink?.gridBackend.setPlaying(playing)
  }, [browserLink, playing])

  return { session, playing }
}
