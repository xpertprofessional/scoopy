/**
 * SCOOPY DECK — the plugin's face (D-SL-DECKPLUGIN-01).
 *
 * A DAW plugin is not a window someone navigated to; it is an instrument
 * somebody just dropped on a track, and it has to be playable immediately.
 * That is the one thing the compose WINDOW cannot be, and why this is a
 * separate route rather than a flag on it:
 *
 *   ComposeWindow opens a session only when ADDRESSED (`__slPanelArg`), which
 *   is right for its two callers — a strip's COMPOSE ⇱, and the app's mapless
 *   boot, where "empty studio, use session ▾" is a deliberate state a person
 *   arrived at on purpose. A freshly inserted plugin has no address and nobody
 *   chose that emptiness, so the grid sat on "waiting for pattern state…"
 *   (no session → no `gridMeta` → no meta → the placeholder) and read as a
 *   broken plugin. Verified in Logic, 2026-08-01.
 *
 * So this panel ENSURES a session before it renders anything.
 *
 * WHAT IT RENDERS IS `DeckFace` — the SAME component the desktop expands a
 * strip into. Not a reduced imitation assembled here: the first cut hand-wired
 * the deck rows and PERF did nothing, because PERF has to reach the grid
 * BACKEND (`setMetaFacts({performActive})`) rather than a React prop. Mounting
 * the real component makes every such wire right by construction.
 *
 * It also settles the density question by evidence rather than taste. Compose
 * density reads its playhead from `HotFrameLayout.trackStep0` and NOTHING IN
 * THE MERGED ENGINE WRITES THOSE LANES — the emitter fills
 * `playheadStepDeck0..2` plus the per-deck DJ telemetry and stops. So a
 * compose-density grid can only ever show a frozen playhead here, while the
 * deck source reads `djTrackStepD0T*`, written every block. The deck face is
 * the one that moves.
 */
import { useEffect, useState } from 'react'

// ⚠️ IMPORTED EXPLICITLY, though it arrives globally anyway (panels share one
// bundle). This face is built out of plane pieces — `.compose-window`,
// `.compose-window-body`, `.strip-deckface`, `.strip-scenes` — and its only
// other importer is PlanePanel. That is exactly the dependency deckTile.tsx
// records getting caught by with djmode.css: delete the panel that happens to
// import the stylesheet and this one loses its layout with no error anywhere.
import './plane.css'
import { SCENE_LETTERS, enabledScenes } from '../audio/sceneProjection.ts'
import { deckTempoIntent } from '../persist/tempo.ts'
import type { EngineLink } from '../engineLink.ts'
import { GridScenes } from './GridElement.tsx'
import { HotFrameLayout } from '../../protocol/schema.ts'
import { lcmForScene } from '../audio/patternClock.ts'
import {
  DEFAULT_QUANTUM,
  LAUNCH_QUANTA,
  nextQuantum,
  quantumSteps,
  type LaunchQuantum,
} from '../audio/launchQuantum.ts'
import { flushAutosave, useCompanion } from '../store/companionEngine.ts'
import { listSessions } from '../store/sessionStore.ts'
import { silenceNote } from '../store/sampleReport.ts'
import { useMapStore } from '../state/mapStore.ts'
import { autoStartEngine } from './bootEngine.ts'
import { ComposeFiles } from './ComposeFiles.tsx'
import { ComposeSessions } from './ComposeSessions.tsx'
import { DeckFace, claimKeyboard } from './deckTile.tsx'
import { DragBox } from '../design/DragBox.tsx'
import {
  PLUGIN_DECK,
  PLUGIN_STRIP_KEY,
  installPluginDeckMap,
  setPluginMasterBpm,
  setPluginSession,
  setPluginTempoInternal,
  setPluginTypedMasterBpm,
} from './pluginDeckMap.ts'

/** The plugin always fronts deck 0 — it is a ONE deck product by decision. */
// One deck, and the SAME index the map shim uses — two constants that could
// disagree about which deck this is would be a bug nobody could see.
const DECK = PLUGIN_DECK

/** The element's mode vocabulary → the engine's `tempoMode` ints (sl_engine.h
    §3). The same mapping `persist/tempo.ts` makes; restated because the recipe
    crosses to C++ where only the int exists. */
const TEMPO_MODE_ID: Record<string, number> = {
  timePitch: 0,
  timeStretch: 1,
  tempoOnly: 2,
}

/** The pulse relation as a MULTIPLIER, which is all the native fallback needs:
    it multiplies the host tempo by this before dividing by the session's. The
    resolved pulse comes from the law, so `auto` is already decided here. */
