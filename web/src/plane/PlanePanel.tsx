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
import { useContextMenu, type MenuItem } from '../design/ContextMenu.tsx'
import { attachAutosave, exportMap, listMaps, openMap, saveMapAs } from '../state/mapFiles.ts'
import { carve } from './carve.ts'
import { parseSidecar, takeSeconds } from '../persist/takeLibrary.ts'
import { Inspector } from './Inspector.tsx'
import { Library } from './Library.tsx'
import { Master } from './Master.tsx'
import { Matrix } from './Matrix.tsx'
import { Plane } from './Plane.tsx'
import { refreshDevices, watchDeviceSwitches } from './devices.ts'
import { ask, onRefusal, send } from './send.ts'
import {
  RECORD_SOURCE,
  freeChannel,
  freeDeck,
  freeTape,
  BR_SCALE,
  inputRoute,
  linkedLooperFor,
  masterBrView,
  nameAfterSessionLoad,
  newGridElement,
  newStrip,
  newTapeElement,
  spawnPoint,
} from './stripOps.ts'
import { useCompanion } from '../store/companionEngine.ts'
import { silenceNote } from '../store/sampleReport.ts'
import { juceBackend } from '../../protocol/juceLink.ts'
import { autoStartEngine } from './bootEngine.ts'
import { deckTempoIntent, formatSyncedBpm, inferTapeBpm } from '../persist/tempo.ts'
import { applyTempo, updateStrip } from '../state/mapStore.ts'
import { Composer } from './Composer.tsx'
import { encodeComposeArg } from './composeArg.ts'
import { handlePanelClosed } from './composeOwnership.ts'
import './plane.css'

/**
 * The ≡ menu's surface rows (P3-4-2, pruned by P3-P1). Exported so the test
 * can pin what P3-P1 retired: djmode / deckmixer / transport opened windows
 * that hang on "waiting for state" in the merged host — pushed-topic surfaces
 * whose publishers were the carved-off Swift shell. Their jobs live on the
 * plane (master bar, the deck tile); the panels stay routed in App.tsx.
 */
export const PANEL_MENU_SURFACES = [
  ['spectral', 'spectral — texture, warp, gesture'],
  ['paintmode', 'paint mode'],
  ['midi', 'MIDI mapping'],
  ['perf', 'performance monitor'],
  ['capture', 'capture'],
] as const

/**
 * The ≡ menu's FX rows: `[label, arg]` per return (P6-2b).
 *
 * Exported so a test can pin the thing that broke — the LABEL and the ARG must
 * be the same number, because the arg is a 1-based `returnIndex` (what
 * FxSlotPanel and every `fxSlot`/`selectFxPlugin` param mean), not the row's
 * 0-based position. Passing the position made `FX 1` address return 0, which
 * the panel could only render as an eternal "waiting for state".
 */
export const FX_MENU_RETURNS: ReadonlyArray<readonly [string, string]> = [1, 2, 3, 4].map(
  (returnIndex) => [`FX ${returnIndex} ⇱`, String(returnIndex)] as const,
)

/**
 * The SETTINGS surfaces — REHOMED from `≡ panels` into `map ▾` (P11-1,
 * D-SL-TOPROW-01, which names `map ▾` as their new home by name).
 *
 * They belong with the document verbs rather than with the panel list: naming a
 * map, saving it, exporting it and configuring the app are all before-or-after
 * work, and none of them is something you reach for mid-set.
 *
 * Exported so `panelMenu.test.ts` can pin BOTH halves of the move — that they
 * left the panels menu AND that they arrived in the map menu. A rehome checked
 * only at the departure end is how a door goes missing.
 */
export const SETTINGS_SURFACES = [
  ['general', 'general'],
  ['audio', 'audio'],
  ['appearance', 'appearance'],
  ['template', 'templates'],
  ['import', 'import'],
] as const

/**
 * `map ▾`'s rows, as a pure builder (P11-1).
 *
 * A FUNCTION rather than inline JSX so the reachability gate can be a real
 * assertion instead of a source grep: the test hands it recording callbacks and
 * checks that every verb this bar used to carry as its own button is still
 * selectable from somewhere. That is the row's actual gate — "every retired
 * item still reachable somewhere" — and it cannot be honoured by eyeballing.
 *
 * Reuses the `≡ panels` ContextMenu shape deliberately (the row is explicit):
 * one menu vocabulary on this bar, not a second popover kind to learn.
 */
