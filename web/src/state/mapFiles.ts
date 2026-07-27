/**
 * Saving and opening a `.scoopyMap` (merge P2 step 4, increment 6).
 *
 * Wizard's persistence discipline, kept: the DOCUMENT layer owns the format
 * (`persist/mapDocument.ts` — strict zod, named migrations, refuse-newer) and
 * this only moves it. The shell moves bytes; nothing here parses and nothing
 * there does either.
 *
 * ⚠️ A SAVE CAPTURES THE ROUTING GRAPH FROM THE ENGINE, not from the store.
 * Those two drift the moment anything patches outside the document's view — a
 * default installed at boot, a cable added from the ledger — and the difference
 * stays invisible until the reload, which is the worst possible moment to
 * discover it. `captureMap` is what makes a save record what EXISTS.
 */
import type { EngineLink } from '../engineLink.ts'
import { loadMap, saveMap, type MapLoadResult, type PlaneMap } from '../persist/mapDocument.ts'
import { planPackage } from '../persist/mapPackage.ts'
import { ask } from '../plane/send.ts'
import { applyMap, captureMap, setMap, useMapStore } from './mapStore.ts'

export type MapEntry = { name: string; savedAt: number }

export type SaveResult = { ok: true } | { ok: false; error: string }

/** Every map this host can open, newest first. */
export async function listMaps(link: EngineLink | null): Promise<MapEntry[]> {
  const r = await ask<{ ok?: boolean; maps?: MapEntry[] }>(link, 'slMap', { action: 'list' })
  return (r?.maps ?? []).slice().sort((a, b) => b.savedAt - a.savedAt)
}

/**
 * Save under `name`.
 *
 * Clears `dirty` only on success — a failed save that cleared it would tell the
 * user their work was safe when it was not, which is the one lie a save
 * indicator must never tell.
 */
export async function saveMapAs(link: EngineLink | null, name: string): Promise<SaveResult> {
  if (!name.trim()) return { ok: false, error: 'a map needs a name' }
  const map = await captureMap(link)
  const r = await ask<{ ok?: boolean; error?: string | null }>(link, 'slMap', {
    action: 'save',
    name: name.trim(),
    json: JSON.stringify(saveMap(map)),
  })
  if (!r?.ok) return { ok: false, error: r?.error ?? 'the host could not save' }
  useMapStore.setState({ map, dirty: false, name: name.trim() })
  return { ok: true }
}

export type OpenResult = { ok: true; map: PlaneMap } | { ok: false; error: string }

/**
 * Open `name` and make the engine match it.
 *
 * A REFUSAL IS REPORTED, never partially applied. `loadMap` refuses a newer
 * document, a corrupt one, and one that overspends the lane budget — and each
 * refusal is a case where loading anyway would be worse than not loading:
 * partially loading a newer document and re-saving destroys what the newer
 * build knew, and a lane-overspent map leaves strips the engine cannot render
 * with nothing on screen explaining the silence.
 */
export async function openMap(link: EngineLink | null, name: string): Promise<OpenResult> {
  const r = await ask<{ ok?: boolean; json?: string }>(link, 'slMap', { action: 'open', name })
  if (!r?.ok || typeof r.json !== 'string') return { ok: false, error: 'could not read that map' }

  let parsed: MapLoadResult
  try {
    parsed = loadMap(JSON.parse(r.json))
  } catch {
    return { ok: false, error: 'that file is not a map' }
  }
  if (!parsed.ok) return { ok: false, error: describeRefusal(parsed) }

  // The document first, so the UI shows what is being loaded even if the engine
  // is slow or absent; then the engine is made to match it.
  setMap(parsed.map)
  useMapStore.setState({ name })
  await applyMap(link, parsed.map)
  return { ok: true, map: parsed.map }
}

/** The refusal, in words a person can act on. */
function describeRefusal(r: Extract<MapLoadResult, { ok: false }>): string {
  switch (r.reason) {
    case 'tooNew':
      return `saved by a newer version — refusing rather than dropping what it knows (${r.message})`
    case 'laneBudget':
      return `too many lanes for this mixer — ${r.message}`
    default:
      return `that map is damaged — ${r.message}`
  }
}

/**
 * Export a self-contained package.
 *
 * TS decides WHAT (the rewritten document and the file list, from
 * `planPackage`); the shell moves the BYTES. No audio crosses the bridge —
 * takes are capped at 256 MB and base64 would be ~350 MB of string each.
 */
export async function exportMap(
  link: EngineLink | null,
  name: string,
): Promise<{ ok: true; path: string; missing: string[] } | { ok: false; error: string }> {
  if (!name.trim()) return { ok: false, error: 'name the map first' }
  const map = await captureMap(link)
  const plan = planPackage(map)
  const r = await ask<{ ok?: boolean; path?: string; missing?: string[] }>(link, 'slMap', {
    action: 'export',
    name: name.trim(),
    json: plan.json,
    takes: plan.takes,
  })
  if (!r?.ok || !r.path) return { ok: false, error: 'the host could not write the package' }
  return { ok: true, path: r.path, missing: r.missing ?? [] }
}

export async function deleteMap(link: EngineLink | null, name: string): Promise<boolean> {
  const r = await ask<{ ok?: boolean }>(link, 'slMap', { action: 'delete', name })
  return Boolean(r?.ok)
}

/* ── autosave ─────────────────────────────────────────────────────────────── */

/**
 * Autosave the CURRENT map while it is dirty.
 *
 * Only once it has a name: autosaving an unnamed map would scatter
 * "untitled-3" documents nobody asked for, and the first explicit save is what
 * says "this one is worth keeping".
 *
 * Debounced rather than periodic. A performance edits the map continuously —
 * every fader move marks it dirty — and a timer would write mid-gesture, over
 * and over. This waits for a pause, which is also when a save is cheapest and
 * most likely to represent something the user meant.
 */
export function attachAutosave(link: EngineLink | null, delayMs = 4000): () => void {
  if (!link) return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let saving = false

  const unsub = useMapStore.subscribe((state) => {
    if (!state.dirty || !state.name || saving) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const { name, dirty } = useMapStore.getState()
      if (!name || !dirty) return
      saving = true
      void saveMapAs(link, name).finally(() => {
        saving = false
      })
    }, delayMs)
  })

  return () => {
    if (timer) clearTimeout(timer)
    unsub()
  }
}
