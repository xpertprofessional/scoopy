/**
 * P3.5-E8a — THE SAMPLE DOORS ARE REGISTERED, AND ON THE RIGHT SCOPE.
 *
 * The defect these pin: `GridPanel` draws LOAD on every audio row, but the
 * button only sends an INTENT (`trackEdit/loadSample`) that `BrowserLink`
 * forwards to whatever handler the mounting surface registered — and when
 * none is registered it falls through to a silent `{ok:true}`. The compose
 * window registered none, so LOAD there accepted every click and did nothing.
 *
 * So the first test is the FAILURE, pinned deliberately: an unregistered
 * surface is silently accepted. The rest pin that a registered one is not, and
 * that the two axes stay distinct — `deck` is whose document the sample lands
 * in, `scope` is which handler slot answers, and confusing them is what put
 * doors on the deck tile and none on the compose window.
 *
 * No jsdom here (P6-2b's house rule), so `document` is stubbed to the minimum
 * a file picker touches: what is observed is that a real picker was CLICKED.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeInput {
  type?: string;
  accept?: string;
  style: Record<string, string>;
  clicked: boolean;
  click: () => void;
  addEventListener: (k: string, fn: () => void) => void;
  remove: () => void;
  onchange?: () => void;
  files?: FileList | null;
}
const created: FakeInput[] = [];

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
vi.stubGlobal("document", {
  body: { append: () => {} },
  createElement: () => {
    // The picker never resolves here (nothing fires `change`): this file is
    // only about whether the INTENT reaches a picker at all, which is E8a's
    // question.
    //
    // ⚠️ THAT LIMIT WAS ONCE WRITTEN HERE AS A VIRTUE — "the OS panel that
    // follows is the user's business" — AND IT IS THE HOLE P3.5-E8g FELL
    // THROUGH. Everything after the pick (import, path, decode, the document
    // write) had no coverage anywhere, and the user's next report was exactly
    // that half: "load opens the documentpicker but the file never loads once
    // executed, track stays empty". The rest of the chain is now driven
    // end-to-end in `composeLoadDoor.test.ts`; this file keeps its narrow job.
    const el: FakeInput = {
      style: {},
      clicked: false,
      click: () => (el.clicked = true),
      addEventListener: () => {},
      remove: () => {},
    };
    created.push(el);
    return el;
  },
});

const { BrowserLink } = await import("../browserLink.ts");
const { registerSampleDoors } = await import("./sampleDoors.ts");
const { MAX_TRACKS, idleDeck, useCompanion } = await import("../store/companionEngine.ts");
const { SECTION_KEYS } = await import("../audio/sceneProjection.ts");

let link: InstanceType<typeof BrowserLink>;
beforeEach(() => {
  link = new BrowserLink();
  created.length = 0;
  useCompanion.setState({ error: null });
});

/** The handlers are fired with `void` — let the microtask run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the LOAD button reaches a picker — or is silently swallowed", () => {
  it("SILENTLY ACCEPTS the intent when no surface registered doors (the defect)", async () => {
    const reply = await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();
    expect(reply).toEqual({ ok: true }); // indistinguishable from success, at the UI
    expect(created).toHaveLength(0); // …and no picker ever opened
  });

  it("opens a file picker once the compose surface registers its doors", async () => {
    registerSampleDoors(link, 0, "compose");
    await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe("file");
    expect(created[0]?.clicked).toBe(true);
  });
});

describe("deck vs scope — the axis confusion that caused the row", () => {
  it("compose-scoped doors answer a DECKLESS intent, not a deck-addressed one", async () => {
    registerSampleDoors(link, 2, "compose"); // writes into deck 2, answers deckless
    await link.command("trackEdit", { op: "loadSample", trackIndex: 0, deck: 2 });
    await settle();
    expect(created).toHaveLength(0);

    await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();
    expect(created).toHaveLength(1);
  });

  it("deck-scoped doors answer THAT deck only", async () => {
    registerSampleDoors(link, 1, "deck");
    await link.command("trackEdit", { op: "loadSample", trackIndex: 0, deck: 3 });
    await settle();
    expect(created).toHaveLength(0);

    await link.command("trackEdit", { op: "loadSample", trackIndex: 0, deck: 1 });
    await settle();
    expect(created).toHaveLength(1);
  });
});

describe("the OTHER door — a library path dropped or double-clicked on a row", () => {
  it("routes fileBrowser/load into the document once registered", async () => {
    registerSampleDoors(link, 0, "compose");
    const reply = await link.command("fileBrowser", {
      op: "load",
      path: "/samples/Imported/kick.wav",
      trackIndex: 0,
    });
    await settle();
    expect(reply).toEqual({ notice: null }); // the routed branch, not the stub's
    // It reached the store, which says the honest thing with no session open —
    // the point being that it reached the DOCUMENT layer at all.
    expect(useCompanion.getState().error).toContain("session first");
  });

  it("without registration the intent never reaches the document", async () => {
    await link.command("fileBrowser", {
      op: "load",
      path: "/samples/Imported/kick.wav",
      trackIndex: 0,
    });
    await settle();
    expect(useCompanion.getState().error).toBeNull();
  });
});

// ── P3.5-E8g-h ─────────────────────────────────────────────────────────────
//
// WHICH GESTURE CREATES. The user: "yes it lands on track 1, however it should
// create a new track." The split is whether a ROW WAS NAMED — the contract the
// protocol has always stated (`fileBrowser.test.tsx`: "omitting trackIndex is
// what means NEW TRACK") and the shipping app still implements
// (`WebFileBrowserBinding.loadBrowserSample`, ../scoopyloops:203 — "trackIndex
// == nil means **create a track**, which is what the native browser's
// double-click and `load` button both do").
//
// ⚠️ WHAT THESE CANNOT SEE: no jsdom, no React renderer, so "a new row appeared
// in the grid" is walk-only (P3.5-E8g-f). They stop at the document and at the
// `gridMeta.trackCount` the panel would read, which is one layer short of paint.

/** A document with `n` rows in every section, opened on deck 0 and loaded into the grid. */
function openDoc(link: InstanceType<typeof BrowserLink>, n: number): void {
  const rows = () => Array.from({ length: n }, () => ({}));
  const pattern: Record<string, unknown> = {
    bpm: 120,
    baseSettings: { trackSettings: Array.from({ length: n }, () => ({})) },
  };
  for (const key of SECTION_KEYS) pattern[key] = rows();
  useCompanion.setState(
    (s) =>
      ({
        decks: s.decks.map((d, i) =>
          i === 0
            ? {
                ...d,
                session: {
                  name: "My Session",
                  pattern,
                  kit: { id: "k", name: "kit", samples: [] },
                  extras: new Map(),
                },
              }
            : d,
        ),
      }) as never,
  );
  link.gridBackend.load(pattern, [], "My Session");
}

