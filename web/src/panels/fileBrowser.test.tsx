import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMANDS, FileBrowserState, HotFrameLayout } from "../../protocol/schema.ts";
import { BrowserShell, BrowserRow } from "../design/BrowserShell.tsx";
import {
  FileBrowserPanel,
  SAMPLE_DRAG_MIME,
  writeSampleDrag,
  hasSampleDrag,
  readSampleDrag,
} from "./FileBrowserPanel.tsx";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), "utf8");

describe("BrowserShell — the chrome both browsers share (BR-4)", () => {
  it("collapses to a rail, and the rail is what re-opens it", () => {
    const html = renderToStaticMarkup(
      <BrowserShell title="FILES" expanded={false} onExpandedChange={() => {}}>
        <li>never rendered while collapsed</li>
      </BrowserShell>,
    );
    expect(html).toContain("br-rail");
    expect(html).toContain("FILES");
    // The body must not mount when folded — a collapsed rail that still renders
    // its list is paying for a surface nobody can see.
    expect(html).not.toContain("never rendered while collapsed");
  });

  it("expanded, it renders header · banner · body · footer slots", () => {
    const html = renderToStaticMarkup(
      <BrowserShell
        title="FILES"
        expanded
        onExpandedChange={() => {}}
        actions={<button>ACT</button>}
        banner={<p>BANNER</p>}
        footer={<div>FOOT</div>}
      >
        <li>BODY</li>
      </BrowserShell>,
    );
    for (const slot of ["ACT", "BANNER", "BODY", "FOOT"]) expect(html).toContain(slot);
    expect(html).toContain("br-head");
    expect(html).toContain("br-foot");
  });

  it("a row carries its icon, name and trailing slot", () => {
    const html = renderToStaticMarkup(
      <ul>
        <BrowserRow name="909_kick.wav" icon="~" selected trailing={<button>A</button>} />
      </ul>,
    );
    expect(html).toContain("909_kick.wav");
    expect(html).toContain("br-row sel");
  });
});

describe("FileBrowserPanel", () => {
  it("with no link it renders the rail rather than crashing", () => {
    const html = renderToStaticMarkup(<FileBrowserPanel link={null} />);
    expect(html).toContain("FILES");
  });
});

/**
 * The DJ session browser was restyled onto the shared shell in BR-5. Natively
 * these two browsers are ONE view behind a `BrowserMode` enum, so the whole
 * point of the shell is that they cannot drift into two hand-styled rails
 * again. This pins that: no private `.dj-browser-*` chrome may come back.
 */
describe("BR-5 — one browser shell, not two", () => {
  // REPOINTED (B1-RETIRE). The DJ session browser was the second browser this
  // rule existed to keep on the shared shell; `DjPanel` is deleted, so there is
  // now exactly ONE browser — which is the rule's goal reached rather than the
  // rule becoming moot. What is still worth guarding is that the survivor uses
  // the shell, and that the private chrome stays gone from the stylesheet.
  it("the surviving browser renders through BrowserShell", () => {
    const src = read("./FileBrowserPanel.tsx");
    expect(src).toContain("BrowserShell");
    expect(src).toContain("BrowserRow");
  });

  it("the old dj-browser chrome is gone from the stylesheet", () => {
    // `djmode.css` outlives DjPanel: it styles `.track-strips.density-dj`, the
    // rows the deck TILE mounts, and its import moved to `plane/deckTile.tsx`.
    expect(read("./djmode.css")).not.toContain(".dj-browser");
  });
});

/**
 * The load INTENT (browser.md §2). Swift keeps ONE loader — these are the
 * fields that decide which of its two entry points runs, so a change to them
 * silently reroutes every load in the app.
 */
describe("fileBrowser/load is an intent, not a load", () => {
  it("omitting trackIndex is what means NEW TRACK", () => {
    const newTrack = COMMANDS.fileBrowser.params.parse({
      op: "load",
      path: "/s/kick.wav",
      asStretch: false,
    });
    expect(newTrack.trackIndex).toBeUndefined();

    const ontoRow = COMMANDS.fileBrowser.params.parse({
      op: "load",
      path: "/s/kick.wav",
      trackIndex: 3,
      asStretch: true,
    });
    expect(ontoRow.trackIndex).toBe(3);
    expect(ontoRow.asStretch).toBe(true);
  });

  it("⌥-stretch travels as an explicit field, not an NSEvent read", () => {
    // The web owns the keyboard event now — if this field ever goes away, ⌥
    // silently stops meaning "load as stretch" on both load paths.
    expect(
      COMMANDS.fileBrowser.params.parse({ op: "load", path: "/a.wav" }).asStretch,
    ).toBeUndefined();
    const shape = COMMANDS.fileBrowser.params.parse({
      op: "load",
      path: "/a.wav",
      asStretch: true,
    });
    expect(shape.asStretch).toBe(true);
  });

  it("rejects an op the Swift binding has no case for", () => {
    expect(COMMANDS.fileBrowser.params.safeParse({ op: "delete" }).success).toBe(false);
  });
});

