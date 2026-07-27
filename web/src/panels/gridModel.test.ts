import { describe, expect, it } from "vitest";
import type { GridTrackState } from "../../protocol/schema.ts";
import {
  applyCycleAccent,
  applyCycleFlam,
  applySetAccent,
  applySetCellLength,
  applySetFlam,
  applySetGlide,
  applySetPreSilence,
  applySetReverse,
  applyToggleStep,
  cellHasHiddenData,
  cellHiddenLaneTags,
  cellParamChipLabel,
  cellParamShortLabel,
  cellParamValueLabel,
  cellValueLabel,
  commaEndTarget,
  fitReadout,
  laneValueLabel,
  noteCellLabel,
  computeDragEnd,
  cycleDialParam,
  dragEndRef,
  paramEditPolicy,
  paramHasCellData,
  regGrabTarget,
  resolveValueTargets,
  gridRowLayout,
  nextTrackJump,
  resolveCellAt,
  rowSlices,
  sharedCellWidth,
  sliceSpanInterval,
  spanFragments,
  spanPointX,
  trackModeLabel,
  trackSubModeLabel,
  type CellRect,
} from "./gridModel.ts";

// Fixtures for THE owner-resolution guard (grid.md §2) — the function that
// replaces five duplicated Swift owner-scans.
describe("resolveCellAt", () => {
  const steps = (n: number, owners: number[]) =>
    Array.from({ length: n }, (_, i) => owners.includes(i));

  it("owner step resolves to itself", () => {
    const r = resolveCellAt(steps(16, [4]), lengths(16, { 4: 3 }), null, 4);
    expect(r).toEqual({ owner: 4, span: 3, offsetInCell: 0, viaWrap: false });
  });

  it("covered step resolves to its owner", () => {
    const r = resolveCellAt(steps(16, [4]), lengths(16, { 4: 3 }), null, 6);
    expect(r?.owner).toBe(4);
    expect(r?.offsetInCell).toBe(2);
  });

  it("step past the span is empty", () => {
    expect(resolveCellAt(steps(16, [4]), lengths(16, { 4: 3 }), null, 7)).toBeNull();
  });

  it("a nearer owner shadows an earlier long cell", () => {
    // owner 2 span 8 would cover step 5, but owner 5 sits in between.
    const r = resolveCellAt(steps(16, [2, 5]), lengths(16, { 2: 8, 5: 1 }), null, 5);
    expect(r?.owner).toBe(5);
  });

  it("span clamps at the pattern end without wrap", () => {
    const r = resolveCellAt(steps(16, [14]), lengths(16, { 14: 4 }), null, 15);
    expect(r?.owner).toBe(14);
    expect(r?.span).toBe(2); // clamped 14..15
  });

  it("wrap continuation covers early steps", () => {
    // owner 14, span 4 → wraps 2 steps past end → covers steps 0 and 1.
    const r = resolveCellAt(steps(16, [14]), lengths(16, { 14: 4 }), 14, 1);
    expect(r).toEqual({ owner: 14, span: 2, offsetInCell: 3, viaWrap: true });
    expect(resolveCellAt(steps(16, [14]), lengths(16, { 14: 4 }), 14, 2)).toBeNull();
  });

  it("out-of-range steps are null (the Swift OOB bug class, fixed)", () => {
    expect(resolveCellAt(steps(16, [4]), lengths(16, {}), null, 16)).toBeNull();
    expect(resolveCellAt(steps(16, [4]), lengths(16, {}), null, -1)).toBeNull();
  });

  function lengths(n: number, m: Record<number, number>): number[] {
    return Array.from({ length: n }, (_, i) => m[i] ?? 1);
  }
});

describe("rowSlices", () => {
  it("scroll mode is one row holding ALL steps (never clipped to zoom)", () => {
    expect(rowSlices(64, 16, false)).toEqual([{ startStep: 0, count: 64 }]);
    expect(rowSlices(16, 16, false)).toEqual([{ startStep: 0, count: 16 }]);
  });
  it("split wraps into rows", () => {
    expect(rowSlices(40, 16, true)).toEqual([
      { startStep: 0, count: 16 },
      { startStep: 16, count: 16 },
      { startStep: 32, count: 8 },
    ]);
  });
  it("short patterns are one row", () => {
    expect(rowSlices(8, 16, true)).toEqual([{ startStep: 0, count: 8 }]);
  });
});

// Cell width is SHARED (native calculatePadSize) so columns align across
// tracks of different lengths — the "expands wrong with length" fix.
describe("sharedCellWidth", () => {
  it("divides by min(maxStepCount, zoom)", () => {
    expect(sharedCellWidth(1600, 8, 16)).toBe(200); // all ≤ zoom → fills to 8 cells
    expect(sharedCellWidth(1600, 16, 16)).toBe(100);
    expect(sharedCellWidth(1600, 32, 16)).toBe(100); // > zoom → capped at zoom (split)
  });
  it("a shorter track keeps the SAME cell width (columns align)", () => {
    // With max=16, a 16-step and an 8-step track share cellW; step 5 lands at
    // the same x in both (base + 5·cellW), so columns line up.
    const cellW = sharedCellWidth(1600, 16, 16);
    const x = (step: number) => step * cellW;
    expect(x(5)).toBe(500); // identical regardless of that track's own length
    expect(cellW).toBe(100);
  });
});

describe("computeDragEnd (exact native math, ContentView :2530–2537)", () => {
  it("in-pattern drag spans owner→pointer inclusive", () => {
    expect(computeDragEnd(4, 7, 16)).toEqual({ length: 4, wrapLength: 0 });
  });
  it("dragging left of the owner grows rightward by the same count (native abs quirk)", () => {
    expect(computeDragEnd(4, 2, 16)).toEqual({ length: 3, wrapLength: 0 });
  });
  it("pointer past the end overflows into wrapLength", () => {
    // owner 14, virtual pointer step 17 → in-pattern 14..15 + 2 wrapped.
    expect(computeDragEnd(14, 17, 16)).toEqual({ length: 2, wrapLength: 2 });
  });
  it("a step-0 owner cannot wrap", () => {
    expect(computeDragEnd(0, 18, 16)).toEqual({ length: 16, wrapLength: 0 });
  });
  it("drag back onto the owner is length 1", () => {
    expect(computeDragEnd(4, 4, 16)).toEqual({ length: 1, wrapLength: 0 });
  });
});

