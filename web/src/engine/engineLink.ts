/**
 * SLP transport for the UI. `EngineLink` is the only surface panels see;
 * `JuceLink` binds the shared JUCE WebView transport (juceLink.ts, vendored from
 * shared/protocol) to Wizard's message names and command table, and adds the
 * deck-load channel that is Wizard's own.
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
import {
  JuceLinkBase,
  juceBackend,
  type FrameScheduler,
  type JuceBackend,
} from '../../protocol/juceLink.ts'

export type { FrameScheduler, JuceBackend }

export interface EngineLink {
  command<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>
  /** Fire-and-forget live control; coalesced to one write per (key, channel)
      per frame. `channel` is the strip index; master-global params (mainGain)
      ignore it and default to 0. */
  paramWrite(id: ParamId, value: number, channel?: number): void
  onHotFrame(cb: (frame: Float64Array) => void): () => void
  /** Deck-load progress pushed from the shell's decode worker (P1-11a). Fired
      0..1 while a deck decodes, then once with loading=false when it settles.
      Separate from HotFrame because it is event-driven and rare, not a
      per-frame stream. */
  onDeckLoad(cb: (e: DeckLoadEvent) => void): () => void
}

export interface DeckLoadEvent {
  deck: number
  progress: number // 0..1
  loading: boolean
}

const DECK_LOAD_EVENT = 'wzDeckLoad'

/**
 * Wizard is a mixer, so ParamWrite carries a strip index: the shared base keys
 * the coalescing queue per (id, channel) — a gain move on strip 3 never swallows
 * one on strip 4 within the same frame — and puts `channel` on the wire.
 *
 * The deck-load channel is Wizard-only, so it is registered here on top of the
 * shared transport rather than pushed into it.
 */
export class JuceLink extends JuceLinkBase<typeof COMMANDS, ParamId> implements EngineLink {
  private readonly deckLoadCbs = new Set<(e: DeckLoadEvent) => void>()

  constructor(backend: JuceBackend, schedule?: FrameScheduler) {
    super(
      {
        commands: COMMANDS,
        commandEvent: 'wzCommand',
        hotFrameEvent: 'wzHotFrame',
        paramEvent: 'wzParam',
        channelAxis: true,
      },
      backend,
      schedule,
    )

    backend.addEventListener(DECK_LOAD_EVENT, (payload) => {
      const p = payload as { deck?: unknown; progress?: unknown; loading?: unknown }
      // The shell is trusted, but a malformed payload must not throw inside an
      // event listener and tear down the bridge — clamp and coerce defensively.
      const deck = typeof p.deck === 'number' ? p.deck : -1
      if (deck < 0) return
      const progress = typeof p.progress === 'number' ? Math.min(1, Math.max(0, p.progress)) : 0
      const loading = p.loading === true
      this.deckLoadCbs.forEach((cb) => cb({ deck, progress, loading }))
    })
  }

  onDeckLoad(cb: (e: DeckLoadEvent) => void): () => void {
    this.deckLoadCbs.add(cb)
    return () => this.deckLoadCbs.delete(cb)
  }
}

/**
 * Returns the JUCE-hosted link, or null when not running inside the shell.
 * Never inferred/faked: a null here means "no engine" and the UI shows a
 * disconnected state rather than a working-looking app with a dead backend.
 */
export function createEngineLink(): EngineLink | null {
  const backend = juceBackend()
  return backend ? new JuceLink(backend) : null
}

export async function fetchCapabilities(link: EngineLink): Promise<Capabilities> {
  return link.command('getCapabilities', {})
}
