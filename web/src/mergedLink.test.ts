import { beforeEach, describe, expect, it, vi } from "vitest";

// `engineLink.ts` reads `window` at module scope (the WKWebView handler probe),
// and this suite runs in the node environment like every other test here. Set
// it up BEFORE the import so the module can evaluate.
vi.stubGlobal("window", {});
vi.stubGlobal("requestAnimationFrame", () => 0);
vi.stubGlobal("cancelAnimationFrame", () => {});
// The companion stack's start() reaches for OPFS. Refusing it is realistic —
// there is no OPFS in the node environment — and this suite is about ROUTING,
// not about the companion's storage. A rejected init must not take the link
// down with it, which this incidentally proves.
vi.stubGlobal("navigator", {
  storage: { getDirectory: () => Promise.reject(new Error("no OPFS here")) },
});
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

const { createEngineLink } = await import("./engineLink.ts");

/**
 * THE MERGED SHELL'S COMMAND ROUTING.
 *
 * This test exists because `MergedLink` was an EMPTY subclass: it held the JUCE
 * backend and never called it, so every command in the merged desktop app was
 * answered by the browser-companion code path and anything that path does not
 * implement threw "not implemented in the browser companion". The native engine
 * was running, with an audio device open, being asked nothing — and the fault
 * was invisible until a panel came along that depended on the native side.
 *
 * Nothing in the type system can catch that: both sides satisfy `EngineLink`.
 * Only an assertion about WHICH SIDE a method lands on can.
 */

type Sent = { name: string; params: unknown[] };

/** A fake `window.__JUCE__.backend`, which is what makes createEngineLink()
    believe it is inside the merged shell. */
/** A minimally VALID reply per method. Replies are parsed through the command
    table on the way back, so a lazy `{}` fails the schema rather than the
    routing — which is the schema doing its job, and worth not defeating. */
const REPLY: Record<string, unknown> = {
  getCapabilities: {
    schemaVersion: 87,
    pluginHosting: false,
    fileSystem: true,
    midiHardware: false,
    audioDeviceSelection: true,
    returnFx: false,
    tape: true,
  },
  slRouteList: { routes: [], renderOrder: [] },
  setSetting: {},
  getSetting: { value: null },
  openPanelWindow: {},
  slFiles: { ok: true },
};

function installJuceBackend() {
  const sent: Sent[] = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const backend = {
    emitEvent(eventId: string, payload: unknown) {
      if (eventId === "__juce__invoke") {
        const p = payload as { name: string; params: unknown[]; resultId: number };
        sent.push({ name: p.name, params: p.params });
        // Resolve as JUCE does, so the caller's promise settles.
        listeners.get("__juce__complete")?.({
          promiseId: p.resultId,
          result: { ok: true, result: REPLY[String(p.params[0])] ?? { ok: true } },
        });
        return;
      }
      sent.push({ name: eventId, params: [payload] });
    },
    addEventListener(eventId: string, fn: (payload: unknown) => void) {
      listeners.set(eventId, fn);
      return listeners.size;
    },
    removeEventListener() {},
  };
  (globalThis as unknown as { window: Record<string, unknown> }).window.__JUCE__ = { backend };
  return { sent, listeners };
}

beforeEach(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window = {};
});

