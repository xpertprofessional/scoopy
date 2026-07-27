import { describe, expect, it, vi } from "vitest";
import {
  clampToViewport,
  formatEntrySeed,
  shouldDismissOnPointerDown,
  type MenuItem,
} from "./ContextMenu.tsx";
import { buildDragBoxMenu } from "./DragBox.tsx";

/**
 * The bug: EVERY menu item in the app was dead. The menu closed on any window
 * `pointerdown`, and pointerdown precedes click — so pressing an item unmounted the menu
 * before its own click could fire, and `onSelect` never ran. Menus opened, looked correct,
 * and did nothing. Nothing caught it: it typechecks, and an SSR render test can't see it.
 */
describe("menu dismissal — the pointerdown-before-click trap", () => {
  // A minimal Node stand-in: `contains` is the only thing the predicate uses.
  const node = (children: object[] = []): Node =>
    ({ contains: (t: Node) => children.includes(t as object) }) as unknown as Node;

  it("does NOT dismiss when the press lands INSIDE the menu (the regression)", () => {
    const item = {};
    expect(shouldDismissOnPointerDown(node([item]), item as Node)).toBe(false);
  });

  it("dismisses when the press lands outside", () => {
    expect(shouldDismissOnPointerDown(node([]), {} as Node)).toBe(true);
  });

  it("dismisses when there is no menu to protect", () => {
    expect(shouldDismissOnPointerDown(null, {} as Node)).toBe(true);
  });
});

/**
 * The bug this fixes: right-click on any DragBox outside the grid did nothing,
 * because the box's only menu branch was a hook (`onMidiLearn`) that no call
 * site ever passed. Every box must now yield a menu — base items even with no
 * extras — and the extras must land AFTER the base, as native does.
 */
describe("buildDragBoxMenu", () => {
  const src = { value: 80, min: 0, max: 120, onChange: () => {} };

  it("gives a bare box a menu (the regression that started this)", () => {
    const items = buildDragBoxMenu(src, () => {});
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "item", label: "Enter value…" });
  });

  it("appends caller extras after the base, behind a separator (native order)", () => {
    const extras: MenuItem[] = [
      { kind: "item", label: "Clear per-cell values", onSelect: () => {} },
      { kind: "item", label: "Output 1", checked: true, onSelect: () => {} },
    ];
    const items = buildDragBoxMenu({ ...src, menu: extras }, () => {});
    expect(items.map((i) => (i.kind === "sep" ? "—" : i.label))).toEqual([
      "Enter value…",
      "—",
      "Clear per-cell values",
      "Output 1",
    ]);
  });

  it("orders the sections as native does: base · MIDI · extras · scene", () => {
    // DraggableNumberBox.swift:520 (base + MIDI) then the extras closure, which
    // itself ends with sceneOverrideContextMenuItems (e.g. pan, ContentView:4289).
    const items = buildDragBoxMenu(
      { ...src, menu: [{ kind: "item", label: "Clear per-cell values", onSelect: () => {} }] },
      () => {},
      {
        midi: [{ kind: "item", label: "Learn MIDI", onSelect: () => {} }],
        scene: [{ kind: "item", label: "Make Scene-Specific (Scene 1)", onSelect: () => {} }],
      },
    );
    expect(items.map((i) => (i.kind === "sep" ? "—" : i.label))).toEqual([
      "Enter value…",
      "—",
      "Learn MIDI",
      "—",
      "Clear per-cell values",
      "—",
      "Make Scene-Specific (Scene 1)",
    ]);
  });

  it("routes 'Enter value…' to the numeric-entry popover", () => {
    const onEnterValue = vi.fn();
    const [first] = buildDragBoxMenu(src, onEnterValue);
    if (first?.kind !== "item") throw new Error("expected an item");
    first.onSelect();
    expect(onEnterValue).toHaveBeenCalledOnce();
  });
});

/**
 * A menu lives inside its panel's WKWebView and cannot escape it (native NSMenu
 * can). Near an edge it must flip/shift back into view or the items are simply
 * unreachable — which is how "the menu does nothing" looks to a user.
 */
describe("clampToViewport", () => {
  const VIEW = { w: 400, h: 300 };
  const clamp = (x: number, y: number, w = 150, h = 100) =>
    clampToViewport(x, y, w, h, VIEW.w, VIEW.h);

  it("leaves a menu with room to spare exactly where the cursor was", () => {
    expect(clamp(10, 20)).toEqual({ x: 10, y: 20 });
  });

  it("flips to the other side of the cursor when it would overflow right/bottom", () => {
    // 380 + 150 > 400 → flip to 380 - 150; 260 + 100 > 300 → flip to 260 - 100.
    expect(clamp(380, 260)).toEqual({ x: 230, y: 160 });
  });

  it("shifts into view when neither side fits (menu wider than the panel)", () => {
    // A thin strip: 500px menu in a 400px panel — pin to the margin, never
    // leave it hanging off the right edge where it can't be clicked.
    const r = clampToViewport(380, 10, 500, 100, VIEW.w, VIEW.h);
    expect(r.x).toBe(4);
  });

  it("never returns a negative origin", () => {
    const r = clampToViewport(2, 2, 900, 900, VIEW.w, VIEW.h);
    expect(r.x).toBeGreaterThanOrEqual(0);
    expect(r.y).toBeGreaterThanOrEqual(0);
  });
});

/** Native NumberEntryPopover.format — integral values seed as "120", not "120.0". */
describe("formatEntrySeed", () => {
  it("trims a trailing .0 on integral values", () => {
    expect(formatEntrySeed(120)).toBe("120");
    expect(formatEntrySeed(-3)).toBe("-3");
    expect(formatEntrySeed(0)).toBe("0");
  });

  it("keeps two decimals otherwise", () => {
    expect(formatEntrySeed(1.27)).toBe("1.27");
    expect(formatEntrySeed(14.5)).toBe("14.50");
  });
});
