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
import { useEffect, useMemo, useRef, useState } from 'react'

import { BrowserLink } from '../browserLink.ts'
import { DeckSceneRow, DeckSyncRow, DeckToolbarRow, DeckViewRow } from './deckRows.tsx'
import type { EngineLink } from '../engineLink.ts'
import { HotFrameLayout } from '../../protocol/schema.ts'
import { projectScene, type SceneLetter } from '../audio/sceneProjection.ts'
import { lcmForScene } from '../audio/patternClock.ts'
import { GridPanel, djSource } from '../panels/GridPanel.tsx'
import { registerSampleDoors } from '../panels/sampleDoors.ts'
import { deckTempoIntent } from '../persist/tempo.ts'
import { useNudge } from '../state/nudgeStore.ts'
import type { Strip as StripDoc } from '../persist/mapDocument.ts'
import type { WorkingSession } from '../store/sessionStore.ts'
import {
  applyGridRow,
  gridDocument,
  gridPeakPaths,
  gridRuntimeInfos,
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
): { session: WorkingSession | null; scene: SceneLetter } {
  const deck = element.deck
  const session = useCompanion((c) => c.decks[deck]?.session ?? null)
  const scene = useCompanion((c) => c.decks[deck]?.scene ?? 'A')
  const playing = useCompanion((c) => c.decks[deck]?.playing ?? false)
  // The transient hold-to-bend (P3-D4-2) — folded into the resolved-tempo
  // display so the strike-through shows what the deck runs at UNDER the hand.
  const nudge = useNudge((s) => s.deltas[deck] ?? 0)
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
    // ↻ locator repeat — pattern wire, not runtime (P3.5-E8g-d), so it republishes
    // THIS tile's `djPattern/<deck>/<i>` rather than pushing runtime infos.
    browserLink.setLocatorRepeatHandler((trackIndex) => {
      toggleLocatorRepeatTrack(trackIndex, deck)
      browserLink.djGridBackend(deck).updatePatternRow(trackIndex, gridDocument(deck))
    }, deck)
    // THE SINGLE-SPACE RULE (B1): Space in this tile starts THIS deck. The
    // keymap has always sent `menuTransport`; nothing answered it, so the key
    // was dead in the merged host. Restart is stop-then-play — a publish is
    // phase-continuous, so it cannot double as a retrigger.
    browserLink.setTransportHandler((op) => {
      const c = useCompanion.getState()
      if (op === 'play') c.play(deck)
      else if (op === 'stop') c.stop(deck)
      else {
        c.stop(deck)
        c.play(deck)
      }
    }, deck)
    // Both sample doors, deck-scoped — the tile addresses the grid WITH a deck,
    // so its LOAD lands in ITS document (P3.5-E8a shares the registration with
    // the compose window, which had none at all).
    registerSampleDoors(browserLink, deck, 'deck')
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
    // Document identity, so an edit does not send this tile's cursor home (P3.5-E8g-e).
    backend.load(
      projectScene(session.pattern, scene) as Record<string, unknown>,
      gridRuntimeInfos(deck),
      session.name,
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
        syncedBpm: deckTempoIntent(element, masterBpm, nudge).syncedBpm,
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
  }, [browserLink, deck, element, masterBpm, nudge])

  return { session, scene }
}

/**
 * The expanded face's GridPanel region: the real dj deck rows, scrolling in
 * their own overflow (never the plane's). `djSlotIndex` stays undefined — the
 * plane has no fixed columns, so there is no cross-deck arrow ring here; the
 * keyboard claim above is the arbitration that matters.
 */
