import { describe, expect, it, vi } from "vitest";
import type { ModSlotState } from "../../protocol/schema.ts";
import { buildModMapItems, channelsFor, mappedChannels } from "./modMap.ts";

const slot = (channelIndex: number, target: string): ModSlotState => ({
  channelIndex,
  target,
  targetShort: target[0]!.toUpperCase(),
  depth: 0.5,
});

const labels = (items: ReturnType<typeof buildModMapItems>) =>
  items.map((i) => (i.kind === "sep" ? "—" : i.label));

describe("channelsFor", () => {
  it("offers all four channels for a normal target", () => {
    expect(channelsFor("pan")).toEqual([0, 1, 2, 3]);
    expect(channelsFor("freeRate")).toEqual([0, 1, 2, 3]);
  });

  /**
   * sampleStart/sampleEnd have no flat depth field on M3/M4, and native
   * `mapModifier` REFUSES there. Offering M3/M4 would be a menu item that looks
   * live and silently does nothing — the exact failure this whole phase is about.
   */
  it("restricts sampleStart/sampleEnd to M1/M2 (native refuses M3/M4)", () => {
    expect(channelsFor("sampleStart")).toEqual([0, 1]);
    expect(channelsFor("sampleEnd")).toEqual([0, 1]);
    expect(labels(buildModMapItems("sampleStart", 0, [], () => {}))).toEqual([
      "Map to Modifier",
      "M1",
      "M2",
    ]);
  });
});

describe("mappedChannels", () => {
  it("reads the routings straight off the published slots", () => {
    const slots = [slot(0, "pan"), slot(2, "pan"), slot(1, "volume")];
    expect(mappedChannels("pan", slots)).toEqual([0, 2]);
    expect(mappedChannels("volume", slots)).toEqual([1]);
    expect(mappedChannels("gain", slots)).toEqual([]);
  });
});

describe("buildModMapItems", () => {
  it("checks the channels this target is routed to", () => {
    const items = buildModMapItems("pan", 3, [slot(1, "pan")], () => {});
    expect(labels(items)).toEqual(["Map to Modifier", "M1", "M2", "M3", "M4"]);
    const checked = items.filter((i) => i.kind === "item" && i.checked);
    expect(checked).toHaveLength(1);
    expect(checked[0]).toMatchObject({ label: "M2" });
  });

  it("maps an unmapped channel and UNMAPS a mapped one (the toggle is the unmap)", () => {
    const send = vi.fn();
    const items = buildModMapItems("filter", 5, [slot(0, "filter")], send);
    const pick = (label: string) => {
      const it = items.find((i) => i.kind === "item" && i.label === label);
      if (it?.kind !== "item") throw new Error(`no item ${label}`);
      it.onSelect();
    };

    pick("M1"); // already mapped → unmap
    expect(send).toHaveBeenCalledWith({
      op: "unmapMod",
      trackIndex: 5,
      index: 0,
      mode: "filter",
    });

    pick("M3"); // not mapped → map
    expect(send).toHaveBeenCalledWith({
      op: "mapMod",
      trackIndex: 5,
      index: 2,
      mode: "filter",
    });
  });

  it("sends no optimistic echo — mapModifier can refuse (cap of 6, or start/end on M3/M4)", () => {
    // The builder's ONLY side effect is the op. Slot state re-arrives from Swift,
    // so a refused map never shows a routing that isn't real.
    const send = vi.fn();
    const items = buildModMapItems("gain", 0, [], send);
    for (const i of items) if (i.kind === "item") i.onSelect();
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls.every(([p]) => p.op === "mapMod")).toBe(true);
  });
});
