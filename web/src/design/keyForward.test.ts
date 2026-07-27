import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineLink } from "../engineLink.ts";
import {
  claimKey,
  forwardKeyToNative,
  forwardKeyUpToNative,
  forwardPayload,
  isDjNudgeKey,
  isKeyClaimed,
  isNoteKeyboardActive,
  setNoteKeyboardActive,
  shouldForwardKey,
} from "./keyForward.ts";

/** A KeyboardEvent-shaped literal — the relay only reads these fields, so the
 *  decision stays testable without a DOM. */
function key(init: Partial<KeyboardEvent> & { key: string; code?: string }): KeyboardEvent {
  return {
    code: "",
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    repeat: false,
    defaultPrevented: false,
    target: null,
    ...init,
  } as unknown as KeyboardEvent;
}

// KB-01: the relay is what keeps the native shortcut library alive while a
// migration webview holds first-responder (the single-owner rule yields every
// key to the web). These tests pin WHICH keys cross that boundary.
describe("shouldForwardKey", () => {
  it("forwards the ordinary shortcut library", () => {
    expect(shouldForwardKey(key({ key: " ", code: "Space" }))).toBe(true); // transport
    expect(shouldForwardKey(key({ key: "p", code: "KeyP" }))).toBe(true); // record-arm
    expect(shouldForwardKey(key({ key: "z", code: "KeyZ", metaKey: true }))).toBe(true); // undo
    expect(shouldForwardKey(key({ key: "t", code: "KeyT" }))).toBe(true); // DJ nudge / finger drum
  });

  it("never forwards a key a panel claimed", () => {
    const e = key({ key: "j", code: "KeyJ" });
    expect(shouldForwardKey(e)).toBe(true);
    claimKey(e);
    expect(isKeyClaimed(e)).toBe(true);
    expect(shouldForwardKey(e)).toBe(false);
  });

  it("a claim is monotonic — a second listener cannot un-claim it", () => {
    // The DJ view mounts three GridPanels, each with its own key listener. If a
    // claim could be revoked, a key one deck HANDLED would still be forwarded by
    // the deck that ignored it (and the old per-panel relay forwarded it 3×).
    const e = key({ key: "f", code: "KeyF" });
    claimKey(e);
    claimKey(e);
    expect(shouldForwardKey(e)).toBe(false);
  });

  it("never forwards the web-owned value keys — native would edit invisibly", () => {
    // Native ö/ä runs adjustFocusedControl against ITS focus indices, which are
    // stale under a web panel: the edit would be real and unseen (the P4-02c bug
    // class). Same for bare arrows (native step/browser nav).
    for (const k of ["ö", "ä", "Ö", "Ä"]) {
      expect(shouldForwardKey(key({ key: k }))).toBe(false);
    }
    expect(shouldForwardKey(key({ key: "ArrowLeft", code: "ArrowLeft" }))).toBe(false);
    expect(shouldForwardKey(key({ key: "ArrowUp", code: "ArrowUp" }))).toBe(false);
  });

  it("forwards ⌘-arrows — those are native track-shift, not grid navigation", () => {
    expect(shouldForwardKey(key({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }))).toBe(true);
  });

  // The bug: Ctrl+1–8 engaged beat repeat (a digit — forwarded fine), and then Ctrl+↑/↓ (length
  // zoom) and Ctrl+←/→ (region shift) did nothing, because this guard swallowed EVERY arrow that
  // wasn't ⌘-modified. The web has no Ctrl+arrow gesture; native has exactly these four.
  it("forwards Ctrl-arrows — those are beat repeat (length zoom ↑/↓, region shift ←/→)", () => {
    for (const code of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(shouldForwardKey(key({ key: code, code, ctrlKey: true }))).toBe(true);
    }
  });

  it("still keeps the BARE arrows — the grid cursor is the web's", () => {
    for (const code of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      expect(shouldForwardKey(key({ key: code, code }))).toBe(false);
      // ⌥-arrow stays web-owned too: only ⌘ and Ctrl are exempt.
      expect(shouldForwardKey(key({ key: code, code, altKey: true }))).toBe(false);
    }
  });

  it("carries the control flag on the wire — native reads it to pick the BR branch", () => {
    expect(forwardPayload(key({ key: "ArrowUp", code: "ArrowUp", ctrlKey: true }))).toMatchObject({
      keyCode: 126, // kVK_UpArrow
      control: true,
    });
  });

  it("stays out of the way of typing and of bare modifiers", () => {
    const input = { tagName: "INPUT" };
    expect(shouldForwardKey(key({ key: "p", code: "KeyP", target: input as unknown as EventTarget }))).toBe(false);
    expect(shouldForwardKey(key({ key: "Shift", code: "ShiftLeft" }))).toBe(false);
    expect(shouldForwardKey(key({ key: "Meta", code: "MetaLeft" }))).toBe(false);
  });

  // KB-02. A tagName-only guard reads <input type=range> — the GeoSlider — as a
  // text field, so the shortcut library went dead the moment you touched a fader:
  // space stopped playback dead and toggled a checkbox instead. A control is not
  // a typing surface, even when the platform spells it <input>.
  it("still forwards while a fader or a checkbox holds focus — those are controls, not text", () => {
    const range = { tagName: "INPUT", type: "range" };
    const check = { tagName: "INPUT", type: "checkbox" };
    expect(shouldForwardKey(key({ key: " ", code: "Space", target: range as unknown as EventTarget }))).toBe(true);
    expect(shouldForwardKey(key({ key: " ", code: "Space", target: check as unknown as EventTarget }))).toBe(true);
  });

  it("treats the real typing surfaces as typing — text inputs, textareas, contentEditable, and <select>", () => {
    const text = { tagName: "INPUT", type: "text" };
    const bare = { tagName: "INPUT" }; // no type attribute ⇒ text
    const area = { tagName: "TEXTAREA" };
    const sel = { tagName: "SELECT" }; // needs its own space/arrows to open
    const rich = { tagName: "DIV", isContentEditable: true };
    for (const t of [text, bare, area, sel, rich]) {
      expect(shouldForwardKey(key({ key: " ", code: "Space", target: t as unknown as EventTarget }))).toBe(false);
    }
  });
});

