/**
 * P8-6 — the file browser, served from OPFS.
 *
 * The claim under test is the migration's oldest one, written into the schema two phases before
 * anything could act on it (schema.ts:704-707): *"the browser target swaps this for OPFS — so the
 * listing is a pushed topic from day one, never a web-side `fs` call."* If that was right, then a
 * backend that publishes the same `FileBrowserState` and answers the same ten ops is a drop-in, and
 * `FileBrowserPanel.tsx` needs no edit at all. These tests hold the backend to the panel's contract;
 * `browser_opfs_test.mjs` then puts the real panel on top of it in real Chrome.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileBrowserState } from "../../protocol/schema.ts";
import { FileBrowserState as FileBrowserStateSchema } from "../../protocol/schema.ts";

import { FileBrowserBackend, type BrowserSettings } from "./fileBrowserBackend.ts";
import { SampleStore } from "./sampleStore.ts";
import { installFakeOpfs } from "./opfsFake.ts";
import * as opfs from "./opfs.ts";

class MemorySettings implements BrowserSettings {
  private map = new Map<string, unknown>();
  get(key: string): unknown {
    return this.map.get(key) ?? null;
  }
  set(key: string, value: unknown): void {
    this.map.set(key, value);
  }
}

let reset: () => void;
let published: FileBrowserState[];
let backend: FileBrowserBackend;
let settings: MemorySettings;

async function seedLibrary(): Promise<void> {
  await opfs.ensureDir("/samples/Kicks");
  await opfs.writeFile("/samples/Kicks/808.wav", new Uint8Array([1]));
  // ⚠️ `alpha` is written BEFORE `beta` on purpose, so the two orders DISAGREE: by name it is
  // alpha→beta, by date (newest first) it is beta→alpha. Seeded the other way round the two
  // coincide and the sort test passes without testing anything — which is how it was first written.
  await opfs.writeFile("/samples/alpha.wav", new Uint8Array([2])); // older
  await opfs.writeFile("/samples/beta.wav", new Uint8Array([3])); // newer
  await opfs.writeFile("/samples/readme.txt", new Uint8Array([4])); // not audio
}

beforeEach(async () => {
  reset = installFakeOpfs();
  published = [];
  settings = new MemorySettings();
  backend = new FileBrowserBackend(new SampleStore(), settings, (s) => published.push(s));
  await seedLibrary();
  await backend.init();
});
afterEach(() => reset());

describe("the state the panel receives", () => {
  it("satisfies the FileBrowserState schema the panel parses", () => {
    // The panel does `FileBrowserState.safeParse(raw)` and IGNORES anything that fails — so a state
    // that is subtly off-schema does not throw, it just renders an eternally empty browser.
    expect(FileBrowserStateSchema.safeParse(backend.state()).success).toBe(true);
  });

  it("lists directories first, then audio, and HIDES non-audio", () => {
    const names = backend.state().entries.map((e) => e.name);
    expect(names).toEqual(["Kicks", "alpha.wav", "beta.wav"]);
    expect(names).not.toContain("readme.txt");
  });

  it("has a root — so the panel's 'no folder' empty state never shows in the companion", () => {
    // The library always exists. An empty one says "empty folder", which is the truth; "no folder"
    // would be a lie about a filesystem the user cannot choose anyway.
    expect(backend.state().root).toBe("/samples");
  });
});

describe("sort", () => {
  it("orders by name, then by date, on the same listing", async () => {
    const files = () =>
      backend.state().entries.filter((e) => !e.isDirectory).map((e) => e.name);

    expect(files()).toEqual(["alpha.wav", "beta.wav"]);

    await backend.handle({ op: "setSort", value: "date" });
    expect(files()).toEqual(["beta.wav", "alpha.wav"]); // newest first — the opposite order
  });

  it("persists to the SAME setting key the native browser and General panel share", async () => {
    await backend.handle({ op: "setSort", value: "date" });
    expect(settings.get("fileBrowserSortOption")).toBe("date");
  });
});

describe("navigation", () => {
  it("navigates into a folder and back up, with crumbs tracking", async () => {
    await backend.handle({ op: "navigate", path: "/samples/Kicks" });
    expect(backend.state().cwd).toBe("/samples/Kicks");
    expect(backend.state().entries.map((e) => e.name)).toEqual(["808.wav"]);
    expect(backend.state().crumbs.map((c) => c.name)).toEqual(["Library", "Kicks"]);

    await backend.handle({ op: "up" });
    expect(backend.state().cwd).toBe("/samples");
    expect(backend.state().crumbs.map((c) => c.name)).toEqual(["Library"]);
  });

  it("refuses to walk above the library root", async () => {
    await backend.handle({ op: "up" });
    await backend.handle({ op: "up" });
    expect(backend.state().cwd).toBe("/samples");
  });

  it("publishes on every navigation — the panel is push-driven, not polled", async () => {
    const before = published.length;
    await backend.handle({ op: "navigate", path: "/samples/Kicks" });
    expect(published.length).toBeGreaterThan(before);
  });

  it("drops a selection that navigating away invalidated", async () => {
    await backend.handle({ op: "select", path: "/samples/alpha.wav" });
    expect(backend.state().selected).toBe("/samples/alpha.wav");

    await backend.handle({ op: "navigate", path: "/samples/Kicks" });
    // Otherwise the footer would draw a waveform for a file that is not in the list.
    expect(backend.state().selected).toBeNull();
  });
});

describe("load — the honest boundary", () => {
  it("says WHY it cannot load, instead of no-op'ing", async () => {
    const { notice } = await backend.handle({ op: "load", path: "/samples/alpha.wav" });
    // A silent no-op is indistinguishable from a dead wire. The panel shows this as a toast.
    expect(notice).toMatch(/FLIP/);
  });
});

/**
 * P3.5-E8b — THE FOLDER DOOR, which is the whole point of giving the browser a home: E8a made LOAD
 * pick ONE file; this is the gesture that brings a folder of samples in.
 *
 * No jsdom here (P6-2b's house rule), so `document` is stubbed to the minimum an `<input
 * webkitdirectory>` touches — and what is observed is the two things that can be wrong without
 * anything going red: WHEN the picker is clicked, and WHERE the bytes land.
 */
