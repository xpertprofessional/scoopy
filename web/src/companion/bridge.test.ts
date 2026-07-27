/**
 * The bridge, driven the way the extension drives it — through `handle` with
 * raw (untrusted) payloads — plus the two store-side laws the mixer depends
 * on: the performance tempo override wins over the document bpm, and it NEVER
 * schedules an autosave (riding a sync fader must not rewrite the session).
 *
 * Runs in node: the store/engine sit behind BridgeHost here, and the
 * store-level assertions never start the audio (publish() no-ops when the
 * engine is not running — which is exactly what lets these run headless).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BRIDGE_VERSION,
  CAPABILITIES,
  fromPageMessage,
  toPageMessage,
  type FromPageMessage,
} from "./bridgeSchema.ts";
import { createBridge, storeBridgeHost, type BridgeHost } from "./companionBridge.ts";
import {
  getTempoOverride,
  resolveWorldBpm,
  setTempoOverride,
  companionDeck,
  useCompanion,
  type DeckState,
} from "../store/companionEngine.ts";
import type { WorkingSession } from "../store/sessionStore.ts";

function fakeHost(overrides: Partial<BridgeHost> = {}) {
  const calls: string[] = [];
  const host: BridgeHost = {
    snapshot: () => ({
      sessionName: "beach",
      bpm: 120,
      playing: false,
      engine: "running",
      tempoOverride: null,
    }),
    onChange: () => () => {},
    play: () => void calls.push("play"),
    stop: () => void calls.push("stop"),
    setBpm: (bpm) => void calls.push(`setBpm:${bpm}`),
    setTempoOverride: (bpm) => void calls.push(`setTempoOverride:${bpm}`),
    setMainGain: (v) => void calls.push(`setMainGain:${v}`),
    levels: () => ({ rms: 0.1, peak: 0.5 }),
    ...overrides,
  };
  return { host, calls };
}

function collect() {
  const out: FromPageMessage[] = [];
  return { out, post: (msg: FromPageMessage) => void out.push(msg) };
}

afterEach(() => {
  vi.useRealTimers();
  setTempoOverride(null);
  setDeck0({ session: null, playing: false });
});

/** Write deck 0's slice — the bridge and the keymap are the browser companion's,
    where one session IS the app, so every fixture here is deck 0. */
function setDeck0(patch: Partial<DeckState>): void {
  useCompanion.setState((s) => ({
    decks: s.decks.map((d, i) => (i === 0 ? { ...d, ...patch } : d)),
  }));
}

describe("bridgeSchema", () => {
  it("accepts every command the mixer sends and rejects garbage", () => {
    const valid: unknown[] = [
      { type: "hello" },
      { type: "subscribe", levels: true },
      { type: "restartAt", epochMs: 1_750_000_000_000 },
      { type: "setBpm", bpm: 128 },
      { type: "setTempoOverride", bpm: 91.5 },
      { type: "setTempoOverride", bpm: null },
      { type: "setMainGain", value: 0 },
    ];
    for (const msg of valid) expect(toPageMessage.safeParse(msg).success).toBe(true);

    const invalid: unknown[] = [
      null,
      "play",
      { type: "play", extra: undefined, bpm: NaN },
      { type: "setBpm", bpm: Infinity },
      { type: "setBpm", bpm: 0 }, // below the floor
      { type: "setMainGain", value: 99 }, // above the safety ceiling
      { type: "nope" },
    ];
    for (const msg of invalid.slice(3)) expect(toPageMessage.safeParse(msg).success).toBe(false);
    expect(toPageMessage.safeParse(invalid[0]).success).toBe(false);
    expect(toPageMessage.safeParse(invalid[1]).success).toBe(false);
  });

  it("helloAck tolerates capabilities this build has never heard of", () => {
    const ack = {
      type: "helloAck",
      bridgeVersion: BRIDGE_VERSION + 5,
      capabilities: [...CAPABILITIES, "hologram"],
    };
    expect(fromPageMessage.safeParse(ack).success).toBe(true);
  });
});

