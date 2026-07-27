/**
 * P5-06 UNDO — the pattern domain's undo history, owned by TS.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS REPLACES SWIFT'S, rather than deferring to it (a full review of the old system):
 *
 *   1. Swift's `.pattern` undo restores a STRICT SUBSET of what the flip writes. `PatternData`
 *      carries the cell arrays; it does NOT carry gain, volume, pan, tone, toneQ, filter mode,
 *      sends, choke, voice mode, sample window, chops, loop points, stretch flags, playback mode
 *      or owner attack/gate — and `PatternUndoPreservedTrackState` then DELIBERATELY re-stamps 18
 *      more (speed, locator, stereo, output assign, direction, glide%, pre-silence…) back to
 *      their current values. So after the flip every track-row edit recorded an entry that
 *      restored NOTHING. ⌘Z popped, wrote back identical data, and looked broken. It was.
 *
 *   2. Most of the app was NEVER undoable. gain · volume · pan · tone · sends · choke · voice ·
 *      pitch · fine-tune · mute · sample load · sample window · chops · loop · stretch ·
 *      playback mode · speed · free-rate · locator — not one pushed an undo entry. Undo covered
 *      cells and almost nothing else. **Everything TS owns is undoable here.** That is the
 *      improvement, and it is the reason to own it rather than patch it.
 *
 *   3. Swift's bracket is unsafe: `beginUndoActivity` pushes UNCONDITIONALLY (so a gesture that
 *      changes nothing leaves a no-op entry you have to press ⌘Z twice to get past), and
 *      `endUndoActivity` only clears a flag — so a LOST `endUndo` (a cancelled drag) leaves
 *      `isBatchUndoActive` true and silently kills all further recording, forever. Here a bracket
 *      records only if the state actually CHANGED, and a lost end cannot wedge anything.
 *
 *   4. Swift snapshots the WHOLE DOCUMENT per entry — all tracks × all cell arrays × all EIGHT
 *      pattern scenes — so undoing an edit made in scene A also reverted every edit made in
 *      scenes B–H since. Here an entry is one track's pattern, held by reference (the reducers
 *      are immutable, so a snapshot is a pointer, not a copy).
 *
 * WHAT STAYS SWIFT'S: topology (add/delete/duplicate/move track) and global (bpm, settings
 * scenes). Those are not TS's to own.
 *
 * ⚠️ MB-1 — HOW THE TWO HISTORIES INTERLEAVE (this used to be wrong, and the comment that used
 * to sit here asserted the opposite):
 *
 *   The old rule was "drain TS's stack, then fall through to Swift's", with the claim that this
 *   kept the combined history in order. **It does not.** It only holds if every Swift-side edit is
 *   OLDER than every TS edit — and the Pattern menu breaks that on the first click: draw a cell
 *   (TS), Clear Grid (Swift), ⌘Z → the old code undid the *cell edit*, because it drained TS
 *   first. The clear was only reachable after every TS entry had been popped.
 *
 *   So a Swift-side edit now takes its PLACE in this stack, as a marker (`kind: "swift"`). TS
 *   cannot replay a Swift edit — it has no payload for it — so the marker records a POSITION, not
 *   a state: popping one delegates to `swiftUndo`, which pops Swift's own stack. One ordered
 *   timeline, two engines behind it. Markers are pushed from Swift's undo choke point
 *   (`BeatSequencer.announceSwiftOwnedEdit`), so marker count tracks Swift's entry count.
 * ────────────────────────────────────────────────────────────────────────────────────────────
 */
import type { GridPatternState } from "../../protocol/schema";

/** An edit TS made and can replay: it holds both sides of the pattern. */
export interface PatternUndoEntry {
  kind: "pattern";
  trackIndex: number;
  before: GridPatternState;
  after: GridPatternState;
  /** What the user did — so the history is inspectable rather than a stack of anonymous blobs. */
  label: string;
}

/**
 * An edit SWIFT made (a native menu op, a hotkey, the track clipboard, bpm, topology).
 *
 * It carries no state, and that is deliberate: TS does not own these domains and must not pretend
 * to restore them. What the entry buys is its POSITION — it is the reason ⌘Z can walk a mixed
 * history in the order the user actually worked, instead of undoing all of one kind first.
 */
