/**
 * P3-C2 — the single-publisher rule's RETURN half.
 *
 * While a compose window owns deck d, the plane suppresses d's publish verbs
 * (Strip's `composing` lock). When the shell broadcasts `slPanelClosed` for a
 * compose window, the plane releases the lock and re-opens the session FROM
 * DISK — the window autosaved there, and disk is the only channel the two
 * WebViews share (there is no cross-window store).
 *
 * Pure-ish and injected so it is testable without a shell: the caller decides
 * what release/reopen/note actually do (and PlanePanel delays the reopen a
 * beat, giving the closing window's pagehide autosave flush time to land).
 */
import { decodeComposeArg } from './composeArg.ts'

export function handlePanelClosed(
  payload: unknown,
  deps: {
    release: (deck: number) => void
    reopen: (session: string, deck: number) => void
    note: (note: string) => void
  },
): void {
  const p = payload as { panel?: unknown; arg?: unknown } | null
  if (!p || p.panel !== 'compose') return
  const arg = decodeComposeArg(typeof p.arg === 'string' ? p.arg : undefined)
  // A compose window that closed with a garbage address cannot say which deck
  // it held — refuse quietly rather than reloading the wrong one.
  if (!arg) return
  deps.release(arg.deck)
  deps.reopen(arg.session, arg.deck)
  deps.note(`deck ${arg.deck + 1} is back from compose — reloaded "${arg.session}" from disk`)
}
