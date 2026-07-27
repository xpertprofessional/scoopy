/**
 * MB-6 — keymap invariants. The collision test is the point: before this
 * file, NOTHING checked chord uniqueness across the menu, HotkeyManager and
 * the registry — NSMenu silently steals duplicates (the ⌘D finding).
 *
 * Limitation, on purpose: compound display chords ("Q / W / E", "⌃1–8") are
 * opaque tokens — the test catches exact-chord double-claims, not token
 * overlaps inside ranges. That is the class NSMenu key equivalents are in,
 * which is the class that bites silently.
 */
import { describe, expect, test } from "vitest";
import { COMMANDS } from "./registry";
import { formatShortcut, KEYMAP, KNOWN_COLLISIONS, type ShortcutEntry } from "./keymap";

const allEntries: ShortcutEntry[] = KEYMAP.flatMap((s) => s.entries);

describe("keymap (MB-6)", () => {
  test("no chord is claimed twice in one context (global claims everywhere)", () => {
    const byKeys = new Map<string, ShortcutEntry[]>();
    for (const e of allEntries) {
      const list = byKeys.get(e.keys) ?? [];
      list.push(e);
      byKeys.set(e.keys, list);
    }
    const collisions: string[] = [];
    for (const [keys, entries] of byKeys) {
      if (entries.length < 2) continue;
      for (let i = 0; i < entries.length; i++) {
        const a = entries[i];
        if (!a) continue;
        for (let j = i + 1; j < entries.length; j++) {
          const b = entries[j];
          if (!b) continue;
          const clash =
            a.context === b.context || a.context === "global" || b.context === "global";
          if (clash && !KNOWN_COLLISIONS.has(keys)) {
            collisions.push(`${keys}: "${a.label}" (${a.context}) vs "${b.label}" (${b.context})`);
          }
        }
      }
    }
    expect(collisions).toEqual([]);
  });

  test("allowlist carries no resolved (stale) collisions", () => {
    const claimed = new Map<string, number>();
    for (const e of allEntries) claimed.set(e.keys, (claimed.get(e.keys) ?? 0) + 1);
    for (const keys of KNOWN_COLLISIONS) {
      expect(claimed.get(keys) ?? 0, `KNOWN_COLLISIONS entry "${keys}" no longer collides — remove it`).toBeGreaterThan(1);
    }
  });

  test("every registry shortcut appears in the keymap exactly once, keys derived", () => {
    const registryRows = allEntries.filter((e) => e.owner === "registry");
    const seen = new Map(registryRows.map((e) => [e.commandId, e]));
    expect(seen.size).toBe(registryRows.length); // no command referenced twice
    for (const c of COMMANDS) {
      if (!c.shortcut) continue;
      const row = seen.get(c.id);
      expect(row, `command ${c.id} declares a shortcut but has no keymap row`).toBeDefined();
      expect(row?.keys).toBe(formatShortcut(c.shortcut)); // derived, never re-typed
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
