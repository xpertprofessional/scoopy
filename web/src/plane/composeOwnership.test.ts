/**
 * P3-C2 — the ownership handoff on `slPanelClosed`.
 *
 * The property that matters: ONLY a compose window's close releases a deck and
 * reloads from disk, and a garbage address releases NOTHING — reloading the
 * wrong deck would be worse than leaving the lock standing.
 */
import { describe, expect, it, vi } from 'vitest'
import { encodeComposeArg } from './composeArg.ts'
import { handlePanelClosed } from './composeOwnership.ts'

const deps = () => ({ release: vi.fn(), reopen: vi.fn(), note: vi.fn() })

describe('handlePanelClosed', () => {
  it('releases the deck and reopens the session from disk, in that order', () => {
    const d = deps()
    handlePanelClosed(
      { panel: 'compose', arg: encodeComposeArg({ deck: 1, session: 'Beach' }) },
      d,
    )
    expect(d.release).toHaveBeenCalledWith(1)
    expect(d.reopen).toHaveBeenCalledWith('Beach', 1)
    expect(d.release.mock.invocationCallOrder[0]!).toBeLessThan(
      d.reopen.mock.invocationCallOrder[0]!,
    )
    expect(d.note).toHaveBeenCalledOnce()
  })

  it('ignores every other window — closing the MIDI panel must not touch a deck', () => {
    const d = deps()
    handlePanelClosed({ panel: 'midi', arg: '' }, d)
    handlePanelClosed({ panel: 'companion' }, d)
    expect(d.release).not.toHaveBeenCalled()
    expect(d.reopen).not.toHaveBeenCalled()
  })

  it('refuses a compose close with a garbage address rather than guessing a deck', () => {
    const d = deps()
    handlePanelClosed({ panel: 'compose', arg: 'not-an-address' }, d)
    handlePanelClosed({ panel: 'compose' }, d)
    handlePanelClosed(null, d)
    expect(d.release).not.toHaveBeenCalled()
    expect(d.reopen).not.toHaveBeenCalled()
    expect(d.note).not.toHaveBeenCalled()
  })
})
