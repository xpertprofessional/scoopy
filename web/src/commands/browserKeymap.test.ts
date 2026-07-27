import { describe, expect, it } from "vitest";
import { claimKey } from "../design/keyForward.ts";
import { COMMANDS } from "./registry.ts";
import {
  browserBindings,
  isReservedShortcut,
  matchesShortcut,
  resolveKey,
  type KeyLike,
} from "./browserKeymap.ts";

/** A keydown, structurally — the matcher and resolver never need a real DOM event. */
const key = (over: Partial<KeyLike & { key: string; defaultPrevented: boolean; target: unknown }>) =>
  ({
    code: "KeyZ",
    key: "z",
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    defaultPrevented: false,
    target: null,
    ...over,
  }) as unknown as KeyboardEvent;

describe("matchesShortcut — exact modifier equality", () => {
  it("bare Z does not match ⌘Z; ⌘Z does not match ⇧⌘Z; ⇧⌘Z matches only itself", () => {
    const cmdZ = { code: "KeyZ", cmd: true as const };
    const shiftCmdZ = { code: "KeyZ", cmd: true as const, shift: true as const };
    expect(matchesShortcut(key({}), cmdZ)).toBe(false);
    expect(matchesShortcut(key({ metaKey: true }), cmdZ)).toBe(true);
    expect(matchesShortcut(key({ metaKey: true }), shiftCmdZ)).toBe(false);
    expect(matchesShortcut(key({ metaKey: true, shiftKey: true }), cmdZ)).toBe(false);
    expect(matchesShortcut(key({ metaKey: true, shiftKey: true }), shiftCmdZ)).toBe(true);
  });

  it("bare digits do not match the browser's ⌘digit tab chords", () => {
    const digit1 = { code: "Digit1" };
    expect(matchesShortcut(key({ code: "Digit1", key: "1" }), digit1)).toBe(true);
    expect(matchesShortcut(key({ code: "Digit1", key: "1", metaKey: true }), digit1)).toBe(false);
  });
});

describe("the binding table", () => {
  it("never binds an OS-reserved chord (⌘W/⌘T/⌘Q/F11 — MIGRATION.md P8-8)", () => {
    for (const b of browserBindings()) {
      expect(isReservedShortcut(b.shortcut)).toBe(false);
    }
    expect(isReservedShortcut({ code: "KeyW", cmd: true })).toBe(true);
    expect(isReservedShortcut({ code: "F11" })).toBe(true);
    expect(isReservedShortcut({ code: "KeyW" })).toBe(false); // bare w is fine
  });

  it("no two bindings collide on the same chord", () => {
    const seen = new Set<string>();
    for (const b of browserBindings()) {
      const sig = `${b.shortcut.code}/${!!b.shortcut.cmd}/${!!b.shortcut.shift}/${!!b.shortcut.alt}/${!!b.shortcut.ctrl}`;
      expect(seen.has(sig)).toBe(false);
      seen.add(sig);
    }
  });

  it("MB-6 seam: registry bindings are READ FROM COMMANDS, not re-declared", () => {
    const registry = browserBindings().filter((b) => b.source === "registry");
    expect(registry.map((b) => b.id)).toEqual(["edit.undo", "edit.redo"]);
    for (const b of registry) {
      // The shortcut object is the registry's own — delete the declaration there and
      // this binding disappears with it.
      expect(COMMANDS.find((c) => c.id === b.id)?.shortcut).toBe(b.shortcut);
    }
  });

  it("supplements: Space → playPause, bare 1-8 → scenes (and ONLY those)", () => {
    const browser = browserBindings().filter((b) => b.source === "browser");
    expect(browser[0]!.shortcut).toEqual({ code: "Space" });
    expect(browser[0]!.action).toEqual({ kind: "playPause" });
    const digits = browser.slice(1);
    expect(digits).toHaveLength(8);
    digits.forEach((b, i) => {
      expect(b.shortcut).toEqual({ code: `Digit${i + 1}` });
      expect(b.action).toEqual({ kind: "scene", index: i });
    });
  });
});

describe("resolveKey — the skip rules the relay also honours", () => {
  const bindings = browserBindings();

  it("matches ⌘Z to undo and Space to playPause", () => {
    expect(resolveKey(key({ metaKey: true }), bindings)?.action).toEqual({
      kind: "undo",
      redo: false,
    });
    expect(resolveKey(key({ code: "Space", key: " " }), bindings)?.action).toEqual({
      kind: "playPause",
    });
  });

  it("digit N resolves to scene index N-1; digit 9 resolves to nothing", () => {
    expect(resolveKey(key({ code: "Digit3", key: "3" }), bindings)?.action).toEqual({
      kind: "scene",
      index: 2,
    });
    expect(resolveKey(key({ code: "Digit9", key: "9" }), bindings)).toBeNull();
  });

  it("a claimed event never fires a binding (a panel's own handler ran first)", () => {
    const e = key({ code: "Space", key: " " });
    claimKey(e);
    expect(resolveKey(e, bindings)).toBeNull();
  });

  it("an already-cancelled event and a bare modifier never fire", () => {
    expect(resolveKey(key({ code: "Space", key: " ", defaultPrevented: true }), bindings)).toBeNull();
    expect(resolveKey(key({ code: "MetaLeft", key: "Meta", metaKey: true }), bindings)).toBeNull();
  });

  it("a typing surface keeps its keys — digits in the BPM box stay digits", () => {
    const input = { tagName: "INPUT", type: "number", isContentEditable: false };
    expect(resolveKey(key({ code: "Digit2", key: "2", target: input }), bindings)).toBeNull();
    // …but a focused BUTTON is not a typing surface: Space must reach the transport
    // (and be preventDefault-ed, so the button does not ALSO click — KB-02's semantic).
    const button = { tagName: "BUTTON", isContentEditable: false };
    expect(resolveKey(key({ code: "Space", key: " ", target: button }), bindings)?.action).toEqual({
      kind: "playPause",
    });
    // Enter on that button is UNBOUND — it falls through to the browser's native activation.
    expect(resolveKey(key({ code: "Enter", key: "Enter", target: button }), bindings)).toBeNull();
  });
});
