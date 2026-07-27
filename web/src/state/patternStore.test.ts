import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GridTrackState } from "../../protocol/schema.ts";
import {
  SETTLE_MS,
  resetShadowEvidence,
  resetShadows,
  shadowAuthoritative,
  shadowCoverage,
  shadowLocalOp,
  shadowUndoDepth,
  shadowUndoPop,
  shadowUnmodeledEdit,
  usePatternStore,
} from "./patternStore.ts";
import { VERIFIABLE_GRID_OPS, applyGridOp, type GridOp } from "../panels/gridOps.ts";
import { VERIFIABLE_TRACK_OPS } from "../panels/trackOps.ts";

// P5-04 shadow store: prediction chain + settle-time drift compare.
// Timers are faked; SETTLE_MS of quiet triggers the comparison.

const track = (over: Partial<GridTrackState> = {}): GridTrackState =>
  ({
    name: "T",
    colorHex: "#fff",
    trackType: "audio",
    playbackMode: "regular",
    stepCount: 8,
    muted: false,
    soloed: false,
    patternStartStep: null,
    locatorStart: null,
    locatorLength: null,
    steps: Array(8).fill(false),
    cellLengths: Array(8).fill(1),
    wrapSourceStep: null,
    pitchOffsets: Array(8).fill(0),
    accentLevels: Array(8).fill(0),
    flamCounts: Array(8).fill(1),
    glideSteps: Array(8).fill(false),
    reverseSteps: Array(8).fill(false),
    preSilenceMsOffsets: Array(8).fill(0),
    cellChopIndices: Array(8).fill(-1),
    chordIndices: Array(8).fill(0),
    volumeOffsets: [],
    mixVolumeOffsets: [],
    panOffsets: [],
    toneOffsets: [],
    send1Offsets: [],
    send2Offsets: [],
    send3Offsets: [],
    send4Offsets: [],
    sampleStartMsOffsets: [],
    sampleEndMsOffsets: [],
    activeCellParameterName: "pitch",
    sampleKey: null,
    sampleDurationMs: 0,
    sampleStartMs: 0,
    sampleEndMs: 0,
    swing: 0,
    globalPitchOffset: 0,
    speedMultiplier: 1,
    pitchSyncMode: false,
    timeStretchMode: false,
    stretchToCell: false,
    loopEnabled: false,
    loopStartMs: 0,
    loopEndMs: 0,
    chopPointsMs: [],
    defaultChopIndex: -1,
    melodicPitchMode: false,
    isReversed: false,
    preSilenceMs: 0,
    rhythmicOffsetRatios: [],
    renderGain: 1,
    gain: 1,
    volume: 1,
    pan: 0,
    tone: 0,
    toneFilterMode: "tone",
    toneQ: 0.707,
    filterDrive: 0,
    globalFineTuneCents: 0,
    chokeGroup: 0,
    voiceMode: "mono",
    stereoMode: 0,
    send1Level: 0,
    send2Level: 0,
    send3Level: 0,
    send4Level: 0,
    glidePercent: 0,
    freeRate: 1,
    freeRateEnabled: false,
    speedRatioLabel: "1:1",
    stretchTimeOnly: false,
    launchScheduled: false,
    isStopped: false,
    playbackDirectionReversed: false,
    ownerAttack: 0,
    ownerGate: 0,
    loopCrossfadeMs: 10,
    locatorStartStep: 0,
    locatorLengthSteps: 8,
    locatorRepeatActive: false,
    modSlots: [],
    outputAssign: 0,
    tuning: 0,
    ...over,
  }) as GridTrackState;

/**
 * These tests run in node, which has no `localStorage`. The store degrades
 * gracefully without it (every access is guarded — a missing/blocked storage
 * must never break the grid), so the persistence behaviour needs a stub to be
 * observable at all.
 */
const memoryStorage = (() => {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
})();
vi.stubGlobal("localStorage", memoryStorage);

