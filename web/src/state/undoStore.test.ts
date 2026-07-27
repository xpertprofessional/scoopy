/**
 * P5-06 UNDO — the pattern domain's history, owned by TS.
 *
 * Each test here pins a failure of the OLD (Swift) system, because "improve the undo" means
 * something concrete: these are the things that were actually wrong with it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { GridPatternState } from "../../protocol/schema";
import {
  beginGesture,
  endGesture,
  popRedo,
  popUndo,
  pushSwiftMarker,
  recordEdit,
  redoDepth,
  resetUndo,
  type PatternUndoEntry,
  type UndoEntry,
  undoDepth,
  undoLabel,
} from "./undoStore";

const pat = (gain: number, steps: boolean[] = [false]) =>
  ({ gain, steps }) as unknown as GridPatternState;

/** The real store uses canonical serialization; JSON is enough for the shape of these tests. */
const same = (a: GridPatternState, b: GridPatternState) => JSON.stringify(a) === JSON.stringify(b);

/** Assert-and-narrow: a test that expected a replayable entry and got a marker should FAIL here. */
const asPattern = (e: UndoEntry | null): PatternUndoEntry => {
  expect(e?.kind).toBe("pattern");
  return e as PatternUndoEntry;
};

beforeEach(() => resetUndo());

describe("ordering — the one thing Swift's design got RIGHT", () => {
  it("⌘Z walks edits in the order they were made, ACROSS tracks", () => {
    // The P5-04 shadow stack was keyed by track index, which structurally cannot do this: it
    // would undo "the last edit on track 3", not "the last edit". Order is the point of undo.
    recordEdit(0, pat(1), pat(2), "gain A", same);
    recordEdit(5, pat(1), pat(9), "gain B", same);

    expect(asPattern(popUndo()).trackIndex).toBe(5); // the most recent edit, whichever track
    expect(asPattern(popUndo()).trackIndex).toBe(0);
    expect(popUndo()).toBeNull();
  });
});

describe("no-op gestures leave NO entry (Swift pushed one at `begin`, unconditionally)", () => {
  it("a gesture that changes nothing records nothing", () => {
    // Swift's `beginUndoActivity` snapshotted on pointerdown, so a click that focused a cell and
    // changed nothing still cost you a ⌘Z press — sometimes several in a row.
    const p = pat(1);
    beginGesture(0, p);
    endGesture(0, p, "drag", same);

    expect(undoDepth()).toBe(0);
  });

  it("a gesture that DOES change something records exactly ONE entry", () => {
    // …and not one per pointer-move: Swift's unguarded `cycleStepFlam`/`adjustStepFlam` pushed a
    // snapshot on every move of a flam drag.
    beginGesture(0, pat(1));
    // (many intermediate publishes during the drag — recordEdit is inert inside a bracket)
    recordEdit(0, pat(1), pat(1.2), "drag", same);
    recordEdit(0, pat(1.2), pat(1.5), "drag", same);
    endGesture(0, pat(2), "Drag gain", same);

    expect(undoDepth()).toBe(1);
    expect(undoLabel()).toBe("Drag gain");
    expect(asPattern(popUndo()).before.gain).toBe(1); // …back to before the WHOLE gesture
  });

  it("a LOST endGesture cannot wedge recording (Swift's could, permanently)", () => {
    // `endUndoActivity` only cleared a flag. A cancelled drag left `isBatchUndoActive == true`
    // and every later `pushUndoSnapshot` became a silent no-op — undo simply stopped recording,
    // for the rest of the session.
    beginGesture(0, pat(1)); // …and never ended (pointercancel)

    // A discrete edit on ANOTHER track still records:
    recordEdit(3, pat(1), pat(2), "gain", same);
    expect(undoDepth()).toBe(1);

    // …and the wedged track recovers as soon as its next gesture completes.
    endGesture(0, pat(7), "Drag", same);
    expect(undoDepth()).toBe(2);
  });
});

