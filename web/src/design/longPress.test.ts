import { describe, expect, it } from "vitest";
import { longPressStep, type LongPressState } from "./longPress.ts";

/**
 * Long-press arbitration (mobile pass). The recognizer is the ONLY touch door
 * into the app's context menus, and its failure modes are all silent: a fire
 * during a drag corrupts a gesture, a missed cancel double-opens against
 * Android's native long-press menu. The state machine is pure so each rule is
 * pinned here without a DOM.
 */
describe("longPressStep", () => {
  const down = (over: Partial<{ touch: boolean; primary: boolean }> = {}) =>
    longPressStep(
      { phase: "idle" },
      { type: "down", x: 100, y: 100, touch: true, primary: true, ...over },
    );

  it("a primary touch press starts tracking at the press point", () => {
    expect(down()).toEqual({ phase: "tracking", x: 100, y: 100 });
  });

  it("mouse/pen and secondary fingers never track", () => {
    expect(down({ touch: false })).toEqual({ phase: "idle" });
    expect(down({ primary: false })).toEqual({ phase: "idle" });
  });

  it("the timer fires only while still tracking", () => {
    expect(longPressStep(down(), { type: "timer" })).toEqual({ phase: "fired" });
    expect(longPressStep({ phase: "idle" }, { type: "timer" })).toEqual({ phase: "idle" });
  });

  it("movement inside the slop keeps tracking; past it cancels", () => {
    const s = down();
    expect(longPressStep(s, { type: "move", x: 106, y: 106 })).toBe(s); // ~8.5px
    expect(longPressStep(s, { type: "move", x: 111, y: 100 })).toEqual({ phase: "idle" });
  });

  it("slop is radial, not per-axis", () => {
    // 8/8 = 11.3px diagonal — outside the 10px radius even though each axis is under it.
    expect(longPressStep(down(), { type: "move", x: 108, y: 108 })).toEqual({ phase: "idle" });
  });

  it("release before the hold = a tap, not a menu", () => {
    expect(longPressStep(down(), { type: "up" })).toEqual({ phase: "idle" });
  });

  it("a trusted native contextmenu (Android) stands the recognizer down", () => {
    // The installer maps it to "cancel": one menu, the platform's.
    expect(longPressStep(down(), { type: "cancel" })).toEqual({ phase: "idle" });
  });

  it("custom slop is honored (installer passes tuning)", () => {
    const s: LongPressState = { phase: "tracking", x: 0, y: 0 };
    expect(longPressStep(s, { type: "move", x: 0, y: 14 }, 15)).toBe(s);
    expect(longPressStep(s, { type: "move", x: 0, y: 16 }, 15)).toEqual({ phase: "idle" });
  });
});
