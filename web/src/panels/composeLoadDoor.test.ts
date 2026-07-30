/**
 * P3.5-E8g — THE COMPOSE WINDOW'S LOAD DOOR, END TO END.
 *
 * MEASUREMENT HARNESS. E8a pinned that the LOAD button reaches a picker, and
 * its own comment said the rest "is the user's business":
 *
 *     "The picker never resolves here (nothing fires `onchange`), which is
 *      exactly right: the click IS the door opening, and the OS panel that
 *      follows is the user's business."
 *
 * That sentence is the hole this row fell through. Everything AFTER the pick —
 * import, path, decode, the document write — had no coverage at all, and the
 * user's report is precisely that half: "load opens the documentpicker but the
 * file never loads once executed, track stays empty".
 *
 * So this drives the WHOLE chain with only the host boundary faked, and it
 * fakes the boundary the MERGED host actually has: `nativeFilesActive()`, i.e.
 * every read/write routed to the shell's `slFiles` instead of OPFS
 * (`nativeFiles.ts` — "OPFS can be LISTED but not WRITTEN in the WKWebView").
 * The in-memory disk RECORDS every path, because the thing under suspicion is
 * whether the path written and the path read back are the same string.
 *
 * No jsdom (the P6-2b house rule).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── the fake host ──────────────────────────────────────────────────────────

/** Every path the chain wrote, in order — the measurement's real output. */
const written: string[] = [];
/** Every path the chain tried to read, in order. */
const read: string[] = [];
/** The in-memory native disk, keyed exactly as the shell keys it. */
const disk = new Map<string, string>();
/** The dirs `mkdirs` was asked for. */
const dirs: string[] = [];

/** The file the fake picker hands back, and whether it was ever asked for. */
let picked: File | null = null;
let pickerOpened = 0;

vi.stubGlobal("window", {});
vi.stubGlobal("requestAnimationFrame", () => 0);
vi.stubGlobal("cancelAnimationFrame", () => {});
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});
vi.stubGlobal("navigator", {
  storage: { getDirectory: () => Promise.reject(new Error("no OPFS on this host")) },
});
/**
 * The picker's DOM, modelled closely enough to observe the thing E8g is about:
 * WHETHER THE INPUT IS IN THE DOCUMENT WHEN IT IS CLICKED. A fake that ignores
 * `append` passes either way — which is how E8a's fake (a bare object with a
 * `click`) could not see the difference between this app's two file inputs.
 */
interface FakeInput {
  type?: string;
  accept?: string;
  style: Record<string, string>;
  files?: unknown[];
  /** The old door's registration style — served too, see `click`. */
  onchange?: () => void;
  listeners: Map<string, () => void>;
  addEventListener: (k: string, fn: () => void) => void;
  remove: () => void;
  click: () => void;
  /** Was it in `document.body` at the moment `click()` ran? */
  connectedAtClick: boolean | null;
  removed: boolean;
}
const inputs: FakeInput[] = [];
const body = new Set<FakeInput>();

vi.stubGlobal("document", {
  body: { append: (el: FakeInput) => void body.add(el) },
  createElement: () => {
    const el: FakeInput = {
      style: {},
      listeners: new Map(),
      connectedAtClick: null,
      removed: false,
      addEventListener: (k, fn) => void el.listeners.set(k, fn),
      remove: () => {
        body.delete(el);
        el.removed = true;
      },
      click: () => {
        pickerOpened++;
        el.connectedAtClick = body.has(el);
        // The OS panel comes back. Asynchronously, like the real one — the
        // whole point of this file is that everything after this line runs.
        setTimeout(() => {
          if (picked) {
            el.files = [picked];
            // BOTH registration styles are honoured on purpose. The old door
            // used the `onchange` PROPERTY and the new one uses
            // `addEventListener`; a fake that served only the new one would make
            // every pin below red against the old code for the wrong reason,
            // and the falsification would prove nothing. Measured 2026-07-30 in
            // real WebKit: a detached input DOES deliver its pick, so the old
            // door must still reach the track in this harness — and it does.
            el.listeners.get("change")?.();
            el.onchange?.();
          } else {
            el.listeners.get("cancel")?.();
          }
        }, 0);
      },
    };
    inputs.push(el);
    return el;
  },
});
vi.stubGlobal(
  "AudioContext",
  class {
    decodeAudioData() {
      return Promise.resolve({
        duration: 1,
        length: 48000,
        numberOfChannels: 1,
        sampleRate: 48000,
        getChannelData: () => new Float32Array(48000),
      });
    }
  },
);

