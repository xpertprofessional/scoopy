import { expect, test } from 'vitest'
import { emptyPatch } from '../../protocol/schema'
import type { EngineLink } from '../engine/engineLink'
import { makeSession, serializeSession } from './session'
import { openPackage, savePackage, takePathsFor } from './packageIo'
import type { Patch } from '../../protocol/schema'

const NOW = '2026-07-24T05:00:00Z'

function deck(id: number, sourcePath: string) {
  return {
    id,
    name: `Deck ${id + 1}`,
    loopEnabled: true,
    loopStartSample: 0,
    loopEndSample: 0,
    rate: 1,
    sourcePath,
  }
}

/** A link with scripted replies; records every call for assertions. */
function link(replies: Record<string, unknown>, present: string[] = []) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const l = {
    command: (async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'deckLoadTake') return { ok: present.includes(params.path as string) }
      return replies[method] ?? { ok: false, error: '' }
    }) as unknown as EngineLink['command'],
    paramWrite: () => {},
    onHotFrame: () => () => {},
  } as EngineLink
  return { link: l, calls }
}

test('a package carries each referenced take exactly once', () => {
  const patch = {
    ...emptyPatch(),
    decks: [deck(0, '/t/a.wav'), deck(1, '/t/a.wav'), deck(2, '/t/b.wav'), deck(3, '')],
  }
  expect(takePathsFor(patch)).toEqual(['/t/a.wav', '/t/b.wav']) // deduped, no empties
})

test('saving reports takes that could not be included, rather than hiding it', async () => {
  const { link: l } = link({ savePackage: { ok: true, path: '/x.wizard', missing: ['/t/gone.wav'], error: '' } })
  const r = await savePackage(l, { ...emptyPatch(), decks: [deck(0, '/t/gone.wav')] }, NOW)
  expect(r.ok).toBe(true)
  expect(r.notice).toContain('could not be included')
})

test('cancelling a save is not an error and says nothing', async () => {
  const { link: l } = link({ savePackage: { ok: false, path: '', missing: [], error: '' } })
  const r = await savePackage(l, emptyPatch(), NOW)
  expect(r.ok).toBe(false)
  expect(r.notice).toBe('') // a cancel must not look like a failure
})

function packageReply(patch: Patch, takes: Array<{ name: string; path: string }>) {
  return {
    loadPackage: {
      ok: true,
      text: serializeSession(makeSession(patch, NOW)),
      takes,
      error: '',
    },
  }
}

test('the ORIGINAL path wins when it still resolves — no silent duplicate', async () => {
  const patch = { ...emptyPatch(), decks: [deck(0, '/orig/a.wav')] }
  const { link: l, calls } = link(
    packageReply(patch, [{ name: 'a.wav', path: '/pkg/a.wav' }]),
    ['/orig/a.wav', '/pkg/a.wav'], // BOTH resolve
  )
  let applied: Patch | null = null
  const r = await openPackage(l, (p) => (applied = p), () => {}, () => {})
  expect(r.ok).toBe(true)
  const loads = calls.filter((c) => c.method === 'deckLoadTake')
  expect(loads).toHaveLength(1) // the embedded copy was never even tried
  expect(loads[0]!.params.path).toBe('/orig/a.wav')
  expect(applied!.decks[0]!.sourcePath).toBe('/orig/a.wav') // document untouched
  expect(r.notice).toBe('')
})

test("a dead original falls back to the package's copy and rewrites the path", async () => {
  const patch = { ...emptyPatch(), decks: [deck(0, '/gone/a.wav')] }
  const { link: l } = link(
    packageReply(patch, [{ name: 'a.wav', path: '/pkg/a.wav' }]),
    ['/pkg/a.wav'], // only the embedded copy exists — the sharing case
  )
  let applied: Patch | null = null
  const r = await openPackage(l, (p) => (applied = p), () => {}, () => {})
  expect(r.ok).toBe(true)
  // Rewritten ONLY because the original was proven dead.
  expect(applied!.decks[0]!.sourcePath).toBe('/pkg/a.wav')
  expect(r.notice).toContain("package's own copy")
})

test('a reference the package does not carry stays marked, not dropped', async () => {
  const patch = { ...emptyPatch(), decks: [deck(0, '/gone/x.wav')] }
  const { link: l } = link(packageReply(patch, []), [])
  const marks: Array<[number, boolean]> = []
  let applied: Patch | null = null
  const r = await openPackage(l, (p) => (applied = p), (d, u) => marks.push([d, u]), () => {})
  expect(r.ok).toBe(true)
  expect(marks).toContainEqual([0, true])
  expect(applied!.decks[0]!.sourcePath).toBe('/gone/x.wav') // preserve-don't-drop
  expect(r.notice).toContain('could not find')
})

test('a package whose session is corrupt is refused with a reason', async () => {
  const { link: l } = link({ loadPackage: { ok: true, text: '{ not json', takes: [], error: '' } })
  const r = await openPackage(l, () => {}, () => {}, () => {})
  expect(r.ok).toBe(false)
  expect(r.notice.length).toBeGreaterThan(0)
})

test('a package from a NEWER Wizard is refused, not partially opened', async () => {
  const s = JSON.parse(serializeSession(makeSession(emptyPatch(), NOW)))
  s.schemaVersion = 9999
  const { link: l } = link({ loadPackage: { ok: true, text: JSON.stringify(s), takes: [], error: '' } })
  let applied = false
  const r = await openPackage(l, () => (applied = true), () => {}, () => {})
  expect(r.ok).toBe(false)
  expect(applied).toBe(false) // nothing installed
  expect(r.notice).toContain('newer Wizard')
})

test('cancelling an open leaves the current session alone', async () => {
  const { link: l } = link({ loadPackage: { ok: false, text: '', takes: [], error: '' } })
  let applied = false
  const r = await openPackage(l, () => (applied = true), () => {}, () => {})
  expect(r.notice).toBe('')
  expect(applied).toBe(false)
})
