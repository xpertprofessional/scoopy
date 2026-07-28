// P3-U1 — the plane starts the engine sink itself (native host only).
//
// The defect this pins: `startEngine()`'s only caller was the companion
// panel's button, in a different WebView with its own store — so in the plane
// window every grid transport gesture was enabled and silently inert. The
// plane's boot effect now calls `autoStartEngine`; these cases pin the
// host-asymmetry (native starts, browser must not) and the failure surfacing
// (a failed start must land on the plane's note line, not on a store field
// only the companion panel renders).
import { describe, expect, it } from "vitest";

import { autoStartEngine, type EngineStarter } from "./bootEngine.ts";

function fakeStore(overrides: Partial<EngineStarter> = {}) {
  const calls: string[] = [];
  const store: EngineStarter = {
    engine: "idle",
    error: null,
    async startEngine() {
      calls.push("startEngine");
      store.engine = "running";
    },
    ...overrides,
  };
  return { store, calls };
}

describe("autoStartEngine", () => {
  it("starts the engine on the native host and reports no note", async () => {
    const { store, calls } = fakeStore();
    const note = await autoStartEngine(true, () => store);
    expect(calls).toEqual(["startEngine"]);
    expect(store.engine).toBe("running");
    expect(note).toBeNull();
  });

  it("does NOT start in the browser — the gesture rule stands", async () => {
    // AudioContext is gesture-gated in browsers; an auto-started context sits
    // `suspended` while every call "succeeds". The click stays mandatory.
    const { store, calls } = fakeStore();
    const note = await autoStartEngine(false, () => store);
    expect(calls).toEqual([]);
    expect(store.engine).toBe("idle");
    expect(note).toBeNull();
  });

  it("returns the store's error as the plane note when the start fails", async () => {
    const { store } = fakeStore();
    store.startEngine = async () => {
      store.engine = "failed";
      store.error = "engine failed to start: no device";
    };
    const note = await autoStartEngine(true, () => store);
    expect(note).toBe("engine failed to start: no device");
  });

  it("still produces a note when a failed start carries no message", async () => {
    // No silent silence: even an unexplained failure must say SOMETHING where
    // the user is looking.
    const { store } = fakeStore();
    store.startEngine = async () => {
      store.engine = "failed";
      store.error = null;
    };
    const note = await autoStartEngine(true, () => store);
    expect(note).toMatch(/failed/);
  });

  it("is idempotent through the store's own re-entry guard", async () => {
    // startEngine() itself refuses while starting/running; autoStart calling
    // into a running store must not produce a note.
    const { store, calls } = fakeStore({ engine: "running" });
    store.startEngine = async () => {
      calls.push("startEngine");
      /* store's guard: no-op when running */
    };
    const note = await autoStartEngine(true, () => store);
    expect(note).toBeNull();
  });
});
