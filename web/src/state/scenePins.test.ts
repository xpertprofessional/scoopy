import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneUiState } from "../../protocol/schema.ts";
import {
  attachScenePins,
  buildScenePinItems,
  isPinnableKey,
  isPinnedToCurrentScene,
  useScenePinStore,
  type ScenePinTarget,
} from "./scenePins.ts";
import { MAX_DECKS, idleDeck, useCompanion } from "../store/companionEngine.ts";
import type { WorkingSession } from "../store/sessionStore.ts";

/** The sets Swift publishes (BeatSequencer :10938/:10945), trimmed to what we assert. */
const scene = (over: Partial<SceneUiState> = {}): SceneUiState => ({
  enabled: ["A", "B"],
  current: "A",
  queued: [],
  loopEnabled: false,
  switchMode: "scheduled",
  cleanCut: false,
  latched: false,
  muted: false,
  canAdd: false,
  sceneLabel: "1",
  pinnedKeys: [],
  pinnableMasterKeys: ["bpm", "masterVolume", "masterClipperDrive"],
  pinnableTrackFields: ["volume", "pan", "tone", "trackGain", "globalPitchOffset", "chokeGroup"],
  scenesWithOverrides: [],
  muteGroupCount: 0,
  ...over,
});

const PAN: ScenePinTarget = { key: "track.3.pan" };
const noop = { pin: () => {}, unpin: () => {}, pushToAll: () => {} };
const labels = (s: SceneUiState, t: ScenePinTarget) =>
  buildScenePinItems(t, s, noop).map((i) => (i.kind === "sep" ? "—" : i.label));

/** Pure mirror of BeatSequencer.isPinnableKey (:10956). */
describe("isPinnableKey", () => {
  const s = scene();

  it("accepts master keys and track.<row>.<field>", () => {
    expect(isPinnableKey("bpm", s)).toBe(true);
    expect(isPinnableKey("masterClipperDrive", s)).toBe(true);
    expect(isPinnableKey("track.0.volume", s)).toBe(true);
    expect(isPinnableKey("track.12.chokeGroup", s)).toBe(true);
  });

  /**
   * Sends are deliberately NOT pinnable — they are performative live values
   * (BeatSequencer :10943). Native's send boxes therefore show an EMPTY scene
   * section, which is why the web must not offer one either: a menu item that
   * appears to work and silently does nothing is the worst outcome.
   */
  it("rejects sends", () => {
    expect(isPinnableKey("track.0.send1Level", s)).toBe(false);
    expect(labels(s, { key: "track.0.send1Level" })).toEqual([]);
  });

  it("rejects malformed keys", () => {
    expect(isPinnableKey("", s)).toBe(false);
    expect(isPinnableKey("track.pan", s)).toBe(false); // no row
    expect(isPinnableKey("track.x.pan", s)).toBe(false); // row not an int
    expect(isPinnableKey("track.0.nonsense", s)).toBe(false);
    expect(isPinnableKey("bogus", s)).toBe(false);
  });
});

describe("buildScenePinItems", () => {
  it("offers the pin when the key is global", () => {
    expect(labels(scene(), PAN)).toEqual(["Make Scene-Specific (Scene 1)"]);
  });

  it("names the CURRENT scene in the pin label", () => {
    expect(labels(scene({ sceneLabel: "4" }), PAN)).toEqual([
      "Make Scene-Specific (Scene 4)",
    ]);
  });

  it("offers the inverse pair once pinned", () => {
    const s = scene({ pinnedKeys: ["track.3.pan"] });
    expect(isPinnedToCurrentScene("track.3.pan", s)).toBe(true);
    expect(labels(s, PAN)).toEqual(["Reset to Global", "Push Value to All Scenes"]);
  });

  it("renders nothing for a non-pinnable key (native's guard)", () => {
    expect(buildScenePinItems({ key: "track.0.swing" }, scene(), noop)).toEqual([]);
  });

  it("routes each action to the clicked key", () => {
    const pin = vi.fn();
    const unpin = vi.fn();
    const pushToAll = vi.fn();
    for (const i of buildScenePinItems(PAN, scene(), { pin, unpin, pushToAll })) {
      if (i.kind === "item") i.onSelect();
    }
    expect(pin).toHaveBeenCalledWith(PAN);

    const pinned = scene({ pinnedKeys: ["track.3.pan"] });
    for (const i of buildScenePinItems(PAN, pinned, { pin, unpin, pushToAll })) {
      if (i.kind === "item") i.onSelect();
    }
    expect(unpin).toHaveBeenCalledWith(PAN);
    expect(pushToAll).toHaveBeenCalledWith(PAN);
  });
});

