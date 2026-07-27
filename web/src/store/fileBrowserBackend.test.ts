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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("errors", () => {
  it("reports an unreadable directory in `error` rather than throwing into the panel", async () => {
    await backend.handle({ op: "navigate", path: "/samples/does-not-exist" });
    expect(backend.state().error).toBeTruthy();
    expect(backend.state().entries).toEqual([]);
  });
});
