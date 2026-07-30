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
  clicked: boolean;
  click: () => void;
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
  createElement: () => {
    // The picker never resolves here (nothing fires `onchange`), which is
    // exactly right: the click IS the door opening, and the OS panel that
    // follows is the user's business.
    const el: FakeInput = { clicked: false, click: () => (el.clicked = true) };
    created.push(el);
    return el;
  },
});

const { BrowserLink } = await import("../browserLink.ts");
const { registerSampleDoors } = await import("./sampleDoors.ts");
const { useCompanion } = await import("../store/companionEngine.ts");

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
