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
    expect(CODE).toMatch(/selectFxPlugin[\s\S]{0,300}readSlots\(\)/);
  });

  it("sends no `state` on a fresh pick", () => {
    // `state` is for RESTORING a remembered plugin; a fresh pick has nothing to
    // restore, and an empty blob asks the plugin to adopt something it never
    // wrote.
    expect(CODE).not.toMatch(/selectFxPlugin['"],\s*\{[^}]*state/);
  });



  it("HAS A RESCAN DOOR — nothing in this app scans at launch", () => {
    // The bug the first cut shipped: it called listPlugins and drew the result,
    // but rescanPlugins must be asked for and the app never scans at boot. With
    // no scan the list is empty and every picker sat disabled, so the rack
    // looked broken because the door it needed had not been drawn.
    expect(CODE).toContain("rescanPlugins");
    // And RESCAN stays live when the list is empty — gating it on having
    // plugins would be a deadlock, since it is how you get some.
    expect(CODE).toMatch(/disabled=\{scanning\}/);
  });

  it("polls while scanning, because there is no event lane", () => {
    // The shell's own comment: the poll IS the progress UI. A fire-and-forget
    // scan with no feedback looks identical to one that never started, and a
    // first sweep can take minutes.
    expect(CODE).toContain("setInterval");
    expect(CODE).toContain("scanning");
  });

  it("shows the plugin's NAME, not its format-encoded identifier", () => {
    // getFxSlotState answered identifier+state only, which is enough to
    // REMEMBER a plugin and not enough to SHOW one.
    expect(CODE).toContain("s?.name");
  });

  it("draws EDIT only where the plugin HAS an editor", () => {
    // Read from the engine (editorAvailable), so a plugin that opens no window
    // shows no button rather than a button that does nothing.
    expect(CODE).toContain("s?.editorAvailable &&");
    expect(CODE).toContain("editorVisible");
  });

  it("says why when it cannot act (§6)", () => {
    expect(CODE).toMatch(/why \?\?/);
    expect(CODE).toContain("no plugins yet");
  });
});
