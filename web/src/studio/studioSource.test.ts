import { describe, expect, it } from "vitest";
import {
  HotFrameLayout,
  MAX_GRID_TRACKS,
  djTrackStepIndex,
  djTrackPosIndex,
  djTrackLevelIndex,
} from "../../protocol/schema.ts";
import { COMPOSE_SOURCE, STUDIO_SOURCE, djSource } from "../panels/GridPanel.tsx";

/**
 * S1 · D-SL-STUDIO-01 — the Studio source is the compose DOCUMENT with the
 * deck's TELEMETRY, and every assertion below locks one half of that sentence.
 *
 * This is a defect-shaped test, not a shape-shaped one: the thing it guards is
 * that `STUDIO_SOURCE` reads HotFrame lanes the merged engine actually WRITES.
 * The failure it prevents is silent and cosmetic-looking — a playhead frozen at
 * step 0 forever — which is exactly what a plain compose mount does in this
 * host today, and what nobody noticed until a plugin was opened in Logic.
 */
describe("STUDIO_SOURCE — compose document, deck-0 telemetry", () => {
  it("reads the deck-0 lanes, NOT the compose lanes nothing writes", () => {
    // The whole point. `sl_engine.cpp` fills playheadStepDeck0..2 and the
    // per-deck djTrack* blocks and stops; trackStep0/Pos0/Level0 are declared
    // in the layout and written by nobody.
    expect(STUDIO_SOURCE.hotBase).toBe(djTrackStepIndex(0, 0));
    expect(STUDIO_SOURCE.hotPosBase).toBe(djTrackPosIndex(0, 0));
    expect(STUDIO_SOURCE.hotLevelBase).toBe(djTrackLevelIndex(0, 0));

    expect(STUDIO_SOURCE.hotBase).not.toBe(HotFrameLayout.trackStep0);
    expect(STUDIO_SOURCE.hotPosBase).not.toBe(HotFrameLayout.trackPos0);
    expect(STUDIO_SOURCE.hotLevelBase).not.toBe(HotFrameLayout.trackLevel0);
  });

  it("keeps the COMPOSE document topics — it is not a dj mount", () => {
    // Switching topics too would move the document onto a backend
    // `useComposeBinding` does not feed, and take LOAD, sample browse, the
    // sample doors and the scene pins with it. Studio is the surface a person
    // loads samples IN, so the document half must stay compose.
    expect(STUDIO_SOURCE.metaTopic).toBe(COMPOSE_SOURCE.metaTopic);
    for (let i = 0; i < MAX_GRID_TRACKS; i++) {
      expect(STUDIO_SOURCE.patternTopic(i)).toBe(COMPOSE_SOURCE.patternTopic(i));
      expect(STUDIO_SOURCE.runtimeTopic(i)).toBe(COMPOSE_SOURCE.runtimeTopic(i));
    }
    expect(STUDIO_SOURCE.metaTopic).not.toBe(djSource(0).metaTopic);
    expect(STUDIO_SOURCE.patternTopic(0)).not.toBe(djSource(0).patternTopic(0));
  });

  it("renders at compose density and keeps the compose deck scope", () => {
    expect(STUDIO_SOURCE.density).toBe("compose");
    // `undefined` = the compose resolver, exactly as COMPOSE_SOURCE. The deck
    // reaches edits through useComposeBinding's handlers, not through the
    // source's scope — pinning a 0 here would send them down a second path.
    expect(STUDIO_SOURCE.deck).toBeUndefined();
  });

  it("still feeds the P5-04 shadow store, unlike every dj source", () => {
    // The stated hazard was three DECKS interleaving patterns under one
    // track-index key. Studio is one grid on one engine — the case the
    // singleton was always keyed for — so the evidence path stays intact.
    expect(STUDIO_SOURCE.shadow).toBe(true);
    for (const deck of [0, 1, 2]) expect(djSource(deck).shadow).toBe(false);
  });

  it("differs from COMPOSE_SOURCE in exactly the three telemetry keys", () => {
    // A guard against the next edit widening the divergence by accident: if
    // Studio ever needs to differ in a fourth way, that is a decision someone
    // should have to make on purpose, in this test, with a reason.
    const differing = (Object.keys(COMPOSE_SOURCE) as (keyof typeof COMPOSE_SOURCE)[]).filter(
      (k) => {
        const a = COMPOSE_SOURCE[k];
        const b = STUDIO_SOURCE[k];
        // The topic members are functions; compare what they produce.
        if (typeof a === "function" && typeof b === "function") {
          return Array.from({ length: MAX_GRID_TRACKS }, (_v, i) => i).some(
            (i) => (a as (n: number) => string)(i) !== (b as (n: number) => string)(i),
          );
        }
        return a !== b;
      },
    );
    expect(differing.sort()).toEqual(["hotBase", "hotLevelBase", "hotPosBase"]);
  });
});
