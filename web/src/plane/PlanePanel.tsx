/**
 * The plane panel — the merged app's top-level surface (merge P2 step 4).
 *
 * A plane of strips, each a uniform channel hosting a composable element. This
 * is the panel `WizardMerged` opens as its main window.
 *
 * IT SUBSCRIBES TO NO UiState TOPIC, and that is a design constraint rather
 * than an omission: the merged shell publishes none (it emits HotFrame only,
 * and answers `getUiState` with `{}` for every topic), so any panel that waited
 * on one would render its waiting state forever there. It also happens to be
 * the right shape — wizard's law is that TS owns the document and the engine
 * follows, so the plane's truth is the `.scoopyMap` in the store, and the only
 * things it reads back are telemetry (HotFrame) and the routing graph.
 */
import { useEffect, useRef, useState } from 'react'
import type { EngineLink } from '../engineLink.ts'
import type { Strip } from '../persist/mapDocument.ts'
import { PanelTitle } from '../design/controls.tsx'
import {
  bootMap,
  checkBudget,
  getMap,
  setMasterBpm,
  getMapName,
  setMasterLevel,
  useMapStore,
} from '../state/mapStore.ts'
import { useContextMenu } from '../design/ContextMenu.tsx'
import { attachAutosave, exportMap, listMaps, openMap, saveMapAs } from '../state/mapFiles.ts'
import { carve } from './carve.ts'
import { Inspector } from './Inspector.tsx'
import { Master } from './Master.tsx'
import { Matrix } from './Matrix.tsx'
import { Plane } from './Plane.tsx'
import { refreshDevices } from './devices.ts'
import { send } from './send.ts'
import {
  freeChannel,
  freeDeck,
  inputRoute,
  nameAfterSessionLoad,
  newGridElement,
  newStrip,
  spawnPoint,
} from './stripOps.ts'
import { useCompanion } from '../store/companionEngine.ts'
import { juceBackend } from '../../protocol/juceLink.ts'
import { autoStartEngine } from './bootEngine.ts'
import { deckTempoIntent, formatSyncedBpm } from '../persist/tempo.ts'
import { applyTempo, updateStrip } from '../state/mapStore.ts'
import { Composer } from './Composer.tsx'
import './plane.css'

