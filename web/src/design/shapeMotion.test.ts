import { describe, expect, it } from "vitest";
import {
  currentTokens,
  DEFAULT_TOKENS,
  inkAlpha,
  mergeTokens,
  tokenVars,
  type DesignTokens,
} from "./tokens.ts";

/**
 * Shape + motion tokens (DESIGN-SYSTEM.md §4d).
 *
 * Three properties carry the design, and each one is a claim that would rot
 * silently if it broke — which is exactly how `--radius-sm` became a live bug
 * (referenced in two panels, defined nowhere, rendering 0 with no fallback).
 *
 *  1. ONE NUMBER OWNS EVERY CORNER. A look sets `shape.radiusPx` and every
 *     radius in the app — CSS and canvas — follows. No look ever enumerates
 *     per-role radii, so no role can drift out of the system.
 *
 *  2. THE MOTION LEVER COLLAPSES WITHOUT BRANCHING. Every duration is emitted
 *     as calc(<n>ms * var(--motion-scale)); at scale 0 they all resolve to 0ms.
 *     If a duration is ever emitted as a bare `90ms`, this is the test that
 *     catches it — because that duration would survive prefers-reduced-motion.
 *
 *  3. STATE PULSES ARE EXEMPT. The armed-launch and scheduled-scene pulses are
 *     readouts ("the engine is holding, not yet"), not decoration. They must NOT
 *     scale with the motion lever, for the same reason nobody wants "less
 *     animation" to freeze the playhead.
 */

/** The suite is DOM-free by design (React tests use renderToStaticMarkup), so
    these assert against tokenVars — the pure half of applyTokens. */
let vars: Record<string, string> = {};
const apply = (t: DesignTokens): void => { vars = tokenVars(t); };
const read = (name: string): string => vars[name] ?? "";

const withShape = (over: Partial<DesignTokens["shape"]>): DesignTokens => ({
  ...DEFAULT_TOKENS,
  shape: { ...DEFAULT_TOKENS.shape, ...over },
});

const withMotion = (over: Partial<DesignTokens["motion"]>): DesignTokens => ({
  ...DEFAULT_TOKENS,
  motion: { ...DEFAULT_TOKENS.motion, ...over },
});

describe("shape", () => {
  it("derives every role radius from the single radiusPx token", () => {
    apply(withShape({ radiusPx: 6 }));
    expect(read("--radius")).toBe("6px");
    // Derived, never enumerated — a look sets one number and the roles follow.
    expect(read("--radius-sm")).toBe("calc(var(--radius) * 0.5)");
    expect(read("--radius-lg")).toBe("calc(var(--radius) * 2)");
  });

  it("radiusPx 0 restores the sharp digital identity", () => {
    apply(withShape({ radiusPx: 0 }));
    expect(read("--radius")).toBe("0px");
  });

  it("--radius-sm is always defined (it used to dangle and silently render 0)", () => {
    apply(DEFAULT_TOKENS);
    expect(read("--radius-sm")).not.toBe("");
  });

  it("emits a hairline so borders stop being literal 1px", () => {
    apply(withShape({ hairlinePx: 2 }));
    expect(read("--hairline")).toBe("2px");
  });
});