describe("chooseFolder — the folder door", () => {
  interface FakeInput {
    style: Record<string, string>;
    files: File[] | null;
    clicked: boolean;
    click(): void;
    remove(): void;
    addEventListener(type: string, fn: () => void): void;
    fire(type: string): void;
  }
  let created: FakeInput[] = [];

  /** A file as a directory picker hands it over: named by its path INSIDE the picked folder. */
  const picked = (relativePath: string): File => {
    const file = new File([new Uint8Array([1, 2, 3])], relativePath.split("/").pop()!);
    Object.defineProperty(file, "webkitRelativePath", {
      value: relativePath,
      configurable: true,
    });
    return file;
  };

  beforeEach(() => {
    created = [];
    vi.stubGlobal("document", {
      createElement: () => {
        const listeners = new Map<string, () => void>();
        const el: FakeInput = {
          style: {},
          files: null,
          clicked: false,
          click: () => {
            el.clicked = true;
          },
          remove: () => {},
          addEventListener: (type, fn) => void listeners.set(type, fn),
          fire: (type) => listeners.get(type)?.(),
        };
        created.push(el);
        return el;
      },
      body: { append: () => {} },
    });
    // No `showDirectoryPicker` — i.e. WebKit, the engine the app ships (H4).
    vi.stubGlobal("window", {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("clicks the picker in the SAME TASK as the gesture — the transient activation E8a lost", () => {
    // ⚠️ NOT AWAITED, deliberately. A picker demands transient activation, and P3.5-E8a measured
    // what an `await` before it costs: in Chromium `showOpenFilePicker` produced no picker and no
    // error, which is a dead button. The whole chain from the panel's onClick down to `input.click()`
    // is synchronous today; this pin fails the moment anyone puts an await on it.
    const pending = backend.handle({ op: "chooseFolder" });
    expect(created).toHaveLength(1);
    expect(created[0]!.clicked).toBe(true);
    created[0]!.fire("cancel");
    return pending;
  });

  it("treats a cancelled picker as a choice, not a failure", async () => {
    const pending = backend.handle({ op: "chooseFolder" });
    created[0]!.fire("cancel");
    expect(await pending).toEqual({ notice: null });
    expect(backend.state().cwd).toBe("/samples");
  });

  it("lands the folder's samples UNDER it, not nested inside a twin of itself", async () => {
    // ⚠️ THE BRANCHES DISAGREED. `collectFiles` (the File System Access walk) starts at the picked
    // folder, so its paths are relative to it; an `<input webkitdirectory>` includes the root
    // segment. `importFiles` joins whatever it gets onto `/samples/<picked name>`, so the INPUT
    // branch — the only one WebKit can reach — wrote `/samples/Kicks909/Kicks909/kick.wav` and then
    // navigated to `/samples/Kicks909`, which showed one folder and no samples.
    const pending = backend.handle({ op: "chooseFolder" });
    const input = created[0]!;
    input.files = [
      picked("Kicks909/kick.wav"),
      picked("Kicks909/hats/closed.wav"),
      picked("Kicks909/notes.txt"),
    ];
    input.fire("change");

    expect(await pending).toEqual({ notice: "imported 2 samples, 1 skipped" });
    expect(backend.state().cwd).toBe("/samples/Kicks909");
    // Directories first, then audio — and NOT a directory called Kicks909.
    expect(backend.state().entries.map((e) => e.name)).toEqual(["hats", "kick.wav"]);
    expect(await opfs.exists("/samples/Kicks909/kick.wav")).toBe(true);
    // The shape BELOW the root is kept: a drum folder stays a drum folder.
    expect(await opfs.exists("/samples/Kicks909/hats/closed.wav")).toBe(true);
  });

  it("says so when the folder held no audio, rather than navigating nowhere", async () => {
    // The pre-fix reading navigated into a directory `importFiles` never created, so the toast said
    // "imported 0 samples" while the list said "cannot read /samples/Docs".
    const pending = backend.handle({ op: "chooseFolder" });
    const input = created[0]!;
    input.files = [picked("Docs/readme.txt")];
    input.fire("change");
    expect(await pending).toEqual({ notice: "no audio in that folder (1 skipped)" });
    expect(backend.state().cwd).toBe("/samples");
    expect(backend.state().error).toBeNull();
  });
});

describe("errors", () => {
  it("reports an unreadable directory in `error` rather than throwing into the panel", async () => {
    await backend.handle({ op: "navigate", path: "/samples/does-not-exist" });
    expect(backend.state().error).toBeTruthy();
    expect(backend.state().entries).toEqual([]);
  });
});
