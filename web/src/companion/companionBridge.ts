/**
 * The page side of the DJ-mixer bridge: turns bridgeSchema messages into calls
 * on the companion store/engine, and pushes state + levels back out.
 *
 * Trust model: messages arrive over window.postMessage from the extension's
 * content script (same window, isolated world). We accept only events whose
 * `e.source` is this window and whose envelope carries EXT_SOURCE, then
 * zod-parse the payload — anything else is dropped silently (one warn). The
 * bridge only exists at all under `?host=browser`; the mac WKWebView host
 * never even loads this module (dynamic import in main.tsx).
 *
 * The core is `createBridge(host, post)` with the store/engine behind the
 * small `BridgeHost` interface — that is what bridge.test.ts drives in node,
 * where there is no window and no audio.
 */
import {
  BRIDGE_VERSION,
  CAPABILITIES,
  EXT_SOURCE,
  PAGE_SOURCE,
  toPageMessage,
  type EngineStatusWire,
  type FromPageMessage,
} from "./bridgeSchema.ts";
import {
  engineLevels,
  getTempoOverride,
  setMainGain,
  setTempoOverride,
  companionDeck,
  useCompanion,
} from "../store/companionEngine.ts";

export interface BridgeSnapshot {
  sessionName: string | null;
  bpm: number | null;
  playing: boolean;
  engine: EngineStatusWire;
  tempoOverride: number | null;
}

export interface BridgeHost {
  snapshot(): BridgeSnapshot;
  /** Subscribe to snapshot-relevant changes; returns the unsubscribe. */
  onChange(push: () => void): () => void;
  play(): void;
  stop(): void;
  setBpm(bpm: number): void;
  setTempoOverride(bpm: number | null): void;
  setMainGain(value: number): void;
  levels(): { rms: number; peak: number };
}

/** ~30 Hz — the meter stream. The mixer paints on rAF from the latest frame. */
const LEVELS_INTERVAL_MS = 33;

/**
 * Below this remaining delay a scheduled restart fires immediately: a setTimeout this short adds
 * more jitter than it removes, and the deadline has effectively arrived.
 */
const RESTART_IMMEDIATE_MS = 20;

export function createBridge(host: BridgeHost, post: (msg: FromPageMessage) => void) {
  let lastMainGain = 1;
  let levelsTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let warnedInvalid = false;

  const pushState = () => post({ type: "state", ...host.snapshot(), lastMainGain });

  const stopLevels = () => {
    if (levelsTimer) {
      clearInterval(levelsTimer);
      levelsTimer = null;
    }
  };

  const handle = (raw: unknown): void => {
    const parsed = toPageMessage.safeParse(raw);
    if (!parsed.success) {
      // One warning, not one per message — a version-skewed extension would otherwise spam.
      if (!warnedInvalid) {
        warnedInvalid = true;
        console.warn("scoopy bridge: dropping unrecognised message", raw);
      }
      return;
    }
    const msg = parsed.data;
    switch (msg.type) {
      case "hello":
        post({ type: "helloAck", bridgeVersion: BRIDGE_VERSION, capabilities: [...CAPABILITIES] });
        pushState();
        break;
      case "getState":
        pushState();
        break;
      case "subscribe":
        unsubscribe ??= host.onChange(pushState);
        if (msg.levels && !levelsTimer) {
          levelsTimer = setInterval(() => post({ type: "levels", ...host.levels() }), LEVELS_INTERVAL_MS);
        } else if (!msg.levels) {
          stopLevels();
        }
        pushState();
        break;
      case "unsubscribe":
        stopLevels();
        unsubscribe?.();
        unsubscribe = null;
        break;
      case "play":
        host.play();
        break;
      case "stop":
        host.stop();
        break;
      case "restartAt": {
        // stop→play resets the engine's masterStep (a mid-play republish would NOT — it re-latches
        // at the boundary). Two windows given the same epochMs land within setTimeout jitter of
        // each other; the residual constant offset is what the mixer's nudge is for.
        const go = () => {
          restartTimer = null;
          host.stop();
          host.play();
        };
        if (restartTimer) clearTimeout(restartTimer);
        const delay = msg.epochMs - (performance.timeOrigin + performance.now());
        if (delay <= RESTART_IMMEDIATE_MS) go();
        else restartTimer = setTimeout(go, delay);
        break;
      }
      case "setBpm":
        host.setBpm(msg.bpm);
        break;
      case "setTempoOverride":
        host.setTempoOverride(msg.bpm);
        pushState();
        break;
      case "setMainGain":
        // No pushState echo: the mixer sends these at fader rate and knows what it sent.
        lastMainGain = msg.value;
        host.setMainGain(msg.value);
        break;
    }
  };

  const dispose = () => {
    stopLevels();
    unsubscribe?.();
    unsubscribe = null;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = null;
  };

  return { handle, dispose };
}

/** The real host — the companion store + module-scoped engine hooks. */
export const storeBridgeHost: BridgeHost = {
  snapshot() {
    // DECK 0. The DJ-mixer bridge is the browser companion's, and the companion
    // is one session by definition — a second deck has no representation on the
    // other side of this bridge to report to.
    const s = useCompanion.getState();
    const d = companionDeck();
    return {
      sessionName: d.session?.name ?? null,
      bpm: (d.session?.pattern.bpm as number | undefined) ?? null,
      playing: d.playing,
      engine: s.engine,
      tempoOverride: getTempoOverride(),
    };
  },
  onChange(push) {
    // The store publishes many fields the bridge does not care about (notices, decode failures…);
    // push only when the snapshot-relevant tuple actually moved.
    const key = () => JSON.stringify(storeBridgeHost.snapshot());
    let prev = key();
    return useCompanion.subscribe(() => {
      const next = key();
      if (next !== prev) {
        prev = next;
        push();
      }
    });
  },
  play: () => useCompanion.getState().play(),
  stop: () => useCompanion.getState().stop(),
  setBpm: (bpm) => useCompanion.getState().setBpm(bpm),
  setTempoOverride,
  setMainGain,
  levels: engineLevels,
};

let installed = false;

export function initCompanionBridge(): void {
  if (installed) return;
  if (new URLSearchParams(window.location.search).get("host") !== "browser") return;
  installed = true;

  const bridge = createBridge(storeBridgeHost, (msg) => {
    window.postMessage({ source: PAGE_SOURCE, msg }, window.location.origin);
  });
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const data = e.data as { source?: unknown; msg?: unknown } | null;
    if (!data || data.source !== EXT_SOURCE) return;
    bridge.handle(data.msg);
  });
}
