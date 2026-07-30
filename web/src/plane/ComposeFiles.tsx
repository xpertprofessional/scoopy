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
import { useState } from 'react'

import type { EngineLink } from '../engineLink.ts'
import { FileBrowserPanel } from '../panels/FileBrowserPanel.tsx'

/** The drawer with its own open state — what a compose surface mounts. */
export function ComposeFiles({ link }: { link: EngineLink | null }) {
  const [open, setOpen] = useState(false)
  return <ComposeFilesDrawer link={link} open={open} onToggle={() => setOpen((v) => !v)} />
}

/**
 * The drawer itself, state held by the caller — so the open and closed shapes
 * are both testable without a DOM (this project has no jsdom; P6-2b's rule is
 * to pin the decision, and here the decision IS which door renders).
 */
export function ComposeFilesDrawer({
  link,
  open,
  onToggle,
}: {
  link: EngineLink | null
  open: boolean
  onToggle: () => void
}) {
  return (
    <aside className={open ? 'compose-files open' : 'compose-files'} aria-label="sample browser">
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
        <div className="compose-files-body">
          <FileBrowserPanel link={link} />
        </div>
      )}
    </aside>
  )
}
