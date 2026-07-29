/**
 * DECK ROUTING THROUGH THE LINK (P3-D4-1).
 *
 * BrowserLink held ONE GridBackend and six SINGLE handler slots, and
 * `publishTrackPattern` / `getSamplePeaks` / `gridEdit` / `trackEdit` all
 * DROPPED the `deck` field the schema has carried since P6-03 — so mounting
 * two grid surfaces meant deck 0's edits landed in deck 1's document (the
 * D4-M measurement). These pin the routing: a deck-carrying command reaches
 * that deck's backend and THAT deck's handlers, and a deckless command still
 * reaches the compose grid every pre-D4-1 caller registered against.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("window", {});
vi.stubGlobal("requestAnimationFrame", () => 0);
vi.stubGlobal("cancelAnimationFrame", () => {});
vi.stubGlobal("navigator", {
  storage: { getDirectory: () => Promise.reject(new Error("no OPFS here")) },
});
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

const { BrowserLink } = await import("./browserLink.ts");
const { HotFrameLayout, djTrackStepIndex, djTrackPosIndex, djTrackLevelIndex } = await import(
  "../protocol/schema.ts"
);

const info = { name: "T1", sampleKey: null, sampleDurationMs: 0, samplePeakGain: 1 };
const doc = { bpm: 120, sectionA: [{}] } as unknown as Record<string, unknown>;

let link: InstanceType<typeof BrowserLink>;
beforeEach(() => {
  link = new BrowserLink();
});

describe("deck routing", () => {
  it("trackEdit with a deck lands on THAT deck's handlers — the compose slot stays silent", async () => {
    const compose: number[] = [];
    const deck1: number[] = [];
    link.setLaunchToggleHandler((i) => compose.push(i));
    link.setLaunchToggleHandler((i) => deck1.push(i), 1);
    await link.command("trackEdit", { op: "toggleLaunch", trackIndex: 0, deck: 1 });
    expect(deck1).toEqual([0]);
    expect(compose).toEqual([]);
    // …and the deckless call is the compose grid's, exactly as before D4-1.
    await link.command("trackEdit", { op: "toggleLaunch", trackIndex: 0 });
    expect(compose).toEqual([0]);
    expect(deck1).toEqual([0]);
  });

  it("publishTrackPattern is answered by the ADDRESSED backend", async () => {
    // Compose holds a track; deck 1 holds nothing. A deck-1 publish must be
    // refused BY DECK 1 ("no track 0") — before the routing, it would have
    // landed on the loaded compose document and silently edited it.
    link.gridBackend.load(doc, [info]);
    const reply = (await link.command("publishTrackPattern", {
      trackIndex: 0,
      json: "{}",
      deck: 1,
    })) as { applied: boolean; error: string | null };
    expect(reply.applied).toBe(false);
    expect(reply.error).toContain("no track 0");
  });

  it("gridEdit selectTrack moves the ADDRESSED deck's cursor only", async () => {
    link.gridBackend.load(doc, [info]);
    link.djGridBackend(2).load(
      { bpm: 120, sectionA: [{}, {}] } as unknown as Record<string, unknown>,
      [info, info],
    );
    await link.command("gridEdit", { op: "selectTrack", trackIndex: 1, deck: 2 });
    expect(link.djGridBackend(2).selectedIndex).toBe(1);
    expect(link.gridBackend.selectedIndex).toBe(0);
  });

  it("getUiState routes a dj topic to its deck's backend", async () => {
    link.djGridBackend(1).load(doc, [info]);
    const seen: string[] = [];
    // Subscribe AFTER load so replay is not what answers; the pull must.
    const off = link.onUiState("djPattern/1/0", () => seen.push("djPattern/1/0"));
    seen.length = 0;
    await link.command("getUiState", { topic: "djPattern/1/0" });
    expect(seen).toContain("djPattern/1/0");
    off();
  });

  it("per-deck peak paths do not bleed across scopes", async () => {
    // Deck 1 gets a path; compose gets none. The compose read must come back
    // empty rather than borrowing deck 1's sample.
    link.djGridBackend(1).load(doc, [{ ...info, sampleKey: "k" }]);
    link.setGridPeakPaths(["/samples/a.wav"], 1);
    link.gridBackend.load(doc, [info]);
    const composePeaks = (await link.command("getSamplePeaks", {
      trackIndex: 0,
      points: 8,
    })) as { minMax: number[] };
    expect(composePeaks.minMax).toEqual([]);
  });

  it("stamps the dj playhead sentinels — a browser frame must not wash step 0 (the D4-3 bug's browser coat)", () => {
    const frame = (link as unknown as { frame: Float64Array }).frame;
    expect(frame[djTrackStepIndex(1, 3)]).toBe(-1);
    expect(frame[djTrackPosIndex(2, 0)]).toBe(-1);
    // Levels are NOT sentinels: 0 means silent, which is true here.
    expect(frame[djTrackLevelIndex(0, 0)]).toBe(0);
    // The original families keep their stamps.
    expect(frame[HotFrameLayout.trackStep0]).toBe(-1);
  });
});