export function mapMenuItems(on: {
  save: () => void
  exportPackage: () => void
  open: () => void
  settings: (panel: string) => void
}): MenuItem[] {
  return [
    { kind: 'info', label: 'map' },
    { kind: 'item', label: 'save', onSelect: on.save },
    { kind: 'item', label: 'open…', onSelect: on.open },
    // The old button's title said what the package IS ("the map with its audio,
    // for travel"); a menu row has no title attribute, so the label carries it.
    { kind: 'item', label: 'export package…', onSelect: on.exportPackage },
    { kind: 'sep' },
    { kind: 'info', label: 'settings' },
    ...SETTINGS_SURFACES.map(([panel, label]) => ({
      kind: 'item' as const,
      label: `${label} ⇱`,
      onSelect: () => on.settings(panel),
    })),
  ]
}

/**
 * `≡ panels`' rows (P11-1). Same reason as above: the gate compares what the
 * two menus can reach against what the bar used to carry, and a builder is the
 * only shape that lets it.
 */
export function panelsMenuItems(on: {
  fx: (arg: string) => void
  surface: (panel: string) => void
}): MenuItem[] {
  return [
    { kind: 'info', label: 'FX returns' },
    ...FX_MENU_RETURNS.map(([label, arg]) => ({
      kind: 'item' as const,
      label,
      onSelect: () => on.fx(arg),
    })),
    { kind: 'sep' },
    { kind: 'info', label: 'surfaces' },
    ...PANEL_MENU_SURFACES.map(([panel, label]) => ({
      kind: 'item' as const,
      label: `${label} ⇱`,
      onSelect: () => on.surface(panel),
    })),
  ]
}

