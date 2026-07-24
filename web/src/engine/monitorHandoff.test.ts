/**
 * The Law C-3 handoff must hand the strip BACK (D-WZ-MON-02).
 *
 * This is the regression test for the bug that made playback look completely
 * dead: arming a take sets `monitorSwitch` (D-WZ-MON-01, so you hear what you
 * are recording), and nothing ever set it back. `publishPatch` routes a strip to
 * its deck only when `material && !monitorSwitch`, so every strip that had ever
 * recorded published as its INPUT forever. The engine looped the take exactly as
 * Law C-3 promises — into a channel nobody was listening to — so ⟳ appeared to
 * do nothing at all. It survived relaunches too, because the stuck switch is a
 * persisted document field.
 *
 * The published WORLD is what these assert, not the document: the document is
 * meant to keep remembering what the strip records from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineLink } from './engineLink'
import { publishPatch } from './usePatch'
import { useAppStore } from '../store/appStore'

type Published = { patch: { channels: Array<{ source: { kind: string; id: string } }> } }

function fakeLink() {
  const published: Published[] = []
  const link = {
    command: vi.fn(async (method: string, params: unknown) => {
      if (method === 'publishWorld') published.push(params as Published)
      return { ok: true } as never
    }),
    paramWrite: vi.fn(),
    onHotFrame: () => () => {},
    onDeckLoad: () => () => {},
  } as unknown as EngineLink
  return { link, published }
}

const lastSources = (p: Published[]) =>
  (p[p.length - 1]?.patch.channels ?? []).map((c) => c.source.kind)

describe('material vs monitoring at publish time', () => {
  beforeEach(() => {
    useAppStore.setState({ patch: { ...useAppStore.getState().patch, channels: [], decks: [] } })
  })

  it('routes a strip to its deck once it holds material', () => {
    const { link, published } = fakeLink()
    const s = useAppStore.getState()
    s.addChannel('Mic', { kind: 'deviceInput', id: '0', name: 'In 1' })
    s.attachDeck(0)
    publishPatch(link, useAppStore.getState().patch)
    expect(lastSources(published)).toEqual(['deck'])
  })

  it('publishes the INPUT while the monitor switch is open', () => {
    const { link, published } = fakeLink()
    const s = useAppStore.getState()
    s.addChannel('Mic', { kind: 'deviceInput', id: '0', name: 'In 1' })
    s.attachDeck(0)
    s.setChannelParam(0, 'monitorSwitch', true) // what arming does
    publishPatch(link, useAppStore.getState().patch)
    expect(lastSources(published)).toEqual(['deviceInput'])
  })

  it('a strip left monitoring after a take never plays — so the handoff must close it', () => {
    const { link, published } = fakeLink()
    const s = useAppStore.getState()
    s.addChannel('Mic', { kind: 'deviceInput', id: '0', name: 'In 1' })
    s.attachDeck(0)
    s.setChannelParam(0, 'monitorSwitch', true)

    // THE BUG: republishing after the take, without closing the switch, leaves
    // the strip on its input. ⟳ then does nothing audible, forever.
    publishPatch(link, useAppStore.getState().patch)
    expect(lastSources(published)).toEqual(['deviceInput'])

    // THE FIX: the handoff closes monitoring (D-WZ-MON-02), and the strip plays.
    s.setChannelParam(0, 'monitorSwitch', false)
    publishPatch(link, useAppStore.getState().patch)
    expect(lastSources(published)).toEqual(['deck'])
    // The document still remembers what this strip records FROM — closing the
    // monitor must not cost provenance.
    expect(useAppStore.getState().patch.channels[0]!.source.kind).toBe('deviceInput')
  })
})
