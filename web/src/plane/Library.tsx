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
 */
import { useRef, useState } from 'react'
import type { SessionSummary } from '../store/sessionStore.ts'
import {
  createSession,
  deleteSession,
  importSessionFile,
  isSessionFile,
  renameSession,
} from '../store/sessionStore.ts'

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

  // Every verb funnels one way: do → refresh → tell the note line on failure.
  // The note line is the plane's ONE error surface (the 502b/P3-U6 lesson) —
  // a library that only console.errors is a library that silently fails.
  const run = (label: string, op: () => Promise<unknown>) => {
    void op()
      .then(() => refresh())
      .catch((err: unknown) => onNote(`${label} failed — ${(err as Error).message}`))
  }

  return (
    <div className="plane-library" data-no-drag>
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
          title="import a .scoopySession package (or its .zip) into the library"
        >
          import
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".scoopySession,.zip"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            if (!isSessionFile(file)) {
              onNote(`import refused — ${file.name} is not a .scoopySession`)
              return
            }
            run('import', async () => {
              const s = await importSessionFile(file)
              onNote(`imported ${s.name}`)
            })
          }}
        />
      </div>
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
