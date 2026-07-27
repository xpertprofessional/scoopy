import {
  COMMANDS,
  HotFrameLayout,
  type Capabilities,
  type Method,
  type ParamId,
} from "../protocol/schema.ts";
import {
  JuceLinkBase,
  createJuceLink,
  juceBackend,
  type JuceBackend,
} from "../protocol/juceLink.ts";
import { BrowserLink } from "./browserLink.ts";

/**
 * Transport-agnostic engine link (SLP). WKWebViewLink is the mac-shell
 * implementation; TauriLink / WasmLink arrive with their shells. UI code
 * only ever sees this interface.
 */
export interface EngineLink {
  command<M extends Method>(
    method: M,
    params: unknown,
  ): Promise<unknown>;
  /** Fire-and-forget live control write; coalesced to one per rAF per key. */
  paramWrite(p: ParamId, value: number, deck?: number, track?: number): void;
  onHotFrame(cb: (frame: Float64Array) => void): () => void;
  onEvent(cb: (evt: unknown) => void): () => void;
  /** Read-only view state pushed by the Swift document owner, per topic. */
  onUiState(topic: string, cb: (state: unknown) => void): () => void;
}

type WebKitHandlers = {
  webkit?: {
    messageHandlers?: {
      slp?: { postMessage(body: unknown): void };
    };
  };
  __slpResponse?: (resp: {
    id: number;
    ok: boolean;
    result?: unknown;
    error?: string;
  }) => void;
  __slpEvent?: (evt: unknown) => void;
  __slHotFrame?: (frame: number[]) => void;
  __slpUiState?: (topic: string, state: unknown) => void;
};

/** The webkit bridge handles, read LAZILY.
 *
 * This used to be `const w = window as …` at module scope, which meant merely
 * IMPORTING this module required a DOM. That is fine in the app and wrong
 * everywhere else: the moment a node-environment module imported anything from
 * here — as `companionEngine` now does for the native world sink — the import
 * threw `window is not defined` before a single line of the test ran. A
 * transport module should not demand a browser just to be named. */
const wk = (): Window & WebKitHandlers =>
  globalThis.window as unknown as Window & WebKitHandlers;

class WKWebViewLink implements EngineLink {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private hotFrameCbs = new Set<(frame: Float64Array) => void>();
  private eventCbs = new Set<(evt: unknown) => void>();
  private uiStateCbs = new Map<string, Set<(state: unknown) => void>>();
  private lastUiState = new Map<string, unknown>();
  private paramQueue = new Map<
    string,
    { p: ParamId; deck?: number; track?: number; v: number }
  >();
  private flushScheduled = false;

  constructor(private post: (body: unknown) => void) {
    const w = wk();
    w.__slpResponse = (resp) => {
      const entry = this.pending.get(resp.id);
      if (!entry) return;
      this.pending.delete(resp.id);
      // Shared reply envelope ({id, ok, result?, error?} — envelope.ts): `ok`
      // is the authority, mirroring the shared JuceLinkBase reply check.
      if (resp.ok !== true)
        entry.reject(new Error(resp.error ?? "command failed"));
      else entry.resolve(resp.result);
    };
    w.__slpEvent = (evt) => this.eventCbs.forEach((cb) => cb(evt));
    w.__slHotFrame = (frame) => {
      const typed = Float64Array.from(frame);
      this.hotFrameCbs.forEach((cb) => cb(typed));
    };
    w.__slpUiState = (topic, state) => {
      this.lastUiState.set(topic, state);
      this.uiStateCbs.get(topic)?.forEach((cb) => cb(state));
    };
  }

  command<M extends Method>(method: M, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ kind: "cmd", id, method, params });
    });
  }

  paramWrite(p: ParamId, value: number, deck?: number, track?: number): void {
    this.paramQueue.set(`${p}/${deck ?? -1}/${track ?? -1}`, {
      p,
      deck,
      track,
      v: value,
    });
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      for (const write of this.paramQueue.values()) {
        this.post({ kind: "param", ...write });
      }
      this.paramQueue.clear();
    });
  }

  onHotFrame(cb: (frame: Float64Array) => void): () => void {
    this.hotFrameCbs.add(cb);
    return () => this.hotFrameCbs.delete(cb);
  }

  onEvent(cb: (evt: unknown) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  onUiState(topic: string, cb: (state: unknown) => void): () => void {
    let set = this.uiStateCbs.get(topic);
    if (!set) {
      set = new Set();
      this.uiStateCbs.set(topic, set);
    }
    set.add(cb);
    // Replay the latest state so late subscribers don't miss the initial push.
    if (this.lastUiState.has(topic)) cb(this.lastUiState.get(topic));
    return () => set.delete(cb);
  }
}

