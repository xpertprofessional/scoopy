/**
 * P3-L1 — THE SESSION LIBRARY, ON THE PLANE.
 *
 * The `sessions ⇱` door used to open the COMPANION PANEL in a second window,
 * because that panel was the only surface that could create or import a
 * session. The user's decree (D-SL-MORPH-01): the companion is the BROWSER's
 * shell — a web bonus, never app-internal. So the library's verbs live here
 * now, as a popover on the plane's own bar: list · New · import · rename ·
 * delete, all against `sessionStore` (which is `slFiles`-routed native disk in
 * the merged host and OPFS in the browser — this component cannot tell and
 * must not care).
 *
 * LOADING is deliberately NOT here: a session loads INTO A STRIP, and the
 * strip menu owns that gesture. The library manages the shelf, not the decks.
 *
 * A session loaded in a deck refuses rename/delete: the autosaver holds the
 * open WorkingSession BY NAME, so renaming under it would quietly re-create
 * the old directory on the next autosave, and deleting would leave a deck
 * playing a ghost. "Unload it from the strip first" is the honest state.
 *
 * P3.5-E7 — THE IMPORT HAS THREE DOORS, and it must keep all three. The
 * desktop's `.scoopySession` is a DIRECTORY: a plain file input cannot select
 * one (picking it fires no event at all, so the button reads as broken), and a
 * `webkitdirectory` input cannot select the zipped form. Drop takes both. This
 * row exists because P3-L1 rebuilt this library with only the first of the
 * three and the folder a user actually has became un-importable. The reading is
 * one implementation for all three — `persist/folderImport.ts` → the one
 * package reader.
 */
import { useRef, useState } from 'react'
import type { SessionSummary } from '../store/sessionStore.ts'
import {
  createSession,
  deleteSession,
  importSessionEntries,
  importSessionFile,
  isSessionFile,
  renameSession,
} from '../store/sessionStore.ts'
import {
  entriesFromDirectoryInput,
  readDrop,
  walkDroppedDir,
} from '../persist/folderImport.ts'

/** Which deck holds this session open, or -1 — the rename/delete gate. */
export function loadedDeckOf(
  decks: ReadonlyArray<{ session: { name: string } | null }>,
  name: string,
): number {
  return decks.findIndex((d) => d.session?.name === name)
}

