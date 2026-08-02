import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * S4 — the FX returns. Studio had the SEND side (per-track sends, the deck's
 * master sends) and nothing saying what those sends fed, or how to put a plugin
 * there. Four faders into four unnamed destinations.
 */
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const CODE = read("src/studio/SendRack.tsx")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("SendRack — only what the shell answers", () => {
  it("Studio mounts it", () => {
    expect(read("src/studio/StudioPanel.tsx")).toContain("<SendRack");
  });

  it("uses the four LIVE commands and no refused ones", () => {
    for (const c of ["listPlugins", "selectFxPlugin", "getFxSlotState", "toggleEditor"])
      expect(CODE).toContain(c);
    // fxSlot's other ops still refuse by name ("arrives with P7-MIX-0"). A
    // pre/post or host-output control here would report success and change
    // nothing, which DESIGN.md §7 forbids and this session keeps finding.
    for (const refused of ["togglePostFader", "toggleHostOutput", "setHostOutput", "toggleMode"])
      expect(CODE).not.toContain(refused);
  });

  it("re-reads the ENGINE after a pick instead of assuming it took", () => {
    // selectFxPlugin can fail (bad identifier, hostless build). Trusting the
    // request would leave the rack naming a plugin that is not loaded.
    expect(CODE).toMatch(/selectFxPlugin[\s\S]{0,200}refresh\(\)/);
  });

  it("sends no `state` on a fresh pick", () => {
    // `state` is for RESTORING a remembered plugin; a fresh pick has nothing to
    // restore, and an empty blob asks the plugin to adopt something it never
    // wrote.
    expect(CODE).not.toMatch(/selectFxPlugin['"],\s*\{[^}]*state/);
  });

  it("EDIT only exists once something is loaded", () => {
    expect(CODE).toMatch(/idOf\(i\) !== null &&/);
  });

  it("says why when it cannot act (§6)", () => {
    expect(CODE).toContain("title={why ??");
    expect(CODE).toContain("no plugins found");
  });
});