describe("dragEndRef (wrap-tail remap, native :2590)", () => {
  it("remaps low pointer indices past the end while resizing a wrap cell", () => {
    expect(dragEndRef(14, 1, 16, true)).toBe(17);
  });
  it("leaves in-span pointers alone", () => {
    expect(dragEndRef(14, 15, 16, true)).toBe(15);
    expect(dragEndRef(4, 2, 16, false)).toBe(2);
  });
});

describe("row-split cell fragments (split-mode region idiom)", () => {
  // 16-cell rows, 100px cells at x0=0; row height 60. Step s of row r lands
  // at x = (s % 16)·100, y = r·60 — the same shape buildCellRects produces.
  const rectAt = (step: number): CellRect => ({
    x: (step % 16) * 100 + 1,
    y: Math.floor(step / 16) * 60 + 1,
    w: 98,
    h: 58,
  });

  it("a span inside one row is a single fragment covering [0,1)", () => {
    const frags = spanFragments(4, 3, rectAt);
    expect(frags).toHaveLength(1);
    expect(frags[0]).toMatchObject({ x: 401, w: 298, v0: 0, v1: 1 });
  });

  it("a span crossing the row break (12–20) splits into per-row fragments", () => {
    const frags = spanFragments(12, 9, rectAt); // steps 12..20
    expect(frags).toHaveLength(2);
    // Row 0: steps 12..15 = 4/9 of the span.
    expect(frags[0]).toMatchObject({ x: 1201, y: 1, v0: 0, v1: 4 / 9 });
    expect(frags[0]!.w).toBeCloseTo(398);
    // Row 1: steps 16..20 = the remaining 5/9, starting at column 0.
    expect(frags[1]).toMatchObject({ x: 1, y: 61, v0: 4 / 9, v1: 1 });
    expect(frags[1]!.w).toBeCloseTo(498);
  });

  it("sliceSpanInterval degenerates to linear mapping on one fragment", () => {
    const frags = spanFragments(0, 4, rectAt);
    const s = sliceSpanInterval(frags, 0.25, 0.5);
    expect(s).toHaveLength(1);
    expect(s[0]!.x).toBeCloseTo(1 + 0.25 * 398);
    expect(s[0]!.w).toBeCloseTo(0.25 * 398);
    expect(s[0]).toMatchObject({ t0: 0, t1: 1 });
  });

  it("an interval straddling the break splits with proportional audio sub-ranges", () => {
    const frags = spanFragments(12, 9, rectAt);
    // Segment covering span fractions [2/9, 6/9): 2 steps on row 0, 2 on row 1.
    const s = sliceSpanInterval(frags, 2 / 9, 6 / 9);
    expect(s).toHaveLength(2);
    expect(s[0]!.fr).toBe(frags[0]);
    expect(s[1]!.fr).toBe(frags[1]);
    // Audio sub-ranges tile the interval: row 0 shows the first half,
    // row 1 the second half.
    expect(s[0]!.t0).toBeCloseTo(0);
    expect(s[0]!.t1).toBeCloseTo(0.5);
    expect(s[1]!.t0).toBeCloseTo(0.5);
    expect(s[1]!.t1).toBeCloseTo(1);
    // Pixel slices: steps 14..15 on row 0, steps 16..17 on row 1.
    expect(s[0]!.x).toBeCloseTo(1201 + 199);
    expect(s[1]!.x).toBeCloseTo(1);
  });

  it("spanPointX puts an exact-break point on the incoming fragment", () => {
    const frags = spanFragments(12, 9, rectAt);
    expect(spanPointX(frags, 4 / 9)!.fr).toBe(frags[1]);
    expect(spanPointX(frags, 4 / 9)!.x).toBeCloseTo(1);
    // Interior points map linearly inside their fragment.
    expect(spanPointX(frags, 2 / 9)!.x).toBeCloseTo(1201 + 199);
    // The span end clamps to the last fragment (guard, not reachable live).
    expect(spanPointX(frags, 1)!.fr).toBe(frags[1]);
  });
});

