/**
 * P3.5-E8b — THE FILE BROWSER HAS A HOME, AND THE HOME HAS A VISIBLE DOOR.
 *
 * The defect these pin is reachability, not behaviour: `FileBrowserPanel` was
 * built, routed at `App.tsx:177`, and mounted by exactly one surface —
 * `CompanionPanel`, whose door P3-L1 deleted. `filebrowser` is deliberately NOT
 * added to `PANEL_MENU_SURFACES` (P11-1 retires that menu; a door that never
 * lived there cannot be orphaned when it goes), so the drawer is the home and
 * its tab is the door.
 *
 * No jsdom in this project (P6-2b's house rule), so what is pinned is what the
 * markup CONTAINS — which is exactly the claim being made: that both compose
 * surfaces render a browser door, and that the door is there before the drawer
 * is opened.
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ComposeFiles,
  ComposeFilesDrawer,
  FILES_WIDTH,
  clampFilesWidth,
} from './ComposeFiles.tsx'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p: string) => readFileSync(resolve(here, p), 'utf8')

describe('the FILES drawer', () => {
  it('shows its tab while CLOSED — the door exists before anything is opened', () => {
    const html = renderToStaticMarkup(
      <ComposeFilesDrawer link={null} open={false} onToggle={() => {}} />,
    )
    expect(html).toContain('compose-files-tab')
    expect(html).toContain('FILES')
    // …and the browser itself is not mounted yet: it subscribes to a topic and
    // decodes peaks, which is a cost with nothing on screen to show for it.
    expect(html).not.toContain('fb-root')
  })

  it('mounts the real FileBrowserPanel when OPEN', () => {
    const html = renderToStaticMarkup(
      <ComposeFilesDrawer link={null} open onToggle={() => {}} />,
    )
    expect(html).toContain('fb-root')
    expect(html).toContain('aria-expanded="true"')
  })

  it('defaults to closed — the grid keeps the width until asked', () => {
    expect(renderToStaticMarkup(<ComposeFiles link={null} />)).not.toContain('fb-root')
  })
})

describe('BOTH compose surfaces carry it — one browser, no drifted copy', () => {
  // P3.5-E8a's root cause was three hand-written copies of one registration and
  // a fourth surface that quietly shipped without it. The compose WINDOW is the
  // merged host's composer and the overlay is the browser host's; a drawer in
  // only one of them is that failure repeating.
  it.each([['ComposeWindow.tsx'], ['Composer.tsx']])('%s mounts <ComposeFiles>', (file) => {
    const src = read(`./${file}`)
    expect(src).toContain("from './ComposeFiles.tsx'")
    expect(src).toContain('<ComposeFiles link={link} />')
    // The grid moved into its own scrolling column so the drawer does not
    // scroll away with it.
    expect(src).toContain('compose-grid-pane')
  })
})

describe('the home is the drawer, NOT the panels menu', () => {
  it('leaves `filebrowser` out of PANEL_MENU_SURFACES', () => {
    // Ruled once across E8b and P11-1: P11-1 retires `≡ panels`, and a door
    // added there would have to be moved again the moment it does.
    expect(read('./PlanePanel.tsx')).not.toContain("'filebrowser'")
  })
})

describe('P3.5-E8e — the drawer remembers, and can be resized', () => {
  it('clamps a drag to bounds and lands on whole pixels', () => {
    // Pure, so the DECISION a drag makes is pinned even though nothing here can
    // drag (no jsdom). The bounds are the reason the control is safe to ship:
    // below the floor the browser's columns stop being readable, above the
    // ceiling the drawer stops being a drawer and starts being the view.
    expect(clampFilesWidth(FILES_WIDTH.min - 200)).toBe(FILES_WIDTH.min)
    expect(clampFilesWidth(FILES_WIDTH.max + 200)).toBe(FILES_WIDTH.max)
    expect(clampFilesWidth(301.6)).toBe(302)
    expect(clampFilesWidth(FILES_WIDTH.def)).toBe(FILES_WIDTH.def)
  })

  it('renders the body at the width it was given', () => {
    const html = renderToStaticMarkup(
      <ComposeFilesDrawer link={null} open width={340} onToggle={() => {}} onWidth={() => {}} />,
    )
    expect(html).toContain('width:340px')
  })

  it('draws the grip only when there is a width to set (§7)', () => {
    const open = renderToStaticMarkup(
      <ComposeFilesDrawer link={null} open width={280} onToggle={() => {}} onWidth={() => {}} />,
    )
    expect(open).toContain('compose-files-grip')
    // CLOSED there is no body to size, and no `onWidth` means the caller holds
    // no width at all — a handle in either case would move nothing.
    const closed = renderToStaticMarkup(
      <ComposeFilesDrawer link={null} open={false} onToggle={() => {}} onWidth={() => {}} />,
    )
    expect(closed).not.toContain('compose-files-grip')
    const readOnly = renderToStaticMarkup(
      <ComposeFilesDrawer link={null} open width={280} onToggle={() => {}} />,
    )
    expect(readOnly).not.toContain('compose-files-grip')
  })

  it('keeps its own keys and never reuses the native fold key', () => {
    // The ledger row recorded this trap BEFORE anyone fell into it:
    // `fileBrowserFolded` (store/fileBrowserBackend.ts) folds the NATIVE browser
    // frame. It merely also means "narrow". Sharing it would couple two
    // different things and make each one's bug look like the other's.
    // Comments stripped: the file's own header NAMES the forbidden key in
    // order to warn about it, so a whole-file match fails on prose that is
    // doing the right thing. `studio/Transport.test.ts` needed the same
    // distinction for the same reason — a third use should extract it.
    const code = read('./ComposeFiles.tsx')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    expect(code).toContain("'fileBrowser.expanded'")
    expect(code).toContain("'fileBrowser.width'")
    expect(code).not.toContain('fileBrowserFolded')
    expect(code).not.toContain('SETTING_FOLDED')
  })
})
