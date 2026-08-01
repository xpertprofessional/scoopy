import { describe, expect, it } from "vitest";

import { hostTouchTargetFor } from "./GridPanel";

/**
 * The op → host-offset mapping (D-SL-DECKPLUGIN-04).
 *
 * This is a lookup between two vocabularies that live in different languages —
 * the web's track ops and the engine's mod-target names, spelled out in
 * `shell/plugin/src/HostParams.cpp`. Nothing type-checks one against the other,
 * so a rename on either side would silently stop Ableton's Configure from
 * finding that control, with no error anywhere. These names are the contract.
 */
describe("hostTouchTargetFor", () => {
  it("maps the four scalar track controls onto their engine target names", () => {
    expect(hostTouchTargetFor({ op: "setPitch", trackIndex: 0 })).toBe("pitch");
    expect(hostTouchTargetFor({ op: "setVolume", trackIndex: 0 })).toBe("volume");
    expect(hostTouchTargetFor({ op: "setPan", trackIndex: 0 })).toBe("pan");
    expect(hostTouchTargetFor({ op: "setTone", trackIndex: 0 })).toBe("tone");
  });

  it("maps sends by their 1-based index", () => {
    // The row emits `index: 1..4` and the engine's targets are send1..send4, so
    // this is the one arm where an off-by-one would point a lane at the wrong
    // send rather than at nothing — silent, and audible only as a wrong bus.
    expect(hostTouchTargetFor({ op: "setSend", index: 1 })).toBe("send1");
    expect(hostTouchTargetFor({ op: "setSend", index: 4 })).toBe("send4");
  });

  it("refuses a send index outside 1…4", () => {
    expect(hostTouchTargetFor({ op: "setSend", index: 0 })).toBeNull();
    expect(hostTouchTargetFor({ op: "setSend", index: 5 })).toBeNull();
    expect(hostTouchTargetFor({ op: "setSend", index: 2.5 })).toBeNull();
    expect(hostTouchTargetFor({ op: "setSend" })).toBeNull();
    expect(hostTouchTargetFor({ op: "setSend", index: "2" })).toBeNull();
  });

  it("maps every other track op to nothing", () => {
    // There is no host offset for a mute or a chop, so touching one must
    // announce nothing rather than announce the wrong thing.
    for (const op of [
      "setMuted",
      "setReversed",
      "setGain",
      "setToneQ",
      "setStepCount",
      "setChokeGroup",
      "setLocatorRange",
      "beginUndo",
      "endUndo",
      "setActiveCellParameter",
    ])
      expect(hostTouchTargetFor({ op, trackIndex: 3 })).toBeNull();
  });

  it("survives a params object with no op at all", () => {
    expect(hostTouchTargetFor({})).toBeNull();
    expect(hostTouchTargetFor({ op: 7 })).toBeNull();
  });
});
