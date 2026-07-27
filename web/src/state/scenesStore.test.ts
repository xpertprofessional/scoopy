import { describe, expect, it, vi } from "vitest";
import type { SceneUiState } from "../../protocol/schema.ts";
import {
  nextSceneLabel,
  sceneDisplayLabel,
  sendSceneAdd,
  sendSceneClick,
  sendSceneCopyPattern,
  sendSceneMove,
  sendScenePastePattern,
  sendSceneRemove,
  sendSceneSwitchMode,
  sendSceneToggleLatch,
  sendSceneToggleMute,
} from "./scenesStore.ts";

// P5-05 scenes store: pure derivations + intent-sender modifier grammar
// (native PdSceneCell.handleClick parity — ContentView :13224–13236).

const state = (over: Partial<SceneUiState> = {}): SceneUiState => ({
  enabled: ["A", "B", "C", "D", "E", "F", "G", "H"],
  current: "A",
  queued: [],
  loopEnabled: false,
  switchMode: "scheduled",
  cleanCut: false,
  latched: false,
  muted: false,
  canAdd: false,
  // CM-3 scene-override fields (unused by these tests, but the topic carries them).
  sceneLabel: "1",
  pinnedKeys: [],
  pinnableMasterKeys: [],
  pinnableTrackFields: [],
  scenesWithOverrides: [],
  muteGroupCount: 0,
  ...over,
});

const fakeLink = () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  return {
    calls,
    link: {
      command: vi.fn((method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return Promise.resolve({});
      }),
      onUiState: vi.fn(() => () => {}),
      onHotFrame: vi.fn(() => () => {}),
    } as never,
  };
};

describe("scene derivations", () => {
  it("display labels are 1–8 by A–H position (persistence stays letters)", () => {
    expect(sceneDisplayLabel("A")).toBe("1");
    expect(sceneDisplayLabel("H")).toBe("8");
    expect(sceneDisplayLabel("X")).toBe("X"); // unknown passes through
  });

  it("add-slot label = next 1-based slot (native nextPatternSceneLetter)", () => {
    // scenes are always added A→H, so the label is just count+1
    expect(nextSceneLabel(state({ enabled: ["A", "B"], canAdd: true }))).toBe("3");
    expect(nextSceneLabel(state({ enabled: ["A", "B", "C", "D"], canAdd: true }))).toBe("5");
  });

  it("add slot hides when the grid is full or canAdd is false", () => {
    expect(nextSceneLabel(state({ canAdd: false }))).toBeNull(); // 8 enabled
    expect(nextSceneLabel(state({ enabled: ["A"], canAdd: false }))).toBeNull();
  });
});

describe("scene click modifier grammar (PdSceneCell parity)", () => {
  it("plain click activates via switch mode", () => {
    const f = fakeLink();
    sendSceneClick(f.link, 1, "B");
    expect(f.calls[0]).toEqual({
      method: "patternScene",
      params: { op: "activate", deck: 1, scene: "B", queue: false },
    });
  });

  it("shift-click adds to the loop queue", () => {
    const f = fakeLink();
    sendSceneClick(f.link, 0, "C", { shift: true });
    expect(f.calls[0]!.params).toEqual({ op: "activate", deck: 0, scene: "C", queue: true });
  });

  it("cmd-click = seamless immediate (running position)", () => {
    const f = fakeLink();
    sendSceneClick(f.link, 2, "D", { meta: true });
    expect(f.calls[0]!.params).toEqual({ op: "runImmediate", deck: 2, scene: "D" });
  });

  it("alt+shift-click = immediate from step 0 (beats cmd, native order)", () => {
    const f = fakeLink();
    sendSceneClick(f.link, 0, "E", { alt: true, shift: true, meta: true });
    expect(f.calls[0]!.params).toEqual({ op: "startImmediate", deck: 0, scene: "E" });
  });
});

describe("add / remove intents (P4-05e pads)", () => {
  it("add carries the deck but no scene (native addPatternScene appends A→H)", () => {
    const f = fakeLink();
    sendSceneAdd(f.link, 1);
    expect(f.calls[0]).toEqual({ method: "patternScene", params: { op: "add", deck: 1 } });
  });

  it("remove targets the clicked scene", () => {
    const f = fakeLink();
    sendSceneRemove(f.link, 2, "F");
    expect(f.calls[0]!.params).toEqual({ op: "remove", deck: 2, scene: "F" });
  });
});

describe("copy/paste pattern intents (menu bar ⇧⌘C/⇧⌘V rehomed — menubar.md §10)", () => {
  // Faithful to native copyCurrentSection/pasteToCurrentSection: they act on the
  // deck's CURRENT scene, so the intent carries only the deck — no scene arg.
  it("copy carries the deck but no scene (acts on the current scene)", () => {
    const f = fakeLink();
    sendSceneCopyPattern(f.link, 1);
    expect(f.calls[0]).toEqual({ method: "patternScene", params: { op: "copyPattern", deck: 1 } });
  });

  it("paste carries the deck but no scene", () => {
    const f = fakeLink();
    sendScenePastePattern(f.link, 2);
    expect(f.calls[0]).toEqual({ method: "patternScene", params: { op: "pastePattern", deck: 2 } });
  });
});

describe("per-deck isolation", () => {
  // Scenes are per-sequencer. A cluster mounted in deck B's transport section
  // must address deck B — never "whichever deck is selected". Every op that
  // mutates scene state therefore carries its own deck.
  it("every scene op carries the deck it was issued from", () => {
    const f = fakeLink();
    sendSceneClick(f.link, 2, "A");
    sendSceneMove(f.link, 2, "A", 1);
    sendSceneAdd(f.link, 2);
    sendSceneRemove(f.link, 2, "B");
    sendSceneSwitchMode(f.link, 2, "restartImmediate");
    sendSceneToggleLatch(f.link, 2);
    sendSceneToggleMute(f.link, 2);
    expect(f.calls).toHaveLength(7);
    for (const c of f.calls) {
      expect(c.method).toBe("patternScene");
      expect(c.params.deck).toBe(2); // never silently retargeted
    }
  });

  it("the same gesture on different decks produces different intents", () => {
    const f = fakeLink();
    sendSceneClick(f.link, 0, "C");
    sendSceneClick(f.link, 1, "C");
    expect(f.calls[0]!.params.deck).toBe(0);
    expect(f.calls[1]!.params.deck).toBe(1);
  });
});