export function DeckFace({
  link,
  strip,
  element,
  masterBpm,
  sessions = [],
  onLoadSession,
  onDropElement,
  doubleTargets = [],
  onDouble,
  locked = false,
}: {
  link: EngineLink | null
  strip: StripDoc
  element: GridElement
  masterBpm: number
  sessions?: { name: string }[]
  onLoadSession?: (name: string) => void
  onDropElement?: () => void
  doubleTargets?: { key: string; label: string; deck: number }[]
  onDouble?: (targetDeck: number) => void
  /** P3-C2: a compose window owns this deck — the rows lock with it. */
  locked?: boolean
}) {
  const { session, scene } = useDeckTileBinding(link, element, masterBpm)
  // STABLE identity (the DjPanel DeckSlot rule): GridPanel keys its topic
  // subscriptions off `source`, so a fresh object each render would tear down
  // and re-subscribe every topic every frame.
  const source = useMemo(() => djSource(element.deck), [element.deck])
  // GRID/PERF — the tile's own view state. SESSION LIFETIME by user ruling
  // (2026-07-31): the donor persists gridHidden as a UI pref, and a follow-up
  // row carries it into the MAPPERF overlay if it itches.
  const [cellsHidden, setCellsHidden] = useState(false)
  const [performActive, setPerformActive] = useState(false)

  // PERF rides the meta topic (GridPanel reads `meta.performActive`), so the
  // toggle has to reach the backend rather than the panel — the same lane the
  // keyboard claim uses.
  const browserLink = link instanceof BrowserLink ? link : null
  useEffect(() => {
    browserLink?.djGridBackend(element.deck).setMetaFacts({ performActive })
  }, [browserLink, element.deck, performActive])

  const rowProps = {
    strip,
    element,
    link,
    masterBpm,
    sessions,
    onLoadSession,
    onDropElement,
    doubleTargets,
    onDouble,
    locked,
    cellsHidden,
    onToggleCells: () => setCellsHidden((v) => !v),
    performActive,
    onTogglePerform: () => setPerformActive((v) => !v),
  }

  return (
    <>
      {/* THE CLASSIC DECK ROWS, above the grid — the donor's deck block on this
          app's lanes (B1 · STRIP-DECK.md). Rebuilt rather than mounted from
          TransportPanel, whose every verb is unanswered (D-SL-DECKFULL-01). */}
      <DeckToolbarRow {...rowProps} />
      <DeckSyncRow {...rowProps} />
      <DeckSceneRow {...rowProps} />
      <DeckViewRow {...rowProps} />
      <div
        className="strip-deckface"
        data-no-drag
        onPointerDownCapture={() => claimKeyboard(element.deck)}
        // A wheel INSIDE the tile scrolls the deck's own rows; without this it
        // bubbles to the plane surface and ZOOMS THE WORLD instead — the tile
        // becomes uncontrollable the moment you try to reach track five (the
        // user's first real-host complaint, 2026-07-29).
        onWheel={(e) => e.stopPropagation()}
      >
        <GridPanel link={link} source={source} cellsHidden={cellsHidden} />
      </div>
      <LcmBar link={link} deck={element.deck} session={session} scene={scene} />
    </>
  )
}

/**
 * THE LCM BAR (P3-D4-2, the sketch's `▓▓▓░░ LCM` row): where the deck is in
 * its pattern cycle. Computed WEB-SIDE from what is real — the engine's
 * per-deck playhead step (`playheadStepDeck<d>`, written since before D4-3)
 * folded through the session's own LCM (`lcmForScene`) — because the desktop's
 * `lcmPosDeck*` HotFrame fields have NO writer in the merged engine and a bar
 * fed by zero-filled slots would sit frozen at 0 forever.
 *
 * Painted on the HotFrame callback via a ref, the StripMeter pattern — a
 * 30 Hz progress bar must not re-render React.
 */
function LcmBar({
  link,
  deck,
  session,
  scene,
}: {
  link: EngineLink | null
  deck: number
  session: WorkingSession | null
  scene: SceneLetter
}) {
  const fillRef = useRef<HTMLSpanElement | null>(null)
  const lcm = session ? lcmForScene(session.pattern, scene) : 0
  useEffect(() => {
    if (!link || lcm <= 0) return
    const idx = (HotFrameLayout as Record<string, number>)[`playheadStepDeck${deck}`]
    if (idx === undefined) return
    return link.onHotFrame((frame) => {
      const step = frame[idx] ?? -1
      const frac = step < 0 ? 0 : (step % lcm) / lcm
      if (fillRef.current) fillRef.current.style.width = `${(frac * 100).toFixed(1)}%`
    })
  }, [link, deck, lcm])
  return (
    <div
      className="strip-lcm"
      title={lcm > 0 ? `pattern cycle — ${lcm} steps` : 'pattern cycle'}
      aria-label="pattern cycle position"
    >
      <span ref={fillRef} className="strip-lcm-fill" />
      <span className="strip-lcm-label mono">LCM</span>
    </div>
  )
}
