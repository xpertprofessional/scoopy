import { useEffect } from "react";
import type { EngineLink } from "../engineLink.ts";

/**
 * KB-01 — the native keyboard relay, app-wide.
 *
 * The single-owner rule (P3-03) makes HotkeyManager yield EVERY key the moment
 * a migration WKWebView owns first-responder (HotkeyManager.swift, keyDown
 * monitor). TR-FT-5 built the way back — a `forwardKey` Command that rebuilds a
 * synthetic NSEvent native-side and runs it through the SAME dispatcher — but it
 * lived inside GridPanel, so the shortcut library only survived in ONE panel.
 * Click a mixer fader, a transport box, a DJ deck or a settings pane and every
 * native shortcut went dead until you clicked back out.
 *
 * The relay therefore belongs at the panel ROOT: every panel is its own webview
 * with its own App instance, so mounting it once in App covers all of them.
 *
 * Arbitration is a CLAIM, not preventDefault. A panel that handled a key claims
 * the event; the root listener forwards whatever is left. Claims are monotonic
 * (a WeakSet, add-only) — which is what makes the DJ view correct, where three
 * GridPanels each run a key listener: whichever deck handles the key claims it
 * and the other two can't un-claim it, so the key forwards exactly once (or not
 * at all). The old per-panel relay forwarded up to three times there.
 */

/** Physical macOS virtual keycodes by `KeyboardEvent.code` (layout-independent,
 *  matching native's keyCode handlers). Chars ride alongside for native's
 *  charactersIgnoringModifiers handlers, so a key missing here still matches a
 *  char-based shortcut — but a keyCode-based one silently would not. */
const MAC_KEYCODES: Record<string, number> = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7,
  KeyC: 8, KeyV: 9, KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15,
  KeyY: 16, KeyT: 17, KeyO: 31, KeyU: 32, KeyI: 34, KeyP: 35, KeyL: 37,
  KeyJ: 38, KeyK: 40, KeyN: 45, KeyM: 46,
  Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23,
  Digit9: 25, Digit7: 26, Digit8: 28, Digit0: 29,
  Minus: 27, Equal: 24, Period: 47, Comma: 43, Slash: 44, Semicolon: 41,
  Quote: 39, Backslash: 42, Backquote: 50,
  Space: 49, Enter: 36, Tab: 48, Backspace: 51, Escape: 53, Delete: 117,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
  BracketLeft: 33, BracketRight: 30,
  Home: 115, End: 119, PageUp: 116, PageDown: 121,
  F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97,
  F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111,
};

/**
 * Keys the WEB owns outright, everywhere — they must never reach native even
 * when no web panel claims them.
 *
 * Not a style choice: native ö/ä runs `adjustFocusedControl` against its own
 * `keyboardFocusedControlIndex`, and native arrows drive its step/browser
 * navigation. Under a web panel those native focus indices are stale and
 * invisible, so forwarding would perform an edit the user cannot see — the same
 * class of bug P4-02c fixed by retiring the headless ≥100 route.
 *
 * The web owns the arrows it NAVIGATES with — the bare ones. It does not own the
 * arrows that are somebody else's shortcut:
 *   ⌘-arrows  — native track-shift (⌘←/→), never web-owned.
 *   Ctrl-arrows — BEAT REPEAT. Ctrl+↑/↓ zooms the repeat length along the fused
 *     16…1 │ 1/2…1/32 scale; Ctrl+←/→ shifts the engaged region a step. These are
 *     the only Ctrl+arrow bindings native has (HotkeyManager:433/:645), and the
 *     web has no cursor gesture on Ctrl+arrow to lose. This guard used to swallow
 *     them along with the bare ones — the comment said "bare-arrow only" while the
 *     code tested `!e.metaKey`, so ⌘ was the single exemption and every other
 *     modifier fell in. Ctrl+1–8 (a digit, not an arrow) forwarded fine and
 *     engaged the repeat; then Ctrl+↑ and Ctrl+← did nothing at all, which is
 *     exactly what a half-migrated shortcut looks like.
 *
 * Native consumes Ctrl+arrow whether or not a repeat is engaged, so forwarding one
 * with beat repeat OFF cannot fall through into native's stale step cursor.
 */
