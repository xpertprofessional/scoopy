import type { GridTrackState } from "../../protocol/schema.ts";
import { chordShortLabel } from "./chordLibrary.ts";

/**
 * Pure grid geometry/model functions (panels/grid.md §2).
 * THE owner-resolution guard lives here — exactly one implementation
 * (Swift has ≥5 duplicated inline copies; see grid.md §4.3).
 */

export interface ResolvedCell {
  owner: number; // owner step index
  span: number; // clamped visual span from the owner
  offsetInCell: number; // how far `step` sits into the cell
  viaWrap: boolean;
}

/**
 * Which cell covers `step`? Backward owner scan + wrap continuation
 * (ports ContentView stepCellContent :2758–2788 semantics).
 */
export function resolveCellAt(
  steps: boolean[],
  cellLengths: number[],
  wrapSourceStep: number | null,
  step: number,
): ResolvedCell | null {
  const n = steps.length;
  if (step < 0 || step >= n) return null;
  // Direct/backward scan: nearest owner at or before `step` whose span covers it.
  for (let o = step; o >= 0; o--) {
    if (!steps[o]) continue;
    const span = Math.max(1, cellLengths[o] ?? 1);
    if (o + span > step) {
      return { owner: o, span: Math.min(span, n - o), offsetInCell: step - o, viaWrap: false };
    }
    break; // nearest owner doesn't cover: nothing earlier can (spans are contiguous)
  }
  // Wrap continuation: an owner near the end whose span passes the pattern end
  // covers steps from 0 (wrapSourceStep points at it).
  if (wrapSourceStep !== null && steps[wrapSourceStep]) {
    const span = Math.max(1, cellLengths[wrapSourceStep] ?? 1);
    const wrapLen = wrapSourceStep + span - n; // steps covered after wrapping
    if (wrapLen > 0 && step < wrapLen) {
      return {
        owner: wrapSourceStep,
        span: wrapLen,
        offsetInCell: n - wrapSourceStep + step,
        viaWrap: true,
      };
    }
  }
  return null;
}

/**
 * Native regExtendedCellOwner (ContentView :2720–2746): the resize-grab
 * target for a REG press. Returns the covering cell's owner ONLY when `step`
 * is a covered NON-OWNER step — pressing the owner itself is the
 * fresh-anchor path (drag resizes from it, stationary release REMOVES the
 * whole cell; a grabbed extension never auto-removes). With the Swift wrap
 * encoding the continuation is a real cell at step 0, so the forward scan
 * covers steps 1..wrapLen−1 via cell 0; the wrap branch (resize the SOURCE)
 * is reachable only for step 0 itself — exactly like native.
 */
export function regGrabTarget(
  t: GridTrackState,
  step: number,
): { owner: number; isWrap: boolean } | null {
  if (t.playbackMode === "owner") return null;
  for (let pos = step - 1; pos >= 0; pos--) {
    if (!t.steps[pos]) continue; // native scans past non-covering owners
    const len = Math.max(1, t.cellLengths[pos] ?? 1);
    const clamped = Math.min(len, t.stepCount - pos);
    if (pos + clamped > step) return { owner: pos, isWrap: false };
  }
  if (
    t.wrapSourceStep !== null &&
    t.wrapSourceStep > 0 &&
    t.steps[t.wrapSourceStep] &&
    t.steps[0]
  ) {
    const wrapLen = Math.max(1, t.cellLengths[0] ?? 1);
    if (step >= 0 && step < wrapLen) return { owner: t.wrapSourceStep, isWrap: true };
  }
  return null;
}

/** Grid row layout: split mode wraps steps into rows of `zoom` columns. */
export interface RowSlice {
  startStep: number;
  count: number;
}

export function rowSlices(stepCount: number, zoom: number, split: boolean): RowSlice[] {
  // Non-split (scroll) mode = ONE row holding ALL steps (native scrolls it
  // horizontally). Split mode wraps into ceil(steps/zoom) stacked rows of
  // `zoom` columns. NEVER clip: a track longer than `zoom` in scroll mode
  // still owns every step (previously clipped to zoom → steps vanished).
  if (!split || stepCount <= zoom) return [{ startStep: 0, count: stepCount }];
  const rows: RowSlice[] = [];
  for (let s = 0; s < stepCount; s += zoom) {
    rows.push({ startStep: s, count: Math.min(zoom, stepCount - s) });
  }
  return rows;
}

/**
 * Shared per-track vertical layout (trackrow.md §3 risk #1): the grid canvas
 * AND the DOM control strips MUST derive row tops/heights from the SAME math,
 * or they drift under split mode. Both consume this helper.
 *
 * Native parity (ContentView `TrackRowView` = `VStack[ cells, modifiersSection ]`):
 * each track band is CELLS on top + a full-width CONTROL STRIP directly below.
 * `live` is the visible track list (already sliced to trackCount); split-mode
 * tracks stack `sliceCount` cell rows. `pad` frames each band; `controlH` is
 * the reserved control-strip height (0 = cells only).
 */
export interface RowBlock {
  trackIndex: number; // index into the source tracks array
  top: number; // band top
  height: number; // full band height (cells + control strip)
  sliceCount: number;
  cellsTop: number; // canvas cells origin (== top)
  cellsHeight: number; // sliceCount * rowH
  controlTop: number; // DOM control strip origin
  controlHeight: number;
}

export interface GridRowLayout {
  rowH: number;
  blocks: RowBlock[];
}

