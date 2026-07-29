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
import { useEffect, useMemo } from 'react'

import type { EngineLink } from '../engineLink.ts'
import { GridPanel } from '../panels/GridPanel.tsx'
import { flushAutosave, useCompanion } from '../store/companionEngine.ts'
import { juceBackend } from '../../protocol/juceLink.ts'
import { autoStartEngine } from './bootEngine.ts'
import { decodeComposeArg } from './composeArg.ts'
import { useComposeBinding } from './useComposeBinding.ts'

export function ComposeWindow({ link }: { link: EngineLink | null }) {
  const arg = useMemo(
    () => decodeComposeArg((window as { __slPanelArg?: string }).__slPanelArg),
    [],
  )
  const deck = arg?.deck ?? 0
  const error = useCompanion((c) => c.error)

  useEffect(() => {
    if (!arg) return
    void (async () => {
      // Sink first, session second: `open()` publishes only while the engine
      // runs, and this window's store boots cold (every WebView has its own).
      await autoStartEngine(juceBackend() !== null, () => useCompanion.getState())
      await useCompanion.getState().open(arg.session, arg.deck)
    })()
    // The arg is decoded once from the injection — it cannot change while the
    // window lives, so this effect runs exactly once by construction.
  }, [arg])

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

  if (!arg) {
    // An unaddressed compose window can only edit the wrong thing — refuse
    // with the next step named, never guess a deck.
    return (
      <main className="panel compose-window">
        <p className="mono warn">
          this compose window opened without an address — close it and use COMPOSE ⇱ on a strip
        </p>
      </main>
    )
  }

  return (
    <main className="panel compose-window" aria-label={`compose ${arg.session}`}>
      <header className="compose-window-bar mono">
        <span>{`compose · ${session?.name ?? arg.session}`}</span>
        <span className="dim">{` deck ${deck + 1} — edits are live and autosaved; close the window to hand the deck back to the plane`}</span>
        {error && <span className="warn">{` ${error}`}</span>}
      </header>
      {/* The REAL composer, unmodified — the same component the desktop runs. */}
      <div className="compose-window-body">
        <GridPanel link={link} />
      </div>
    </main>
  )
}
