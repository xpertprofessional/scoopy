import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineLink } from "../engineLink.ts";
import { setNoteKeyboardActive } from "./keyForward.ts";
import { installFocusRelay } from "./focusRelay.ts";
import { installFocusKeyboard, useFocusModel } from "./focusModel.ts";

// Cross-webview controls-focus relay: claims ride link.command("focusRelay"),
// incoming broadcasts arrive as {type:"focusRelay"} events. The store-side
// semantics live in focusModel.test.ts; this file covers the link wiring.

function fakeLink() {
  let eventCb: ((evt: unknown) => void) | null = null;
  const command = vi.fn().mockResolvedValue({});
  const offEvent = vi.fn(() => {
    eventCb = null;
  });
  const link = {
    command,
    paramWrite: vi.fn(),
    onHotFrame: vi.fn().mockReturnValue(() => {}),
    onEvent: (cb: (evt: unknown) => void) => {
      eventCb = cb;
      return offEvent;
    },
    onUiState: vi.fn().mockReturnValue(() => {}),
  } as unknown as EngineLink;
  return { link, command, offEvent, emit: (evt: unknown) => eventCb?.(evt) };
}

let keydownHandler: (e: KeyboardEvent) => void;

const fakeKeydown = (key: string, mods: Partial<KeyboardEvent> = {}) =>
  ({
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...mods,
  }) as unknown as KeyboardEvent;

describe("focusRelay link wiring", () => {
  beforeAll(() => {
    // Node env: capture the module keydown listener so tests can drive the
    // REAL parked-ö/ä path (same harness as focusModel.test.ts).
    (globalThis as { window?: unknown }).window = {
      addEventListener: (_type: string, fn: (e: KeyboardEvent) => void) => {
        keydownHandler = fn;
      },
    };
    installFocusKeyboard();
  });

  beforeEach(() => {
    useFocusModel.setState({ lane: "grid", focused: null, cell: null, remoteControls: false });
    setNoteKeyboardActive(false);
  });

  it("a local setFocus sends a controls claim; setCellFocus sends the grid release", () => {
    const { link, command } = fakeLink();
    const off = installFocusRelay(link)!;
    useFocusModel.getState().setFocus({ id: "track/0/pitch", adjust: () => {} });
    expect(command).toHaveBeenCalledWith("focusRelay", { op: "claim", kind: "controls" });
    useFocusModel.getState().setCellFocus({ trackIndex: 0, step: 0 });
    expect(command).toHaveBeenCalledWith("focusRelay", { op: "claim", kind: "grid" });
    off();
  });

  it("an incoming controls claim parks the store", () => {
    const { link, emit } = fakeLink();
    const off = installFocusRelay(link)!;
    useFocusModel.getState().setCellFocus({ trackIndex: 2, step: 1 });
    emit({ type: "focusRelay", op: "claim", kind: "controls" });
    const s = useFocusModel.getState();
    expect(s.remoteControls).toBe(true);
    expect(s.focused).toBeNull();
    expect(s.cell).toEqual({ trackIndex: 2, step: 1 });
    off();
  });

  it("an incoming adjust hits the locally focused control only", () => {
    const { link, emit } = fakeLink();
    const off = installFocusRelay(link)!;
    const adjust = vi.fn();
    // Not controls-focused → the broadcast is ignored here.
    emit({ type: "focusRelay", op: "adjust", delta: 1, fine: false });
    useFocusModel.getState().setFocus({ id: "track/1/tone", adjust });
    emit({ type: "focusRelay", op: "adjust", delta: -1, fine: true });
    expect(adjust).toHaveBeenCalledTimes(1);
    expect(adjust).toHaveBeenCalledWith(-1, true);
    off();
  });

  it("a parked ö relays an adjust command — unless musical-keyboard mode is on", () => {
    const { link, command } = fakeLink();
    const off = installFocusRelay(link)!;
    useFocusModel.getState().applyRemoteClaim("controls");

    // Musical mode: the relay declines, the key is left untouched (it will be
    // handled as a piano note by the forwarding layer).
    setNoteKeyboardActive(true);
    const muted = fakeKeydown("ö");
    keydownHandler(muted);
    expect(muted.preventDefault).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalledWith(
      "focusRelay",
      expect.objectContaining({ op: "adjust" }),
    );

    // Normal mode: relayed to the owner and consumed.
    setNoteKeyboardActive(false);
    const live = fakeKeydown("ä", { altKey: true });
    keydownHandler(live);
    expect(live.preventDefault).toHaveBeenCalled();
    expect(command).toHaveBeenCalledWith("focusRelay", { op: "adjust", delta: 1, fine: true });
    off();
  });

  it("cleanup unregisters: no claims sent, events ignored", () => {
    const { link, command, offEvent, emit } = fakeLink();
    const off = installFocusRelay(link)!;
    off();
    expect(offEvent).toHaveBeenCalled();
    useFocusModel.getState().setFocus({ id: "track/0/pitch", adjust: () => {} });
    expect(command).not.toHaveBeenCalled();
    emit({ type: "focusRelay", op: "claim", kind: "controls" });
    expect(useFocusModel.getState().remoteControls).toBe(false);
  });

  it("returns undefined without a link (plain-browser dev mode)", () => {
    expect(installFocusRelay(null)).toBeUndefined();
  });
});