/**
 * `controlH` accepts a single height (all tracks) or a PER-TRACK array
 * (TR-FT-6): a track whose band is shorter (no sample → no trim row, no mod
 * slots) must not inherit the tallest track's reserve, or it renders dead
 * space below its sends row. The DOM measures each band and feeds its own
 * height back here.
 */
export function gridRowLayout(
  live: { trackIndex: number; stepCount: number }[],
  zoom: number,
  split: boolean,
  heightPx: number,
  pad: number,
  controlH: number | number[] = 0,
  /**
   * Collapse the cells away entirely (DJ "hide grid" toggle): rows become
   * pure control bands. Needs to be an explicit MODE, not a zero height —
   * rowH has a 24px floor precisely so cells can never collapse by accident.
   */
  cellsHidden = false,
): GridRowLayout {
  const n = live.length;
  const bandH = (k: number): number =>
    Array.isArray(controlH) ? (controlH[k] ?? controlH[0] ?? 0) : controlH;
  const sliceCounts = live.map((l) => rowSlices(l.stepCount, zoom, split).length);
  const totalRows = sliceCounts.reduce((a, b) => a + b, 0) || 1;
  const bandTotal = live.reduce((s, _l, k) => s + bandH(k), 0);
  // Control strips + framing pad eat into the height before cells divide it.
  const cellsBudget = heightPx - pad * (n + 1) - bandTotal;
  const rowH = cellsHidden ? 0 : Math.max(24, Math.floor(cellsBudget / totalRows));
  const blocks: RowBlock[] = [];
  let y = pad;
  live.forEach((l, k) => {
    const sc = sliceCounts[k] ?? 1;
    const cellsHeight = sc * rowH;
    const ch = bandH(k);
    blocks.push({
      trackIndex: l.trackIndex,
      top: y,
      height: cellsHeight + ch,
      sliceCount: sc,
      cellsTop: y,
      cellsHeight,
      controlTop: y + cellsHeight,
      controlHeight: ch,
    });
    y += cellsHeight + ch + pad;
  });
  return { rowH, blocks };
}

/**
 * Shared cell width (native `calculatePadSize`: divisor = min(maxStepCount,
 * zoom)). Every track uses the SAME width so a column lines up across tracks
 * of different lengths — a shorter track shows fewer cells from the left, it
 * does NOT stretch its cells to fill the row. `maxStepCount` is the max across
 * the visible tracks; `zoom` is 16 or 32.
 */
export function sharedCellWidth(gridW: number, maxStepCount: number, zoom: number): number {
  return gridW / Math.max(1, Math.min(maxStepCount, zoom));
}

/** Collapsed main mode badge (spec §2B idx 14: REG↔OWN). */
export function trackModeLabel(t: GridTrackState): string {
  return t.playbackMode === "owner" ? "OWN" : "REG";
}

/**
 * Sub-mode badge (spec §2B idx 49). OWN: —/CHOP/LOOP · REG: —/STR/LOOP —
 * single-select, derived from the existing render-meta flags (no new field).
 */
export function trackSubModeLabel(t: GridTrackState): string {
  if (t.playbackMode === "owner") {
    if (t.defaultChopIndex >= 0) return "CHOP";
    if (t.loopEnabled) return "LOOP";
    return "";
  }
  if (t.loopEnabled) return "LOOP";
  if (t.stretchToCell) return "STR";
  return "";
}

/** Short display label for the per-track active cell parameter (Row A chip). */
export function cellParamShortLabel(name: string): string {
  const map: Record<string, string> = {
    pitch: "PITCH",
    volume: "VOL",
    gain: "GAIN",
    pan: "PAN",
    tone: "TONE",
    sampleStart: "START",
    sampleEnd: "END",
    preSilence: "PRE",
    flam: "FLAM",
    chop: "CHOP",
    chord: "CHORD",
    reverse: "REV",
    glide: "GLD",
  };
  return map[name] ?? name.toUpperCase();
}

// ---------------------------------------------------------------------------
// P5-PCE selection core (percell-selection-ux.md P1, user CONFIRM 2026-07-12).
// Family 1 = the six dial params: one armed param per track, switched
// instantly via chips / p-t-n-v-s-e / [ ] / Ö Ä, never stealing cell focus.
// ---------------------------------------------------------------------------

/** Dial-param cycle order == chip order (wraps). */
export const DIAL_PARAMS = [
  "pitch",
  "tone",
  "pan",
  "volume",
  "sampleStart",
  "sampleEnd",
] as const;

/**
 * The dial set for a track that EMITS NOTES. A note has no sample window to
 * trim and no filter of its own — it has a pitch, a loudness, and a length.
 * So the six sample dials give way to the four that mean something in MIDI:
 * NOTE (the cell's transposition of the track's root) · VEL · LEN · CHD.
 *
 * `midiNote` and `pitch` are the SAME underlying lane (`pitchOffsets`) — the
 * engine has always read one pitch source for both sample and note. Only the
 * name and the display change, which is the whole point: the same control,
 * speaking the language of whatever the track is driving.
 */
export const MIDI_DIAL_PARAMS = [
  "midiNote",
  "midiVelocity",
  "cellLength",
  "chord",
] as const;

/** Which dial set this track's chips + k/l cycle walk. A track that sounds a
 *  sample keeps the sample dials even when it ALSO drives the MIDI port —
 *  its cells still trim and filter real audio. */
export function dialParamsFor(t: Pick<GridTrackState, "trackType">): readonly string[] {
  return t.trackType === "midi" ? MIDI_DIAL_PARAMS : DIAL_PARAMS;
}