// KB-02: the relay must cancel the browser default, and it only gets one chance —
// the synchronous one. Gating preventDefault on native's `handled` reply looks
// careful and is dead code: the reply lands turns after the default already ran.
describe("forwardKeyToNative", () => {
  it("preventDefaults SYNCHRONOUSLY, before the native round trip can resolve", () => {
    let resolveNative: ((v: unknown) => void) | null = null;
    const link = {
      command: vi.fn(() => new Promise((res) => { resolveNative = res; })),
    } as unknown as EngineLink;
    const preventDefault = vi.fn();
    const e = key({ key: " ", code: "Space" });
    (e as unknown as { preventDefault: () => void }).preventDefault = preventDefault;

    forwardKeyToNative(link, e);

    // Native has not answered yet — and it never gets to decide. If this assertion
    // moves after an await, space scrolls the panel again.
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(link.command).toHaveBeenCalledWith("forwardKey", forwardPayload(e));
    expect(resolveNative).not.toBeNull();
  });

  it("swallows a rejected round trip — a dead link must not throw out of a keydown", () => {
    const link = { command: vi.fn(() => Promise.reject(new Error("no host"))) } as unknown as EngineLink;
    const e = key({ key: " ", code: "Space" });
    (e as unknown as { preventDefault: () => void }).preventDefault = () => {};
    expect(() => forwardKeyToNative(link, e)).not.toThrow();
  });

  // KB-03: the release only travels for a key whose PRESS we forwarded. A keyup we
  // never pressed native-side (the web claimed it, or a text field ate it) must not
  // reach the DJ release path — the deck it would revert is not the one being held.
  it("forwards a release only for a key it forwarded the press for", () => {
    const link = { command: vi.fn(() => Promise.resolve({})) } as unknown as EngineLink;
    const down = key({ key: "t", code: "KeyT" });
    (down as unknown as { preventDefault: () => void }).preventDefault = () => {};

    forwardKeyUpToNative(link, key({ key: "t", code: "KeyT" })); // never pressed
    expect(link.command).not.toHaveBeenCalled();

    forwardKeyToNative(link, down);
    forwardKeyUpToNative(link, key({ key: "t", code: "KeyT" }));
    expect(link.command).toHaveBeenNthCalledWith(2, "forwardKey", expect.objectContaining({
      type: "keyUp",
      keyCode: 17,
    }));

    // The hold is over — a second release must not fire a second revert.
    forwardKeyUpToNative(link, key({ key: "t", code: "KeyT" }));
    expect(link.command).toHaveBeenCalledTimes(2);
  });

  it("skips keys neither native lane could match", () => {
    // No physical keycode mapped AND no single character to match on.
    expect(shouldForwardKey(key({ key: "F13", code: "F13" }))).toBe(false);
  });

  it("defaultPrevented means another web listener already acted", () => {
    // focusModel's ö/ä + Enter listener preventDefaults when a DragBox is focused.
    expect(shouldForwardKey(key({ key: "Enter", code: "Enter", defaultPrevented: true }))).toBe(false);
  });
});

