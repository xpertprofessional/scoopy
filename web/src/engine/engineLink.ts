/**
 * SLP transport for the UI. `EngineLink` is the only surface panels see;
 * `JuceLink` implements it over the JUCE WebView bridge (`window.__JUCE__`).
 *
 * The bridge is injected (not read from `window` in the constructor) so the
 * request/reply/hotframe plumbing is unit-testable with a fake backend, and
 * so a Tauri/WASM transport can drop in later behind the same interface.
 */
import {
  COMMANDS,
  type Capabilities,
  type Method,
  type Params,
  type Result,
  type ParamId,
} from '../../protocol/schema'

export interface EngineLink {
  command<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>
  /** Fire-and-forget live control; coalesced to one write per key per frame. */
  paramWrite(id: ParamId, value: number): void
  onHotFrame(cb: (frame: Float64Array) => void): () => void
}

/** The subset of `window.__JUCE__.backend` this transport uses. */
export interface JuceBackend {
  emitEvent(eventId: string, payload: unknown): void
  addEventListener(eventId: string, fn: (payload: unknown) => void): number
  removeEventListener?(id: number): void
}

/** rAF scheduler — injectable so tests can drive coalescing deterministically. */
export type FrameScheduler = (cb: () => void) => void

const NATIVE_COMMAND = 'wzCommand'
const HOT_FRAME_EVENT = 'wzHotFrame'
const PARAM_EVENT = 'wzParam'

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class JuceLink implements EngineLink {
  private nextPromiseId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly hotFrameCbs = new Set<(frame: Float64Array) => void>()
  private readonly paramQueue = new Map<ParamId, number>()
  private flushScheduled = false

  constructor(
    private readonly backend: JuceBackend,
    private readonly schedule: FrameScheduler = (cb) => requestAnimationFrame(cb),
  ) {
    // JUCE resolves native-function promises by emitting __juce__complete.
    backend.addEventListener('__juce__complete', (payload) => {
      const { promiseId, result } = payload as { promiseId: number; result: unknown }
      const entry = this.pending.get(promiseId)
      if (!entry) return
      this.pending.delete(promiseId)
      entry.resolve(result)
    })

    backend.addEventListener(HOT_FRAME_EVENT, (payload) => {
      const frame = Float64Array.from(payload as ArrayLike<number>)
      this.hotFrameCbs.forEach((cb) => cb(frame))
    })
  }

  command<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
    const promiseId = this.nextPromiseId++
    const raw = new Promise<unknown>((resolve, reject) => {
      this.pending.set(promiseId, { resolve, reject })
      // Mirrors JUCE's getNativeFunction wire format exactly.
      this.backend.emitEvent('__juce__invoke', {
        name: NATIVE_COMMAND,
        params: [method, params],
        resultId: promiseId,
      })
    })
    return raw.then((reply) => {
      const r = reply as { ok: boolean; result?: unknown; error?: string }
      if (!r || r.ok !== true) throw new Error(r?.error ?? `command ${method} failed`)
      return COMMANDS[method].result.parse(r.result) as Result<M>
    })
  }

  paramWrite(id: ParamId, value: number): void {
    this.paramQueue.set(id, value)
    if (this.flushScheduled) return
    this.flushScheduled = true
    this.schedule(() => {
      this.flushScheduled = false
      for (const [pid, v] of this.paramQueue) this.backend.emitEvent(PARAM_EVENT, { id: pid, value: v })
      this.paramQueue.clear()
    })
  }

  onHotFrame(cb: (frame: Float64Array) => void): () => void {
    this.hotFrameCbs.add(cb)
    return () => this.hotFrameCbs.delete(cb)
  }
}

interface JuceWindow {
  __JUCE__?: { backend?: JuceBackend }
}

/**
 * Returns the JUCE-hosted link, or null when not running inside the shell.
 * Never inferred/faked: a null here means "no engine" and the UI shows a
 * disconnected state rather than a working-looking app with a dead backend.
 */
export function createEngineLink(): EngineLink | null {
  const backend = (window as unknown as JuceWindow).__JUCE__?.backend
  return backend ? new JuceLink(backend) : null
}

export async function fetchCapabilities(link: EngineLink): Promise<Capabilities> {
  return link.command('getCapabilities', {})
}
