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
import { attachScenePins } from '../state/scenePins.ts'
// ⚠️ REHOMED (B1-RETIRE). `djmode.css` styles `.track-strips.density-dj` — the
// DJ-density track rows THIS tile mounts — and its only importer was
// `DjPanel`, which is deleted. Panels share one bundle, so the stylesheet
// arrived globally and nothing pointed at the dependency; removing that panel
// would have stripped the tile's row metrics with no error anywhere. The
// import belongs with the surface that needs it.
import '../panels/djmode.css'
import type { EngineLink } from '../engineLink.ts'
import { HotFrameLayout } from '../../protocol/schema.ts'
import { projectScene, type SceneLetter } from '../audio/sceneProjection.ts'
import { lcmForScene } from '../audio/patternClock.ts'
import { GridPanel, djSource, type Density } from '../panels/GridPanel.tsx'
import { registerSampleDoors } from '../panels/sampleDoors.ts'
import { deckTempoIntent } from '../persist/tempo.ts'
import { useNudge } from '../state/nudgeStore.ts'
import { liveSetSend, useMapStore } from '../state/mapStore.ts'
import type { Strip as StripDoc } from '../persist/mapDocument.ts'
import type { WorkingSession } from '../store/sessionStore.ts'
import {
  applyGridRow,
  applyTopologyUndo,
  setDocumentEditAnnouncer,
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
/** The live scene-pin subscription, so re-claiming REPLACES it rather than
    stacking another store listener on every pointerdown. */
let offScenePins: (() => void) | null = null

/** Give the arrow keys to `deck` — called on pointerdown in a tile.
 *
 * It also moves the SCENE-PIN state (B2): "the deck being edited" is the same
 * question both answer, and two mounted tiles would otherwise fight over one
 * global pin store. Whichever tile you last touched is the one whose pins a
 * right-click menu talks about — the same arbitration, one claim. */
export function claimKeyboard(deck: number): void {
  if (keyboardDeck === deck) return
  keyboardDeck = deck
  offScenePins?.()
  offScenePins = attachScenePins(deck)
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
  // Read REACTIVELY, or the meta below would only pick engagement up on the
  // next unrelated re-render — the M buttons would keep editing their own mute
  // until something else moved.
  const muteGroupActive = useCompanion((c) => c.decks[deck]?.muteGroupActive ?? false)
  // THE STRIP BEHIND THIS DECK, found by deck rather than passed in — the plane
  // hands `DeckFace` a strip, but the plugin's face is built from the same
  // binding with a one-strip map it installs itself, and looking it up here
  // means neither caller has to remember to thread it through. Subscribed, so
  // moving a send re-renders the row that shows it.
  const deckStrip = useMapStore(
    (s) =>
      s.map.strips.find((st) => st.element.kind === 'grid' && st.element.deck === deck) ?? null,
  )
  const browserLink = link instanceof BrowserLink ? link : null

  // The per-deck handler slots — every gesture the dj band fires lands on THIS
  // deck's document. Mirrors useComposeBinding's registrations plus the two
  // sample doors.
  //
  // ⚠️ This used to claim "the band's header row carries browse·LOAD at dj
  // density too". It does NOT, and never did: `trackRowControls` gates the whole
  // H row — name · browse ◀▶ · LOAD — on `!dj`. On the plane that omission is
  // deliberate and harmless (sample browsing is sound design, and a compose
  // window is one double-click away), but ScoopyDeck mounts a deck and nothing
  // else, so it left the plugin with NO WAY TO LOAD A SAMPLE AT ALL — reported
  // from the real host, 2026-08-01. The doors below were registered and correct
  // the whole time; there was simply no control wired to them. Fixed by the
  // COMPOSE/DECK view switch (`viewDensity`), not by growing a second LOAD here.
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
    browserLink.setMuteGroupHandler((trackIndex) => {
      useCompanion.getState().toggleMuteGroupMember(trackIndex, deck)
      browserLink.djGridBackend(deck).updateRuntime(gridRuntimeInfos(deck))
    }, deck)
    browserLink.setTopologyUndoHandler((d, pattern) => applyTopologyUndo(d, pattern), deck)
    setDocumentEditAnnouncer((d, scope) =>
      browserLink.emitEvent({ type: 'swiftEdit', scope, deck: d }),
    )
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
        // CM-5b: with the group engaged, this grid's M buttons edit MEMBERSHIP.
        muteGroupActive,
        // THE DECK'S MASTER SENDS — the strip channel's four sends, which is
        // what `core.setDeckMasterSend` is already fed from. MasterRow rendered
        // this cluster from a hard-coded [] on every host, so it never appeared
        // anywhere; with no strip behind this mount it stays empty, which is
        // still how the compose grid hides it honestly.
        masterSends: deckStrip ? [...deckStrip.sends] : [],
      })
    refresh()
    keyboardWatchers.set(deck, refresh)
    return () => {
      keyboardWatchers.delete(deck)
      // An unmounting tile releases its claim — a hidden panel must not keep
      // answering the arrow keys.
      if (keyboardDeck === deck) {
        keyboardDeck = null
        // The pin state goes with the claim: a hidden tile must not keep
        // answering what "the deck being edited" means.
        offScenePins?.()
        offScenePins = null
      }
      browserLink.djGridBackend(deck).setMetaFacts({ keyboardActive: false })
    }
  }, [browserLink, deck, element, masterBpm, nudge, muteGroupActive, deckStrip])

  // …and the WRITE half. MasterRow's S-fader write had no arm anywhere and fell
  // to BrowserLink's "no document" warn, so the four faders moved nothing. This
  // RECEIVES that write (the row is still its only author — see
  // `uiOwnership.test.ts`) and lands it where the value actually lives: the
  // strip channel's sends. `liveSetSend` updates the document AND emits
  // `slChannel setSend`, which the engine projects onto the deck's master send.
  useEffect(() => {
    if (!browserLink || !deckStrip) return
    browserLink.setDeckMasterSendHandler((_d, send, level) => {
      liveSetSend(link, deckStrip, send, level)
    })
  }, [browserLink, link, deckStrip])

  return { session, scene }
}

