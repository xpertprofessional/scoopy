/**
 * The JUCE WebView transport, shared by every JUCE-hosted xpert app. This is the
 * request/reply, rAF param-coalescing and HotFrame fan-out plumbing that was
 * duplicated verbatim across apps — the only real differences were the three
 * message-name constants and whether ParamWrite carries a strip index.
 *
 * The backend is INJECTED (never read off `window` in here) so the plumbing is
 * unit-testable with a fake, and so a Tauri/WASM transport can drop in later
 * behind the same interface.
 *
 * Apps subclass this with their own message names and narrow the public surface
 * to their own EngineLink interface:
 *
 *   export class JuceLink extends JuceLinkBase<typeof COMMANDS, ParamId>
 *     implements EngineLink {
 *     constructor(backend: JuceBackend, schedule?: FrameScheduler) {
 *       super({ commands: COMMANDS, commandEvent: 'plCommand', … }, backend, schedule)
 *     }
 *   }
 *
 * Vendored, not linked — see shared/README.md.
 */
import type { CommandSpec, CommandTable, MethodOf, ParamsOf, ResultOf } from './types.ts'

/** The subset of `window.__JUCE__.backend` this transport uses. */
export interface JuceBackend {
  emitEvent(eventId: string, payload: unknown): void
  addEventListener(eventId: string, fn: (payload: unknown) => void): number
  removeEventListener?(id: number): void
}

/** rAF scheduler — injectable so tests can drive coalescing deterministically. */
export type FrameScheduler = (cb: () => void) => void

export interface JuceLinkConfig<T extends CommandTable> {
  /** The app's command registry; replies are parsed through it. */
  commands: T
  /** JUCE native-function name for commands, e.g. 'plCommand'. */
  commandEvent: string
  /** Event id the shell emits HotFrames on, e.g. 'plHotFrame'. */
  hotFrameEvent: string
  /** Event id for coalesced ParamWrites, e.g. 'plParam'. */
  paramEvent: string
  /**
   * Whether a ParamWrite carries a strip index. Mixer-shaped apps (Wizard) key
   * the coalescing queue per (id, channel) so a gain move on strip 3 never
   * swallows one on strip 4 in the same frame, and put `channel` on the wire.
   * Master-global apps (Parlante) omit it entirely — the payload stays
   * {id, value}. Apps narrow their own paramWrite signature, so the axis cannot
   * be passed where it would be ignored.
   */
  channelAxis?: boolean
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

interface QueuedParam {
  id: string
  channel: number
  value: number
}

export class JuceLinkBase<T extends CommandTable, P extends string> {
  private nextPromiseId = 0
  private readonly pending = new Map<number, Pending>()
  private readonly hotFrameCbs = new Set<(frame: Float64Array) => void>()
  private readonly paramQueue = new Map<string, QueuedParam>()
  private flushScheduled = false

  constructor(
    private readonly config: JuceLinkConfig<T>,
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

    backend.addEventListener(config.hotFrameEvent, (payload) => {
      const frame = Float64Array.from(payload as ArrayLike<number>)
      this.hotFrameCbs.forEach((cb) => cb(frame))
    })
  }

  command<M extends MethodOf<T>>(method: M, params: ParamsOf<T, M>): Promise<ResultOf<T, M>> {
    const promiseId = this.nextPromiseId++
    const raw = new Promise<unknown>((resolve, reject) => {
      this.pending.set(promiseId, { resolve, reject })
      // Mirrors JUCE's getNativeFunction wire format exactly.
      this.backend.emitEvent('__juce__invoke', {
        name: this.config.commandEvent,
        params: [method, params],
        resultId: promiseId,
      })
    })
    return raw.then((reply) => {
      const r = reply as { ok: boolean; result?: unknown; error?: string }
      if (!r || r.ok !== true) throw new Error(r?.error ?? `command ${String(method)} failed`)
      const spec = this.config.commands[method as keyof T] as CommandSpec
      return spec.result.parse(r.result) as ResultOf<T, M>
    })
  }

  paramWrite(id: P, value: number, channel = 0): void {
    const axis = this.config.channelAxis === true
    this.paramQueue.set(axis ? `${id}:${channel}` : id, { id, channel, value })
    if (this.flushScheduled) return
    this.flushScheduled = true
    this.schedule(() => {
      this.flushScheduled = false
      for (const w of this.paramQueue.values()) {
        this.backend.emitEvent(
          this.config.paramEvent,
          axis ? { id: w.id, channel: w.channel, value: w.value } : { id: w.id, value: w.value },
        )
      }
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
 * Builds the app's link when the JUCE backend is present, else null. This is
 * the one shared home of the "null means no engine" law: the backend is never
 * inferred or faked, and each app decides WHAT to construct (usually its
 * JuceLinkBase subclass) while this decides WHETHER.
 */
export function createJuceLink<L>(make: (backend: JuceBackend) => L): L | null {
  const backend = juceBackend()
  return backend === null ? null : make(backend)
}

/**
 * The JUCE backend if we are running inside the shell, else null. Never inferred
 * or faked: a null here means "no engine", and the UI must show a disconnected
 * state rather than a working-looking app with a dead backend.
 */
export function juceBackend(): JuceBackend | null {
  return (window as unknown as JuceWindow).__JUCE__?.backend ?? null
}
