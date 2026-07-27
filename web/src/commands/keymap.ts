/**
 * MB-6 — THE keymap. Every keyboard shortcut the app answers, ONE list.
 *
 * Before this file, shortcut truth lived on five unsynchronized surfaces:
 * ShortcutListView.swift's hand-typed string (~90 entries, 6+ of them stale),
 * ~30 literal `.keyboardShortcut`s in ScoopyLoopsApp.swift, HotkeyManager's
 * ~40 imperative dispatch blocks, registry.ts (the only real data), and
 * scattered tooltip strings. This file is the collapse:
 *
 * - Registry-owned shortcuts are NOT re-declared here — entries reference the
 *   command id and derive keys (and label, unless the label is a state
 *   function) from `COMMANDS`. One declaration, still.
 * - Native-owned shortcuts (HotkeyManager dispatch + the Commands-block
 *   remainders) are DECLARED here, transcribed from the dispatch code itself
 *   (MB-6 audit, 2026-07-21) — not from the drifted Help list.
 * - `Generated/ShortcutList.swift` is emitted from this file by
 *   scripts/generate-protocol.ts, and Help ▸ Keyboard Shortcuts… renders it.
 *   `npm run protocol:check` fails when the render is stale.
 *
 * ⚠️ LIMIT (deliberate): native DISPATCH does not consume this table yet —
 * HotkeyManager stays imperative until P8-8 builds the TS dispatcher. Until
 * then this file is the declaration + the drift gate, not the dispatcher.
 * When you add or change a native shortcut, change it here in the same
 * commit — the collision test and the generated Help window are the reward.
 */
import { COMMANDS, type Command, type CommandId, type KeyEquivalent } from "./registry.ts";

/** Where a chord is live. Collisions are only illegal within one context. */
export type KeyContext =
  | "global" // answered everywhere (menu key equivalents, transport)
  | "compose" // compose view only
  | "grid" // compose grid/controls lanes (focus-dependent)
  | "dj" // DJ view only
  | "browserFocus" // only while the file browser holds focus
  | "noteKeyboard"; // only while ⌘K musical keyboard mode is on

export interface ShortcutEntry {
  /** Display chord: "⌘⇧S", "ö / ä", "⌃1–8". Modifier order: ⌃⌥⇧⌘. */
  keys: string;
  label: string;
  context: KeyContext;
  /** "registry" runs a registry Command; "native" is HotkeyManager or the
   * remaining SwiftUI Commands items. */
  owner: "registry" | "native";
  /** Registry entries carry their id so coverage can be tested. */
  commandId?: CommandId;
}

export interface ShortcutSection {
  title: string;
  /** Optional trailing note rendered under the section. */
  note?: string;
  entries: ShortcutEntry[];
}

/** KeyboardEvent.code → display glyph for registry-declared shortcuts. */
const CODE_DISPLAY: Record<string, string> = {
  Space: "Space",
  Enter: "Return",
  Period: ".",
  Comma: ",",
  BracketLeft: "[",
  BracketRight: "]",
};

export function formatShortcut(sc: KeyEquivalent): string {
  const key = sc.code.startsWith("Key")
    ? sc.code.slice(3)
    : sc.code.startsWith("Digit")
      ? sc.code.slice(5)
      : (CODE_DISPLAY[sc.code] ?? sc.code);
  return `${sc.ctrl ? "⌃" : ""}${sc.alt ? "⌥" : ""}${sc.shift ? "⇧" : ""}${sc.cmd ? "⌘" : ""}${key}`;
}

const byId = new Map<CommandId, Command>(COMMANDS.map((c) => [c.id, c]));

/**
 * A registry-owned row: keys always derive from the Command (one declaration).
 * `label` is required only when the Command's label is a state function
 * (Play/Pause, DJ toggle) — a static list needs a static description.
 */
function reg(id: CommandId, label?: string, context: KeyContext = "global"): ShortcutEntry {
  const c = byId.get(id);
  if (!c) throw new Error(`keymap references unknown command ${id}`);
  if (!c.shortcut) throw new Error(`keymap references shortcut-less command ${id}`);
  const resolved = label ?? (typeof c.label === "string" ? c.label : undefined);
  if (resolved === undefined) {
    throw new Error(`command ${id} has a label function — keymap entry needs a static label`);
  }
  return { keys: formatShortcut(c.shortcut), label: resolved, context, owner: "registry", commandId: id };
}

function nat(keys: string, label: string, context: KeyContext = "global"): ShortcutEntry {
  return { keys, label, context, owner: "native" };
}

/**
 * THE list. Section order is Help-window order.
 * Native entries transcribed from HotkeyManager.swift / ScoopyLoopsApp.swift
 * dispatch code (file:line refs in the MB-6 audit) — corrected against the old
 * hand list: ⌘⇧R (never bound) and ⌘⇧L (feature deleted) are gone; ⌘I is the
 * Master FX sheet, not the retired inspector; DJ toggle is ⌘D, not ⌘⇧D; the
 * DJ Tab popover is retired; "9" is the scene-edit latch.
 */