describe("cellValueLabel", () => {
  const track = (over: Partial<GridTrackState>): GridTrackState => ({
    name: "T",
    colorHex: "#ff0000",
    trackType: "audio",
    playbackMode: "regular",
    stepCount: 16,
    muted: false,
    soloed: false,
    patternStartStep: null,
    locatorStart: null,
    locatorLength: null,
    steps: Array(16).fill(false),
    cellLengths: Array(16).fill(1),
    wrapSourceStep: null,
    pitchOffsets: Array(16).fill(0),
    accentLevels: Array(16).fill(0),
    flamCounts: Array(16).fill(1),
    glideSteps: Array(16).fill(false),
    reverseSteps: Array(16).fill(false),
    preSilenceMsOffsets: Array(16).fill(0),
    cellChopIndices: Array(16).fill(-1),
    chordIndices: Array(16).fill(0),
    volumeOffsets: Array(16).fill(0),
    mixVolumeOffsets: Array(16).fill(0),
    panOffsets: Array(16).fill(0),
    toneOffsets: Array(16).fill(0),
    sampleStartMsOffsets: Array(16).fill(0),
    sampleEndMsOffsets: Array(16).fill(0),
    activeCellParameterName: "pitch",
    sampleKey: null,
    sampleDurationMs: 0,
    sampleStartMs: 0,
    sampleEndMs: 0,
    swing: 0,
    globalPitchOffset: 0,
    speedMultiplier: 1,
    rateLockRatio: 1,
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
    samplePeakGain: 1,
    chopPoints: [],
    chopCount: 1,
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
    stretchTimeOnly: false,
    launchScheduled: false,
    isStopped: false,
    beatRepeatSteps: [],
    beatRepeatSubStep: -1,
    beatRepeatSubStart: 0,
    beatRepeatSubLen: 0,
    instrumentPresetIndex: null,
    instrumentPresetCount: null,
    instrumentPresetName: null,
    playbackDirectionReversed: false,
    ownerAttack: 0,
    ownerGate: 0,
    loopCrossfadeMs: 10,
    locatorStartStep: 0,
    locatorEndStep: 15,
    locatorLengthSteps: 16,
    locatorRepeatActive: false,
    modSlots: [],
    outputAssign: 0,
    tuning: 0,
    muteGroupMember: false,
    instrumentOutEnabled: false,
    midiOutEnabled: false,
    midiRootNote: 60,
    midiGatePercent: 100,
    midiVelocities: [],
    hasInstrument: false,
    instrumentName: null,
    midiInputPinned: false,
    ...over,
  });

  it("pitch renders quarter-tones as signed semitones", () => {
    const t = track({ pitchOffsets: Object.assign(Array(16).fill(0), { 3: 3 }) });
    expect(cellValueLabel(t, 3)).toBe("+1.5");
    expect(cellValueLabel(t, 4)).toBe(""); // default = no label
  });

  it("negative pitch keeps its sign", () => {
    const t = track({ pitchOffsets: Object.assign(Array(16).fill(0), { 0: -4 }) });
    expect(cellValueLabel(t, 0)).toBe("-2");
  });

  it("per-track active parameter picks the array", () => {
    const t = track({
      activeCellParameterName: "tone",
      toneOffsets: Object.assign(Array(16).fill(0), { 5: 12 }),
    });
    expect(cellValueLabel(t, 5)).toBe("+12");
  });

  it("sends are NOT per-cell (grid.md §8 lock) — send cases render nothing", () => {
    // P5-06 step B moved this lock into the WIRE: `send1..4Offsets` were deleted from the grid
    // topic precisely BECAUSE the lock means nothing ever read them (4 dead arrays × 16 tracks
    // on every push). Arming the send param must still render an empty cell — the lock holds,
    // and now the payload agrees with it.
    const t = track({ activeCellParameterName: "send2" });
    expect(cellValueLabel(t, 5)).toBe("");
  });

  it("flam shows ×N above 1", () => {
    const t = track({
      activeCellParameterName: "flam",
      flamCounts: Object.assign(Array(16).fill(1), { 2: 3 }),
    });
    expect(cellValueLabel(t, 2)).toBe("×3");
    expect(cellValueLabel(t, 3)).toBe("");
  });

  it("chop is 1-indexed for display, −1 = off", () => {
    const t = track({
      activeCellParameterName: "chop",
      cellChopIndices: Object.assign(Array(16).fill(-1), { 0: 0 }),
    });
    expect(cellValueLabel(t, 0)).toBe("C1");
    expect(cellValueLabel(t, 1)).toBe("");
  });

  // The MIDI lanes. `midiNote` reads the SAME pitchOffsets the sampler pitches
  // with — it just renders the note the synth will play instead of an offset.
  it("midiNote shows the note the cell actually plays (root + cell pitch)", () => {
    const t = track({
      activeCellParameterName: "midiNote",
      midiRootNote: 60, // C3
      pitchOffsets: [0, 4, -2, 24], // quarter-tones → +0, +2, −1, +12 semitones
    });
    expect(cellValueLabel(t, 0)).toBe("C3");
    expect(cellValueLabel(t, 1)).toBe("D3");
    expect(cellValueLabel(t, 2)).toBe("B2");
    expect(cellValueLabel(t, 3)).toBe("C4");
  });

  it("midiVelocity is blank where the cell has no value of its own", () => {
    const t = track({ activeCellParameterName: "midiVelocity", midiVelocities: [100, 127] });
    expect(cellValueLabel(t, 0)).toBe("100");
    expect(cellValueLabel(t, 1)).toBe("127");
    expect(cellValueLabel(t, 2)).toBe(""); // past the lane → nothing to show
  });

  it("cellLength shows the note's length, blank at the default single step", () => {
    const t = track({ activeCellParameterName: "cellLength", cellLengths: [1, 4] });
    expect(cellValueLabel(t, 0)).toBe("");
    expect(cellValueLabel(t, 1)).toBe("4");
  });

  it("midiPitch (pitch-bend) is still unported and renders nothing", () => {
    expect(cellValueLabel(track({ activeCellParameterName: "midiPitch" }), 0)).toBe("");
  });

  // TR-4f: chord = Family-1 dial; the in-cell label is the library shortLabel
  // (native ContentView :2998 renders it on the owner cell, blank when OFF).
  it("chord shows the library short label, blank when OFF", () => {
    const t = track({
      activeCellParameterName: "chord",
      chordIndices: Object.assign(Array(16).fill(0), { 2: 1, 4: 5, 6: 12 }),
    });
    expect(cellValueLabel(t, 2)).toBe("OCT");
    expect(cellValueLabel(t, 4)).toBe("MAJ");
    expect(cellValueLabel(t, 6)).toBe("AD9");
    expect(cellValueLabel(t, 3)).toBe(""); // OFF
  });

  it("chord out-of-range index renders blank (never a wrong voicing)", () => {
    const t = track({
      activeCellParameterName: "chord",
      chordIndices: Object.assign(Array(16).fill(0), { 0: 99 }),
    });
    expect(cellValueLabel(t, 0)).toBe("");
  });

  // P5-PCE selection core (percell-selection-ux.md P1, CONFIRM 2026-07-12).
  describe("cellParamValueLabel (focused-cell live label, defaults shown)", () => {
    it("shows the armed param at default value (always-on)", () => {
      expect(cellParamValueLabel(track({}), 0)).toBe("PIT 0");
      expect(cellParamValueLabel(track({ activeCellParameterName: "tone" }), 0)).toBe("TON 0");
    });

    it("pitch renders quarter-tones as signed semitones", () => {
      const t = track({ pitchOffsets: Object.assign(Array(16).fill(0), { 3: 3 }) });
      expect(cellParamValueLabel(t, 3)).toBe("PIT +1.5");
    });

    it("sample offsets carry the ms suffix", () => {
      const t = track({
        activeCellParameterName: "sampleEnd",
        sampleEndMsOffsets: Object.assign(Array(16).fill(0), { 2: -40 }),
      });
      expect(cellParamValueLabel(t, 2)).toBe("END -40ms");
      expect(cellParamValueLabel(t, 0)).toBe("END 0ms");
    });

    it("mark params still label when armed via the legacy tools", () => {
      expect(cellParamValueLabel(track({ activeCellParameterName: "flam" }), 0)).toBe("FLM ×1");
      expect(cellParamValueLabel(track({ activeCellParameterName: "accent" }), 0)).toBe("ACC 0");
    });

    it("chord reads CHD <label>, em-dash at OFF (TR-4f)", () => {
      const t = track({
        activeCellParameterName: "chord",
        chordIndices: Object.assign(Array(16).fill(0), { 1: 4 }),
      });
      expect(cellParamValueLabel(t, 1)).toBe("CHD MIN");
      expect(cellParamValueLabel(t, 0)).toBe("CHD —");
    });
  });

  describe("cycleDialParam ([ ] and Ö/Ä param cycle)", () => {
    it("cycles the chip order and wraps", () => {
      expect(cycleDialParam("pitch", 1)).toBe("tone");
      expect(cycleDialParam("sampleEnd", 1)).toBe("pitch");
      expect(cycleDialParam("pitch", -1)).toBe("sampleEnd");
    });

    it("re-enters at the ends from a non-dial param (accent/glide/flam)", () => {
      expect(cycleDialParam("accent", 1)).toBe("pitch");
      expect(cycleDialParam("glide", -1)).toBe("sampleEnd");
    });
  });

  describe("paramHasCellData (chip data-dot)", () => {
    it("true only when the param's offsets carry a value", () => {
      const t = track({ panOffsets: Object.assign(Array(16).fill(0), { 7: -0.3 }) });
      expect(paramHasCellData(t, "pan")).toBe(true);
      expect(paramHasCellData(t, "pitch")).toBe(false);
      expect(paramHasCellData(t, "accent")).toBe(false); // marks never dot
    });
  });

  // TR-FT-3: the REG resize-grab mirror of native regExtendedCellOwner
  // (ContentView :2720–2746) — the owner press is EXCLUDED so a stationary
  // click on it can remove the whole extended cell.
  describe("regGrabTarget", () => {
    it("covered non-owner step grabs the covering cell's owner", () => {
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 2: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 2: 5 }),
      });
      expect(regGrabTarget(t, 4)).toEqual({ owner: 2, isWrap: false });
    });

    it("the OWNER itself is NOT a grab (fresh-anchor path → removable)", () => {
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 2: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 2: 5 }),
      });
      expect(regGrabTarget(t, 2)).toBeNull();
    });

    it("uncovered steps and OWN mode never grab", () => {
      expect(regGrabTarget(track({}), 4)).toBeNull();
      const own = track({
        playbackMode: "owner",
        steps: Object.assign(Array(16).fill(false), { 2: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 2: 5 }),
      });
      expect(regGrabTarget(own, 4)).toBeNull();
    });

    it("Swift wrap encoding: tail steps grab cell 0; step 0 grabs the SOURCE", () => {
      // owner 14 len 2 (in-pattern) + continuation cell at 0 len 3.
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 0: true, 14: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 0: 3, 14: 2 }),
        wrapSourceStep: 14,
      });
      expect(regGrabTarget(t, 1)).toEqual({ owner: 0, isWrap: false }); // forward scan via cell 0 (native)
      expect(regGrabTarget(t, 0)).toEqual({ owner: 14, isWrap: true }); // wrap branch (step 0 only)
    });
  });

  // P5-PCE P2.3: the per-param edit policy that stops the Swift OOB write.
  describe("resolveValueTargets / paramEditPolicy", () => {
    it("pitch is step-anchored (each in-bounds step kept as-is)", () => {
      expect(paramEditPolicy("pitch")).toBe("stepAnchored");
      const t = track({ steps: Object.assign(Array(16).fill(false), { 2: true, 5: true }) });
      expect(resolveValueTargets(t, [2, 5, 99], "pitch")).toEqual([2, 5]); // OOB dropped
    });

    it("owner-cell params remap a covered step to its owner", () => {
      // one 4-step cell owned at step 4 covers 4..7
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 4: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 4: 4 }),
      });
      expect(paramEditPolicy("sampleStart")).toBe("ownerRemap");
      expect(resolveValueTargets(t, [6], "sampleStart")).toEqual([4]); // covered→owner
    });

    it("a selection spanning one owner cell dedupes to a single write", () => {
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 4: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 4: 4 }),
      });
      expect(resolveValueTargets(t, [4, 5, 6, 7], "tone")).toEqual([4]);
    });

    it("owner-remap skips a step with no covering cell (nothing to edit)", () => {
      const t = track({ steps: Object.assign(Array(16).fill(false), { 4: true }) });
      expect(resolveValueTargets(t, [9], "pan")).toEqual([]); // empty step → no write
    });
  });

  // P5-PCE in-cell affordance reducers (incell-affordance-ux.md §4.4).
  describe("affordance reducers", () => {
    it("applySetReverse toggles the owner flag", () => {
      const on = applySetReverse(track({}), 3, true);
      expect(on.reverseSteps[3]).toBe(true);
      expect(applySetReverse(on, 3, false).reverseSteps[3]).toBe(false);
    });

    it("applySetAccent sets the level AND activates the step", () => {
      const r = applySetAccent(track({}), 5, 2);
      expect(r.accentLevels[5]).toBe(2);
      expect(r.steps[5]).toBe(true); // native activate-on-set
    });

    it("applySetFlam clamps 1…16", () => {
      expect(applySetFlam(track({}), 0, 20).flamCounts[0]).toBe(16);
      expect(applySetFlam(track({}), 0, 0).flamCounts[0]).toBe(1);
    });

    it("applySetGlide materializes ALL-TRUE for a legacy track then toggles", () => {
      // empty glideSteps + glidePercent>0 = engine glides every transition;
      // the first per-cell write must preserve that (all-true), then set.
      const t = track({ glideSteps: [], glidePercent: 50 });
      const r = applySetGlide(t, 2, false);
      expect(r.glideSteps.length).toBe(t.stepCount);
      expect(r.glideSteps[2]).toBe(false); // the toggled one
      expect(r.glideSteps[0]).toBe(true); // the rest stay glided (legacy sound)
    });

    it("applySetGlide on a modern track just sets the flag", () => {
      const t = track({ glideSteps: Array(16).fill(false), glidePercent: 50 });
      expect(applySetGlide(t, 4, true).glideSteps[4]).toBe(true);
      expect(applySetGlide(t, 4, true).glideSteps[0]).toBe(false); // others untouched
    });

    it("applySetPreSilence stores an absolute value as a base-relative offset", () => {
      const t = track({ preSilenceMs: 20 });
      expect(applySetPreSilence(t, 1, 60).preSilenceMsOffsets[1]).toBe(40); // 60 − base 20
    });
  });

  describe("optimistic reducers", () => {
    it("toggle on stamps a soft-accented owner; toggle off clears both", () => {
      const on = applyToggleStep(track({}), 4);
      expect(on.steps[4]).toBe(true);
      expect(on.accentLevels[4]).toBe(1); // native: drawn notes get soft (:4131)
      const off = applyToggleStep(on, 4);
      expect(off.steps[4]).toBe(false);
      expect(off.accentLevels[4]).toBe(0);
    });

    it("REG: enabling a covered step ONLY shortens the covering cell", () => {
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 2: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 2: 6 }),
      });
      const r = applyToggleStep(t, 5);
      expect(r.steps[5]).toBe(false); // native does NOT enable it (:4120)
      expect(r.cellLengths[2]).toBe(3); // 2..4 remain
    });

    it("OWN mode never shortens neighbours (independent enable + accent)", () => {
      const t = track({
        playbackMode: "owner",
        steps: Object.assign(Array(16).fill(false), { 2: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 2: 6 }),
      });
      const r = applyToggleStep(t, 5);
      expect(r.cellLengths[2]).toBe(6);
      expect(r.steps[5]).toBe(true);
      expect(r.accentLevels[5]).toBe(1);
    });

    it("toggle off a wrap owner clears the whole continuation", () => {
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 0: true, 14: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 0: 2, 14: 4 }),
        wrapSourceStep: 14,
      });
      const r = applyToggleStep(t, 14);
      expect(r.wrapSourceStep).toBeNull();
      expect(r.steps[0]).toBe(false); // continuation cell dies with the source
      expect(r.cellLengths[0]).toBe(1);
    });

    it("setCellLength uses the SWIFT wrap encoding (in-pattern len + cell at 0)", () => {
      const t = track({ steps: Object.assign(Array(16).fill(false), { 14: true }) });
      const r = applySetCellLength(t, 14, 2, 2);
      expect(r.cellLengths[14]).toBe(2); // in-pattern length ONLY (:1418)
      expect(r.steps[0]).toBe(true); // continuation is a real cell at 0
      expect(r.cellLengths[0]).toBe(2);
      expect(r.wrapSourceStep).toBe(14);
      const back = applySetCellLength(r, 14, 2, 0);
      expect(back.wrapSourceStep).toBeNull();
      expect(back.steps[0]).toBe(false);
    });

    it("setCellLength TRUNCATES at the first active step (never absorbs)", () => {
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 2: true, 4: true }),
      });
      const r = applySetCellLength(t, 2, 5, 0);
      expect(r.steps[4]).toBe(true); // the neighbour SURVIVES (:1396)
      expect(r.cellLengths[2]).toBe(2); // extension stops just before it
    });

    it("setCellLength is a no-op on an inactive owner (native guard)", () => {
      const t = track({});
      expect(applySetCellLength(t, 3, 4, 0)).toEqual(t);
    });

    it("accent cycles off→soft→hard→off and activates the step", () => {
      let t = track({});
      t = applyCycleAccent(t, 3);
      expect(t.accentLevels[3]).toBe(1);
      expect(t.steps[3]).toBe(true);
      t = applyCycleAccent(t, 3);
      expect(t.accentLevels[3]).toBe(2);
      t = applyCycleAccent(t, 3);
      expect(t.accentLevels[3]).toBe(0);
    });

    it("flam fast-cycles 1→…→kMaxFlam(16)→1 (native cycleStepFlam parity)", () => {
      let t = track({ steps: Object.assign(Array(16).fill(false), { 0: true }) });
      for (let expected = 2; expected <= 16; expected++) {
        t = applyCycleFlam(t, 0);
        expect(t.flamCounts[0]).toBe(expected);
      }
      t = applyCycleFlam(t, 0); // 16 wraps to 1, not 4
      expect(t.flamCounts[0]).toBe(1);
    });
  });

  // TR-FT-13: "," sets the owning REG cell's END to the focused step —
  // extend, shrink, or (focus before the owner) grow the wrap tail.
  describe("commaEndTarget", () => {
    it("extends forward from a covered step", () => {
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 2: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 2: 3 }),
      });
      expect(commaEndTarget(t, 6)).toEqual({ owner: 2, length: 5, wrapLength: 0 });
    });

    it("extends from an uncovered gap via the backward owner scan", () => {
      const t = track({ steps: Object.assign(Array(16).fill(false), { 2: true }) });
      expect(commaEndTarget(t, 6)).toEqual({ owner: 2, length: 5, wrapLength: 0 });
    });

    it("shrinks when the focus sits inside the span", () => {
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 2: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 2: 6 }),
      });
      const tgt = commaEndTarget(t, 3)!;
      expect(tgt).toEqual({ owner: 2, length: 2, wrapLength: 0 });
      expect(applySetCellLength(t, tgt.owner, tgt.length, tgt.wrapLength).cellLengths[2]).toBe(2);
    });

    it("focus on the owner itself collapses the cell to length 1 (and kills a wrap)", () => {
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 0: true, 14: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 0: 3, 14: 2 }),
        wrapSourceStep: 14,
      });
      const tgt = commaEndTarget(t, 14)!;
      expect(tgt).toEqual({ owner: 14, length: 1, wrapLength: 0 });
      const r = applySetCellLength(t, tgt.owner, tgt.length, tgt.wrapLength);
      expect(r.wrapSourceStep).toBeNull();
      expect(r.steps[0]).toBe(false); // orphaned continuation dies
    });

    it("focus before the only owner extends the wrap tail up to it", () => {
      const t = track({ steps: Object.assign(Array(16).fill(false), { 14: true }) });
      const tgt = commaEndTarget(t, 1)!;
      expect(tgt).toEqual({ owner: 14, length: 2, wrapLength: 2 });
      const r = applySetCellLength(t, tgt.owner, tgt.length, tgt.wrapLength);
      expect(r.cellLengths[14]).toBe(2); // filled to the pattern end
      expect(r.steps[0]).toBe(true); // Swift wrap encoding: real cell at 0
      expect(r.cellLengths[0]).toBe(2); // tail ends AT the focused step
      expect(r.wrapSourceStep).toBe(14);
    });

    it("focus inside the wrap tail remaps the continuation cell to its SOURCE (shrink)", () => {
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 0: true, 14: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 0: 3, 14: 2 }),
        wrapSourceStep: 14,
      });
      // Step 1 is covered by the continuation cell at 0 — "," must resize
      // the wrap of owner 14, not treat step 0 as a real cell.
      expect(commaEndTarget(t, 1)).toEqual({ owner: 14, length: 2, wrapLength: 2 });
    });

    it("focus past the wrap tail extends it (backward scan hits the continuation)", () => {
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 0: true, 14: true }),
        cellLengths: Object.assign(Array(16).fill(1), { 0: 3, 14: 2 }),
        wrapSourceStep: 14,
      });
      expect(commaEndTarget(t, 5)).toEqual({ owner: 14, length: 2, wrapLength: 6 });
    });

    it("a step-0 owner extends in-pattern only (step-0 cells can never wrap)", () => {
      const t = track({ steps: Object.assign(Array(16).fill(false), { 0: true }) });
      expect(commaEndTarget(t, 5)).toEqual({ owner: 0, length: 6, wrapLength: 0 });
    });

    it("the NEAREST active owner wins — extension never crosses another note", () => {
      const t = track({
        steps: Object.assign(Array(16).fill(false), { 2: true, 4: true }),
      });
      const tgt = commaEndTarget(t, 8)!;
      expect(tgt).toEqual({ owner: 4, length: 5, wrapLength: 0 });
      const r = applySetCellLength(t, tgt.owner, tgt.length, tgt.wrapLength);
      expect(r.cellLengths[4]).toBe(5);
      expect(r.cellLengths[2]).toBe(1); // the earlier cell is untouched
    });

    it("inapplicable: OWN mode, empty track, out of bounds", () => {
      expect(commaEndTarget(track({ playbackMode: "owner" }), 3)).toBeNull();
      expect(commaEndTarget(track({}), 3)).toBeNull();
      const t = track({ steps: Object.assign(Array(16).fill(false), { 2: true }) });
      expect(commaEndTarget(t, -1)).toBeNull();
      expect(commaEndTarget(t, 16)).toBeNull();
    });
  });

  // laneValueLabel is the extracted body of cellValueLabel; the refactor must
  // leave the armed-param output identical, and add the previously-unported
  // rhythmic-nudge lane.
  describe("laneValueLabel (arbitrary lane, not just the armed one)", () => {
    it("matches cellValueLabel for the armed param", () => {
      const t = track({
        activeCellParameterName: "tone",
        toneOffsets: Object.assign(Array(16).fill(0), { 5: 12 }),
      });
      expect(laneValueLabel(t, "tone", 5)).toBe(cellValueLabel(t, 5));
      expect(laneValueLabel(t, "tone", 5)).toBe("+12");
    });

    it("reads a lane the track has NOT armed", () => {
      const t = track({
        activeCellParameterName: "pitch", // armed elsewhere
        panOffsets: Object.assign(Array(16).fill(0), { 2: 0.2 }),
      });
      expect(laneValueLabel(t, "pan", 2)).toBe("+0.2");
    });

    it("renders the rhythmic nudge as a signed ratio (blank at 0)", () => {
      const t = track({
        rhythmicOffsetRatios: Object.assign(Array(16).fill(0), { 3: 0.25, 4: -0.5 }),
      });
      expect(laneValueLabel(t, "rhythmicOffset", 3)).toBe("+0.25");
      expect(laneValueLabel(t, "rhythmicOffset", 4)).toBe("-0.5");
      expect(laneValueLabel(t, "rhythmicOffset", 5)).toBe("");
    });
  });

  // Tier 1: the permanent instrument-cell label = note + chord, so a chord
  // voicing stays visible without the CHD param being armed.
  describe("noteCellLabel (permanent note + chord)", () => {
    const note = (over: Partial<GridTrackState>) =>
      track({ trackType: "midi", midiRootNote: 60, ...over });

    it("shows the note alone when no chord is armed", () => {
      expect(noteCellLabel(note({}), 0)).toBe("C3");
    });

    it("appends the chord short label when the cell has a chord", () => {
      const t = note({ chordIndices: Object.assign(Array(16).fill(0), { 0: 4 }) });
      expect(noteCellLabel(t, 0)).toBe("C3 MIN");
    });

    it("reflects the cell's own transposition in the root", () => {
      // +4 quarter-tones = +2 semitones → D3; chord MAJ (index 5)
      const t = note({
        pitchOffsets: Object.assign(Array(16).fill(0), { 1: 4 }),
        chordIndices: Object.assign(Array(16).fill(0), { 1: 5 }),
      });
      expect(noteCellLabel(t, 1)).toBe("D3 MAJ");
    });

    it("drops an out-of-range chord index to note-only (never a wrong voicing)", () => {
      const t = note({ chordIndices: Object.assign(Array(16).fill(0), { 0: 99 }) });
      expect(noteCellLabel(t, 0)).toBe("C3");
    });
  });

  // Tier 2/3: which un-marked, un-armed lanes a cell secretly edits.
  describe("cellHiddenLaneTags / cellHasHiddenData", () => {
    it("flags an un-armed offset lane on an audio cell", () => {
      const t = track({
        activeCellParameterName: "pitch",
        panOffsets: Object.assign(Array(16).fill(0), { 2: 0.2 }),
      });
      expect(cellHiddenLaneTags(t, 2, "pitch")).toEqual(["PAN +0.2"]);
      expect(cellHasHiddenData(t, 2, "pitch")).toBe(true);
      expect(cellHasHiddenData(t, 3, "pitch")).toBe(false); // clean cell
    });

    it("orders tags by the dial order, then the nudge", () => {
      const t = track({
        activeCellParameterName: "sampleStart",
        toneOffsets: Object.assign(Array(16).fill(0), { 0: 10 }),
        panOffsets: Object.assign(Array(16).fill(0), { 0: -0.5 }),
        rhythmicOffsetRatios: Object.assign(Array(16).fill(0), { 0: 0.25 }),
      });
      expect(cellHiddenLaneTags(t, 0, "sampleStart")).toEqual(["TON +10", "PAN -0.5", "NDG +0.25"]);
    });

    it("excludes the armed lane — the chip already shows it", () => {
      const t = track({
        activeCellParameterName: "pan",
        panOffsets: Object.assign(Array(16).fill(0), { 0: 0.2 }),
      });
      expect(cellHiddenLaneTags(t, 0, "pan")).toEqual([]);
    });

    it("folds the pitch/midiNote alias when either is armed", () => {
      const t = track({
        trackType: "midi",
        pitchOffsets: Object.assign(Array(16).fill(0), { 0: 4 }),
      });
      // midiNote armed → the shared pitch lane is considered visible
      expect(cellHiddenLaneTags(t, 0, "midiNote")).toEqual([]);
    });

    it("never flags lanes that already have a standing mark or permanent label", () => {
      const t = track({
        activeCellParameterName: "pitch",
        accentLevels: Object.assign(Array(16).fill(0), { 0: 2 }),
        flamCounts: Object.assign(Array(16).fill(1), { 0: 3 }),
        reverseSteps: Object.assign(Array(16).fill(false), { 0: true }),
        glideSteps: Object.assign(Array(16).fill(false), { 0: true }),
        preSilenceMsOffsets: Object.assign(Array(16).fill(0), { 0: 35 }),
        cellChopIndices: Object.assign(Array(16).fill(-1), { 0: 2 }),
        cellLengths: Object.assign(Array(16).fill(1), { 0: 4 }),
      });
      expect(cellHiddenLaneTags(t, 0, "pitch")).toEqual([]);
    });

    it("velocity flags only when it differs from the track default (cell 0)", () => {
      const t = track({
        trackType: "midi",
        activeCellParameterName: "midiNote",
        midiVelocities: [100, 100, 127],
      });
      expect(cellHasHiddenData(t, 0, "midiNote")).toBe(false); // == default
      expect(cellHasHiddenData(t, 1, "midiNote")).toBe(false); // == default
      expect(cellHiddenLaneTags(t, 2, "midiNote")).toEqual(["VEL 127"]);
    });
  });
});

