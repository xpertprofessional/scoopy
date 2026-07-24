/**
 * `.wizard` package save/open (P7-07, sessions.md §2).
 *
 * The shell owns the dialogs and the bytes; this owns the DECISIONS — which
 * takes to carry, and what to do with references that do not resolve on the
 * machine the package is opened on.
 */
import type { Patch } from '../../protocol/schema'
import type { EngineLink } from '../engine/engineLink'
import { loadSession, makeSession, serializeSession } from './session'
import { basename, rehydrateDecks, missingAudioNotice } from './useAutosave'

/**
 * Which files the package should carry. Decks reference audio by absolute path;
 * a package opened elsewhere must still make sound, so those files travel.
 *
 * Deliberately de-duplicated: two decks playing the same take embed it once.
 */
export function takePathsFor(patch: Patch): string[] {
  const seen = new Set<string>()
  for (const deck of patch.decks) if (deck.sourcePath !== '') seen.add(deck.sourcePath)
  return [...seen]
}

export interface PackageOutcome {
  /** Empty when the user simply cancelled — a cancel is not a failure. */
  notice: string
  ok: boolean
}

export async function savePackage(
  link: EngineLink,
  patch: Patch,
  nowIso: string,
): Promise<PackageOutcome> {
  const text = serializeSession(makeSession(patch, nowIso))
  const takes = takePathsFor(patch)
  try {
    const r = await link.command('savePackage', { text, takes })
    if (!r.ok) return { ok: false, notice: r.error ?? '' } // cancel => error ''
    if (r.missing.length > 0)
      return {
        ok: true,
        // Say exactly what the package does NOT contain. A package quietly
        // missing audio is discovered by whoever opens it, far from here.
        notice: `package saved, but ${r.missing.length} take${
          r.missing.length === 1 ? '' : 's'
        } no longer exist and could not be included`,
      }
    return { ok: true, notice: '' }
  } catch (e) {
    return { ok: false, notice: `could not save the package: ${String(e)}` }
  }
}

/**
 * Open a package: parse its session, publish it, then rehydrate decks with the
 * embedded copies as a FALLBACK behind each deck's original path.
 *
 * `applyPatch` receives the patch to install (already remapped where the
 * original path was dead), so this module never touches the store directly.
 */
export async function openPackage(
  link: EngineLink,
  applyPatch: (patch: Patch) => void,
  setUnresolved: (deck: number, unresolved: boolean) => void,
  bumpRevision: (deck: number) => void,
): Promise<PackageOutcome> {
  let r: { ok: boolean; text: string; takes: Array<{ name: string; path: string }>; error: string }
  try {
    r = (await link.command('loadPackage', {})) as typeof r
  } catch (e) {
    return { ok: false, notice: `could not open the package: ${String(e)}` }
  }
  if (!r.ok) return { ok: false, notice: r.error ?? '' } // cancel => error ''

  const parsed = loadSession(r.text)
  if (!parsed.ok) return { ok: false, notice: `that package's session ${parsed.message}` }

  const fallbacks: Record<string, string> = {}
  for (const t of r.takes) fallbacks[t.name] = t.path

  applyPatch(parsed.patch)
  const { unresolved, remaps } = await rehydrateDecks(
    link,
    parsed.patch,
    setUnresolved,
    bumpRevision,
    fallbacks,
  )

  // Write back only the paths that actually changed, and only because the
  // original was proven dead — the document keeps pointing at the user's own
  // files wherever those still exist.
  if (remaps.length > 0) {
    const byDeck = new Map(remaps.map((m) => [m.deck, m.path]))
    applyPatch({
      ...parsed.patch,
      decks: parsed.patch.decks.map((d) =>
        byDeck.has(d.id) ? { ...d, sourcePath: byDeck.get(d.id)! } : d,
      ),
    })
  }

  const parts: string[] = []
  if (remaps.length > 0)
    parts.push(
      `${remaps.length} deck${remaps.length === 1 ? '' : 's'} now play the package's own copy`,
    )
  if (unresolved > 0) parts.push(missingAudioNotice(unresolved))
  return { ok: true, notice: parts.join('; ') }
}

/** Exported for the fixture: the name a reference is matched by. */
export { basename }
