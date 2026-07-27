/**
 * DJ perform-mode locator gesture — the pure machine behind PERF pointer
 * handling (performLocator.ts). Pins the release contract: drag = set the
 * window (release engages it), plain click = disengage iff engaged. The
 * canvas wiring in GridPanel stays untestable here; this is the part that
 * decides WHAT a release does.
 */
import { describe, expect, it } from "vitest";
import {
  PERFORM_DRAG_PX,
  performDragArmed,
  performRange,
  resolvePerformRelease,
  rowStepFromXY,
  type CellRect,
  type PerformDrag,
} from "./performLocator";

const drag = (anchor: number, last: number, moved = true): PerformDrag => ({
  trackIndex: 0,
  anchor,
  last,
  downX: 0,
  downY: 0,
  moved,
});

describe("performRange", () => {
  it("a left-to-right drag is an inclusive window", () => {
    expect(performRange(drag(4, 9), 16)).toEqual({ startStep: 4, lengthSteps: 6 });
  });

  it("a right-to-left drag flips to the same window", () => {
    expect(performRange(drag(9, 4), 16)).toEqual({ startStep: 4, lengthSteps: 6 });
  });

  it("clamps to the pattern edges — never a wrapping window", () => {
    // Steps outside the pattern can only come in via clamped hit-tests going
    // stale across a stepCount change; the window must stay in-bounds.
    expect(performRange(drag(12, 40), 16)).toEqual({ startStep: 12, lengthSteps: 4 });
    expect(performRange(drag(-3, 2), 16)).toEqual({ startStep: 0, lengthSteps: 3 });
  });

  it("a drag that returned to its anchor is a 1-step window", () => {
    expect(performRange(drag(5, 5), 16)).toEqual({ startStep: 5, lengthSteps: 1 });
  });
});

describe("resolvePerformRelease", () => {
  it("a drag sets the normalized window (engagement rides the send)", () => {
    expect(resolvePerformRelease(drag(9, 4), 16, false)).toEqual({
      kind: "setRange",
      startStep: 4,
      lengthSteps: 6,
    });
  });

  it("a drag out and back still sets — 1-step window, matching the steppers' inert-window behavior", () => {
    expect(resolvePerformRelease(drag(5, 5, true), 16, true)).toEqual({
      kind: "setRange",
      startStep: 5,
      lengthSteps: 1,
    });
  });

  it("a plain click disengages iff the track's repeat is engaged", () => {
    expect(resolvePerformRelease(drag(5, 5, false), 16, true)).toEqual({ kind: "disengage" });
  });

  it("a plain click on a disengaged row does nothing", () => {
    expect(resolvePerformRelease(drag(5, 5, false), 16, false)).toEqual({ kind: "none" });
  });
});

describe("performDragArmed", () => {
  const press = (): PerformDrag => ({
    trackIndex: 0,
    anchor: 5,
    last: 5,
    downX: 100,
    downY: 50,
    moved: false,
  });

  it("a stationary press is not armed — it stays a click, so it disengages", () => {
    expect(performDragArmed(press(), 100, 50)).toBe(false);
    expect(resolvePerformRelease(press(), 16, true)).toEqual({ kind: "disengage" });
  });

  it("jitter inside the deadzone is not armed", () => {
    expect(performDragArmed(press(), 100 + PERFORM_DRAG_PX, 50)).toBe(false);
  });

  it("travel past the deadzone arms even without leaving the anchor cell (the 1-step bug)", () => {
    // A drag that never reaches a second step used to release as a click and
    // get ignored; it must now set a 1-step window.
    const d = press();
    expect(performDragArmed(d, 100 + PERFORM_DRAG_PX + 1, 50)).toBe(true);
    d.moved = true;
    expect(resolvePerformRelease(d, 16, false)).toEqual({
      kind: "setRange",
      startStep: 5,
      lengthSteps: 1,
    });
  });

  it("arms on vertical travel too — the distance is radial, not per-axis", () => {
    expect(performDragArmed(press(), 100, 50 + PERFORM_DRAG_PX + 1)).toBe(true);
  });
});

describe("rowStepFromXY", () => {
  const W = 10; // cell width
  const H = 12; // cell height
  const cell = (col: number, y: number): CellRect => ({ x: col * (W + 2), y, w: W, h: H });

  // A single 8-step row at y=0.
  const singleRow = (): Array<[number, CellRect]> =>
    Array.from({ length: 8 }, (_, s) => [s, cell(s, 0)] as [number, CellRect]);

  // A 16-step track drawn SPLIT: steps 0..7 on top (y=0), 8..15 below (y=40) —
  // the two halves share the SAME x columns, which is exactly what defeated the
  // X-only mapper.
  const splitRows = (): Array<[number, CellRect]> => [
    ...Array.from({ length: 8 }, (_, s) => [s, cell(s, 0)] as [number, CellRect]),
    ...Array.from({ length: 8 }, (_, s) => [s + 8, cell(s, 40)] as [number, CellRect]),
  ];

  const midX = (col: number) => col * (W + 2) + W / 2;

  it("maps x to the column on a single row", () => {
    expect(rowStepFromXY(singleRow(), midX(0), 6)).toBe(0);
    expect(rowStepFromXY(singleRow(), midX(5), 6)).toBe(5);
  });

  it("drifting above/below a single row still tracks its columns", () => {
    expect(rowStepFromXY(singleRow(), midX(3), -50)).toBe(3);
    expect(rowStepFromXY(singleRow(), midX(3), 999)).toBe(3);
  });

  it("clamps past either end to the row's step span", () => {
    expect(rowStepFromXY(singleRow(), -100, 6)).toBe(0);
    expect(rowStepFromXY(singleRow(), 10_000, 6)).toBe(7);
  });

  it("SPLIT: the lower row's columns map to the lower steps, not the upper (the row-border bug)", () => {
    // y=40 band → steps 8..15, same x columns as the top's 0..7.
    expect(rowStepFromXY(splitRows(), midX(0), 40)).toBe(8);
    expect(rowStepFromXY(splitRows(), midX(2), 40)).toBe(10);
    expect(rowStepFromXY(splitRows(), midX(7), 40)).toBe(15);
  });

  it("SPLIT: the upper row still maps to the upper steps", () => {
    expect(rowStepFromXY(splitRows(), midX(2), 0)).toBe(2);
  });

  it("SPLIT: a two-cell drag inside the lower row is a clean 2-step window (regression)", () => {
    const anchor = rowStepFromXY(splitRows(), midX(2), 40); // 10
    const last = rowStepFromXY(splitRows(), midX(3), 40); // 11
    const d: PerformDrag = {
      trackIndex: 0,
      anchor,
      last,
      downX: midX(2),
      downY: 40,
      moved: last !== anchor,
    };
    expect(performRange(d, 16)).toEqual({ startStep: 10, lengthSteps: 2 });
  });

  it("returns -1 for an empty map", () => {
    expect(rowStepFromXY([], 5, 5)).toBe(-1);
  });
});
