import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireControlFocus,
  acquireFirstControlFocus,
  installFocusKeyboard,
  registerFocusTarget,
  setFocusClaimNotifier,
  setRemoteAdjustRelay,
  useFocusModel,
} from "./focusModel.ts";

// P5-PCE P2.1: one focus world — a lane state machine + a Tab-target
// registry. Exactly one accent ring on screen; the lane is the arbitration.
describe("focusModel lane state machine", () => {
  const noop = () => {};

  beforeEach(() => {
    useFocusModel.setState({ lane: "grid", focused: null, cell: null, remoteControls: false });
    setFocusClaimNotifier(null);
    setRemoteAdjustRelay(null);
  });

  it("a cell click claims the grid lane and drops any control ring", () => {
    useFocusModel.getState().setFocus({ id: "track/0/pitch", adjust: noop });
    expect(useFocusModel.getState().lane).toBe("controls");

    useFocusModel.getState().setCellFocus({ trackIndex: 2, step: 5 });
    const s = useFocusModel.getState();
    expect(s.lane).toBe("grid");
    expect(s.focused).toBeNull();
    expect(s.cell).toEqual({ trackIndex: 2, step: 5 });
  });

  it("a DragBox click flips to controls but KEEPS the parked cell focus", () => {
    useFocusModel.getState().setCellFocus({ trackIndex: 1, step: 3 });
    useFocusModel.getState().setFocus({ id: "track/1/tone", adjust: noop });
    const s = useFocusModel.getState();
    expect(s.lane).toBe("controls");
    expect(s.focused?.id).toBe("track/1/tone");
    expect(s.cell).toEqual({ trackIndex: 1, step: 3 }); // survives (inert)
  });

  it("clearing the focused control hands the keys back to the grid lane", () => {
    useFocusModel.getState().setFocus({ id: "track/0/pan", adjust: noop });
    useFocusModel.getState().clearFocus();
    const s = useFocusModel.getState();
    expect(s.lane).toBe("grid");
    expect(s.focused).toBeNull();
  });

  it("id-scoped clearFocus only clears the matching control", () => {
    useFocusModel.getState().setFocus({ id: "track/0/pan", adjust: noop });
    useFocusModel.getState().clearFocus("track/9/other"); // not the focused id
    expect(useFocusModel.getState().focused?.id).toBe("track/0/pan");
    expect(useFocusModel.getState().lane).toBe("controls");
  });
});