// TR-1: shared row layout must produce the SAME tops/heights the canvas
// draws (trackrow.md §3 native parity) — pinned so the DOM control strips
// can't drift from the cells. Each band = cells (top) + control strip (below).
describe("gridRowLayout", () => {
  it("stacks 4 tracks as cells + a control strip below each", () => {
    const live = [0, 1, 2, 3].map((trackIndex) => ({ trackIndex, stepCount: 16 }));
    const { rowH, blocks } = gridRowLayout(live, 16, false, 200, 2, 20);
    // cellsBudget = 200 − 2·5 − 20·4 = 110 → rowH = floor(110/4) = 27
    expect(rowH).toBe(27);
    expect(blocks[0]).toEqual({
      trackIndex: 0,
      top: 2,
      height: 47, // 27 cells + 20 control
      sliceCount: 1,
      cellsTop: 2,
      cellsHeight: 27,
      controlTop: 29, // directly below the cells
      controlHeight: 20,
    });
    expect(blocks[1]!.top).toBe(2 + 47 + 2); // prev.top + band + pad
    expect(blocks[3]!.top).toBe(2 + 3 * (47 + 2));
  });

  it("per-track band heights: a short band reserves less (TR-FT-6)", () => {
    // Track 0 has a sample (tall band 40), track 1 has none (short band 20).
    // A shared max would give track 1 a 40px reserve → dead space under sends.
    const live = [0, 1].map((trackIndex) => ({ trackIndex, stepCount: 16 }));
    const { blocks } = gridRowLayout(live, 16, false, 200, 2, [40, 20]);
    expect(blocks[0]!.controlHeight).toBe(40);
    expect(blocks[1]!.controlHeight).toBe(20);
    // cellsBudget = 200 − 2·3 − (40+20) = 134 → rowH = 67
    expect(blocks[0]!.cellsHeight).toBe(67);
    // track 1 starts right after track 0's full band + pad
    expect(blocks[1]!.top).toBe(2 + 67 + 40 + 2);
  });

  it("split mode makes a 32-step track occupy two stacked cell rows", () => {
    const live = [
      { trackIndex: 0, stepCount: 32 }, // 2 slices at zoom 16
      { trackIndex: 1, stepCount: 16 }, // 1 slice
    ];
    const { rowH, blocks } = gridRowLayout(live, 16, true, 300, 2, 20);
    expect(blocks[0]!.sliceCount).toBe(2);
    expect(blocks[0]!.cellsHeight).toBe(2 * rowH);
    expect(blocks[0]!.controlTop).toBe(2 + 2 * rowH); // strip below both slices
    expect(blocks[1]!.sliceCount).toBe(1);
    expect(blocks[1]!.top).toBe(2 + (2 * rowH + 20) + 2);
  });

  it("clamps rowH to a 24px floor when cramped", () => {
    const live = Array.from({ length: 40 }, (_, i) => ({ trackIndex: i, stepCount: 16 }));
    const { rowH } = gridRowLayout(live, 16, false, 200, 2, 20);
    expect(rowH).toBe(24);
  });

  // DJ "hide grid" toggle: cells collapse to nothing and the control bands
  // become the whole row. It has to be an explicit mode — the 24px floor above
  // means no height budget can ever produce a zero-height cell row.
  it("cellsHidden collapses the cells and stacks pure control bands", () => {
    const live = [0, 1].map((trackIndex) => ({ trackIndex, stepCount: 32 }));
    const { rowH, blocks } = gridRowLayout(live, 16, true, 400, 2, [30, 20], true);
    expect(rowH).toBe(0);
    // Band 0: no cells, control strip sits AT the top of the band.
    expect(blocks[0]).toEqual({
      trackIndex: 0,
      top: 2,
      height: 30,
      sliceCount: 2, // the track still HAS 2 slices — they're just not drawn
      cellsTop: 2,
      cellsHeight: 0,
      controlTop: 2,
      controlHeight: 30,
    });
    // Band 1 follows immediately: band + pad, with no cell rows between them.
    expect(blocks[1]!.top).toBe(2 + 30 + 2);
    expect(blocks[1]!.cellsHeight).toBe(0);
    expect(blocks[1]!.controlHeight).toBe(20);
  });

  it("cellsHidden ignores the height budget entirely (bands never stretch)", () => {
    const live = [{ trackIndex: 0, stepCount: 16 }];
    const tall = gridRowLayout(live, 16, false, 4000, 2, 40, true);
    const short = gridRowLayout(live, 16, false, 50, 2, 40, true);
    expect(tall.blocks[0]).toEqual(short.blocks[0]);
    expect(tall.rowH).toBe(0);
  });
});

