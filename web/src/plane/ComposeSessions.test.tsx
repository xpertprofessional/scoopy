/**
 * THE COMPOSE WINDOW'S SESSION VERBS (B5 · P7-L1).
 *
 * The property that matters is not that a menu renders — it is that a compose
 * window opened with NO PLANE AND NO MAP is still a place you can work. That is
 * D-SL-LAUNCH-01's mapless path, and a session section that only made sense
 * beside the plane's library would make it a dead end at "how do I open
 * anything".
 *
 * `sessionMenuItems` is pure for the same reason `launchMenuItems` and
 * `inputDeviceMenuItems` are: the menu is built inside an event handler and
 * rendered through a portal, so the built section is the only assertable thing.
 */
import { describe, expect, it, vi } from 'vitest'

import { sessionMenuItems } from './ComposeSessions.tsx'
import type { MenuItem } from '../design/ContextMenu.tsx'
import type { SessionSummary } from '../store/sessionStore.ts'

const on = () => ({
  create: vi.fn(),
  open: vi.fn(),
  save: vi.fn(),
  rename: vi.fn(),
  exportZip: vi.fn(),
})

const sessions = (...names: string[]): SessionSummary[] =>
  names.map((name) => ({ name, modifiedMs: 0 })) as SessionSummary[]

/** `MenuItem` is a union and `sep` carries no label — narrow rather than cast,
    so a future member without a label is a compile error here, not a crash. */
type Labelled = Extract<MenuItem, { label: string }>
const labelled = (items: MenuItem[]): Labelled[] =>
  items.filter((i): i is Labelled => 'label' in i)
const labels = (items: MenuItem[]) =>
  labelled(items).filter((i) => i.kind === 'item').map((i) => i.label)

describe('the session menu', () => {
  it('offers NEW even with nothing in the library — the mapless path starts here', () => {
    // On the boot chooser's COMPOSE path this window may be the only thing
    // running. If `new` were gated on an existing session there would be no way
    // to make the first one.
    const items = sessionMenuItems([], null, on())
    expect(labels(items)).toContain('new')
  })

  it('SAYS the library is empty rather than rendering nothing', () => {
    // A section that vanishes teaches nothing, and the plane's library — the
    // other place that would explain it — may not exist on this path.
    const items = sessionMenuItems([], null, on())
    expect(labelled(items).some((i) => i.label.includes('none yet'))).toBe(true)
  })

  it('disables save/rename/export with no session open, instead of hiding them', () => {
    // L2's rule applied to a menu: a verb that is meaningless right now is
    // disabled and still visible, so the shape of the surface does not change.
    const items = sessionMenuItems([], null, on())
    const byLabel = (l: string) =>
      labelled(items).find((i) => i.kind === 'item' && i.label.startsWith(l)) as {
        disabled?: boolean
      }
    expect(byLabel('save').disabled).toBe(true)
    expect(byLabel('rename').disabled).toBe(true)
    expect(byLabel('export').disabled).toBe(true)
  })

  it('names ⌘S on the save row', () => {
    // A verb whose shortcut is invisible is one nobody learns — and D-SL-SAVE-01
    // makes ⌘S mean the same thing here as on the plane, which only pays off if
    // it is discoverable in both places.
    const items = sessionMenuItems(sessions('beach'), 'beach', on())
    expect(labels(items).some((l) => l.includes('⌘S'))).toBe(true)
  })

  it('lists every session and checks the open one', () => {
    const items = sessionMenuItems(sessions('beach', 'forest'), 'forest', on())
    expect(labels(items)).toEqual(expect.arrayContaining(['beach', 'forest']))
    const forest = labelled(items).find((i) => i.label === 'forest') as { checked?: boolean }
    expect(forest.checked).toBe(true)
  })

  it('routes each verb to its own action', () => {
    const acts = on()
    const items = sessionMenuItems(sessions('beach'), 'beach', acts)
    const run = (l: string) =>
      (
        labelled(items).find((i) => i.kind === 'item' && i.label.startsWith(l)) as {
          onSelect: () => void
        }
      ).onSelect()
    run('new')
    run('save')
    run('rename')
    run('export')
    expect(acts.create).toHaveBeenCalled()
    expect(acts.save).toHaveBeenCalled()
    expect(acts.rename).toHaveBeenCalled()
    expect(acts.exportZip).toHaveBeenCalled()
    ;(labelled(items).find((i) => i.label === 'beach') as { onSelect: () => void }).onSelect()
    expect(acts.open).toHaveBeenCalledWith('beach')
  })
})
