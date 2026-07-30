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
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

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
const { useCompanion, idleDeck, gridRuntimeInfos } = await import("../store/companionEngine.ts");
const { GridRuntimeState } = await import("../../protocol/schema.ts");

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

/**
 * P3.5-E8g-a — THE ROW REPAINTS, WITHOUT A SUBSCRIPTION THE DOOR DOES NOT OWN.
 *
 * The user's E8g walk reached `<name> → track N` — the line `loadSample` sets
 * at companionEngine.ts:674, AFTER the document write — with the track row
 * still empty. So the load worked and the repaint did not.
 *
 * ⚠️ WHAT THESE PIN, EXACTLY. There is no jsdom here (the P6-2b house rule) and
 * no React renderer in this project's devDependencies, so **nothing below can
 * see a pixel**. What they see is the topic push the panel repaints FROM: a
 * `gridRuntime/<i>` carrying the sample's name and key is the last thing this
 * side of the wire can observe, and `GridPanel`'s subscription
 * (GridPanel.tsx:779) turns it into `tracksRef` + `bump` with no further
 * decision. "The row shows the sample" stays a REAL-HOST WALK claim, and the
 * gate line says so.
 *
 * THE HARNESS DELIBERATELY DOES NOT SIMULATE THE RELOAD EFFECT. Measured
 * 2026-07-30: with `useComposeBinding`'s session-keyed reload effect simulated,
 * the store→backend chain is correct end to end — `gridRuntime/0` receives
 * `name: "kick"`. So faking that effect here would have pinned a chain that was
 * never broken and stayed green through the user's defect. Not simulating it is
 * the honest reproduction of the state the walk found: the document written,
 * and nothing that reads it having been told. What is pinned is that the DOOR
 * no longer depends on that effect — the same shape `toggleLaunch` and
 * `toggleSolo` have always had (CompanionPanel:66/71, useComposeBinding:36/40).
 */
describe("P3.5-E8g-a · the grid is TOLD, by the door, that a sample landed", () => {
  /** Every `gridRuntime/<i>` push, parsed — what the panel would repaint from. */
  function watchRuntime(i: number) {
    const seen: { name: string; sampleKey: string | null }[] = [];
    link.onUiState(`gridRuntime/${i}`, (raw) => {
      const parsed = GridRuntimeState.safeParse(raw);
      // A payload the panel would reject is not a repaint — count only what it
      // would actually adopt (GridPanel.tsx:781 drops a failed parse).
      if (parsed.success) seen.push({ name: parsed.data.name, sampleKey: parsed.data.sampleKey });
    });
    return seen;
  }

  /** The grid as it stands after a session opens: rows loaded, no sample yet. */
  function gridAtOpen() {
    const s = deckSession()!;
    link.gridBackend.load(s.pattern as unknown as Record<string, unknown>, gridRuntimeInfos(DECK));
  }

  it("LOAD: the picked sample reaches the row's runtime topic", async () => {
    gridAtOpen();
    const seen = watchRuntime(0);
    registerSampleDoors(link, DECK, "compose");
    seen.length = 0; // only what the DOOR caused

    await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();

    expect(
      seen.at(-1),
      "the row the document now names must reach the topic the grid repaints from",
    ).toEqual({ name: "kick", sampleKey: "/samples/Imported/kick.wav" });
  });

  it("FILES double-click: the same door, the same push", async () => {
    // The conductor's contrast, pinned rather than argued: the library-path
    // handler and the LOAD button land through ONE `loadSample`, so a repaint
    // that only the picker triggers would be the E8a defect again — two callers
    // of one gesture and only one of them wired.
    disk.set("/samples/Imported/kick.wav", "");
    await useCompanion.getState().loadSample(0, "/samples/Imported/kick.wav", DECK);
    gridAtOpen();
    const seen = watchRuntime(0);
    registerSampleDoors(link, DECK, "compose");
    seen.length = 0;

    await link.command("fileBrowser", { op: "load", trackIndex: 0, path: "/samples/Imported/kick.wav" });
    await settle();

    expect(seen.at(-1)?.sampleKey, "a double-clicked library row must repaint too").toBe(
      "/samples/Imported/kick.wav",
    );
  });

  it("the peak paths move with it — a named row with no waveform is the same report, smaller", async () => {
    // `getSamplePeaks` resolves the row's file through the scoped peak-path map
    // (browserLink.ts:246), written ONLY by the reload effect until now. A
    // runtime push naming a sample that map has never heard of draws a row with
    // a name and no waveform.
    gridAtOpen();
    registerSampleDoors(link, DECK, "compose");
    await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();

    const peaks = (await link.command("getSamplePeaks", { trackIndex: 0, points: 64 })) as {
      sampleKey: string | null;
      minMax: number[];
    };
    expect(peaks.sampleKey).toBe("/samples/Imported/kick.wav");
    expect(peaks.minMax.length, "an empty envelope is a row that draws nothing").toBeGreaterThan(0);
  });

  /**
   * ⚠️ BOTH COMPOSE SURFACES, OR IT IS SHIPPED BROKEN IN ONE. The separate
   * compose WINDOW and the in-window `Composer` overlay share the FILES drawer
   * for exactly this reason (P3.5-E8b), and E8a's root cause was three
   * hand-written copies of a registration with a fourth surface quietly missing
   * it. The repaint above lives in `registerSampleDoors`, whose only compose
   * caller is `useComposeBinding` — so what has to hold is that neither surface
   * grows its own binding. Source-level, because there is no jsdom to mount
   * them in.
   */
  it.each([["ComposeWindow.tsx"], ["Composer.tsx"]])(
    "%s takes its doors from the SHARED binding, not a copy",
    (file) => {
      const src = readFileSync(resolve(here, "../plane", file), "utf8");
      expect(src).toContain("useComposeBinding(link, deck)");
      expect(src, "a surface registering its own doors is the E8a defect").not.toContain(
        "registerSampleDoors",
      );
    },
  );

  it("…and that binding is the one place compose registers them", () => {
    const src = readFileSync(resolve(here, "../plane/useComposeBinding.ts"), "utf8");
    expect(src).toContain("registerSampleDoors(browserLink, deck, 'compose')");
  });

  it("a load with NO session open does not wipe the names off the grid", async () => {
    // `gridRuntimeInfos` answers `[]` with no session, and `updateRuntime([])`
    // would republish every row under `runtimeState`'s `Track i+1` fallback —
    // a repaint fix that blanks the grid is worse than the defect.
    gridAtOpen();
    const seen = watchRuntime(0);
    registerSampleDoors(link, DECK, "compose");
    useCompanion.setState({ decks: Array.from({ length: 8 }, idleDeck) });
    seen.length = 0;

    await link.command("trackEdit", { op: "loadSample", trackIndex: 0 });
    await settle();

    expect(useCompanion.getState().error, "and it still says why").toContain("open (or create)");
    expect(seen, "nothing may be republished over a grid this store cannot describe").toEqual([]);
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
