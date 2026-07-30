/**
 * P3.5-E8g-e — THE GRID CURSOR SURVIVES A DOCUMENT EDIT.
 *
 * The defect, found while measuring E8g-a and never reported by a user because
 * it takes TWO doors in a row to see:
 *
 *   select track 5 → edit any cell → double-click a file in FILES
 *   → THE SAMPLE LANDS ON TRACK 1
 *
 * Three true things nobody had put together. `GridBackend.load` reset
 * `selected = 0`. The bindings' reload effect is keyed on the session OBJECT,
 * and every document edit replaces it — so `load` runs on every edit, not just
 * when a session opens. And `fileBrowser load` with no explicit `trackIndex`
 * falls back to `grid.selectedIndex` (browserLink.ts:392). Each is reasonable
 * alone; together they silently move where the next sample lands.
 *
 * The distinction that IS the row: a reload of the SAME document keeps the
 * cursor, a genuinely NEW document still resets it. "Track 5" is a promise
 * about a specific row, and it means nothing once row 5 is a different track —
 * carrying it across a session change would put a dropped sample somewhere the
 * user never pointed.
 *
 * ⚠️ WHAT THESE PINS CANNOT SEE: no jsdom, no React renderer, so they cannot
 * prove the SELECTION HIGHLIGHT moved on screen, and they do not simulate React
 * — the reload effect is driven here by calling `load` the way the bindings do.
 * What they do prove is where the next untargeted load is aimed, which is the
 * half the user feels.
 *
 * ⚠️ **REPOINTED BY P3.5-E8g-h, NOT DELETED.** The property this file exists for
 * is unchanged — a cursor is UI state and must survive an edit of the same
 * document — but the door it was measured through moved. The user's answer to
 * "it lands on track 1" was "it should create a new track", so an UNTARGETED
 * `fileBrowser load` no longer reads the cursor at all: it arrives as `null` and
 * appends. The cursor still aims the LOAD button (`trackEdit loadSample` with no
 * `trackIndex` resolves to `grid.selectedIndex`, browserLink.ts:329), so that is
 * the door these pins now drive, and the untargeted-load tests below assert the
 * NEW contract — that the cursor is deliberately not consulted.
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

const { BrowserLink } = await import("../browserLink.ts");
const { GridBackend } = await import("./gridBackend.ts");

const info = (n: number) => ({
  name: `T${n}`,
  sampleKey: null,
  sampleDurationMs: 0,
  samplePeakGain: 1,
});
/** An eight-track document, the shape a projection needs and nothing more. */
const doc = (tracks = 8) =>
  ({ bpm: 120, sectionA: Array.from({ length: tracks }, () => ({})) }) as unknown as Record<
    string,
    unknown
  >;
const runtime = (tracks = 8) => Array.from({ length: tracks }, (_, i) => info(i + 1));

/** The handlers are fired with `void` — let the microtask run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let link: InstanceType<typeof BrowserLink>;
/** Every `fileBrowser load` that reached a handler. `null` = the gesture named no row. */
let landed: Array<{ trackIndex: number | null; path: string }>;
/** Every row the LOAD button asked a picker for — the door the cursor still aims. */
let picked: number[];
beforeEach(() => {
  link = new BrowserLink();
  landed = [];
  picked = [];
  link.setSampleLoadHandler(async (trackIndex, path) => {
    landed.push({ trackIndex, path });
  });
  link.setSamplePickHandler(async (trackIndex) => {
    picked.push(trackIndex);
  });
});

/** The row's LOAD button, fired without an explicit index — what `GridPanel` sends
    when the click carries no row of its own. This is where the cursor is read now. */
const loadButton = () => link.command("trackEdit", { op: "loadSample" });

/** Exactly what the bindings' reload effect does on every document edit. */
const reload = (name: string, tracks = 8) =>
  link.gridBackend.load(doc(tracks), runtime(tracks), name);

