/**
 * The `.scoopyMapPkg` — a map made SELF-CONTAINED for travel (merge P2, inc 6).
 *
 * A saved map REFERENCES its takes by path (the signed decision: sessions and
 * takes are referenced, not embedded, because a strip is a slot and copying
 * whole sessions is wasteful). That is right on the machine that recorded them
 * and useless anywhere else — the map opens, every strip says "audio missing",
 * and the set is gone.
 *
 * COLLECT-ON-EXPORT is the deliberate step that closes that: packing copies
 * every referenced take in beside the document and REWRITES the refs to point
 * inside the package. Unpacking is the mirror. Portability stays an explicit
 * act rather than a default, which is what keeps the everyday save cheap.
 *
 * STORED, NOT DEFLATED — the same call `sessionPackage.ts` makes, for the same
 * reasons, plus one of its own: takes are WAV, which deflate barely shrinks, so
 * compressing them would spend real time to save almost nothing.
 *
 * ⚠️ THIS MODULE IS THE FORMAT AND THE UNPACK PATH. It is NOT yet wired to an
 * export button, and that is a measured decision rather than an omission:
 *
 *   `packMap` takes a `read(ref)` callback, and the merged host has no way to
 *   hand take BYTES to the web layer — `slTakes` lists and deletes, and adding
 *   a read would mean base64 over the JSON bridge for files capped at 256 MB
 *   (~350 MB of string, per take). That would not be slow, it would be fatal.
 *
 * So EXPORT belongs in the shell, which already holds the files and has a zip
 * writer: `slMap/export` reading the map, collecting its takes and writing the
 * archive without a byte crossing the bridge. UNPACK stays here — a package
 * arrives as a dropped file, the web layer already has those bytes, and the
 * document layer must be the one to parse it so a package cannot become a way
 * around the version discipline (which the tests pin).
 *
 * Building a second zip WRITER in TS to work around the bridge would have been
 * the wrong fix twice over: a hand-mirrored format, and megabytes moved for no
 * reason.
 */
import { unzipSync, zipSync } from 'fflate'
import { loadMap, saveMap, type MapDocument, type PlaneMap } from './mapDocument.ts'

export const MAP_ENTRY = 'map.scoopyMap'
export const TAKES_DIR = 'Takes/'

export interface MapPackage {
  document: MapDocument
  /** Take file name → bytes. Keyed by NAME, not path: the whole point of
      packing is that the original paths stop being meaningful. */
  takes: Map<string, Uint8Array>
}

/** The file name a take ref collapses to inside a package. */
export function takeEntryName(ref: string): string {
  return ref.split('/').pop() ?? ref
}

/**
 * THE EXPORT PLAN — everything a packer needs, WITHOUT any audio.
 *
 * This is what makes native export possible while keeping wizard's law intact.
 * The shell cannot collect takes without knowing which ones the map references,
 * and knowing that means parsing the document — which the shell must never do
 * (the format has exactly one home, and a second parser in C++ is the
 * hand-mirror the law forbids).
 *
 * So the split is: TS decides WHAT (the rewritten document, and the list of
 * files by path), the shell moves BYTES (copies those files, writes the zip).
 * Neither side learns the other's job, and no audio crosses the bridge.
 */
export type PackagePlan = {
  /** The document with its refs already rewritten to point inside the package.
      Rewritten HERE because it is a document edit, and the shell does not edit
      documents. */
  json: string
  /** Absolute paths the shell should collect, and the entry name each becomes.
      Names are resolved here too, so the shell never has to decide anything. */
  takes: Array<{ path: string; entry: string }>
}

export function planPackage(map: PlaneMap, app = 'scoopy'): PackagePlan {
  const refs = referencedTakes(map)
  const rewritten: PlaneMap = {
    ...map,
    strips: map.strips.map((s) =>
      s.element.kind === 'tape' && s.element.takeRef !== null
        ? { ...s, element: { ...s.element, takeRef: TAKES_DIR + takeEntryName(s.element.takeRef) } }
        : s,
    ),
  }
  return {
    json: JSON.stringify(saveMap(rewritten, app)),
    takes: refs.map((path) => ({ path, entry: TAKES_DIR + takeEntryName(path) })),
  }
}

export type PackResult =
  | { ok: true; bytes: Uint8Array; collected: number; missing: string[] }
  | { ok: false; reason: string }

