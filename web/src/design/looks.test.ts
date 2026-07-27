import { describe, expect, it } from "vitest";
import { DEFAULT_LOOK, SHIPPED_LOOKS, lookByName } from "./looks.ts";
import { DEFAULT_TOKENS, deriveChrome, mergeTokens, tokenVars } from "./tokens.ts";

/**
 * The four looks are the token system's own test.
 *
 * The claim Phase LOOK makes is that the system is now complete enough to express
 * four genuinely different identities as DATA — no component, stylesheet or
 * canvas call changed between them. If a look needed code, the system still has
 * a hole. So these tests check the SPAN: that the looks actually reach the far
 * ends of every axis (corners, polarity, material, optics, motion), because four
 * looks that all sit in the middle would prove nothing.
 */

describe("looks", () => {
  it("every look survives a round-trip through persistence", () => {
    // A look is stored as JSON under theme.tokens and comes back through
    // mergeTokens. If a group is missing from the merge, the look silently
    // reverts to defaults on the next launch — the exact failure that would
    // make "switch and compare" untrustworthy.
    for (const look of SHIPPED_LOOKS) {
      const round = mergeTokens(JSON.parse(JSON.stringify(look.tokens)));
      expect(round, look.name).toEqual(look.tokens);
    }
  });

  it("the default look IS the current app — switching to it changes nothing", () => {
    expect(lookByName(DEFAULT_LOOK)?.tokens).toEqual(DEFAULT_TOKENS);
  });

  it("spans every axis the token system exposes", () => {
    const t = (n: string) => lookByName(n)!.tokens;
    // corners: sharp → soft
    expect(t("INSTRUMENT").shape.radiusPx).toBe(0);
    expect(t("SOFTBOX").shape.radiusPx).toBeGreaterThan(4);
    // polarity: dark → light
    expect(t("BENCH").polarity).toBe("light");
    // material: void → grain
    expect(t("INSTRUMENT").surface.grainAlpha).toBe(0);
    expect(t("PHOSPHOR").surface.grainAlpha).toBeGreaterThan(0);
    // optics: occlude → add light
    expect(t("INSTRUMENT").waveform.blend).toBe("normal");
    expect(t("PHOSPHOR").waveform.blend).toBe("screen");
    // depth: flat → lifted
    expect(t("PHOSPHOR").elevation.ambientAlpha).toBe(0);
    expect(t("SOFTBOX").elevation.ambientAlpha).toBeGreaterThan(0.4);
    // motion: still → lively. At 0 every duration calc() resolves to 0ms, so
    // the app is instant with no rule anywhere testing whether motion is on.
    expect(t("DOCUMENT").motion.scale).toBe(0);
    expect(t("SOFTBOX").motion.scale).toBeGreaterThan(1);
    // colour: measurement → none at all. DOCUMENT is the only look that switches
    // an information channel OFF, which is the axis the master switch exists for.
    expect(t("INSTRUMENT").semantic.enabled).toBe(true);
    expect(t("DOCUMENT").semantic.enabled).toBe(false);
    // TYPE: a look that keeps the same typography isn't really a different look.
    // All four must disagree about the prose face.
    const faces = SHIPPED_LOOKS.map((l) => l.tokens.fontUI);
    expect(new Set(faces).size).toBe(SHIPPED_LOOKS.length);
  });

  it("the light look re-tunes what a dark ground cannot carry", () => {
    const bench = lookByName("BENCH")!.tokens;
    // Ink on paper reads heavier than light on black at the same alpha, so the
    // quiet field steps back as a family.
    expect(bench.surface.chromeInk).toBeLessThan(1);
    // The default spectrum's mid is a near-white cyan — invisible on a light
    // ground. The MEASUREMENT is unchanged; the ink drawing it has to darken.
    expect(bench.waveform.spectrum.mid).not.toBe(DEFAULT_TOKENS.waveform.spectrum.mid);
  });

  it("emits real vars for every look (no look can wedge applyTokens)", () => {
    for (const look of SHIPPED_LOOKS) {
      const vars = tokenVars(look.tokens);
      expect(vars["--bg"], look.name).toMatch(/^#[0-9a-f]{6}$/i);
      expect(vars["color-scheme"], look.name).toBe(look.tokens.polarity);
    }
  });
});

describe("derive mode", () => {
  it("reproduces the established greys from ground + ink", () => {
    // This is the claim that makes derive mode trustworthy: it is not a new
    // palette, it is the EXISTING palette expressed as what it always was — a
    // ground, an ink, and fixed steps between them. Within one 8-bit step.
    const d = deriveChrome(
      { enabled: true, ground: "#141414", ink: "#d8d8d8", accent: "#bfbfbf" },
      DEFAULT_TOKENS.chrome,
    );
    const near = (got: string, want: string) => {
      const v = (h: string) => parseInt(h.slice(1, 3), 16);
      expect(Math.abs(v(got) - v(want)), `${got} vs ${want}`).toBeLessThanOrEqual(1);
    };
    near(d.bgRaised, "#1e1e1e");
    near(d.line, "#2e2e2e");
    near(d.textDim, "#7f7f7f");
    expect(d.bg).toBe("#141414");
    expect(d.text).toBe("#d8d8d8");
  });

  it("needs no branch for polarity — every step mixes ground TOWARD ink", () => {
    const lum = (h: string) => parseInt(h.slice(1, 3), 16);
    const dark = deriveChrome(
      { enabled: true, ground: "#141414", ink: "#d8d8d8", accent: "#bfbfbf" },
      DEFAULT_TOKENS.chrome,
    );
    const light = deriveChrome(
      { enabled: true, ground: "#e6e8ea", ink: "#1b1e21", accent: "#3d444b" },
      DEFAULT_TOKENS.chrome,
    );
    // "Raised" is LIGHTER than the ground on black…
    expect(lum(dark.bgRaised)).toBeGreaterThan(lum(dark.bg));
    // …and DARKER than the ground on paper. Same formula, no conditional.
    expect(lum(light.bgRaised)).toBeLessThan(lum(light.bg));
  });

  it("never derives the state colours", () => {
    // Clipping has to shout on any ground. Picking a background is not allowed
    // to decide what "recording" looks like.
    const d = deriveChrome(
      { enabled: true, ground: "#e6e8ea", ink: "#1b1e21", accent: "#3d444b" },
      DEFAULT_TOKENS.chrome,
    );
    expect(d.signal).toBe(DEFAULT_TOKENS.chrome.signal);
    expect(d.warn).toBe(DEFAULT_TOKENS.chrome.warn);
    expect(d.hot).toBe(DEFAULT_TOKENS.chrome.hot);
  });

  it("disabled → the nine swatches pass through untouched", () => {
    const d = deriveChrome(
      { enabled: false, ground: "#ff0000", ink: "#00ff00", accent: "#0000ff" },
      DEFAULT_TOKENS.chrome,
    );
    expect(d).toEqual(DEFAULT_TOKENS.chrome);
  });
});
