/**
 * P8-8 — THE BROWSER KEYMAP. The other renderer the registry was promised.
 *
 * On the desktop a shortcut is an NSMenu key equivalent (consumed before the web view ever sees
 * the keystroke) or a HotkeyManager binding reached via `forwardKey`. A browser has neither: the
 * relay's `forwardKey` lands in BrowserLink's documented swallow (browserLink.ts), so every
 * native-owned key used to be preventDefault-ed into the void. This module is the replacement the
 * swallow's comment promised: a `KeyboardEvent.code` matcher (physical, layout-independent —
 * registry.ts:25-28), mounted only when the host is a BrowserLink.
 *
 * Binding sources, layered for MB-6 (one registry declaration → N shells):
 *   1. REGISTRY-DECLARED — every `COMMANDS` entry with a `shortcut` binds here automatically
 *      (today: edit.undo ⌘Z / edit.redo ⇧⌘Z). Delete the declaration and the binding disappears.
 *   2. BROWSER SUPPLEMENTS — Space (transport) and bare digits 1-8 (scene pads). Deliberately NOT
 *      added to registry `shortcut`s yet: menuBridge publishes registry shortcuts into the macOS
 *      menu tree, and MB-4 blocks Space adoption there (the single-space rule). When MB-6 folds
 *      the native keymap into the registry, this table collapses into it.
 *
 * ⚠️ The OS reserves ⌘W/⌘T/⌘Q/F11 — a binding on those would claim a key the browser will take
 * anyway (MIGRATION.md P8-8). `isReservedShortcut` guards it, and the tests sweep every binding.
 */
import { useEffect } from "react";

import { enabledScenes } from "../audio/sceneProjection.ts";
import { BrowserLink } from "../browserLink.ts";
import { isKeyClaimed, isTypingTarget } from "../design/keyForward.ts";
import { companionDeck, useCompanion } from "../store/companionEngine.ts";
import { COMMANDS, type CommandId, type KeyEquivalent } from "./registry.ts";

/** The slice of a KeyboardEvent the matcher reads — structural, so tests need no DOM. */
export interface KeyLike {
  code: string;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
}

/** EXACT modifier equality — ⌘Z must not match ⇧⌘Z, and bare 1 must not match ⌘1
 *  (the browser's own tab-switching chord). */
export function matchesShortcut(e: KeyLike, sc: KeyEquivalent): boolean {
  return (
    e.code === sc.code &&
    e.metaKey === Boolean(sc.cmd) &&
    e.shiftKey === Boolean(sc.shift) &&
    e.altKey === Boolean(sc.alt) &&
    e.ctrlKey === Boolean(sc.ctrl)
  );
}

/** Chords the OS/browser will not give up (MIGRATION.md:1225) — never bind them. */
export function isReservedShortcut(sc: KeyEquivalent): boolean {
  if (sc.code === "F11") return true;
  return Boolean(sc.cmd) && ["KeyW", "KeyT", "KeyQ"].includes(sc.code);
}

export type BrowserAction =
  | { kind: "undo"; redo: boolean }
  | { kind: "playPause" }
  | { kind: "scene"; index: number };

export interface Binding {
  shortcut: KeyEquivalent;
  action: BrowserAction;
  source: "registry" | "browser";
  id?: CommandId;
}

/** What each registry command DOES in this shell. A declared shortcut whose id has no entry here
 *  simply does not bind — a menu item must never appear to work and do nothing. */
const REGISTRY_ACTIONS: Partial<Record<CommandId, BrowserAction>> = {
  "edit.undo": { kind: "undo", redo: false },
  "edit.redo": { kind: "undo", redo: true },
};

/** The full binding table — registry-declared first, browser supplements after. */
export function browserBindings(): Binding[] {
  const out: Binding[] = [];
  for (const cmd of COMMANDS) {
    if (!cmd.shortcut) continue;
    const action = REGISTRY_ACTIONS[cmd.id];
    if (action) out.push({ shortcut: cmd.shortcut, action, source: "registry", id: cmd.id });
  }
  out.push({ shortcut: { code: "Space" }, action: { kind: "playPause" }, source: "browser" });
  for (let n = 1; n <= 8; n++) {
    out.push({
      shortcut: { code: `Digit${n}` },
      action: { kind: "scene", index: n - 1 },
      source: "browser",
    });
  }
  return out;
}

/**
 * The pure decision core: which binding (if any) fires for this event. Skips exactly what the
 * relay skips — a claimed event (a panel's own handler ran first; child effects register before
 * the root's), an already-cancelled one, a bare modifier, and a typing surface (the BPM box, a
 * rename input) keeps its keys.
 */
export function resolveKey(e: KeyboardEvent, bindings: Binding[]): Binding | null {
  if (isKeyClaimed(e) || e.defaultPrevented) return null;
  if (["Shift", "Alt", "Meta", "Control"].includes(e.key)) return null;
  if (isTypingTarget(e)) return null;
  return bindings.find((b) => matchesShortcut(e, b.shortcut)) ?? null;
}

function execute(link: BrowserLink, action: BrowserAction): void {
  switch (action.kind) {
    case "undo":
      // The SAME channel the desktop's NSMenu uses — delivered as an engine event, so
      // GridPanel's undo/redo handler runs unchanged (it already answers `swiftUndo` no).
      link.emitEvent({ type: action.redo ? "redo" : "undo" });
      return;
    case "playPause": {
      // The keyboard drives DECK 0 — this is the browser companion's keymap,
      // where one session is the app. The plane's strips are clicked, not typed.
      const s = useCompanion.getState();
      const d = companionDeck();
      if (s.engine !== "running" || !d.session) return; // still preventDefault-ed — space never scrolls
      if (d.playing) s.stop();
      else s.play();
      return;
    }
    case "scene": {
      const s = useCompanion.getState();
      const d = companionDeck();
      if (!d.session) return;
      const letter = enabledScenes(d.session.pattern)[action.index];
      if (letter) s.selectScene(letter);
      return;
    }
  }
}

/**
 * Mount ONCE at the panel root (App), browser host only — the desktop keeps NSMenu +
 * HotkeyManager and never sees this. Registers last, like the native relay: every panel's own
 * key listener has already claimed what it owns.
 */
export function useBrowserKeymap(link: BrowserLink | null): void {
  useEffect(() => {
    if (!link) return;
    const bindings = browserBindings().filter((b) => {
      if (!isReservedShortcut(b.shortcut)) return true;
      console.warn("browserKeymap: refusing to bind an OS-reserved chord", b.shortcut);
      return false;
    });
    const onKey = (e: KeyboardEvent) => {
      const binding = resolveKey(e, bindings);
      if (!binding) return;
      e.preventDefault(); // KB-02's rule, kept: a matched key never also scrolls/clicks
      execute(link, binding.action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [link]);
}