/**
 * The merged-shell link: scoopy's web stack hosted in a JUCE WebBrowserComponent
 * (wizard×scoopy merge P0-A). DORMANT in the shipping WKWebView app — no
 * `window.__JUCE__` backend exists there — and picked up by the merged shell's
 * CommandDispatch in P1. Two deliberate differences from WKWebViewLink:
 * command replies are validated through the command table (strict result
 * schemas, JuceLinkBase.command), and the param axis is scoopy's (deck, track)
 * pair, so this subclass owns its own coalescing queue instead of the base's
 * single-channel one.
 */
class JuceLink
  extends JuceLinkBase<typeof COMMANDS, ParamId>
  implements EngineLink
{
  private eventCbs = new Set<(evt: unknown) => void>();
  private uiStateCbs = new Map<string, Set<(state: unknown) => void>>();
  private lastUiState = new Map<string, unknown>();
  private slParamQueue = new Map<
    string,
    { p: ParamId; deck?: number; track?: number; v: number }
  >();
  private slFlushScheduled = false;

  constructor(private readonly slBackend: JuceBackend) {
    super(
      {
        commands: COMMANDS,
        commandEvent: "slCommand",
        hotFrameEvent: "slHotFrame",
        paramEvent: "slParam",
      },
      slBackend,
    );
    slBackend.addEventListener("slEvent", (evt) =>
      this.eventCbs.forEach((cb) => cb(evt)),
    );
    slBackend.addEventListener("slUiState", (payload) => {
      const { topic, state } = payload as { topic: string; state: unknown };
      this.lastUiState.set(topic, state);
      this.uiStateCbs.get(topic)?.forEach((cb) => cb(state));
    });
  }

  /** SLP wire payload ({p, deck?, track?, v}), coalesced one per rAF per key. */
  override paramWrite(
    p: ParamId,
    value: number,
    deck?: number,
    track?: number,
  ): void {
    this.slParamQueue.set(`${p}/${deck ?? -1}/${track ?? -1}`, {
      p,
      deck,
      track,
      v: value,
    });
    if (this.slFlushScheduled) return;
    this.slFlushScheduled = true;
    requestAnimationFrame(() => {
      this.slFlushScheduled = false;
      for (const write of this.slParamQueue.values())
        this.slBackend.emitEvent("slParam", write);
      this.slParamQueue.clear();
    });
  }

  onEvent(cb: (evt: unknown) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  onUiState(topic: string, cb: (state: unknown) => void): () => void {
    let set = this.uiStateCbs.get(topic);
    if (!set) {
      set = new Set();
      this.uiStateCbs.set(topic, set);
    }
    set.add(cb);
    // Replay the latest state so late subscribers don't miss the initial push.
    if (this.lastUiState.has(topic)) cb(this.lastUiState.get(topic));
    return () => set.delete(cb);
  }
}

/**
 * The merged shell's link, the mac shell's link, the browser companion's link,
 * or null.
 *
 * ⚠️ THE BROWSER HOST IS OPT-IN (`?host=browser`), NEVER INFERRED. It would be one line shorter to
 * fall back to the BrowserLink whenever the webkit handler is absent — and that line would silently
 * swallow the case this null return exists to expose: a mac panel whose bridge failed to install.
 * Today that shows up as "no engine link"; under a fallback it would show up as a working-looking
 * file browser listing an empty OPFS library, and the real fault would be invisible. An engine host
 * is a deliberate choice, so it is made explicitly.
 */
/**
 * The merged shell's link (wizard×scoopy merge): scoopy's COMPANION stack
 * hosted inside the JUCE shell, with a REAL native lane beside it.
 *
 * THE SPLIT, and why it is a split rather than one or the other:
 *
 *   NATIVE (JUCE / SlDispatch) — the engine, the audio device, settings on
 *     disk, the plane's whole strip surface, and window spawning. The merged
 *     shell is the only host that HAS these, and none of them can be faked in a
 *     webview.
 *   BROWSER (the companion stack) — the grid document, patterns, scenes,
 *     sessions, samples, OPFS, the file browser. `MergedMain` implements none
 *     of these, and the flip that would move them native is P3. Delegating is
 *     what keeps the grid working unchanged.
 *
 * ⚠️ THIS CLASS USED TO BE EMPTY. It held `juceBackend` and never called it, so
 * EVERY command in the merged shell was answered by the browser stack and
 * anything that stack does not implement threw "not implemented in the browser
 * companion" — which is what the plane's first run-pass hit, on every single
 * command it issued. The engine was running, with a device open, being asked
 * nothing. That is why the allowlist below is explicit and commented rather
 * than a heuristic: a method silently landing on the wrong side is invisible
 * until the feature that needs it is built.
 */
class MergedLink extends BrowserLink {
  private readonly native: JuceLink;

  /**
   * Methods the NATIVE side owns. Everything not listed falls through to the
   * companion stack, which is the safe default: an unlisted method reaching the
   * browser fails loudly with a named error, whereas an unlisted method
   * reaching a native host that does not implement it fails identically. The
   * asymmetry that matters is that the browser CAN answer the document methods
   * and native cannot.
   */
  private static readonly NATIVE_METHODS: ReadonlySet<string> = new Set([
    // The handshake. Native's capabilities are the true ones for this host —
    // audioDeviceSelection is genuinely available here and is not in a browser.
    "getCapabilities",
    // Settings live in the shell's own file, not this webview's localStorage:
    // every panel window is a separate webview and they must agree, which only
    // a shared file gives you.
    "getSetting",
    "setSetting",
    "getSettings",
    // The plane's strip surface (merge P2 step 4) — sl_channel_* / sl_tape_* /
    // sl_route_* and the take library. No browser equivalent exists or could.
    "slChannel",
    "slTape",
    "slRoute",
    "slRouteList",
    "slRecord",
    "slTakes",
    // The GRID's world sink. Native for the same reason the strips are: this
    // app HAS the engine, and publishing to the browser's WASM copy of the same
    // core would put the grid on a second clock and a second output.
    "slWorld",
    // Window spawning needs the window layer.
    "openPanelWindow",
    "openInstrumentWindow",
    "openFxSlotWindow",
    "openAudioRoutingWindow",
  ]);

  constructor(readonly juceBackend: JuceBackend) {
    super();
    this.native = new JuceLink(juceBackend);
  }

  /**
   * Browser init WITHOUT the synthetic HotFrame pump. The companion generates
   * its own frame on rAF because it has no engine to ask; here there IS one,
   * broadcasting at 30 Hz over the JUCE event lane, and two sources writing the
   * same frame would race — the meters would read whichever arrived last.
   */
  override async start(): Promise<void> {
    await super.start();
    super.stop(); // cancels the synthetic pump; the native lane replaces it
  }

  override async command<M extends Method>(method: M, params: unknown): Promise<unknown> {
    if (MergedLink.NATIVE_METHODS.has(method as string))
      return this.native.command(method, params as never);
    return super.command(method, params);
  }

  /**
   * The REAL engine's telemetry, with the companion's preview scalars laid over
   * it. The file-browser preview player is a browser AudioContext and the
   * engine knows nothing about it, so its two slots would otherwise go dark the
   * moment the native lane took over — a working feature silently losing its
   * meter is exactly the kind of regression this merge keeps having to avoid.
   */
  override onHotFrame(cb: (frame: Float64Array) => void): () => void {
    return this.native.onHotFrame((frame) => {
      const player = this.fileBrowser.player;
      frame[HotFrameLayout.previewLevel] = player.level();
      frame[HotFrameLayout.previewProgress] = player.progress();
      cb(frame);
    });
  }

  /** Param writes are engine control — they belong to the engine that renders. */
  override paramWrite(p: ParamId, value: number, deck?: number, track?: number): void {
    this.native.paramWrite(p, value, deck, track);
  }

  /**
   * Events come from BOTH sides and must be merged: native emits `slEvent`
   * (settingChanged, which drives cross-window theme sync), while the companion
   * emits its own document events. Subscribing to only one loses half of them.
   */
  override onEvent(cb: (evt: unknown) => void): () => void {
    const offNative = this.native.onEvent(cb);
    const offBrowser = super.onEvent(cb);
    return () => {
      offNative();
      offBrowser();
    };
  }

  /**
   * UiState stays with the COMPANION. It owns the grid document, so it is the
   * only side with anything to publish; `SlDispatch::getUiState` deliberately
   * answers `{}` for every topic. Native pushes are still merged in, so a topic
   * the shell later starts publishing arrives without another change here.
   */
  override onUiState(topic: string, cb: (state: unknown) => void): () => void {
    const offNative = this.native.onUiState(topic, cb);
    const offBrowser = super.onUiState(topic, cb);
    return () => {
      offNative();
      offBrowser();
    };
  }
}

/**
 * A link that speaks ONLY to the native side, for callers that must not be
 * routed by `MergedLink`'s allowlist.
 *
 * The world sink is the case. `companionEngine` is module-scoped and chooses
 * its sink at import time — before any panel has built a link — so it cannot be
 * handed the app's `EngineLink`. It also must not be: routing its `slWorld`
 * calls through the merged link would work, but the sink is a NATIVE-ONLY
 * concept, and reaching it through a link whose whole job is deciding
 * native-vs-companion would make the decision look re-litigable.
 *
 * Cheap and safe to call more than once: `JuceLink` holds no state of its own
 * beyond its listener registrations, and the backend is a singleton the shell
 * installed. Throws if there is no backend, because a caller reaching for this
 * on a non-native host has a bug that a null would hide.
 */
export function nativeLink(): EngineLink {
  const backend = juceBackend();
  if (!backend) throw new Error("nativeLink(): no JUCE backend on this host");
  return new JuceLink(backend);
}

export function createEngineLink(): EngineLink | null {
  // JUCE backend present ⇒ we are inside the merged shell (never true in the
  // shipping WKWebView app). Checked first: the merged shell is the host, and
  // the backends never coexist. The merged shell reuses the companion stack, so
  // this is a BrowserLink subclass rather than the bare JuceLink.
  const merged = createJuceLink((backend) => new MergedLink(backend));
  if (merged) {
    (window as unknown as { __scoopyLink?: EngineLink }).__scoopyLink = merged;
    // CAUGHT, not `void`ed. start() reaches for OPFS, and an unhandled
    // rejection here is rendered by main.tsx as a full-width error block over
    // the app — so a storage quirk would present as a crashed panel. The link
    // itself is fine without it; only the file browser is degraded.
    void (merged as unknown as BrowserLink)
      .start()
      .catch((e: unknown) => console.error("companion stack failed to start:", e));
    return merged;
  }

  const handler = wk().webkit?.messageHandlers?.slp;
  if (handler) return new WKWebViewLink((body) => handler.postMessage(body));

  if (new URLSearchParams(location.search).get("host") === "browser") {
    const link = new BrowserLink();
    // A debug/e2e handle on the one link the companion uses. Harmless (it exposes the same object a
    // panel already holds) and it is what `browser_grid_test.mjs` drives the write path through —
    // the grid renders to a canvas, so a gate cannot click "step 4" and must send the command the
    // grid would.
    (window as unknown as { __scoopyLink?: EngineLink }).__scoopyLink = link;
    // OPFS init is async and the panels need a link synchronously. The first `fileBrowser` push
    // lands when the library is open; until then the panel renders its empty state, which is
    // exactly what it does on the desktop before Swift's first push arrives.
    void link
      .start()
      .catch((e: unknown) => console.error("companion stack failed to start:", e));
    return link;
  }
  return null;
}

/** Typed convenience for the schema-version handshake. */
export async function fetchCapabilities(
  link: EngineLink,
): Promise<Capabilities> {
  const raw = await link.command("getCapabilities", {});
  return COMMANDS.getCapabilities.result.parse(raw);
}