describe("track badges (TR-1 derivations)", () => {
  const t = (over: Partial<GridTrackState>): GridTrackState =>
    ({
      playbackMode: "regular",
      defaultChopIndex: -1,
      loopEnabled: false,
      stretchToCell: false,
      ...over,
    }) as GridTrackState;

  it("mode collapses to OWN/REG", () => {
    expect(trackModeLabel(t({ playbackMode: "owner" }))).toBe("OWN");
    expect(trackModeLabel(t({ playbackMode: "regular" }))).toBe("REG");
    expect(trackModeLabel(t({ playbackMode: "stretch" }))).toBe("REG");
  });

  it("OWN sub-mode: CHOP wins over LOOP, else empty", () => {
    expect(trackSubModeLabel(t({ playbackMode: "owner", defaultChopIndex: 0 }))).toBe("CHOP");
    expect(trackSubModeLabel(t({ playbackMode: "owner", loopEnabled: true }))).toBe("LOOP");
    expect(
      trackSubModeLabel(t({ playbackMode: "owner", defaultChopIndex: 2, loopEnabled: true })),
    ).toBe("CHOP");
    expect(trackSubModeLabel(t({ playbackMode: "owner" }))).toBe("");
  });

  it("REG sub-mode: LOOP or STR, else empty", () => {
    expect(trackSubModeLabel(t({ loopEnabled: true }))).toBe("LOOP");
    expect(trackSubModeLabel(t({ stretchToCell: true }))).toBe("STR");
    expect(trackSubModeLabel(t({}))).toBe("");
  });

  it("param label shortens known params and upper-cases unknowns", () => {
    expect(cellParamShortLabel("sampleStart")).toBe("START");
    expect(cellParamShortLabel("volume")).toBe("VOL");
    expect(cellParamShortLabel("whatever")).toBe("WHATEVER");
    // P5-PCE 3-char chip variant
    expect(cellParamChipLabel("sampleStart")).toBe("STA");
    expect(cellParamChipLabel("volume")).toBe("VOL");
    expect(cellParamChipLabel("pitch")).toBe("PIT");
  });
});

