// P3-U6 — a refusal is news the USER gets, not just the console.
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { EngineLink } from '../engineLink.ts'
import { ask, onRefusal, resetSendReporting, send } from './send.ts'

const refusingLink = {
  command: () => Promise.reject(new Error('not implemented in the browser companion')),
} as unknown as EngineLink

afterEach(() => {
  resetSendReporting()
  vi.restoreAllMocks()
})

describe('refusal surfacing (P3-U6)', () => {
  it('notifies subscribers on EVERY refusal — the note line is idempotent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    const off = onRefusal((method, msg) => seen.push(`${method}:${msg}`))
    await ask(refusingLink, 'slTape', {})
    await ask(refusingLink, 'slTape', {})
    off()
    expect(seen).toEqual([
      'slTape:not implemented in the browser companion',
      'slTape:not implemented in the browser companion',
    ])
  })

  it('keeps the console damped to once per method — a drag must not log 600 times', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await ask(refusingLink, 'slChannel', {})
    await ask(refusingLink, 'slChannel', {})
    expect(err).toHaveBeenCalledTimes(1)
  })

  it('the fire-and-forget path reports through the same seam', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    const off = onRefusal((method) => seen.push(method))
    send(refusingLink, 'slRoute', {})
    await new Promise((r) => setTimeout(r, 0))
    off()
    expect(seen).toEqual(['slRoute'])
  })

  it('an unsubscribed listener hears nothing more', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    const off = onRefusal((method) => seen.push(method))
    off()
    await ask(refusingLink, 'slDeck', {})
    expect(seen).toEqual([])
  })
})
