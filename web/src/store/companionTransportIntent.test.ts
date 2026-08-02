/**
 * WHICH PUBLISHES ARE TRANSPORT (real-host report, 2026-08-02).
 *
 * "Start playback through the DAW, then operate any control in the plugin
 * window, and playback stops." The store publishes a whole world for every edit
 * and every one of them carries `isPlaying` — so in ScoopyDeck, where the HOST
 * can start the deck without this store ever hearing about it, a content
 * publish was overruling the DAW's transport. The processor now refuses an
 * unstated transport flag while it owns the run (`hostOwnsTransport`), which
 * only works if the doors that really ARE transport keep saying so.
 *
 * That makes `transportIntent` a two-sided contract, and this pins THIS side:
 * ▸ · ◼ · the one-shot · a deck being closed state it, and nothing else does.
 * Get it wrong in one direction and a knob stops the music again; wrong in the
 * other and ◼ cannot stop a deck the DAW is rolling.
 *
 * The sink is faked because the real one is chosen at import time by whether a
 * JUCE backend exists — the point here is what the STORE says, not where it goes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every publish the store made, in order. */
const published: { deck: number; isPlaying: boolean; intent: boolean }[] = [];

vi.mock("../audio/scoopyAudio.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../audio/scoopyAudio.ts")>();
  return {
    ...actual,
    ScoopyAudio: class {
      running = true;
      error = null;
      async start() {}
      async resume() {}
      registerSample() {}
      publish(world: { isPlaying: boolean }, deck = 0, transportIntent = false) {
        published.push({ deck, isPlaying: world.isPlaying, intent: transportIntent });
      }
      setMainGain() {}
      position() {
        return null;
      }
      onPosition() {
        return () => {};
      }
      level() {
        return 0;
      }
      levels() {
        return { rms: 0, peak: 0 };
      }
    },
  };
});

const { MAX_DECKS, idleDeck, useCompanion } = await import("./companionEngine.ts");
type WorkingSession = import("./sessionStore.ts").WorkingSession;

const session = (name: string): WorkingSession =>
  ({
    name,
    pattern: { bpm: 120, sectionA: [{}, {}, {}] },
    kit: { id: "k", name: "kit", samples: [] },
    extras: new Map(),
  }) as unknown as WorkingSession;

beforeEach(() => {
  vi.useFakeTimers();
  published.length = 0;
  useCompanion.setState({ decks: Array.from({ length: MAX_DECKS }, idleDeck), error: null });
  useCompanion.setState((s) => ({
    decks: s.decks.map((d, i) => (i === 0 ? { ...d, session: session("beach") } : d)),
  }));
});

afterEach(() => {
  vi.clearAllTimers(); // never let a scheduled autosave actually write
  vi.useRealTimers();
});

describe("transportIntent — the publishes that ARE the transport", () => {
  it("▸ states it", () => {
    useCompanion.getState().play(0);
    expect(published.at(-1)).toEqual({ deck: 0, isPlaying: true, intent: true });
  });

  it("◼ states it — the half that keeps a DAW-rolled deck stoppable", () => {
    useCompanion.getState().play(0);
    useCompanion.getState().stop(0);
    expect(published.at(-1)).toEqual({ deck: 0, isPlaying: false, intent: true });
  });

  it("the one-shot states it, going in", () => {
    useCompanion.getState().playOnce(0);
    expect(published.at(-1)?.intent).toBe(true);
  });

  it("closing a deck states it — the deck is LEAVING, not being edited", () => {
    useCompanion.getState().play(0);
    published.length = 0;
    useCompanion.getState().closeDeck(0);
    expect(published.at(-1)).toEqual({ deck: 0, isPlaying: false, intent: true });
  });
});

describe("transportIntent — the publishes that are CONTENT", () => {
  it("a transport VERB on a playing deck says nothing about transport", () => {
    useCompanion.getState().play(0);
    published.length = 0;
    // Beat repeat and reverse ride the world (P3-M-1b) but are not the
    // transport: they neither start nor stop the deck.
    useCompanion.getState().setReverse(0, true);
    expect(published.at(-1)).toEqual({ deck: 0, isPlaying: true, intent: false });
  });

  it("a stopped deck's edit stays silent about transport — the bug, exactly", () => {
    // The deck's own flag is false because the HOST started it and this store
    // was never told. If this publish claimed transport, the processor would
    // obey it and the music would stop — which is the reported defect.
    useCompanion.getState().setReverse(0, true);
    expect(published.at(-1)).toEqual({ deck: 0, isPlaying: false, intent: false });
  });
});