/**
 * Pack a map with its audio.
 *
 * A take the host could not read is REPORTED, never silently omitted: a package
 * that is quietly short one file is a package that fails on the other machine,
 * at the worst moment, with no way to know what went missing. The pack still
 * succeeds — an incomplete package is more useful than none, and the strip will
 * say "audio missing" honestly — but the caller is told exactly which.
 */
export function packMap(
  map: PlaneMap,
  read: (ref: string) => Uint8Array | null,
  app = 'scoopy',
): PackResult {
  const refs = referencedTakes(map)
  const takes = new Map<string, Uint8Array>()
  const missing: string[] = []

  for (const ref of refs) {
    const bytes = read(ref)
    if (bytes === null) {
      missing.push(ref)
      continue
    }
    takes.set(takeEntryName(ref), bytes)
  }

  // REWRITE THE REFS to point inside the package. Without this the document
  // still names the old absolute paths and the collected audio is dead weight —
  // the package would be bigger AND still broken, which is the worst of both.
  const rewritten: PlaneMap = {
    ...map,
    strips: map.strips.map((s) =>
      s.element.kind === 'tape' && s.element.takeRef !== null
        ? { ...s, element: { ...s.element, takeRef: TAKES_DIR + takeEntryName(s.element.takeRef) } }
        : s,
    ),
  }

  const files: Record<string, Uint8Array> = {
    [MAP_ENTRY]: new TextEncoder().encode(JSON.stringify(saveMap(rewritten, app))),
  }
  for (const [name, bytes] of takes) files[TAKES_DIR + name] = bytes

  return {
    ok: true,
    bytes: zipSync(files, { level: 0 }),
    collected: takes.size,
    missing,
  }
}

export type UnpackResult =
  | { ok: true; map: PlaneMap; takes: Map<string, Uint8Array> }
  | { ok: false; reason: string }

/**
 * Unpack. The document is parsed by the DOCUMENT layer, so a package carrying a
 * newer map is refused exactly as a loose file would be — a package must not be
 * a way around the version discipline.
 */
export function unpackMap(zip: Uint8Array): UnpackResult {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zip)
  } catch {
    return { ok: false, reason: 'that file is not a package' }
  }

  // A package zipped by Finder arrives inside a single folder, and with a
  // `__MACOSX/` tree beside it. Tolerating both is what makes the one workflow
  // a user without the export button actually has — zip the folder, mail it —
  // keep working. Same reasoning as sessionPackage.
  const files = stripCommonRoot(entries)
  const doc = files.get(MAP_ENTRY)
  if (!doc) return { ok: false, reason: `no ${MAP_ENTRY} in the package` }

  let parsed
  try {
    parsed = loadMap(JSON.parse(new TextDecoder().decode(doc)))
  } catch {
    return { ok: false, reason: 'the package contains a damaged map' }
  }
  if (!parsed.ok) return { ok: false, reason: parsed.message }

  const takes = new Map<string, Uint8Array>()
  for (const [name, bytes] of files)
    if (name.startsWith(TAKES_DIR)) takes.set(name.slice(TAKES_DIR.length), bytes)

  return { ok: true, map: parsed.map, takes }
}

/** Every take the map references, de-duplicated — one take underlies a
    scrubbable tape AND any grid track carved from it, so a naive walk would
    collect the same file twice. */
export function referencedTakes(map: PlaneMap): string[] {
  const refs = new Set<string>()
  for (const s of map.strips)
    if (s.element.kind === 'tape' && s.element.takeRef !== null) refs.add(s.element.takeRef)
  return [...refs]
}

/** Normalise separators, drop `__MACOSX`, and strip one wrapping folder if
    every entry shares it. */
function stripCommonRoot(entries: Record<string, Uint8Array>): Map<string, Uint8Array> {
  const cleaned = new Map<string, Uint8Array>()
  for (const [rawName, bytes] of Object.entries(entries)) {
    const name = rawName.replace(/\\/g, '/')
    if (name.startsWith('__MACOSX/') || name.endsWith('/.DS_Store')) continue
    if (name.endsWith('/')) continue // directory entries carry no bytes
    cleaned.set(name, bytes)
  }

  const names = [...cleaned.keys()]
  if (names.length === 0) return cleaned
  const first = names[0]?.split('/')[0] ?? ''
  // Only strip when EVERY entry shares the folder — otherwise a package whose
  // takes happen to sit in a directory named like the map would lose its
  // document.
  if (!first || !names.every((n) => n.startsWith(first + '/'))) return cleaned

  const stripped = new Map<string, Uint8Array>()
  for (const [name, bytes] of cleaned) stripped.set(name.slice(first.length + 1), bytes)
  return stripped
}