function isWebOwnedKey(e: KeyboardEvent): boolean {
  if (!noteKeyboardActive && (e.key === "ö" || e.key === "ä" || e.key === "Ö" || e.key === "Ä")) {
    return true;
  }
  if (e.key.startsWith("Arrow") && !e.metaKey && !e.ctrlKey) return true;
  return false;
}

/**
 * NK-3: Musical Keyboard Mode is engaged natively.
 *
 * It LIFTS the ö/ä guard, and it has to. On a German QWERTZ, ö and ä are
 * keyCodes 41 and 39 — which native's piano map reads as **E** and **F**
 * (HotkeyManager.musicalKeyMap). The guard above exists only because native's
 * ö/ä normally runs `adjustFocusedControl` against a stale focus index; in
 * musical mode that handler never runs, because the musical block consumes the
 * key first (HotkeyManager:179, well above the focus lane). So the reason for
 * the guard evaporates exactly when the mode turns on — and keeping it would
 * silently drop two notes out of the middle of the scale.
 *
 * Arrows stay web-owned regardless: the grid's cursor still has to move.
 */
let noteKeyboardActive = false;
export function setNoteKeyboardActive(on: boolean): void {
  noteKeyboardActive = on;
}
export function isNoteKeyboardActive(): boolean {
  return noteKeyboardActive;
}

/**
 * The DJ nudge keys, by PHYSICAL position — T/Y bend deck 1, G/H bend deck 2
 * (HotkeyManager :176-179). `code`, not `key`: on a QWERTZ the `KeyY` slot types
 * `z`, and native matches the slot.
 */
const DJ_NUDGE_CODES = new Set(["KeyT", "KeyY", "KeyG", "KeyH"]);

/**
 * KB-03 — inside a DECK, the bare nudge keys are the DJ's, not the pattern's.
 *
 * Native dispatches them FIRST of everything (ahead of chop-preview and
 * finger-drum) so that in the DJ window they can never mean anything else. The
 * web grid claims by default, and `g` is its accent cycle — so deck 2's
 * nudge-down quietly edited a cell instead of bending the deck, and T/Y/H died on
 * the claim without a web handler to show for it. A deck grid must yield all four.
 *
 * Only bare presses (native's guard: no ⌘/⇧/⌥), and only in a deck-scoped panel —
 * compose has no decks, and `t` there is a grid param key.
 */
export function isDjNudgeKey(e: KeyboardEvent): boolean {
  if (!DJ_NUDGE_CODES.has(e.code)) return false;
  return !e.metaKey && !e.shiftKey && !e.altKey;
}

const claimed = new WeakSet<KeyboardEvent>();

/** Mark an event as handled web-side: the root relay will not forward it.
 *  Monotonic — no un-claim, so one panel's claim survives another's pass. */
export function claimKey(e: KeyboardEvent): void {
  claimed.add(e);
}

export function isKeyClaimed(e: KeyboardEvent): boolean {
  return claimed.has(e);
}

/**
 * `<input>` types that are NOT typing surfaces. The distinction is load-bearing:
 * a `type=range` fader (GeoSlider) and a `type=checkbox` are CONTROLS that happen
 * to be inputs, and a tagName-only guard treats holding focus on one as "the user
 * is typing" — so space stopped reaching native transport the moment you touched
 * a fader, and toggled the checkbox instead. Focus on a control must not eat the
 * shortcut library; focus on a rename box must.
 */
const NON_TYPING_INPUT_TYPES = new Set([
  "range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image",
]);

/** True when the focused element consumes the key as text (or as a native picker
 *  — a `<select>` needs its own space/arrows to open and choose). Exported for
 *  the browser keymap (P8-8), which must honour the same typing surfaces. */
export function isTypingTarget(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = ((el as HTMLInputElement).type || "text").toLowerCase();
  return !NON_TYPING_INPUT_TYPES.has(type);
}

/** True when the event should reach the native HotkeyManager. Pure — the
 *  listener and the tests share this one decision. */
export function shouldForwardKey(e: KeyboardEvent): boolean {
  if (isKeyClaimed(e) || e.defaultPrevented) return false;
  // Bare modifier presses carry no shortcut.
  if (["Shift", "Alt", "Meta", "Control"].includes(e.key)) return false;
  // A web text field is consuming the key (rename box, font tester, search).
  if (isTypingTarget(e)) return false;
  if (isWebOwnedKey(e)) return false;
  // Nothing native could match on either lane.
  const keyCode = MAC_KEYCODES[e.code] ?? 0;
  const chars = e.key.length === 1 ? e.key : "";
  return keyCode !== 0 || chars !== "";
}

