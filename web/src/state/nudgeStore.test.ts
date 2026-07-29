/**
 * The nudge store (P3-D4-2): transient, per-deck, snap-back — and it pushes
 * the re-resolved tempo at the engine on every change, because a bend the
 * engine never hears is a fake fader.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { nudgeOf, setNudge, useNudge } from "./nudgeStore.ts";
import { useMapStore } from "./mapStore.ts";
import { newGridElement, newStrip } from "../plane/stripOps.ts";
import type { EngineLink } from "../engineLink.ts";

/** A link that records what applyTempo sends. */
function fakeLink() {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const link = {
    command: async (method: string, params: unknown) => {
      sent.push({ method, params: params as Record<string, unknown> });
      return { ok: true };
    },
    paramWrite: () => {},
    onHotFrame: () => () => {},
    onEvent: () => () => {},
    onUiState: () => () => {},
  } as unknown as EngineLink;
  return { link, sent };
}

beforeEach(() => {
  useNudge.setState({ deltas: {} });
  // A synced grid strip in the map, or applyTempo has no intents to push.
  const strip = {
    ...newStrip(0, { x: 0, y: 0 }),
    element: { ...newGridElement(0, "ses", 120), syncToMaster: true },
  };
  useMapStore.setState((s) => ({ map: { ...s.map, strips: [strip] } }));
});

describe("the nudge store", () => {
  it("bends per deck and snaps back to zero", () => {
    const { link } = fakeLink();
    setNudge(link, 1, 4);
    expect(nudgeOf(1)).toBe(4);
    expect(nudgeOf(0)).toBe(0); // the other deck's fader is untouched
    setNudge(link, 1, 0);
    expect(nudgeOf(1)).toBe(0);
  });

  it("pushes the tempo lane on change and NOT on a repeated identical delta", async () => {
    const { link, sent } = fakeLink();
    setNudge(link, 0, 4);
    // One grid strip = the deck trio (setTempoMode · setTempoSync · setTranspose).
    await vi.waitFor(() => expect(sent.length).toBe(3));
    // …and the ratio the engine heard is the BENT one: 124/120 at 1:1.
    const ratio = sent.find((s) => (s.params as { action?: string }).action === "setTempoSync")
      ?.params as { ratio?: number };
    expect(ratio?.ratio).toBeCloseTo(124 / 120, 3);
    // The pointer fires enter/move noise — an identical delta must not
    // re-push the whole tempo lane every frame.
    setNudge(link, 0, 4);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.length).toBe(3);
  });
});