describe("fileBrowser topic", () => {
  it("parses a folder with a selection", () => {
    const parsed = FileBrowserState.safeParse({
      root: "/Samples",
      cwd: "/Samples/Drums",
      crumbs: [
        { path: "/Samples", name: "Samples" },
        { path: "/Samples/Drums", name: "Drums" },
      ],
      entries: [
        { path: "/Samples/Drums/909", name: "909", isDirectory: true, sizeBytes: 0, modifiedMs: 1 },
        {
          path: "/Samples/Drums/kick.wav",
          name: "kick.wav",
          isDirectory: false,
          sizeBytes: 1024,
          modifiedMs: 2,
        },
      ],
      selected: "/Samples/Drums/kick.wav",
      sort: "name",
      autoPlay: true,
      previewPlaying: false,
      folded: false,
      error: null,
    });
    expect(parsed.success).toBe(true);
  });

  /**
   * The fold is SHARED state, and it has to be. The compose browser is its own
   * WKWebView whose FRAME SwiftUI sizes; the page draws the collapsed rail at
   * 22px. If the web kept the fold to itself, collapsing would leave a ~258px
   * transparent webview sitting over the grid and eating every click in it.
   * (The DJ browser's fold IS view-local — it folds inside a full-page webview,
   * so nothing outside it needs to know. Don't "fix" one to match the other.)
   */
  it("the fold is on the topic, and setFolded is the door back", () => {
    expect(FileBrowserState.shape.folded).toBeDefined();
    expect(COMMANDS.fileBrowser.params.safeParse({ op: "setFolded", value: "on" }).success).toBe(
      true,
    );
    expect(read("./FileBrowserPanel.tsx")).toContain('browse("setFolded"');
  });

  it("nullable fields must be present as explicit null (the P5-01c trap)", () => {
    // Swift's synthesized Codable OMITS nil keys, which fails safeParse
    // silently — the generated struct carries a custom encode for exactly this.
    // If `root` were `.optional()` instead of `.nullable()`, an unchosen folder
    // would render as a blank panel with no error.
    expect(FileBrowserState.safeParse({ crumbs: [], entries: [] }).success).toBe(false);
  });
});

describe("preview meter rides the HotFrame, not a UiState push", () => {
  it("has its own scalar slots", () => {
    expect(typeof HotFrameLayout.previewLevel).toBe("number");
    expect(typeof HotFrameLayout.previewProgress).toBe("number");
    expect(HotFrameLayout.previewLevel).not.toBe(HotFrameLayout.previewProgress);
  });
});

// A tiny DataTransfer stand-in — jsdom has no drag payload store of its own.
function fakeDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    setData: (type: string, val: string) => store.set(type, val),
    getData: (type: string) => store.get(type) ?? "",
    get types() {
      return [...store.keys()];
    },
    effectAllowed: "none",
    dropEffect: "none",
  } as unknown as DataTransfer;
}

describe("drag-to-row (BR-4)", () => {
  it("the grid reads the sample drag through the shared helpers", () => {
    // One contract, two files — a drift here means dragging silently does
    // nothing, with no error anywhere.
    expect(SAMPLE_DRAG_MIME).toBe("application/x-scoopy-sample");
    const grid = read("./GridPanel.tsx");
    expect(grid).toContain("hasSampleDrag");
    expect(grid).toContain("readSampleDrag");
  });

  it("carries the path across the WKWebView boundary via text/plain", () => {
    // The custom MIME does NOT cross between the browser and grid webviews, so
    // the drag MUST also ride text/plain or the drop is dead cross-webview.
    const dt = fakeDataTransfer();
    writeSampleDrag(dt, "/kits/clap.wav");
    expect(dt.types).toContain("text/plain");
    expect(dt.types).toContain(SAMPLE_DRAG_MIME);

    // A destination webview that only sees text/plain still recovers the path.
    const crossed = fakeDataTransfer();
    crossed.setData("text/plain", dt.getData("text/plain"));
    expect(hasSampleDrag(crossed)).toBe(true);
    expect(readSampleDrag(crossed)).toBe("/kits/clap.wav");
  });

  it("ignores a stray text drop that is not one of our drags", () => {
    const dt = fakeDataTransfer();
    dt.setData("text/plain", "just some dragged words");
    // hasSampleDrag lets the hover through (data is unreadable then), but the
    // untagged drop resolves to no path, so nothing loads.
    expect(readSampleDrag(dt)).toBe("");
  });

  it("a MIDI row refuses the drag instead of accepting and failing", () => {
    const src = read("./GridPanel.tsx");
    // Both the hover AND the drop must check — accepting a drop the loader will
    // reject would light the row up and then do nothing.
    const dragOver = src.slice(src.indexOf("onDragOver"), src.indexOf("onDragLeave"));
    const onDrop = src.slice(src.indexOf("onDrop={"), src.indexOf("onDropSample(i"));
    expect(dragOver).toContain('t.trackType !== "audio"');
    expect(onDrop).toContain('t.trackType !== "audio"');
  });
});