describe("MergedLink routing", () => {
  it("sends the PLANE's commands to the native side", async () => {
    // The regression that cost a whole run-pass: every one of these threw
    // "not implemented in the browser companion".
    const { sent } = installJuceBackend();
    const link = createEngineLink();
    expect(link).not.toBeNull();

    // The last four were missing until P3-2 and had callers the whole time:
    // slDeck (every deck's sync, on every map load), slMaster (the master
    // fader), slMap (the entire .scoopyMap document) and slDevices (the input
    // picker) all refused, once, to the console. This list is the allowlist's
    // only real specification, so a method added there without a line here is
    // untested routing.
    const planeMethods = [
      "slChannel",
      "slTape",
      "slRoute",
      "slRouteList",
      "slRecord",
      "slTakes",
      "slDeck",
      "slMaster",
      "slMap",
      "slDevices",
    ];
    for (const method of planeMethods) {
      await link!.command(method as never, {});
    }

    // The companion stack's own boot now emits slFiles (P3-SES-1 — the file
    // browser scans the NATIVE library on this host), interleaved at whatever
    // moment its async init reaches the disk. That traffic is routing WORKING,
    // not part of this test's issued sequence — filtered, and asserted native
    // in its own case below.
    const native = sent
      .filter((s) => s.name === "slCommand")
      .map((s) => s.params[0])
      .filter((m) => m !== "slFiles");
    expect(native).toEqual(planeMethods);
  });

  it("sends the LIBRARY FILESYSTEM native — sessions must land on real disk", async () => {
    // P3-SES-1: OPFS can be listed but not written in the WKWebView, so
    // `opfs.ts` routes through slFiles here. A miss on this allowlist would
    // silently send the session library back to the browser companion — the
    // exact zero-length-session failure the flip exists to delete.
    const { sent } = installJuceBackend();
    const link = createEngineLink()!;
    await link.command("slFiles" as never, { action: "mkdirs", path: "/sessions" });
    const native = sent.filter((s) => s.name === "slCommand").map((s) => s.params[0]);
    expect(native).toContain("slFiles");
  });

  it("sends the handshake and settings native — they are the SHELL's, not this webview's", async () => {
    // Settings must be the shell's file: every panel is a separate webview, and
    // localStorage would give each one its own private copy of the theme.
    const { sent } = installJuceBackend();
    const link = createEngineLink()!;
    await link.command("getCapabilities" as never, {});
    await link.command("setSetting" as never, { key: "k", value: 1 });
    const native = sent.filter((s) => s.name === "slCommand").map((s) => s.params[0]);
    expect(native).toContain("getCapabilities");
    expect(native).toContain("setSetting");
  });

  it("sends window spawning native — it needs the window layer", async () => {
    const { sent } = installJuceBackend();
    const link = createEngineLink()!;
    await link.command("openPanelWindow" as never, { panel: "companion" });
    expect(sent.filter((s) => s.name === "slCommand").map((s) => s.params[0])).toContain(
      "openPanelWindow",
    );
  });

  it("sends the WORLD SINK native — the grid must not drive a WASM copy", async () => {
    // The structural bug: `companionEngine` publishes worlds, and its sink was
    // ScoopyAudio — an Emscripten build of the same C++ core — so in the merged
    // desktop app the grid drove a WASM COPY of the engine inside an app that
    // already had the original, on a second clock, into a second output.
    // `SlWorldApply` sat built and tested with zero callers.
    const { sent } = installJuceBackend();
    const link = createEngineLink()!;
    await link.command("slWorld" as never, { action: "publish", world: {} });
    expect(sent.filter((s) => s.name === "slCommand").map((s) => s.params[0])).toContain(
      "slWorld",
    );
  });

  it("routes the MasterRow's session params to the DOCUMENT owner, not the native lane (P3-D4-1a)", () => {
    // The merged shell REFUSES sessionBpm/sessionMasterVolume/sessionMasterDrive
    // by design (kParamMap maps only deckTranspose) — the session document lives
    // on the companion side. Before this seam, the MasterRow was three live-
    // looking controls whose every write died in a DBG line.
    const { sent } = installJuceBackend();
    const link = createEngineLink()! as import("./browserLink.ts").BrowserLink;
    // The native param lane coalesces per rAF; capture frames so the flush is
    // OURS — otherwise a mis-routed write would sit unflushed in the queue and
    // the "nothing leaked" assertion below would pass vacuously.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      frames.push(fn);
      return frames.length;
    });
    const flush = () => frames.splice(0).forEach((fn) => fn(0));
    const landed: [string, number, number][] = [];
    link.setSessionParamHandler((p, v, deck) => landed.push([p, v, deck]));
    link.paramWrite("sessionBpm" as never, 128, 1);
    link.paramWrite("sessionMasterVolume" as never, 0.5, 0);
    link.paramWrite("sessionMasterDrive" as never, 8, 2);
    expect(landed).toEqual([
      ["sessionBpm", 128, 1],
      ["sessionMasterVolume", 0.5, 0],
      ["sessionMasterDrive", 8, 2],
    ]);
    // …and nothing leaked to the native param lane.
    flush();
    expect(sent.filter((s) => s.name === "slParam")).toHaveLength(0);
    // A deck param still goes native — the seam must not swallow engine control.
    link.paramWrite("deckTranspose" as never, 3, 0);
    flush();
    expect(sent.filter((s) => s.name === "slParam")).toHaveLength(1);
    vi.stubGlobal("requestAnimationFrame", () => 0);
  });

  it("routes the DECK MASTER SENDS to the strip owner, not the param lane", () => {
    // MasterRow's S1-S4 cluster had NO arm anywhere: the write fell through to
    // BrowserLink's "no document" warn and the four faders moved nothing.
    //
    // The engine is not the wrong destination — it is the wrong ROUTE. A grid
    // deck's master sends are its strip channel's four sends, and the engine
    // hears them through `slChannel setSend` → `projectToCore` →
    // `core.setDeckMasterSend`. There is no `deckMasterSend` param to write.
    const { sent } = installJuceBackend();
    const link = createEngineLink()! as import("./browserLink.ts").BrowserLink;
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
      frames.push(fn);
      return frames.length;
    });
    const flush = () => frames.splice(0).forEach((fn) => fn(0));

    const landed: [number, number, number][] = [];
    link.setDeckMasterSendHandler((deck, send, level) => landed.push([deck, send, level]));
    // MasterRow speaks the engine's 1-BASED send index; the handler is 0-based,
    // and exactly one place converts.
    link.paramWrite("deckMasterSend" as never, 0.25, 0, 1);
    link.paramWrite("deckMasterSend" as never, 0.75, 2, 4);
    expect(landed).toEqual([
      [0, 0, 0.25],
      [2, 3, 0.75],
    ]);
    flush();
    expect(sent.filter((s) => s.name === "slParam")).toHaveLength(0);

    // An index outside 1…4 is NOT CLAMPED — a caller that starts counting at
    // zero must fail rather than silently move send 1. It falls through to the
    // native lane, where there is no `deckMasterSend` param and the shell
    // refuses it: wrong, loudly, instead of right-looking and wrong.
    landed.length = 0;
    link.paramWrite("deckMasterSend" as never, 0.5, 0, 0);
    link.paramWrite("deckMasterSend" as never, 0.5, 0, 5);
    expect(landed).toEqual([]);
    vi.stubGlobal("requestAnimationFrame", () => 0);
  });

  it("keeps the GRID DOCUMENT on the companion side", async () => {
    // `MergedMain` implements none of the document methods, and the flip that
    // would move them native is P3. Routing these native would break the grid
    // in exactly the way routing the plane's methods to the browser broke the
    // plane — the same bug, mirrored.
    const { sent } = installJuceBackend();
    const link = createEngineLink()!;
    await link.command("getUiState" as never, { topic: "gridMeta" }).catch(() => {});
    expect(sent.filter((s) => s.name === "slCommand")).toHaveLength(0);
  });
});