const trackCount = () =>
  (useCompanion.getState().decks[0]!.session!.pattern.sectionA as unknown[]).length;

/**
 * The handlers are fired with `void`, and the create path awaits the fresh-session
 * TEMPLATE — a dynamic import plus a full pattern decode on its first call. One
 * macrotask is not enough for that, and a fixed sleep long enough to cover it would
 * be slow on every other test. So wait on the CONDITION, with a bounded number of
 * ticks so a genuine failure still fails rather than hanging.
 *
 * ⚠️ THE BOUND IS GENEROUS ON PURPOSE. It was 200 ticks and went red exactly once,
 * on a machine that was also running the nine drift gates — the decode simply took
 * longer than the budget. A gate that fails under load is worse than a slow one:
 * it teaches you to re-run reds instead of reading them. The ceiling only costs
 * wall-clock on a GENUINE failure, and it stays well inside vitest's 5 s timeout.
 */
async function waitFor(cond: () => boolean, ticks = 1500): Promise<void> {
  for (let i = 0; i < ticks && !cond(); i++) await new Promise((r) => setTimeout(r, 1));
}

describe("only an UNTARGETED load creates a track", () => {
  beforeEach(() => {
    useCompanion.setState({
      decks: useCompanion.getState().decks.map(() => idleDeck()),
      error: null,
      notice: null,
    });
  });

  it("a double-click (no trackIndex) APPENDS — it does not overwrite the cursor's row", async () => {
    registerSampleDoors(link, 0, "compose");
    openDoc(link, 8);
    await link.command("gridEdit", { op: "selectTrack", trackIndex: 4 }); // "track 5"

    await link.command("fileBrowser", { op: "load", path: "/samples/kick.wav" });
    await waitFor(() => trackCount() > 8);

    expect(trackCount()).toBe(9);
    // The cursor follows the new row, as `addTrackInternal` does
    // (keyboardSelectedTrackIndex = newIndex, BeatSequencer.swift:15656).
    expect(link.gridBackend.selectedIndex).toBe(8);
  });

  it("a DROP onto a row replaces that row and creates nothing", async () => {
    registerSampleDoors(link, 0, "compose");
    openDoc(link, 8);
    await link.command("fileBrowser", { op: "load", path: "/samples/kick.wav", trackIndex: 2 });
    await settle();
    expect(trackCount()).toBe(8);
  });

  it("the LOAD button names its own row and creates nothing", async () => {
    registerSampleDoors(link, 0, "compose");
    openDoc(link, 8);
    await link.command("trackEdit", { op: "loadSample", trackIndex: 3 });
    await settle();
    expect(trackCount()).toBe(8);
    expect(created).toHaveLength(1); // it opened a picker instead
  });

  it("at the ceiling it REFUSES OUT LOUD and creates nothing", async () => {
    registerSampleDoors(link, 0, "compose");
    openDoc(link, MAX_TRACKS);
    await link.command("fileBrowser", { op: "load", path: "/samples/kick.wav" });
    await waitFor(() => useCompanion.getState().error !== null);
    expect(trackCount()).toBe(MAX_TRACKS);
    expect(useCompanion.getState().error).toContain(String(MAX_TRACKS));
    // ⚠️ And the load does not quietly proceed onto some other row — a refusal
    // that still landed the sample somewhere is the silent accept, inverted.
    expect(useCompanion.getState().notice).toBeNull();
  });
});

