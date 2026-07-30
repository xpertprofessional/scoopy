/**
 * MB-6 — keymap invariants. The collision test is the point: before this
 * file, NOTHING checked chord uniqueness across the menu, HotkeyManager and
 * the registry — NSMenu silently steals duplicates (the ⌘D finding).
 *
 * ⚠️ THE LIMITATION IS GONE (P7-K0a). This file used to say: "compound display
 * chords ('Q / W / E', '⌃1–8') are opaque tokens — the test catches exact-chord
 * double-claims, not token overlaps inside ranges." That was the whole class
 * NSMenu key equivalents live in, i.e. the class that bites silently. Every
 * entry now carries `chords`, the expanded machine form, and the collision test
 * below compares CHORDS. It found three overlaps the token test could not see;
 * they are in `KNOWN_COLLISIONS` with their reasons.
 *
 * What these pins still cannot see: whether any of this is DISPATCHED. Nothing
 * consumes `KEYMAP` but this file (P7-K4), and WizardMerged has no native
 * keyboard at all (NAV-SHORTCUTS §1.1) — so a green run here proves the table
 * is coherent, never that a key does anything.
 */
import { describe, expect, test } from "vitest";
import { COMMANDS } from "./registry";
import {
  chordId,
  formatShortcut,
  KEYMAP,
  KNOWN_COLLISIONS,
  type Chord,
  type ShortcutEntry,
} from "./keymap";

const allEntries: ShortcutEntry[] = KEYMAP.flatMap((s) => s.entries);
const allChords: [Chord, ShortcutEntry][] = allEntries.flatMap((e) =>
  e.chords.map((ch): [Chord, ShortcutEntry] => [ch, e]),
);

describe("keymap (MB-6)", () => {
  test("no CHORD is claimed twice in one context (global claims everywhere)", () => {
    const byChord = new Map<string, ShortcutEntry[]>();
    for (const [ch, e] of allChords) {
      const id = chordId(ch);
      const list = byChord.get(id) ?? [];
      list.push(e);
      byChord.set(id, list);
    }
    const collisions: string[] = [];
    for (const [id, entries] of byChord) {
      if (entries.length < 2) continue;
      for (let i = 0; i < entries.length; i++) {
        const a = entries[i];
        if (!a) continue;
        for (let j = i + 1; j < entries.length; j++) {
          const b = entries[j];
          if (!b) continue;
          const clash =
            a.context === b.context || a.context === "global" || b.context === "global";
          if (clash && !KNOWN_COLLISIONS.has(id)) {
            collisions.push(
              `${id}: "${a.label}" (${a.context}, ${a.keys}) vs "${b.label}" (${b.context}, ${b.keys})`,
            );
          }
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  test("allowlist carries no resolved (stale) collisions", () => {
    const claimed = new Map<string, number>();
    for (const [ch] of allChords) {
      const id = chordId(ch);
      claimed.set(id, (claimed.get(id) ?? 0) + 1);
    }
    for (const id of KNOWN_COLLISIONS) {
      expect(
        claimed.get(id) ?? 0,
        `KNOWN_COLLISIONS entry "${id}" no longer collides — remove it`,
      ).toBeGreaterThan(1);
    }
  });

  /**
   * P7-K0a's own gate, and P7-K3's foundation: a row either has something to
   * match or a written reason it never will. No third state, and no silent
   * dead chord.
   */
  test("every entry ends with a chord or a parked reason", () => {
    const orphans = allEntries
      .filter((e) => e.chords.length === 0 && !e.parked)
      .map((e) => `${e.keys} — "${e.label}"`);
    expect(orphans).toEqual([]);
    for (const e of allEntries) {
      if (!e.parked) continue;
      // A reason is the audit's status letter AND prose. The letter alone is a
      // classification, not an explanation; the prose alone loses the class
      // P7-K3 will group by. "PARK-A: same as ⌘[" is legal — a pointer to the
      // sibling row that carries the argument is still an argument.
      expect(e.parked, `${e.keys}: parked reason must carry its PARK-x class`).toMatch(
        /^PARK-[ABCE]: /,
      );
      expect(
        e.parked.slice("PARK-A: ".length).trim().length,
        `${e.keys}: parked with a class letter and no reason`,
      ).toBeGreaterThan(4);
    }
  });

  /**
   * Pinned against NAV-SHORTCUTS §6's tally, which was measured row-by-row at
   * HEAD. If an expansion drifts, this is what says so — and if a row is added
   * without auditing it, this is what makes that a decision rather than an
   * accident.
   *
   * The four numbers were re-derived from the expansion, not copied: 42 rows
   * with a target (LIVE 6 + RETARGET 17 + BIND 63 + DECLARED-LIVE 16 = 102
   * slots) and 57 parked (PARK-A 96 + B 4 + C 0 + E 14 = 114). They match §6's
   * per-status tally exactly, including the one row that could have gone either
   * way: "+ or =" is TWO slots, the shifted and the bare Equal, because it
   * names the two ways to type one physical key.
   */
  test("the audited shape holds: 99 rows, 216 chord slots, 57 of them parked", () => {
    expect(allEntries.length).toBe(99);
    expect(allChords.length).toBe(216);
    expect(allEntries.filter((e) => e.parked).length).toBe(57);
    expect(allEntries.filter((e) => !e.parked).length).toBe(42);
  });

  test("a chord is code-matched, except the four with no stable code", () => {
    const byKey = allChords
      .filter(([ch]) => ch.code === undefined)
      .map(([ch]) => (ch.code === undefined ? ch.key : ""));
    // ö / ä / ü / # — the convention the tree already uses twice
    // (GridPanel.tsx:2440, focusModel.ts:176-178). A fifth would be a new
    // convention and needs a ruling, not a commit.
    expect(byKey.sort()).toEqual(["#", "ä", "ö", "ü"]);
    for (const [ch, e] of allChords) {
      if (ch.code === undefined) continue;
      expect(ch.code.trim().length, `${e.keys}: empty code`).toBeGreaterThan(0);
      // Modifiers are `true` or absent — never `false`, so exact-equality
      // matching (browserKeymap.ts:41-49) cannot be fooled by a falsy field.
      for (const m of [ch.cmd, ch.shift, ch.alt, ch.ctrl])
        expect(m === undefined || m === true).toBe(true);
    }
  });

  test("every registry shortcut appears in the keymap exactly once, keys AND chords derived", () => {
    const registryRows = allEntries.filter((e) => e.owner === "registry");
    const seen = new Map(registryRows.map((e) => [e.commandId, e]));
    expect(seen.size).toBe(registryRows.length); // no command referenced twice
    for (const c of COMMANDS) {
      if (!c.shortcut) continue;
      const row = seen.get(c.id);
      expect(row, `command ${c.id} declares a shortcut but has no keymap row`).toBeDefined();
      expect(row?.keys).toBe(formatShortcut(c.shortcut)); // derived, never re-typed
      expect(row?.chords).toEqual([c.shortcut]); // one declaration, both forms
    }
    for (const row of registryRows) {
      const c = COMMANDS.find((x) => x.id === row.commandId);
      expect(c?.shortcut, `keymap row "${row.label}" references ${row.commandId} which has no shortcut`).toBeDefined();
    }
  });

  test("every entry has non-empty keys and label; sections have titles", () => {
    for (const s of KEYMAP) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.entries.length).toBeGreaterThan(0);
      for (const e of s.entries) {
        expect(e.keys.trim().length).toBeGreaterThan(0);
        expect(e.label.trim().length).toBeGreaterThan(0);
      }
    }
  });
});
