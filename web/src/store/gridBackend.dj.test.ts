/**
 * The dj topic family + mount-owned meta facts (P3-D4-1).
 *
 * `GridPanel@dj` reads `djMeta/<d>` / `djPattern/<d>/<i>` / `djRuntime/<d>/<i>`
 * — addresses NOTHING in the merged host served before this row (the D4-M
 * hard-block finding: meta absent = "waiting for pattern state…" forever).
 * These pin that a deck-parameterised backend publishes exactly those strings,
 * answers the deterministic pull for them, and carries the facts the document
 * cannot know (deck identity, the sync law's resolved tempo, the keyboard
 * claim).
 */
import { describe, expect, it, vi } from "vitest";
import { GridBackend, djGridTopics } from "./gridBackend.ts";

function makeDj(deck = 1) {
  const published: Array<{ topic: string; state: unknown }> = [];
  const backend = new GridBackend(
    {
      publish: (topic, state) => published.push({ topic, state }),
      onEdit: vi.fn(),
      peaks: vi.fn(async () => ({ minMax: [], rms: [] })),
    },
    djGridTopics(deck),
  );
  backend.load({ bpm: 120, sectionA: [{}, {}] } as unknown as Record<string, unknown>, [
    { name: "T1", sampleKey: null, sampleDurationMs: 0, samplePeakGain: 1 },
    { name: "T2", sampleKey: null, sampleDurationMs: 0, samplePeakGain: 1 },
  ]);
  return { backend, published };
}

describe("GridBackend at the dj topic family", () => {
  it("publishes the EXACT addresses djSource(deck) reads", () => {
    const { published } = makeDj(1);
    const topics = published.map((p) => p.topic);
    expect(topics).toContain("djMeta/1");
    expect(topics).toContain("djPattern/1/0");
    expect(topics).toContain("djRuntime/1/1");
    // …and none of the compose family — two surfaces, two address spaces.
    expect(topics.some((t) => t.startsWith("gridPattern/"))).toBe(false);
    expect(topics).not.toContain("gridMeta");
  });

  it("answers the deterministic pull for its own topics", () => {
    const { backend, published } = makeDj(2);
    published.length = 0;
    backend.republish("djPattern/2/1");
    backend.republish("djMeta/2");
    expect(published.map((p) => p.topic)).toEqual(["djPattern/2/1", "djMeta/2"]);
    // A topic from ANOTHER deck's family is not this backend's to answer.
    published.length = 0;
    backend.republish("djPattern/0/1");
    expect(published).toHaveLength(0);
  });

  it("meta carries the mount-owned facts, and an unchanged set does not republish", () => {
    const { backend, published } = makeDj(0);
    backend.setMetaFacts({ deckIndex: 0, syncedBpm: 132.5, keyboardActive: true });
    const meta = [...published].reverse().find((p) => p.topic === "djMeta/0")!.state as {
      deckIndex: number | null;
      syncedBpm: number | null;
      keyboardActive: boolean;
      masterSends: number[];
    };
    expect(meta.deckIndex).toBe(0);
    expect(meta.syncedBpm).toBe(132.5);
    expect(meta.keyboardActive).toBe(true);
    // The sends cluster stays hidden honestly — returnFx is P6's.
    expect(meta.masterSends).toEqual([]);
    // Same facts again → no publish. The binding refreshes on every render
    // pass; a republish per pass would repaint three panels for nothing.
    const before = published.length;
    backend.setMetaFacts({ deckIndex: 0, syncedBpm: 132.5, keyboardActive: true });
    expect(published.length).toBe(before);
  });
});