// KB-03. The deck grid claims keys by default, and `g` is its accent cycle — so
// deck 2's nudge-down was editing a cell instead of bending the deck, and T/Y/H
// died on a claim with no web handler behind it. A deck grid yields all four.
describe("isDjNudgeKey — the four keys a DECK grid must not claim", () => {
  it("holds the physical T/Y · G/H slots, layout-independently", () => {
    expect(isDjNudgeKey(key({ key: "t", code: "KeyT" }))).toBe(true);
    expect(isDjNudgeKey(key({ key: "z", code: "KeyY" }))).toBe(true); // QWERTZ
    expect(isDjNudgeKey(key({ key: "g", code: "KeyG" }))).toBe(true);
    expect(isDjNudgeKey(key({ key: "h", code: "KeyH" }))).toBe(true);
    expect(isDjNudgeKey(key({ key: "j", code: "KeyJ" }))).toBe(false);
  });

  it("is a BARE gesture — native's own guard excludes ⌘/⇧/⌥", () => {
    expect(isDjNudgeKey(key({ key: "t", code: "KeyT", metaKey: true }))).toBe(false);
    expect(isDjNudgeKey(key({ key: "t", code: "KeyT", shiftKey: true }))).toBe(false);
    // ⌥+T is the CHOP PREVIEW (HotkeyManager :187), a different shortcut entirely.
    expect(isDjNudgeKey(key({ key: "t", code: "KeyT", altKey: true }))).toBe(false);
  });
});

describe("forwardPayload", () => {
  it("sends the physical keycode (layout-independent) plus the character", () => {
    // Native matches on BOTH lanes: keyCode for transport/chop-preview, chars for
    // "." / "p" / "y". A German layout must still hit the physical handlers.
    expect(forwardPayload(key({ key: "z", code: "KeyY", metaKey: true }))).toEqual({
      type: "keyDown",
      keyCode: 16, // physical Y slot — QWERTZ 'z' sits there
      chars: "z",
      command: true,
      option: false,
      shift: false,
      control: false,
      isRepeat: false,
    });
  });

  // KB-03: a hold shortcut (DJ nudge) is a PRESS and a RELEASE, and native learns
  // about the press asynchronously — so the release has to ride the same wire or it
  // arrives first and the deck stays bent. `isRepeat` is meaningless on a release.
  it("phases the key: a release carries type keyUp and never repeats", () => {
    const p = forwardPayload(key({ key: "t", code: "KeyT", repeat: true }), "keyUp");
    expect(p.type).toBe("keyUp");
    expect(p.keyCode).toBe(17);
    expect(p.isRepeat).toBe(false);
  });

  it("sends an empty char for non-printable keys, and carries key-repeat", () => {
    const p = forwardPayload(key({ key: "Enter", code: "Enter", repeat: true }));
    expect(p.chars).toBe("");
    expect(p.keyCode).toBe(36);
    expect(p.isRepeat).toBe(true);
  });

  it("maps the function keys the old map was missing", () => {
    expect(forwardPayload(key({ key: "F5", code: "F5" })).keyCode).toBe(96);
    expect(forwardPayload(key({ key: "`", code: "Backquote" })).keyCode).toBe(50);
  });
});

// NK-3: Musical Keyboard Mode turns the letter keys into piano keys, and that
// changes who owns them. These tests pin the two consequences — otherwise the
// keyboard "works" while silently dropping notes out of the middle of the scale.
describe("note keyboard mode", () => {
  afterEach(() => setNoteKeyboardActive(false));

  it("normally keeps ö/ä web-owned (they drive the value lane)", () => {
    expect(shouldForwardKey(key({ key: "ö", code: "Semicolon" }))).toBe(false);
    expect(shouldForwardKey(key({ key: "ä", code: "Quote" }))).toBe(false);
  });

  // The one that matters. On a German QWERTZ, ö and ä sit on keyCodes 41 and 39
  // — which native's piano map reads as E and F. Leave the deny-list in place
  // and the scale loses two notes, with no error anywhere to explain it.
  it("forwards ö/ä while the mode is on — they are piano E and F on a QWERTZ", () => {
    setNoteKeyboardActive(true);
    expect(shouldForwardKey(key({ key: "ö", code: "Semicolon" }))).toBe(true);
    expect(shouldForwardKey(key({ key: "ä", code: "Quote" }))).toBe(true);
    expect(forwardPayload(key({ key: "ö", code: "Semicolon" })).keyCode).toBe(41); // native E
    expect(forwardPayload(key({ key: "ä", code: "Quote" })).keyCode).toBe(39); // native F
  });

  // Arrows are NOT part of the bargain: the grid's cursor still has to move, and
  // native's arrow handlers would run against a focus index the web can't see.
  it("keeps bare arrows web-owned even while the mode is on", () => {
    setNoteKeyboardActive(true);
    expect(shouldForwardKey(key({ key: "ArrowUp", code: "ArrowUp" }))).toBe(false);
    expect(shouldForwardKey(key({ key: "ArrowDown", code: "ArrowDown" }))).toBe(false);
  });

  it("still refuses a claimed key — the mode does not outrank a panel's claim", () => {
    setNoteKeyboardActive(true);
    const e = key({ key: "ö", code: "Semicolon" });
    claimKey(e);
    expect(shouldForwardKey(e)).toBe(false);
  });

  it("reports its own state, so the grid and the deny-list cannot disagree", () => {
    expect(isNoteKeyboardActive()).toBe(false);
    setNoteKeyboardActive(true);
    expect(isNoteKeyboardActive()).toBe(true);
  });
});
