/**
 * The scene-switch modes, pinned against the donor's three-way rule.
 *
 * Every case answers "what does `activatePatternSceneViaSwitchMode` do", not
 * "what seems reasonable" — these are ported laws.
 */
import { describe, expect, it } from "vitest";

import {
  SWITCH_MODES,
  SWITCH_MODE_LABEL,
  nextSwitchMode,
  resolveSwitchAction,
} from "./sceneSwitch.ts";

describe("the three modes", () => {
  it("cycles in the donor's order and comes back round", () => {
    expect(nextSwitchMode("scheduled")).toBe("seamless");
    expect(nextSwitchMode("seamless")).toBe("restart");
    expect(nextSwitchMode("restart")).toBe("scheduled");
  });

  it("gives every mode a label, so the cycler can always say what it is", () => {
    // The button WEARS its value (the strip-tempomode idiom), so a mode with no
    // label would render as an empty button — a control you cannot read.
    for (const m of SWITCH_MODES) expect(SWITCH_MODE_LABEL[m]).toBeTruthy();
  });
});

describe("what a pad click resolves to", () => {
  it("SCHED schedules while playing", () => {
    expect(resolveSwitchAction("scheduled", true)).toBe("schedule");
  });

  it("SCHED switches NOW when stopped — the donor's own sentence", () => {
    // "Scene clicks schedule during playback and switch immediately when
    // stopped." Scheduling against a stopped clock arms a boundary that never
    // arrives: the pad lights and nothing happens, which is worse than
    // switching.
    expect(resolveSwitchAction("scheduled", false)).toBe("seamless");
  });

  it("RUN switches at the running position, playing or not", () => {
    expect(resolveSwitchAction("seamless", true)).toBe("seamless");
    expect(resolveSwitchAction("seamless", false)).toBe("seamless");
  });

  it("START re-enters at step 0, and stays START when stopped", () => {
    // The mode says WHERE the pattern begins; "from step 0" means the same
    // thing whether or not the transport is already moving.
    expect(resolveSwitchAction("restart", true)).toBe("restart");
    expect(resolveSwitchAction("restart", false)).toBe("restart");
  });

  it("an explicit immediate overrides SCHED — the ⌘-click gesture", () => {
    expect(resolveSwitchAction("scheduled", true, true)).toBe("seamless");
  });

  it("an explicit immediate does NOT flatten START into a seamless switch", () => {
    // The gesture means "not what the mode says about WHEN" — it does not mean
    // "forget where the pattern starts". Flattening it here would make ⌘-click
    // silently different from a plain click in START mode.
    expect(resolveSwitchAction("restart", true, true)).toBe("restart");
  });
});
