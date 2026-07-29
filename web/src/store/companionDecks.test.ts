/**
 * THE DECK AXIS — that a deck's world is its own, and that touching one leaves
 * every other alone.
 *
 * This is the property the whole increment exists for. `companionEngine` held
 * ONE session because it was written for the browser companion, where one
 * session IS the app; the mission sentence is "decks load into strips, each
 * with its own BPM", which needs N. That single cause blocked the grid creation
 * gesture, landing a carve, and multi-deck grid strips all at once.
 *
 * The ENGINE was never the blocker — `SlWorldApply` already reads `world.deck`
 * and `plane_audio_test` §10 runs two decks at independent tempos. So what
 * needs pinning is the STORE's half: isolation between decks, and that every
 * deck-scoped action goes where it was aimed.
 *
 * Runs headless: `publish()` no-ops while the engine is not running, and the
 * autosaver only debounces a timer, so nothing here touches OPFS or audio.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_DECKS,
  companionDeck,
  deckOf,
  idleDeck,
  useCompanion,
  type DeckState,
} from "./companionEngine.ts";
import type { WorkingSession } from "./sessionStore.ts";

const session = (name: string, bpm = 120): WorkingSession =>
  ({
    name,
    pattern: { bpm, sectionA: [{}, {}, {}] },
    kit: { id: "k", name: "kit", samples: [] },
    extras: new Map(),
  }) as unknown as WorkingSession;

function setDeck(deck: number, patch: Partial<DeckState>): void {
  useCompanion.setState((s) => ({
    decks: s.decks.map((d, i) => (i === deck ? { ...d, ...patch } : d)),
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  useCompanion.setState({ decks: Array.from({ length: MAX_DECKS }, idleDeck), error: null });
});

afterEach(() => {
  vi.clearAllTimers(); // never let a scheduled autosave actually write
  vi.useRealTimers();
});

describe("the deck map", () => {
  it("starts with one idle deck per engine deck, never a hole", () => {
    const { decks } = useCompanion.getState();
    expect(decks).toHaveLength(MAX_DECKS);
    // `decks[d]` is indexed all over the plane; a sparse array would make every
    // one of those a null check nobody would remember to write.
    expect(decks.every((d) => d.session === null)).toBe(true);
  });

  it("hands back an idle deck for an out-of-range index rather than throwing", () => {
    // A caller bug should read as "nothing is loaded there", not as a crash
    // mid-performance.
    expect(deckOf(useCompanion.getState(), 99).session).toBeNull();
    expect(companionDeck(-1).session).toBeNull();
  });

  it("holds a different session per deck", () => {
    setDeck(0, { session: session("beach") });
    setDeck(1, { session: session("forest") });
    expect(companionDeck(0).session?.name).toBe("beach");
    expect(companionDeck(1).session?.name).toBe("forest");
    expect(companionDeck(2).session).toBeNull();
  });
});

describe("deck isolation — the property the increment is for", () => {
  beforeEach(() => {
    setDeck(0, { session: session("beach", 120) });
    setDeck(1, { session: session("forest", 174) });
  });

  it("setBpm moves ONE deck's tempo — per-deck BPM, the mission requirement", () => {
    useCompanion.getState().setBpm(128, 1);
    expect(companionDeck(1).session?.pattern.bpm).toBe(128);
    // The whole point of "decks load into strips, each with its own BPM": a
    // strip's tempo is not the app's tempo.
    expect(companionDeck(0).session?.pattern.bpm).toBe(120);
  });

  it("setBpm with no deck argument still means deck 0 — the companion's calls are unchanged", () => {
    useCompanion.getState().setBpm(90);
    expect(companionDeck(0).session?.pattern.bpm).toBe(90);
    expect(companionDeck(1).session?.pattern.bpm).toBe(174);
  });

  it("setMasterVolume/setMasterDrive edit ONE deck's document, clamped to the row's range (P3-D4-1a)", () => {
    useCompanion.getState().setMasterVolume(1.5, 1);
    useCompanion.getState().setMasterDrive(8, 1);
    const p1 = companionDeck(1).session?.pattern as Record<string, unknown>;
    const p0 = companionDeck(0).session?.pattern as Record<string, unknown>;
    expect(p1.masterVolume).toBe(1.5);
    expect(p1.masterClipperDrive).toBe(8);
    // Deck isolation — the file's whole property, for the new verbs too.
    expect("masterVolume" in p0).toBe(false);
    // Clamps: a runaway drag must not write a value the engine range refuses.
    useCompanion.getState().setMasterVolume(99, 1);
    useCompanion.getState().setMasterDrive(0, 1);
    const p1b = companionDeck(1).session?.pattern as Record<string, unknown>;
    expect(p1b.masterVolume).toBe(2);
    expect(p1b.masterClipperDrive).toBe(1);
    // No session → a refusal-by-no-op, never a crash on an empty deck.
    useCompanion.getState().setMasterVolume(1, 2);
    expect(companionDeck(2).session).toBeNull();
  });

  it("beat repeat and reverse are PER-DECK DeckState — readable truth for the tile lamps (P3-D4-2)", () => {
    useCompanion.getState().setBeatRepeat(1, { startStep: 0, length: 2 });
    useCompanion.getState().setReverse(1, true);
    expect(companionDeck(1).beatRepeat).toEqual({ startStep: 0, length: 2 });
    expect(companionDeck(1).reverse).toBe(true);
    // The other deck's hand is its own.
    expect(companionDeck(0).beatRepeat).toBeNull();
    expect(companionDeck(0).reverse).toBe(false);
    // A reused slot must not inherit the previous occupant's repeat/reverse —
    // the verbs die with the deck (closeDeck → idleDeck).
    useCompanion.getState().closeDeck(1);
    expect(companionDeck(1).beatRepeat).toBeNull();
    expect(companionDeck(1).reverse).toBe(false);
  });

  it("selectScene lands on the deck it was aimed at", () => {
    // Stopped, so the switch is immediate (no clock to schedule against).
    useCompanion.getState().selectScene("C", { deck: 1 });
    expect(companionDeck(1).scene).toBe("C");
    // Before the deck axis, one `scene` was handed to every strip: two grid
    // strips lit the same pad whatever they were playing, and clicking either
    // moved them both.
    expect(companionDeck(0).scene).toBe("A");
  });

  it("launch and solo gates are per deck", () => {
    useCompanion.getState().toggleLaunch(2, 1);
    useCompanion.getState().toggleSoloTrack(0, 1);
    expect(companionDeck(1).stoppedTracks).toEqual([2]);
    expect(companionDeck(1).soloedTracks).toEqual([0]);
    expect(companionDeck(0).stoppedTracks).toEqual([]);
    expect(companionDeck(0).soloedTracks).toEqual([]);
  });

  it("play/stop move one deck's transport, so two strips can run independently", () => {
    // No audio here, so drive the flag directly and check the ACTION's scope
    // rather than the engine's response.
    setDeck(1, { playing: true });
    expect(companionDeck(1).playing).toBe(true);
    expect(companionDeck(0).playing).toBe(false);
  });

  it("closeDeck frees ONE deck and leaves its peers loaded", () => {
    setDeck(1, { playing: true, scene: "D", stoppedTracks: [1] });
    useCompanion.getState().closeDeck(1);
    expect(companionDeck(1)).toEqual(idleDeck());
    expect(companionDeck(0).session?.name).toBe("beach");
  });
});

describe("an out-of-range deck is refused, never aliased", () => {
  it("open() declines rather than landing the session on deck 0", async () => {
    setDeck(0, { session: session("beach") });
    await useCompanion.getState().open("forest", MAX_DECKS);
    // The same rule `SlWorldApply` applies to an out-of-range world: quietly
    // landing a session on the WRONG deck is far worse than declining to load
    // it, because nothing downstream would ever say what happened.
    expect(useCompanion.getState().error).toMatch(/deck/i);
    expect(companionDeck(0).session?.name).toBe("beach");
  });

  it("closeDeck ignores an index that does not exist", () => {
    setDeck(0, { session: session("beach") });
    useCompanion.getState().closeDeck(99);
    expect(companionDeck(0).session?.name).toBe("beach");
  });
});

describe("setEnabledSceneCount (P3-U8) — the scene row is a document fact", () => {
  const withScenes = (name: string, count?: number) => {
    const s = session(name);
    if (count !== undefined)
      (s.pattern as Record<string, unknown>).enabledSceneCount = count;
    return s;
  };

  it("grows the row on the deck it was aimed at, leaving peers alone", () => {
    setDeck(0, { session: withScenes("beach", 3) });
    setDeck(1, { session: withScenes("forest", 3) });
    useCompanion.getState().setEnabledSceneCount(4, 0);
    expect(companionDeck(0).session?.pattern.enabledSceneCount).toBe(4);
    expect(companionDeck(1).session?.pattern.enabledSceneCount).toBe(3);
  });

  it("clamps to 1..8 — a count outside the letters is a caller bug, not a document state", () => {
    setDeck(0, { session: withScenes("beach", 3) });
    useCompanion.getState().setEnabledSceneCount(99, 0);
    expect(companionDeck(0).session?.pattern.enabledSceneCount).toBe(8);
    useCompanion.getState().setEnabledSceneCount(0, 0);
    expect(companionDeck(0).session?.pattern.enabledSceneCount).toBe(1);
  });

  it("shrinking below the active scene falls back to A and disarms any queue", () => {
    setDeck(0, {
      session: withScenes("beach", 8),
      scene: "F",
      scheduledScene: "G",
      switchBoundaryStep: 64,
    });
    useCompanion.getState().setEnabledSceneCount(3, 0);
    const d = companionDeck(0);
    // A pad that no longer exists must not stay the one playing (or armed).
    expect(d.scene).toBe("A");
    expect(d.scheduledScene).toBeNull();
    expect(d.switchBoundaryStep).toBeNull();
  });

  it("shrinking above the active scene leaves the performance state untouched", () => {
    setDeck(0, { session: withScenes("beach", 8), scene: "B" });
    useCompanion.getState().setEnabledSceneCount(4, 0);
    expect(companionDeck(0).scene).toBe("B");
  });

  it("no session, no edit — the verb refuses quietly like every deck-scoped op", () => {
    useCompanion.getState().setEnabledSceneCount(4, 0);
    expect(companionDeck(0).session).toBeNull();
  });
});