describe("addTrack — the verb that existed and reached nothing", () => {
  beforeEach(() => {
    useCompanion.setState({
      decks: useCompanion.getState().decks.map(() => idleDeck()),
      error: null,
      notice: null,
    });
  });

  it("THE DEFECT: unregistered it throws, and both callers .catch() that away", async () => {
    // `MasterRow.tsx:174` and `registry.ts:211` (⌘T) are fire-and-forget with a
    // `.catch(() => {})`, so this throw has been invisible in every browser host.
    await expect(link.command("addTrack", {})).rejects.toThrow();
  });

  it("registered, it appends and hands back the new index", async () => {
    const meta: unknown[] = [];
    link.onUiState("gridMeta", (s) => meta.push(s));
    registerSampleDoors(link, 0, "compose");
    openDoc(link, 2);

    expect(await link.command("addTrack", {})).toEqual({ trackIndex: 2 });
    expect(trackCount()).toBe(3);
    // The panel learns of the row through `gridMeta.trackCount`: a repaint that
    // pushed only `gridRuntime/<i>` could not draw a row the backend never had.
    expect((meta.at(-1) as { trackCount: number }).trackCount).toBe(3);
  });

  it("rejects LOUDLY at the ceiling, as the schema demands", async () => {
    registerSampleDoors(link, 0, "compose");
    openDoc(link, MAX_TRACKS);
    await expect(link.command("addTrack", {})).rejects.toThrow();
    expect(useCompanion.getState().error).toContain(String(MAX_TRACKS));
  });
});