/** Next/prev dial param from `current`. A non-dial active param (accent/
 *  glide/flam — armed by the legacy CellTools) re-enters the cycle at the
 *  ends, so `]` from anywhere always lands on a dial param. */
export function cycleDialParam(
  current: string,
  dir: 1 | -1,
  params: readonly string[] = DIAL_PARAMS,
): string {
  const idx = params.indexOf(current);
  if (idx < 0) return dir > 0 ? params[0]! : params[params.length - 1]!;
  return params[(idx + dir + params.length) % params.length]!;
}

/** MIDI note number → name (60 = C3, the convention the row's ROOT box shows). */
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
export function noteName(midi: number): string {
  if (!Number.isFinite(midi)) return "—";
  const n = Math.max(0, Math.min(127, Math.round(midi)));
  return `${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 2}`;
}

/**
 * Permanent in-cell label for a note/instrument owner cell: the note it plays
 * plus, when a chord is armed on that cell, the chord's short label — so a
 * chord voicing stays visible without the CHD param being the armed dial.
 * "C3" · "C3 MIN". The chord suffix is dropped by callers on narrow cells.
 */
export function noteCellLabel(t: GridTrackState, owner: number): string {
  const note = noteName(t.midiRootNote + Math.round((t.pitchOffsets[owner] ?? 0) / 2));
  const chord = chordShortLabel(t.chordIndices[owner] ?? 0);
  return chord ? `${note} ${chord}` : note;
}

/** 3-char chip / focused-cell label (PIT · TON · PAN · VOL · STA · END). */
export function cellParamChipLabel(name: string): string {
  const map: Record<string, string> = {
    pitch: "PIT",
    tone: "TON",
    pan: "PAN",
    volume: "VOL",
    gain: "GAI",
    sampleStart: "STA",
    sampleEnd: "END",
    preSilence: "PRE",
    accent: "ACC",
    glide: "GLD",
    flam: "FLM",
    chop: "CHP",
    chord: "CHD",
    reverse: "REV",
    midiNote: "NOT",
    midiVelocity: "VEL",
    cellLength: "LEN",
    rhythmicOffset: "NDG",
  };
  return map[name] ?? name.toUpperCase().slice(0, 3);
}

/** Chip data-dot: does this dial param carry per-cell data anywhere? */
export function paramHasCellData(t: GridTrackState, name: string): boolean {
  const any = (arr: number[]) => arr.some((v) => v !== 0);
  switch (name) {
    case "pitch":
      return any(t.pitchOffsets);
    case "tone":
      return any(t.toneOffsets);
    case "pan":
      return any(t.panOffsets);
    case "volume":
      return any(t.volumeOffsets);
    case "gain":
      return any(t.mixVolumeOffsets);
    case "sampleStart":
      return any(t.sampleStartMsOffsets);
    case "sampleEnd":
      return any(t.sampleEndMsOffsets);
    // --- note lanes. A cell carries data when it DIFFERS from the track default,
    // not when it is merely non-zero: velocity 100 everywhere is "no per-cell data".
    case "midiNote":
      return any(t.pitchOffsets);
    case "midiVelocity":
      return t.midiVelocities.some((v) => v !== t.midiVelocities[0]);
    case "cellLength":
      return t.cellLengths.some((v) => v > 1);
    case "chord":
      return t.chordIndices.some((v) => v > 0);
    default:
      return false;
  }
}

/**
 * The dial lanes whose per-cell edits have NO permanent in-cell mark of their
 * own — so an edit here would be invisible unless the lane happens to be the
 * armed param. Deliberately excludes: lanes with a standing mark (accent/flam/
 * glide/reverse/preSilence), chop + cellLength (the waveform/span IS the
 * visual), and note+chord (permanent via noteCellLabel). Split by track type
 * because the sample and note tracks expose different dial sets.
 */
const HIDDEN_AUDIO_LANES: readonly string[] = [
  "pitch",
  "tone",
  "pan",
  "volume",
  "gain",
  "sampleStart",
  "sampleEnd",
  "rhythmicOffset",
];
const HIDDEN_MIDI_LANES: readonly string[] = ["midiVelocity", "rhythmicOffset"];

/** True when this specific cell carries a non-default value in a lane with no
 *  standing mark AND that isn't the currently-armed param (which the chip
 *  already shows). Drives the bottom-right hidden-edit dot. */
export function cellHasHiddenData(t: GridTrackState, step: number, armed: string): boolean {
  return cellHiddenLaneTags(t, step, armed).length > 0;
}

/** Ordered `NDG +0.25`-style tags for every un-marked, un-armed lane this cell
 *  edits — the hover/focus readout detail, and the dot's presence test. */
export function cellHiddenLaneTags(t: GridTrackState, step: number, armed: string): string[] {
  const lanes = t.trackType === "midi" ? HIDDEN_MIDI_LANES : HIDDEN_AUDIO_LANES;
  // `midiNote` and `pitch` are the same underlying lane: arming either hides
  // both, so fold the alias when deciding what the chip already covers.
  const armedIsPitch = armed === "pitch" || armed === "midiNote";
  const tags: string[] = [];
  for (const name of lanes) {
    if (name === armed) continue;
    if (armedIsPitch && (name === "pitch" || name === "midiNote")) continue;
    if (!laneCellNonDefault(t, name, step)) continue;
    const label = laneValueLabel(t, name, step);
    if (label) tags.push(`${cellParamChipLabel(name)} ${label}`);
  }
  return tags;
}