export function PlanePanel({ link }: { link: EngineLink | null }) {
  const strips = useMapStore((s) => s.map.strips)
  const masterBpm = useMapStore((s) => s.map.transport.masterBpm)
  const masterLevel = useMapStore((s) => s.map.transport.masterLevel)
  const dirty = useMapStore((s) => s.dirty)
  const [note, setNote] = useState<string | null>(null)
  const [matrix, setMatrix] = useState(false)
  /** Which deck the in-window composer is showing, or null for the plane. */
  const [composing, setComposing] = useState<number | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  // P3-C2: decks whose publishes a compose WINDOW currently owns. While a deck
  // is in here the plane's verbs for it lock (Strip's `composing` face, the
  // master fan-outs, session swap/drop) — one publisher at a time.
  const [composingDecks, setComposingDecks] = useState<ReadonlySet<number>>(new Set())

  // COMPOSE, HOST-SPLIT (P3-C1): the merged host spawns the REAL window,
  // addressed with {deck, session} through the sanitizer-proof arg; the
  // browser host (no window layer) keeps the in-window overlay.
  const composeDeck = (deck: number) => {
    const name = useCompanion.getState().decks[deck]?.session?.name
    if (juceBackend() !== null && name !== undefined) {
      if (composingDecks.has(deck)) {
        setNote(`deck ${deck + 1} is already composing — close that window to hand it back`)
        return
      }
      send(link, 'openPanelWindow', {
        panel: 'compose',
        arg: encodeComposeArg({ deck, session: name }),
      })
      setComposingDecks((prev) => new Set(prev).add(deck))
    } else {
      setComposing(deck)
    }
  }

  // The RETURN half (P3-C2): the shell broadcasts `slPanelClosed` when any
  // window goes; a compose window's close releases its deck and reloads the
  // session from disk — the only channel two WebViews share. KNOWN LIMIT: a
  // window that dies without the event (crash) leaves the lock standing until
  // the strip's session is dropped; there is no shell verb to enumerate
  // windows yet.
  useEffect(() => {
    const backend = juceBackend()
    if (!backend) return
    backend.addEventListener('slPanelClosed', (payload: unknown) =>
      handlePanelClosed(payload, {
        release: (deck) =>
          setComposingDecks((prev) => {
            const next = new Set(prev)
            next.delete(deck)
            return next
          }),
        // A beat's grace: the closing window flushes its autosave on pagehide,
        // and this reopen must read the flushed file, not race the write.
        reopen: (session, deck) =>
          void setTimeout(() => void useCompanion.getState().open(session, deck), 500),
        note: setNote,
      }),
    )
  }, [])
  /* P11-1 removed `firstGrid`/`firstLoadedDeck` with the bar's compose button.
     They existed only to answer "which deck does a bar-level COMPOSE mean?",
     and the honest answer was "the first one, arbitrarily". The strip's own
     `COMPOSE ⇱` names its deck, so the question no longer arises. `composeDeck`
     itself stays — the strips call it. */
  /** Every deck on the plane — what the MASTER transport acts on, as against a
      strip's transport, which acts on its own. Same verbs, wider scope. */
  const loadedDecks = strips.flatMap((s) => (s.element.kind === 'grid' ? [s.element.deck] : []))
  // P3-C2: the master's fan-out verbs skip decks a compose window owns — a
  // plane-side republish of an owned deck is exactly the stale-world race the
  // single-publisher rule exists to prevent.
  const activeDecks = loadedDecks.filter((d) => !composingDecks.has(d))
  const companionPlay = useCompanion((c) => c.play)
  const companionStop = useCompanion((c) => c.stop)
  const companionSessions = useCompanion((c) => c.sessions)
  const companionDecks = useCompanion((c) => c.decks)
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
              setNote(
                !r.ok
                  ? `could not open — ${r.error}`
                  : r.warnings.length > 0
                    ? // It OPENED, and something it wanted is not here (P6-5b).
                      // Named rather than counted: "1 warning" sends you looking.
                      `opened ${m.name} — ${r.warnings.join(' · ')}`
                    : `opened ${m.name}`,
              ),
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
  const doCarve = async (strip: Strip) => {
    const r = carve(strip, 48000)
    if (!r.ok) {
      setNote(`cannot carve — ${r.reason}`)
      return
    }
    // The bridge LANDS (P3-U7): the native store gave sessions a disk and the
    // /takes mount lets a track reference the recorder's WAV in place. Target:
    // the first grid strip with an OPEN session — a carve is "make this a
    // composition element", and the composition is whichever one is up.
    const gridStrip = getMap().strips.find(
      (s) =>
        s.element.kind === 'grid' &&
        useCompanion.getState().decks[s.element.deck]?.session != null,
    )
    if (!gridStrip || gridStrip.element.kind !== 'grid') {
      setNote('carve needs a grid strip with an open session — load one (⋯), then carve')
      return
    }
    const landed = await useCompanion
      .getState()
      .carveIntoSession(gridStrip.element.deck, r.track)
    if (!landed) {
      setNote(useCompanion.getState().error ?? 'carve failed')
      return
    }
    // CARVE FREES THE TAPE (STRIP-MODEL, decided): the layer clears for the
    // next capture, the audio survives twice over — the take in the library,
    // the region in the session. The channel unbinds so the freed strip is
    // silent, not playing a tape the document no longer shows.
    updateStrip(strip.key, () => r.strip)
    send(link, 'slChannel', { action: 'setSource', channel: strip.channel, kind: 0, index: 0 })
    setNote(`carved → ${r.track.name}, into “${gridStrip.name}” — the tape layer is free again`)
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

  // THE LIBRARY REFRESHES ON FOCUS. Every panel window is a separate WebView
  // with its OWN companion store, so a session created in the sessions window
  // is invisible here until somebody asks the disk again — and the boot
  // effect asked exactly once. Coming BACK to this window is precisely the
  // moment freshness matters (create over there, load over here), and it is
  // how the first real-host walk found the gap: "Untitled" on disk, the strip
  // menu insisting there were no sessions.
  useEffect(() => {
    const refresh = () => void useCompanion.getState().refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  // REFUSALS REACH THE NOTE LINE (P3-U6). Every slChannel/slRoute/slTape/…
  // failure used to be one console.error — invisible in the shipped app, so a
  // control that the engine refused was indistinguishable from a dead one
  // (the defect class this phase keeps paying for; 502bc1d built this surface
  // for session opens, this extends it to every command the plane sends).
  useEffect(() => onRefusal((method, msg) => setNote(`${method} refused — ${msg}`)), [])

  // …AND SO DOES A REFUSED DEVICE SWITCH (P9-5c). `slDevices/setInput` answers
  // a failure with `ok:false` + a reason, which RESOLVES — so it never went
  // through `onRefusal` above, and the reason sat in the device store read by
  // nothing. Same seam, same line, deliberately: the ⋯ menu that took the pick
  // has already closed by the time the host answers (`watchDeviceSwitches`).
  useEffect(() => watchDeviceSwitches(setNote), [])

  // THE TAKE LIBRARY, INDEXED (P3-U4). What lets a strip's status line say
  // "audio missing — <ref>" and name a resolved take with its length. `null`
  // until the first listing answers, so nothing flashes "missing" merely
  // because the disk has not been asked yet. Re-fetched whenever any strip's
  // takeRef changes — recording stops and take loads both move that.
  // BEAT REPEAT + REV — a FAN-OUT, never a second truth (P11-0).
  //
  // ⚠️ THE SCOPE LAW: BR · TR · WIN · REV · SYNC are DECK controls. The master
  // row FEEDS them and owns none of them. Original scoopyloops puts every one
  // of them in the DECK block's row 2 (`TransportPanel.tsx:25`), reading
  // `DeckSectionState`; the master row there carries the tempo REFERENCE.
  //
  // This used to be `useState` — `brOn`/`revOn` were the master's OWN booleans
  // with nothing syncing them from the decks, and the comment called them
  // "master-level runtime state". Two consequences, both real: engage BR on a
  // strip from its own header and the master lamp stayed DARK while that deck
  // repeated; and the master's toggle then computed `!brOn` from that stale
  // boolean, so one press could re-engage what was already on.
  //
  // Now DERIVED from the decks the master can actually drive. The only state
  // kept here is `brIdx` — the scale the master will SEND, which is a pending
  // intent rather than a claim about what any deck is doing.
  const [brIdx, setBrIdx] = useState(3) // '2' — the classic window
  const br = masterBrView(activeDecks, (d) => companionDecks[d]?.beatRepeat ?? null, brIdx)
  const brOn = br.active
  const brLabel = br.label
  const revOn = activeDecks.some((d) => companionDecks[d]?.reverse === true)
  const setBeatRepeat = useCompanion((c) => c.setBeatRepeat)
  const setReverse = useCompanion((c) => c.setReverse)
  const applyBr = (on: boolean, idx: number) => {
    const sc = BR_SCALE[idx] ?? BR_SCALE[3]!
    for (const d of activeDecks)
      setBeatRepeat(
        d,
        // startStep 0 = repeat the TOP of the window. "From where you are"
        // needs per-deck playhead steps the HotFrame only carries for deck 0;
        // honest uniform behaviour beats a verb that works differently per
        // strip. Revisit when per-deck steps land.
        on ? { startStep: 0, length: sc.length, subdivision: sc.subdivision } : null,
      )
  }

  const [takeIndex, setTakeIndex] = useState<Map<
    string,
    {
      name: string
      seconds: number | null
      frames: number | null
      sampleRate: number | null
      bpmAtStart: number | null
    }
  > | null>(null)
  const takeRefs = strips
    .map((s) => (s.element.kind === 'tape' ? (s.element.takeRef ?? '') : ''))
    .join('|')
  useEffect(() => {
    if (!link) return
    // UNKNOWN while the refs just changed and the disk has not answered — a
    // stale index would call a freshly recorded take "audio missing" for the
    // gap between record-stop and this listing.
    setTakeIndex(null)
    void (async () => {
      const r = await ask<{
        ok?: boolean
        takes?: Array<{ path: string; sidecar: string | null }>
      }>(link, 'slTakes', { action: 'list' })
      if (!r?.takes) return
      const idx = new Map<
        string,
        {
          name: string
          seconds: number | null
          frames: number | null
          sampleRate: number | null
          bpmAtStart: number | null
        }
      >()
      for (const t of r.takes) {
        // A corrupt or absent sidecar is still a TAKE — named, no length. The
        // wav with no sidecar is exactly the take a crash leaves behind, and
        // the one a user most wants back (takeLibrary's own rule).
        let seconds: number | null = null
        let frames: number | null = null
        let sampleRate: number | null = null
        let bpmAtStart: number | null = null
        if (t.sidecar != null) {
          try {
            const p = parseSidecar(JSON.parse(t.sidecar))
            if (p.ok) {
              seconds = takeSeconds(p.sidecar)
              frames = p.sidecar.frames
              sampleRate = p.sidecar.sampleRate
              bpmAtStart = p.sidecar.bpmAtStart ?? null
            }
          } catch {
            /* named take, unknown length */
          }
        }
        idx.set(t.path, {
          name: t.path.split('/').pop() ?? t.path,
          seconds,
          frames,
          sampleRate,
          bpmAtStart,
        })
      }
      setTakeIndex(idx)
    })()
  }, [link, takeRefs])

  // A TAPE LEARNS ITS BPM (P3-2b-2, provisional D-2). When a tape strip's bpm
  // is honestly unknown and its take carries the record-time tempo stamp, the
  // inference law fills it in — into the DOCUMENT, where the Inspector's field
  // can override it and a save remembers it. Only ever fills a null: a bpm the
  // user typed, or a previous inference, is never re-derived behind their back.
  useEffect(() => {
    if (!takeIndex) return
    for (const s of strips) {
      if (s.element.kind !== 'tape' || s.element.bpm !== null || !s.element.takeRef) continue
      const t = takeIndex.get(s.element.takeRef)
      if (!t?.bpmAtStart || !t.frames || !t.sampleRate) continue
      const loopFrames =
        s.element.loop.end > s.element.loop.start
          ? s.element.loop.end - s.element.loop.start
          : t.frames
      const bpm = inferTapeBpm(loopFrames, t.sampleRate, t.bpmAtStart)
      if (bpm !== null)
        updateStrip(s.key, (st) =>
          st.element.kind === 'tape' ? { ...st, element: { ...st.element, bpm } } : st,
        )
    }
  }, [takeIndex, strips])

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

  const addStrip = (preset: 'empty' | 'looper' = 'empty') => {
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
    let strip = newStrip(channel, at)
    // THE LOOPER PRESET (P3-X3, STRIP-MODEL "presets keep the quick-looper
    // fast"): channel + tape, one click. The tape element is bound up front so
    // the strip reads as a looper from its first frame and REC is one press
    // away — but recording is NOT auto-started: a preset that starts capturing
    // the room on click is a surprise, not a speed-up.
    if (preset === 'looper') {
      const freeT = freeTape(map)
      if (freeT === null) {
        setNote('all 8 tapes are in use — drop one first')
        return
      }
      strip = { ...strip, name: `LOOPER ${freeT + 1}`, element: newTapeElement(freeT, false) }
    }
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
    // Bind the channel so the engine and the document agree from the first
    // frame, rather than only after the first edit — to the preset's tape, or
    // to nothing for an empty strip.
    if (strip.element.kind === 'tape')
      send(link, 'slChannel', { action: 'setSource', channel, kind: 1, index: strip.element.index })
    else send(link, 'slChannel', { action: 'setSource', channel, kind: 0, index: 0 })
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
   * P3-R3 — REC on a GRID strip spawns (or targets) its LOOPER STRIP.
   *
   * The old behaviour was P3-X1's recorded defect: REC allocated a tape and
   * REPLACED the grid element in the document — capture worked, the session
   * silently fell out of the strip. With one-kind-per-strip signed
   * (D-SL-MORPH-01), "the looper records the deck's own output" is TWO ROUTED
   * STRIPS: this finds the linked looper (a tape strip whose bus this strip
   * feeds, tap = bus) or spawns one patched from this strip's bus, then starts
   * the capture THERE. The looper strip's own ■ closes the loop; this strip's
   * grid never moves.
   */
  const recordIntoLooper = async (stripKey: string) => {
    const map = getMap()
    const src = map.strips.find((s) => s.key === stripKey)
    if (!src || src.element.kind !== 'grid') return

    let looper = linkedLooperFor(map, src)
    if (!looper) {
      const channel = freeChannel(map)
      if (channel === null) {
        setNote(`all ${map.strips.length} mixer channels are in use — a looper strip needs one`)
        return
      }
      const freeT = freeTape(map)
      if (freeT === null) {
        setNote('all 8 tapes are in use — drop one first')
        return
      }
      const el = surfaceRef.current
      const at = spawnPoint(
        { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 },
        map.plane,
        map.strips.length,
      )
      let strip = newStrip(channel, at)
      strip = {
        ...strip,
        // Named after its JOB, not its slot: this looper exists to record that
        // strip, and the name is how the pair reads as a pair on the plane.
        name: `LOOP · ${src.name}`,
        element: newTapeElement(freeT, false),
        recordTap: 'bus',
      }
      const budget = checkBudget(strip.key, strip.element)
      if (!budget.ok) {
        setNote(`no lanes left — ${budget.wanted} of ${budget.budget}`)
        return
      }
      // Patched from THE DECK'S OWN OUTPUT, not the device input and not the
      // grid strip's channel bus.
      //
      // ⚠️ THIS USED TO READ `channelOut` OF THE SOURCE STRIP, and it recorded
      // SILENCE (P3.5-E3). A grid deck's channel is a projection: the core owns
      // that deck's gain stage and has already summed it into main, so this
      // tier mixes nothing for it and its bus is empty by construction. The
      // gesture worked, the take held nothing, and no surface said why. The
      // engine now names the deck directly (srcKind 4 = deckOut, index = the
      // DECK). Still no cycle possible — a deck is rendered before the
      // channels, so the edge is external.
      const route = {
        src: { kind: 'deckOut' as const, index: src.element.deck, sub: null },
        dst: { kind: 'channelIn' as const, index: channel },
        gain: 1,
        feedback: false,
      }
      useMapStore.setState((st) => ({
        map: { ...st.map, strips: [...st.map.strips, strip], routes: [...st.map.routes, route] },
        dirty: true,
      }))
      send(link, 'slChannel', {
        action: 'setSource',
        channel,
        kind: 1,
        index: strip.element.kind === 'tape' ? strip.element.index : 0,
      })
      send(link, 'slRoute', {
        action: 'add',
        srcKind: 4, // deckOut — the DECK's dry output (P3.5-E3)
        srcIndex: src.element.deck,
        srcSub: 0xffffffff,
        dstKind: 0,
        dstIndex: channel,
        gain: 1,
        feedback: false,
      })
      looper = strip
    }

    if (looper.element.kind !== 'tape') return
    const started = await ask(link, 'slRecord', {
      action: 'start',
      tape: looper.element.index,
      sourceKind: RECORD_SOURCE.channelBus,
      chan0: looper.channel,
      chan1: -1,
      sourceDesc: `${src.name} → ${looper.name}`,
      bpmAtStart: masterBpm,
    })
    setNote(
      started
        ? `recording ${src.name} into “${looper.name}” — press ■ there to close the loop`
        : `could not start recording into “${looper.name}”`,
    )
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
    // P3-C2: swapping the session under an open compose window would split the
    // document in two — the menu row is disabled, and this is the belt.
    if (existing !== null && composingDecks.has(existing)) {
      setNote(`deck ${existing + 1} is composing — close its window before swapping the session`)
      return
    }
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

    // P3.5-E9a — A SILENT DECK SAYS WHY. The store has always collected the
    // reasons (a kit sample that would not decode, a track naming a sample the
    // kit does not carry, an engine sink that never started), and until now the
    // only surface that READ them was the browser-only companion panel P3-L1
    // deleted. So a session could load, look right and play nothing, with the
    // cause on nobody's screen. The load succeeded — this is a note, not a
    // refusal, and it must not overwrite one.
    const loaded = useCompanion.getState()
    const d = loaded.decks[deck]
    const quiet = silenceNote(sessionId, {
      engine: loaded.engine,
      decodeFailures: d?.decodeFailures,
      missingSamples: d?.missingSamples,
    })
    if (quiet) setNote(quiet)
  }

  /** Give up a strip's element and the engine slot behind it. */
  const dropElement = (stripKey: string) => {
    const strip = getMap().strips.find((s) => s.key === stripKey)
    if (!strip || strip.element.kind !== 'grid') return
    // P3-C2: dropping the session under an open compose window leaves that
    // window editing a document nothing owns any more.
    if (composingDecks.has(strip.element.deck)) {
      setNote(`deck ${strip.element.deck + 1} is composing — close its window before dropping it`)
      return
    }
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
      {/* THE BAR, IN THREE ZONES (P11-1, D-SL-TOPROW-01):
          DOCUMENT (left) · MASTER (centre) · OUTPUT (right).

          It used to run four file/panel buttons BEFORE the master cluster,
          which was then shoved right of a spacer — backwards for a performance
          surface, in the user's words "old from wizard plane". The centre is
          now the only contiguous group a hand goes to during a set; the
          document work is to its left and what the plane is sending is to its
          right. The grid (not flex + spacer) is what holds the centre STILL:
          the transport keeps the same screen position however long the map's
          name is, which is what makes it findable without looking. */}
      <div className="plane-bar">
        {/* ZONE 1 — THE DOCUMENT. Which map this is, whether it is saved, and
            the two menus that act on it. */}
        <div className="plane-zone plane-zone-doc">
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
          {/* `map ▾` — save · open · export · settings, in ONE menu (P11-1).
              They were four separate bar buttons; three of them are things you
              do once at either end of a session, and giving each permanent
              width in front of the transport is what the decision calls
              backwards. Same ContextMenu the panels button uses — one menu
              vocabulary on this bar, not a second popover kind. */}
          <button
            type="button"
            className="plane-compose"
            onPointerDown={(e) => {
              evtRef.current = { x: e.clientX, y: e.clientY }
              openMenu(
                mapMenuItems({
                  save: () => void doSave(),
                  exportPackage: () => void doExport(),
                  // `open` opens a SECOND menu listing the saved maps, at the
                  // same point — it has to, because a native modal would block
                  // the whole WebView (the `doSave` rule, one level up).
                  open: () => void doOpen(evtRef.current),
                  settings: (panel) => send(link, 'openPanelWindow', { panel }),
                }),
                e.clientX,
                e.clientY,
              )
            }}
            title="the map — save, open, export a package, and settings"
          >
            map ▾
          </button>
          {/* THE SESSION LIBRARY, ON THE PLANE (P3-L1). This used to open the
              COMPANION PANEL in a second window — the only surface that could
              create/import a session, and the door that made the user ask
              whether we were building on the wrong app. The decree
              (D-SL-MORPH-01): the companion is the BROWSER's shell, a web
              bonus, never app-internal. The library's verbs (New · import ·
              rename · delete) now live in a popover right here, against the
              same sessionStore both hosts share; LOADING stays the strip
              menu's gesture. No second window, no second store, no focus
              round-trip for freshness.

              KEPT AS ITS OWN BUTTON rather than folded into `map ▾`: it acts on
              SESSIONS, and `map ▾` acts on the MAP. Two different documents —
              filing session verbs under a menu named for the map would be a
              tidier bar telling a lie. */}
          <button
            type="button"
            className="plane-compose"
            onClick={() => setLibraryOpen((v) => !v)}
            title="the session library — create, import, rename and delete sessions; load them from a strip’s ⋯ menu"
          >
            library ▾
          </button>
          {/* THE PANELS MENU (P3-4-2) — the door PANEL-AUDIT.md promised. Every
              compiled-in panel the audit marked mechanical opens from here;
              "nothing lost" stops depending on knowing a panel's name. fxslot
              leads: it is the return-FX config path P3-3-1 is blocked on.

              P3-P1 (D-SL-MORPH-01): djmode, deckmixer and transport are GONE
              from this menu — their windows hung on "waiting for state" forever
              (they wait on pushed UiState topics only the old Swift shell
              served; the M-1 measurement), and their jobs live on the plane now
              (master bar verbs via P3-M-1b, the deck tile via P3-D4). A door
              that opens a tombstone is worse than no door. The panels stay
              routed in App.tsx.

              ⚠️ THIS BUTTON WAS SUPPOSED TO LEAVE THE BAR AT P11-1 AND DID NOT.
              D-SL-TOPROW-01 retires it, and the settings block DID move out (to
              `map ▾`, above) — but the rest of it has nowhere to go yet, and a
              retirement that orphans a door is rule four, not tidiness. TWO
              things must land before it can go, and neither is this row's:

                · P7-MIX-0 rehomes FX 1–4 into the strip mixer. Until then this
                  menu is their only door (conductor ruling: do not invent an
                  interim home — that means building the same door twice and
                  risking the gap in between, which is what P3.5-E8 was).
                · P11-1-a decides where the five PANEL_MENU_SURFACES live.
                  Measured: `openPanelWindow` has four call sites and ALL FOUR
                  are in this file, so this menu is the only door to spectral,
                  paintmode, midi, perf and capture — and D-SL-TOPROW-01 names a
                  new home for settings only.

              Do not delete this button until both are done. */}
          <button
            type="button"
            className="plane-compose"
            onPointerDown={(e) => {
              openMenu(
                panelsMenuItems({
                  // ⚠️ THE ARG IS THE RETURN INDEX, 1-BASED (P6-2b). This used to
                  // pass the 0-based menu slot, and FxSlotPanel reads the arg as a
                  // returnIndex — so `FX 1` sent "0", the panel indexed
                  // `fxSlots[-1]`, found undefined and sat on "waiting for state"
                  // FOREVER, while `FX 2`…`FX 4` quietly addressed returns 1…3 and
                  // return 4 was unreachable. Every fxSlot/selectFxPlugin param is
                  // 1-based too, so 0 also failed schema validation on the wire.
                  // The label and the arg are now the same number — which is the
                  // only arrangement that cannot drift again.
                  fx: (arg) => send(link, 'openPanelWindow', { panel: 'fxslot', arg }),
                  surface: (panel) => send(link, 'openPanelWindow', { panel }),
                }),
                e.clientX,
                e.clientY,
              )
            }}
            title="every panel — FX returns, spectral, paint mode, MIDI, perf and capture"
          >
            ≡ panels
          </button>
          {/* COMPOSE IS RETIRED FROM THE BAR (P11-1, D-SL-TOPROW-01) — it is a
              PER-STRIP verb, and the strip's own door is strictly better.

              The bar's button could only ever open the FIRST grid strip,
              because a bar has no way to say WHICH strip you meant. Every grid
              strip already draws its own `COMPOSE ⇱`
              (`GridElement.tsx:265`, wired through `Plane.tsx:660` to the same
              `composeDeck` this button called). So the retired door was a less
              capable duplicate of one that stays, and `composeDeck` itself is
              untouched — this removes a button, not a capability. */}
        </div>
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
          // Composing decks are OWNED elsewhere: the master counts only the
          // decks it can actually drive, so its buttons disable honestly when
          // every loaded deck is in a compose window.
          deckCount={activeDecks.length}
          brActive={brOn}
          brLabel={brLabel}
          revActive={revOn}
          // The toggles decide from the DERIVED value: any deck on → turn them
          // all off, otherwise turn them all on. So the master always completes
          // the gesture the lamp is showing, whoever started it.
          onToggleBeatRepeat={() => applyBr(br.nextOn, brIdx)}
          onCycleBeatRepeat={() => {
            const next = (brIdx + 1) % BR_SCALE.length
            setBrIdx(next)
            if (brOn) applyBr(true, next) // live while latched
          }}
          onToggleReverse={() => {
            const next = !revOn
            for (const d of activeDecks) setReverse(d, next)
          }}
          onPlay={() => activeDecks.forEach((d) => companionPlay(d))}
          onStop={() => activeDecks.forEach((d) => companionStop(d))}
          onRestart={() =>
            activeDecks.forEach((d) => {
              companionStop(d)
              companionPlay(d)
            })
          }
        />
      </div>

      {/* The library popover (P3-L1) — a shelf, not a window. The backdrop is
          the close gesture; every action's outcome lands on the note line. */}
      {libraryOpen && (
        <>
          <div className="plane-library-backdrop" onPointerDown={() => setLibraryOpen(false)} />
          <Library
            sessions={companionSessions}
            decks={companionDecks}
            refresh={() => useCompanion.getState().refresh()}
            onNote={setNote}
          />
        </>
      )}

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
          onCompose={composeDeck}
          composingDecks={composingDecks}
          onRecordIntoLooper={(key) => void recordIntoLooper(key)}
          takeIndex={takeIndex}
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
