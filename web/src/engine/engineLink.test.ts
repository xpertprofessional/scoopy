import { beforeEach, expect, test, vi } from 'vitest'
import { JuceLink, type JuceBackend } from './engineLink'

/**
 * Fake JUCE backend: records emitted events and lets a test resolve a
 * __juce__invoke by feeding a reply back through __juce__complete — exactly
 * what the real C++ native-function completion does over the bridge.
 */
class FakeBackend implements JuceBackend {
  private listeners = new Map<string, Set<(p: unknown) => void>>()
  emitted: Array<{ eventId: string; payload: unknown }> = []

  emitEvent(eventId: string, payload: unknown): void {
    this.emitted.push({ eventId, payload })
  }
  addEventListener(eventId: string, fn: (p: unknown) => void): number {
    if (!this.listeners.has(eventId)) this.listeners.set(eventId, new Set())
    this.listeners.get(eventId)!.add(fn)
    return this.listeners.get(eventId)!.size
  }
  fire(eventId: string, payload: unknown): void {
    this.listeners.get(eventId)?.forEach((fn) => fn(payload))
  }
  /** Resolve the most recent __juce__invoke with a reply object. */
  completeLastInvoke(reply: unknown): void {
    const invoke = [...this.emitted].reverse().find((e) => e.eventId === '__juce__invoke')
    if (!invoke) throw new Error('no pending invoke')
    const { resultId } = invoke.payload as { resultId: number }
    this.fire('__juce__complete', { promiseId: resultId, result: reply })
  }
}

let backend: FakeBackend
beforeEach(() => {
  backend = new FakeBackend()
})

test('command emits a JUCE-format invoke and resolves the parsed result', async () => {
  const link = new JuceLink(backend)
  const p = link.command('getCapabilities', {})

  const invoke = backend.emitted.find((e) => e.eventId === '__juce__invoke')!
  expect(invoke.payload).toMatchObject({ name: 'wzCommand', params: ['getCapabilities', {}] })

  backend.completeLastInvoke({
    ok: true,
    result: {
      schemaVersion: 1,
      processCapture: false,
      virtualDevice: false,
      pluginHosting: false,
      fileSystem: true,
      audioDeviceSelection: false,
    },
  })
  await expect(p).resolves.toMatchObject({ schemaVersion: 1, fileSystem: true })
})

test('command rejects when the reply is not ok', async () => {
  const link = new JuceLink(backend)
  const p = link.command('ping', {})
  backend.completeLastInvoke({ ok: false, error: 'unknown method: ping' })
  await expect(p).rejects.toThrow('unknown method: ping')
})

test('command rejects when the result fails schema validation', async () => {
  const link = new JuceLink(backend)
  const p = link.command('ping', {})
  backend.completeLastInvoke({ ok: true, result: { pong: 'not-a-bool' } })
  await expect(p).rejects.toBeInstanceOf(Error)
})

test('concurrent commands resolve to their own replies by promiseId', async () => {
  const link = new JuceLink(backend)
  const a = link.command('ping', {})
  const b = link.command('ping', {})
  const invokes = backend.emitted.filter((e) => e.eventId === '__juce__invoke')
  const idA = (invokes[0]!.payload as { resultId: number }).resultId
  const idB = (invokes[1]!.payload as { resultId: number }).resultId
  expect(idA).not.toBe(idB)

  backend.fire('__juce__complete', { promiseId: idB, result: { ok: true, result: { pong: true } } })
  backend.fire('__juce__complete', { promiseId: idA, result: { ok: true, result: { pong: true } } })
  await expect(a).resolves.toEqual({ pong: true })
  await expect(b).resolves.toEqual({ pong: true })
})

test('paramWrite coalesces to one emit per (key, channel) per frame', () => {
  const scheduled: Array<() => void> = []
  const link = new JuceLink(backend, (cb) => scheduled.push(cb))

  link.paramWrite('mainGain', 0.1)
  link.paramWrite('mainGain', 0.2)
  link.paramWrite('mainGain', 0.5)
  // Same param on two different strips must NOT swallow each other.
  link.paramWrite('gain', 0.3, 3)
  link.paramWrite('gain', 0.9, 3)
  link.paramWrite('gain', 0.4, 4)
  expect(backend.emitted.filter((e) => e.eventId === 'wzParam')).toHaveLength(0)

  expect(scheduled).toHaveLength(1) // only one frame scheduled for the burst
  scheduled[0]!()

  const writes = backend.emitted.filter((e) => e.eventId === 'wzParam')
  expect(writes).toHaveLength(3)
  expect(writes.map((w) => w.payload)).toEqual([
    { id: 'mainGain', channel: 0, value: 0.5 }, // last value wins
    { id: 'gain', channel: 3, value: 0.9 },
    { id: 'gain', channel: 4, value: 0.4 },
  ])
})

test('hot frames are delivered as Float64Array to subscribers', () => {
  const link = new JuceLink(backend)
  const seen: Float64Array[] = []
  const off = link.onHotFrame((f) => seen.push(f))

  backend.fire('wzHotFrame', [1, 0, 0.25])
  expect(seen).toHaveLength(1)
  expect(seen[0]).toBeInstanceOf(Float64Array)
  expect(Array.from(seen[0]!)).toEqual([1, 0, 0.25])

  off()
  backend.fire('wzHotFrame', [2, 512, 0.3])
  expect(seen).toHaveLength(1) // unsubscribed
})

test('deck-load events are coerced, clamped, and unsubscribe cleanly (P1-11a)', () => {
  const link = new JuceLink(backend)
  const seen: Array<{ deck: number; progress: number; loading: boolean }> = []
  const off = link.onDeckLoad((e) => seen.push(e))

  backend.fire('wzDeckLoad', { deck: 2, progress: 0.5, loading: true })
  expect(seen).toEqual([{ deck: 2, progress: 0.5, loading: true }])

  // Out-of-range progress is clamped so a bad payload can't paint past 100%.
  backend.fire('wzDeckLoad', { deck: 2, progress: 1.4, loading: true })
  backend.fire('wzDeckLoad', { deck: 2, progress: -0.2, loading: false })
  expect(seen[1]).toEqual({ deck: 2, progress: 1, loading: true })
  expect(seen[2]).toEqual({ deck: 2, progress: 0, loading: false })

  // A payload with no usable deck is dropped, not delivered as deck -1.
  backend.fire('wzDeckLoad', { progress: 0.3, loading: true })
  expect(seen).toHaveLength(3)

  off()
  backend.fire('wzDeckLoad', { deck: 2, progress: 1, loading: false })
  expect(seen).toHaveLength(3) // unsubscribed
})