/** Per-cell (not per-track) non-default test, mirroring paramHasCellData's
 *  per-lane convention: offsets are non-zero; velocity differs from the track
 *  default (cell 0's value). */
function laneCellNonDefault(t: GridTrackState, name: string, step: number): boolean {
  const at = (arr: number[]) => arr[step] ?? 0;
  switch (name) {
    case "pitch":
      return at(t.pitchOffsets) !== 0;
    case "tone":
      return at(t.toneOffsets) !== 0;
    case "pan":
      return at(t.panOffsets) !== 0;
    case "volume":
      return at(t.volumeOffsets) !== 0;
    case "gain":
      return at(t.mixVolumeOffsets) !== 0;
    case "sampleStart":
      return at(t.sampleStartMsOffsets) !== 0;
    case "sampleEnd":
      return at(t.sampleEndMsOffsets) !== 0;
    case "rhythmicOffset":
      return at(t.rhythmicOffsetRatios) !== 0;
    case "midiVelocity":
      return (t.midiVelocities[step] ?? t.midiVelocities[0]) !== t.midiVelocities[0];
    default:
      return false;
  }
}

/**
 * Width-degrading readout: start from `base` (the armed-param label) and append
 * ` · tag` while `fits` holds. When a tag won't fit, stop and append ` +N` for
 * the dropped remainder if THAT fits; otherwise fall back to base-only. `fits`
 * is injected so the canvas passes a measureText predicate and tests pass a
 * cheap character-count stub.
 */
export function fitReadout(base: string, tags: string[], fits: (s: string) => boolean): string {
  let out = base;
  for (let i = 0; i < tags.length; i++) {
    const next = `${out} · ${tags[i]}`;
    if (fits(next)) {
      out = next;
    } else {
      const remainder = tags.length - i;
      const withCount = `${out} +${remainder}`;
      return fits(withCount) ? withCount : out;
    }
  }
  return out;
}

/**
 * Focused-cell live label (P1.4, user CONFIRM: always-on incl. defaults):
 * `TON -10` / `PIT 0` — the armed param + the step's effective value, so the
 * active param is always visible while switching/dialing. Callers pass the
 * resolved OWNER step (covered steps show what ö/ä actually edits).
 */
export function cellParamValueLabel(t: GridTrackState, step: number): string {
  const short = cellParamChipLabel(t.activeCellParameterName);
  const at = (arr: number[]) => arr[step] ?? 0;
  const num = (v: number, digits = 2, suffix = "") =>
    `${v > 0 ? "+" : ""}${Number(v.toFixed(digits))}${suffix}`;
  let val: string;
  switch (t.activeCellParameterName) {
    case "pitch":
      val = num(at(t.pitchOffsets) / 2); // quarter-tones → semitones
      break;
    // The SAME pitchOffsets lane, read as a note: the cell transposes the track's
    // root, so the cell's value is the note the synth will actually play.
    case "midiNote":
      val = noteName(t.midiRootNote + Math.round(at(t.pitchOffsets) / 2));
      break;
    case "midiVelocity":
      val = String(t.midiVelocities[step] ?? t.midiVelocities[0] ?? 100);
      break;
    case "cellLength":
      val = String(t.cellLengths[step] ?? 1);
      break;
    case "volume":
      val = num(at(t.volumeOffsets));
      break;
    case "gain":
      val = num(at(t.mixVolumeOffsets));
      break;
    case "pan":
      val = num(at(t.panOffsets));
      break;
    case "tone":
      val = num(at(t.toneOffsets), 0);
      break;
    case "sampleStart":
      val = num(at(t.sampleStartMsOffsets), 0, "ms");
      break;
    case "sampleEnd":
      val = num(at(t.sampleEndMsOffsets), 0, "ms");
      break;
    case "preSilence":
      val = num(at(t.preSilenceMsOffsets), 0, "ms");
      break;
    case "flam":
      val = `×${t.flamCounts[step] ?? 1}`;
      break;
    case "chop": {
      const c = t.cellChopIndices[step] ?? -1;
      val = c >= 0 ? `C${c + 1}` : "—";
      break;
    }
    case "chord": {
      const c = t.chordIndices[step] ?? 0;
      val = c > 0 ? chordShortLabel(c) : "—";
      break;
    }
    case "reverse":
      val = t.reverseSteps[step] ? "ON" : "—";
      break;
    case "glide":
      val = t.glideSteps[step] ? "ON" : "—";
      break;
    case "accent":
      val = String(t.accentLevels[step] ?? 0);
      break;
    default:
      return short;
  }
  return `${short} ${val}`;
}

/**
 * Drag-extension endpoint → updateCellLength args. EXACT port of the native
 * row-drag math (ContentView :2530–2537 ⌥-drag and :2583–2596 REG drag —
 * both compute the same quantities):
 * - `endRef` may exceed stepCount−1 (pointer extrapolated past the pattern
 *   end) → the overflow becomes wrapLength (continuation at step 0).
 * - `abs`: dragging LEFT of the owner also grows the cell rightward by the
 *   same count (native quirk, kept 1:1).
 * - step 0 owners cannot wrap (canWrap = ownerStep > 0).
 */
export interface DragEnd {
  length: number;
  wrapLength: number;
}