export interface SwiftUndoEntry {
  kind: "swift";
  /** The Swift undo scope this delegates to: "pattern" | "topology" | "global". */
  label: string;
}

export type UndoEntry = PatternUndoEntry | SwiftUndoEntry;

/**
 * ONE ordered stack, not one per track.
 *
 * The shadow store's COW undo (P5-04) was keyed by track index, which cannot express "⌘Z walks
 * your edits in the order you made them" — the single property Swift's design got right and the
 * one thing a per-track stack structurally cannot do. Order is the whole point of undo.
 */
const undoStack: UndoEntry[] = [];
const redoStack: UndoEntry[] = [];

/** Deep, because it is cheap: entries hold immutable pattern objects by REFERENCE. */
export const MAX_UNDO = 256;

/** Open gesture brackets, per track. A drag is ONE undo entry, not one per pointer-move. */
const brackets = new Map<number, GridPatternState>();

export function undoDepth(): number {
  return undoStack.length;
}
export function redoDepth(): number {
  return redoStack.length;
}

/** Peek the top entry's label — for a menu that can say "Undo Draw cell" rather than "Undo". */
export function undoLabel(): string | null {
  return undoStack[undoStack.length - 1]?.label ?? null;
}

export function resetUndo(): void {
  undoStack.length = 0;
  redoStack.length = 0;
  brackets.clear();
}

/**
 * Open a gesture bracket. Idempotent — a second begin on the same track is ignored, so the
 * pointer handlers can call it freely.
 *
 * Unlike Swift's, this records NOTHING yet. Swift pushed an entry at `begin`, which is why a
 * click that changed nothing still cost you a ⌘Z press.
 */
export function beginGesture(trackIndex: number, state: GridPatternState): void {
  if (!brackets.has(trackIndex)) brackets.set(trackIndex, state);
}

/**
 * Close the bracket and record ONE entry — but only if the pattern actually changed.
 *
 * `same` is the caller's equality (canonical serialization). A no-op gesture leaves no trace:
 * the single most common complaint about the old undo was having to press ⌘Z several times to
 * get past entries that did nothing.
 */
export function endGesture(
  trackIndex: number,
  state: GridPatternState,
  label: string,
  same: (a: GridPatternState, b: GridPatternState) => boolean,
): void {
  const before = brackets.get(trackIndex);
  brackets.delete(trackIndex);
  if (!before || same(before, state)) return; // nothing happened — record nothing
  push({ kind: "pattern", trackIndex, before, after: state, label });
}

/**
 * MB-1 — record that SWIFT edited the document, at this point in the timeline.
 *
 * Called when the page is told a native mutation happened (`swiftEdit` event, emitted from
 * Swift's undo choke point). It records no state — see `SwiftUndoEntry`. An open gesture bracket
 * is left alone: a native op cannot land inside a pointer drag.
 */
export function pushSwiftMarker(label: string): void {
  push({ kind: "swift", label });
}

/** Record a DISCRETE edit (no gesture bracket around it). */
export function recordEdit(
  trackIndex: number,
  before: GridPatternState,
  after: GridPatternState,
  label: string,
  same: (a: GridPatternState, b: GridPatternState) => boolean,
): void {
  // A discrete edit inside an open bracket belongs to the gesture, not to itself.
  if (brackets.has(trackIndex)) return;
  if (same(before, after)) return;
  push({ kind: "pattern", trackIndex, before, after, label });
}

function push(entry: UndoEntry): void {
  undoStack.push(entry);
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  // A new edit invalidates the redo future — same as Swift, and the only sane semantics.
  redoStack.length = 0;
}

/** Pop one edit. Returns the entry to APPLY (`before`), or null when the stack is empty. */
export function popUndo(): UndoEntry | null {
  const e = undoStack.pop();
  if (!e) return null;
  redoStack.push(e);
  return e;
}

/** Pop one redo. Returns the entry to APPLY (`after`), or null. */
export function popRedo(): UndoEntry | null {
  const e = redoStack.pop();
  if (!e) return null;
  undoStack.push(e);
  return e;
}
