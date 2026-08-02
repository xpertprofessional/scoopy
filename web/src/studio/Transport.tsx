/**
 * THE DECK TRANSPORT — ⟳ ▸ ↻ ◼, as a block (S2).
 *
 * `DESIGN.md` §3 fixes the vocabulary at four glyphs and says it is the same in
 * every scope: a tape, a grid strip, the deck tile, the master bar. This is the
 * fourth surface to need it, which is exactly when a shared component stops
 * being a nicety — the plane's master renders its own set inline, and a copy per
 * face is how `■`/`▶` eventually appears somewhere as a second dialect.
 *
 * ONE DECK. It addresses a deck by index because the store's verbs do; Studio
 * passes 0 because with DJ mode gone there is only one (D-SL-STUDIO-01), and a
 * plugin face passes its own. It is not a MASTER transport — the plane's
 * `Master` drives every deck at once and deliberately drops ▸ because "fire this
 * once" has no meaning across N decks. Here ▸ is a real verb, so all four render.
 *
 * ⚠️ RULE 7, AND IT IS THE WHOLE REASON THE `session` PROP EXISTS. `DESIGN.md`
 * §7 says never ship a control that reaches nothing, and §6 says a disabled
 * control must teach. Every verb below goes through `useCompanion`, which
 * refuses silently when there is no session or the engine sink is not running —
 * so without the guard these would be four buttons that swallow clicks and look
 * identical to four working ones. They are disabled and say why instead.
 */
import { useCompanion } from '../store/companionEngine.ts'

export function Transport({ deck, session }: { deck: number; session: string | null }) {
  const playing = useCompanion((c) => c.decks[deck]?.playing ?? false)
  const c = () => useCompanion.getState()
  /** The one precondition every verb here shares. */
  const why = session ? null : 'no session — use “session ▾” to make or open one'

  return (
    <span className="master-transport" role="group" aria-label="transport">
      <button
        type="button"
        onClick={() => c().play(deck)}
        disabled={!!why}
        aria-pressed={playing}
        title={why ?? 'play — the pattern loops'}
      >
        ⟳
      </button>
      {/* ▸ ONE-SHOT is `playOnce`, which the store implements as the donor does:
          stopped → one full cycle from the top; ALREADY PLAYING → arm the stop
          at the end of the cycle in flight rather than restarting, because "let
          this one finish" is the opposite of jumping the playhead home. */}
      <button
        type="button"
        onClick={() => c().playOnce(deck)}
        disabled={!!why}
        title={why ?? 'one-shot — play one cycle, then stop'}
      >
        ▸
      </button>
      {/* ↻ RETRIGGER — back to step 0 WITHOUT leaving the transport (§3). Stop
          then play, which is what the plane's master does for the same verb;
          `play()` alone restarts at 0 but also clears a pending one-shot arm, so
          the pair is the honest spelling of "from the top, still running". */}
      <button
        type="button"
        onClick={() => {
          c().stop(deck)
          c().play(deck)
        }}
        disabled={!!why}
        title={why ?? 'retrigger — back to step 0 without stopping'}
      >
        ↻
      </button>
      <button
        type="button"
        onClick={() => c().stop(deck)}
        disabled={!!why}
        title={why ?? 'stop'}
      >
        ◼
      </button>
    </span>
  )
}