/** The wire payload for one forwarded key (exported for the tests). */
export function forwardPayload(e: KeyboardEvent, type: "keyDown" | "keyUp" = "keyDown") {
  return {
    type,
    keyCode: MAC_KEYCODES[e.code] ?? 0,
    chars: e.key.length === 1 ? e.key : "",
    command: e.metaKey,
    option: e.altKey,
    shift: e.shiftKey,
    control: e.ctrlKey,
    isRepeat: type === "keyDown" && e.repeat,
  };
}

/**
 * KB-02 — cancel the browser default SYNCHRONOUSLY, at the moment we decide to
 * forward.
 *
 * This used to live in a `.then()` on the round trip, gated on native's `handled`
 * flag, which reads as the careful thing to do and is in fact dead code: a
 * `forwardKey` Command is a WKScriptMessage that resolves in `window.__slpResponse`
 * many event-loop turns later (engineLink.ts), long after the keydown finished
 * dispatching. `preventDefault()` at that point is a no-op. So EVERY forwarded key
 * also kept its browser behaviour — space scrolled the panel (`body` and
 * `.grid-panel` are both `overflow-y: auto`), space on a focused button ALSO
 * clicked it (hit ▶ then space and the focused ■ stopped you again), and because
 * the page never cancelled the key, WKWebView handed it back to AppKit where the
 * Transport menu's bare-space key equivalent toggled play a second time — two
 * toggles, net nothing. That is the whole "space sometimes doesn't play, sometimes
 * just scrolls" report.
 *
 * We cannot wait for native's answer, so we do not ask: reaching this function
 * already MEANS native owns the key. shouldForwardKey has excluded the web-owned
 * keys, the typing targets and everything a panel claimed — a panel that wants a
 * key back claims it (claimKey), which is exactly what the claim lane is for.
 */
export function forwardKeyToNative(link: EngineLink, e: KeyboardEvent): void {
  e.preventDefault();
  heldForwarded.add(e.code);
  link.command("forwardKey", forwardPayload(e, "keyDown")).catch(() => {});
}

/**
 * KB-03 — the RELEASE has to travel the same wire as the press.
 *
 * Native has hold-shortcuts: DJ nudge (T/Y · G/H) bends the deck's rate for as
 * long as the key is down and snaps back on release. The press arrives natively
 * as an ASYNC forwarded WKScriptMessage; the release used to arrive only as the
 * PHYSICAL keyUp, which the local monitor sees immediately (a local monitor is
 * ahead of the responder chain, so a webview holding first-responder never hid
 * it). Two different clocks for one gesture:
 *
 *   physical keyDown ──► web ──► (async IPC) ──► native start   ← may land LAST
 *   physical keyUp   ─────────────────────────► native release  ← already ran
 *
 * On a quick tap the release ran against an empty `activeNudgeKeyCodes`, did
 * nothing, and the late press then engaged a nudge with no release coming — the
 * deck stayed bent off-grid for the rest of the set. Forwarding the keyUp down
 * the SAME channel restores the ordering (script messages are FIFO), so the
 * release can never overtake its press. The physical keyUp still fires natively
 * too; the nudge release is idempotent (guarded by that same key set), so the
 * duplicate is harmless — and only keys we actually forwarded are tracked.
 */
const heldForwarded = new Set<string>();

export function forwardKeyUpToNative(link: EngineLink, e: KeyboardEvent): void {
  if (!heldForwarded.delete(e.code)) return;
  link.command("forwardKey", forwardPayload(e, "keyUp")).catch(() => {});
}

/**
 * Mount ONCE at the panel root (App). Registers last — React runs child effects
 * before parent effects, so every panel's own key listener has already had its
 * turn (and claimed what it owns) by the time this one runs.
 */
export function useNativeKeyForwarding(link: EngineLink | null): void {
  useEffect(() => {
    if (!link) return;
    const onKey = (e: KeyboardEvent) => {
      if (!shouldForwardKey(e)) return;
      forwardKeyToNative(link, e);
    };
    const onKeyUp = (e: KeyboardEvent) => forwardKeyUpToNative(link, e);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      heldForwarded.clear();
    };
  }, [link]);
}