export function Library({
  sessions,
  decks,
  refresh,
  onNote,
}: {
  /** Props, not store reads — the house SSR-test rule (Strip/Master): the
      component states what exists; the PANEL owns the subscriptions. */
  sessions: SessionSummary[]
  decks: ReadonlyArray<{ session: { name: string } | null }>
  refresh: () => Promise<void>
  onNote: (note: string) => void
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const dirRef = useRef<HTMLInputElement>(null)
  const [dropArmed, setDropArmed] = useState(false)

  // Every verb funnels one way: do → refresh → tell the note line on failure.
  // The note line is the plane's ONE error surface (the 502b/P3-U6 lesson) —
  // a library that only console.errors is a library that silently fails.
  const run = (label: string, op: () => Promise<unknown>) => {
    void op()
      .then(() => refresh())
      .catch((err: unknown) => onNote(`${label} failed — ${(err as Error).message}`))
  }

  /** The zipped form, from either the picker or a drop. */
  const takeFile = (file: File) => {
    if (!isSessionFile(file)) {
      onNote(`import refused — ${file.name} is not a .scoopySession`)
      return
    }
    run('import', async () => {
      const s = await importSessionFile(file)
      onNote(`imported ${s.name}`)
    })
  }

  /** The folder form — the shape the desktop actually writes. */
  const takeEntries = (dirName: string, entries: Map<string, Uint8Array>) => {
    if (entries.size === 0) {
      onNote(`import refused — ${dirName} is empty`)
      return
    }
    run('import', async () => {
      const s = await importSessionEntries(dirName, entries)
      onNote(`imported ${s.name}`)
    })
  }

  return (
    <div
      className={`plane-library${dropArmed ? ' drop' : ''}`}
      data-no-drag
      // The third door. It is the only one that takes BOTH forms, so it is also
      // the fallback wherever a host's pickers disappoint (WKWebView is exactly
      // that risk — this row exists because a folder could not be imported).
      onDragOver={(e) => {
        e.preventDefault()
        setDropArmed(true)
      }}
      onDragLeave={() => setDropArmed(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropArmed(false)
        const drop = readDrop(e.dataTransfer)
        if (drop.kind === 'directory') {
          run('import', async () => {
            const s = await importSessionEntries(
              drop.entry.name,
              await walkDroppedDir(drop.entry),
            )
            onNote(`imported ${s.name}`)
          })
          return
        }
        if (drop.kind === 'file') takeFile(drop.file)
        else onNote('import refused — nothing readable in that drop')
      }}
    >
      <div className="plane-library-actions">
        <button
          type="button"
          onClick={() =>
            run('new session', async () => {
              const { name } = await createSession()
              onNote(`created ${name} — load it into a strip via the strip’s ⋯ menu`)
            })
          }
          title="a fresh session on disk — load it into a strip when you want it playing"
        >
          New
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          title="import a zipped .scoopySession (or .zip) — for a session FOLDER use folder…"
        >
          import
        </button>
        <button
          type="button"
          onClick={() => dirRef.current?.click()}
          title="import a .scoopySession FOLDER — the form the desktop writes on disk"
        >
          folder…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".scoopySession,.zip"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = '' // so importing the same file twice still fires
            if (file) takeFile(file)
          }}
        />
        <input
          ref={dirRef}
          type="file"
          /* Non-standard but universal (Chrome/Safari/Firefox honour it), and
             the ONLY attribute that makes a picker take a directory. React has
             no typing for it. */
          // @ts-expect-error see above
          webkitdirectory=""
          hidden
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            e.target.value = ''
            if (files.length === 0) return
            void entriesFromDirectoryInput(files).then(({ dirName, entries }) =>
              takeEntries(dirName, entries),
            )
          }}
        />
      </div>
      <div className="plane-library-hint">or drop a .scoopySession here</div>
      {sessions.length === 0 && (
        <div className="plane-library-empty">no sessions yet — New creates one</div>
      )}
      {sessions.map((s) => {
        const deck = loadedDeckOf(decks, s.name)
        const loaded = deck >= 0
        const lockTitle = `loaded in a strip (deck ${deck + 1}) — unload it there first`
        return (
          <div key={s.name} className="plane-library-row">
            {renaming === s.name ? (
              <input
                className="plane-library-rename mono"
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setRenaming(null)
                  if (e.key === 'Enter') {
                    setRenaming(null)
                    run('rename', () => renameSession(s.name, draft))
                  }
                }}
                onBlur={() => setRenaming(null)}
              />
            ) : (
              <span className="plane-library-name mono" title={s.name}>
                {s.name}
                {loaded && <span className="plane-library-loaded"> · deck {deck + 1}</span>}
              </span>
            )}
            <button
              type="button"
              className="plane-library-verb"
              disabled={loaded}
              title={loaded ? lockTitle : 'rename'}
              onClick={() => {
                setConfirming(null)
                setDraft(s.name)
                setRenaming(s.name)
              }}
            >
              ✎
            </button>
            <button
              type="button"
              className={`plane-library-verb${confirming === s.name ? ' arm' : ''}`}
              disabled={loaded}
              // Two clicks, on purpose: the store's remove is trash-first, but a
              // one-click kill beside a rename pencil is a misclick away.
              title={
                loaded ? lockTitle : confirming === s.name ? 'click again to delete' : 'delete'
              }
              onClick={() => {
                if (confirming !== s.name) {
                  setConfirming(s.name)
                  return
                }
                setConfirming(null)
                run('delete', async () => {
                  await deleteSession(s.name)
                  onNote(`deleted ${s.name}`)
                })
              }}
            >
              {confirming === s.name ? 'sure?' : '✕'}
            </button>
          </div>
        )
      })}
    </div>
  )
}