describe("an untargeted load lands where the cursor is", () => {
  it("THE DEFECT, end to end: an edit used to send the next sample to track 1", async () => {
    reload("My Session");
    await link.command("gridEdit", { op: "selectTrack", trackIndex: 4 }); // "track 5"
    expect(link.gridBackend.selectedIndex).toBe(4);

    // The cell edit. The store writes the document, the session object is replaced, and the
    // binding's effect reloads the backend — this line IS that effect.
    reload("My Session");

    // Driven through the LOAD button since E8g-h: the FILES double-click that used to
    // stand here now means "new track" and never consults the cursor (see below). The
    // defect being pinned is the same one — an edit silently moving where a sample goes.
    await loadButton();
    await settle();
    // Before E8g-e: 0.
    expect(picked).toEqual([4]);
  });

  it("survives a whole run of edits, not just one", async () => {
    reload("My Session");
    await link.command("gridEdit", { op: "selectTrack", trackIndex: 6 });
    for (let i = 0; i < 5; i++) reload("My Session");
    expect(link.gridBackend.selectedIndex).toBe(6);
  });

  it("an EXPLICIT trackIndex still wins — a row-drop names its own row", async () => {
    reload("My Session");
    await link.command("gridEdit", { op: "selectTrack", trackIndex: 4 });
    await link.command("fileBrowser", { op: "load", path: "/samples/snare.wav", trackIndex: 1 });
    await settle();
    expect(landed).toEqual([{ trackIndex: 1, path: "/samples/snare.wav" }]);
  });

  it("a FILES double-click deliberately does NOT read the cursor any more (E8g-h)", async () => {
    // The contract this REPLACED: `trackIndex` absent used to be coerced to
    // `grid.selectedIndex` here, so the same gesture overwrote whatever row the user
    // had last touched. It now travels as `null` — "no row was named" — all the way
    // to the handler, which appends. Asserted against a cursor parked somewhere
    // conspicuous, so a regression to the old coercion cannot pass by accident.
    reload("My Session");
    await link.command("gridEdit", { op: "selectTrack", trackIndex: 4 });
    await link.command("fileBrowser", { op: "load", path: "/samples/kick.wav" });
    await settle();
    expect(landed).toEqual([{ trackIndex: null, path: "/samples/kick.wav" }]);
    // …and the cursor is untouched by the load: it still aims the LOAD button.
    expect(link.gridBackend.selectedIndex).toBe(4);
  });

  it("`trackIndex: 0` is a NAMED row, not an absent one", async () => {
    // The falsy trap. A coercion written `||` rather than `??`, or a
    // `Number(p.trackIndex) || null`, would turn an explicit drop on track 1 into a
    // create — the one index where "named" and "absent" are easiest to confuse.
    reload("My Session");
    await link.command("gridEdit", { op: "selectTrack", trackIndex: 4 });
    await link.command("fileBrowser", { op: "load", path: "/samples/kick.wav", trackIndex: 0 });
    await settle();
    expect(landed).toEqual([{ trackIndex: 0, path: "/samples/kick.wav" }]);
  });
});

describe("a genuinely new document still resets — the distinction that is the row", () => {
  it("opening a DIFFERENT session sends the cursor home", async () => {
    reload("My Session");
    await link.command("gridEdit", { op: "selectTrack", trackIndex: 4 });
    reload("Another Session"); // a different document: row 5 is a different track now
    expect(link.gridBackend.selectedIndex).toBe(0);

    await loadButton();
    await settle();
    expect(picked).toEqual([0]);
  });

  it("a caller that names NO document keeps the old reset-always behaviour", () => {
    // `undefined` must read as "different" in BOTH directions, so a call site that
    // never opts in cannot silently inherit a stale cursor.
    const backend = new GridBackend({
      publish: () => {},
      onEdit: vi.fn(),
      peaks: vi.fn(async () => ({ minMax: [], rms: [] })),
    });
    backend.load(doc(), runtime());
    backend.selectTrack(3);
    backend.load(doc(), runtime());
    expect(backend.selectedIndex).toBe(0);
  });
});

describe("the edges the reset used to hide", () => {
  it("clamps a cursor the edit left past the end (tracks were deleted)", () => {
    const backend = new GridBackend({
      publish: () => {},
      onEdit: vi.fn(),
      peaks: vi.fn(async () => ({ minMax: [], rms: [] })),
    });
    backend.load(doc(8), runtime(8), "S");
    backend.selectTrack(7);
    backend.load(doc(3), runtime(3), "S");
    // A `selectedIndex` no row answers to is where a dropped sample would vanish.
    expect(backend.selectedIndex).toBe(2);
  });

  it("an empty document leaves the cursor at 0 rather than -1", () => {
    const backend = new GridBackend({
      publish: () => {},
      onEdit: vi.fn(),
      peaks: vi.fn(async () => ({ minMax: [], rms: [] })),
    });
    backend.load(doc(4), runtime(4), "S");
    backend.selectTrack(3);
    backend.load({ bpm: 120, sectionA: [] } as unknown as Record<string, unknown>, [], "S");
    expect(backend.selectedIndex).toBe(0);
  });

  it("the armed cell-parameter lane rides with the cursor, and resets with the document", () => {
    // Lost the same way and for the same reason: per-track UI state about the
    // document that is OPEN, so every value-drag fell back to pitch after one edit.
    const published: Array<{ topic: string; state: unknown }> = [];
    const backend = new GridBackend({
      publish: (topic, state) => published.push({ topic, state }),
      onEdit: vi.fn(),
      peaks: vi.fn(async () => ({ minMax: [], rms: [] })),
    });
    const lane = (i: number) =>
      ([...published].reverse().find((p) => p.topic === `gridRuntime/${i}`)!.state as {
        activeCellParameterName: string;
      }).activeCellParameterName;

    backend.load(doc(4), runtime(4), "S");
    backend.setActiveCellParameter(2, "pan");
    backend.load(doc(4), runtime(4), "S");
    expect(lane(2)).toBe("pan");

    backend.load(doc(4), runtime(4), "Other");
    expect(lane(2)).toBe("pitch");
  });

  it("a SCENE switch keeps the cursor — same document, same tracks", async () => {
    // The bindings reload on `scene` too, and scene projection changes only the
    // pattern-scoped fields; the tracks the cursor points at are the same tracks.
    reload("My Session");
    await link.command("gridEdit", { op: "selectTrack", trackIndex: 5 });
    reload("My Session"); // the same session, projected through scene C
    expect(link.gridBackend.selectedIndex).toBe(5);
  });
});
