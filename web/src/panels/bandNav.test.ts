import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bandControls,
  groupRows,
  nearestIndexByX,
  stepIndex,
  type BandControl,
} from "./bandNav.ts";

describe("stepIndex (band ←/→)", () => {
  it("clamps at both ends — no wrap (grid ←/→ parity)", () => {
    expect(stepIndex(0, -1, 5)).toBe(0);
    expect(stepIndex(4, 1, 5)).toBe(4);
    expect(stepIndex(2, 1, 5)).toBe(3);
    expect(stepIndex(2, -1, 5)).toBe(1);
  });

  it("re-enters at the travel edge when the current id vanished", () => {
    expect(stepIndex(-1, 1, 5)).toBe(0);
    expect(stepIndex(-1, -1, 5)).toBe(4);
  });

  it("empty band yields -1", () => {
    expect(stepIndex(0, 1, 0)).toBe(-1);
  });
});

describe("nearestIndexByX (band entry landing)", () => {
  it("picks the control whose center is nearest to the cell's x", () => {
    expect(nearestIndexByX([10, 50, 90], 60)).toBe(1);
    expect(nearestIndexByX([10, 50, 90], 85)).toBe(2);
    expect(nearestIndexByX([10, 50, 90], -5)).toBe(0);
  });

  it("ties resolve to the left control", () => {
    expect(nearestIndexByX([10, 30], 20)).toBe(0);
  });
});

describe("groupRows (visual sub-row hopping)", () => {
  const c = (id: string, x: number, y: number): BandControl => ({
    id,
    centerX: x,
    centerY: y,
  });

  it("clusters controls by center-y into top→bottom rows, items left→right", () => {
    const rows = groupRows([
      c("p/launch", 10, 20),
      c("p/steps", 40, 22), // same line despite 2px jitter (mixed heights)
      c("h/mute", 30, 60),
      c("dsp/gain", 5, 100),
      c("h/solo", 60, 61),
    ]);
    expect(rows.map((r) => r.map((x) => x.id))).toEqual([
      ["p/launch", "p/steps"],
      ["h/mute", "h/solo"],
      ["dsp/gain"],
    ]);
  });

  it("a flex-WRAPPED long row splits into one row per rendered line", () => {
    const rows = groupRows([c("a", 10, 20), c("b", 40, 20), c("c", 10, 44)]);
    expect(rows.length).toBe(2);
    expect(rows[1]![0]!.id).toBe("c");
  });

  it("empty band yields no rows", () => {
    expect(groupRows([])).toEqual([]);
  });
});

describe("bandControls (DOM-order traversal)", () => {
  // Node env has no DOM — stub the two document calls bandControls makes.
  // Document order == visual order is pinned by the trackRowControls SSR test.
  const fakeEl = (id: string, left: number, width: number, top = 0, height = 18) => ({
    getAttribute: (name: string) => (name === "data-focus-id" ? id : null),
    getBoundingClientRect: () => ({ left, width, top, height }),
  });
  const strips = new Map<string, ReturnType<typeof fakeEl>[]>();
  const originalDocument = (globalThis as { document?: unknown }).document;

  beforeAll(() => {
    (globalThis as { document?: unknown }).document = {
      querySelector: (sel: string) => {
        const m = sel.match(/data-track-index="(\d+)"/);
        const els = m ? strips.get(m[1]!) : undefined;
        if (!els) return null;
        return { querySelectorAll: (_q: string) => ({ forEach: els.forEach.bind(els) }) };
      },
    };
  });

  afterAll(() => {
    (globalThis as { document?: unknown }).document = originalDocument;
  });

  it("returns ids + centers in document order for the requested track", () => {
    strips.set("3", [fakeEl("track/3/launch", 0, 20, 11), fakeEl("track/3/steps", 30, 40, 11)]);
    expect(bandControls(3)).toEqual([
      { id: "track/3/launch", centerX: 10, centerY: 20 },
      { id: "track/3/steps", centerX: 50, centerY: 20 },
    ]);
  });

  it("missing strip yields an empty band", () => {
    expect(bandControls(99)).toEqual([]);
  });

  it("NAV-11: a `root` scopes the query — two decks' track-N strips never cross", () => {
    // Both decks render `.trk-strip[data-track-index="2"]`; a document-wide
    // query always hit the FIRST. Passing each deck's panel root makes each
    // read only its own band — the fix for "the other deck scrolls / stuck".
    const rootOf = (els: ReturnType<typeof fakeEl>[]) => ({
      querySelector: (sel: string) =>
        /data-track-index="2"/.test(sel)
          ? { querySelectorAll: () => ({ forEach: els.forEach.bind(els) }) }
          : null,
    });
    const deckA = rootOf([fakeEl("s0/track/2/mute", 0, 20)]) as unknown as ParentNode;
    const deckB = rootOf([fakeEl("s1/track/2/mute", 0, 20)]) as unknown as ParentNode;
    expect(bandControls(2, deckA).map((c) => c.id)).toEqual(["s0/track/2/mute"]);
    expect(bandControls(2, deckB).map((c) => c.id)).toEqual(["s1/track/2/mute"]);
  });
});