export const KEYMAP: readonly ShortcutSection[] = [
  {
    title: "Transport",
    entries: [
      reg("transport.playPause", "Play / Pause"),
      reg("transport.stop"),
      reg("transport.restart", "Restart from beginning"),
    ],
  },
  {
    title: "Session",
    entries: [
      reg("session.new"),
      reg("session.save"),
      reg("session.saveAs"),
      reg("session.load"),
    ],
  },
  {
    title: "Undo / Redo",
    entries: [reg("edit.undo", "Undo"), reg("edit.redo", "Redo")],
  },
  {
    title: "Pattern Scenes",
    note: "When stopped, all pattern keys switch immediately for editing. Only enabled scenes respond.",
    entries: [
      nat("1–8", "Schedule pattern scene 1–8 (during playback)", "compose"),
      nat("⇧1–8", "Add pattern scene to loop queue", "compose"),
      nat("⌥1–8", "Immediate pattern scene switch", "compose"),
      nat("⌥⇧1–8", "Immediate pattern scene switch from start", "compose"),
      nat("9", "Toggle scene-edit latch (pin edits to the current scene)", "compose"),
      nat("0", "Toggle master mute group", "compose"),
      nat("⌘⇧C", "Copy pattern scene", "compose"),
      nat("⌘⇧V", "Paste pattern scene", "compose"),
    ],
  },
  {
    title: "Track Selection & Preview",
    entries: [
      nat("↑ / ↓", "Select previous / next track", "grid"),
      nat("⇧↑ / ⇧↓", "Add track to multi-selection", "grid"),
      nat("Q W E R T Z U I", "Preview / finger-drum tracks 1–8", "compose"),
    ],
  },
  {
    title: "Track Management",
    entries: [
      nat("+ or =", "Add new audio track", "compose"),
      reg("track.add"),
      nat("⌘⇧T", "Add MIDI Track"),
      nat("⌘+", "Add new MIDI track", "compose"),
      nat("Delete", "Delete selected track", "grid"),
      nat("⌘D", "Duplicate selected track", "grid"),
      nat("⌥↑ / ⌥↓", "Move selected track up / down"),
      nat("⌘⇧O", "Open sample dialog", "compose"),
    ],
  },
  {
    title: "Grid Navigation",
    entries: [
      nat("Tab or -", "Toggle grid lane / controls lane", "compose"),
      nat("⇧Tab", "Switch between Compose and DJ view"),
      nat("← / →", "Navigate cells (grid lane)", "grid"),
      nat("⇧← / ⇧→", "Extend / shrink cell selection", "grid"),
    ],
  },
  {
    title: "Cell Editing",
    entries: [
      nat(".", "Draw (toggle) focused cell or selected cells", "grid"),
      nat("O", "Clear selected cell values (all parameters)", "grid"),
      nat("⌥← / ⌥→", "Extend / shrink cell duration", "grid"),
      nat("⌥⇧← / ⌥⇧→", "Toggle pattern playback direction", "grid"),
      nat("⌘A", "Select all cells", "grid"),
      nat("⌘C", "Copy selected cells", "grid"),
      nat("⌘V", "Paste cells at focused position", "grid"),
      nat("⌘B", "Duplicate selected cells", "grid"),
      nat("⌘E", "Make first cell of selection an owner", "grid"),
      nat("⌘R", "Reverse order of selected steps", "grid"),
    ],
  },
  {
    title: "Beat Repeat",
    entries: [
      nat("⌃1–8", "Loop 1–8 steps", "compose"),
      nat("⌃⌥1–8", "Loop 9–16 steps", "compose"),
      nat("⌃← / ⌃→", "Scale beat-repeat length", "compose"),
    ],
  },
  {
    title: "Pitch, Accent & Step Parameters",
    entries: [
      nat("ö", "Parameter ↓ for focused / selected cells or control", "grid"),
      nat("ä", "Parameter ↑ for focused / selected cells or control", "grid"),
      nat("ü", "Cycle accent level of last step", "grid"),
    ],
  },
  {
    title: "Speed Multipliers (selected track)",
    entries: [
      nat("⇧8 (*)", "Cycle multiply: 3:2 → 2:1 → 3:1 → 4:1 → 1:1", "grid"),
      nat("⌥*", "Set 2x speed directly", "grid"),
      nat("⇧-", "Cycle divide: 2:3 → 1:2 → 1:3 → 1:4 → 1:1", "grid"),
      nat("⌥/", "Set 0.5x speed directly", "grid"),
      nat("⌥+ / ⌥-", "Increase / decrease step count by 1", "grid"),
      nat("⌥⇧+ / ⌥⇧-", "Double / halve step count", "grid"),
    ],
  },
  {
    title: "Pattern Shift",
    entries: [
      nat("⌘[", "Shift all tracks left by one step"),
      nat("⌘⇧[", "Shift selected track left by one step"),
      nat("⌘]", "Shift all tracks right by one step"),
      nat("⌘⇧]", "Shift selected track right by one step"),
    ],
  },
  {
    title: "Paint Mode (Arpeggio / Intervals)",
    entries: [
      nat("⇧Drag", "Paint descending pitch values on cells", "grid"),
      nat("⌥⇧Drag", "Paint ascending pitch values on cells", "grid"),
      nat("⌥.", "Paint descending on selected cells", "grid"),
      nat("⌥⇧.", "Paint ascending on selected cells", "grid"),
      nat("⌘1–4", "Switch pitch interval preset bank", "compose"),
    ],
  },
  {
    title: "Recording",
    entries: [
      nat("P", "Arm / disarm live recording", "compose"),
      nat("O (hold, recording)", "Erase step under playhead while recording", "compose"),
      nat("Y", "Toolbar recorder: record / stop (take window opens)", "compose"),
    ],
  },
  {
    title: "Track Quick Actions (selected track)",
    entries: [
      nat("⌥A", "Toggle mute", "grid"),
      nat("⌥S", "Toggle solo", "grid"),
      nat("#", "Toggle track launch (respects quantize)", "grid"),
      nat("V", "Toggle reverse transport", "compose"),
    ],
  },
  {
    title: "View & Panels",
    entries: [
      nat("⌘M", "Toggle Modifiers section"),
      nat("⌘⌥M", "Toggle Modulation system"),
      nat("⌘I", "Toggle Master FX sheet (compose)", "compose"),
      nat("⌘⇧M", "Master FX…"),
      nat("F1–F4", "Open FX slot editor 1–4"),
      nat("⌘= / ⌘-", "Zoom track view in / out", "compose"),
      nat("Esc", "Close open overlay panel"),
    ],
  },
  {
    title: "DJ Mode",
    entries: [
      // View toggle: ⇧Tab (listed under Grid Navigation) — dj.toggleView is
      // deliberately keyless since the ⌘D-shadows-duplicate resolution.
      nat("⌘⇧1 / 2 / 3", "Send session to Deck A / B / C"),
      nat("⌘⌥3", "Enable Deck C"),
      nat("Q / W / E", "Deck A: reverse-play / play / cue-restart", "dj"),
      nat("A / S / D", "Deck B: reverse-play / play / cue-restart", "dj"),
      nat("R / F", "Deck A / B: hold to play, release pauses, next hold resumes", "dj"),
      nat("U / J", "Deck A / B: tape-reverse hold (reverts on release)", "dj"),
      nat("T Y / G H", "Deck A / B: nudge down / up (hold)", "dj"),
      nat("1–4 / 5–8", "Launch scene on Deck A / Deck B (⌥: upper bank)", "dj"),
      nat("⌘⌥D", "Double active deck to the other deck", "dj"),
      nat("-", "Switch active deck", "dj"),
      nat("⌥Space", "Global play / stop (all decks)", "dj"),
      nat("⌥9 / ⌥0", "Sync BPM down / up by 1", "dj"),
      nat("⌥⌘`", "Focus playlist (enable playlist hotkeys)", "dj"),
    ],
  },
  {
    title: "File Browser (while focused)",
    entries: [
      nat("↑ ↓ ← →", "Navigate the browser", "browserFocus"),
      nat("⌥← / ⌥→", "Load selected session to Deck A / B", "browserFocus"),
    ],
  },
  {
    title: "Musical Keyboard Mode",
    note: "While active, letter keys are absorbed (no finger-drumming); Z/X/C/V override the pad shortcuts.",
    entries: [
      nat("⌘K", "Toggle musical keyboard mode"),
      nat("A W S E D F T G Y H U J K O L P ; '", "Piano keys (two octaves)", "noteKeyboard"),
      nat("Z", "Octave down", "noteKeyboard"),
      nat("X", "Octave up", "noteKeyboard"),
      nat("C / V", "Velocity down / up", "noteKeyboard"),
    ],
  },
  {
    title: "Sample Pads & Chops",
    entries: [
      nat("Z / X / C / V", "Trigger FX pads 1–4", "compose"),
      nat("⌥Q…⌥I", "Preview chop slots 1–8", "compose"),
    ],
  },
];

/**
 * Known, deliberate double-claims — each is a real finding this file made
 * visible; resolving them is MB-7 / decision-batch work, not the keymap's.
 * Keyed by the display chord. Remove an entry here the day its collision is
 * actually resolved; never add one without a comment saying who shadows whom.
 */
export const KNOWN_COLLISIONS: ReadonlySet<string> = new Set([
  // (empty — the ⌘D double-claim was resolved 2026-07-21: dj.toggleView went
  // keyless, ⇧Tab owns the view toggle, duplicate-track keeps ⌘D.)
]);
