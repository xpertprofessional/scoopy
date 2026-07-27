/**
 * P8-6 — the browser's EngineLink. The shell `engineLink.ts` has been holding a seat for:
 *
 *   > "WKWebViewLink is the mac-shell implementation; TauriLink / **WasmLink** arrive with their
 *   >  shells. UI code only ever sees this interface." (engineLink.ts:9-12)
 *
 * This is that WasmLink, and it exists to prove one claim the migration has been making since the
 * schema was written: that a panel does not know, and cannot tell, who is answering it.
 * `FileBrowserPanel.tsx` is **not modified by this row** — it sends the same ten `fileBrowser` ops,
 * subscribes to the same `fileBrowser` topic, and reads the same two HotFrame slots. Underneath, a
 * `FileManager` was replaced by an OPFS handle tree and the panel never noticed.
 *
 * ⚠️ IT IS A PARTIAL LINK, AND IT SAYS SO. A browser cannot host an AU, open a hardware device, or
 * send MIDI to a port, and those command families REJECT by name rather than resolve `{}` — this
 * codebase's recurring injury is the silent no-op (the dead context-menu items, the frozen DJ topic,
 * the inert launchQuantize picker), and a loud TODO beats a bug you find in six weeks. What is NO
 * LONGER missing is the document: the grid edits over `gridMeta`/`gridPattern`/`gridRuntime` +
 * `publishTrackPattern`, served from the session by `GridBackend`, so `GridPanel` runs here unchanged.
 */
import {
  HOT_FRAME_LENGTH,
  HotFrameLayout,
  SCHEMA_VERSION,
  type Method,
  type ParamId,
} from "../protocol/schema.ts";
import type { EngineLink } from "./engineLink.ts";
import { FileBrowserBackend, type BrowserSettings } from "./store/fileBrowserBackend.ts";
import { GridBackend, type GridBackendHooks } from "./store/gridBackend.ts";
import { SampleStore } from "./store/sampleStore.ts";
import type { FileBrowserState } from "../protocol/schema.ts";

/** Settings over localStorage — the browser's @AppStorage. Same keys, so there is still ONE owner. */
class LocalSettings implements BrowserSettings {
  private prefix = "scoopy.";