const { setNativeFilesLinkForTest } = await import("../store/nativeFiles.ts");
const { BrowserLink } = await import("../browserLink.ts");
const { registerSampleDoors } = await import("./sampleDoors.ts");
const { useCompanion, idleDeck } = await import("../store/companionEngine.ts");

/** The shell's `slFiles` dispatch, in memory. */
const nativeLink = {
  command: async (method: string, p: Record<string, unknown>) => {
    if (method !== "slFiles") return {};
    const path = String(p.path ?? "");
    switch (p.action) {
      case "mkdirs":
        dirs.push(path);
        return { ok: true };
      case "write":
        written.push(path);
        disk.set(path, String(p.b64 ?? p.text ?? ""));
        return { ok: true };
      case "read": {
        read.push(path);
        const hit = disk.get(path);
        // The shell throws on a missing file; so must the fake, or a path
        // mismatch would silently look like an empty sample.
        if (hit === undefined) throw new Error(`no such file: ${path}`);
        return { b64: hit };
      }
      case "exists":
        return { exists: disk.has(path) };
      case "list":
        return { entries: [] };
      default:
        return { ok: true };
    }
  },
};

const DECK = 1; // a compose window on strip 2 — never deck 0, which would hide an axis bug

/** A one-track session, in the deck the compose window addresses. */
function seatSession() {
  const track = () => [{ sampleId: "", steps: [] as unknown[] }];
  const pattern: Record<string, unknown> = {};
  for (const s of ["A", "B", "C", "D", "E", "F", "G", "H"]) pattern[`section${s}`] = track();
  const decks = Array.from({ length: 8 }, idleDeck);
  decks[DECK] = {
    ...idleDeck(),
    session: {
      name: "demo",
      pattern: pattern as never,
      kit: { samples: [] } as never,
      extras: new Map(),
    },
  };
  useCompanion.setState({ decks, error: null, notice: null });
}

let link: InstanceType<typeof BrowserLink>;
beforeEach(() => {
  setNativeFilesLinkForTest(nativeLink as never);
  link = new BrowserLink();
  written.length = 0;
  read.length = 0;
  dirs.length = 0;
  disk.clear();
  inputs.length = 0;
  body.clear();
  pickerOpened = 0;
  picked = new File([new Uint8Array(64)], "kick.wav", { type: "audio/wav" });
  seatSession();
});

/** The door is fired with `void`; let its awaits drain. */
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
};

const deckSession = () => useCompanion.getState().decks[DECK]?.session;

describe("P3.5-E8g · LOAD in the compose window, from click to track", () => {
  it("opens the picker — E8a's half, still true", async () => {
    registerSampleDoors(link, DECK, "compose");
    await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();
    expect(pickerOpened).toBe(1);
  });

  it("THE ROW: the picked file reaches the track", async () => {
    registerSampleDoors(link, DECK, "compose");
    await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();

    // What the user sees: a sample on the row, or an empty row.
    const kit = (deckSession()?.kit as { samples: { filePath: string }[] } | undefined)?.samples;
    const row = (deckSession()?.pattern as Record<string, { sampleId: string }[]> | undefined)
      ?.sectionA?.[0];
    expect(
      { error: useCompanion.getState().error, kit: kit?.length, sampleId: row?.sampleId },
      "the track must carry the sample the user picked",
    ).toEqual({ error: null, kit: 1, sampleId: expect.any(String) });
    expect(row?.sampleId).not.toBe("");
  });

  it("THE SEAM: the path written and the path read back are the same string", async () => {
    registerSampleDoors(link, DECK, "compose");
    await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();
    // `importAudioFile` RETURNS a path it composes itself while `importFiles`
    // WRITES one it composes from `webkitRelativePath || name`. Two joins, one
    // file — the folder branch already shipped a doubling bug of exactly this
    // species (`/samples/Kicks909/Kicks909/kick.wav`, E8b).
    expect(read, "every read must land on a path that was written").toEqual(
      read.filter((p) => written.includes(p)),
    );
  });
});

