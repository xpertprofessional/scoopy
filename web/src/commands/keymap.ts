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

/** The modifier set of a chord. Every field is `?: true`, never `false` —
 *  same shape as `KeyEquivalent`, so `matchesShortcut`'s EXACT-equality test
 *  (`browserKeymap.ts:41-49`) reads a keymap chord and a registry shortcut
 *  identically. */
export type ChordMods = { cmd?: true; shift?: true; alt?: true; ctrl?: true };

/**
 * ONE MATCHABLE CHORD (P7-K0a, NAV-SHORTCUTS §2).
 *
 * `keys` above is a DISPLAY string — "ö / ä", "⌃1–8", "O (hold, recording)",
 * "⇧Drag". It is prose: a dispatcher cannot match a KeyboardEvent against it
 * and must never try to parse it. `chords` is the machine half, and the two
 * are NEVER derived from each other — a range row expands here, its display
 * stays a range.
 *
 * `code` is the physical key and is the rule (registry.ts:26-28,
 * browserKeymap.ts:8-9; `keyForward.ts:104-108` records the bite — on a QWERTZ
 * the `KeyY` slot types `z`). The exceptions are the characters with no stable
 * code across layouts — `ö` `ä` `ü` `#` — which the tree ALREADY matches by
 * `key` in both live handlers (`GridPanel.tsx:2440`, `focusModel.ts:176-178`).
 * They are modelled as `{ key: "ö" }`; there is no third convention.
 */
export type Chord = KeyEquivalent | ({ key: string; code?: undefined } & ChordMods);

/** A stable, readable identity for a chord — the key the collision test groups
 *  by, and what a failure message prints. Modifier order is ⌃⌥⇧⌘, as in
 *  `formatShortcut`. */
export function chordId(ch: Chord): string {
  const key = ch.code !== undefined ? ch.code : `«${ch.key}»`;
  return `${ch.ctrl ? "⌃" : ""}${ch.alt ? "⌥" : ""}${ch.shift ? "⇧" : ""}${ch.cmd ? "⌘" : ""}${key}`;
}

