import { describe, expect, it, vi } from "vitest";
import type { MidiLearnState } from "../../protocol/schema.ts";
import {
  buildMidiLearnItems,
  isLearningTarget,
  learnKey,
  learnParams,
  mappingFor,
  type LearnTarget,
} from "./midiLearn.ts";
import { trackLearnTarget } from "../panels/trackRowControls.tsx";

const IDLE: MidiLearnState = {
  isLearning: false,
  learningKind: null,
  learningKey: null,
  learningTrackIndex: null,
  mapped: [],
};

const VOL: LearnTarget = { kind: "trackParam", token: "volume", trackIndex: 2 };
const VOL_OTHER_ROW: LearnTarget = { kind: "trackParam", token: "volume", trackIndex: 7 };
const BPM: LearnTarget = { kind: "singleton", learnId: "master_bpm" };

const labels = (s: MidiLearnState, t: LearnTarget) =>
  buildMidiLearnItems(t, s, { start: () => {}, cancel: () => {}, clear: () => {} }).map((i) =>
    i.kind === "sep" ? "—" : i.label,
  );

describe("learnKey", () => {
  it("is the token for a track param and the learnId for a singleton", () => {
    expect(learnKey(VOL)).toBe("volume");
    expect(learnKey(BPM)).toBe("master_bpm");
  });
});

describe("mappingFor", () => {
  const mapped: MidiLearnState = {
    ...IDLE,
    mapped: [
      { kind: "trackParam", key: "volume", ccNumber: 12, channel: 1 },
      { kind: "singleton", key: "master_bpm", ccNumber: 74, channel: 1 },
    ],
  };

  it("resolves a singleton by learnId", () => {
    expect(mappingFor(mapped, BPM)?.ccNumber).toBe(74);
  });

  /**
   * Native `createMapping` DISCARDS the track UUID and stores `.trackParam(token)`,
   * so ONE bound volume mapping shows on EVERY track's volume box and fires on
   * whatever track is selected. Pin it: it looks like a bug and is the feature.
   */
  it("is track-agnostic — a volume mapping resolves from any row", () => {
    expect(mappingFor(mapped, VOL)?.ccNumber).toBe(12);
    expect(mappingFor(mapped, VOL_OTHER_ROW)?.ccNumber).toBe(12);
  });

  it("does not cross the kind boundary", () => {
    const t: LearnTarget = { kind: "singleton", learnId: "volume" };
    expect(mappingFor(mapped, t)).toBeUndefined();
  });
});

describe("isLearningTarget", () => {
  const arming: MidiLearnState = {
    ...IDLE,
    isLearning: true,
    learningKind: "trackParam",
    learningKey: "volume",
    learningTrackIndex: 2,
  };

  it("lights only the armed ROW, not every row sharing the token", () => {
    expect(isLearningTarget(arming, VOL)).toBe(true);
    expect(isLearningTarget(arming, VOL_OTHER_ROW)).toBe(false);
  });

  it("is false when nothing is armed", () => {
    expect(isLearningTarget(IDLE, VOL)).toBe(false);
  });
});

/** Exact mirror of native MIDILearnContextMenuContent (DraggableNumberBox:985). */
describe("buildMidiLearnItems", () => {
  it("offers Learn MIDI when unmapped and idle", () => {
    expect(labels(IDLE, VOL)).toEqual(["Learn MIDI"]);
  });

  it("shows the CC readout + Clear when mapped", () => {
    const s: MidiLearnState = {
      ...IDLE,
      mapped: [{ kind: "trackParam", key: "volume", ccNumber: 12, channel: 1 }],
    };
    expect(labels(s, VOL)).toEqual([
      "Mapped: CC12",
      "Clear MIDI Mapping",
      "—",
      "Learn MIDI",
    ]);
  });

  it("offers Cancel while a learn is armed", () => {
    const s: MidiLearnState = { ...IDLE, isLearning: true };
    expect(labels(s, VOL)).toEqual(["Cancel MIDI Learning"]);
  });

  it("routes the actions to the right target", () => {
    const start = vi.fn();
    const clear = vi.fn();
    const s: MidiLearnState = {
      ...IDLE,
      mapped: [{ kind: "singleton", key: "master_bpm", ccNumber: 74, channel: 1 }],
    };
    const items = buildMidiLearnItems(BPM, s, { start, cancel: () => {}, clear });
    for (const i of items) if (i.kind === "item") i.onSelect();
    expect(clear).toHaveBeenCalledWith(BPM);
    expect(start).toHaveBeenCalledWith(BPM);
  });
});

/**
 * CM-6 — the DJ + toolbar wave. Two failure modes are silent (the mapping
 * sticks, it just lands on the wrong control), so they are pinned here.
 */
describe("CM-6 — deck-scoped learn targets", () => {
  it("carries the deck for a DJ row, so learn resolves against THAT deck", () => {
    expect(learnParams("start", trackLearnTarget("volume", 2, 1))).toEqual({
      op: "start",
      kind: "trackParam",
      key: "volume",
      trackIndex: 2,
      deck: 1,
    });
  });

  it("keeps deck 0 — a falsy check would drop deck A and silently use compose", () => {
    expect(learnParams("start", trackLearnTarget("pan", 0, 0)).deck).toBe(0);
  });

  it("omits the deck in the compose row (the compose sequencer is the default)", () => {
    expect(learnParams("start", trackLearnTarget("gain", 3))).toEqual({
      op: "start",
      kind: "trackParam",
      key: "gain",
      trackIndex: 3,
    });
  });

  it("names the sends with native's tokens (track_send1…4_<uuid>)", () => {
    expect([1, 2, 3, 4].map((n) => learnKey(trackLearnTarget(`send${n}`, 0)))).toEqual([
      "send1",
      "send2",
      "send3",
      "send4",
    ]);
  });

  it("sends the DJ singletons by their native learnId, with no track scope", () => {
    const xfader: LearnTarget = { kind: "singleton", learnId: "dj_crossfader" };
    expect(learnParams("start", xfader)).toEqual({
      op: "start",
      kind: "singleton",
      key: "dj_crossfader",
    });
    const tempo: LearnTarget = { kind: "singleton", learnId: "dj_master_tempo" };
    expect(learnParams("clear", tempo).key).toBe("dj_master_tempo");
  });

  it("a bound send shows Mapped on the box (sends are track-AGNOSTIC, like every token)", () => {
    const s: MidiLearnState = {
      ...IDLE,
      mapped: [{ kind: "trackParam", key: "send2", ccNumber: 41, channel: 1 }],
    };
    expect(mappingFor(s, trackLearnTarget("send2", 5, 2))?.ccNumber).toBe(41);
  });
});
