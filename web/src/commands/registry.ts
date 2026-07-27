/**
 * MB-2 — THE COMMAND REGISTRY: one definition, N renderers.
 *
 * The menu bar rotted because every item's label, key equivalent, enablement
 * AND action were declared in SwiftUI `Commands` against views the web panels
 * replaced one at a time (menubar.md §1). This module is the fix's foundation:
 * the app's command surface as DATA, defined once, rendered by whichever shell
 * is present — macOS NSMenu (MB-4), the browser's DOM menu bar (P8-7), Tauri
 * later. The three rot mechanisms die by construction here: `checked` is a
 * predicate over state the page owns, so there is no notification to miss, no
 * UserDefaults key to forget to bridge, and no sink to omit.
 *
 * ⚠️ SCOPE (deliberate): only commands whose wire EXISTS today are declared.
 * The Session menu (New/Save/Save As/Load/Recent/Bounce) has no SLP commands
 * yet — that is MB-5, "the bulk of the phase's work" — and a registry entry
 * whose `run` cannot run is exactly the silent-menu-item failure this phase
 * exists to stop shipping. Until MB-5 lands, Swift keeps rendering the Session
 * menu natively; the two coexist because a menu SECTION is the unit of
 * adoption, not the whole bar. Shift Pattern (⌘[/⌘]) likewise waits for its
 * deferred reducer increment (MB-1b2).
 *
 * @see docs/migration/panels/menubar.md §5 (the model) · §10 (what survives)
 */

/** A shortcut, declared once. macOS binds it as an NSMenu key equivalent
 * (consumed before the web view ever sees the keystroke); the browser shell
 * binds it as a `KeyboardEvent.code` matcher. `code` is the PHYSICAL key
 * (layout-independent), same convention as `forwardKey`. */
export interface KeyEquivalent {
  code: string; // e.g. "KeyZ", "Space", "Digit0"
  cmd?: true;
  shift?: true;
  alt?: true;
  ctrl?: true;
}

/** Menu sections, in bar order. A section is the unit of shell adoption:
 * a shell renders the sections the registry serves and keeps its native
 * rendering for the ones it does not (Session, until MB-5). */
export const MENU_SECTIONS = ["Session", "Edit", "Transport", "Track", "Pattern", "DJ"] as const;
export type MenuSection = (typeof MENU_SECTIONS)[number];

/** Stable wire identities — `menuCommand {id}` (MB-3) carries these. Renaming
 * one is a schema-visible change; treat the strings as frozen. */
export type CommandId =
  | "session.new"
  | "session.save"
  | "session.saveAs"
  | "session.load"
  | "session.exportZip"
  | "session.bounce"
  | "edit.undo"
  | "edit.redo"
  | "transport.playPause"
  | "transport.stop"
  | "transport.restart"
  | "track.add"
  | "pattern.clearAll"
  | "dj.toggleView";

/**
 * Everything a command may read or drive. The page that hosts the registry
 * provides this — commands never import stores or links themselves, which is
 * what keeps the registry renderable (and testable) with no app running.
 */
export interface CommandState {
  /** TS undo depth (undoStore) — Swift markers included. */
  canUndo: boolean;
  canRedo: boolean;
  /** What ⌘Z would undo, for the menu label ("Undo Draw cell"). */
  undoLabel: string | null;
  isPlaying: boolean;
  djMode: boolean;
  /** The ACTIVE sequencer's bounce/output-record state (toolbar topic, v79). */
  isBouncing: boolean;
  isOutputRecording: boolean;
  /** Actions — each backed by an EXISTING wire (see the declaration table). */
  // Session lifecycle (menuSession, v78) — the dialogs stay shell calls
  // inside the Swift handler; these carry only the INTENT.
  sessionNew: () => void;
  sessionSave: () => void;
  sessionSaveAs: () => void;
  sessionLoad: () => void;
  /** Writes the zipped session (P8-0b) — the one file the browser imports.
   * Swift owns the dialogs, including the save-first fallback when unsaved. */
  sessionExportZip: () => void;
  /** One intent — Swift resolves trigger-vs-cancel from CURRENT isBouncing. */
  sessionBounceToggle: () => void;
  performUndo: (redo: boolean) => void;
  transportPlay: () => void;
  transportStop: () => void;
  transportRestart: () => void;
  addTrack: () => void;
  /** Opens the page's confirm, then clears every track (gridEdit clearGrid —
   * the MB-1b reducer — per track). The CONFIRM lives in the page: a registry
   * must never own UI, only intent. */
  requestClearAll: () => void;
  toggleDjMode: () => void;
}

export interface Command {
  id: CommandId;
  /** May be a function — Play/Pause and Switch to DJ/Compose flip theirs. */
  label: string | ((s: CommandState) => string);
  shortcut?: KeyEquivalent;
  section: MenuSection;
  enabled?: (s: CommandState) => boolean;
  checked?: (s: CommandState) => boolean;
  run: (s: CommandState) => void;
}