function pulseMultiplierOf(
  element: { bpm: number; syncToMaster: boolean; tempoMode: string; pulseRelation: string },
  masterBpm: number,
): number {
  const intent = deckTempoIntent(element as never, masterBpm, 0)
  // syncedBpm ÷ host = the relation, independent of the session's own tempo.
  if (!intent.syncedBpm || masterBpm <= 0) return 1
  return intent.syncedBpm / masterBpm
}

/** The one-strip map the deck rows write through. Its master tempo is the
    HOST's — see pluginDeckMap.ts. Hoisted so BOTH the boot path and a session
    opened later from the menu install it the same way. */
function installMapFor(open: { name: string; pattern: unknown }): void {
  installPluginDeckMap({
    sessionId: open.name,
    bpm: (open.pattern as { bpm?: number }).bpm ?? 120,
    syncToMaster: true,
    tempoMode: 'timeStretch' as never,
    hostBpm: 0,
  })
}

export function PluginDeckPanel({ link }: { link: EngineLink | null }) {
  const [boot, setBoot] = useState<'starting' | 'ready' | 'empty' | string>('starting')
  const [note, setNote] = useState<string | null>(null)
  const [hostPlaying, setHostPlaying] = useState(false)
  const [sessions, setSessions] = useState<{ name: string }[]>([])
  /** CLK — does the DAW's transport start and stop this deck?
   *
   *  ON (default): host play launches the deck on the host's bar grid, host
   *  stop stops it. OFF is the INTERNAL CLOCK: the deck answers only its own
   *  transport glyphs and ignores the DAW's play head entirely.
   *
   *  Deliberately separate from SYNC/FREE, which is the TEMPO axis. The four
   *  combinations are all musically real — a deck can follow the host's tempo
   *  while being started by hand (SYNC + INT), or run at its own tempo but
   *  start with the DAW (FREE + HOST). Collapsing them into one switch would
   *  remove two of those. */
  const [followTransport, setFollowTransport] = useState(true)
  /** TEMPO — where the MASTER TEMPO comes from (D-SL-DECKPLUGIN-02 · D2).
   *
   *  A SECOND switch, not a mode of CLK. CLK is the TRANSPORT axis (who presses
   *  play); this is the TEMPO axis (what the deck stretches against). Signed as
   *  two controls because all four combinations are real, and the one that was
   *  unreachable is the useful one: follow the DAW's play/stop while running
   *  against a tempo of your own.
   *
   *  OFF (default): the DAW's playhead. ON: the number in the box beside it. */
  const [tempoInternal, setTempoInternal] = useState(false)
  /** COMPOSE / DECK — how the track rows are DRAWN (§ real-host report,
   *  2026-08-01).
   *
   *  Not a different mount and not a different data source: the deck source
   *  stays, so the playhead keeps reading `djTrackStepD0T*` (written every
   *  block) instead of compose's `trackStep0`, which NOTHING in the merged
   *  engine writes. A real compose mount here would show a frozen playhead.
   *
   *  It exists because the dj row deliberately has no H row — no sample browse
   *  and no LOAD, "sound design, not performance". On the plane that is fine; a
   *  compose window is one double-click away. ScoopyDeck has no such window, so
   *  the omission meant there was no way to put a sample on a track at all.
   *
   *  DECK is the default: a plugin dropped on a track should come up playable,
   *  not in an editing surface. */
  const [composeView, setComposeView] = useState(false)
  /** THE LAUNCH QUANTUM (D-SL-DECKPLUGIN-03 · step 3) — which boundary on the
   *  DAW's bar grid ⟳ waits for.
   *
   *  The scale is the donor's, ported in `audio/launchQuantum.ts`, and its
   *  numbers are STEPS (16ths), so "16" is a bar of 4/4. Default `cycle`,
   *  matching `DJModeManager.globalLaunchQuantize` — in the original app ⟳
   *  already waits, so this carries the muscle memory across.
   *
   *  Held NATIVE (the state chunk) rather than here, per instance: two decks in
   *  one set may run different quantums, which a shared preference could not
   *  express. This is the mirror; the processor is the record. */
  const [quantum, setQuantum] = useState<LaunchQuantum>(DEFAULT_QUANTUM)

  // The strip the deck rows read and write. Subscribed through the store so a
  // control's own write re-renders the row that made it.
  const strip = useMapStore((s) => s.map.strips.find((x) => x.key === PLUGIN_STRIP_KEY) ?? null)
  const masterBpm = useMapStore((s) => s.map.transport.masterBpm)
  const gridElement = strip?.element.kind === 'grid' ? strip.element : null

  const session = useCompanion((c) => c.decks[DECK]?.session ?? null)
  // Scene state for the pads. `scheduledScene` is the one armed for the next
  // cycle boundary — the pad shows it as QUEUED so a click has visible effect
  // before the switch actually lands, which is most of what makes scheduled
  // switching usable.
  // The strip follows whatever session is actually open, however it got there
  // — the deck row's OPEN, the `session ▾` menu, or a project restore. One
  // effect rather than a rewrite at each call site, so a new door cannot
  // forget it and leave the sync denominator stale.
  useEffect(() => {
    if (!session || !gridElement) return
    const bpm = (session.pattern as { bpm?: number }).bpm ?? gridElement.bpm
    if (session.name === gridElement.sessionId && bpm === gridElement.bpm) return
    setPluginSession(session.name, bpm)
  }, [session?.name, session?.pattern, gridElement?.sessionId, gridElement?.bpm])

  const scene = useCompanion((c) => c.decks[DECK]?.scene ?? 'A')
  const queued = useCompanion((c) => c.decks[DECK]?.scheduledScene ?? null)
  const enabledSceneRow = session ? enabledScenes(session.pattern) : SCENE_LETTERS.slice(0, 8)

  const error = useCompanion((c) => c.error)
  const notice = useCompanion((c) => c.notice)
  const engine = useCompanion((c) => c.engine)
  const decodeFailures = useCompanion((c) => c.decks[DECK]?.decodeFailures)
  const missingSamples = useCompanion((c) => c.decks[DECK]?.missingSamples)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // Sink FIRST, document second — the B5 ordering. `open`/`newSession`
        // publish only while the engine runs, and every WebView boots its own
        // store cold, so a document opened before the sink is a document
        // nothing hears.
        await autoStartEngine(true, () => useCompanion.getState())
        if (cancelled) return

        // WHICH SESSION IS THIS INSTANCE'S? The chunk knows — ask it.
        //
        // ⚠️ THIS USED TO CALL `newSession()`, and that was two bugs at once.
        // `createSession` ends in `saveSession`, so EVERY insert wrote a fresh
        // `Untitled N` folder into the shared library (reported from the real
        // host, 2026-08-01: "open session shows loads of untitled"). And on a
        // reloaded DAW project the chunk had already replayed the right audio
        // into the engine, so the manufactured Untitled sat as an empty grid on
        // top of a correctly-playing deck.
        //
        // Per-INSTANCE, deliberately. A shared "most recent session" pointer
        // would race: with several decks open, whichever autosaved last would
        // win and every new insert would inherit whatever another deck touched.
        let want: string | null = null
        try {
          const r = await link?.command('pluginSession' as never, {})
          want = (r as { name?: string | null } | null)?.name ?? null
        } catch {
          // The app host refuses the method; there is simply nothing to restore.
        }
        if (cancelled) return
        if (want && !useCompanion.getState().decks[DECK]?.session) {
          // A session named in the chunk but since deleted from the library must
          // not take the boot down with it — fall through to the empty state,
          // which can say so and offer the library.
          await useCompanion.getState().open(want).catch(() => {})
          if (cancelled) return
        }
        const open = useCompanion.getState().decks[DECK]?.session
        if (open) installMapFor(open)
        // NOTHING IS CREATED. An insert with no chunk comes up empty with the
        // session menu open — see the `boot === 'empty'` body below, which
        // exists so that emptiness is a door rather than the broken-looking
        // grid PluginDeckPanel was originally written to avoid.
        setBoot(open ? 'ready' : 'empty')
      } catch (err) {
        // Say it on screen. A plugin that fails to boot its document and shows
        // a placeholder is indistinguishable from a plugin that is simply
        // broken, which is the whole defect this panel exists to end.
        if (!cancelled) setBoot(`could not start: ${(err as Error).message}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [link])

  // The quantum this INSTANCE was restored with. Read once, like the sync
  // recipe — the chunk is the record and the editor is only showing it.
  useEffect(() => {
    if (!link) return
    let cancelled = false
    void link
      .command('deckLaunch' as never, {})
      .then((r: unknown) => {
        if (cancelled) return
        const q = (r as { quantum?: string } | null)?.quantum
        if (q && (LAUNCH_QUANTA as readonly string[]).includes(q))
          setQuantum(q as LaunchQuantum)
      })
      .catch(() => {}) // the app host refuses it — nothing to restore
    return () => {
      cancelled = true
    }
  }, [link])

  // A session opened LATER — from the menu, on an instance that booted empty.
  // The map and the ready state have to follow it, or picking a session would
  // leave the deck rows unmounted with a document loaded behind them.
  useEffect(() => {
    if (!session) return
    installMapFor(session)
    setBoot((b) => (b === 'ready' ? b : 'ready'))
  }, [session?.name])

  // …and native must be told, so THIS instance reopens it next time. Written on
  // every change rather than on save: the chunk is the instance's memory of
  // which document it holds, not a record of what was persisted.
  useEffect(() => {
    if (!link || !session) return
    void link.command('pluginSession' as never, { name: session.name }).catch(() => {})
  }, [link, session?.name])

  /**
   * ARE ENGINE FRAMES ARRIVING? (real-host debug, 2026-08-01)
   *
   * "The playhead is dead" is three faults wearing one symptom — the clock is
   * stopped, the frames are not reaching the page, or the page is not drawing
   * them — and inside a DAW there is no console to tell them apart. The chrome
   * strip answers the first natively; this answers the second, which is the one
   * only the page can see.
   *
   * It is a WARNING, not a readout: silent when telemetry is flowing, and it
   * says so when it stops. A UI quietly showing stale numbers because its feed
   * died is the failure this exists to name.
   */
  const [framesStalled, setFramesStalled] = useState(false)
  useEffect(() => {
    if (!link) return
    let seen = 0
    let last = -1
    const off = link.onHotFrame((frame) => {
      seen = frame[HotFrameLayout.frameCounter] ?? 0
    })
    // 1.5 s: the editor broadcasts at 30 Hz, so a gap this long is a real stop,
    // not a scheduling hiccup or a hidden window skipping a few.
    const id = window.setInterval(() => {
      setFramesStalled(seen === last)
      last = seen
    }, 1500)
    return () => {
      off()
      window.clearInterval(id)
    }
  }, [link])

  /**
   * ⟳ ON THE HOST'S GRID (D-SL-DECKPLUGIN-03).
   *
   * ORDER IS THE CONTRACT, and it is `plane/launch.ts`'s, followed rather than
   * re-derived: publish the deck as PLAYING first, then arm. The core holds a
   * deck whose world says active + launchArmed — so the world has to say
   * playing before the request, or there is nothing for the hold to hold.
   *
   * Both fallbacks land the same way, which is why neither needs an error path:
   * a quantum of `off` (or a session with no resolvable cycle) never arms, and
   * an arm that answers frame 0 — no playhead, stopped host — means "no grid to
   * wait on". In every case the deck is ALREADY playing from the line above,
   * which is exactly the right outcome.
   */
  const launchOnHostGrid = () => {
    const c = useCompanion.getState()
    c.play(DECK)
    if (!link) return
    // ⚠️ AND CHECK THAT IT TOOK. `play` returns early with no session or no
    // running engine, silently. Arming after a no-op play would hand the core a
    // deck its world does not say is playing: nothing to hold, nothing to
    // release, and a ⟳ that waits forever with no error anywhere. The same trap
    // `launch.ts` documents.
    if (!useCompanion.getState().decks[DECK]?.playing) return
    const cycle = session ? lcmForScene(session.pattern, scene) : 0
    const steps = quantumSteps(quantum, cycle)
    if (steps <= 0) return // `off`, or no cycle to resolve — already playing
    // Steps are 16ths; the native arm speaks BEATS. One conversion, here.
    void link.command('deckLaunch' as never, { quantumBeats: steps / 4 }).catch(() => {})
  }

  // THE ARROW KEYS, without having to click first.
  //
  // `keyboardActive` is an ARBITRATION: the plane can mount three deck tiles
  // and they would all answer every keystroke, so the claim goes to whichever
  // tile you last pointed at and starts unheld. A plugin has exactly ONE deck,
  // so there is nothing to arbitrate and an unclaimed start just means the
  // arrow keys silently do nothing until you happen to click the grid.
  useEffect(() => {
    claimKeyboard(PLUGIN_DECK)
  }, [])

  // THE RECIPE, pushed to native — the closed-editor fallback.
  //
  // With the editor open the web owns the sync ratio (djSyncLaw). But a DAW
  // can play a project whose plugin window was never opened, and then there is
  // no web tier at all: the processor's own pump has to keep the deck locked
  // to the host. It cannot run djSyncLaw, so it gets the RESOLVED recipe here
  // and does the one multiplication that must survive. Sent on change only —
  // the values move at human rate.
  // READ FIRST. The recipe rides the plugin state chunk, so a project saved
  // with the internal clock has already restored `followTransport: false` by
  // the time this editor mounts — pushing our own default before reading would
  // silently undo the user's setting on every window open. An empty payload is
  // a pure read (the processor replies with the effective recipe).
  const [seeded, setSeeded] = useState(false)
  useEffect(() => {
    if (!link) return
    let cancelled = false
    void link
      .command('hostSyncConfig' as never, {})
      .then((r: unknown) => {
        if (cancelled) return
        const rec = r as { followTransport?: boolean; masterBpm?: number } | null
        if (typeof rec?.followTransport === 'boolean') setFollowTransport(rec.followTransport)
        // A POSITIVE restored master means the saved project was on an internal
        // tempo. Re-arm the flag BEFORE adopting the value, or the very next
        // `hostTransport` tick would overwrite it — the same ordering hazard
        // `followTransport` documents above, one axis over.
        if (typeof rec?.masterBpm === 'number' && rec.masterBpm > 0) {
          setTempoInternal(true)
          setPluginTempoInternal(true)
          setPluginTypedMasterBpm(rec.masterBpm, link)
        }
      })
      .catch(() => {}) // the app host refuses it — nothing to seed from
      .finally(() => {
        if (!cancelled) setSeeded(true)
      })
    return () => {
      cancelled = true
    }
  }, [link])

  useEffect(() => {
    if (!link || !gridElement || !seeded) return
    void link
      .command('hostSyncConfig' as never, {
        sessionBpm: gridElement.bpm,
        tempoMode: TEMPO_MODE_ID[gridElement.tempoMode] ?? 1,
        pulseMultiplier: pulseMultiplierOf(gridElement, masterBpm),
        syncEnabled: gridElement.syncToMaster,
        followTransport,
        // 0 = "follow the host", which is what the pump did before this existed.
        // Sending the typed value (rather than only a flag) is what lets a
        // CLOSED editor keep stretching against it — the web tier is not
        // running then, so a flag alone would have nothing to resolve.
        masterBpm: tempoInternal ? masterBpm : 0,
      })
      // The app host refuses this method; that is correct and not worth a
      // console line on every tempo change.
      .catch(() => {})
  }, [
    link,
    gridElement?.bpm,
    gridElement?.tempoMode,
    gridElement?.syncToMaster,
    gridElement?.pulseRelation,
    masterBpm,
    followTransport,
    tempoInternal,
    seeded,
  ])

  // The library, for the deck row's OPEN. Refreshed on mount and whenever the
  // session menu reports it did something.
  const refreshSessions = () => void listSessions().then(setSessions).catch(() => {})
  useEffect(refreshSessions, [])

  // THE HOST IS THE MASTER TEMPO. The processor emits `hostTransport` from its
  // 40 Hz pump (it is the only way the UI can learn what the DAW's transport
  // did — there is no transport slot in the HotFrame, so the web tier's mirror
  // would otherwise show the last transport IT commanded and quietly lie).
  useEffect(() => {
    if (!link) return
    return link.onEvent((evt) => {
      const e = evt as { type?: string; bpm?: number; playing?: boolean }
      if (e?.type !== 'hostTransport') return
      if (typeof e.bpm === 'number') setPluginMasterBpm(e.bpm)
      if (typeof e.playing === 'boolean') setHostPlaying(e.playing)
    })
  }, [link])

  // DAW MIDI → THE SCENE PADS.
  //
  // The engine has no MIDI surface and no live-trigger door, so notes cannot
  // reach it directly; what they CAN reach is the same store the pads call,
  // which makes scene launching the honest first consumer — it is also what a
  // deck in a DAW is most often asked to do from a controller.
  //
  // C3..G3 (MIDI 60-67) → scenes 1-8, the octave a pad controller sends by
  // default. Velocity 0 is a note-off in disguise (running status) and must
  // not launch. Held back from the deck's own transport keys deliberately:
  // one mapping, stated, beats a guessable half-set.
  useEffect(() => {
    if (!link) return
    return link.onEvent((evt) => {
      const e = evt as { type?: string; events?: unknown[] }
      if (e?.type !== 'hostMidi' || !Array.isArray(e.events)) return
      for (const raw of e.events) {
        const m = raw as { status?: number; data1?: number; data2?: number }
        if (m.status !== 0x90 || !m.data2) continue // note-on with velocity only
        const target = enabledSceneRow[(m.data1 ?? 0) - 60]
        if (!target) continue // outside the mapped octave, or a scene not enabled
        useCompanion.getState().selectScene(target, { immediate: false, deck: PLUGIN_DECK })
      }
    })
  }, [link, enabledSceneRow])

  // ⌘S flushes the autosave debounce, same meaning as everywhere else
  // (D-SL-SAVE-01). Inside a DAW the host may well take ⌘S first; this is the
  // fallback for when focus is in the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 's' || !(e.metaKey || e.ctrlKey) || e.shiftKey) return
      e.preventDefault()
      void flushAutosave().then(() => setNote('saved'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The last edit must land. A DAW can close a plugin editor without any of
  // the usual page lifecycle firing, so the flush is wired to both.
  useEffect(() => {
    const flush = () => void flushAutosave()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [])

  // ⚠️ NOT useComposeBinding, and the reason is measurable rather than
  // stylistic: compose density reads its playhead from `HotFrameLayout
  // .trackStep0`, and NOTHING IN THE MERGED ENGINE WRITES THOSE LANES. The
  // emitter fills `playheadStepDeck0..2` and the per-deck DJ telemetry and
  // stops there, so a compose-density grid shows a playhead frozen at -1
  // forever — the same shape as the `lcmPosDeck*` gap deckTile.tsx documents.
  // The deck (dj) source reads `djTrackStepD0T*`, which IS written every
  // block, so the playhead moves. DeckFace is that binding plus the rows.
  const quiet = silenceNote(session?.name ?? '', { engine, decodeFailures, missingSamples })

  if (boot === 'starting' || (boot !== 'ready' && boot !== 'empty')) {
    return (
      <main className="panel compose-window mono dim" aria-label="scoopy deck starting">
        <div style={{ padding: '12px' }}>{`scoopy deck · ${boot}…`}</div>
      </main>
    )
  }

  // EMPTY IS A DOOR, not a dead end.
  //
  // The original panel manufactured an `Untitled` here precisely because an
  // empty grid "read as a broken plugin" — but that solved the appearance by
  // writing a folder into the user's library on every insert. The honest fix is
  // to SAY the state and put the library right next to it: `session ▾` carries
  // new · open · import, and it is the same menu the ready face uses.
  if (boot === 'empty') {
    return (
      <main className="panel compose-window" aria-label="scoopy deck — no session">
        <header className="compose-window-bar mono">
          <ComposeSessions deck={DECK} onNote={setNote} />
          <span>scoopy deck</span>
          {note && <span className="dim">{` · ${note}`}</span>}
          {error && <span className="warn">{` ${error}`}</span>}
        </header>
        <div className="compose-window-body">
          <div className="plugin-deck-pane mono dim" style={{ padding: '16px', gap: '8px' }}>
            <div>no session open</div>
            <div style={{ maxWidth: '46ch', lineHeight: 1.5 }}>
              Pick one from <strong>session ▾</strong> — it lists your library, and
              carries <strong>new</strong> and <strong>import…</strong>. Whatever you
              open is remembered by <em>this</em> plugin instance, so reopening the
              project brings it back.
            </div>
          </div>
          <ComposeFiles link={link} />
        </div>
      </main>
    )
  }

  return (
    <main className="panel compose-window" aria-label={`scoopy deck ${session?.name ?? ''}`}>
      <header className="compose-window-bar mono">
        <ComposeSessions deck={DECK} onNote={setNote} />
        <span>{`scoopy deck · ${session?.name ?? 'no session'}`}</span>
        {/* TWO TEMPI, deliberately both on screen — the desktop shows the same
            pair. `element.bpm` is the session's own tempo (the denominator of
            the sync ratio); masterBpm is what the DAW is running at. Showing
            only one is how "synced" becomes unfalsifiable from the UI. */}
        <span className="dim">
          {gridElement
            ? ` session ${gridElement.bpm.toFixed(1)} · ${tempoInternal ? 'master' : 'host'} `
            : ' no deck'}
        </span>
        {/* THE MASTER TEMPO, EDITABLE (D2 · kickoff §2).
            It was a read-only readout with no way anywhere in the app to type
            one, so `syncRatio` was always ~1 and TP / TS / T sounded identical —
            there was nothing to stretch AGAINST. A DragBox rather than a number
            input per DESIGN.md §1; its base right-click menu carries "Enter
            value…", so the tempo is typeable as well as draggable.
            Disabled on TEMPO HOST and SAYS SO (§6) rather than vanishing (L2):
            what the DAW reports is not ours to edit. */}
        {gridElement && (
          <DragBox
            id="plugin/masterBpm"
            value={masterBpm}
            display={masterBpm.toFixed(1)}
            min={20}
            max={400}
            step={1}
            defaultValue={gridElement.bpm}
            disabled={!tempoInternal}
            title={
              tempoInternal
                ? 'master tempo — drag, or right-click to type. The deck stretches against this.'
                : 'the DAW is the master tempo — switch TEMPO HOST to TEMPO INT to set your own'
            }
            onChange={(v) => setPluginTypedMasterBpm(v, link)}
            menu={[
              {
                kind: 'item',
                label: `Match the session (${gridElement.bpm.toFixed(1)})`,
                onSelect: () => setPluginTypedMasterBpm(gridElement.bpm, link),
              },
            ]}
          />
        )}
        <span className="dim">{hostPlaying ? ' ▸' : ' ◼'}</span>
        {/* TEMPO — the master tempo SOURCE. The second of D2's two switches;
            CLK below is the other one and governs transport alone. */}
        <button
          type="button"
          className={`dr mono${tempoInternal ? ' latched' : ''}`}
          onClick={() => {
            const next = !tempoInternal
            setTempoInternal(next)
            // Order matters: arm the gate BEFORE React re-renders, or a
            // `hostTransport` tick landing in between overwrites the value the
            // user is about to take over.
            setPluginTempoInternal(next)
          }}
          title={
            tempoInternal
              ? 'TEMPO INT — the deck stretches against the master tempo box, ignoring the DAW’s tempo'
              : 'TEMPO HOST — the DAW’s tempo is the master; the box follows it and cannot be edited'
          }
        >
          {tempoInternal ? 'TEMPO INT' : 'TEMPO HOST'}
        </button>
        {/* COMPOSE / DECK — how the rows are drawn. First, because it is the
            widest thing this bar does: it is the difference between a surface
            you build on and a surface you perform on. */}
        <button
          type="button"
          className={`dr mono${composeView ? ' latched' : ''}`}
          onClick={() => setComposeView((v) => !v)}
          title={
            composeView
              ? 'COMPOSE — full track rows: sample browse, LOAD, the DSP band and + to add a track'
              : 'DECK — the compact performance rows. Switch to COMPOSE to load samples and build.'
          }
        >
          {composeView ? 'COMPOSE' : 'DECK'}
        </button>
        {/* Q — the launch quantum. Sits with CLK and TEMPO because it is the
            third of the same family: those two pick which host clock governs
            transport and tempo, and this picks which of its BOUNDARIES a launch
            waits for. Cycling rather than a menu, like the plane's own picker.
            Steps are 16ths — "16" is a bar of 4/4 — which the title says so the
            scale is not a thing you have to already know. */}
        <button
          type="button"
          className={`dr mono${quantum !== 'off' ? ' latched' : ''}`}
          onClick={() => {
            const next = nextQuantum(quantum)
            setQuantum(next)
            // Native is the record (it rides the chunk); this is the mirror.
            void link?.command('deckLaunch' as never, { quantum: next }).catch(() => {})
          }}
          title={
            quantum === 'off'
              ? 'Q OFF — ⟳ starts this deck immediately'
              : quantum === 'cycle'
                ? '⟳ waits for this deck’s own cycle on the DAW’s grid'
                : `⟳ waits ${quantum} steps (${Number(quantum) / 4} beats) on the DAW’s grid`
          }
        >
          {`Q ${quantum}`}
        </button>
        {/* CLK — host transport vs internal clock. The tempo axis is SYNC/FREE
            on the deck row; this is the TRANSPORT axis, and they are
            independent on purpose (see followTransport). */}
        <button
          type="button"
          className={`dr mono${followTransport ? ' latched' : ''}`}
          onClick={() => setFollowTransport((v) => !v)}
          title={
            followTransport
              ? 'CLK HOST — the DAW’s transport starts and stops this deck, on its bar grid'
              : 'CLK INT — internal clock: the deck answers only its own transport, ignoring the DAW'
          }
        >
          {followTransport ? 'CLK HOST' : 'CLK INT'}
        </button>
        {/* ⤢ — THE IN-PAGE RESIZE GRIP.
            The native corner is reclaimed (the editor trims itself a strip for
            it, because a WKWebView covers a lightweight JUCE component no
            matter what z-order says), but a host that refuses to let a plugin
            window grow leaves that grip inert — and "the window will not
            expand" is what was reported. This drives `setSize` on the editor
            instead, which more hosts honour. Drag it: right/down grows.
            Refused by the app host like every other plugin-only method. */}
        <button
          type="button"
          className="dr mono"
          title="drag to resize the plugin window — right/down grows it"
          style={{ cursor: 'nwse-resize', touchAction: 'none' }}
          onPointerDown={(e) => {
            if (!link) return
            e.preventDefault()
            e.currentTarget.setPointerCapture(e.pointerId)
            const x0 = e.clientX
            const y0 = e.clientY
            // The OUTER window, not the viewport: the editor trims a chrome
            // strip off the webview, so innerHeight is short by that much and
            // resizing from it would shrink the window a little on every drag.
            const w0 = window.outerWidth || window.innerWidth
            const h0 = window.outerHeight || window.innerHeight
            const el = e.currentTarget
            const move = (ev: PointerEvent) => {
              void link
                .command('editorSize' as never, {
                  width: Math.round(w0 + (ev.clientX - x0)),
                  height: Math.round(h0 + (ev.clientY - y0)),
                })
                .catch(() => {})
            }
            const up = () => {
              el.removeEventListener('pointermove', move)
              el.removeEventListener('pointerup', up)
              el.removeEventListener('pointercancel', up)
            }
            el.addEventListener('pointermove', move)
            el.addEventListener('pointerup', up)
            el.addEventListener('pointercancel', up)
          }}
        >
          ⤢
        </button>
        {note && <span className="dim">{` · ${note}`}</span>}
        {/* Only when it is true. A telemetry feed that has stopped must SAY so —
            every meter, LED and playhead on this face is fed by it, and stale
            numbers that look live are worse than blank ones. */}
        {framesStalled && (
          <span className="warn" title="the editor is not receiving HotFrames from the engine — meters, LEDs and the playhead are frozen">
            {' no engine frames'}
          </span>
        )}
        {error && <span className="warn">{` ${error}`}</span>}
        {!error && quiet && <span className="warn">{` ${quiet}`}</span>}
        {!error && notice && <span className="dim">{` · ${notice}`}</span>}
      </header>
      {/* THE DECK, whole — the SAME component the desktop expands a strip into
          (deckTile's DeckFace). Toolbar · sync · scenes · view rows, the grid
          at deck density, and the LCM cycle bar.

          Assembling these by hand here was the first cut and it was worse in
          exactly the way that matters: PERF has to reach the grid BACKEND
          (`setMetaFacts({performActive})`), not a React prop, so a hand-wired
          copy latched on screen and did nothing. Mounting the real component
          means every one of those wires is right by construction rather than
          by my remembering it. */}
      {/* THE SCENE PADS (1…8).
          NOT in DeckSceneRow despite that row's name — it carries the scene
          MODE controls (switch mode · CU · SCN · MUTE) and the pads live on the
          plane's collapsed strip face, which a plugin never mounts. So the deck
          rows alone gave scene controls with no scenes to point at.
          Letters A…H are the storage identity; the FACE is 1-based, which is
          the app's own rule (sceneDisplayLabel). */}
      {/* ⚠️ THE PADS NEED A BOX. `.strip-scenes` is `height: 100%` because in
          the plane it sits in the wave field's 48 px rect. As a direct child
          of this flex column that resolves against the WHOLE WINDOW, and the
          pads eat the entire plugin — deck rows, grid and files all pushed
          off screen. The wrapper is the rect the plane would have given it. */}
      {strip && gridElement && (
        <div className="plugin-deck-scenes">
        <GridScenes
          strip={strip}
          scene={scene}
          queued={queued}
          enabledScenes={enabledSceneRow}
          onAddScene={() =>
            useCompanion.getState().setEnabledSceneCount(enabledSceneRow.length + 1, PLUGIN_DECK)
          }
          onSelectScene={(sc, immediate) =>
            useCompanion.getState().selectScene(sc, { immediate, deck: PLUGIN_DECK })
          }
        />
        </div>
      )}
      {/* ⚠️ TWO LAYOUT CONTRACTS, both of which I broke on the first pass and
          both of which are invisible in a unit test:

          `.compose-window-body` is `display:flex; flex-direction:row` — it is
          the ONLY reason the FILES drawer sits BESIDE the grid instead of
          stacking underneath it.

          `.plugin-deck-pane` is a flex COLUMN with a bounded height, because
          DeckFace's own `.strip-deckface` is `flex: 1 1 auto; min-height: 0`
          and `.strip-deckface .grid-panel { height: 100% }`. Without a bounded
          column parent that resolves to nothing, and GridPanel falls back to
          sizing itself as a WINDOW ROOT at 100vh — which is the grid slowly
          stretching down the screen on load. */}
      <div className="compose-window-body">
        <div className="plugin-deck-pane">
          {strip && gridElement && (
            <DeckFace
              link={link}
              strip={strip}
              element={gridElement}
              masterBpm={masterBpm}
              sessions={sessions}
              // ONE DECK, so it is unambiguously the first slot — and passing it
              // is what enables GridPanel's focus ADOPTION (§8). Without it the
              // keyboard claim moved and the ring stayed where it was, which is
              // the "focus doesn't stick" report. The plane leaves it undefined
              // on purpose; see DeckFace.
              djSlotIndex={0}
              // The COMPOSE/DECK switch. Nothing else feeds it: PERF is a
              // pointer mode and no longer touches the view (user, 2026-08-01).
              viewDensity={composeView ? 'compose' : 'dj'}
              // ⟳ waits for the DAW's bar grid. The plane omits this and keeps
              // its immediate play — it arms its own launch a layer up.
              onLaunch={launchOnHostGrid}
              // ⚠️ THE STRIP MUST FOLLOW THE SESSION. Opening alone leaves
              // `element.sessionId`/`bpm` pointing at the PREVIOUS session, so
              // djSyncLaw divides by a stale denominator, the header shows the
              // wrong tempo, and the recipe pushed to native disagrees with
              // the one the world-publish path just derived — the native sync
              // denominator then flip-flops between two values. The plane does
              // the same rewrite after its own load (PlanePanel.loadSession).
              onLoadSession={(name) => {
                void useCompanion
                  .getState()
                  .open(name, PLUGIN_DECK)
                  .then(() => {
                    const s = useCompanion.getState().decks[PLUGIN_DECK]?.session
                    if (s)
                      setPluginSession(s.name, (s.pattern as { bpm?: number }).bpm ?? masterBpm)
                  })
                  .finally(refreshSessions)
              }}
            />
          )}
        </div>
        <ComposeFiles link={link} />
      </div>
    </main>
  )
}
