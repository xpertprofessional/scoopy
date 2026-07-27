/**
 * P5-06 step D — THE FLIP's routing rule.
 *
 * With `web.owner.patterns` on, an edit takes ONE of two paths, and picking the wrong one is
 * silently destructive in both directions:
 *
 *   apply-and-publish   TS runs the reducer and tells Swift the result.
 *   send-the-intent     Swift does the work and pushes the result back.
 *
 * Do BOTH for one op and every edit is applied TWICE (TS's reducer, then Swift's mutator on top).
 * Do NEITHER and the control is inert. So the split has to be exact, and it has to stay exact as
 * reducers are added — which is why this asserts the RULE against the reducer sets rather than
 * re-listing the ops by hand.
 */
import { describe, expect, it } from "vitest";
import type { GridTrackState } from "../../protocol/schema.ts";
import { VERIFIABLE_GRID_OPS, applyGridOp } from "./gridOps";
import { SETTINGS_OWNED_TRACK_OPS, VERIFIABLE_TRACK_OPS, applyTrackOp } from "./trackOps";

/** The rule GridPanel implements: TS applies an op iff it has a reducer for it. */
const tsApplies = (op: string) => VERIFIABLE_GRID_OPS.has(op) || VERIFIABLE_TRACK_OPS.has(op);

describe("owner-mode routing", () => {
  it("TS applies every op it has a reducer for", () => {
    for (const op of [...VERIFIABLE_GRID_OPS, ...VERIFIABLE_TRACK_OPS]) {
      expect(tsApplies(op), `${op} is modeled but would be sent as an intent`).toBe(true);
    }
  });

  it("the IMPURE ops are still SENT — TS cannot do them at all", () => {
    // These reach outside the document: an NSOpenPanel, the SampleBank, the AU host, the audio
    // clock. TS applying them would be a fabrication. Swift does the work and pushes the result,
    // and TS adopts it once the track is quiet.
    for (const op of [
      "loadSample",
      "browseSample",
      "loadInstrument",
      "clearInstrument",
      "openInstrumentEditor",
      "setInstrumentOut",
      "setMidiInputPin",
      "toggleLaunch",
      "mapMod",
      "unmapMod",
      "setModDepth",
    ]) {
      expect(tsApplies(op), `${op} is IMPURE — TS must not pretend to apply it`).toBe(false);
    }
  });

  it("the SELECTION-SCOPED ops are still SENT — they touch tracks this per-track path doesn't", () => {
    // Each fans out across the native multi-selection. A per-track TS reducer would update ONE
    // track and leave the others silently diverged from the engine.
    for (const op of ["toggleDirection", "toggleLocatorRepeat", "setOutputAssign", "setTuning"]) {
      expect(tsApplies(op), `${op} is SELECTION-SCOPED — TS must not apply it per-track`).toBe(
        false,
      );
    }
  });

  it("the DJ perform ops are still SENT — Swift owns the locator engagement latch", () => {
    // setLocatorRange/setLocatorRepeat drive the engine's catch-the-playhead
    // latch (off→on re-arms against the new window). TS applying them would
    // fake a window the engine hasn't latched; the web adopts Swift's echo.
    for (const op of ["setLocatorRange", "setLocatorRepeat"]) {
      expect(tsApplies(op), `${op} is a perform gesture — Swift owns the latch`).toBe(false);
    }
  });

  it("UNDO is still SENT — it never moved to TS", () => {
    // The flip is about who COMPUTES an edit, not who remembers history. Swift still holds an
    // authoritative mirror, so its snapshots stay valid — and keeping ONE ordered stack is the
    // only way ⌘Z still walks edits in the order they were made, across pattern/topology/global.
    // A reducer for these would quietly take that away.
    for (const op of ["beginUndo", "endUndo"]) {
      expect(tsApplies(op), `${op} must stay Swift's — undo did not move`).toBe(false);
    }
  });

  it("the ops whose fields aren't on the pattern wire are still SENT", () => {
    // TS cannot own what it cannot see: `renameTrack` writes customName, `toggleSolo` writes a
    // field that is not persisted at all, `setActiveCellParameter` is pure UI selection.
    for (const op of ["renameTrack", "toggleSolo", "setActiveCellParameter", "toggleMuteGroup"]) {
      expect(tsApplies(op), `${op} writes off-wire fields — TS must not apply it`).toBe(false);
    }
  });
});

