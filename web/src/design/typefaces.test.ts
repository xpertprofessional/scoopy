import { describe, expect, it } from "vitest";
import { FACES, TYPE_PAIRINGS, faceByName, nameForStack } from "./typefaces.ts";
import { DEFAULT_TOKENS, mergeTokens, tokenVars } from "./tokens.ts";
import { SHIPPED_LOOKS } from "./looks.ts";

/**
 * The typeface catalogue (LOOK-5).
 *
 * The failure mode this guards is the one that makes a font picker feel broken:
 * SILENCE. A pairing naming a face that doesn't exist, a default that isn't in
 * the list, a face offered for a role it can't reach — all of them change
 * nothing when you pick them, and nothing on screen says why. Same species as an
 * orphan token: a control that does nothing.
 */

describe("typeface catalogue", () => {
  it("is ONE list, usable for BOTH roles", () => {
    // Two lists was the bug the user hit: the prose face reaches only captions
    // and panel titles (the app is mono-dominant — labels AND values are mono),
    // so a prose-only picker could never actually show you a typeface. Either
    // role may now take any face; if you want Didot everywhere, put Didot on the
    // role that owns the labels.
    expect(FACES.length).toBeGreaterThan(20);
    expect(FACES.some((f) => f.mono)).toBe(true);
    expect(FACES.some((f) => !f.mono)).toBe(true);
  });

  it("every pairing names faces that actually exist", () => {
    // A typo here gives you a pairing that silently changes nothing.
    for (const p of TYPE_PAIRINGS) {
      expect(faceByName(p.values), `${p.name} → values "${p.values}"`).toBeDefined();
      expect(faceByName(p.prose), `${p.name} → prose "${p.prose}"`).toBeDefined();
    }
  });

  it("offers at least one pairing that puts a PROPORTIONAL face on the values role", () => {
    // The whole point of merging the lists: you must be able to put Futura or
    // Didot on the role that actually covers the app, or you cannot see it.
    const allIn = TYPE_PAIRINGS.filter((p) => faceByName(p.values)?.mono === false);
    expect(allIn.length).toBeGreaterThan(0);
  });

  it("the shipped defaults ARE catalogue entries, so the picker opens on a real name", () => {
    // If a default stack weren't in the list, the picker would open on "Custom"
    // on a fresh install — which reads as "someone edited this".
    expect(nameForStack(DEFAULT_TOKENS.fontMono)).not.toBe("Custom");
    expect(nameForStack(DEFAULT_TOKENS.fontUI)).not.toBe("Custom");
  });

  it("every LOOK's faces are catalogue entries too", () => {
    for (const l of SHIPPED_LOOKS) {
      expect(nameForStack(l.tokens.fontMono), l.name).not.toBe("Custom");
      expect(nameForStack(l.tokens.fontUI), l.name).not.toBe("Custom");
    }
  });

  it("every stack ends in a generic family, so a missing face still lands nearby", () => {
    for (const f of FACES) {
      expect(f.stack, f.name).toMatch(/(monospace|sans-serif|serif)\s*$/);
    }
  });

  it("every face carries a note — a picker of bare names teaches nothing", () => {
    for (const f of FACES) {
      expect(f.note.length, f.name).toBeGreaterThan(10);
    }
  });

  it("has no duplicate names (the picker keys on them)", () => {
    expect(new Set(FACES.map((f) => f.name)).size).toBe(FACES.length);
  });
});

describe("the display step", () => {
  it("is emitted as a full type step", () => {
    const vars = tokenVars(DEFAULT_TOKENS);
    for (const axis of ["size", "weight", "tracking", "family", "transform"]) {
      expect(vars[`--type-display-${axis}`], axis).toBeDefined();
    }
  });

  it("is BIG enough to judge a typeface by — that is its entire reason to exist", () => {
    // Every other step is 10–11px. A font picker whose largest sample is 11px is
    // a font picker you cannot use: no face says anything at that size.
    expect(DEFAULT_TOKENS.type.display.sizePx).toBeGreaterThan(
      DEFAULT_TOKENS.type.title.sizePx + 3,
    );
  });

  it("survives a stored theme that predates it", () => {
    // An older theme.tokens has no `display` key. It must land on the default
    // rather than leaving a hole that renders as 0px text.
    const stored = JSON.parse(JSON.stringify(DEFAULT_TOKENS));
    delete stored.type.display;
    const merged = mergeTokens(stored);
    expect(merged.type.display).toEqual(DEFAULT_TOKENS.type.display);
  });
});
