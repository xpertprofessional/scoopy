/**
 * D-SL-UNDO-01 — topology takes its place in the ONE ordered stack.
 *
 * The property that matters is ORDER: ⌘Z must walk an add-track and a cell edit
 * in the sequence they happened. A per-track store structurally cannot express
 * that, which is the reason this file's subject exists at all.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  popRedo,
  popUndo,
  recordEdit,
  recordTopology,
  resetUndo,
  undoDepth,
} from "./undoStore.ts";
import type { GridPatternState } from "../../protocol/schema.ts";

const pat = (n: number) => ({ trackIndex: 0, steps: [n] }) as unknown as GridPatternState;
const same = (a: GridPatternState, b: GridPatternState) => JSON.stringify(a) === JSON.stringify(b);

beforeEach(() => resetUndo());

describe("topology entries", () => {
  it("records an add-track so ⌘Z has something to pop", () => {
    // Before this, an add-track pushed a `swift` marker that delegated to a
    // host which does not answer — the step existed and could not be taken.
    recordTopology(0, { sectionA: [] }, { sectionA: [{}] }, "add track 1");
    expect(undoDepth()).toBe(1);
    const e = popUndo();
    expect(e?.kind).toBe("topology");
  });

  it("carries the whole PATTERN either side, not a track index", () => {
    // Appending a row touches all eight sections plus baseSettings.trackSettings;
    // an index would make the receiver re-implement the mutator backwards.
    const before = { sectionA: [] };
    const after = { sectionA: [{ id: "x" }] };
    recordTopology(1, before, after, "add track 1");
    const e = popUndo();
    if (e?.kind !== "topology") throw new Error("expected a topology entry");
    expect(e.before).toBe(before);
    expect(e.after).toBe(after);
    expect(e.deck).toBe(1);
  });

  it("interleaves with pattern edits IN ORDER — the whole point of one stack", () => {
    // Draw a cell, add a track, ⌘Z: the TRACK goes first. A per-kind stack (or
    // "drain one kind then the other") would undo the cell edit, which is the
    // exact bug MB-1 fixed for Swift markers and this inherits the fix from.
    recordEdit(0, pat(1), pat(2), "draw cell", same);
    recordTopology(0, { sectionA: [{}] }, { sectionA: [{}, {}] }, "add track 2");
    expect(popUndo()?.kind).toBe("topology");
    expect(popUndo()?.kind).toBe("pattern");
  });

  it("redoes in the mirror order", () => {
    recordEdit(0, pat(1), pat(2), "draw cell", same);
    recordTopology(0, { sectionA: [{}] }, { sectionA: [{}, {}] }, "add track 2");
    popUndo();
    popUndo();
    expect(popRedo()?.kind).toBe("pattern");
    expect(popRedo()?.kind).toBe("topology");
  });

  it("a new edit invalidates the redo future, topology included", () => {
    recordTopology(0, { sectionA: [] }, { sectionA: [{}] }, "add track 1");
    popUndo();
    recordEdit(0, pat(1), pat(2), "draw cell", same);
    expect(popRedo()).toBeNull();
  });
});
