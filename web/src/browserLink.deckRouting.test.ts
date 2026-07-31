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

/**
 * THE SINGLE-SPACE RULE (B1). `menuTransport` is what the keymap's Space rides,
 * and NOTHING in the merged host answered it — so Space did nothing in the
 * compose window and nothing in a deck tile. It routes like every other
 * deck-scoped intent now: to the handler the owning mount registered.
 */
describe("menuTransport — the deck-targeted transport", () => {
  it("reaches THAT deck's handler, leaving the compose slot silent", async () => {
    const seen: string[] = [];
    const compose: string[] = [];
    link.setTransportHandler((op) => compose.push(op));
    link.setTransportHandler((op) => seen.push(op), 1);

    expect(await link.command("menuTransport" as never, { op: "play", deck: 1 })).toEqual({
      ok: true,
    });
    expect(seen).toEqual(["play"]);
    expect(compose).toEqual([]);
  });

  it("a deckless call still reaches the compose grid — every pre-B1 caller", async () => {
    const compose: string[] = [];
    link.setTransportHandler((op) => compose.push(op));
    await link.command("menuTransport" as never, { op: "stop" });
    expect(compose).toEqual(["stop"]);
  });

  it("REFUSES rather than faking success when no mount owns that scope", async () => {
    // The distinction the bundle exists for: an unanswered transport must read
    // as unanswered. A silent `{ok:true}` here is exactly how `menuTransport`
    // looked alive for a whole phase while doing nothing.
    expect(await link.command("menuTransport" as never, { op: "play", deck: 2 })).toEqual({
      ok: false,
    });
  });

  it("refuses an op it does not implement instead of guessing at one", async () => {
    const compose: string[] = [];
    link.setTransportHandler((op) => compose.push(op));
    expect(await link.command("menuTransport" as never, { op: "bounce" })).toEqual({ ok: false });
    expect(compose).toEqual([]);
  });
});

/**
 * CM-5b — a track's M while the mute group is ENGAGED edits MEMBERSHIP.
 *
 * `trackRowControls` has branched on `muteGroupActive` and sent this op since it
 * was written, and nothing ever handled it: the click was accepted and dropped,
 * so the group could not be built — which made the MUTE control itself
 * pointless even once it existed.
 */
describe("toggleMuteGroup — building the group", () => {
  it("reaches THAT deck's handler", async () => {
    const seen: number[] = [];
    link.setMuteGroupHandler((i) => seen.push(i), 1);
    await link.command("trackEdit" as never, { op: "toggleMuteGroup", trackIndex: 3, deck: 1 });
    expect(seen).toEqual([3]);
  });

  it("leaves the compose slot silent when the op names a deck", async () => {
    const compose: number[] = [];
    link.setMuteGroupHandler((i) => compose.push(i));
    link.setMuteGroupHandler(() => {}, 1);
    await link.command("trackEdit" as never, { op: "toggleMuteGroup", trackIndex: 3, deck: 1 });
    expect(compose).toEqual([]);
  });
});

/**
 * D-SL-UNDO-01 — topology undo. `undoStore` is per-track and pattern-shaped, so
 * an add-track could only ever push a `swift` MARKER, and that marker delegates
 * to `swiftUndo` — a method no host in this app answers. ⌘Z after adding a
 * track therefore took a step that could never be taken.
 */
describe("topologyUndo — replaying a document edit", () => {
  it("reaches THAT deck's handler with the pattern to restore", async () => {
    const seen: { deck: number; pattern: unknown }[] = [];
    link.setTopologyUndoHandler((deck, pattern) => seen.push({ deck, pattern }), 1);
    const pattern = { bpm: 120, sectionA: [{}] };

    expect(await link.command("topologyUndo" as never, { deck: 1, pattern })).toEqual({ ok: true });
    expect(seen).toEqual([{ deck: 1, pattern }]);
  });

  it("REFUSES rather than faking success when no mount owns that scope", async () => {
    // The distinction that matters: an unanswered undo must read as unanswered.
    // A silent `{ok:true}` here is exactly how `swiftUndo` looked alive while
    // doing nothing.
    expect(await link.command("topologyUndo" as never, { deck: 2, pattern: {} })).toEqual({
      ok: false,
    });
  });
})