describe("P3.5-E8g · the picker is the shape this host has actually delivered through", () => {
  /**
   * `fileBrowserBackend.pickViaInput` (E7's `folder…`) appends its input to the
   * document before clicking it; `pickAudioFile` did not. The user's walk proved
   * the appended one end-to-end in WizardMerged and reported the detached one
   * broken, on the same day. Measured 2026-07-30: headless WebKit fires `change`
   * on a detached input too, so this pin does NOT claim to be the cause — it
   * pins that the app stops having two implementations of one gesture where only
   * one has ever been exercised in the shipping host.
   */
  it("clicks an input that is IN the document, not a detached one", async () => {
    registerSampleDoors(link, DECK, "compose");
    await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.connectedAtClick, "a detached input is the E8g shape").toBe(true);
  });

  it("cleans the input up rather than leaving one per click in the body", async () => {
    registerSampleDoors(link, DECK, "compose");
    await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();
    expect(inputs[0]?.removed).toBe(true);
    expect(body.size).toBe(0);
  });

  it("a CANCELLED pick resolves instead of hanging forever, and is not an error", async () => {
    // It used to register only `change`, so cancelling left the promise pending
    // for the life of the window — identical, from outside, to a pick that
    // vanished. Both were silence, so neither could be reported.
    picked = null;
    registerSampleDoors(link, DECK, "compose");
    await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();
    expect(useCompanion.getState().error, "cancelling is a choice, not a failure").toBeNull();
    expect(useCompanion.getState().notice, "and it leaves no stale progress line").toBeNull();
  });
});

describe("P3.5-E8g · no outcome is silent", () => {
  /**
   * THE REPORTABILITY RULE. "Load opens the documentpicker but the file never
   * loads, track stays empty" is what FIVE different outcomes looked like from
   * outside, which is why one report could not name the seam. Each stage now
   * says where control is, so the next walk returns a seam instead of a shrug.
   */
  it("names the stage it is waiting on while the picker is open", async () => {
    // Hold the picker open: no change, no cancel — the real host's "I am in the
    // OS panel" state, and the state a hung pick is indistinguishable from
    // without this line.
    picked = new File([new Uint8Array(4)], "kick.wav");
    registerSampleDoors(link, DECK, "compose");
    const el = () => inputs[0];
    await link.command("trackEdit", { op: "loadSample", trackIndex: 3 });
    // Before the panel comes back, the store already says what it is doing.
    expect(useCompanion.getState().notice).toBe("choosing a sample for track 4…");
    expect(el()).toBeDefined();
    await settle();
  });

  it("reports a file the library refuses instead of dropping it", async () => {
    picked = new File([new Uint8Array(4)], "notes.txt", { type: "text/plain" });
    registerSampleDoors(link, DECK, "compose");
    await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();
    expect(useCompanion.getState().error, "a skipped import used to vanish").toContain("notes.txt");
    expect(useCompanion.getState().notice, "and the progress line must not stick").toBeNull();
  });

  it("ends a SUCCESSFUL load with the line that names the track", async () => {
    registerSampleDoors(link, DECK, "compose");
    await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();
    expect(useCompanion.getState().error).toBeNull();
    expect(useCompanion.getState().notice, "the success line `loadSample` always set").toBe(
      "kick → track 1",
    );
  });
});
