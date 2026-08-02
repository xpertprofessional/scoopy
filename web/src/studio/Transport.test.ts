import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * S2 — the transport block, pinned against the two rules it exists to keep.
 *
 * Source-text, in the `uiOwnership` idiom, for the standing reason: no jsdom and
 * no React renderer in this project (P3.5-E8g-f), so nothing can mount a face
 * and click a glyph. What is mechanically checkable is the vocabulary and the
 * disabled contract — which are precisely the two things DESIGN.md already had
 * to be written down because they had drifted before.
 */

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const SRC = read("src/studio/Transport.tsx");

/** What the component RENDERS, with prose removed.
 *
 *  The distinction is not pedantry — it is the first thing this test got wrong.
 *  The §3 check below forbids the `■`/`▶` dialect, and the file's own header
 *  NAMES that dialect in order to warn about it, so a whole-file match fails on
 *  a comment that is doing the right thing. A rule about what ships has to be
 *  measured against what ships. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("Transport — DESIGN.md §3 and §6", () => {
  it("speaks all four glyphs and no other dialect", () => {
    // §3: ⟳ play · ▸ one-shot · ↻ retrigger · ◼ stop. One vocabulary, every scope.
    for (const glyph of ["⟳", "▸", "↻", "◼"]) expect(CODE).toContain(glyph);
    // ■/▶ are the second dialect §3 names outright. A surface that shows three
    // of the four has a missing verb, not a smaller vocabulary — so a stray
    // ▶ here would mean someone reached for the other alphabet.
    expect(CODE).not.toContain("■");
    expect(CODE).not.toContain("▶");
  });

  it("renders ▸ one-shot — this is a DECK transport, not the plane's master", () => {
    // The plane's master drops ▸ deliberately: "fire this once" has no meaning
    // across N decks. Studio has exactly one, so dropping it here would be
    // copying the master's OMISSION without the master's reason.
    expect(CODE).toContain("playOnce");
  });

  it("every verb it draws reaches a real store call (§7)", () => {
    for (const verb of ["play(", "playOnce(", "stop("]) expect(CODE).toContain(verb);
  });

  it("a disabled control says why (§6) — never `disabled` with no title", () => {
    // The rule that makes the difference between a dead end and a precondition.
    // Four buttons; each carries `title={why ?? …}`, so the disabled state
    // always names what to do about it.
    const disabled = CODE.match(/disabled=\{!!why\}/g) ?? [];
    expect(disabled).toHaveLength(4);
    const titled = CODE.match(/title=\{why \?\? /g) ?? [];
    expect(titled).toHaveLength(4);
    // …and the reason is actionable, naming the door rather than the state.
    expect(CODE).toContain("session ▾");
  });

  it("Studio mounts it — the verb had no visible door before", () => {
    const face = read("src/studio/StudioPanel.tsx");
    expect(face).toContain("<Transport");
    // Deck 0 is the only deck (D-SL-STUDIO-01), not a default someone picked.
    expect(face).toContain("deck={DECK}");
  });
});