describe("createBridge", () => {
  it("answers hello with version + capabilities and a state push", () => {
    const { host } = fakeHost();
    const { out, post } = collect();
    createBridge(host, post).handle({ type: "hello" });

    expect(out[0]).toEqual({
      type: "helloAck",
      bridgeVersion: BRIDGE_VERSION,
      capabilities: [...CAPABILITIES],
    });
    expect(out[1]).toMatchObject({ type: "state", sessionName: "beach", bpm: 120, lastMainGain: 1 });
  });

  it("dispatches transport and tempo commands to the host", () => {
    const { host, calls } = fakeHost();
    const bridge = createBridge(host, collect().post);
    bridge.handle({ type: "play" });
    bridge.handle({ type: "setBpm", bpm: 133 });
    bridge.handle({ type: "setTempoOverride", bpm: 140.25 });
    bridge.handle({ type: "setMainGain", value: 0.5 });
    bridge.handle({ type: "stop" });
    expect(calls).toEqual([
      "play",
      "setBpm:133",
      "setTempoOverride:140.25",
      "setMainGain:0.5",
      "stop",
    ]);
  });

  it("drops invalid messages without touching the host", () => {
    const { host, calls } = fakeHost();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridge = createBridge(host, collect().post);
    bridge.handle({ type: "setBpm", bpm: NaN });
    bridge.handle({ type: "detonate" });
    expect(calls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1); // once, not per message
    warn.mockRestore();
  });

  it("streams levels at ~30 Hz while subscribed and stops on unsubscribe", () => {
    vi.useFakeTimers();
    const { host } = fakeHost();
    const { out, post } = collect();
    const bridge = createBridge(host, post);

    bridge.handle({ type: "subscribe", levels: true });
    vi.advanceTimersByTime(100);
    const levels = out.filter((m) => m.type === "levels");
    expect(levels.length).toBe(3);
    expect(levels[0]).toEqual({ type: "levels", rms: 0.1, peak: 0.5 });

    bridge.handle({ type: "unsubscribe" });
    vi.advanceTimersByTime(200);
    expect(out.filter((m) => m.type === "levels").length).toBe(3);
  });

  it("echoes lastMainGain through the next state push (the e2e probe)", () => {
    const { host } = fakeHost();
    const { out, post } = collect();
    const bridge = createBridge(host, post);
    bridge.handle({ type: "setMainGain", value: 0.25 });
    expect(out).toEqual([]); // no echo at fader rate
    bridge.handle({ type: "getState" });
    expect(out[0]).toMatchObject({ type: "state", lastMainGain: 0.25 });
  });

  it("restartAt in the past fires immediately: stop then play", () => {
    const { host, calls } = fakeHost();
    const bridge = createBridge(host, collect().post);
    bridge.handle({ type: "restartAt", epochMs: 0 });
    expect(calls).toEqual(["stop", "play"]);
  });

  it("restartAt in the future waits for the deadline", () => {
    vi.useFakeTimers();
    const { host, calls } = fakeHost();
    const bridge = createBridge(host, collect().post);
    const epochNow = performance.timeOrigin + performance.now();
    bridge.handle({ type: "restartAt", epochMs: epochNow + 500 });
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(calls).toEqual(["stop", "play"]);
  });
});

describe("store-side tempo laws", () => {
  const fakeSession = {
    name: "t",
    pattern: { bpm: 120 },
    kit: {},
    extras: new Map(),
  } as unknown as WorkingSession;

  it("the performance override wins over the document and releases cleanly", () => {
    expect(resolveWorldBpm(120, null)).toBe(120);
    expect(resolveWorldBpm(120, 91.5)).toBe(91.5);
    setTempoOverride(140);
    expect(getTempoOverride()).toBe(140);
    setTempoOverride(null);
    expect(getTempoOverride()).toBeNull();
  });

  it("setTempoOverride never schedules an autosave; setBpm (a document edit) does", () => {
    vi.useFakeTimers();
    setDeck0({ session: fakeSession });

    setTempoOverride(140);
    expect(vi.getTimerCount()).toBe(0);

    useCompanion.getState().setBpm(128);
    expect(vi.getTimerCount()).toBe(1);
    expect(companionDeck().session?.pattern.bpm).toBe(128);
    // The override still owns the engine clock; the document moved underneath it.
    expect(getTempoOverride()).toBe(140);

    vi.clearAllTimers(); // never let the autosave actually write (no OPFS in node)
  });

  it("storeBridgeHost snapshots the store and reports session bpm", () => {
    setDeck0({ session: fakeSession, playing: true });
    setTempoOverride(99);
    expect(storeBridgeHost.snapshot()).toEqual({
      sessionName: "t",
      bpm: 120,
      playing: true,
      engine: "idle",
      tempoOverride: 99,
    });
  });

  it("storeBridgeHost.onChange pushes only when the snapshot tuple moves", () => {
    let pushes = 0;
    const unsub = storeBridgeHost.onChange(() => pushes++);
    useCompanion.setState({ notice: "irrelevant to the bridge" });
    expect(pushes).toBe(0);
    setDeck0({ playing: true });
    expect(pushes).toBe(1);
    unsub();
    setDeck0({ playing: false });
    expect(pushes).toBe(1);
  });
});
