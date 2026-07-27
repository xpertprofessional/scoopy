/**
 * COMPOSE BESIDE THE MAP — the real grid composer, on the plane's own window.
 *
 * ⚠️ WHY IT IS NOT A SEPARATE WINDOW, which is what the plane tried first and
 * what `pd-plane-playground` assumed. Three things were wrong with it, and only
 * the first looks like a bug:
 *
 *   1. `openPanelWindow` DROPS its arg — `MergedMain.cpp` calls
 *      `openPanelFn(panel)` and nothing sets `window.__slPanelArg`, which
 *      `InstrumentPanel`/`FxSlotPanel` read and `GridPanel` never did. So the
 *      window could not be told which deck it was for.
 *   2. Nothing loads a session into it. `GridPanel` is served by `BrowserLink`'s
 *      `GridBackend`, and the only caller of `gridBackend.load()` is
 *      `CompanionPanel`. On the desktop this was Swift's job (`WebGridBinding`
 *      serving `gridMeta` / `gridPattern/<i>` / `gridRuntime/<i>`), and Swift is
 *      carved off.
 *   3. Underneath both: EVERY PANEL WINDOW IS A SEPARATE WEBVIEW with its own
 *      `companionEngine`. Even with the arg delivered and a session loaded, two
 *      windows holding the same deck would each publish their own world for it
 *      and the stale one would win whenever it published last.
 *
 * In-window keeps ONE store as the only publisher, which DELETES (3) rather
 * than solving it — no cross-window document relay, no ownership handshake.
 * What it costs is the separate-window ergonomics, which is a real loss and a
 * cheap one to reverse later if the relay ever gets built.
 *
 * The composer itself is `GridPanel`, reused unmodified. This wires it to a
 * DECK: the same `load` / `setPlaying` / `updateRuntime` calls `CompanionPanel`
 * makes, aimed at one deck instead of at "the session".
 */
import { useEffect } from 'react'

import type { EngineLink } from '../engineLink.ts'
import { BrowserLink } from '../browserLink.ts'
import { GridPanel } from '../panels/GridPanel.tsx'
import { projectScene } from '../audio/sceneProjection.ts'
import {
  applyGridRow,
  gridPeakPaths,
  gridRuntimeInfos,
  toggleLocatorRepeatTrack,
  useCompanion,
} from '../store/companionEngine.ts'

/**
 * Bind a deck's session to the grid backend for as long as this is mounted.
 *
 * Lifted from `CompanionPanel`'s effect rather than copied: the two would
 * otherwise drift, and the failure mode of a drifted copy here is an edit that
 * lands in the document and never reaches the engine — which looks exactly like
 * a broken grid.
 */
export function Composer({
  link,
  deck,
  onClose,
}: {
  link: EngineLink | null
  deck: number
  onClose: () => void
}) {
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

  return (
    <section className="plane-composer" aria-label={`compose ${session?.name ?? ''}`}>
      <header className="plane-composer-bar">
        <span className="mono">
          {session ? `compose · ${session.name}` : 'compose · nothing loaded'}
        </span>
        <span className="mono dim">deck {deck}</span>
        <span className="plane-spacer" />
        <button type="button" onClick={onClose} title="back to the plane">
          close
        </button>
      </header>
      {/* The REAL composer, unmodified — the same component the desktop runs. */}
      <div className="plane-composer-body">
        <GridPanel link={link} />
      </div>
    </section>
  )
}
