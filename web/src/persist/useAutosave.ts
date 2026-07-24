/**
 * Autosave + restore (P7-03, sessions.md §4–§5).
 *
 * Restoring is a PUBLISH, not a special path: the loaded Patch goes through the
 * same publishPatch the UI uses for any edit, so there is one code path and no
 * restore-only bugs. Decks land idle — an app that starts making sound on
 * launch is hostile.
 */
import { useEffect, useRef } from 'react'
import type { Patch } from '../../protocol/schema'
import type { EngineLink } from '../engine/engineLink'
import { publishPatch } from '../engine/usePatch'
import { useAppStore } from '../store/appStore'
import { loadSession, makeSession, serializeSession } from './session'

/** The file's own name, used to match a document reference against a copy
    carried inside a package. */
export function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}

export interface RehydrateResult {
  /** Decks whose audio could not be found anywhere. */
  unresolved: number
  /** Decks now pointing at a package's embedded copy instead of the original,
      so the caller can write the working path back into the document. */
  remaps: Array<{ deck: number; path: string }>
}

/**
 * Re-load each deck's referenced audio after a restore (sessions.md §5). A
 * reference that no longer resolves leaves the deck IN PLACE, marked and
 * silent — never dropped — matching the vanished-source posture the whole app
 * takes.
 *
 * `fallbacks` maps a filename to a package's embedded copy. The ORIGINAL path
 * is always tried first: when it still resolves, the user's own file wins and
 * nothing is rewritten, so opening a package on the machine that made it does
 * not silently re-point the document at a duplicate.
 */
export async function rehydrateDecks(
  link: EngineLink,
  patch: Patch,
  setUnresolved: (deck: number, unresolved: boolean) => void,
  bumpRevision: (deck: number) => void,
  fallbacks: Record<string, string> = {},
): Promise<RehydrateResult> {
  const out: RehydrateResult = { unresolved: 0, remaps: [] }
  const tryLoad = async (deck: number, path: string) => {
    try {
      return (await link.command('deckLoadTake', { deck, path })).ok
    } catch {
      return false
    }
  }
  for (const deck of patch.decks) {
    if (deck.sourcePath === '') {
      setUnresolved(deck.id, false)
      continue
    }
    let ok = await tryLoad(deck.id, deck.sourcePath)
    if (!ok) {
      // Only now consider the embedded copy — the original had its chance.
      const fallback = fallbacks[basename(deck.sourcePath)]
      if (fallback !== undefined && fallback !== deck.sourcePath) {
        ok = await tryLoad(deck.id, fallback)
        if (ok) out.remaps.push({ deck: deck.id, path: fallback })
      }
    }
    setUnresolved(deck.id, !ok)
    if (ok) bumpRevision(deck.id)
    else out.unresolved++
  }
  return out
}

/** Shared wording so a restore and a package open report a loss identically. */
export function missingAudioNotice(count: number): string {
  return `${count} deck${count === 1 ? '' : 's'} could not find ${
    count === 1 ? 'its' : 'their'
  } audio — kept in place, silent`
}

/** Wait this long after the last edit before writing. Long enough that a fader
    drag is one write, short enough that a crash loses almost nothing. */
export const AUTOSAVE_DEBOUNCE_MS = 2000

export interface RestoreOutcome {
  restored: boolean
  source: 'primary' | 'backup' | 'none'
  /** Non-empty when a session existed but could not be used — shown to the
      user, because a silently-empty app is the failure this feature prevents. */
  problem: string
}

/** Pure: decide what to do with whatever the shell handed back. */
export function interpretRestore(text: string, source: string): RestoreOutcome & { patch?: Patch } {
  if (source === 'none' || text.trim() === '')
    return { restored: false, source: 'none', problem: '' }
  const result = loadSession(text)
  if (!result.ok) {
    return {
      restored: false,
      source: source === 'backup' ? 'backup' : 'primary',
      problem: result.message,
    }
  }
  return {
    restored: true,
    source: source === 'backup' ? 'backup' : 'primary',
    problem:
      source === 'backup'
        ? 'the main session file was unreadable; restored from the backup'
        : '',
    patch: result.patch,
  }
}

/**
 * Restores once on mount, then autosaves the Patch on a debounce.
 * `nowIso` is injected so tests are deterministic and the module stays pure.
 */
export function useAutosave(link: EngineLink | null, nowIso: () => string): void {
  const patch = useAppStore((s) => s.patch)
  const restoredRef = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // --- restore once, before any autosave can overwrite it -------------------
  useEffect(() => {
    if (!link || restoredRef.current) return
    let cancelled = false
    void link
      .command('loadAutosave', {})
      .then((r) => {
        if (cancelled) return
        const outcome = interpretRestore(r.text, r.source)
        const store = useAppStore.getState()
        if (outcome.patch) {
          store.setPatch(outcome.patch)
          publishPatch(link, outcome.patch) // restore IS a publish
          // Then rehydrate deck audio from its references. Decks land idle —
          // an app that starts making sound on launch is hostile.
          void rehydrateDecks(
            link,
            outcome.patch,
            store.setDeckUnresolved,
            store.bumpDeckRevision,
          ).then(({ unresolved }) => {
            if (unresolved > 0)
              useAppStore.getState().setSessionNotice(missingAudioNotice(unresolved))
          })
        }
        if (outcome.problem) store.setSessionNotice(outcome.problem)
        // Only allow autosave AFTER a restore attempt has resolved — otherwise
        // an empty initial patch could overwrite a good session on launch.
        restoredRef.current = true
      })
      .catch(() => {
        if (!cancelled) restoredRef.current = true
      })
    return () => {
      cancelled = true
    }
  }, [link])

  // --- debounced autosave ---------------------------------------------------
  useEffect(() => {
    if (!link || !restoredRef.current) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      const text = serializeSession(makeSession(patch, nowIso()))
      void link.command('saveAutosave', { text }).then((r) => {
        if (!r.ok) useAppStore.getState().setSessionNotice(r.error || 'autosave failed')
      })
    }, AUTOSAVE_DEBOUNCE_MS)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [link, patch, nowIso])
}
