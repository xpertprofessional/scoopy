import { describe, expect, it } from "vitest";
import { HotFrameLayout, djTrackStepIndex, MAX_GRID_TRACKS } from "../../protocol/schema.ts";
import { COMPOSE_SOURCE, djSource } from "./GridPanel.tsx";

/**
 * P6-03 — the reuse contract (djmode.md §8 Q1). The DJ deck strip is the
 * compose grid at another density, so everything that makes the two surfaces
 * DIFFERENT lives in the GridSource. These lock the parts that are silent when
 * they break.
 */
describe("GridSource — DJ vs compose", () => {
  it("a DJ deck NEVER feeds the P5-04 shadow store", () => {
    // The store is a singleton keyed by TRACK INDEX and is the evidence gate
    // for P5-06 THE FLIP. Three decks writing into it would interleave three
    // different patterns under the same keys and manufacture drift that isn't
    // real — silently destroying the evidence it exists to produce.
    for (const deck of [0, 1, 2]) expect(djSource(deck).shadow).toBe(false);
    expect(COMPOSE_SOURCE.shadow).toBe(true);
  });

  it("scopes topics per deck without colliding with the compose namespace", () => {
    // P5-06 step B: one track arrives as TWO topics — the DOCUMENT half (TS's after the flip)
    // and the RUNTIME half (Swift's forever).
    expect(COMPOSE_SOURCE.metaTopic).toBe("gridMeta");
    expect(COMPOSE_SOURCE.patternTopic(3)).toBe("gridPattern/3");
    expect(COMPOSE_SOURCE.runtimeTopic(3)).toBe("gridRuntime/3");
    expect(djSource(1).metaTopic).toBe("djMeta/1");
    expect(djSource(1).patternTopic(3)).toBe("djPattern/1/3");
    expect(djSource(1).runtimeTopic(3)).toBe("djRuntime/1/3");
    // No DJ topic may ever equal a compose topic (they carry different decks'
    // patterns under the same payload type).
    const composeTopics = new Set([
      COMPOSE_SOURCE.metaTopic,
      ...Array.from({ length: MAX_GRID_TRACKS }, (_v, i) => COMPOSE_SOURCE.patternTopic(i)),
      ...Array.from({ length: MAX_GRID_TRACKS }, (_v, i) => COMPOSE_SOURCE.runtimeTopic(i)),
    ]);
    for (const deck of [0, 1, 2]) {
      const s = djSource(deck);
      expect(composeTopics.has(s.metaTopic)).toBe(false);
      for (let i = 0; i < MAX_GRID_TRACKS; i++) {
        expect(composeTopics.has(s.patternTopic(i))).toBe(false);
        expect(composeTopics.has(s.runtimeTopic(i))).toBe(false);
      }
    }
  });

  it("a pattern topic is never a runtime topic (the ownership boundary must be unambiguous)", () => {
    // If these namespaces could collide, Swift would one day stop pushing a topic TS still
    // needs — the exact silent failure the split exists to prevent.
    for (const s of [COMPOSE_SOURCE, djSource(0), djSource(1), djSource(2)]) {
      for (let i = 0; i < MAX_GRID_TRACKS; i++) {
        expect(s.patternTopic(i)).not.toBe(s.runtimeTopic(i));
      }
    }
  });

  it("carries the deck scope so edits reach the right sequencer", () => {
    expect(COMPOSE_SOURCE.deck).toBeUndefined(); // = the compose resolver
    expect(djSource(0).deck).toBe(0);
    expect(djSource(2).deck).toBe(2);
  });

  it("reads each deck's own HotFrame playhead block", () => {
    expect(COMPOSE_SOURCE.hotBase).toBe(HotFrameLayout.trackStep0);
    // Per-deck blocks are contiguous, distinct, and 16 wide — an off-by-one
    // here would draw deck B's playhead on deck A's grid.
    const bases = [0, 1, 2].map((d) => djSource(d).hotBase);
    expect(bases[1]! - bases[0]!).toBe(MAX_GRID_TRACKS);
    expect(bases[2]! - bases[1]!).toBe(MAX_GRID_TRACKS);
    expect(bases[0]).toBe(djTrackStepIndex(0, 0));
    expect(djTrackStepIndex(2, 15)).toBe(bases[2]! + 15);
    // …and the DJ block must not overlap the compose one.
    expect(bases[0]!).toBeGreaterThan(HotFrameLayout.trackStep0 + MAX_GRID_TRACKS - 1);
  });

  it("renders DJ decks at the compact density", () => {
    expect(COMPOSE_SOURCE.density).toBe("compose");
    for (const deck of [0, 1, 2]) expect(djSource(deck).density).toBe("dj");
  });
});
