/**
 * The armed cell-parameter lane in the browser (2026-07-22).
 *
 * activeCellParameterName is RUNTIME UI state with no pattern-wire home, so the
 * browser had no memory of it: every value-drag resolved to the empty default
 * and per-cell editing did nothing. GridBackend now owns it. These pin the two
 * things that were broken: the default is "pitch" (an unarmed drag edits
 * pitch, like the desktop), and setActiveCellParameter both sticks AND
 * republishes the runtime so the editor sees the new lane.
 */
import { describe, expect, it, vi } from "vitest";
import { GridBackend } from "./gridBackend.ts";
import type { GridRuntimeState } from "../../protocol/schema.ts";

function makeBackend() {
  const published: Array<{ topic: string; state: unknown }> = [];
  const backend = new GridBackend({
    publish: (topic, state) => published.push({ topic, state }),
    onEdit: vi.fn(),
    peaks: vi.fn(async () => ({ minMax: [], rms: [] })),
  });
  // Two-track document — the minimum a projection needs is the track scaffold.
  backend.load({ bpm: 120, sectionA: [{}, {}] } as unknown as Record<string, unknown>, [
    { name: "T1", sampleKey: null, sampleDurationMs: 0, samplePeakGain: 1 },
    { name: "T2", sampleKey: null, sampleDurationMs: 0, samplePeakGain: 1 },
  ]);
  const runtimeOf = (i: number): GridRuntimeState => {
    const hit = [...published].reverse().find((p) => p.topic === `gridRuntime/${i}`);
    return hit!.state as GridRuntimeState;
  };
  return { backend, published, runtimeOf };
}

describe("GridBackend armed cell parameter", () => {
  it("defaults every track's armed lane to pitch (an unarmed drag edits pitch)", () => {
    const { runtimeOf } = makeBackend();
    expect(runtimeOf(0).activeCellParameterName).toBe("pitch");
    expect(runtimeOf(1).activeCellParameterName).toBe("pitch");
  });

  it("setActiveCellParameter sticks and republishes that track's runtime", () => {
    const { backend, published, runtimeOf } = makeBackend();
    const before = published.length;
    backend.setActiveCellParameter(1, "pan");
    // Republished exactly the one track's runtime…
    expect(published.slice(before)).toEqual([
      { topic: "gridRuntime/1", state: expect.objectContaining({ activeCellParameterName: "pan" }) },
    ]);
    // …and it persists on the next read, without disturbing the sibling.
    expect(runtimeOf(1).activeCellParameterName).toBe("pan");
    expect(runtimeOf(0).activeCellParameterName).toBe("pitch");
  });

  it("a fresh session load resets the arms to the default", () => {
    const { backend, runtimeOf } = makeBackend();
    backend.setActiveCellParameter(0, "tone");
    backend.load({ bpm: 120, sectionA: [{}, {}] } as unknown as Record<string, unknown>, [
      { name: "T1", sampleKey: null, sampleDurationMs: 0, samplePeakGain: 1 },
      { name: "T2", sampleKey: null, sampleDurationMs: 0, samplePeakGain: 1 },
    ]);
    expect(runtimeOf(0).activeCellParameterName).toBe("pitch");
  });
});
