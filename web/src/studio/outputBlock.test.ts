import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * S5 — the output routing's door, and the two things about it that are the
 * ENGINE's shape rather than a UI preference.
 */
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const CODE = read("src/studio/OutputBlock.tsx")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("OutputBlock — the door the routing did not have", () => {
  it("Studio mounts it", () => {
    // setDeckOutputChannels and setSendOutputChannel were answered by the shell
    // and called by nobody. Built and unreachable is the defect this closes.
    expect(read("src/studio/StudioPanel.tsx")).toContain("<OutputBlock");
  });

  it("calls both routing commands", () => {
    expect(CODE).toContain("setDeckOutputChannels");
    expect(CODE).toContain("setSendOutputChannel");
  });

  it("sends pick ONE channel; main picks a PAIR", () => {
    // The engine's layout, not a UI choice: sl_engine.cpp warns the four send
    // lanes are consecutive MONO lanes and that treating them as stereo pairs
    // is how a reorder routes a channel's right side into the next send.
    expect(CODE).toMatch(/channels:\s*first === null \? null : \[first, first \+ 1\]/);
    expect(CODE).toMatch(/sendIndex: i \+ 1, channel: ch/);
  });

  it("null main means MAIN — the summed program, not both at once", () => {
    // A deck in the summed program AND on its own pair is the same audio twice.
    expect(CODE).toContain("first === null ? null");
  });

  it("offers only pairs the hardware has, and says why when it cannot", () => {
    // The donor gates its picker on outputChannelCount > 2. A picker offering
    // 3/4 on a two-channel interface reaches nothing.
    expect(CODE).toContain("outputChannelCount");
    expect(CODE).toContain("channelCount <= 2");
    expect(CODE).toContain("title={why ??");
  });
});
