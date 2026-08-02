import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * S2 — every session-editing face owes ⌘S and the teardown flush, and owes them
 * THROUGH THE HOOK.
 *
 * A source-text test, in the house idiom `panels/uiOwnership.test.ts` already
 * uses, and for the reason that makes that idiom necessary here: this project
 * has no jsdom and no React renderer (P3.5-E8g-f), so nothing can mount these
 * faces and press a key. What CAN be checked mechanically is that no face has
 * grown its own copy again — which is the failure that actually happened.
 *
 * IT IS A REGRESSION TEST, not a style rule. The four faces below each had a
 * hand-written pair, and they had already drifted: `CompanionPanel` listened for
 * `pagehide` ALONE and had no ⌘S at all, so D-SL-SAVE-01's "one meaning on every
 * surface" was false on the host where it costs most — `visibilitychange` is the
 * event a backgrounded mobile tab fires, and `pagehide` is the one it may not.
 * Nothing caught that for as long as the copies existed.
 */

const FACES = [
  "src/studio/StudioPanel.tsx",
  "src/plane/ComposeWindow.tsx",
  "src/plane/PluginDeckPanel.tsx",
  "src/panels/CompanionPanel.tsx",
] as const;

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

describe("useComposeLifecycle — one owner for ⌘S and the teardown flush", () => {
  it.each(FACES)("%s calls the hook", (face) => {
    expect(read(face)).toContain("useComposeLifecycle(");
  });

  it.each(FACES)("%s does not hand-roll the teardown flush", (face) => {
    const src = read(face);
    // The hook owns these listeners. A face registering its own is the drift
    // this exists to stop — and the half-copy is the dangerous shape, because
    // it looks present while covering one of the two ways a surface goes away.
    expect(src).not.toMatch(/addEventListener\(\s*["']pagehide["']/);
    expect(src).not.toMatch(/addEventListener\(\s*["']visibilitychange["']/);
  });

  it.each(FACES)("%s does not hand-roll ⌘S", (face) => {
    const src = read(face);
    // `e.key !== "s"` guarded by a meta/ctrl test is the shape every copy had.
    expect(src).not.toMatch(/key\s*!==\s*['"]s['"]/);
  });

  it("the hook registers BOTH teardown events, not just pagehide", () => {
    // The specific defect CompanionPanel carried. If someone ever trims this
    // back to one listener, every face loses the half that fires on mobile.
    const hook = read("src/plane/useComposeLifecycle.ts");
    expect(hook).toMatch(/addEventListener\(\s*['"]pagehide['"]/);
    expect(hook).toMatch(/addEventListener\(\s*['"]visibilitychange['"]/);
    // …and removes both, or a remounting face leaks a flush per mount.
    expect(hook).toMatch(/removeEventListener\(\s*['"]pagehide['"]/);
    expect(hook).toMatch(/removeEventListener\(\s*['"]visibilitychange['"]/);
  });

  it("⇧⌘S is left alone — it is the MAP's, and a compose face has no map", () => {
    expect(read("src/plane/useComposeLifecycle.ts")).toContain("e.shiftKey");
  });
});
