/**
 * The launch quantum's scale and its reference resolution (D-SL-QUANTUM-01).
 *
 * The scale is a port; the resolution is ours, because the donor never needed
 * one — it had a fixed A/B/C and took the first audibly-playing deck. Every
 * case below is one of the decision's four steps, or the reason a step exists.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUANTUM,
  LAUNCH_QUANTA,
  launchReferenceLabel,
  quantumSteps,
  quantumStepsRaw,
  resolveLaunchReference,
  type LaunchStrip,
} from "./launchQuantum.ts";

const strip = (over: Partial<LaunchStrip> & { key: string; index: number }): LaunchStrip => ({
  playing: false,
  launchRef: "auto",
  deck: 0,
  ...over,
});

describe("the scale", () => {
  it("carries the donor's values and its default", () => {
    expect(LAUNCH_QUANTA).toContain("cycle");
    expect(DEFAULT_QUANTUM).toBe("cycle");
  });

  it("resolves fixed step counts", () => {
    expect(quantumSteps("4", 64)).toBe(4);
    expect(quantumSteps("16", 64)).toBe(16);
  });

  it("resolves `cycle` against the REFERENCE's cycle, not a constant", () => {
    expect(quantumSteps("cycle", 48)).toBe(48);
  });

  it("gives `off` a boundary of 0 — launch now", () => {
    // `off` and `cycle` are both null in the donor's own `steps` property,
    // meaning OPPOSITE things; it is safe there only because every caller
    // checks `off` first. This version does not need that to be remembered.
    expect(quantumStepsRaw("off")).toBeNull();
    expect(quantumStepsRaw("cycle")).toBeNull();
    expect(quantumSteps("off", 64)).toBe(0);
  });

  it("treats a cycle of 0 as nothing to wait for rather than an instant loop", () => {
    expect(quantumSteps("cycle", 0)).toBe(0);
  });
});

describe("whose grid a launch waits on", () => {
  it("takes the lowest-numbered PLAYING strip when nothing else says otherwise", () => {
    // The automatic answer, and with two decks running it is simply "the other
    // one" — which is the case the user says is most of them.
    const strips = [
      strip({ key: "a", index: 0, playing: true }),
      strip({ key: "b", index: 1 }),
      strip({ key: "c", index: 2, playing: true }),
    ];
    expect(resolveLaunchReference(strips, "b", null)).toEqual({ key: "a", reason: "lowest-playing" });
  });

  it("orders by INDEX, so the answer does not change under you mid-set", () => {
    // Not "first started": that reshuffles every time something stops, and a
    // performer would have to track it.
    const strips = [
      strip({ key: "a", index: 2, playing: true }),
      strip({ key: "b", index: 0, playing: true }),
      strip({ key: "c", index: 1 }),
    ];
    expect(resolveLaunchReference(strips, "c", null).key).toBe("b");
  });

  it("prefers the SYNC-MASTER when one is playing", () => {
    const strips = [
      strip({ key: "a", index: 0, playing: true }),
      strip({ key: "m", index: 5, playing: true }),
      strip({ key: "x", index: 9 }),
    ];
    expect(resolveLaunchReference(strips, "x", "m")).toEqual({ key: "m", reason: "master" });
  });

  it("lets an EXPLICIT per-strip reference out-vote the master", () => {
    // Someone said so. That is the whole point of the field.
    const strips = [
      strip({ key: "a", index: 0, playing: true }),
      strip({ key: "m", index: 1, playing: true }),
      strip({ key: "x", index: 2, launchRef: "a" }),
    ];
    expect(resolveLaunchReference(strips, "x", "m")).toEqual({ key: "a", reason: "explicit" });
  });

  it("falls through when the named reference is gone or stopped", () => {
    // A deleted or stopped strip must not silently freeze a pad forever — the
    // launch degrades to auto rather than waiting on nothing.
    const strips = [
      strip({ key: "a", index: 0, playing: true }),
      strip({ key: "x", index: 1, launchRef: "deleted" }),
    ];
    expect(resolveLaunchReference(strips, "x", null)).toEqual({ key: "a", reason: "lowest-playing" });

    const stopped = [
      strip({ key: "a", index: 0, playing: true }),
      strip({ key: "s", index: 1 }), // named but not playing
      strip({ key: "x", index: 2, launchRef: "s" }),
    ];
    expect(resolveLaunchReference(stopped, "x", null).key).toBe("a");
  });

  it("never references ITSELF", () => {
    // The launcher is not running yet, so its own boundary would never arrive.
    const strips = [strip({ key: "x", index: 0, playing: true, launchRef: "x" })];
    expect(resolveLaunchReference(strips, "x", "x")).toEqual({ key: null, reason: "none" });
  });

  it("says NOTHING IS PLAYING rather than arming against a stopped grid", () => {
    // The donor's arm-against-a-stopped-deck surprise, made a stated case: the
    // caller fires immediately and the control can say why.
    const strips = [strip({ key: "a", index: 0 }), strip({ key: "x", index: 1 })];
    expect(resolveLaunchReference(strips, "x", "a")).toEqual({ key: null, reason: "none" });
  });

  it("resolves for a LOOPER exactly as for a deck", () => {
    // The reason this law does not take document types: a tape strip is a
    // reference and a launcher like any other. A looper spawned mid-set lands
    // on the beat with no configuration, which is the user's second fact.
    const strips = [
      strip({ key: "deck", index: 0, playing: true }),
      strip({ key: "loop", index: 1, deck: null }),
    ];
    expect(resolveLaunchReference(strips, "loop", null)).toEqual({
      key: "deck",
      reason: "lowest-playing",
    });
  });
});

describe("what the strip shows", () => {
  const name = (k: string) => k.toUpperCase();

  it("labels each resolution so `auto` is never a mystery", () => {
    expect(launchReferenceLabel({ key: "a", reason: "explicit" }, name)).toBe("A");
    expect(launchReferenceLabel({ key: "a", reason: "master" }, name)).toBe("A (master)");
    expect(launchReferenceLabel({ key: "a", reason: "lowest-playing" }, name)).toBe("A (auto)");
  });

  it("says what will happen when there is nothing to wait on", () => {
    expect(launchReferenceLabel({ key: null, reason: "none" }, name)).toBe(
      "nothing playing — launches now",
    );
  });
});
