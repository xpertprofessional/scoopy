/**
 * COMPOSE BESIDE THE MAP — the real grid composer, as an IN-WINDOW overlay.
 *
 * HISTORY (P3-C1 rewrote this header): the separate window this started as was
 * abandoned for three reasons, and all three are now resolved or superseded —
 *
 *   1. `openPanelWindow` dropped its arg → FIXED by P3-4-2 (`__slPanelArg`
 *      injection); the compose window's address rides it (composeArg.ts).
 *   2. Nothing loaded a session into a bare GridPanel window → FIXED by
 *      `ComposeWindow.tsx` (opens the session from disk into its own store's
 *      deck and binds via the same `useComposeBinding` this overlay uses).
 *   3. Two windows holding one deck would both publish its world → HANDLED by
 *      the single-publisher rule (P3-C2): while a compose window owns deck d,
 *      the plane suppresses d's verbs and re-opens from disk on close.
 *
 * So in the MERGED (JUCE) host, `COMPOSE ⇱` opens the real separate window —
 * the user's explicit wish. THIS overlay remains as the browser host's
 * fallback, where there is no window layer to spawn.
 *
 * The composer itself is `GridPanel`, reused unmodified; the deck binding
 * lives in `useComposeBinding` (shared with the window — a drifted copy here
 * is an edit that lands in the document and never reaches the engine).
 */
import type { EngineLink } from '../engineLink.ts'
import { GridPanel } from '../panels/GridPanel.tsx'
import { useCompanion } from '../store/companionEngine.ts'
import { ComposeFiles } from './ComposeFiles.tsx'
import { useComposeBinding } from './useComposeBinding.ts'

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
  useComposeBinding(link, deck)

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
        <div className="compose-grid-pane">
          <GridPanel link={link} />
        </div>
        {/* P3.5-E8b — the same drawer the compose WINDOW carries. Two compose
            surfaces with one sample browser between them: the alternative is
            how E8a's omission happened. */}
        <ComposeFiles link={link} />
      </div>
    </section>
  )
}