// Track-wise cursor jump: Tab (wrap=true) and ⇧↑/⇧↓ selection-extend
// (wrap=false). `live` is the VISUAL order, trackIndex the source index —
// the two are decoupled on purpose (hidden/null tracks skip indices).
describe("nextTrackJump", () => {
  const live = [
    { trackIndex: 0, stepCount: 16 },
    { trackIndex: 2, stepCount: 8 },
    { trackIndex: 5, stepCount: 64 },
  ];

  it("moves to the next visual track keeping the step", () => {
    expect(nextTrackJump(live, 0, 4, 1, true)).toEqual({ trackIndex: 2, step: 4 });
    expect(nextTrackJump(live, 2, 4, 1, true)).toEqual({ trackIndex: 5, step: 4 });
  });

  it("clamps the kept step to the target's last step", () => {
    // 64-step cursor at step 40 lands on the 8-step track's last step.
    expect(nextTrackJump(live, 5, 40, -1, false)).toEqual({ trackIndex: 2, step: 7 });
  });

  it("wraps last→first when wrap is on (Tab)", () => {
    expect(nextTrackJump(live, 5, 0, 1, true)).toEqual({ trackIndex: 0, step: 0 });
    expect(nextTrackJump(live, 0, 0, -1, true)).toEqual({ trackIndex: 5, step: 0 });
  });

  it("returns null at the edge when wrap is off (⇧↑/⇧↓ clamp)", () => {
    expect(nextTrackJump(live, 5, 0, 1, false)).toBeNull();
    expect(nextTrackJump(live, 0, 0, -1, false)).toBeNull();
  });

  it("single track: wrap is a same-track no-move, clamp is null", () => {
    const one = [{ trackIndex: 3, stepCount: 16 }];
    expect(nextTrackJump(one, 3, 2, 1, true)).toEqual({ trackIndex: 3, step: 2 });
    expect(nextTrackJump(one, 3, 2, 1, false)).toBeNull();
  });

  it("cursor on a vanished track enters the list at the nearest end", () => {
    expect(nextTrackJump(live, 9, 4, 1, true)).toEqual({ trackIndex: 0, step: 4 });
    expect(nextTrackJump(live, 9, 4, -1, true)).toEqual({ trackIndex: 5, step: 4 });
  });

  it("empty list is null", () => {
    expect(nextTrackJump([], 0, 0, 1, true)).toBeNull();
  });
});

// Tier 3 width-degrade. A char-count budget stands in for canvas measureText.
describe("fitReadout", () => {
  const budget = (max: number) => (s: string) => s.length <= max;

  it("appends every tag when they all fit", () => {
    expect(fitReadout("NOT C3", ["VEL 90", "PAN +0.2"], budget(100))).toBe(
      "NOT C3 · VEL 90 · PAN +0.2",
    );
  });

  it("stops at the budget and appends a +N remainder count", () => {
    // "NOT C3 · VEL 90" = 15 chars fits; the next tag would overflow → " +2"
    expect(fitReadout("NOT C3", ["VEL 90", "PAN +0.2", "TON +10"], budget(18))).toBe("NOT C3 · VEL 90 +2");
  });

  it("falls back to base-only when even the count won't fit", () => {
    expect(fitReadout("NOT C3", ["VEL 90", "PAN +0.2"], budget(6))).toBe("NOT C3");
  });

  it("returns the base unchanged when there are no hidden tags", () => {
    expect(fitReadout("PIT +2", [], budget(100))).toBe("PIT +2");
  });
});
