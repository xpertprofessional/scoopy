/**
 * The two effects EVERY session-editing surface owes, in one place (S1).
 *
 * `ComposeWindow`, `StudioPanel` and `PluginDeckPanel` each edit a session and
 * each autosave on the store's 1.5 s debounce. That debounce makes two
 * obligations, and both are the kind that look fine until the one time they
 * matter:
 *
 *   ⌘S      D-SL-SAVE-01 — one meaning on every surface, so the chord transfers
 *           between faces. It is a FLUSH: edits already autosave, so this lands
 *           the pending write NOW rather than rescuing one that was never going
 *           to be saved. ⇧⌘S is the MAP and is deliberately NOT swallowed here,
 *           so it stays available to whatever owns one.
 *   teardown Closing the surface is precisely when the debounce would eat the
 *           last edit. `pagehide` AND `visibilitychange`, because a WKWebView
 *           torn down by the shell does not reliably fire the usual lifecycle.
 *
 * These were copied into each face by hand. That is exactly the drift
 * `useComposeBinding`'s header warns about one layer down — "a drifted copy
 * here is an edit that lands in the document and never reaches the engine" —
 * and the failure here has the same shape: a surface that silently saves less
 * than its sibling, discovered only by losing work.
 */
import { useEffect } from 'react'

import { flushAutosave } from '../store/companionEngine.ts'

export function useComposeLifecycle(onSaved?: (note: string) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 's' || !(e.metaKey || e.ctrlKey) || e.shiftKey) return
      e.preventDefault()
      void flushAutosave().then(() => onSaved?.('saved'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // `onSaved` is a setState-shaped callback in every caller; re-binding the
    // listener on each render would be churn for no behaviour change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const flush = () => void flushAutosave()
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [])
}