describe("motion", () => {
  it("emits every duration as a calc against the master scale", () => {
    apply(withMotion({ scale: 1, fastMs: 90, baseMs: 120 }));
    // The calc() form is the whole contract: a bare `90ms` here would survive
    // prefers-reduced-motion, because the lever multiplies, it does not branch.
    expect(read("--dur-fast")).toBe("calc(90ms * var(--motion-scale))");
    expect(read("--dur-base")).toBe("calc(120ms * var(--motion-scale))");
  });

  it("a trick DERIVES from a base duration — one edit moves every trick using it", () => {
    // The per-trick vars used to carry their own copy of the ms value, which made
    // --dur-fast an orphan: emitted, obeyed by nothing. Now they reference it.
    apply(withMotion({ tricks: { menuEntry: true, hoverLift: true, latchSweep: true, panelEntry: true } }));
    expect(read("--dur-menu")).toBe("var(--dur-fast)");
    expect(read("--dur-latch")).toBe("var(--dur-base)");
  });

  it("scale 0 collapses every chrome duration to zero", () => {
    apply(withMotion({ scale: 0 }));
    expect(read("--motion-scale")).toBe("0");
    // Each --dur-* is calc(<n>ms * 0) = 0ms. Nothing branches on `scale`.
    for (const d of ["--dur-fast", "--dur-base"]) {
      expect(read(d)).toContain("var(--motion-scale)");
    }
  });

  it("leaves the state-pulse period UNSCALED by the motion lever", () => {
    apply(withMotion({ scale: 0, pulseMs: 600 }));
    // A quantized launch waiting for its boundary must keep pulsing even when a
    // user has asked for no motion — it is information, not decoration. Reduced
    // motion silences it by swapping in a STATIC mark (grid.css), not by
    // deleting the state.
    expect(read("--dur-pulse")).toBe("600ms");
    expect(read("--dur-pulse")).not.toContain("motion-scale");
  });

  it("keeps a trick that a stored theme predates (undefined must not read as off)", () => {
    const stored = { motion: { scale: 2, tricks: { menuEntry: false } } };
    const merged = mergeTokens(stored);
    expect(merged.motion.scale).toBe(2);
    expect(merged.motion.tricks.menuEntry).toBe(false); // the explicit opt-out survives
    expect(merged.motion.tricks.hoverLift).toBe(true); // the unknown-to-it trick defaults ON
  });

  it("a trick that is OFF emits 0ms, so no CSS rule has to branch on it", () => {
    apply(withMotion({ tricks: { menuEntry: false, hoverLift: true, latchSweep: true, panelEntry: true } }));
    // The transition still EXISTS — it just takes no time. That is what keeps
    // the stylesheet free of `.motion-on` classes and half-styled states.
    expect(read("--dur-menu")).toBe("0ms");
    // An ON trick resolves THROUGH --dur-fast, which is itself the scaled calc —
    // so the master lever still reaches it, one hop further along.
    expect(read("--dur-hover")).toBe("var(--dur-fast)");
    expect(read("--dur-fast")).toContain("var(--motion-scale)");
  });
});

describe("surface + polarity", () => {
  it("emits color-scheme from polarity (or a light look gets dark scrollbars)", () => {
    apply({ ...DEFAULT_TOKENS, polarity: "light" });
    expect(read("color-scheme")).toBe("light");
    apply(DEFAULT_TOKENS);
    expect(read("color-scheme")).toBe("dark");
  });

  it("scales CHROME with the ink level but never SIGNAL", () => {
    apply({
      ...DEFAULT_TOKENS,
      surface: { ...DEFAULT_TOKENS.surface, chromeInk: 0.5 },
    });
    // inkAlpha is the canvas route to chromeInk — gridlines, shading, marks.
    expect(inkAlpha(0.4)).toBeCloseTo(0.2);
    // …but the audio itself is NOT chrome. Turning the grid's ink down to suit a
    // light ground must not dim the waveform, the meters, or the playhead — so
    // these are read straight, never through inkAlpha.
    const s = currentTokens().surface;
    expect(s.ghostTailAlpha).toBe(DEFAULT_TOKENS.surface.ghostTailAlpha);
    expect(s.playheadAlpha).toBe(DEFAULT_TOKENS.surface.playheadAlpha);
  });

  it("defaults are a no-op hoist — the grid draws exactly what it always drew", () => {
    // If any of these drift, the "tokenise without restyling" claim is broken.
    const s = DEFAULT_TOKENS.surface;
    expect(s.chromeInk).toBe(1);
    expect(s.cellTintAlpha).toBe(0.12);
    expect(s.wrapTintAlpha).toBe(0.08);
    expect(s.ghostTailAlpha).toBe(0.4);
    expect(s.playheadAlpha).toBe(0.25);
    expect(s.grainAlpha).toBe(0); // INSTRUMENT is a void; PHOSPHOR gives it tooth
  });
});

describe("elevation", () => {
  it("ambientAlpha 0 means flat — `none`, not an invisible blur that still paints", () => {
    apply({ ...DEFAULT_TOKENS, elevation: { ambientAlpha: 0 } });
    expect(read("--elev-1")).toBe("none");
    expect(read("--elev-2")).toBe("none");
  });

  it("carries depth on a DARK ground with a LIT EDGE, not just a shadow", () => {
    // The bug this pins: black-on-near-black is invisible. #000 at 45% over
    // #141414 is very nearly #141414, so the Depth slider moved and nothing
    // happened. On a dark UI the top rim catching light is what says "above the
    // surface" — exactly as it does on a physical panel.
    apply({ ...DEFAULT_TOKENS, elevation: { ambientAlpha: 0.45 } });
    expect(read("--elev-2")).toContain("inset 0 1px 0 rgb(255 255 255"); // the rim
    expect(read("--elev-2")).toContain("rgb(0 0 0 /"); // and the drop
  });

  it("drops the rim on a light ground, where light-on-light says nothing", () => {
    apply({ ...DEFAULT_TOKENS, polarity: "light", elevation: { ambientAlpha: 0.45 } });
    expect(read("--elev-2")).not.toContain("255 255 255");
    expect(read("--elev-2")).toContain("rgb(0 0 0 /");
  });
});