describe("the settings-scene-owned exception (chokeGroup does BOTH)", () => {
  // chokeGroup is settings-scene state in Swift and is deliberately NOT read from the whole-pattern
  // payload Swift adopts (WebWorldBinding.applyTrackScalars). So the usual apply-XOR-send split
  // does not hold for it: GridPanel publishes the pattern (the browser companion's real write, and
  // the desktop's optimistic preview) AND sends the trackEdit command (the desktop's real write).
  it("every settings-owned op is also modeled — the publish/preview needs the reducer", () => {
    for (const op of SETTINGS_OWNED_TRACK_OPS) {
      expect(VERIFIABLE_TRACK_OPS.has(op), `${op} is settings-owned but has no reducer`).toBe(true);
    }
  });

  it("setChokeGroup is the (only) settings-owned op", () => {
    expect([...SETTINGS_OWNED_TRACK_OPS]).toEqual(["setChokeGroup"]);
  });

  it("the reducer clamps to 0…8 so publish/preview matches Swift's mutator", () => {
    const base = { chokeGroup: 1 } as unknown as Parameters<typeof applyTrackOp>[0];
    expect(applyTrackOp(base, { op: "setChokeGroup", value: 9 }).chokeGroup).toBe(8);
    expect(applyTrackOp(base, { op: "setChokeGroup", value: -1 }).chokeGroup).toBe(0);
    expect(applyTrackOp(base, { op: "setChokeGroup", value: 3 }).chokeGroup).toBe(3);
  });
});

describe("setRateLockRatio — the per-track ⟳ reset target (store-only)", () => {
  // The rate control's right-click menu ASSIGNS this ratio; the ⟳ button later snaps the LIVE
  // speed to it. So the reducer must remember the target WITHOUT moving the live rate — mirroring
  // BeatSequencer.setRateLockRatio, which writes rateLockRatio and leaves speedMultiplier alone.
  const base = { speedMultiplier: 1, rateLockRatio: 1 } as unknown as GridTrackState;

  it("stores the assigned ratio and leaves the live speed untouched", () => {
    const t = applyTrackOp(base, { op: "setRateLockRatio", value: 1.5 });
    expect(t.rateLockRatio).toBe(1.5);
    expect(t.speedMultiplier).toBe(1); // the live rate does NOT move — that is the ⟳ button's job
  });

  it("snaps to a valid multiply ratio; an off-table value is a silent no-op", () => {
    expect(applyTrackOp(base, { op: "setRateLockRatio", value: 2 }).rateLockRatio).toBe(2);
    expect(applyTrackOp(base, { op: "setRateLockRatio", value: 1.234 })).toBe(base); // unchanged
  });
});

describe("the double-apply trap (how cell painting died on the flip's first hardware run)", () => {
  // Every pointer handler pairs `optimistic(reduce)` with `sendEdit(op)`. While SWIFT owns the
  // pattern that is right: the optimistic copy is a PREVIEW and Swift applies the op once.
  //
  // Once TS owns it, sendEdit applies the reducer ITSELF — so previewing as well runs the op
  // TWICE. This test shows why that is fatal rather than merely wasteful.
  const base = {
    steps: [false, false, false, false, false],
    cellLengths: [1, 1, 1, 1, 1],
    stepCount: 5,
    accentLevels: [0, 0, 0, 0, 0],
    flamCounts: [1, 1, 1, 1, 1],
    glideSteps: [false, false, false, false, false],
    reverseSteps: [false, false, false, false, false],
    preSilenceMsOffsets: [0, 0, 0, 0, 0],
    wrapSourceStep: null,
    playbackMode: "regular",
  } as unknown as Parameters<typeof applyGridOp>[0];

  it("an ABSOLUTE setter survives being applied twice — which is why the bug hid", () => {
    const once = applyTrackOp(base, { op: "setGain", value: 1.5 });
    const twice = applyTrackOp(once, { op: "setGain", value: 1.5 });
    expect(twice.gain).toBe(once.gain); // idempotent: gain boxes still looked fine
  });

  it("a RELATIVE op applied twice is a NO-OP — the cell goes on, then straight back off", () => {
    const once = applyGridOp(base, { op: "toggleStep", step: 2 });
    const twice = applyGridOp(once, { op: "toggleStep", step: 2 });

    expect(once.steps[2]).toBe(true); // the edit the user made
    expect(twice.steps[2]).toBe(false); // …undone by the second application
    // So the grid does nothing at all, silently. `optimistic()` must be inert in owner mode:
    // the reducer inside send*() is the single application.
  });
});