// Cross-webview focus relay (the ö/ä "double-click" fix): each webview has its
// own store; claims broadcast through native keep at most one controls owner
// across all of them.
describe("cross-webview claims (remoteControls)", () => {
  const noop = () => {};

  beforeEach(() => {
    useFocusModel.setState({ lane: "grid", focused: null, cell: null, remoteControls: false });
    setFocusClaimNotifier(null);
    setRemoteAdjustRelay(null);
  });

  it("a remote controls claim parks this webview: ring cleared, cell kept, lane stays grid", () => {
    useFocusModel.getState().setCellFocus({ trackIndex: 1, step: 3 });
    useFocusModel.getState().setFocus({ id: "track/1/tone", adjust: noop });
    useFocusModel.getState().applyRemoteClaim("controls");
    const s = useFocusModel.getState();
    expect(s.focused).toBeNull(); // one ring globally — the remote box owns it
    expect(s.lane).toBe("grid"); // arrows keep navigating locally
    expect(s.remoteControls).toBe(true);
    expect(s.cell).toEqual({ trackIndex: 1, step: 3 }); // parked, not lost
  });

  it("a remote grid claim releases the parked state", () => {
    useFocusModel.getState().applyRemoteClaim("controls");
    useFocusModel.getState().applyRemoteClaim("grid");
    expect(useFocusModel.getState().remoteControls).toBe(false);
  });

  it("setFocus notifies 'controls' and clears any remote ownership", () => {
    const claims: string[] = [];
    setFocusClaimNotifier((kind) => claims.push(kind));
    useFocusModel.getState().applyRemoteClaim("controls");
    useFocusModel.getState().setFocus({ id: "track/0/pitch", adjust: noop });
    expect(claims).toEqual(["controls"]);
    expect(useFocusModel.getState().remoteControls).toBe(false);
  });

  it("setCellFocus notifies 'grid' only when it takes ownership back", () => {
    const claims: string[] = [];
    setFocusClaimNotifier((kind) => claims.push(kind));
    // Steady-state arrow nav: no focused control, no remote owner → silent.
    useFocusModel.getState().setCellFocus({ trackIndex: 0, step: 0 });
    useFocusModel.getState().setCellFocus({ trackIndex: 0, step: 1 });
    expect(claims).toEqual([]);
    // Stealing back from a LOCAL box → broadcast.
    useFocusModel.getState().setFocus({ id: "track/0/pitch", adjust: noop });
    useFocusModel.getState().setCellFocus({ trackIndex: 0, step: 2 });
    // Stealing back from a REMOTE owner → broadcast.
    useFocusModel.getState().applyRemoteClaim("controls");
    useFocusModel.getState().setCellFocus({ trackIndex: 0, step: 3 });
    expect(claims).toEqual(["controls", "grid", "grid"]);
  });

  it("clearFocus of the focused control notifies 'grid' (owner release)", () => {
    const claims: string[] = [];
    useFocusModel.getState().setFocus({ id: "track/0/pan", adjust: noop });
    setFocusClaimNotifier((kind) => claims.push(kind));
    useFocusModel.getState().clearFocus("track/0/pan");
    expect(claims).toEqual(["grid"]);
    // Non-matching clear: no change, no broadcast.
    useFocusModel.getState().setFocus({ id: "track/0/vol", adjust: noop });
    claims.length = 0;
    useFocusModel.getState().clearFocus("track/9/other");
    expect(claims).toEqual([]);
  });

  it("applyRemoteClaim never re-notifies (no broadcast loops)", () => {
    const claims: string[] = [];
    setFocusClaimNotifier((kind) => claims.push(kind));
    useFocusModel.getState().applyRemoteClaim("controls");
    useFocusModel.getState().applyRemoteClaim("grid");
    expect(claims).toEqual([]);
  });
});

describe("focus-target registry (Tab lane switch)", () => {
  it("acquires the first registered target under a prefix (mount order)", () => {
    let landed = "";
    const off1 = registerFocusTarget("track/3/gain", () => (landed = "gain"));
    const off2 = registerFocusTarget("track/3/pitch", () => (landed = "pitch"));
    const off3 = registerFocusTarget("track/4/gain", () => (landed = "other-track"));

    expect(acquireFirstControlFocus("track/3/")).toBe(true);
    expect(landed).toBe("gain"); // first registered under the prefix

    expect(acquireFirstControlFocus("track/99/")).toBe(false); // no match
    off1();
    off2();
    off3();
  });

  it("unregister removes the target", () => {
    const off = registerFocusTarget("track/7/vol", noopAcquire);
    off();
    expect(acquireFirstControlFocus("track/7/")).toBe(false);
  });

  it("acquireControlFocus hits an exact id, misses unknown ones (TR-FT-12)", () => {
    let landed = "";
    const off = registerFocusTarget("track/2/mute", () => (landed = "mute"));
    expect(acquireControlFocus("track/2/mute")).toBe(true);
    expect(landed).toBe("mute");
    expect(acquireControlFocus("track/2/nope")).toBe(false);
    off();
  });
});