export interface ShortcutEntry {
  /** Display chord: "⌘⇧S", "ö / ä", "⌃1–8". Modifier order: ⌃⌥⇧⌘. */
  keys: string;
  /** What a dispatcher matches. A range row expands to its members, so "⌃1–8"
   *  carries eight. EMPTY is legal and means the row can never be dispatched
   *  (a pointer gesture) — which is why `parked` is then mandatory. */
  chords: readonly Chord[];
  label: string;
  context: KeyContext;
  /** "registry" runs a registry Command; "native" is HotkeyManager or the
   * remaining SwiftUI Commands items. */
  owner: "registry" | "native";
  /** Registry entries carry their id so coverage can be tested. */
  commandId?: CommandId;
  /**
   * Set ⇒ this row is PARKED: it dispatches nothing, and this is why.
   * Required for every parked row (the `park()` constructor is the only way to
   * make one), so a dead chord can never be silent — that requirement is what
   * makes P7-K3's coverage gate mechanically checkable rather than a reading
   * exercise. Reasons are transcribed from NAV-SHORTCUTS §6 and keep its
   * status letter:
   *   PARK-A no merged feature or verb to aim at · PARK-B the verb exists but
   *   is dead on the wire · PARK-C not a keyboard chord · PARK-E superseded by
   *   a merged decision, the meaning now lives on another chord.
   * (PARK-D — host-reserved — is never a row's only status and is scoped in
   * `isReservedShortcut`, not here.)
   */
  parked?: string;
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
 * A registry-owned row: keys AND chords always derive from the Command (one
 * declaration). `label` is required only when the Command's label is a state
 * function (Play/Pause, DJ toggle) — a static list needs a static description.
 */
function reg(id: CommandId, label?: string, context: KeyContext = "global"): ShortcutEntry {
  const c = byId.get(id);
  if (!c) throw new Error(`keymap references unknown command ${id}`);
  if (!c.shortcut) throw new Error(`keymap references shortcut-less command ${id}`);
  const resolved = label ?? (typeof c.label === "string" ? c.label : undefined);
  if (resolved === undefined) {
    throw new Error(`command ${id} has a label function — keymap entry needs a static label`);
  }
  return {
    keys: formatShortcut(c.shortcut),
    chords: [c.shortcut],
    label: resolved,
    context,
    owner: "registry",
    commandId: id,
  };
}

/** A native row with a live or reachable target. */
function nat(
  keys: string,
  chords: readonly Chord[],
  label: string,
  context: KeyContext = "global",
): ShortcutEntry {
  return { keys, chords, label, context, owner: "native" };
}

/** A native row that dispatches NOTHING, and says why. The reason is a
 *  positional argument rather than an option so that parking a row without
 *  stating a reason is not expressible. */
function park(
  keys: string,
  chords: readonly Chord[],
  label: string,
  context: KeyContext,
  parked: string,
): ShortcutEntry {
  return { keys, chords, label, context, owner: "native", parked };
}

// ── chord builders ────────────────────────────────────────────────────────
// Modifier sets, named so a row reads as its display string does.
const S: ChordMods = { shift: true };
const A: ChordMods = { alt: true };
const C: ChordMods = { cmd: true };
const T: ChordMods = { ctrl: true }; // ⌃
const AS: ChordMods = { alt: true, shift: true };
const CS: ChordMods = { cmd: true, shift: true };
const CA: ChordMods = { cmd: true, alt: true };
const TA: ChordMods = { ctrl: true, alt: true };

const c = (code: string, m: ChordMods = {}): Chord => ({ code, ...m });
/** A chord with no stable `code` — see the `Chord` doc. Four rows only. */
const k = (key: string, m: ChordMods = {}): Chord => ({ key, ...m });
/** "⌃1–8" → eight chords. THE point of the field: a range is prose in `keys`
 *  and eight matchable slots here. */
const digits = (from: number, to: number, m: ChordMods = {}): Chord[] => {
  const out: Chord[] = [];
  for (let n = from; n <= to; n++) out.push({ code: `Digit${n}`, ...m });
  return out;
};
/** "Q W E R T Z U I" → eight physical letter codes. ⚠️ These display strings
 *  come from a German-layout app, so `Z` here is the code `KeyZ` (which types
 *  `y` on a QWERTZ). Every row that uses this builder is parked, so the
 *  ambiguity is recorded rather than resolved — K2 resolves it if it ever
 *  un-parks one. */
const letters = (spaced: string, m: ChordMods = {}): Chord[] =>
  spaced.split(/\s+/).map((ch) => ({ code: `Key${ch.toUpperCase()}`, ...m }));

/**
 * THE list. Section order is Help-window order.
 * Native entries transcribed from HotkeyManager.swift / ScoopyLoopsApp.swift
 * dispatch code (file:line refs in the MB-6 audit) — corrected against the old
 * hand list: ⌘⇧R (never bound) and ⌘⇧L (feature deleted) are gone; ⌘I is the
 * Master FX sheet, not the retired inspector; DJ toggle is ⌘D, not ⌘⇧D; the
 * DJ Tab popover is retired; "9" is the scene-edit latch.
 *
 * Every row's `chords` and `parked` reason are P7-K0a, transcribed from
 * `docs/merge/NAV-SHORTCUTS.md` §6 — the row-by-row audit against HEAD. That
 * table is written in this file's own section order so the two diff line by
 * line; keep them in step.
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
    entries: [reg("session.new"), reg("session.save"), reg("session.saveAs"), reg("session.load")],
  },
  {
    title: "Undo / Redo",
    entries: [reg("edit.undo", "Undo"), reg("edit.redo", "Redo")],
  },
  {
    title: "Pattern Scenes",
    note: "When stopped, all pattern keys switch immediately for editing. Only enabled scenes respond.",
    entries: [
      nat("1–8", digits(1, 8), "Schedule pattern scene 1–8 (during playback)", "compose"),
      park("⇧1–8", digits(1, 8, S), "Add pattern scene to loop queue", "compose",
        "PARK-A: queue-a-scene has no merged verb — `selectScene` carries `immediate` only, and scenesStore's queue flag rides the dead `patternScene` wire"),
      nat("⌥1–8", digits(1, 8, A), "Immediate pattern scene switch", "compose"),
      // "…from start" has no merged flag; the honest merged meaning is plain
      // immediate. Reduced deliberately, not silently (NAV-SHORTCUTS row 13).
      nat("⌥⇧1–8", digits(1, 8, AS), "Immediate pattern scene switch from start", "compose"),
      park("9", [c("Digit9")], "Toggle scene-edit latch (pin edits to the current scene)", "compose",
        "PARK-B: sendSceneToggleLatch → `patternScene`, a method no host answers"),
      park("0", [c("Digit0")], "Toggle master mute group", "compose",
        "PARK-B: sendSceneToggleMute → the same dead `patternScene` wire"),
      park("⌘⇧C", [c("KeyC", CS)], "Copy pattern scene", "compose",
        "PARK-B: sendSceneCopyPattern → dead wire; `copyPattern` is in the gridEdit vocabulary but has no merged handler"),
      park("⌘⇧V", [c("KeyV", CS)], "Paste pattern scene", "compose",
        "PARK-B: sendScenePastePattern → the same dead wire"),
    ],
  },
  {
    title: "Track Selection & Preview",
    entries: [
      nat("↑ / ↓", [c("ArrowUp"), c("ArrowDown")], "Select previous / next track", "grid"),
      nat("⇧↑ / ⇧↓", [c("ArrowUp", S), c("ArrowDown", S)], "Add track to multi-selection", "grid"),
      park("Q W E R T Z U I", letters("Q W E R T Z U I"), "Preview / finger-drum tracks 1–8", "compose",
        "PARK-A: finger-drum preview has no merged verb — `store/preview.ts` is the file-browser audition player and deliberately bypasses the engine"),
    ],
  },
  {
    title: "Track Management",
    entries: [
      // "+ or =" names the two ways to type ONE physical key, so it expands to
      // two chords rather than one — the shifted and the bare Equal.
      nat("+ or =", [c("Equal", S), c("Equal")], "Add new audio track", "compose"),
      reg("track.add"),
      park("⌘⇧T", [c("KeyT", CS)], "Add MIDI Track", "global",
        "PARK-A: no merged create-MIDI-track verb"),
      park("⌘+", [c("Equal", CS)], "Add new MIDI track", "compose",
        "PARK-A: same as ⌘⇧T. (`+` is the shifted Equal — that is what keeps it distinct from ⌘= plane zoom)"),
      park("Delete", [c("Backspace")], "Delete selected track", "grid",
        "PARK-A: `deleteTrack` is in the gridEdit vocabulary but the merged grid is owner-mode with no track-topology path — only `selectTrack` lands. (macOS's Delete key is the code `Backspace`)"),
      park("⌘D", [c("KeyD", C)], "Duplicate selected track", "grid",
        "PARK-A: `duplicateTrack` — same reason as Delete"),
      park("⌥↑ / ⌥↓", [c("ArrowUp", A), c("ArrowDown", A)], "Move selected track up / down", "global",
        "PARK-A: `moveTrackUp/Down` — same reason as Delete"),
      nat("⌘⇧O", [c("KeyO", CS)], "Open sample dialog", "compose"),
    ],
  },
  {
    title: "Grid Navigation",
    entries: [
      park("Tab or -", [c("Tab"), c("Minus")], "Toggle grid lane / controls lane", "compose",
        "PARK-E: the lane toggle is GONE (GridPanel.tsx:2377-2381 says so) — Tab is next-track, and `-` is the deck switch. Stale twice; the label goes with it"),
      park("⇧Tab", [c("Tab", S)], "Switch between Compose and DJ view", "global",
        "PARK-E: there are no views in the merged app — a plane and a compose window. §4 gives ⇧Tab to reverse focus-cycle (P7-N2)"),
      nat("← / →", [c("ArrowLeft"), c("ArrowRight")], "Navigate cells (grid lane)", "grid"),
      nat("⇧← / ⇧→", [c("ArrowLeft", S), c("ArrowRight", S)], "Extend / shrink cell selection", "grid"),
    ],
  },
  {
    title: "Cell Editing",
    entries: [
      nat(".", [c("Period")], "Draw (toggle) focused cell or selected cells", "grid"),
      park("O", [c("KeyO")], "Clear selected cell values (all parameters)", "grid",
        "PARK-A: `clearCellParameter` is in the op vocabulary; the merged owner-mode grid implements no clear-all path"),
      park("⌥← / ⌥→", [c("ArrowLeft", A), c("ArrowRight", A)], "Extend / shrink cell duration", "grid",
        "PARK-E: cell duration moved to `,` (GridPanel.tsx:2568-2574) — arrows are pure navigation on the web surface. The meaning is live on a different chord"),
      park("⌥⇧← / ⌥⇧→", [c("ArrowLeft", AS), c("ArrowRight", AS)], "Toggle pattern playback direction", "grid",
        "PARK-A: `setPlaybackDirection` exists as an op with no keyboard path and no merged handler"),
      park("⌘A", [c("KeyA", C)], "Select all cells", "grid",
        "PARK-A: no merged selection verb spans a track"),
      nat("⌘C", [c("KeyC", C)], "Copy selected cells", "grid"),
      nat("⌘V", [c("KeyV", C)], "Paste cells at focused position", "grid"),
      park("⌘B", [c("KeyB", C)], "Duplicate selected cells", "grid",
        "PARK-A: no merged duplicate-cells op. ⚠️ ⌘B is ALSO live and undeclared as the DJ browser fold (DjPanel.tsx:65-81) on a retired panel — a second claim this table cannot see, because it is not in it"),
      park("⌘E", [c("KeyE", C)], "Make first cell of selection an owner", "grid",
        "PARK-A: owner mode is reached from the track band, not this chord; no merged handler for the op"),
      park("⌘R", [c("KeyR", C)], "Reverse order of selected steps", "grid",
        "PARK-A: merged `setReverse` is per-owner-cell and bound to `j`; there is no range-reverse verb"),
    ],
  },
  {
    title: "Beat Repeat",
    entries: [
      nat("⌃1–8", digits(1, 8, T), "Loop 1–8 steps", "compose"),
      nat("⌃⌥1–8", digits(1, 8, TA), "Loop 9–16 steps", "compose"),
      nat("⌃← / ⌃→", [c("ArrowLeft", T), c("ArrowRight", T)], "Scale beat-repeat length", "compose"),
    ],
  },
  {
    title: "Pitch, Accent & Step Parameters",
    entries: [
      // Two live handlers, one chord, arbitrated by lane (grid vs controls) —
      // modelled as ONE entry with a lane note, never two rows.
      nat("ö", [k("ö")], "Parameter ↓ for focused / selected cells or control", "grid"),
      nat("ä", [k("ä")], "Parameter ↑ for focused / selected cells or control", "grid"),
      park("ü", [k("ü")], "Cycle accent level of last step", "grid",
        "PARK-E: the accent cycle is live on `a` (GridPanel.tsx:2490,2515 → `cycleAccent`); `ü` is the stale scoopyloops chord"),
    ],
  },
  {
    title: "Speed Multipliers (selected track)",
    entries: [
      park("⇧8 (*)", [c("Digit8", S)], "Cycle multiply: 3:2 → 2:1 → 3:1 → 4:1 → 1:1", "grid",
        "PARK-A: `setSpeedMultiplier`/`setSpeedMode` are driven from the track band; no merged cycle verb and no keyboard path"),
      park("⌥*", [c("Digit8", AS)], "Set 2x speed directly", "grid",
        "PARK-A: same as ⇧8 (*)"),
      park("⇧-", [c("Minus", S)], "Cycle divide: 2:3 → 1:2 → 1:3 → 1:4 → 1:1", "grid",
        "PARK-A: same as ⇧8 (*)"),
      park("⌥/", [c("Slash", A)], "Set 0.5x speed directly", "grid",
        "PARK-A: same as ⇧8 (*)"),
      park("⌥+ / ⌥-", [c("Equal", AS), c("Minus", A)], "Increase / decrease step count by 1", "grid",
        "PARK-A: `setStepCount` exists as an op, driven from the band; no keyboard path"),
      park("⌥⇧+ / ⌥⇧-", [c("Equal", AS), c("Minus", AS)], "Double / halve step count", "grid",
        "PARK-A: same as ⌥+ / ⌥-. ⚠️ `⌥+` and `⌥⇧+` are the SAME keystroke once expanded — see KNOWN_COLLISIONS"),
    ],
  },
  {
    title: "Pattern Shift",
    entries: [
      park("⌘[", [c("BracketLeft", C)], "Shift all tracks left by one step", "global",
        "PARK-A: Shift Pattern waits on its deferred reducer increment (registry.ts:19-20, MB-1b2) — never built"),
      park("⌘⇧[", [c("BracketLeft", CS)], "Shift selected track left by one step", "global",
        "PARK-A: same as ⌘[ — never built"),
      park("⌘]", [c("BracketRight", C)], "Shift all tracks right by one step", "global",
        "PARK-A: same as ⌘[ — never built"),
      park("⌘⇧]", [c("BracketRight", CS)], "Shift selected track right by one step", "global",
        "PARK-A: same as ⌘[ — never built"),
    ],
  },
  {
    title: "Paint Mode (Arpeggio / Intervals)",
    entries: [
      park("⇧Drag", [], "Paint descending pitch values on cells", "grid",
        "PARK-C: a pointer gesture, not a chord — it carries none and can never be dispatched. Stays in the map as documentation"),
      park("⌥⇧Drag", [], "Paint ascending pitch values on cells", "grid",
        "PARK-C: same as ⇧Drag — a pointer gesture"),
      nat("⌥.", [c("Period", A)], "Paint descending on selected cells", "grid"),
      nat("⌥⇧.", [c("Period", AS)], "Paint ascending on selected cells", "grid"),
      park("⌘1–4", digits(1, 4, C), "Switch pitch interval preset bank", "compose",
        "PARK-A: pitch interval preset banks have no merged store — and ⌘-digits are host-reserved (§4), so this is parked twice over"),
    ],
  },
  {
    title: "Recording",
    entries: [
      park("P", [c("KeyP")], "Arm / disarm live recording", "compose",
        "PARK-A: live pattern recording (arm/disarm) has no merged verb"),
      park("O (hold, recording)", [c("KeyO")], "Erase step under playhead while recording", "compose",
        "PARK-A: depends on `P`. ⚠️ the display encodes a MODE, which no chord can carry — the mode lives in the label, never in `chords`"),
      park("Y", [c("KeyY")], "Toolbar recorder: record / stop (take window opens)", "compose",
        "PARK-A: the toolbar recorder and its take window are not in the merged tree. (The plane's looper `slRecord` is a DIFFERENT feature with its own door — do not conflate)"),
    ],
  },
  {
    title: "Track Quick Actions (selected track)",
    entries: [
      nat("⌥A", [c("KeyA", A)], "Toggle mute", "grid"),
      nat("⌥S", [c("KeyS", A)], "Toggle solo", "grid"),
      nat("#", [k("#")], "Toggle track launch (respects quantize)", "grid"),
      park("V", [c("KeyV")], "Toggle reverse transport", "compose",
        "PARK-E: 'reverse transport' is the deck verb `setReverse`, which §3.2 puts on `Q`. `V` also collides with the FX pads and the note keyboard"),
    ],
  },
  {
    title: "View & Panels",
    entries: [
      park("⌘M", [c("KeyM", C)], "Toggle Modifiers section", "global",
        "PARK-A: the Modifiers fold is a compose-panel affordance with no merged toggle (⌘M also minimises the window on macOS)"),
      park("⌘⌥M", [c("KeyM", CA)], "Toggle Modulation system", "global",
        "PARK-A: the modulation system is not in the merged tree"),
      park("⌘I", [c("KeyI", C)], "Toggle Master FX sheet (compose)", "compose",
        "PARK-A: the Master FX sheet is not in the merged tree — P6-2's FX returns are a different surface"),
      park("⌘⇧M", [c("KeyM", CS)], "Master FX…", "global",
        "PARK-A: same as ⌘I — not in the merged tree"),
      park("F1–F4", [c("F1"), c("F2"), c("F3"), c("F4")], "Open FX slot editor 1–4", "global",
        "PARK-A: the FX slot editors have no home — P11-1's 'FX 1–4 need a named interim home' is this same gap seen from the panel side"),
      nat("⌘= / ⌘-", [c("Equal", C), c("Minus", C)], "Zoom track view in / out", "compose"),
      nat("Esc", [c("Escape")], "Close open overlay panel", "global"),
    ],
  },
  {
    title: "DJ Mode",
    entries: [
      // View toggle: ⇧Tab (listed under Grid Navigation) — dj.toggleView is
      // deliberately keyless since the ⌘D-shadows-duplicate resolution.
      park("⌘⇧1 / 2 / 3", digits(1, 3, CS), "Send session to Deck A / B / C", "global",
        "PARK-A: a strip IS the deck — the merged equivalent is the strip's own `library ▾` or a drop. No global send-to-deck verb exists"),
      park("⌘⌥3", [c("Digit3", CA)], "Enable Deck C", "global",
        "PARK-E: in the merged app a deck exists because a strip exists — superseded by strip creation"),
      // ⚠️ The deck-B halves below (`F`, `J`, `G H`) are FREED, not reassigned
      // (§3.2) — they keep their chord here because `keys` still shows the
      // pair. P7-K2 splits the pair and parks the freed half; doing it here
      // would be K2's ruling made by a data edit.
      nat("Q / W / E", letters("Q W E"), "Deck A: reverse-play / play / cue-restart", "dj"),
      park("A / S / D", letters("A S D"), "Deck B: reverse-play / play / cue-restart", "dj",
        "PARK-E: the deck-B half of the pair, collapsed onto the focused strip by D-8. A S D are freed, not reassigned"),
      nat("R / F", [c("KeyR"), c("KeyF")], "Deck A / B: hold to play, release pauses, next hold resumes", "dj"),
      nat("U / J", [c("KeyU"), c("KeyJ")], "Deck A / B: tape-reverse hold (reverts on release)", "dj"),
      nat("T Y / G H", letters("T Y G H"), "Deck A / B: nudge down / up (hold)", "dj"),
      nat("1–4 / 5–8", digits(1, 8), "Launch scene on Deck A / Deck B (⌥: upper bank)", "dj"),
      park("⌘⌥D", [c("KeyD", CA)], "Double active deck to the other deck", "dj",
        "PARK-A: with N strips and no A/B there is no 'other deck' to mean"),
      park("-", [c("Minus")], "Switch active deck", "dj",
        "PARK-E: Tab cycles focus (§4); `-` is freed"),
      nat("⌥Space", [c("Space", A)], "Global play / stop (all decks)", "dj"),
      nat("⌥9 / ⌥0", [c("Digit9", A), c("Digit0", A)], "Sync BPM down / up by 1", "dj"),
      park("⌥⌘`", [c("Backquote", CA)], "Focus playlist (enable playlist hotkeys)", "dj",
        "PARK-A: no playlist exists in the merged tree"),
    ],
  },
  {
    title: "File Browser (while focused)",
    entries: [
      nat("↑ ↓ ← →", [c("ArrowUp"), c("ArrowDown"), c("ArrowLeft"), c("ArrowRight")], "Navigate the browser", "browserFocus"),
      park("⌥← / ⌥→", [c("ArrowLeft", A), c("ArrowRight", A)], "Load selected session to Deck A / B", "browserFocus",
        "PARK-E: a session loads into a STRIP, by drop or the strip's `library ▾`. No A/B destination exists"),
    ],
  },
  {
    title: "Musical Keyboard Mode",
    note: "While active, letter keys are absorbed (no finger-drumming); Z/X/C/V override the pad shortcuts.",
    entries: [
      park("⌘K", [c("KeyK", C)], "Toggle musical keyboard mode", "global",
        "PARK-A: `setNoteKeyboardActive` is the flag and NOTHING calls it in the merged tree — the mode can be read but never entered. Un-parks the moment a caller exists"),
      park("A W S E D F T G Y H U J K O L P ; '",
        [...letters("A W S E D F T G Y H U J K O L P"), c("Semicolon"), c("Quote")],
        "Piano keys (two octaves)", "noteKeyboard",
        "PARK-A: 18 chords, every one depending on ⌘K — the mode is unreachable, so they are"),
      park("Z", [c("KeyZ")], "Octave down", "noteKeyboard", "PARK-A: depends on ⌘K, unreachable"),
      park("X", [c("KeyX")], "Octave up", "noteKeyboard", "PARK-A: depends on ⌘K, unreachable"),
      park("C / V", [c("KeyC"), c("KeyV")], "Velocity down / up", "noteKeyboard",
        "PARK-A: depends on ⌘K, unreachable"),
    ],
  },
  {
    title: "Sample Pads & Chops",
    entries: [
      park("Z / X / C / V", letters("Z X C V"), "Trigger FX pads 1–4", "compose",
        "PARK-A: the FX pads have no merged verb. P11-1's 'FX 1–4 need a named interim home' is the same gap from the panel side"),
      park("⌥Q…⌥I", letters("Q W E R T Z U I", A), "Preview chop slots 1–8", "compose",
        "PARK-A: `setChopPoint`/`setChopCount`/`resetChopPoint` exist as ops from the track band; there is no preview-a-slot verb"),
    ],
  },
];

/**
 * Known, deliberate double-claims — each is a real finding this file made
 * visible; resolving them is MB-7 / decision-batch work, not the keymap's.
 *
 * ⚠️ KEYED BY `chordId`, NOT by the display string (P7-K0a). Before the chord
 * expansion the collision test compared whole display tokens, so "Q W E R T Z
 * U I" and "Z / X / C / V" were simply two different strings and the shared
 * `Z` was invisible. All three entries below are in exactly that class — the
 * one `keymap.test.ts:6-9` said it could not see.
 *
 * Remove an entry the day its collision is actually resolved; never add one
 * without a comment saying who shadows whom.
 */
export const KNOWN_COLLISIONS: ReadonlySet<string> = new Set([
  // compose: finger-drum preview (row 20, PARK-A) vs FX pad 1 (row 98,
  // PARK-A). Both dead, so nothing is shadowed TODAY — but they are the same
  // physical key and only one can ever win.
  "KeyZ",
  // compose: reverse transport (row 70, PARK-E) vs FX pad 4 (row 98, PARK-A).
  // NAV-SHORTCUTS names this one in the audit itself ("`V` also collides").
  "KeyV",
  // grid: "⌥+" (step count +1, row 53) and "⌥⇧+" (double step count, row 54)
  // are the SAME keystroke — `+` is already the shifted Equal. Two display
  // strings, one chord: an ambiguity in the scoopyloops-era Help text that
  // only expansion could expose. Both PARK-A, so nothing is shadowed today;
  // whichever un-parks first must pick a different chord for the other.
  "⌥⇧Equal",
]);