/**
 * B2 — THE DOOR, which is what this whole mechanism was missing.
 *
 * Every piece of the pin UI has existed for phases: `buildScenePinItems` builds
 * the menu, `useScenePinned` rings the control, `DragBox` wires both, and
 * `MasterRow` has been passing `scenePin={{ key: "bpm", deck }}` all along. The
 * store behind them mirrored a `scenes` UiState topic that NOTHING has ever
 * published, so `state` sat at EMPTY, `isPinnableKey` was false for every key,
 * and the menu section rendered as `[]` — structurally invisible rather than
 * broken. These pin the repointing.
 */
describe("the pin menu, fed from the companion (B2)", () => {
  const session = (name: string) =>
    ({
      name,
      pattern: { bpm: 120, sectionA: [{}, {}] },
      kit: { id: "k", name: "kit", samples: [] },
      extras: new Map(),
    }) as unknown as WorkingSession;

  beforeEach(() => {
    useCompanion.setState({ decks: Array.from({ length: MAX_DECKS }, idleDeck) });
  });

  it("offers NOTHING while no session is loaded, exactly as before", () => {
    const off = attachScenePins(0);
    expect(buildScenePinItems({ key: "bpm" }, useScenePinStore.getState().state)).toEqual([]);
    off();
  });

  it("offers the pin item once a deck has a document — the door opens", () => {
    useCompanion.setState((s) => ({
      decks: s.decks.map((d, i) => (i === 0 ? { ...d, session: session("beach") } : d)),
    }));
    const off = attachScenePins(0);
    const items = buildScenePinItems({ key: "bpm" }, useScenePinStore.getState().state);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ label: expect.stringContaining("Make Scene-Specific") });
    off();
  });

  it("flips to Reset/Push once the key is pinned, and rings the control", () => {
    useCompanion.setState((s) => ({
      decks: s.decks.map((d, i) => (i === 0 ? { ...d, session: session("beach") } : d)),
    }));
    const off = attachScenePins(0);
    useCompanion.getState().pinToScene("bpm", 0);
    const state = useScenePinStore.getState().state;
    expect(isPinnedToCurrentScene("bpm", state)).toBe(true);
    expect(buildScenePinItems({ key: "bpm" }, state).map((i) => (i as { label: string }).label))
      .toEqual(["Reset to Global", "Push Value to All Scenes"]);
    off();
  });

  it("offers nothing for a key the projection does not honour", () => {
    // `trackRowControls` passes `track.<i>.sampleStartMs`, which the donor allows
    // and our projection ignores. The menu must stay EMPTY for it rather than
    // storing a pin that changes nothing audible.
    useCompanion.setState((s) => ({
      decks: s.decks.map((d, i) => (i === 0 ? { ...d, session: session("beach") } : d)),
    }));
    const off = attachScenePins(0);
    expect(
      buildScenePinItems({ key: "track.0.sampleStartMs" }, useScenePinStore.getState().state),
    ).toEqual([]);
    off();
  });

  it("names the CURRENT scene in the pin label, not always scene 1", () => {
    useCompanion.setState((s) => ({
      decks: s.decks.map((d, i) => (i === 0 ? { ...d, session: session("beach"), scene: "C" } : d)),
    }));
    const off = attachScenePins(0);
    const [item] = buildScenePinItems({ key: "bpm" }, useScenePinStore.getState().state);
    expect((item as { label: string }).label).toContain("Scene 3");
    off();
  });
});