beforeEach(() => {
  vi.useFakeTimers();
  memoryStorage.clear();
  resetShadows();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("shadow PatternStore drift detector", () => {
  it("verified: prediction matches the authoritative push at settle", () => {
    const base = track();
    shadowAuthoritative(0, base); // clean adopt = baseline
    shadowLocalOp(0, { op: "toggleStep", step: 4 });
    // Swift processes the same op and pushes ~35ms later:
    shadowAuthoritative(0, applyGridOp(base, { op: "toggleStep", step: 4 }));
    vi.advanceTimersByTime(SETTLE_MS + 10);
    expect(usePatternStore.getState().verifiedCount).toBe(1);
    expect(usePatternStore.getState().driftCount).toBe(0);
  });

  it("drift: a diverging push is counted with the canonical diff", () => {
    const base = track();
    shadowAuthoritative(0, base);
    shadowLocalOp(0, { op: "toggleStep", step: 4 });
    // Swift (hypothetically) lands the note on the wrong step:
    shadowAuthoritative(0, applyGridOp(base, { op: "toggleStep", step: 5 }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.advanceTimersByTime(SETTLE_MS + 10);
    expect(usePatternStore.getState().driftCount).toBe(1);
    expect(usePatternStore.getState().lastDrift?.trackIndex).toBe(0);
    expect(usePatternStore.getState().lastDrift?.predicted).toContain('"steps":[0,0,0,0,1,0,0,0]');
    warn.mockRestore();
  });

  it("mid-gesture pushes are stashed, not adopted — the chain stays initial+ops", () => {
    const base = track();
    shadowAuthoritative(0, base);
    shadowLocalOp(0, { op: "toggleStep", step: 2 });
    // interim push reflecting op 1 arrives while op 2 is being made
    shadowAuthoritative(0, applyGridOp(base, { op: "toggleStep", step: 2 }));
    shadowLocalOp(0, { op: "cycleAccent", step: 2 });
    // final push reflects both ops
    let final = applyGridOp(base, { op: "toggleStep", step: 2 });
    final = applyGridOp(final, { op: "cycleAccent", step: 2 });
    shadowAuthoritative(0, final);
    vi.advanceTimersByTime(SETTLE_MS + 10);
    expect(usePatternStore.getState().verifiedCount).toBe(1);
    expect(usePatternStore.getState().driftCount).toBe(0);
  });

  it("unmodeled ops (adjustParameter) poison the chain — settle adopts silently", () => {
    const base = track();
    shadowAuthoritative(0, base);
    shadowLocalOp(0, { op: "adjustParameter", step: 3, delta: 1 });
    shadowAuthoritative(0, track({ pitchOffsets: Object.assign(Array(8).fill(0), { 3: 2 }) }));
    vi.advanceTimersByTime(SETTLE_MS + 10);
    expect(usePatternStore.getState().verifiedCount).toBe(0);
    expect(usePatternStore.getState().driftCount).toBe(0);
  });

  it("trackEdit poisons via shadowUnmodeledEdit (stepCount would false-drift)", () => {
    const base = track();
    shadowAuthoritative(0, base);
    shadowUnmodeledEdit(0); // e.g. setStepCount 8→16
    shadowAuthoritative(0, track({ stepCount: 16, steps: Array(16).fill(false) }));
    vi.advanceTimersByTime(SETTLE_MS + 10);
    expect(usePatternStore.getState().driftCount).toBe(0);
    // the adopted 16-step state is the new baseline for the next chain
    shadowLocalOp(0, { op: "toggleStep", step: 12 });
    shadowAuthoritative(
      0,
      applyGridOp(track({ stepCount: 16, steps: Array(16).fill(false) }), {
        op: "toggleStep",
        step: 12,
      }),
    );
    vi.advanceTimersByTime(SETTLE_MS + 10);
    expect(usePatternStore.getState().verifiedCount).toBe(1);
  });

  it("bookkeeping ops (begin/endUndo) never dirty the chain", () => {
    const base = track();
    shadowAuthoritative(0, base);
    shadowLocalOp(0, { op: "beginUndo" });
    shadowLocalOp(0, { op: "endUndo" });
    vi.advanceTimersByTime(SETTLE_MS + 10);
    expect(usePatternStore.getState().verifiedCount).toBe(0);
    expect(usePatternStore.getState().driftCount).toBe(0);
  });

  it("COW undo: one snapshot per gesture bracket, pop restores it", () => {
    const base = track();
    shadowAuthoritative(0, base);
    // gesture 1: bracket around two ops = ONE snapshot
    shadowLocalOp(0, { op: "beginUndo" });
    shadowLocalOp(0, { op: "toggleStep", step: 2 });
    shadowLocalOp(0, { op: "beginUndo" }); // nested (lazy re-begin) — ignored
    shadowLocalOp(0, { op: "cycleAccent", step: 2 });
    shadowLocalOp(0, { op: "endUndo" });
    expect(shadowUndoDepth(0)).toBe(1);
    // gesture 2
    shadowLocalOp(0, { op: "beginUndo" });
    shadowLocalOp(0, { op: "toggleStep", step: 6 });
    shadowLocalOp(0, { op: "endUndo" });
    expect(shadowUndoDepth(0)).toBe(2);
    // pop gesture 2 → the state before it (gesture 1 applied, step 6 empty)
    const snap = shadowUndoPop(0)!;
    expect(snap.steps[2]).toBe(true);
    expect(snap.steps[6]).toBe(false);
    expect(shadowUndoDepth(0)).toBe(1);
  });

  it("external/native pushes while clean adopt directly as the new baseline", () => {
    shadowAuthoritative(0, track());
    const external = track({ steps: Object.assign(Array(8).fill(false), { 7: true }) });
    shadowAuthoritative(0, external); // no local op — native edit
    shadowLocalOp(0, { op: "toggleStep", step: 1 });
    shadowAuthoritative(0, applyGridOp(external, { op: "toggleStep", step: 1 }));
    vi.advanceTimersByTime(SETTLE_MS + 10);
    expect(usePatternStore.getState().verifiedCount).toBe(1);
    expect(usePatternStore.getState().driftCount).toBe(0);
  });
});

/**
 * COVERAGE is the gate, not volume. The user ran 118 clean edits — but a bare
 * total cannot distinguish "118 toggleSteps" (one reducer proven, eight
 * untouched) from real coverage, and setCellLength/wrap is exactly where the
 * P5-03 golden harness already caught two real bugs.
 */
describe("reducer coverage (the real flip gate)", () => {
  const verifyOp = (trackIndex: number, base: GridTrackState, op: GridOp) => {
    shadowAuthoritative(trackIndex, base);
    shadowLocalOp(trackIndex, op);
    shadowAuthoritative(trackIndex, applyGridOp(base, op));
    vi.advanceTimersByTime(SETTLE_MS + 10);
  };

  it("credits only the reducers actually exercised", () => {
    const base = track();
    verifyOp(0, base, { op: "toggleStep", step: 4 });
    verifyOp(0, track(), { op: "toggleStep", step: 5 });

    const st = usePatternStore.getState();
    expect(st.verifiedCount).toBe(2);
    expect(st.verifiedByOp.toggleStep).toBe(2);

    // Two clean verifications, and EVERY other reducer still unproven — a passing count that is
    // NOT a passing gate. This is the distinction the badge makes.
    //
    // P5-06 step C widened the gate from 9 cell reducers to 54 (9 gridEdit + 45 trackEdit). The
    // old assertion (`missing.length === 8`) is exactly the shape of thinking that made "9/9
    // clean" read as proof of the write path when it covered nine of ~85 ops. The gate is
    // "nothing missing", never a fixed number — so this asserts the PROPERTY, not the count.
    const { covered, missing } = shadowCoverage(st.verifiedByOp);
    expect(covered).toEqual(["toggleStep"]);
    expect(missing).toContain("setCellLength"); // an unexercised CELL reducer
    expect(missing).toContain("setGain"); // …and an unexercised TRACK reducer
    expect(missing).not.toContain("toggleStep");
    expect(missing.length).toBeGreaterThan(8); // the gate got WIDER, deliberately
  });

  it("a drifting settle credits NO coverage (an unproven reducer stays unproven)", () => {
    const base = track({ steps: Object.assign(Array(8).fill(false), { 0: true }) });
    shadowAuthoritative(0, base);
    shadowLocalOp(0, { op: "setCellLength", step: 0, length: 3 });
    // Engine reports something else → drift.
    shadowAuthoritative(0, applyGridOp(base, { op: "setCellLength", step: 0, length: 4 }));
    vi.advanceTimersByTime(SETTLE_MS + 10);

    expect(usePatternStore.getState().driftCount).toBe(1);
    expect(usePatternStore.getState().verifiedByOp.setCellLength).toBeUndefined();
    expect(shadowCoverage(usePatternStore.getState().verifiedByOp).missing).toContain(
      "setCellLength",
    );
  });

  it("coverage is complete only when every verifiable reducer has run clean", () => {
    const full: Record<string, number> = {};
    // Derived from the reducer sets, never hand-listed — a hand-listed set silently stops
    // covering the reducer someone adds tomorrow, which is how a gate rots into a rubber stamp.
    for (const op of [...VERIFIABLE_GRID_OPS, ...VERIFIABLE_TRACK_OPS]) {
      full[op] = 1;
    }
    expect(shadowCoverage(full).missing).toEqual([]);
  });
});

/**
 * The evidence gate is cumulative and the web view is reloaded constantly (every
 * rebuild, every panel remount). A drift seen once and lost to a reload is a
 * real failure — it happened to the user: a badge appeared, then vanished for
 * good, taking the console diff with it. The counters must therefore survive.
 */
describe("shadow evidence persistence (survives a page reload)", () => {
  it("restores counters + the last drift record from storage", () => {
    const base = track();
    shadowAuthoritative(0, base);
    shadowLocalOp(0, { op: "toggleStep", step: 4 });
    // Swift reports something else → drift.
    shadowAuthoritative(0, applyGridOp(base, { op: "toggleStep", step: 5 }));
    vi.advanceTimersByTime(SETTLE_MS + 10);
    expect(usePatternStore.getState().driftCount).toBe(1);

    // Simulate the reload: the persisted blob is what a fresh module would load.
    const raw = localStorage.getItem("sl.shadowEvidence.v2");
    expect(raw).toBeTruthy();
    const restored = JSON.parse(raw!);
    expect(restored.driftCount).toBe(1);
    expect(restored.lastDrift.trackIndex).toBe(0);
    // The canonical diff is preserved — the whole point (it used to live only
    // in a console nobody had open).
    expect(restored.lastDrift.predicted).not.toBe(restored.lastDrift.authoritative);
  });

  it("resetShadowEvidence clears the persisted record", () => {
    const base = track();
    shadowAuthoritative(0, base);
    shadowLocalOp(0, { op: "toggleStep", step: 4 });
    shadowAuthoritative(0, applyGridOp(base, { op: "toggleStep", step: 5 }));
    vi.advanceTimersByTime(SETTLE_MS + 10);

    resetShadowEvidence();
    expect(usePatternStore.getState().driftCount).toBe(0);
    expect(usePatternStore.getState().lastDrift).toBeNull();
    const raw = JSON.parse(localStorage.getItem("sl.shadowEvidence.v2")!);
    expect(raw.driftCount).toBe(0);
  });
});