export function computeDragEnd(ownerStep: number, endRef: number, stepCount: number): DragEnd {
  const canWrap = ownerStep > 0;
  const effectiveEnd = Math.min(endRef, stepCount - 1);
  const length = Math.abs(effectiveEnd - ownerStep) + 1;
  const wrapsAround = endRef >= stepCount && canWrap;
  const cellEndsAtPatternEnd = ownerStep + length >= stepCount;
  const wrapLength = wrapsAround && cellEndsAtPatternEnd ? endRef - stepCount + 1 : 0;
  return { length, wrapLength };
}

/**
 * Wrap-tail remap (native :2590): while resizing a cell that wraps, the
 * pointer sits at low (wrapped) indices — map them past the pattern end so
 * the length math sees one continuous span.
 */
export function dragEndRef(
  ownerStep: number,
  pointerStep: number,
  stepCount: number,
  isWrapResize: boolean,
): number {
  return isWrapResize && pointerStep < ownerStep ? stepCount + pointerStep : pointerStep;
}

// ---------------------------------------------------------------------------
// Row-split cell fragments. In split display mode a multi-step cell can
// cross a grid-row boundary (e.g. steps 12–20 over 16-step rows) — the ONE
// unbroken region idiom then becomes one fragment per row, each carrying
// its span-relative interval [v0,v1) so waveform segments and the onset
// hairline distribute across rows by step position. (Native rendered
// per-step, so it split for free — but broke the cell into bordered
// singles at extension opacity; the web keeps the region idiom per row.)
// ---------------------------------------------------------------------------

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One per-row piece of a multi-step cell region. */
export interface SpanFrag extends CellRect {
  v0: number;
  v1: number;
}

/** Group a span's step rects into contiguous per-row fragments (a new row =
 *  a y jump). Steps without a rect (never for in-bounds spans) are skipped. */
export function spanFragments(
  startStep: number,
  span: number,
  rectAt: (step: number) => CellRect | undefined,
): SpanFrag[] {
  const frags: SpanFrag[] = [];
  for (let k = 0; k < span; k++) {
    const r = rectAt(startStep + k);
    if (!r) continue;
    const cur = frags[frags.length - 1];
    if (cur && Math.abs(r.y - cur.y) < 0.5) {
      cur.w = r.x + r.w - cur.x;
      cur.v1 = (k + 1) / span;
    } else {
      frags.push({ x: r.x, y: r.y, w: r.w, h: r.h, v0: k / span, v1: (k + 1) / span });
    }
  }
  return frags;
}

export interface FragSlice {
  fr: SpanFrag;
  /** Pixel slice inside the fragment. */
  x: number;
  w: number;
  /** Normalized sub-range of the INPUT interval (to slice paired audio). */
  t0: number;
  t1: number;
}

/** Map a span-relative interval [v0,v1) onto the fragments it crosses. On a
 *  single fragment this degenerates to the old linear region mapping. */
export function sliceSpanInterval(frags: SpanFrag[], v0: number, v1: number): FragSlice[] {
  const out: FragSlice[] = [];
  if (v1 - v0 <= 0) return out;
  for (const fr of frags) {
    const lo = Math.max(v0, fr.v0);
    const hi = Math.min(v1, fr.v1);
    if (hi - lo <= 1e-6) continue;
    out.push({
      fr,
      x: fr.x + ((lo - fr.v0) / (fr.v1 - fr.v0)) * fr.w,
      w: ((hi - lo) / (fr.v1 - fr.v0)) * fr.w,
      t0: (lo - v0) / (v1 - v0),
      t1: (hi - v0) / (v1 - v0),
    });
  }
  return out;
}

/** Pixel x of a span-relative POINT (onset hairline): on an exact row break
 *  the point belongs to the incoming fragment. */
export function spanPointX(frags: SpanFrag[], v: number): { x: number; fr: SpanFrag } | null {
  const fr = frags.find((f) => v >= f.v0 && v < f.v1 - 1e-9) ?? frags[frags.length - 1];
  if (!fr) return null;
  return { x: fr.x + ((v - fr.v0) / (fr.v1 - fr.v0)) * fr.w, fr };
}

// ---------------------------------------------------------------------------
// Per-param edit policy (P5-PCE P2.3 — percell-selection-ux.md F7, grid.md
// §4.2). Now that Family-1 selection exists (P1), sampleStart/sampleEnd
// became reachable — and Swift's adjustStepParameter writes those offsets
// to the raw step index unguarded (the OOB / crash path). The web FIXES it
// here (does NOT port the bug): every param except pitch is an OWNER-cell
// value, so a covered/out-of-owner step remaps to its owner; pitch alone is
// genuinely per-step (native writes per-step pitch offsets).
// ---------------------------------------------------------------------------

export type ParamPolicy = "stepAnchored" | "ownerRemap";

export function paramEditPolicy(param: string): ParamPolicy {
  return param === "pitch" ? "stepAnchored" : "ownerRemap";
}

/**
 * The step indices an adjust for `param` should actually write, applying the
 * policy to a candidate list (selection, else the focused/anchor step):
 * - pitch (stepAnchored): keep each in-bounds step as-is.
 * - all others (ownerRemap): map each step to its resolved OWNER and dedupe
 *   (a selection spanning one owner cell collapses to one write; a step with
 *   no covering cell is skipped — nothing to edit).
 */
export function resolveValueTargets(
  t: GridTrackState,
  steps: number[],
  param: string,
): number[] {
  if (paramEditPolicy(param) === "stepAnchored") {
    return steps.filter((s) => s >= 0 && s < t.stepCount);
  }
  const owners = new Set<number>();
  for (const s of steps) {
    const r = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, s);
    if (r) owners.add(r.owner);
  }
  return [...owners];
}

