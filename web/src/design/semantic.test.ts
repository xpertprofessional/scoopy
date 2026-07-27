import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOKENS,
  mergeTokens,
  resolveSemanticColor,
  type DesignTokens,
} from "./tokens.ts";

/**
 * The semantic (assignment) color system — DESIGN-SYSTEM.md §2b.
 *
 * Two properties carry the whole design and are what these tests pin:
 *
 *  1. THE OFF SWITCH RESTORES THE APP EXACTLY. Disabled → every family resolves
 *     to the chrome color it wore BEFORE this system existed (sends/decks had no
 *     color at all → --accent; the multi-routing sweep band was --signal; the
 *     mute-group member rings were --warn). Not "one arbitrary neutral" — the
 *     previous look, so the toggle is genuinely reversible.
 *
 *  2. SENDS AND MODS NEVER COLLIDE. They are the two families that share a track
 *     row, so the palettes are zoned (sends cool, mods warm) BY CONSTRUCTION. A
 *     future palette edit that breaks that is a design regression, not a taste
 *     change — hence a test.
 */

const withSemantic = (over: Partial<DesignTokens["semantic"]>): DesignTokens => ({
  ...DEFAULT_TOKENS,
  semantic: { ...DEFAULT_TOKENS.semantic, ...over },
});

describe("semantic color resolution", () => {
  it("returns the family palette entry when enabled", () => {
    const t = withSemantic({ enabled: true });
    expect(resolveSemanticColor(t, "send", 2)).toBe(t.semantic.send[2]);
    expect(resolveSemanticColor(t, "mod", 0)).toBe(t.semantic.mod[0]);
    expect(resolveSemanticColor(t, "deck", 1)).toBe(t.semantic.deck[1]);
    expect(resolveSemanticColor(t, "muteGroup")).toBe(t.semantic.muteGroup);
  });

  it("falls back to each family's PRE-SYSTEM chrome color when disabled", () => {
    const t = withSemantic({ enabled: false });
    // Sends and decks carried no color at all before — plain accent chrome.
    expect(resolveSemanticColor(t, "send", 0)).toBe(t.chrome.accent);
    expect(resolveSemanticColor(t, "deck", 2)).toBe(t.chrome.accent);
    // The sweep band's neutral (multi-routing) color was --signal.
    expect(resolveSemanticColor(t, "mod", 3)).toBe(t.chrome.signal);
    // Mute-group member rings were --warn (grid.css).
    expect(resolveSemanticColor(t, "muteGroup")).toBe(t.chrome.warn);
  });

  it("falls back rather than returning undefined for an out-of-range member", () => {
    // A 4th deck, a 5th send: the caller gets a usable color, never `undefined`
    // painted into a canvas fillStyle (which silently renders black).
    const t = withSemantic({ enabled: true });
    expect(resolveSemanticColor(t, "deck", 3)).toBe(t.chrome.accent);
    expect(resolveSemanticColor(t, "send", 9)).toBe(t.chrome.accent);
  });

  it("tracks a live palette edit (Appearance writes tokens, not constants)", () => {
    const t = withSemantic({ enabled: true, send: ["#111111", "#222222", "#333333", "#444444"] });
    expect(resolveSemanticColor(t, "send", 1)).toBe("#222222");
  });
});

describe("zoned palettes — sends and mods cannot be confused", () => {
  /** Crude hue extraction, enough to assert which ARC a color sits in. */
  const hue = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    if (d === 0) return 0;
    let h: number;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return ((h * 60) % 360 + 360) % 360;
  };

  it("every send is COOL (blue→violet) and every mod is WARM (gold→rose)", () => {
    // The two families share a track row (S1..S4 sit under the mod sweep bands),
    // so hue alone must say which family a tint belongs to.
    for (const c of DEFAULT_TOKENS.semantic.send) {
      const h = hue(c);
      expect(h, `send ${c} must sit in the cool arc`).toBeGreaterThan(180);
      expect(h, `send ${c} must sit in the cool arc`).toBeLessThan(310);
    }
    for (const c of DEFAULT_TOKENS.semantic.mod) {
      const h = hue(c);
      // Warm arc wraps through 0° (gold 45° → rose 330°), so it is the complement.
      expect(h < 90 || h > 310, `mod ${c} must sit in the warm arc`).toBe(true);
    }
  });

  it("no send shares a hue with any mod", () => {
    for (const s of DEFAULT_TOKENS.semantic.send) {
      for (const m of DEFAULT_TOKENS.semantic.mod) {
        const gap = Math.abs(hue(s) - hue(m));
        const circular = Math.min(gap, 360 - gap);
        expect(circular, `${s} (send) vs ${m} (mod) are too close`).toBeGreaterThan(30);
      }
    }
  });
});

describe("mergeTokens — a stored theme must not corrupt the palettes", () => {
  it("supplies the semantic defaults for a theme saved before the system existed", () => {
    const merged = mergeTokens({ chrome: { bg: "#000000" } });
    expect(merged.semantic).toEqual(DEFAULT_TOKENS.semantic);
    expect(merged.chrome.bg).toBe("#000000");
  });

  it("keeps a stored palette of the right length", () => {
    const send = ["#111111", "#222222", "#333333", "#444444"];
    expect(mergeTokens({ semantic: { send } }).semantic.send).toEqual(send);
  });

  it("rejects a WRONG-LENGTH palette whole, rather than leaving holes", () => {
    // A 2-entry send palette would leave S3/S4 resolving to the fallback color —
    // two sends wearing the accent, silently un-identified. Fall back entire.
    const merged = mergeTokens({ semantic: { send: ["#111111", "#222222"] } });
    expect(merged.semantic.send).toEqual(DEFAULT_TOKENS.semantic.send);
  });

  it("preserves the off switch and the strength across a save/load", () => {
    const merged = mergeTokens({ semantic: { enabled: false, strengthPct: 72 } });
    expect(merged.semantic.enabled).toBe(false);
    expect(merged.semantic.strengthPct).toBe(72);
  });
});