// TR-FT-12: the module keydown listener grows Enter/'.' press routing for
// controls that expose a `press` capability (band toggles/buttons).
describe("controls-lane key listener (ö/ä + Enter/'.')", () => {
  let handler: (e: KeyboardEvent) => void;

  const fakeKey = (key: string, mods: Partial<KeyboardEvent> = {}) =>
    ({
      key,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      preventDefault: vi.fn(),
      ...mods,
    }) as unknown as KeyboardEvent;

  beforeAll(() => {
    // Node env: capture the listener installFocusKeyboard registers.
    (globalThis as { window?: unknown }).window = {
      addEventListener: (_type: string, fn: (e: KeyboardEvent) => void) => {
        handler = fn;
      },
    };
    installFocusKeyboard();
  });

  beforeEach(() => {
    useFocusModel.setState({ lane: "grid", focused: null, cell: null, remoteControls: false });
    setFocusClaimNotifier(null);
    setRemoteAdjustRelay(null);
  });

  it("Enter and '.' press the focused control (controls lane, press defined)", () => {
    const press = vi.fn();
    useFocusModel.getState().setFocus({ id: "track/0/mute", adjust: press, press });
    const enter = fakeKey("Enter");
    handler(enter);
    expect(press).toHaveBeenCalledTimes(1);
    expect(enter.preventDefault).toHaveBeenCalled();
    handler(fakeKey("."));
    expect(press).toHaveBeenCalledTimes(2);
  });

  it("press-less controls (DragBoxes) ignore Enter/'.' — they forward instead", () => {
    const adjust = vi.fn();
    useFocusModel.getState().setFocus({ id: "track/0/pitch", adjust });
    const enter = fakeKey("Enter");
    handler(enter);
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(adjust).not.toHaveBeenCalled();
  });

  it("grid lane never presses (the grid owns '.')", () => {
    const press = vi.fn();
    useFocusModel.getState().setFocus({ id: "track/0/mute", adjust: press, press });
    useFocusModel.getState().setCellFocus({ trackIndex: 0, step: 0 }); // back to grid
    handler(fakeKey("."));
    expect(press).not.toHaveBeenCalled();
  });

  it("ö/ä still adjusts — on a press-control both keys flip it", () => {
    const flip = vi.fn();
    useFocusModel.getState().setFocus({ id: "track/0/solo", adjust: flip, press: flip });
    handler(fakeKey("ö"));
    handler(fakeKey("ä"));
    expect(flip).toHaveBeenCalledTimes(2);
  });

  it("modified Enter (⌘/⌃/⌥) is left alone for native shortcuts", () => {
    const press = vi.fn();
    useFocusModel.getState().setFocus({ id: "track/0/mode", adjust: press, press });
    handler(fakeKey("Enter", { metaKey: true }));
    handler(fakeKey("Enter", { altKey: true }));
    expect(press).not.toHaveBeenCalled();
  });

  it("ö under a REMOTE owner relays (-1, alt) and preventDefaults iff relayed", () => {
    const relay = vi.fn().mockReturnValue(true);
    setRemoteAdjustRelay(relay);
    useFocusModel.getState().applyRemoteClaim("controls");
    const oe = fakeKey("ö", { altKey: true });
    handler(oe);
    expect(relay).toHaveBeenCalledWith(-1, true);
    expect(oe.preventDefault).toHaveBeenCalled();
    // Relay declines (musical-keyboard mode): key left untouched.
    relay.mockReturnValue(false);
    const ae = fakeKey("ä");
    handler(ae);
    expect(relay).toHaveBeenCalledWith(1, false);
    expect(ae.preventDefault).not.toHaveBeenCalled();
  });

  it("a LOCAL focused control wins over the remote relay", () => {
    const adjust = vi.fn();
    const relay = vi.fn().mockReturnValue(true);
    setRemoteAdjustRelay(relay);
    useFocusModel.getState().setFocus({ id: "track/0/pitch", adjust });
    handler(fakeKey("ä"));
    expect(adjust).toHaveBeenCalledWith(1, false);
    expect(relay).not.toHaveBeenCalled();
  });

  it("no local focus, no remote owner → ö/ä stays inert (pre-relay behavior)", () => {
    const relay = vi.fn().mockReturnValue(true);
    setRemoteAdjustRelay(relay);
    const e = fakeKey("ö");
    handler(e);
    expect(relay).not.toHaveBeenCalled();
    expect(e.preventDefault).not.toHaveBeenCalled();
  });
});

function noopAcquire() {}
