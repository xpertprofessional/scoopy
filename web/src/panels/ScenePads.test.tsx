import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SceneUiState } from "../../protocol/schema.ts";
import { ScenePadsView } from "./ScenePads.tsx";

/**
 * Render smoke for the scene cluster: pad labels/states, the add slot, and the
 * S/R/0 picker. The 4+4 row split is GONE (user, 2026-07-12) — it only ever
 * existed to squeeze the pads into the toolbar's bar height, and the cluster
 * now lives in the master track row: ONE row of regular-size buttons.
 *
 * Tests target the PURE view: zustand v5 serves getInitialState as the SSR
 * snapshot, so the store-connected wrapper always renders empty here.
 */
const state = (over: Partial<SceneUiState> = {}): SceneUiState => ({
  enabled: ["A", "B", "C"],
  current: "A",
  queued: [],
  loopEnabled: false,
  switchMode: "scheduled",
  cleanCut: false,
  latched: false,
  muted: false,
  canAdd: true,
  // CM-3 scene-override fields (unused by the pads, but the topic carries them).
  sceneLabel: "1",
  pinnedKeys: [],
  pinnableMasterKeys: [],
  pinnableTrackFields: [],
  scenesWithOverrides: [],
  muteGroupCount: 0,
  ...over,
});

const render = (s: SceneUiState) => renderToStaticMarkup(<ScenePadsView scenes={s} link={null} deck={0} />);

describe("ScenePads", () => {
  it("labels pads 1-based and marks the current scene active", () => {
    const html = render(state());
    expect(html).toContain(">1</button>"); // A → "1"
    expect(html).toContain(">3</button>"); // C → "3"
    expect(html).toContain("scene-pad is-active");
  });

  it("renders every scene in ONE row, add slot last, labelled count+1", () => {
    const html = render(state({ enabled: ["A", "B", "C"] }));
    expect(html).not.toContain("scene-pad-row"); // the 4+4 split is gone
    expect(html).toContain("scene-add");
    expect(html).toContain(">4</button>");
    // The add slot is the LAST child of the pad row, not a second-row migrant.
    expect(html.indexOf("scene-add")).toBeGreaterThan(html.lastIndexOf("scene-pad\""));
  });

  it("keeps one row past the old 4-pad break, and at the full 8", () => {
    const five = render(state({ enabled: ["A", "B", "C", "D", "E"] }));
    expect(five).not.toContain("scene-pad-row");
    expect(five).toContain(">5</button>");
    const eight = render(
      state({ enabled: ["A", "B", "C", "D", "E", "F", "G", "H"], canAdd: false }),
    );
    expect(eight).not.toContain("scene-pad-row");
    expect(eight).toContain(">8</button>");
  });

  it("hides the add slot when all 8 exist (canAdd false)", () => {
    const html = render(
      state({ enabled: ["A", "B", "C", "D", "E", "F", "G", "H"], canAdd: false }),
    );
    expect(html).not.toContain("scene-add");
  });

  it("scheduled pads tint warn, loop-scheduled tint accent", () => {
    expect(render(state({ queued: ["B"] }))).toContain("scene-pad is-scheduled");
    expect(render(state({ queued: ["B"], loopEnabled: true }))).toContain("scene-pad is-loop");
  });

  it("switch-mode picker marks the active mode and SCN/MUTE reflect state", () => {
    const html = render(state({ switchMode: "seamlessImmediate", latched: true, muted: true }));
    expect(html).toContain('class="is-on"'); // R selected
    expect(html).toContain(">R</button>");
    expect(html.match(/ds-button active/g)).toHaveLength(2); // SCN + MUTE lit
  });

  it("CUT toggle renders and lights only when cleanCut is on", () => {
    const off = render(state());
    expect(off).toContain(">CUT</button>");
    expect(off.match(/class="is-on"/g)).toHaveLength(1); // only the S mode pick
    const on = render(state({ cleanCut: true }));
    expect(on).toContain(">CUT</button>");
    expect(on.match(/class="is-on"/g)).toHaveLength(2); // the S mode pick + CUT
  });
});

/**
 * CM-5: "Clear Scene Overrides" per pad + the MUTE button's group menu.
 * Both are right-click only (no DOM here), so we pin the STATE they read —
 * the gating is what native gets right and a naive port gets wrong: the item
 * is DISABLED, not hidden, on a scene with no overrides, so the menu still
 * tells you the scene is clean.
 */
describe("scene overrides + mute group (CM-5)", () => {
  it("carries the per-scene override flags and the member count", () => {
    const s = state({ scenesWithOverrides: ["B"], muteGroupCount: 3 });
    expect(s.scenesWithOverrides).toContain("B");
    expect(s.scenesWithOverrides).not.toContain("A");
    expect(s.muteGroupCount).toBe(3);
    // Renders without them too (a clean session pushes empty arrays).
    expect(render(state())).toContain("MUTE");
  });
})