/** THE definition. Order within a section is menu order. */
export const COMMANDS: readonly Command[] = [
  // --- Session (MB-5 slice 1; Bounce + Recent stay native for now:
  // stateful label / submenu semantics respectively) --------------------
  {
    id: "session.new",
    label: "New Session",
    shortcut: { code: "KeyN", cmd: true },
    section: "Session",
    run: (s) => s.sessionNew(),
  },
  {
    id: "session.save",
    label: "Save Session",
    shortcut: { code: "KeyS", cmd: true },
    section: "Session",
    run: (s) => s.sessionSave(),
  },
  {
    id: "session.saveAs",
    label: "Save Session As…",
    shortcut: { code: "KeyS", cmd: true, shift: true },
    section: "Session",
    run: (s) => s.sessionSaveAs(),
  },
  {
    id: "session.load",
    label: "Load Session…",
    shortcut: { code: "KeyO", cmd: true },
    section: "Session",
    run: (s) => s.sessionLoad(),
  },
  {
    id: "session.exportZip",
    label: "Export Zipped Session…",
    section: "Session",
    run: (s) => s.sessionExportZip(),
  },
  {
    id: "session.bounce",
    label: (s) => (s.isBouncing ? "Cancel Pattern Bounce" : "Bounce Pattern to AIFF…"),
    section: "Session",
    // Disabled only when a full-mix output recording holds the bus and no
    // bounce is running (native rule); while bouncing it stays enabled so
    // Cancel is reachable.
    enabled: (s) => s.isBouncing || !s.isOutputRecording,
    run: (s) => s.sessionBounceToggle(),
  },
  // --- Edit -----------------------------------------------------------
  {
    id: "edit.undo",
    label: (s) => (s.undoLabel ? `Undo ${s.undoLabel}` : "Undo"),
    // ⌘Z stays an NSMenu key equivalent on macOS (WebGridBinding already
    // delegates it to the page — MB-4 generalizes those hardcoded strings).
    shortcut: { code: "KeyZ", cmd: true },
    section: "Edit",
    enabled: (s) => s.canUndo,
    run: (s) => s.performUndo(false),
  },
  {
    id: "edit.redo",
    label: "Redo",
    shortcut: { code: "KeyZ", cmd: true, shift: true },
    section: "Edit",
    enabled: (s) => s.canRedo,
    run: (s) => s.performUndo(true),
  },
  // --- Transport (shortcut carriers — the real controls are on screen).
  // Native-parity keys: Space rides the single-space rule via `menuTransport`
  // (an NSMenu key equivalent is consumed before the web view sees the key,
  // so on macOS the menu IS the delivery mechanism for these).
  {
    id: "transport.playPause",
    label: (s) => (s.isPlaying ? "Pause" : "Play"),
    shortcut: { code: "Space" },
    section: "Transport",
    run: (s) => s.transportPlay(),
  },
  {
    id: "transport.stop",
    label: "Stop",
    shortcut: { code: "Period", cmd: true },
    section: "Transport",
    enabled: (s) => s.isPlaying,
    run: (s) => s.transportStop(),
  },
  {
    id: "transport.restart",
    label: "Restart",
    shortcut: { code: "Enter" },
    section: "Transport",
    run: (s) => s.transportRestart(),
  },
  // --- Track -----------------------------------------------------------
  {
    id: "track.add",
    label: "Add Sampler Track",
    shortcut: { code: "KeyT", cmd: true },
    section: "Track",
    run: (s) => s.addTrack(),
  },
  // --- Pattern ----------------------------------------------------------
  {
    id: "pattern.clearAll",
    label: "Clear All…", // the ellipsis is the confirm's promise
    section: "Pattern",
    run: (s) => s.requestClearAll(),
  },
  // --- DJ ----------------------------------------------------------------
  {
    id: "dj.toggleView",
    label: (s) => (s.djMode ? "Switch to Compose Mode" : "Switch to DJ Mode"),
    // No shortcut: ⇧Tab (native, HotkeyManager) owns the view toggle. The ⌘D
    // this carried shadowed HotkeyManager's duplicate-track — the collision
    // the MB-6 keymap surfaced; user resolved it this way 2026-07-21.
    section: "DJ",
    run: (s) => s.toggleDjMode(),
  },
];

const byId = new Map<CommandId, Command>(COMMANDS.map((c) => [c.id, c]));

export function command(id: CommandId): Command {
  const c = byId.get(id);
  if (!c) throw new Error(`unknown command id: ${id}`);
  return c;
}

/** Run a command by wire id (the `menuCommand` handler's entry point).
 * Disabled commands are REFUSED here, not just greyed in the tree — a shell
 * whose enablement went stale must not execute through it. */
export function runCommand(id: CommandId, s: CommandState): boolean {
  const c = command(id);
  if (c.enabled && !c.enabled(s)) return false;
  c.run(s);
  return true;
}

/** One rendered menu entry — the shape MB-3's `menuTree` publish carries.
 * (design/ContextMenu.tsx's MenuItem gains `id`/`shortcut`/`submenu` in MB-3;
 * this stays structurally compatible with it.) */
export interface MenuTreeItem {
  id: CommandId;
  label: string;
  shortcut?: KeyEquivalent;
  enabled: boolean;
  checked: boolean;
}

export interface MenuTreeSection {
  section: MenuSection;
  items: MenuTreeItem[];
}

/** Evaluate the registry against the current state → the renderable tree.
 * Pure and cheap; shells call it at menu-open time (macOS `menuNeedsUpdate:`),
 * never on a state tick, so predicates cost nothing at rest.
 *
 * `sections` restricts the tree to the sections the CALLING HOST can honestly
 * evaluate — a section is the unit of adoption, and publishing a section whose
 * state the host cannot see (the compose grid does not know `djMode`) would
 * ship a wrong label, which is the exact rot this registry replaces. */
export function menuTree(
  s: CommandState,
  sections: readonly MenuSection[] = MENU_SECTIONS,
): MenuTreeSection[] {
  return MENU_SECTIONS.filter((sec) => sections.includes(sec))
    .map((section) => ({
      section,
      items: COMMANDS.filter((c) => c.section === section).map((c) => ({
        id: c.id,
        label: typeof c.label === "function" ? c.label(s) : c.label,
        ...(c.shortcut ? { shortcut: c.shortcut } : {}),
        enabled: c.enabled ? c.enabled(s) : true,
        checked: c.checked ? c.checked(s) : false,
      })),
    }))
    .filter((sec) => sec.items.length > 0);
}