describe("redo", () => {
  it("undo → redo round-trips", () => {
    recordEdit(0, pat(1), pat(2), "gain", same);

    const u = asPattern(popUndo());
    expect(u.before.gain).toBe(1);
    expect(redoDepth()).toBe(1);

    const r = asPattern(popRedo());
    expect(r.after.gain).toBe(2);
    expect(undoDepth()).toBe(1);
  });

  it("a NEW edit invalidates the redo future", () => {
    recordEdit(0, pat(1), pat(2), "a", same);
    popUndo();
    expect(redoDepth()).toBe(1);

    recordEdit(0, pat(1), pat(3), "b", same);
    expect(redoDepth()).toBe(0); // the future you undid into no longer exists
  });
});

describe("MB-1 — a SWIFT edit takes its place in the timeline", () => {
  it("⌘Z after a native menu op undoes the MENU OP, not your last cell edit", () => {
    // THE BUG. The old rule was "drain TS's stack, then fall through to Swift's" — which only
    // keeps order if every Swift edit is older than every TS edit. The Pattern menu breaks that on
    // the first click: draw a cell, Clear Grid, ⌘Z → you got your cell edit back and the clear
    // stayed. The clear was only reachable after every TS entry had been popped.
    recordEdit(0, pat(1), pat(2), "Draw cell", same);
    pushSwiftMarker("pattern"); // ← the native "Clear Grid (All Tracks)"

    // The FIRST ⌘Z must land on the clear, i.e. delegate to Swift.
    expect(popUndo()!.kind).toBe("swift");
    // …and only THEN on the cell edit.
    expect(asPattern(popUndo()).before.gain).toBe(1);
    expect(popUndo()).toBeNull();
  });

  it("interleaves in true order across several alternations", () => {
    recordEdit(0, pat(1), pat(2), "cell", same); // TS
    pushSwiftMarker("topology"); //                  Swift (add track)
    recordEdit(1, pat(3), pat(4), "cell", same); // TS
    pushSwiftMarker("global"); //                    Swift (bpm)

    expect(popUndo()!.kind).toBe("swift"); // bpm
    expect(popUndo()!.kind).toBe("pattern"); // cell on track 1
    expect(popUndo()!.kind).toBe("swift"); // add track
    expect(popUndo()!.kind).toBe("pattern"); // cell on track 0
  });

  it("a marker carries NO state — it is a position, not a payload", () => {
    // TS does not own topology or globals and must not pretend it can restore them. The entry
    // exists so ⌘Z knows WHEN to hand the step to Swift, and for nothing else.
    pushSwiftMarker("topology");
    const e = popUndo()!;
    expect(e.kind).toBe("swift");
    expect(e).not.toHaveProperty("before");
    expect(e).not.toHaveProperty("after");
  });

  it("redo replays a marker in its place too", () => {
    recordEdit(0, pat(1), pat(2), "cell", same);
    pushSwiftMarker("pattern");

    expect(popUndo()!.kind).toBe("swift"); // undo the native op
    expect(popUndo()!.kind).toBe("pattern"); // undo the cell edit
    expect(popRedo()!.kind).toBe("pattern"); // …and redo walks back out the same way
    expect(popRedo()!.kind).toBe("swift");
    expect(redoDepth()).toBe(0);
  });

  it("a native op invalidates the redo future, like any other edit", () => {
    recordEdit(0, pat(1), pat(2), "cell", same);
    popUndo();
    expect(redoDepth()).toBe(1);

    pushSwiftMarker("pattern");
    expect(redoDepth()).toBe(0);
  });
});

describe("coverage — the actual improvement", () => {
  it("records edits to fields Swift's `.pattern` undo could never restore", () => {
    // gain / pan / tone / sends / chops / loop / speed / locator are not in `PatternData`, and 18
    // more are deliberately re-stamped by PatternUndoPreservedTrackState. In the native app NONE
    // of these were undoable — the entry either did not exist or restored nothing. Here the entry
    // is the whole pattern half, so every field TS owns comes back.
    const before = { gain: 1, pan: 0, chopCount: 4 } as unknown as GridPatternState;
    const after = { gain: 2, pan: 0.5, chopCount: 2 } as unknown as GridPatternState;
    recordEdit(0, before, after, "Set chop count", same);

    const e = asPattern(popUndo());
    expect(e.before).toEqual({ gain: 1, pan: 0, chopCount: 4 });
  });
});
