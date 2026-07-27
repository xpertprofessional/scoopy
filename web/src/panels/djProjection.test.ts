import { describe, expect, it } from "vitest";
import { deckInSlot, projectionAfterDeckCToggle, toggleProjection } from "./djProjection.ts";

/** P6-03 — deck-C projection (djmode.md §7 parity item 1 / §8 Q3). */
describe("deck C projection", () => {
  it("shows A and B when C is not projected", () => {
    expect(deckInSlot("a", null, true)).toBe(0);
    expect(deckInSlot("b", null, true)).toBe(1);
  });

  it("takes OVER the slot it projects into (never a third column)", () => {
    // C in slot A ⇒ slot A renders deck 2, and deck B is untouched. Deck A is
    // simply not on screen — that is the model, not a bug.
    expect(deckInSlot("a", "a", true)).toBe(2);
    expect(deckInSlot("b", "a", true)).toBe(1);
    // …and symmetrically in slot B.
    expect(deckInSlot("b", "b", true)).toBe(2);
    expect(deckInSlot("a", "b", true)).toBe(0);
  });

  it("never projects a DISABLED deck C", () => {
    // Disabling C stops its transport, so projecting it would park a silent,
    // dead deck in a slot the performer still needs.
    expect(deckInSlot("a", "a", false)).toBe(0);
    expect(deckInSlot("b", "b", false)).toBe(1);
  });

  it("can never occupy both slots at once", () => {
    const moved = toggleProjection("a", "b"); // C was in A, user projects into B
    expect(moved).toBe("b");
    expect(deckInSlot("a", moved, true)).toBe(0); // A comes back
    expect(deckInSlot("b", moved, true)).toBe(2); // C moved, not duplicated
  });

  it("toggles off when re-pressed on the slot it already occupies", () => {
    expect(toggleProjection("a", "a")).toBeNull();
    expect(toggleProjection(null, "a")).toBe("a");
  });

  it("drops the projection when deck C is disabled", () => {
    expect(projectionAfterDeckCToggle("b", false)).toBeNull();
    expect(projectionAfterDeckCToggle("b", true)).toBe("b");
    expect(projectionAfterDeckCToggle(null, true)).toBeNull();
  });
});