  get(key: string): unknown {
    const raw = localStorage.getItem(this.prefix + key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  set(key: string, value: unknown): void {
    localStorage.setItem(this.prefix + key, JSON.stringify(value));
  }
}

/** 30 Hz — the rate the desktop pushes HotFrames at, so meters behave identically. */
const HOT_FRAME_INTERVAL_MS = 1000 / 30;

export class BrowserLink implements EngineLink {
  private hotFrameCbs = new Set<(frame: Float64Array) => void>();
  private eventCbs = new Set<(evt: unknown) => void>();
  private uiStateCbs = new Map<string, Set<(state: unknown) => void>>();
  private lastUiState = new Map<string, unknown>();

  private settings = new LocalSettings();
  private store = new SampleStore();
  private browser: FileBrowserBackend;
  private grid: GridBackend;

  private frame = new Float64Array(HOT_FRAME_LENGTH);
  private frameCounter = 0;
  private rafHandle: number | null = null;
  private lastFrameAt = 0;
  private warnedParamWrite = false;

  private gridEditHandler: GridBackendHooks["onEdit"] | null = null;
  /** Registered by the companion: assign a LIBRARY sample (OPFS path) to a track. */
  private sampleLoadHandler: ((trackIndex: number, path: string) => Promise<void>) | null = null;
  /** Registered by the companion: the LOAD button — pick an audio file, import it, assign it. */
  private samplePickHandler: ((trackIndex: number) => Promise<void>) | null = null;
  /** Registered by the companion: the grid's ▶/■ — flip the runtime launch gate. */
  private launchToggleHandler: ((trackIndex: number) => void) | null = null;
  /** Registered by the companion: the S button — flip the runtime solo. */
  private soloToggleHandler: ((trackIndex: number) => void) | null = null;
  /** Registered by the companion: the ↻ locator-repeat toggle — a scene-aware document flip. */
  private locatorRepeatHandler: ((trackIndex: number) => void) | null = null;

  constructor() {
    // Playhead sentinels. A Float64Array defaults to 0 — a VALID step — so the unfilled playhead
    // slots made the companion grid draw a permanent playhead wash on step 0 of every track. The
    // schema's "not playing" value is −1 (schema.ts:135-141); these slots are static here (no
    // per-track playhead is pumped yet), so they are stamped once.
    for (const name of Object.keys(HotFrameLayout)) {
      if (/^trackStep\d+$|^trackPos\d+$|^playheadStepDeck\d$/.test(name)) {
        this.frame[HotFrameLayout[name as keyof typeof HotFrameLayout]] = -1;
      }
    }
    this.browser = new FileBrowserBackend(this.store, this.settings, (state) =>
      this.pushUiState("fileBrowser", state),
    );
    this.grid = new GridBackend({
      publish: (topic, state) => this.pushUiState(topic, state),
      // The companion store owns the document — it folds the edit in, re-publishes the world and
      // autosaves. Registered after construction (the store outlives one link and wires itself in),
      // and a no-op until then so the link works before a session is open.
      onEdit: (i, row) => this.gridEditHandler?.(i, row),
      peaks: (i, points) => this.gridPeaks(i, points),
    });
  }

  /** The document backend, so the companion store can `load()` a session into the grid. */
  get gridBackend(): GridBackend {
    return this.grid;
  }

  /** The companion store registers here so a grid edit reaches the document + engine + autosave. */
  setGridEditHandler(fn: GridBackendHooks["onEdit"]): void {
    this.gridEditHandler = fn;
  }

  setSampleLoadHandler(fn: (trackIndex: number, path: string) => Promise<void>): void {
    this.sampleLoadHandler = fn;
  }

  setSamplePickHandler(fn: (trackIndex: number) => Promise<void>): void {
    this.samplePickHandler = fn;
  }

  setLaunchToggleHandler(fn: (trackIndex: number) => void): void {
    this.launchToggleHandler = fn;
  }

  setSoloToggleHandler(fn: (trackIndex: number) => void): void {
    this.soloToggleHandler = fn;
  }

  setLocatorRepeatHandler(fn: (trackIndex: number) => void): void {
    this.locatorRepeatHandler = fn;
  }

  /**
   * How the grid gets its cell waveforms. The store keys decoded audio by OPFS path; the grid knows
   * a track by index, so the path is threaded through the runtime info the store already hands the
   * grid on load. Set by the companion via `setGridPeakPaths`.
   */
  private gridPeakPaths: (string | null)[] = [];
  setGridPeakPaths(paths: (string | null)[]): void {
    this.gridPeakPaths = paths;
  }

  private async gridPeaks(trackIndex: number, points: number): Promise<{ minMax: number[]; rms: number[] }> {
    const path = this.gridPeakPaths[trackIndex];
    if (!path) return { minMax: [], rms: [] };
    const env = await this.store.peakEnvelope(path, points);
    return { minMax: env.minMax, rms: env.rms };
  }

  /** Create the OPFS libraries and publish the first listing. */
  async start(): Promise<void> {
    await this.browser.init();
    // init() only scans — the push is what the panel is waiting on, and forgetting it is how a
    // topic-driven panel ends up permanently empty with every test still green.
    this.pushUiState("fileBrowser", this.browser.state());
    this.pumpHotFrames();
  }

  get fileBrowser(): FileBrowserBackend {
    return this.browser;
  }

  get sampleStore(): SampleStore {
    return this.store;
  }

  async command<M extends Method>(method: M, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;

    switch (method as string) {
      case "getCapabilities":
        return {
          schemaVersion: SCHEMA_VERSION,
          // The capability tier, stated honestly (P8-9). These are not "not built yet" — a browser
          // cannot host an AU, and saying so is what lets the UI render those surfaces INERT rather
          // than broken.
          pluginHosting: false,
          fileSystem: true, // OPFS + user-gesture pickers. Real, just not a disk.
          midiHardware: false,
          audioDeviceSelection: false,
          // No return FX section: the WASM render could only feed the returns' C++ DEFAULT
          // parameters, never the session's — so the browser is a dry host by policy (sends UI
          // hidden, send levels zeroed in the world) rather than a wrong-sounding one.
          returnFx: false,
        };

      case "getUiState":
        // Deterministic pull: re-run the topic's provider, exactly as Swift does.
        if (p.topic === "fileBrowser") this.pushUiState("fileBrowser", this.browser.state());
        else this.grid.republish(p.topic as string); // gridMeta · gridPattern/<i> · gridRuntime/<i>
        return {};

      case "publishTrackPattern":
        // THE FLIP's write path, in the browser. The grid applies its own reducers and hands back a
        // whole GridPatternState; GridBackend folds it into the document, and the store re-publishes
        // the world + autosaves. Returns the same {applied,error} Swift does — a refusal is loud.
        return this.grid.handlePublish(p as { trackIndex: number; json: string });

      case "getSamplePeaks":
        return this.grid.samplePeaks(p as { trackIndex: number; points: number });

      case "gridEdit":
        // In owner mode the grid applies verifiable edits itself and publishes them; the only intent
        // that still reaches here is the cursor move. Everything else that falls through is a
        // non-modeled op (topology / sample load) the browser does not do — accepted, not faked.
        if (p.op === "selectTrack") this.grid.selectTrack(Number(p.trackIndex ?? p.index ?? 0));
        return { ok: true };

      case "trackEdit":
        // The LOAD button: pick an audio file, import it into the library, assign it to the row.
        // The handler lives in the companion (it owns the document and the DOM for a picker).
        if (p.op === "loadSample" && this.samplePickHandler) {
          void this.samplePickHandler(Number(p.trackIndex ?? this.grid.selectedIndex));
          return { ok: true };
        }
        // The ▶/■ launch button: a RUNTIME gate, not a document edit — the companion flips its
        // stopped-set, republishes the world, and pushes the row's gridRuntime back. Unquantized
        // (launch-quantize scheduling is desktop-only; `launchScheduled` stays false here).
        if (p.op === "toggleLaunch" && this.launchToggleHandler) {
          this.launchToggleHandler(Number(p.trackIndex ?? this.grid.selectedIndex));
          return { ok: true };
        }
        // Solo — the same runtime shape: never persisted (on either host), rides the world's
        // mixMuted mask. Was a silent accept, which read as "the S button is dead".
        if (p.op === "toggleSolo" && this.soloToggleHandler) {
          this.soloToggleHandler(Number(p.trackIndex ?? this.grid.selectedIndex));
          return { ok: true };
        }
        // The ↻ locator-repeat toggle — a DOCUMENT edit (pattern-scoped field) that is Swift-side
        // on the desktop only because it fans across the multi-selection there. Was a silent
        // accept: the button could neither engage nor release the loop.
        if (p.op === "toggleLocatorRepeat" && this.locatorRepeatHandler) {
          this.locatorRepeatHandler(Number(p.trackIndex ?? this.grid.selectedIndex));
          return { ok: true };
        }
        // Arm the per-cell parameter lane (which lane a value-drag / ö-ä edits).
        // RUNTIME UI state with no pattern-wire home, so on the desktop it is
        // Swift's; here the grid backend remembers it and republishes gridRuntime.
        // Was a silent accept — the browser had NO armed lane, so every value-drag
        // resolved to the empty default and did nothing.
        if (p.op === "setActiveCellParameter" && typeof p.mode === "string") {
          this.grid.setActiveCellParameter(Number(p.trackIndex ?? this.grid.selectedIndex), p.mode);
          return { ok: true };
        }
        // Same story as gridEdit: verifiable track edits are self-applied + published. A stray
        // intent is a non-modeled op, accepted rather than silently dropped OR loudly rejected
        // (rejecting would make the grid think the edit failed).
        return { ok: true };

      case "reportUndoState":
        // Undo is TS-side (undoStore); this call exists to light the NATIVE Edit menu, which has no
        // browser equivalent. Accepting it is correct, not lossy.
        return {};

      case "swiftUndo":
        // ⌘Z reaches the TS undo store directly in the browser; there is no Swift undo to defer to.
        return { ok: false };

      case "openInstrumentWindow":
        // P8-9: no AU hosting in a browser. The instrument binding is preserved in the file and
        // rendered inert; there is no window to open.
        return {};

      case "fileBrowser":
        // `load` is a DOCUMENT edit, not a browser op: a double-clicked file lands on the grid's
        // selected row; a row-drop names its row. Routed to the companion, which owns the document
        // — this is the op the backend's stub has been promising since P8-6 ("load needs the TS
        // document"). The document is here now.
        if (p.op === "load" && this.sampleLoadHandler && typeof p.path === "string") {
          const trackIndex = Number(p.trackIndex ?? this.grid.selectedIndex);
          void this.sampleLoadHandler(trackIndex, p.path);
          return { notice: null };
        }
        return this.browser.handle(
          p as { op: string; path?: string; value?: string; trackIndex?: number; asStretch?: boolean },
        );

      case "getFilePeaks":
        return this.browser.peaks(p.path as string, p.points as number);

      case "getSetting":
        return { value: this.settings.get(p.key as string) };

      case "setSetting":
        this.settings.set(p.key as string, p.value);
        // The desktop broadcasts settingChanged so other webviews re-read; one document needs it
        // too, since the tokens loader listens for exactly this.
        this.eventCbs.forEach((cb) => cb({ type: "settingChanged", key: p.key }));
        return {};

      case "getSettings": {
        const values: Record<string, unknown> = {};
        for (const key of (p.keys as string[]) ?? []) values[key] = this.settings.get(key);
        return { values };
      }

      case "forwardKey":
        // Not a gap — a CATEGORY ERROR. `forwardKey` exists to hand a key back to AppKit's
        // HotkeyManager, and there is no AppKit here. P8-8 replaces the native keymap with a
        // `KeyboardEvent.code` matcher; until then the browser's own key handling is all there is,
        // and swallowing this is correct rather than lossy.
        return {};

      default:
        throw new Error(
          `${method}: not implemented in the browser companion — TS does not own the document yet (THE FLIP, P5-06 step D)`,
        );
    }
  }

  paramWrite(_p: ParamId, _value: number, _deck?: number, _track?: number): void {
    // Live control writes need a document to land in. Warn ONCE — a per-rAF console storm would be
    // worse than the silence it is meant to break.
    if (!this.warnedParamWrite) {
      this.warnedParamWrite = true;
      console.warn("paramWrite: no document in the browser companion yet (THE FLIP, P5-06 step D)");
    }
  }

  onHotFrame(cb: (frame: Float64Array) => void): () => void {
    this.hotFrameCbs.add(cb);
    return () => this.hotFrameCbs.delete(cb);
  }

  onEvent(cb: (evt: unknown) => void): () => void {
    this.eventCbs.add(cb);
    return () => this.eventCbs.delete(cb);
  }

  /**
   * Deliver an engine event to every subscriber — the browser shell's stand-in for the pushes the
   * desktop sends from Swift. The keymap uses it for `{type:"undo"|"redo"}`, the exact channel the
   * NSMenu delegates through, so GridPanel's handler runs unchanged (P8-8).
   */
  emitEvent(evt: unknown): void {
    this.eventCbs.forEach((cb) => cb(evt));
  }

  onUiState(topic: string, cb: (state: unknown) => void): () => void {
    let set = this.uiStateCbs.get(topic);
    if (!set) {
      set = new Set();
      this.uiStateCbs.set(topic, set);
    }
    set.add(cb);
    // Replay, so a late subscriber does not miss the initial push — same contract as WKWebViewLink.
    if (this.lastUiState.has(topic)) cb(this.lastUiState.get(topic));
    return () => set.delete(cb);
  }

  private pushUiState(topic: string, state: FileBrowserState | unknown): void {
    this.lastUiState.set(topic, state);
    this.uiStateCbs.get(topic)?.forEach((cb) => cb(state));
  }

  /**
   * The HotFrame pump. On the desktop this is 108 Float64 stringified into a JS literal and
   * `evaluateJavaScript`-injected per panel per tick (P8-4's indictment); here it is the same index
   * map, filled in place, with no serialization at all.
   *
   * rAF rather than setInterval: it stops when the tab is hidden, which is the right behaviour for a
   * meter nobody is looking at.
   */
  private pumpHotFrames(): void {
    const tick = (now: number) => {
      this.rafHandle = requestAnimationFrame(tick);
      if (now - this.lastFrameAt < HOT_FRAME_INTERVAL_MS) return;
      this.lastFrameAt = now;
      if (this.hotFrameCbs.size === 0) return;

      this.frame[HotFrameLayout.frameCounter] = ++this.frameCounter;
      this.frame[HotFrameLayout.hostTimeMs] = now;
      this.frame[HotFrameLayout.previewLevel] = this.browser.player.level();
      this.frame[HotFrameLayout.previewProgress] = this.browser.player.progress();

      // One shared array, handed out by reference — the panels only read, and the desktop's own
      // Float64Array-per-frame is a cost worth not reproducing.
      this.hotFrameCbs.forEach((cb) => cb(this.frame));
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = null;
  }
}
