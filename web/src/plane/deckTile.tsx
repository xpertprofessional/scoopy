/**
 * THE DECK TILE (P3-D4-1, STRIP-DECK.md, D-SL-MORPH-01) — a session-loaded
 * strip expanded to host the REAL `GridPanel` at DJ density: the same component
 * that IS the DJ deck view in scoopyloops since AR-6, mounted against this
 * deck's document through the dj topic family (`djMeta/<d>` …) that nothing in
 * the merged host served before.
 *
 * The binding is `useComposeBinding`'s sibling with the deck axis made
 * explicit: it feeds the dj backend (`djGridBackend(deck)`) and registers the
 * per-deck handler slots, so three mounted tiles are three independent
 * documents — the "last mount wins" defect D4-M measured cannot exist here.
 *
 * KEYBOARD ARBITRATION (the D4-M note): `GridPanel@dj` answers arrow keys
 * whenever its meta says `keyboardActive` — with three tiles mounted, three
 * panels would fight over every keystroke. Exactly ONE deck holds the claim:
 * the last tile the pointer went down in. Module state rather than React state
 * because the claim spans strips that do not share an owner component.
 *
 * Inherited hazard, accepted + noted (STRIP-DECK.md item 6): `undoStore` is
 * keyed by track only, so expanded tiles share one ⌘Z timeline — same as DJ
 * mode on the desktop.
 */
import { useEffect, useMemo } from 'react'

import { BrowserLink } from '../browserLink.ts'
import type { EngineLink } from '../engineLink.ts'
import { projectScene } from '../audio/sceneProjection.ts'
import { GridPanel, djSource } from '../panels/GridPanel.tsx'
import { pickAudioFile } from '../panels/CompanionPanel.tsx'
import { deckTempoIntent } from '../persist/tempo.ts'
import type { Strip as StripDoc } from '../persist/mapDocument.ts'
import {
  applyGridRow,
  gridPeakPaths,
  gridRuntimeInfos,
  importAudioFile,
  toggleLocatorRepeatTrack,
  useCompanion,
} from '../store/companionEngine.ts'

type GridElement = Extract<StripDoc['element'], { kind: 'grid' }>

/** Which deck holds the keyboard claim, and who to tell when it moves. */
let keyboardDeck: number | null = null
const keyboardWatchers = new Map<number, () => void>()

/** Give the arrow keys to `deck` — called on pointerdown in a tile. */
export function claimKeyboard(deck: number): void {
  if (keyboardDeck === deck) return
  keyboardDeck = deck
  keyboardWatchers.forEach((refresh) => refresh())
}

/** Test seam: the current claim holder. */
export function keyboardDeckForTest(): number | null {
  return keyboardDeck
}

/**
 * Bind deck `deck`'s session to this WebView's dj grid backend. Mounted by the
 * expanded face only — a collapsed strip pays nothing.
 */
export function useDeckTileBinding(
  link: EngineLink | null,
  element: GridElement,
  masterBpm: number,
): void {
  const deck = element.deck
  const session = useCompanion((c) => c.decks[deck]?.session ?? null)
  const scene = useCompanion((c) => c.decks[deck]?.scene ?? 'A')
  const playing = useCompanion((c) => c.decks[deck]?.playing ?? false)
  const browserLink = link instanceof BrowserLink ? link : null

  // The per-deck handler slots — every gesture the dj band fires lands on THIS
  // deck's document. Mirrors useComposeBinding's registrations plus the two
  // sample doors (the band's header row carries browse·LOAD at dj density too,
  // and a LOAD that does nothing is a dead control — the four-rules line).
  useEffect(() => {
    if (!browserLink) return
    browserLink.setGridEditHandler((trackIndex, row) => applyGridRow(trackIndex, row, deck), deck)
    browserLink.setLaunchToggleHandler((trackIndex) => {
      useCompanion.getState().toggleLaunch(trackIndex, deck)
      browserLink.djGridBackend(deck).updateRuntime(gridRuntimeInfos(deck))
    }, deck)
    browserLink.setSoloToggleHandler((trackIndex) => {
      useCompanion.getState().toggleSoloTrack(trackIndex, deck)
      browserLink.djGridBackend(deck).updateRuntime(gridRuntimeInfos(deck))
    }, deck)
    browserLink.setLocatorRepeatHandler(
      (trackIndex) => toggleLocatorRepeatTrack(trackIndex, deck),
      deck,
    )
    browserLink.setSampleLoadHandler(async (trackIndex, path) => {
      await useCompanion.getState().loadSample(trackIndex, path, deck)
    }, deck)
    browserLink.setSamplePickHandler(async (trackIndex) => {
      try {
        const file = await pickAudioFile()
        if (!file) return
        const path = await importAudioFile(file)
        await useCompanion.getState().loadSample(trackIndex, path, deck)
        void browserLink.command('fileBrowser', { op: 'refresh' })
      } catch (err) {
        useCompanion.setState({ error: `sample import failed: ${(err as Error).message}` })
      }
    }, deck)
  }, [browserLink, deck])

  // The document into the backend — the active scene's projection, reloaded on
  // session/scene moves, exactly the compose binding's law.
  useEffect(() => {
    if (!browserLink) return
    const backend = browserLink.djGridBackend(deck)
    if (!session) {
      backend.clear()
      return
    }
    browserLink.setGridPeakPaths(gridPeakPaths(deck), deck)
    backend.load(
      projectScene(session.pattern, scene) as Record<string, unknown>,
      gridRuntimeInfos(deck),
    )
  }, [browserLink, session, scene, deck])

  useEffect(() => {
    browserLink?.djGridBackend(deck).setPlaying(playing)
  }, [browserLink, playing, deck])

  // The mount-owned meta facts: deck identity, the sync law's resolved tempo
  // (the strike-through display the user called out — sync/nudge shows what
  // the deck ACTUALLY runs at), and the keyboard claim.
  useEffect(() => {
    if (!browserLink) return
    const refresh = () =>
      browserLink.djGridBackend(deck).setMetaFacts({
        deckIndex: deck,
        syncedBpm: deckTempoIntent(element, masterBpm).syncedBpm,
        keyboardActive: keyboardDeck === deck,
      })
    refresh()
    keyboardWatchers.set(deck, refresh)
    return () => {
      keyboardWatchers.delete(deck)
      // An unmounting tile releases its claim — a hidden panel must not keep
      // answering the arrow keys.
      if (keyboardDeck === deck) keyboardDeck = null
      browserLink.djGridBackend(deck).setMetaFacts({ keyboardActive: false })
    }
  }, [browserLink, deck, element, masterBpm])
}

/**
 * The expanded face's GridPanel region: the real dj deck rows, scrolling in
 * their own overflow (never the plane's). `djSlotIndex` stays undefined — the
 * plane has no fixed columns, so there is no cross-deck arrow ring here; the
 * keyboard claim above is the arbitration that matters.
 */
export function DeckFace({
  link,
  element,
  masterBpm,
}: {
  link: EngineLink | null
  element: GridElement
  masterBpm: number
}) {
  useDeckTileBinding(link, element, masterBpm)
  // STABLE identity (the DjPanel DeckSlot rule): GridPanel keys its topic
  // subscriptions off `source`, so a fresh object each render would tear down
  // and re-subscribe every topic every frame.
  const source = useMemo(() => djSource(element.deck), [element.deck])
  return (
    <div
      className="strip-deckface"
      data-no-drag
      onPointerDownCapture={() => claimKeyboard(element.deck)}
    >
      <GridPanel link={link} source={source} />
    </div>
  )
}