// ---------------------------------------------------------------------------
// Optimistic echo reducers (P5-02b → P5-03). Applied to the LOCAL render
// state the instant an edit is sent; the authoritative grid/<i> push
// overwrites them ~35 ms later. Since P5-03 these are FULL PARITY ports of
// the Swift mutators, byte-compared by the golden-fixture harness
// (web/fixtures/grid-ops + GridOpGoldenTests.swift) — P5-04's PatternStore
// builds on them. Overlap-corruption edge paths (an ACTIVE step covered by
// another cell) are not modeled: unreachable via any web sender.
// ---------------------------------------------------------------------------

/** Full port of BeatSequencer.toggleStep (:3971). Key semantics: manual
 *  enable sets accent SOFT (drawn notes get the ×1.25 boost), disable clears
 *  accent + resets an extended length; enabling a COVERED step in REG only
 *  SHORTENS the covering cell (the note does NOT appear); step 0 is always
 *  a normal independent cell when manually enabled. */
export function applyToggleStep(t: GridTrackState, step: number): GridTrackState {
  if (step < 0 || step >= t.stepCount) return t;
  const steps = t.steps.slice();
  const cellLengths = t.cellLengths.slice();
  const accentLevels = t.accentLevels.slice();
  let wrapSourceStep = t.wrapSourceStep;
  const n = t.stepCount;

  if (!steps[step]) {
    // ENABLE. REG: a step covered by an earlier extended cell only shortens
    // that cell — native "Don't enable the step - just shorten" (:4120).
    if (t.playbackMode !== "owner") {
      for (let pos = step - 1; pos >= 0; pos--) {
        if (!steps[pos]) continue;
        const len = Math.max(1, cellLengths[pos] ?? 1);
        if (pos + len <= step) continue; // native scans past non-covering owners
        const newLength = step - pos;
        if (newLength >= 1) {
          cellLengths[pos] = newLength;
          // Shortened below the pattern end → this cell's wrap dies (:4082).
          if (pos + newLength < n && wrapSourceStep === pos) {
            steps[0] = false;
            cellLengths[0] = 1;
            wrapSourceStep = null;
          }
          if (pos === 0 && wrapSourceStep !== null) wrapSourceStep = null;
          return { ...t, steps, cellLengths, wrapSourceStep };
        }
        break;
      }
    }
    steps[step] = true;
    if (step < accentLevels.length) accentLevels[step] = 1; // soft (:4131)
    if (step === 0) {
      // Manual step 0 is never a wrap continuation (:4137–4172): the source
      // keeps its in-pattern length, the continuation identity dies.
      wrapSourceStep = null;
      cellLengths[0] = 1;
    }
  } else {
    // DISABLE. Step 0 as wrap continuation → remove the wrap entirely
    // (:4283–4308; accent NOT touched on this early-return path).
    if (step === 0 && wrapSourceStep !== null) {
      steps[0] = false;
      cellLengths[0] = 1;
      wrapSourceStep = null;
      return { ...t, steps, cellLengths, wrapSourceStep };
    }
    steps[step] = false;
    if (step < accentLevels.length) accentLevels[step] = 0; // (:4319)
    const len = Math.max(1, cellLengths[step] ?? 1);
    if (len > 1) {
      cellLengths[step] = 1;
      if (step + len >= n && wrapSourceStep === step) {
        steps[0] = false;
        cellLengths[0] = 1;
        wrapSourceStep = null;
      }
    }
  }
  return { ...t, steps, cellLengths, accentLevels, wrapSourceStep };
}

/** Full port of BeatSequencer.updateCellLength (:1284) incl. the Swift wrap
 *  ENCODING: cellLengths[owner] = IN-PATTERN length only; the continuation
 *  is a real cell at step 0 (steps[0]=true, cellLengths[0]=wrapLen) plus
 *  wrapSourceStep. (The old optimistic total-span encoding diverged from
 *  every authoritative push — pinned by the golden harness.) */
export function applySetCellLength(
  t: GridTrackState,
  owner: number,
  length: number,
  wrapLength: number,
): GridTrackState {
  if (owner < 0 || owner >= t.stepCount) return t;
  if (!t.steps[owner]) return t; // native guards on an ACTIVE owner (:1293)
  const steps = t.steps.slice();
  const cellLengths = t.cellLengths.slice();
  let wrapSourceStep = t.wrapSourceStep;
  const n = t.stepCount;
  const clamped = Math.max(1, length);

  // Explicit wrap intent: blocked from step 0, blocked when step 0 is an
  // unrelated active cell, clamped so it can't reach back into the owner.
  let appliedWrap = owner === 0 ? 0 : Math.max(0, wrapLength);
  if (appliedWrap > 0 && steps[0] && wrapSourceStep !== owner) appliedWrap = 0;
  if (appliedWrap > owner) appliedWrap = owner;

  // In-pattern extension truncates at the first active step — it does NOT
  // absorb existing notes (:1389–1402).
  let eff = clamped;
  for (let s = owner + 1; s < Math.min(owner + clamped, n); s++) {
    if (steps[s]) {
      eff = s - owner;
      break;
    }
  }
  cellLengths[owner] = eff;

  // Auto-wrap: a length passing the pattern end creates the wrap implicitly
  // (:1433–1451). Explicit wrap wins when both are present.
  if (owner > 0 && owner + eff > n && appliedWrap === 0) {
    appliedWrap = Math.min(eff - (n - owner), owner);
  }

  if (appliedWrap > 0 && owner > 0) {
    let w = Math.min(appliedWrap, n);
    for (let s = 1; s < w; s++) {
      if (steps[s]) {
        w = s;
        break;
      }
    }
    steps[0] = true;
    cellLengths[0] = w;
    wrapSourceStep = owner;
  } else if (wrapSourceStep === owner) {
    // wrapLength 0 on the wrap source = remove the continuation.
    steps[0] = false;
    cellLengths[0] = 1;
    wrapSourceStep = null;
  }
  return { ...t, steps, cellLengths, wrapSourceStep };
}

