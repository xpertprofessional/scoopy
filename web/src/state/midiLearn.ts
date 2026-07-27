import { create } from "zustand";
import { MidiLearnState, type MidiLearnMapping } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import type { MenuItem } from "../design/ContextMenu.tsx";

/**
 * MIDI learn for web controls (CM-2). Mirrors the "midiLearn" topic and sends
 * learn INTENTS — Swift stays the owner of the learnId grammar, the value range
 * and the write, exactly as it is for a native `DraggableNumberBox`.
 *
 * The one thing to understand here: **track mappings are track-agnostic.**
 * Native `createMapping` discards the track UUID and stores `.trackParam(token)`,
 * so a CC bound to "volume" fires on whatever track is SELECTED at the time.
 * A box therefore identifies itself by (kind, key) — never by UUID — and
 * "Mapped: CC12" correctly shows on EVERY track's volume box once one is bound.
 * That is native behaviour, not a bug.
 */

/** How a web control names itself to `MIDILearnSystem`. */
export type LearnTarget =
  | { kind: "trackParam"; token: string; trackIndex: number; deck?: number }
  | { kind: "singleton"; learnId: string };

const EMPTY: MidiLearnState = {
  isLearning: false,
  learningKind: null,
  learningKey: null,
  learningTrackIndex: null,
  mapped: [],
};

interface Store {
  state: MidiLearnState;
  link: EngineLink | null;
}

export const useMidiLearnStore = create<Store>(() => ({ state: EMPTY, link: null }));

/** Subscribe the store to the "midiLearn" topic. Returns the unsubscribe. */
export function attachMidiLearn(link: EngineLink): () => void {
  useMidiLearnStore.setState({ link });
  const off = link.onUiState("midiLearn", (raw) => {
    const parsed = MidiLearnState.safeParse(raw);
    if (!parsed.success) {
      console.error("midiLearn rejected:", parsed.error.issues, raw);
      return;
    }
    useMidiLearnStore.setState({ state: parsed.data });
  });
  link.command("getUiState", { topic: "midiLearn" }).catch(() => {});
  return () => {
    off();
    useMidiLearnStore.setState({ link: null, state: EMPTY });
  };
}

/** The key a target resolves to in `MidiLearnState.mapped`. */
export function learnKey(t: LearnTarget): string {
  return t.kind === "singleton" ? t.learnId : t.token;
}

/** The mapping this control resolves to, if any. */
export function mappingFor(
  state: MidiLearnState,
  t: LearnTarget,
): MidiLearnMapping | undefined {
  const key = learnKey(t);
  return state.mapped.find((m) => m.kind === t.kind && m.key === key);
}

/** Is THIS control the one currently armed? */
export function isLearningTarget(state: MidiLearnState, t: LearnTarget): boolean {
  if (!state.isLearning) return false;
  if (state.learningKind !== t.kind || state.learningKey !== learnKey(t)) return false;
  // A token matches every row, so the armed row must match too — otherwise all
  // 16 volume boxes would light up during one learn.
  if (t.kind === "trackParam") return state.learningTrackIndex === t.trackIndex;
  return true;
}

/**
 * The `midiLearn` Command payload. Pure, so the wire is testable: Swift resolves
 * a trackParam against a deck's sequencer, and omitting `deck` silently targets
 * the compose one (CM-6).
 */
export function learnParams(
  op: "start" | "cancel" | "clear",
  t?: LearnTarget,
): Record<string, unknown> {
  const params: Record<string, unknown> = { op };
  if (!t) return params;
  params.kind = t.kind;
  params.key = learnKey(t);
  if (t.kind === "trackParam") {
    params.trackIndex = t.trackIndex;
    if (t.deck !== undefined) params.deck = t.deck;
  }
  return params;
}

function send(op: "start" | "cancel" | "clear", t?: LearnTarget) {
  const { link } = useMidiLearnStore.getState();
  if (!link) return;
  link.command("midiLearn", learnParams(op, t)).catch(() => {});
}

export const startLearn = (t: LearnTarget) => send("start", t);
export const cancelLearn = () => send("cancel");
export const clearLearn = (t: LearnTarget) => send("clear", t);

/**
 * The MIDI section of a box's right-click menu — an exact mirror of native
 * `MIDILearnContextMenuContent` (DraggableNumberBox.swift:985), including the
 * non-interactive "Mapped: CC{n}" readout. Pure, so it is testable without a DOM.
 */
export function buildMidiLearnItems(
  t: LearnTarget,
  state: MidiLearnState,
  actions: {
    start: (t: LearnTarget) => void;
    cancel: () => void;
    clear: (t: LearnTarget) => void;
  } = { start: startLearn, cancel: cancelLearn, clear: clearLearn },
): MenuItem[] {
  const items: MenuItem[] = [];
  const mapping = mappingFor(state, t);
  if (mapping) {
    items.push({ kind: "info", label: `Mapped: CC${mapping.ccNumber}` });
    items.push({
      kind: "item",
      label: "Clear MIDI Mapping",
      onSelect: () => actions.clear(t),
    });
    items.push({ kind: "sep" });
  }
  if (state.isLearning) {
    items.push({
      kind: "item",
      label: "Cancel MIDI Learning",
      onSelect: () => actions.cancel(),
    });
  } else {
    items.push({ kind: "item", label: "Learn MIDI", onSelect: () => actions.start(t) });
  }
  return items;
}
