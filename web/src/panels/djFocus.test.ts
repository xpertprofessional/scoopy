import { describe, expect, it } from "vitest";
import { planDeckFocusAdoption } from "./djFocusBridge.ts";

// NAV-12: the `-` deck switch moves Swift's activeSequencer and nothing else.
// Both DJ grids share ONE focus store and tell each other apart by scope prefix,
// so the deck that just took the keyboard has to decide what to do with a ring
// that may still be sitting in the other deck's scope.
describe("planDeckFocusAdoption", () => {
  it("keeps the grid lane alone — each deck already reads its own cell cursor", () => {
    expect(planDeckFocusAdoption({ lane: "grid", focusedId: null, scope: "s1/" })).toEqual({
      kind: "keep",
    });
  });

  it("keeps a ring that is already ours", () => {
    expect(
      planDeckFocusAdoption({ lane: "controls", focusedId: "s1/track/2/pitch", scope: "s1/" }),
    ).toEqual({ kind: "keep" });
  });

  it("mirrors the other deck's control onto the same control over here", () => {
    // This is the reported bug: the ring stays "s0/…", so deck B's arrow handler
    // resolves it to none-of-my-bands and swallows the key.
    expect(
      planDeckFocusAdoption({ lane: "controls", focusedId: "s0/track/2/pitch", scope: "s1/" }),
    ).toEqual({ kind: "control", mirrorId: "s1/track/2/pitch", trackPrefix: "s1/track/2/" });
  });

  it("mirrors right-to-left too", () => {
    expect(
      planDeckFocusAdoption({ lane: "controls", focusedId: "s1/track/0/volume", scope: "s0/" }),
    ).toEqual({ kind: "control", mirrorId: "s0/track/0/volume", trackPrefix: "s0/track/0/" });
  });

  it("offers no track fallback for a non-band control", () => {
    // Nothing to walk down to: the caller tries the twin, then the cell cursor.
    expect(
      planDeckFocusAdoption({ lane: "controls", focusedId: "s0/spectral/texture", scope: "s1/" }),
    ).toEqual({ kind: "control", mirrorId: "s1/spectral/texture", trackPrefix: null });
  });

  it("scopes an unscoped foreign control (another webview's box) into this deck", () => {
    expect(
      planDeckFocusAdoption({ lane: "controls", focusedId: "master/volume", scope: "s1/" }),
    ).toEqual({ kind: "control", mirrorId: "s1/master/volume", trackPrefix: null });
  });
});