/**
 * TR-FT-13: the "," extension tool (replaces native option+←/→ on the web
 * surface — those arrows are pure navigation now). Sets the owning REG
 * cell's END to `focusStep`: extends when beyond the current end, shrinks
 * when inside the span. A focus BEFORE the owner extends the wrap-around
 * portion instead (native HotkeyManager :779–811 parity; step-0 owners can
 * never wrap). Returns applySetCellLength/setCellLength args, or null when
 * inapplicable (OWN mode, empty track, out of bounds).
 */
export function commaEndTarget(
  t: GridTrackState,
  focusStep: number,
): { owner: number; length: number; wrapLength: number } | null {
  const n = t.stepCount;
  if (t.playbackMode === "owner") return null;
  if (focusStep < 0 || focusStep >= n) return null;

  let owner: number | null = null;
  let viaWrap = false;
  const isContinuation = (o: number) =>
    o === 0 && t.wrapSourceStep !== null && t.wrapSourceStep > 0;

  const r = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, focusStep);
  if (r) {
    if (r.viaWrap || isContinuation(r.owner)) {
      // Focus sits in the wrap tail. The Swift encoding stores the tail as a
      // real cell at step 0, so the forward scan attributes it to owner 0 —
      // remap to the wrap SOURCE (regGrabTarget parity).
      owner = r.viaWrap ? r.owner : t.wrapSourceStep;
      viaWrap = true;
    } else {
      owner = r.owner;
    }
  } else {
    // Uncovered step: nearest active owner at or before it (native backward
    // owner scan, HotkeyManager :699–743)…
    for (let o = focusStep; o >= 0; o--) {
      if (!t.steps[o]) continue;
      if (isContinuation(o)) {
        owner = t.wrapSourceStep;
        viaWrap = true;
      } else {
        owner = o;
      }
      break;
    }
    // …else wrap around: the last active owner AFTER the focus extends its
    // wrap portion up to the focused step.
    if (owner === null) {
      for (let o = n - 1; o > focusStep; o--) {
        if (!t.steps[o]) continue;
        owner = o;
        viaWrap = true;
        break;
      }
    }
  }
  if (owner === null) return null; // empty track

  if (viaWrap) {
    if (owner === 0) return null; // step-0 cells can never wrap (native block)
    // Fill to the pattern end, wrap tail ends AT the focused step. The
    // reducer independently re-clamps and truncates at intervening notes.
    return { owner, length: n - owner, wrapLength: focusStep + 1 };
  }
  return { owner, length: focusStep - owner + 1, wrapLength: 0 };
}

export function applyCycleAccent(t: GridTrackState, step: number): GridTrackState {
  if (step < 0 || step >= t.stepCount) return t;
  const accentLevels = t.accentLevels.slice();
  accentLevels[step] = ((accentLevels[step] ?? 0) + 1) % 3;
  const steps = t.steps.slice();
  if (!steps[step]) steps[step] = true; // native: accent activates the step
  return { ...t, accentLevels, steps };
}

export function applyCycleFlam(t: GridTrackState, step: number): GridTrackState {
  if (step < 0 || step >= t.stepCount) return t;
  const flamCounts = t.flamCounts.slice();
  const f = flamCounts[step] ?? 1;
  flamCounts[step] = f >= 16 ? 1 : f + 1; // native cycleStepFlam: 1→…→kMaxFlam(16)→1
  return { ...t, flamCounts };
}

// ---------------------------------------------------------------------------
// In-cell affordance reducers (P5-PCE, incell-affordance-ux.md §4.4). Each
// writes at the resolved OWNER (the caller resolves before applying).
// ---------------------------------------------------------------------------

/** Set the accent level 0/1/2, activating the step (native activate-on-set). */
export function applySetAccent(t: GridTrackState, owner: number, level: number): GridTrackState {
  if (owner < 0 || owner >= t.stepCount) return t;
  const accentLevels = t.accentLevels.slice();
  accentLevels[owner] = Math.max(0, Math.min(2, level));
  const steps = t.steps.slice();
  if (!steps[owner]) steps[owner] = true;
  return { ...t, accentLevels, steps };
}

/** Set the flam count directly, clamped 1…16 (kMaxFlam). */
export function applySetFlam(t: GridTrackState, owner: number, count: number): GridTrackState {
  if (owner < 0 || owner >= t.stepCount) return t;
  const flamCounts = t.flamCounts.slice();
  flamCounts[owner] = Math.max(1, Math.min(16, count));
  return { ...t, flamCounts };
}

/** Set the per-step reverse flag at the owner. */
export function applySetReverse(t: GridTrackState, owner: number, on: boolean): GridTrackState {
  if (owner < 0 || owner >= t.stepCount) return t;
  const reverseSteps = t.reverseSteps.slice();
  reverseSteps[owner] = on;
  return { ...t, reverseSteps };
}

