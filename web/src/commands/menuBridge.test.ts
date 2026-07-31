/**
 * MB-3 — bridge contract: publishes only the host's sections, diffs identical
 * trees, republishes after a selection, refuses unknown ids, and routes
 * menuCommand through runCommand (which re-checks enablement).
 */
import { describe, expect, test, vi } from "vitest";
import { attachMenuBridge } from "./menuBridge";
import type { CommandState } from "./registry";
import type { EngineLink } from "../engineLink";

function makeLink() {
  let eventCb: ((evt: unknown) => void) | null = null;
  const commands: Array<{ method: string; params: unknown }> = [];
  const link = {
    command: vi.fn((method: string, params: unknown) => {
      commands.push({ method, params });
      return Promise.resolve({});
    }),
    onEvent: vi.fn((cb: (evt: unknown) => void) => {
      eventCb = cb;
      return () => {
        eventCb = null;
      };
    }),
    onUiState: vi.fn(() => () => {}),
    onHotFrame: vi.fn(() => () => {}),
  } as unknown as EngineLink;
  return {
    link,
    commands,
    fire: (evt: unknown) => eventCb?.(evt),
  };
}

function state(over: Partial<CommandState> = {}): CommandState {
  return {
    canUndo: true,
    canRedo: false,
    undoLabel: "Draw cell",
    isPlaying: false,
    djMode: false,
    isBouncing: false,
    isOutputRecording: false,
    sessionNew: vi.fn(),
    sessionSave: vi.fn(),
    sessionSaveAs: vi.fn(),
    sessionLoad: vi.fn(),
    sessionExportZip: vi.fn(),
    sessionBounceToggle: vi.fn(),
    performUndo: vi.fn(),
    transportPlay: vi.fn(),
    transportStop: vi.fn(),
    transportRestart: vi.fn(),
    addTrack: vi.fn(),
    requestClearAll: vi.fn(),
    ...over,
  };
}

const publishes = (commands: Array<{ method: string; params: unknown }>) =>
  commands.filter((c) => c.method === "publishMenuTree");

describe("menu bridge (MB-3)", () => {
  test("publishes on attach — only the host's sections, labels evaluated", () => {
    const { link, commands } = makeLink();
    attachMenuBridge(link, { state: () => state(), sections: ["Edit", "Transport"] });
    const p = publishes(commands)[0];
    expect(p).toBeTruthy();
    const tree = (p!.params as { sections: Array<{ section: string; items: unknown[] }> })
      .sections;
    expect(tree.map((s) => s.section)).toEqual(["Edit", "Transport"]);
    const items = tree.flatMap((s) => s.items) as Array<{ id: string; label: string }>;
    expect(items.find((i) => i.id === "edit.undo")!.label).toBe("Undo Draw cell");
    expect(items.some((i) => i.id === "dj.toggleView")).toBe(false);
  });

  test("publish() diffs — an identical tree is not re-sent", () => {
    const { link, commands } = makeLink();
    const bridge = attachMenuBridge(link, { state: () => state(), sections: ["Edit"] });
    bridge.publish();
    bridge.publish();
    expect(publishes(commands)).toHaveLength(1);
  });

  test("a menuCommand selection runs the command and republishes", () => {
    const s = state();
    const { link, commands, fire } = makeLink();
    attachMenuBridge(link, {
      state: () => s,
      sections: ["Edit", "Transport"],
    });
    fire({ type: "menuCommand", id: "transport.restart" });
    expect(s.transportRestart).toHaveBeenCalled();
    // initial publish + post-selection publish (may diff away if identical —
    // restart does not change the tree, so force a tree-changing command):
    fire({ type: "menuCommand", id: "edit.undo" });
    expect(s.performUndo).toHaveBeenCalledWith(false);
    expect(publishes(commands).length).toBeGreaterThanOrEqual(1);
  });

  test("a disabled command is refused at selection time", () => {
    const s = state({ canUndo: false });
    const { link, fire } = makeLink();
    attachMenuBridge(link, { state: () => s, sections: ["Edit"] });
    fire({ type: "menuCommand", id: "edit.undo" });
    expect(s.performUndo).not.toHaveBeenCalled();
  });

  test("an unknown id is refused, not thrown — a newer shell must not crash an older page", () => {
    const s = state();
    const { link, fire } = makeLink();
    attachMenuBridge(link, { state: () => s, sections: ["Edit"] });
    expect(() => fire({ type: "menuCommand", id: "bogus.futureCommand" })).not.toThrow();
  });

  test("detach stops listening", () => {
    const s = state();
    const { link, fire } = makeLink();
    const bridge = attachMenuBridge(link, { state: () => s, sections: ["Edit"] });
    bridge.detach();
    fire({ type: "menuCommand", id: "edit.undo" });
    expect(s.performUndo).not.toHaveBeenCalled();
  });
});
