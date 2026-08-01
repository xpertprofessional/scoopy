/**
 * THE COMPOSE WINDOW'S SESSION VERBS (B5 · P7-L1, D-SL-LAUNCH-01).
 *
 * New · open · save · rename · export, on the compose window's own bar — so a
 * compose window is a place you can WORK, not just a place you can edit
 * something the plane handed you.
 *
 * ⚠️ IT MUST WORK WITH NO PLANE AND NO MAP ALIVE. That is the whole point of
 * D-SL-LAUNCH-01's mapless COMPOSE path: the boot chooser can open this window
 * with nothing else in the app, so every verb here goes to `sessionStore` and
 * the companion, never through `mapStore`. A door that needed the plane's
 * library would make the mapless path a dead end at "how do I open anything".
 *
 * The verbs already existed — `sessionStore` owns save/open/create/rename/
 * delete/import/export and has since P3-SES-1. Autosave-only UI was the gap,
 * not the machinery, which is why this is a surface rather than a subsystem.
 *
 * A MENU, not a row of buttons: choosing from a list of sessions is not a
 * one-handed live gesture (pd-strip-anatomy §3.1, the same rule that puts the
 * strip's input picker and launch reference in menus). What stays on the bar is
 * the RESULT — the session's name, already there.
 */
import { useState } from 'react'

import { useContextMenu, type MenuItem } from '../design/ContextMenu.tsx'
import { flushAutosave, useCompanion } from '../store/companionEngine.ts'
import {
  createSession,
  exportSession,
  isSessionFile,
  listSessions,
  renameSession,
  type SessionSummary,
} from '../store/sessionStore.ts'

/**
 * The menu's rows, pure — exported for the same reason `launchMenuItems` and
 * `inputDeviceMenuItems` are: the menu is built inside an event handler and
 * rendered through a portal, so the built section is the only thing a test can
 * assert.
 */
export function sessionMenuItems(
  sessions: SessionSummary[],
  current: string | null,
  on: {
    create: () => void
    open: (name: string) => void
    save: () => void
    rename: () => void
    exportZip: () => void
    importFile: () => void
  },
): MenuItem[] {
  const items: MenuItem[] = [
    { kind: 'info', label: 'session' },
    { kind: 'item', label: 'new', onSelect: on.create },
    // IMPORT — the door the plugin had no way to reach (real-host report,
    // 2026-08-01: "we need to import session from hd"). The library is OPFS, so
    // without this a session that exists as a file on disk was simply
    // unreachable from inside a DAW; the plane had drag-and-drop, and a plugin
    // window is not somewhere you drop a Finder item.
    { kind: 'item', label: 'import…', onSelect: on.importFile },
    // SAVE IS ⌘S (D-SL-SAVE-01), and the row says so — a verb whose shortcut is
    // invisible is one people never learn.
    { kind: 'item', label: 'save  ⌘S', disabled: !current, onSelect: on.save },
    { kind: 'item', label: 'rename…', disabled: !current, onSelect: on.rename },
    { kind: 'item', label: 'export…', disabled: !current, onSelect: on.exportZip },
    { kind: 'sep' },
    { kind: 'info', label: 'open' },
  ]
  // ⚠️ THE EMPTY CASE IS RENDERED, not hidden. On the mapless boot path this
  // window may be the only thing running, so "there is nothing to open yet" has
  // to be readable HERE — a section that vanishes teaches nothing, and the
  // plane's library (the other place that would say it) may not exist.
  if (sessions.length === 0) {
    items.push({ kind: 'info', label: 'none yet — “new” makes one' })
  } else {
    for (const s of sessions) {
      items.push({
        kind: 'item',
        label: s.name,
        checked: s.name === current,
        onSelect: () => on.open(s.name),
      })
    }
  }
  return items
}

/**
 * Open the native file panel and resolve the chosen session package, or null if
 * the user cancelled.
 *
 * A detached `<input type="file">` rather than a native command: JUCE's
 * WKWebView implements `runOpenPanelWithParameters`, so this IS the platform
 * panel inside a DAW. Resolves on `cancel` too — without that, cancelling would
 * leave the promise (and the menu's `run` wrapper) hanging forever.
 */
function pickSessionFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.scoopySession,.zip'
    let settled = false
    const done = (f: File | null) => {
      if (settled) return
      settled = true
      resolve(f)
    }
    input.addEventListener('change', () => done(input.files?.[0] ?? null))
    // Safari/WKWebView fire `cancel` on dismissal; older engines fire nothing,
    // which is why `done` is idempotent rather than assuming exactly one event.
    input.addEventListener('cancel', () => done(null))
    input.click()
  })
}

/** The bar control. `deck` is the deck this window composes. */
export function ComposeSessions({ deck, onNote }: { deck: number; onNote: (n: string) => void }) {
  const { openMenu } = useContextMenu()
  const current = useCompanion((c) => c.decks[deck]?.session?.name ?? null)
  const [sessions, setSessions] = useState<SessionSummary[]>([])

  /** Every verb funnels one way: do → refresh → say so on failure. The compose
      window's note line is its ONE error surface, exactly as the plane's is. */
  const run = (label: string, op: () => Promise<unknown>) => {
    void op()
      .then(() => listSessions().then(setSessions))
      .catch((err: unknown) => onNote(`${label} failed — ${(err as Error).message}`))
  }

  const open = (e: React.MouseEvent) => {
    // Ask the disk as the menu opens: another window may have added a session
    // since this one booted, and a stale list is a door onto the wrong thing.
    void listSessions()
      .then((list) => {
        setSessions(list)
        openMenu(
          sessionMenuItems(list, current, {
            create: () =>
              run('new session', async () => {
                const s = await createSession()
                await useCompanion.getState().open(s.name, deck)
                onNote(`created ${s.name}`)
              }),
            open: (name) => run(`open ${name}`, () => useCompanion.getState().open(name, deck)),
            // SAVE IS A FLUSH. Edits autosave on a 1.5 s debounce, so "save"
            // means "land the pending write NOW" rather than "write something
            // that would otherwise be lost" — and saying that is what stops it
            // reading as though the session were unsaved until pressed.
            save: () =>
              run('save', async () => {
                await flushAutosave()
                onNote('saved')
              }),
            rename: () =>
              run('rename', async () => {
                if (!current) return
                const next = window.prompt('rename session', current)
                if (!next || next === current) return
                await renameSession(current, next)
                await useCompanion.getState().open(next, deck)
              }),
            // A real file picker. JUCE's WKWebView implements
            // `runOpenPanelWithParameters` (juce_WebBrowserComponent_mac.mm),
            // so a plain <input type=file> opens the native panel inside the
            // plugin — no new native command needed.
            importFile: () =>
              run('import', async () => {
                const file = await pickSessionFile()
                if (!file) return
                if (!isSessionFile(file)) {
                  onNote(`import failed — ${file.name} is not a session package`)
                  return
                }
                await useCompanion.getState().importFile(file)
                onNote(`imported ${file.name}`)
              }),
            exportZip: () =>

              run('export', async () => {
                const s = useCompanion.getState().decks[deck]?.session
                if (!s) return
                const { missing } = await exportSession(s)
                // A partial export is reported, never silent: a package missing
                // audio opens somewhere else as a session full of dead rows.
                onNote(missing.length ? `exported — ${missing.length} sample(s) missing` : 'exported')
              }),
          }),
          e.clientX,
          e.clientY,
        )
      })
      .catch((err: unknown) => onNote(`library unavailable — ${(err as Error).message}`))
  }

  return (
    <button type="button" className="compose-session-menu mono" onClick={open}>
      {'session ▾'}
    </button>
  )
}