export function PlanePanel({ link }: { link: EngineLink | null }) {
  const strips = useMapStore((s) => s.map.strips)
  const masterBpm = useMapStore((s) => s.map.transport.masterBpm)
  const masterLevel = useMapStore((s) => s.map.transport.masterLevel)
  const dirty = useMapStore((s) => s.dirty)
  const [note, setNote] = useState<string | null>(null)
  const [matrix, setMatrix] = useState(false)
  /** Which deck the in-window composer is showing, or null for the plane. */
  const [composing, setComposing] = useState<number | null>(null)
  /** A deck for the BAR's compose button to open — the first grid strip on the
      plane. (A strip's own COMPOSE names its own deck; this is the affordance
      for "I just want the composer".) Inert rather than hidden when there is
      nothing to compose, which is layout law L2 applied to the bar. */
  const firstGrid = strips.find((s) => s.element.kind === 'grid')
  const firstLoadedDeck = firstGrid?.element.kind === 'grid' ? firstGrid.element.deck : null
  /** Every deck on the plane — what the MASTER transport acts on, as against a
      strip's transport, which acts on its own. Same verbs, wider scope. */
  const loadedDecks = strips.flatMap((s) => (s.element.kind === 'grid' ? [s.element.deck] : []))
  const companionPlay = useCompanion((c) => c.play)
  const companionStop = useCompanion((c) => c.stop)
  /** The synced strips, resolved through the tempo law, for the master's
      readout. Only the synced ones: a free-running deck has no relation to the
      master and listing it as "1:1 120" would claim one. */
  const syncedReadout = strips.flatMap((s) => {
    if (s.element.kind !== 'grid' || !s.element.syncToMaster) return []
    const intent = deckTempoIntent(s.element, masterBpm)
    return [{ pulse: intent.pulse, bpm: formatSyncedBpm(intent) }]
  })
  const mapDoc = useMapStore((s) => s.map)
  const selectedKey = useMapStore((s) => s.selectedKey)
  const mapName = useMapStore((s) => s.name)
  const { openMenu } = useContextMenu()
  const evtRef = useRef({ x: 0, y: 0 })
  const nameRef = useRef<HTMLInputElement>(null)
  const [draftName, setDraftName] = useState('')

  /**
   * Remove a strip, and everything that referenced it.
   *
   * The strip's CABLES go with it — a route naming a channel no strip occupies
   * is not drawable and not meaningful, and leaving them would quietly re-patch
   * the next strip that took the channel. The engine is told to drop them too,
   * or the audio would keep flowing through a strip nobody can see.
   */
  /**
   * Save. Asks for a name only the FIRST time — after that it is the same
   * gesture as any other save, and being prompted every time would make saving
   * something you avoid mid-set.
   */
  const doSave = async () => {
    // ⚠️ NOT `window.prompt`. A JS modal BLOCKS the whole WebView — in the JUCE
    // host it freezes the page and takes the audio UI with it. The name lives
    // in an inline field in the bar instead, which is not a dialog at all and
    // doubles as the "what is this map called" display.
    const name = (getMapName() ?? draftName).trim()
    if (!name) {
      setNote('name the map first — the field is beside the save button')
      nameRef.current?.focus()
      return
    }
    const r = await saveMapAs(link, name)
    setNote(r.ok ? `saved ${name}` : `could not save — ${r.error}`)
  }

  /** Export a package. Reports what it could NOT collect, because a package
      quietly short a file fails on the other machine at the worst moment. */
  const doExport = async () => {
    const name = (getMapName() ?? draftName).trim()
    if (!name) {
      setNote('name the map first — the field is beside the save button')
      nameRef.current?.focus()
      return
    }
    const r = await exportMap(link, name)
    setNote(
      !r.ok
        ? `could not export — ${r.error}`
        : r.missing.length > 0
          ? `exported ${name} — ⚠️ ${r.missing.length} take(s) missing from the package`
          : `exported ${name}`,
    )
  }

  /** Open, via the app's own menu — a native modal would block the WebView. */
  const doOpen = async (at: { x: number; y: number }) => {
    const maps = await listMaps(link)
    if (maps.length === 0) {
      setNote('no saved maps yet')
      return
    }
    openMenu(
      [
        { kind: 'info', label: 'open a map' },
        ...maps.map((m) => ({
          kind: 'item' as const,
          label: m.name,
          checked: m.name === mapName,
          onSelect: () => {
            void openMap(link, m.name).then((r) =>
              setNote(r.ok ? `opened ${m.name}` : `could not open — ${r.error}`),
            )
          },
        })),
      ],
      at.x,
      at.y,
    )
  }

  /**
   * CARVE the loop region into a grid track.
   *
   * ⚠️ STILL HALF-LANDED — BUT NOT FOR THE REASON THIS COMMENT USED TO GIVE.
   *
   * It said the blocker was `companionEngine` holding one session with no deck
   * axis. That was true and it is now FIXED (`decks[]`), so the claim was
   * checked rather than inherited — and the real remaining gap turned out to be
   * somewhere else entirely.
   *
   * A carved track has to point at AUDIO THE SESSION CAN READ. A session's
   * samples are OPFS paths (`SampleStore.decode` → `opfs.readFile`), and a take
   * is a `.wav` on the NATIVE filesystem. So landing a carve means copying take
   * bytes from disk into OPFS — and `slTakes` does list · delete · reveal only,
   * with no byte read, deliberately: take bytes do not cross the JSON bridge
   * (the 256 MB cap becomes ~350 MB of base64, which is why collect-on-export
   * had to be native in the first place).
   *
   * That is missing INFRASTRUCTURE, not a missing button — the third time this
   * phase that a line reading like UI work turned out to be plumbing. It wants
   * a native `slTakes/importToLibrary` (copy a take into the sample library,
   * shell moves the bytes, TS decides which), which is a decision, not a
   * keystroke.
   *
   * So this still performs the half it can and refuses the half it cannot,
   * loudly. Clearing the tape while silently dropping the track would destroy
   * the user's region — the one outcome STRIP-MODEL's "nothing is lost" forbids.
   */
  const doCarve = (strip: Strip) => {
    const r = carve(strip, 48000)
    if (!r.ok) {
      setNote(`cannot carve — ${r.reason}`)
      return
    }
    // The take survives regardless; the region is reported so it is not lost
    // from view while the byte path is unbuilt.
    setNote(
      `carve cannot land yet — a take lives on disk and a session reads OPFS, ` +
        `so the bytes need a native import first. Region kept: ${r.track.name}`,
    )
  }

  const removeStrip = (strip: Strip) => {
    useMapStore.setState((st) => ({
      map: {
        ...st.map,
        strips: st.map.strips.filter((s) => s.key !== strip.key),
        routes: st.map.routes.filter(
          (r) =>
            !(
              ((r.src.kind === 'channelOut' || r.src.kind === 'channelSend') &&
                r.src.index === strip.channel) ||
              (r.dst.kind === 'channelIn' && r.dst.index === strip.channel)
            ),
        ),
      },
      selectedKey: null,
      dirty: true,
    }))
    send(link, 'slChannel', { action: 'setSource', channel: strip.channel, kind: 0, index: 0 })
    void dropCablesFor(strip.channel)
  }

  /** Drop the engine's cables for a channel, read from the LIVE graph so a
      cable added outside the document's view goes too. */
  const dropCablesFor = async (channel: number) => {
    if (!link) return
    const listed = (await link
      .command('slRouteList', {})
      .catch(() => null)) as { routes?: Array<Record<string, number | boolean>> } | null
    for (const [id, r] of (listed?.routes ?? []).entries())
      if (
        r.active &&
        (((r.srcKind === 0 || r.srcKind === 1) && r.srcIndex === channel) ||
          (r.dstKind === 0 && r.dstIndex === channel))
      )
        send(link, 'slRoute', { action: 'remove', id })
  }
  const surfaceRef = useRef<HTMLDivElement>(null)

  // Make the engine agree with the document, once. `bootMap` rather than
  // `applyMap`: a map that has never been saved must boot into the engine's
  // DEFAULT wiring and capture it, or clearing the patchbay to install an empty
  // route list would leave a plane that looks fine and makes no sound.
  const booted = useRef(false)
  useEffect(() => {
    if (!link || booted.current) return
    booted.current = true
    void bootMap(link)
    // The source picker has nothing to offer until the inputs are named.
    void refreshDevices(link)
    // …and the session menu has nothing to offer until the library is read.
    // Without this the grid creation gesture is an empty list, which reads as
    // "there are no sessions" rather than "nobody asked yet".
    void useCompanion.getState().refresh()
    // P3-U1: start the engine sink HERE, not behind the companion panel's
    // button — that button lives in a DIFFERENT WebView with its own store and
    // can never start this window's sink. Without this, play/publish
    // early-return on `!audio.running` and every grid transport gesture on the
    // plane is enabled and silently inert. Native host only (gestureless by
    // design); the browser keeps its click (AudioContext autoplay rule).
    // A failure lands on the plane's own note line — the 502bc1d lesson: an
    // error only the companion panel renders is invisible here.
    void autoStartEngine(juceBackend() !== null, () => useCompanion.getState()).then(
      (failNote) => {
        if (failNote) setNote(failNote)
      },
    )
  }, [link])

  // Autosave, once the map has a name. Debounced rather than periodic: a
  // performance edits the map continuously, and a timer would write mid-gesture
  // over and over.
  useEffect(() => attachAutosave(link), [link])

  // ⌘R summons the ledger. A KEY rather than a docked panel: nobody should need
  // it in a six-strip set, and a permanently docked table would spend screen
  // edge every second to answer a question asked once a month.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault()
        setMatrix((m) => !m)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const addStrip = () => {
    const map = getMap()
    const channel = freeChannel(map)
    if (channel === null) {
      // Named, not silent. "Nothing happened when I clicked add" is the worst
      // possible answer, and the count is the whole explanation.
      setNote(`all ${map.strips.length} mixer channels are in use`)
      return
    }
    const el = surfaceRef.current
    const at = spawnPoint(
      { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 },
      map.plane,
      map.strips.length,
    )
    const strip = newStrip(channel, at)
    const budget = checkBudget(strip.key, strip.element)
    if (!budget.ok) {
      setNote(`no lanes left — ${budget.wanted} of ${budget.budget}`)
      return
    }
    setNote(null)
    // A strip arrives WITH ITS INPUT PATCHED. A strip records its own channel
    // bus, and a channel carries its element plus whatever is routed into it —
    // so without this route a fresh strip carries silence and pressing REC
    // records silence, perfectly and forever, with nothing saying why. That was
    // real, and `plane_audio_test` is what caught it.
    const route = inputRoute(channel)
    useMapStore.setState((st) => ({
      map: { ...st.map, strips: [...st.map.strips, strip], routes: [...st.map.routes, route] },
      dirty: true,
    }))
    // Bind the (empty) channel so the engine and the document agree from the
    // first frame, rather than only after the first edit.
    send(link, 'slChannel', { action: 'setSource', channel, kind: 0, index: 0 })
    send(link, 'slRoute', {
      action: 'add',
      srcKind: 2, // deviceInput
      srcIndex: route.src.index,
      srcSub: route.src.sub ?? 0xffffffff,
      dstKind: 0, // channelIn
      dstIndex: channel,
      gain: route.gain,
      feedback: false,
    })
  }

  /**
   * LOAD A SESSION INTO A STRIP — the grid creation gesture.
   *
   * Blocked until now for one reason, and it was never a missing button:
   * `companionEngine` held ONE session with no deck axis. With `decks[]` in
   * place this is what it always should have been — allocate a deck, write the
   * element, bind the channel, open the session onto that deck.
   *
   * ORDER MATTERS. The channel is bound BEFORE the session is opened, because
   * opening publishes a world for that deck and a deck whose channel is not yet
   * bound has nothing carrying it — the same order `Strip.onRecord` uses for a
   * tape, and for the same reason.
   */
  const loadSession = async (stripKey: string, sessionId: string) => {
    const map = getMap()
    const strip = map.strips.find((s) => s.key === stripKey)
    if (!strip) return

    // Reuse the deck this strip already holds — swapping the session on a grid
    // strip must not consume a second of only three decks.
    const existing = strip.element.kind === 'grid' ? strip.element.deck : null
    const deck = existing ?? freeDeck(map)
    if (deck === null) {
      setNote('all 3 grid decks are in use — drop one first')
      return
    }

    // Budget-check BEFORE anything is opened. A grid deck is 2 of the 8 mono
    // lanes, and saying so beats a click that appears to do nothing. The tempo
    // here is a placeholder — the real one is read below, and it cannot change
    // the lane cost.
    const budget = checkBudget(stripKey, newGridElement(deck, sessionId, 120))
    if (!budget.ok) {
      setNote(`no lanes left — ${budget.wanted} of ${budget.budget}`)
      return
    }
    setNote(null)
    send(link, 'slChannel', { action: 'setSource', channel: strip.channel, kind: 2, index: deck })
    // Cleared FIRST so the check below reads THIS open's outcome and not a
    // failure left over from an earlier one.
    useCompanion.setState({ error: null })
    await useCompanion.getState().open(sessionId, deck)

    // The element is written AFTER the open, carrying the session's OWN tempo.
    // `SessionSummary` has no bpm, so writing the element first would mean
    // guessing 120 and then either living with the lie or correcting it a frame
    // later — and the strip's tempo field is the mission requirement made
    // visible ("decks load into strips, each with its own BPM").
    const opened = useCompanion.getState().decks[deck]?.session
    if (!opened) {
      // ⚠️ "open() already reported why" WAS NOT TRUE HERE, and this is the
      // whole bug behind "clicking a session does nothing". `open()` reports by
      // setting `error` on the COMPANION store — which the composer panel
      // renders and the plane does not. So every failure to open a session was
      // completely silent on the plane: the menu closed, the strip did not
      // change, and nothing anywhere said why.
      //
      // A refusal the user cannot see is indistinguishable from a dead control,
      // which is the defect this phase keeps paying for. The plane has a note
      // line; a failure belongs in it.
      setNote(useCompanion.getState().error ?? `could not open “${sessionId}”`)
      return
    }
    const bpm = (opened.pattern.bpm as number | undefined) ?? 120
    // The strip takes the session's NAME as well as its element (P3-U2): a
    // default or previous-session name follows the load, a user's rename wins.
    updateStrip(stripKey, (s) => ({
      ...s,
      name: nameAfterSessionLoad(s, sessionId),
      element: newGridElement(deck, sessionId, bpm),
    }))
    // AND TELL THE ENGINE WHAT THE NEW ELEMENT'S TEMPO IS. A deck SLOT is
    // reused, so without this the fresh element inherits whatever sync, mode and
    // transpose the previous occupant left in the engine — the document saying
    // "free, no transpose" while the deck plays stretched and a fifth down.
    // (Before P3-2 this was masked: the ratio was reset by every publish, and
    // `open()` publishes. Deck scope removed that accident, which is what made
    // this path's missing push visible.)
    void applyTempo(link)
  }

  /** Give up a strip's element and the engine slot behind it. */
  const dropElement = (stripKey: string) => {
    const strip = getMap().strips.find((s) => s.key === stripKey)
    if (!strip || strip.element.kind !== 'grid') return
    // The STORE letting go is not the ENGINE letting go: closeDeck publishes a
    // stopped world first, or the deck keeps playing with nothing on screen to
    // stop it.
    useCompanion.getState().closeDeck(strip.element.deck)
    // THE DECK'S TEMPO AXIS GOES WITH THE DECK. `closeDeck` publishes a stopped
    // world, which silences the slot but leaves its deck-scope params standing —
    // they survive a publish by design (SL-ABI-V3 §3). `slDeck clear` is the
    // verb that actually drops them, and until now NOTHING IN THE APP SENT IT:
    // the action existed in the ABI and the dispatcher with zero callers, so the
    // next session loaded into this slot inherited the old sync and transpose.
    send(link, 'slDeck', { action: 'clear', deck: strip.element.deck })
    updateStrip(stripKey, (s) => ({ ...s, element: { kind: 'none' } }))
    send(link, 'slChannel', { action: 'setSource', channel: strip.channel, kind: 0, index: 0 })
    if (composing === strip.element.deck) setComposing(null)
  }

  return (
    <main className="panel plane-panel" ref={surfaceRef}>
      <div className="plane-bar">
        <PanelTitle>PLANE</PanelTitle>
        <input
          ref={nameRef}
          className="plane-name mono"
          type="text"
          value={mapName ?? draftName}
          placeholder="untitled"
          aria-label="map name"
          onChange={(e) => {
            // Renaming a SAVED map writes the next save under the new name and
            // leaves the old file alone — a rename that silently deleted the
            // previous document would be a destructive act wearing a text
            // field's clothes.
            if (mapName) useMapStore.setState({ name: e.target.value, dirty: true })
            else setDraftName(e.target.value)
          }}
          title="the map's name on disk"
        />
        <span className="plane-count mono dim">
          {strips.length} strip{strips.length === 1 ? '' : 's'}
          {dirty ? ' · unsaved' : ''}
        </span>
        <button
          type="button"
          className="plane-compose"
          onClick={() => void doSave()}
          title={mapName ? `save ${mapName}` : 'save this map'}
        >
          save
        </button>
        <button
          type="button"
          className="plane-compose"
          onClick={() => void doExport()}
          title="export a self-contained package — the map with its audio, for travel"
        >
          export
        </button>
        <button
          type="button"
          className="plane-compose"
          onClick={() => void doOpen(evtRef.current)}
          onPointerDown={(e) => (evtRef.current = { x: e.clientX, y: e.clientY })}
          title="open a saved map"
        >
          open
        </button>
        {/* THE SESSION LIBRARY'S DOOR — and without it the merged app is a dead
            end, which is how this button was found.

            A scoopy session can only be CREATED or IMPORTED in the companion
            panel, and that panel had no way to be opened here: `openPanelWindow`
            lost its last caller when compose moved in-window (see the note
            below). So `WizardMerged` could not make a session, therefore could
            not put a deck in a strip, therefore could not reach the grid
            transport or the tempo controls AT ALL — every one of them lives on a
            grid strip. The whole of P3-1 and P3-2 was unreachable from a clean
            install, and the strip's "load a session" menu section renders only
            when the library is non-empty, so it said nothing either.

            This is the first of the P3-4 doors ("every scoopy panel reachable"),
            pulled forward because the tempo domain cannot be verified without
            it. A SEPARATE WINDOW is right here, unlike compose: the library is
            not per-strip, it holds no deck, and it publishes no world — none of
            the reasons compose had to come in-window apply. */}
        <button
          type="button"
          className="plane-compose"
          onClick={() => send(link, 'openPanelWindow', { panel: 'companion' })}
          title="the session library — create, import and manage sessions"
        >
          sessions ⇱
        </button>
        {/* COMPOSE-BESIDE-THE-MAP. The plane is the PERFORMATIVE surface; a
            session is COMPOSED in the grid, which is a different job. Without
            this affordance, booting into the plane simply takes the composer
            away.

            ⚠️ IN THIS WINDOW, not a new one. It used to open a `panel: 'grid'`
            window, which cannot work: the shell drops the arg, nothing loads a
            session into that window's grid backend, and every panel window has
            its OWN companionEngine — so two windows holding one deck would each
            publish their own world for it. See Composer.tsx. */}
        <button
          type="button"
          className="plane-compose"
          title="compose the selected grid strip's session, beside the map"
          disabled={firstLoadedDeck === null}
          onClick={() => setComposing(firstLoadedDeck)}
        >
          compose
        </button>
        <span className="plane-spacer" />
        <Master
          link={link}
          level={masterLevel}
          masterBpm={masterBpm}
          synced={syncedReadout}
          onLevel={setMasterLevel}
          // ⚠️ TAKES THE LINK. `setMasterBpm` used to write the document and
          // stop, so the master tempo moved on screen and changed nothing.
          onBpm={(bpm) => setMasterBpm(bpm, link)}
          // The master transport drives EVERY loaded deck, through the same
          // companion path a strip's own transport uses (P3-1) — one vocabulary,
          // two scopes. Restart is stop-then-play for the same reason it is on a
          // strip: a publish is phase-continuous by design and cannot retrigger.
          onPlay={() => loadedDecks.forEach((d) => companionPlay(d))}
          onStop={() => loadedDecks.forEach((d) => companionStop(d))}
          onRestart={() =>
            loadedDecks.forEach((d) => {
              companionStop(d)
              companionPlay(d)
            })
          }
        />
      </div>

      {note && (
        <p className="plane-note warn mono" role="status">
          {note}
        </p>
      )}

      {/* The plane and its Inspector, side by side. The Inspector is ALWAYS
          visible — it is not a mode (pd-strip-anatomy §3), and its empty state
          is the plane summary rather than dead space. */}
      <div className="plane-body">
        <Plane
          link={link}
          onAddStrip={addStrip}
          onOpenMatrix={() => setMatrix(true)}
          onLoadSession={(key, id) => void loadSession(key, id)}
          onDropElement={dropElement}
          onCompose={setComposing}
        />
        <Inspector
          link={link}
          map={mapDoc}
          selectedKey={selectedKey}
          onRemove={removeStrip}
          onCarve={doCarve}
        />
      </div>
      {matrix && <Matrix link={link} map={getMap()} onClose={() => setMatrix(false)} />}
      {composing !== null && (
        <Composer link={link} deck={composing} onClose={() => setComposing(null)} />
      )}
    </main>
  )
}
