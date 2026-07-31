/**
 * MB-2 — registry invariants. These pin the properties the shells rely on:
 * stable unique ids (they are wire identities), collision-free shortcuts
 * (NSMenu silently steals dupes), refusal of disabled commands (a shell with
 * stale enablement must not execute through the registry), and the label
 * functions that flip.
 */
import { describe, expect, test, vi } from "vitest";
import {
  COMMANDS,
  MENU_SECTIONS,
  command,
  menuTree,
  runCommand,
  type CommandState,
  type KeyEquivalent,
} from "./registry";

function state(over: Partial<CommandState> = {}): CommandState {
  return {
    canUndo: true,
    canRedo: true,
    undoLabel: null,
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

const shortcutKey = (k: KeyEquivalent) =>
  `${k.cmd ? "cmd+" : ""}${k.shift ? "shift+" : ""}${k.alt ? "alt+" : ""}${k.ctrl ? "ctrl+" : ""}${k.code}`;

describe("command registry (MB-2)", () => {
  test("ids are unique — they are wire identities", () => {
    const ids = COMMANDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("declared shortcuts never collide — NSMenu silently steals duplicates", () => {
    const keys = COMMANDS.flatMap((c) => (c.shortcut ? [shortcutKey(c.shortcut)] : []));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every command sits in a declared section", () => {
    for (const c of COMMANDS) expect(MENU_SECTIONS).toContain(c.section);
  });

  test("menuTree renders sections in bar order, skipping empty ones", () => {
    const tree = menuTree(state());
    const order = tree.map((s) => s.section);
    expect(order).toEqual(MENU_SECTIONS.filter((s) => order.includes(s)));
    for (const sec of tree) expect(sec.items.length).toBeGreaterThan(0);
  });

  test("labels flip with state: Play/Pause", () => {
    // ⚠️ `dj.toggleView` was the second half of this pin and is RETIRED
    // (B1-RETIRE). It flipped between "Switch to DJ Mode" and "Switch to
    // Compose Mode" and called `toggleDjMode` — a verb no host ever answered.
    // There is no DJ mode to switch to any more: the expanded deck tile IS the
    // deck view (D-SL-DECKFULL-01), reached by a strip's ⤢ rather than a global
    // mode. The Play/Pause half is the live law and stays.
    const find = (tree: ReturnType<typeof menuTree>, id: string) =>
      tree.flatMap((s) => s.items).find((i) => i.id === id)!;
    expect(find(menuTree(state({ isPlaying: false })), "transport.playPause").label).toBe("Play");
    expect(find(menuTree(state({ isPlaying: true })), "transport.playPause").label).toBe("Pause");
  });

  test("undo label carries what it will undo, and enablement follows the stack", () => {
    const s = state({ undoLabel: "Draw cell", canUndo: true });
    const label = command("edit.undo").label;
    expect(typeof label === "function" ? label(s) : label).toBe("Undo Draw cell");
    const tree = menuTree(state({ canUndo: false, canRedo: false }));
    const items = tree.flatMap((t) => t.items);
    expect(items.find((i) => i.id === "edit.undo")!.enabled).toBe(false);
    expect(items.find((i) => i.id === "edit.redo")!.enabled).toBe(false);
  });

  test("runCommand REFUSES a disabled command — stale shell enablement must not execute", () => {
    const s = state({ canUndo: false });
    expect(runCommand("edit.undo", s)).toBe(false);
    expect(s.performUndo).not.toHaveBeenCalled();
  });

  test("runCommand drives the wire hooks", () => {
    const s = state();
    expect(runCommand("edit.undo", s)).toBe(true);
    expect(s.performUndo).toHaveBeenCalledWith(false);
    runCommand("edit.redo", s);
    expect(s.performUndo).toHaveBeenCalledWith(true);
    runCommand("transport.restart", s);
    expect(s.transportRestart).toHaveBeenCalled();
    runCommand("pattern.clearAll", s);
    expect(s.requestClearAll).toHaveBeenCalled();
    runCommand("track.add", s);
    expect(s.addTrack).toHaveBeenCalled();
  });

  test("stop is a no-op while stopped (enabled gates it)", () => {
    const s = state({ isPlaying: false });
    expect(runCommand("transport.stop", s)).toBe(false);
    expect(s.transportStop).not.toHaveBeenCalled();
  });
});