/**
 * The expanded face's GridPanel region: the real dj deck rows, scrolling in
 * their own overflow (never the plane's).
 *
 * `djSlotIndex` DEFAULTS to undefined, and on the plane that is still right:
 * the plane has no fixed columns, so there is no left/right arrow ring to
 * register with, and the keyboard claim above is the arbitration that matters.
 *
 * ScoopyDeck passes 0, because a plugin has exactly ONE deck and it is
 * unambiguously the first slot. What that buys (all disabled while the prop is
 * undefined — DECKPLUGIN v2 §8):
 *   · `GridPanel.tsx:663` — FOCUS ADOPTION. When the keyboard claim lands on
 *     this deck the ring comes with it. Without the prop the claim moved and
 *     the ring did not, so ö/ä kept driving whatever box last had it and the
 *     keys read as doing nothing. This is the reported "focus doesn't stick".
 *   · `GridPanel.tsx:695` — the cross-deck focus bridge registers. Harmless
 *     with one deck; correct the day a second exists.
 * The launch-transient default (`:481`) is unchanged: `undefined` and `0` both
 * start active, which is what a single-deck host wants.
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
  djSlotIndex,
  viewDensity,
  onLaunch,
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
  /** Which fixed deck column this face occupies; omit on the plane, which has
      none. See the note above for exactly what it turns on. */
  djSlotIndex?: number
  /** Draw the rows at a different density than the deck source implies — see
      `GridPanel.viewDensity`. Omit on the plane: a strip's expanded face is a
      deck face, and COMPOSE is a window you open instead. ScoopyDeck has no
      such window, so its COMPOSE/DECK switch lands here. */
  viewDensity?: Density
  /** What ⟳ does. Omit for the plane's immediate play; ScoopyDeck passes a
      host-grid quantized launch. See `DeckRowsProps.onLaunch`. */
  onLaunch?: () => void
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
    onLaunch,
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
        <GridPanel
          link={link}
          source={source}
          cellsHidden={cellsHidden}
          djSlotIndex={djSlotIndex}
          viewDensity={viewDensity}
        />
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
