/**
 * P3.5-E8b — THE FILE BROWSER'S HOME: a drawer in the compose surfaces.
 *
 * `FileBrowserPanel` was built and ROUTED (`App.tsx:177`) and reachable from
 * nowhere: `filebrowser` is not in `PANEL_MENU_SURFACES`, and the only surface
 * that ever mounted it is `CompanionPanel`, the browser-only shell whose door
 * P3-L1 deleted. So the one door that browses a FOLDER of samples — as opposed
 * to P3.5-E8a's LOAD, which picks one file at a time — had no door of its own.
 *
 * WHY A DRAWER, AND WHY HERE. Compose is where a person reaches for a sample,
 * so the browser lives beside the grid it loads into. It is deliberately NOT a
 * `≡ panels` entry: P11-1 retires that menu, and a door that never lived there
 * cannot be orphaned when it goes.
 *
 * ONE implementation for BOTH compose surfaces — the separate compose WINDOW
 * (`ComposeWindow`) and the in-window overlay (`Composer`) — because P3.5-E8a's
 * root cause was three hand-written copies of a registration and one surface
 * that quietly shipped without it.
 *
 * THE TAB IS ALWAYS VISIBLE, and that is the point rather than a style choice:
 * a drawer whose handle only appears when it is already open is the same
 * unreachable feature this row is about. Closed is the default because the grid
 * needs the width; the tab is the door.
 */
import { useRef } from 'react'

import type { EngineLink } from '../engineLink.ts'
import { FileBrowserPanel } from '../panels/FileBrowserPanel.tsx'
import { asBoolean, asNumber, useSetting } from '../useSetting.ts'

/**
 * P3.5-E8e — THE DRAWER REMEMBERS.
 *
 * ⚠️ TWO KEYS OF ITS OWN, and the row records why that matters more than it
 * looks: `fileBrowserFolded` (`store/fileBrowserBackend.ts:34`) already exists
 * and is NOT this. That one folds the NATIVE browser frame; reusing it would
 * couple two different things that merely both mean "narrow", and the ledger
 * flagged the mistake before anyone made it. The donor keeps its own key for
 * the same reason — `@AppStorage("fileBrowser.expanded")`, `ContentView.swift:150`.
 */
const OPEN_KEY = 'fileBrowser.expanded'
const WIDTH_KEY = 'fileBrowser.width'

/** Donor width, and the bounds a drag is held inside. 280 is
 *  `ContentView.swift:150`'s open width; the floor is where the browser's own
 *  columns stop being readable, and the ceiling keeps the GRID the larger half
 *  of a compose surface — which is the whole reason the drawer is a drawer. */
export const FILES_WIDTH = { def: 280, min: 180, max: 560 } as const

/** Pure, and exported for its test: this project has no jsdom, so the DECISION
 *  a drag makes is what can be pinned, not the dragging. */
export const clampFilesWidth = (px: number): number =>
  Math.round(Math.min(FILES_WIDTH.max, Math.max(FILES_WIDTH.min, px)))

/** The drawer with its own persisted state — what a compose surface mounts. */
export function ComposeFiles({ link }: { link: EngineLink | null }) {
  const [open, setOpen] = useSetting(link, OPEN_KEY, false, asBoolean)
  const [width, setWidth] = useSetting(link, WIDTH_KEY, FILES_WIDTH.def, asNumber)
  return (
    <ComposeFilesDrawer
      link={link}
      open={open}
      width={clampFilesWidth(width)}
      onToggle={() => setOpen(!open)}
      onWidth={setWidth}
    />
  )
}

/**
 * The drawer itself, state held by the caller — so the open and closed shapes
 * are both testable without a DOM (this project has no jsdom; P6-2b's rule is
 * to pin the decision, and here the decision IS which door renders).
 */
export function ComposeFilesDrawer({
  link,
  open,
  width = FILES_WIDTH.def,
  onToggle,
  onWidth,
}: {
  link: EngineLink | null
  open: boolean
  width?: number
  onToggle: () => void
  onWidth?: (px: number) => void
}) {
  /** Where the pointer went down, and how wide the body was then. A drag is
   *  measured from its own start rather than from the live width — reading the
   *  element mid-drag would compound rounding on every move. */
  const drag = useRef<{ x: number; w: number } | null>(null)

  /**
   * ⚠️ WINDOW LISTENERS, NOT `setPointerCapture`, and that is a measured choice
   * rather than a stylistic one. Capture retargets moves to the grip — which
   * also means the grip must survive every re-render of the drag, and each
   * `onWidth` re-renders it. Under WebKit the first move after that landed
   * nowhere and the drawer never resized (the walk caught it: "width 280"). The
   * listeners below are bound to `window` for the life of the gesture, so
   * nothing about re-rendering can interrupt it.
   */
  const onGripDown = (e: React.PointerEvent) => {
    if (!onWidth) return
    drag.current = { x: e.clientX, w: width }
    e.preventDefault()
    // The drawer is on the RIGHT, so dragging its grip LEFT makes it wider.
    const move = (ev: PointerEvent) => {
      const d = drag.current
      if (d) onWidth(clampFilesWidth(d.w + (d.x - ev.clientX)))
    }
    const up = () => {
      drag.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <aside className={open ? 'compose-files open' : 'compose-files'} aria-label="sample browser">
      {/* The grip exists only while the drawer is open — closed, there is no
          width to set, and a handle for a dimension nothing is showing is the
          "control that reaches nothing" DESIGN.md §7 forbids. */}
      {open && onWidth && (
        <div
          className="compose-files-grip"
          role="separator"
          aria-orientation="vertical"
          aria-label="resize the sample browser"
          onPointerDown={onGripDown}
          onDoubleClick={() => onWidth(FILES_WIDTH.def)}
          title="Drag to resize · double-click to reset"
        />
      )}
      <button
        type="button"
        className="compose-files-tab mono"
        aria-expanded={open}
        onClick={onToggle}
        title={
          open
            ? 'Hide the sample browser'
            : 'Sample browser — choose a folder of samples, then drag one onto a track'
        }
      >
        {open ? 'FILES ›' : '‹ FILES'}
      </button>
      {/* Mounted only while open: the panel subscribes to the `fileBrowser`
          topic and decodes peaks for the selection, and a hidden browser paying
          for that is a cost with nothing on screen to show for it. */}
      {open && (
        <div className="compose-files-body" style={{ width: `${width}px` }}>
          <FileBrowserPanel link={link} />
        </div>
      )}
    </aside>
  )
}
