/**
 * P3-C1 — THE COMPOSE WINDOW: the real grid composer, in its own window.
 *
 * The plane sends `openPanelWindow {panel:'compose', arg}` where `arg` is the
 * base64url address `{deck, session}` (composeArg.ts — it survives the shell's
 * user-script sanitizer by construction). This window is a SEPARATE WebView
 * with its OWN companionEngine store; on mount it starts the engine sink and
 * opens the session FROM DISK into the same deck index, so edits made here are
 * audible immediately through this window's publish lane and autosaved through
 * the same slFiles route everything else uses.
 *
 * OWNERSHIP: while this window lives, IT is deck d's publisher — the plane
 * suppresses its own verbs for d and re-opens the session from disk when the
 * shell broadcasts `slPanelClosed` (the single-publisher rule, P3-C2). The
 * pagehide/visibility flush matters more here than anywhere: the autosave
 * debounce is 1.5 s and closing the window is exactly when the last edit must
 * not be the one that never landed.
 */
import { useEffect, useMemo, useState } from 'react'

import type { EngineLink } from '../engineLink.ts'
import { GridPanel } from '../panels/GridPanel.tsx'
import { flushAutosave, useCompanion } from '../store/companionEngine.ts'
import { silenceNote } from '../store/sampleReport.ts'
import { juceBackend } from '../../protocol/juceLink.ts'
import { autoStartEngine } from './bootEngine.ts'
import { ComposeFiles } from './ComposeFiles.tsx'
import { ComposeSessions } from './ComposeSessions.tsx'
import { decodeComposeArg } from './composeArg.ts'
import { useComposeBinding } from './useComposeBinding.ts'

export function ComposeWindow({ link }: { link: EngineLink | null }) {
  const arg = useMemo(
    () => decodeComposeArg((window as { __slPanelArg?: string }).__slPanelArg),
    [],
  )
  const deck = arg?.deck ?? 0
  /** The window's own note line — its ONE error surface, like the plane's. */
  const [note, setNote] = useState<string | null>(null)
  const error = useCompanion((c) => c.error)
  // P3.5-E8g — the store's PROGRESS line, which this window never rendered.
  // `loadSample` has always set `<sample> → track N` on success and the sample
  // doors now name the stage they are waiting on; none of it reached the one
  // surface a person loads samples in. A door whose only outcome is a silent
  // change to a row three panes away is not reportable, and "the file never
  // loads, track stays empty" is what that unreportability sounds like.
  const notice = useCompanion((c) => c.notice)
  // P3.5-E9a — this window opens the session itself, in its OWN store, so it
  // must report its own silence: a kit that did not fully decode here is a kit
  // this window's engine cannot play, whatever the plane's copy managed.
  const engine = useCompanion((c) => c.engine)
  const decodeFailures = useCompanion((c) => c.decks[deck]?.decodeFailures)
  const missingSamples = useCompanion((c) => c.decks[deck]?.missingSamples)
  const quiet = silenceNote(arg?.session ?? '', {
    engine,
    decodeFailures,
    missingSamples,
  })

  useEffect(() => {
    void (async () => {
      // ⚠️ THE SINK STARTS EVEN WITH NO ARG (B5). This used to return early
      // when the window was unaddressed, which was harmless while the only way
      // here was from a strip. On the mapless boot path it would be the whole
      // bug: "new session" would create and open a document into an engine that
      // was never started, so nothing publishes and the transport silently
      // no-ops — the `didNotStart` shape, one layer down.
      //
      // Sink first, session second: `open()` publishes only while the engine
      // runs, and this window's store boots cold (every WebView has its own).
      await autoStartEngine(juceBackend() !== null, () => useCompanion.getState())
      if (arg) await useCompanion.getState().open(arg.session, arg.deck)
    })()
    // The arg is decoded once from the injection — it cannot change while the
    // window lives, so this effect runs exactly once by construction.
  }, [arg])

  // ⌘S SAVES THE SESSION (D-SL-SAVE-01) — one meaning on every surface, so the
  // chord transfers between this window and the plane. It is a FLUSH: edits
  // already autosave on a 1.5 s debounce, so this lands the pending write now
  // rather than rescuing something that was never going to be saved.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 's' || !(e.metaKey || e.ctrlKey) || e.shiftKey) return
      // ⇧⌘S is the MAP, which a compose window does not have — deliberately not
      // swallowed here, so it stays available to whatever does.
      e.preventDefault()
      void flushAutosave().then(() => setNote('saved'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // The last edit must land: closing the window is precisely when the 1.5 s
  // autosave debounce would eat it (the CompanionPanel:103 rule, applied here).
  useEffect(() => {
    const flush = () => void flushAutosave()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [])

  const { session } = useComposeBinding(link, deck)

  // ⚠️ NO ARG IS NOW A VALID STATE (B5 · D-SL-LAUNCH-01). It used to be a
  // refusal — "close it and use COMPOSE ⇱ on a strip" — which was right when
  // the only way here was from a strip. The boot chooser's mapless COMPOSE path
  // opens this window with NOTHING addressed, on purpose: there is no plane, no
  // map, and no session yet. So an unaddressed window is an empty studio rather
  // than a mistake, and the session menu is how you fill it.

  return (
    <main className="panel compose-window" aria-label={`compose ${arg?.session ?? 'empty'}`}>
      <header className="compose-window-bar mono">
        <ComposeSessions deck={deck} onNote={setNote} />
        <span>{`compose · ${session?.name ?? arg?.session ?? 'no session'}`}</span>
        <span className="dim">
          {arg
            ? ` deck ${deck + 1} — edits are live and autosaved; close the window to hand the deck back to the plane`
            : ` deck ${deck + 1} — no plane open; use “session ▾” to make or open one`}
        </span>
        {note && <span className="dim">{` · ${note}`}</span>}
        {error && <span className="warn">{` ${error}`}</span>}
        {!error && quiet && <span className="warn">{` ${quiet}`}</span>}
        {/* Beside the warnings rather than instead of them: a kit that cannot
            play and a sample that is mid-load are two different facts, and the
            moment you most need the progress line is while filling a kit that
            is still silent. */}
        {!error && notice && <span className="dim">{` · ${notice}`}</span>}
      </header>
      {/* The REAL composer, unmodified — the same component the desktop runs. */}
      <div className="compose-window-body">
        <div className="compose-grid-pane">
          <GridPanel link={link} />
        </div>
        {/* P3.5-E8b — the sample browser's home. The doors it feeds were
            registered by E8a in `useComposeBinding`, so a file double-clicked
            here lands on the grid's selected track and a row dragged onto a
            track lands on that one. */}
        <ComposeFiles link={link} />
      </div>
    </main>
  )
}