/**
 * Set the glide-into flag with LEGACY MATERIALIZATION (grid.md §8.3, mirrors
 * Swift setStepGlide): an empty glideSteps array + glidePercent>0 = the
 * engine glides EVERY transition, so materialize ALL-TRUE before the first
 * per-cell write (preserve the audible legacy behavior) then toggle.
 */
export function applySetGlide(t: GridTrackState, owner: number, on: boolean): GridTrackState {
  if (owner < 0 || owner >= t.stepCount) return t;
  let glideSteps = t.glideSteps.slice();
  const empty = glideSteps.every((g) => !g);
  if (empty && glideSteps.length === 0 && t.glidePercent > 0) {
    glideSteps = Array(t.stepCount).fill(true);
  }
  glideSteps[owner] = on;
  return { ...t, glideSteps };
}

/** Set the absolute per-cell pre-silence (stored as an offset from the base). */
export function applySetPreSilence(t: GridTrackState, owner: number, ms: number): GridTrackState {
  if (owner < 0 || owner >= t.stepCount) return t;
  const preSilenceMsOffsets = t.preSilenceMsOffsets.slice();
  preSilenceMsOffsets[owner] = Math.max(0, Math.min(1000, ms)) - t.preSilenceMs;
  return { ...t, preSilenceMsOffsets };
}

/**
 * Owner-cell value label for the track's ACTIVE cell parameter (per-track
 * activeCellParameterName — not the gridMeta selected-track value). Empty
 * string = nothing to show (value at default). v1 subset: numeric offsets +
 * flam/chop/reverse/glide; midi/stereoMode/rhythmicOffset land with their
 * editing lanes.
 */
export function cellValueLabel(t: GridTrackState, step: number): string {
  return laneValueLabel(t, t.activeCellParameterName, step);
}

/**
 * Off-default value label for ANY named lane at a step (not just the armed
 * param). "" = value at default. `cellValueLabel` reads the armed lane; the
 * hidden-edit readout (cellHiddenLaneTags) reads the un-armed lanes.
 */
export function laneValueLabel(t: GridTrackState, name: string, step: number): string {
  const signed = (v: number, digits = 2, suffix = "") =>
    v === 0 ? "" : `${v > 0 ? "+" : ""}${Number(v.toFixed(digits))}${suffix}`;
  const at = (arr: number[]) => arr[step] ?? 0;
  switch (name) {
    case "pitch":
      return signed(at(t.pitchOffsets) / 2, 2); // quarter-tones → semitones
    // Note lanes: a MIDI cell shows what it PLAYS, not an offset from something.
    // The note name is the whole point — "C3" tells you more than "+0" ever could.
    case "midiNote":
      return noteName(t.midiRootNote + Math.round(at(t.pitchOffsets) / 2));
    case "midiVelocity": {
      const v = t.midiVelocities[step];
      return v === undefined ? "" : String(v);
    }
    case "cellLength": {
      const len = t.cellLengths[step] ?? 1;
      return len > 1 ? String(len) : "";
    }
    case "volume":
      return signed(at(t.volumeOffsets));
    case "gain":
      return signed(at(t.mixVolumeOffsets));
    case "pan":
      return signed(at(t.panOffsets));
    case "tone":
      return signed(at(t.toneOffsets), 0);
    // sends are NOT per-cell (grid.md §8 lock item 7) — cases deleted
    case "sampleStart":
      return signed(at(t.sampleStartMsOffsets), 0, "ms");
    case "sampleEnd":
      return signed(at(t.sampleEndMsOffsets), 0, "ms");
    case "preSilence":
      return signed(at(t.preSilenceMsOffsets), 0, "ms");
    case "flam": {
      const f = t.flamCounts[step] ?? 1;
      return f > 1 ? `×${f}` : "";
    }
    case "chop": {
      const c = t.cellChopIndices[step] ?? -1;
      return c >= 0 ? `C${c + 1}` : "";
    }
    case "chord":
      return chordShortLabel(t.chordIndices[step] ?? 0);
    case "reverse":
      return t.reverseSteps[step] ? "REV" : "";
    case "glide":
      return t.glideSteps[step] ? "GLD" : "";
    case "rhythmicOffset":
      return signed(at(t.rhythmicOffsetRatios), 2);
    default:
      return "";
  }
}

// v1 `cellWave` (linear trim-window map) was replaced by the full segment
// mapping in gridWave.ts (P5-02c): computeCellSegments.

/**
 * Track-wise cursor jump (Tab / ⇧↑⇧↓): the next/previous track in visual
 * order, keeping the column. Tab wraps (⇧Tab is native's compose/DJ toggle,
 * so last→first IS the way back); the selection-extend jump clamps — wrapping
 * an extension from track 0 to the last track would select the wrong end.
 * The kept step clamps to the target's last step so a 64-step cursor landing
 * on a 16-step track stays on the row.
 */
export function nextTrackJump(
  live: { trackIndex: number; stepCount: number }[],
  fromTrack: number,
  step: number,
  dir: 1 | -1,
  wrap: boolean,
): { trackIndex: number; step: number } | null {
  if (live.length === 0) return null;
  const at = live.findIndex((l) => l.trackIndex === fromTrack);
  // Cursor on a vanished track: enter the list at its nearest end.
  let k = at >= 0 ? at + dir : dir === 1 ? 0 : live.length - 1;
  if (at >= 0 && (k < 0 || k >= live.length)) {
    if (!wrap) return null;
    k = (k + live.length) % live.length;
  }
  const target = live[k]!;
  return {
    trackIndex: target.trackIndex,
    step: Math.max(0, Math.min(step, target.stepCount - 1)),
  };
}
