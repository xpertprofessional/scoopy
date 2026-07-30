import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  COMMANDS,
  DJ_PATTERN_TOPIC,
  DJ_RUNTIME_TOPIC,
  EngineEvent,
  GridMetaState,
  GridPatternState,
  GridRuntimeState,
  GridTrackState,
  HotFrameLayout,
  MAX_GRID_TRACKS,
  djTrackLevelIndex,
  djTrackPosIndex,
  djTrackStepIndex,
} from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { BrowserLink } from "../browserLink.ts";
import { deriveTrackState } from "./deriveTrackState.ts";
import { levelToLedFill } from "./ledLevel.ts";
import {
  performDragArmed,
  performRange,
  resolvePerformRelease,
  rowStepFromXY,
  type PerformDrag,
} from "./performLocator.ts";
import {
  applyCycleAccent,
  applyCycleFlam,
  applySetAccent,
  applySetCellLength,
  applySetFlam,
  applySetGlide,
  applySetPreSilence,
  applySetReverse,
  applyToggleStep,
  cellHasHiddenData,
  cellHiddenLaneTags,
  cellParamChipLabel,
  cellParamValueLabel,
  cellValueLabel,
  commaEndTarget,
  computeDragEnd,
  cycleDialParam,
  dialParamsFor,
  fitReadout,
  noteCellLabel,
  noteName,
  dragEndRef,
  regGrabTarget,
  resolveValueTargets,
  gridRowLayout,
  nextTrackJump,
  resolveCellAt,
  rowSlices,
  sharedCellWidth,
  sliceSpanInterval,
  spanFragments,
  spanPointX,
} from "./gridModel.ts";
import {
  cellLeadIn,
  computeCellSegments,
  flamCopySpan,
  gridStepMs,
  preSilenceOnsetFrac,
  sourceMsToCellFrac,
  stepAmplitude,
  stepRate,
  type CellWaveform,
} from "./gridWave.ts";
import { drawWave, peaksKey, type Peaks } from "./waveRender.ts";
import {
  accentScrubLevel,
  affordanceHit,
  fanCount,
  leadInPxToPreMs,
  ownerContext,
  preMsToOnsetFrac,
  zoneSizes,
  type Mark,
} from "./cellAffordances.ts";
import { gestureTuning, type GestureTuning } from "../design/touchGestures.ts";
import { isCoarsePointer } from "../design/pointerCapability.ts";
import {
  acquireControlFocus,
  acquireFirstControlFocus,
  FocusScopeContext,
  useFocusModel,
} from "../design/focusModel.ts";
import { crossDjFocus, planDeckFocusAdoption, registerDjFocus } from "./djFocusBridge.ts";
import { bandControls, groupRows, nearestIndexByX, stepIndex } from "./bandNav.ts";
import {
  claimKey,
  isDjNudgeKey,
  isNoteKeyboardActive,
  setNoteKeyboardActive,
} from "../design/keyForward.ts";
import {
  currentTokens,
  inkAlpha,
  onTokensApplied,
  semanticColor,
  UNSET_TRACK_HEX,
  trackDisplayColor,
} from "../design/tokens.ts";
import { DEFAULT_WAVEFORM, type WaveformStyle } from "../design/waveformStyle.ts";
import {
  resetShadowEvidence,
  shadowAuthoritative,
  shadowCoverage,
  shadowLocalOp,
  shadowTrackOp,
  shadowUnmodeledEdit,
  usePatternStore,
  type DriftRecord,
} from "../state/patternStore.ts";
import { TrackBand } from "./trackRowControls.tsx";
import { useContextMenu, type MenuItem } from "../design/ContextMenu.tsx";
import { verifyWorldRoundTrip, type RoundTripResult } from "../persist/worldWire.ts";
import { attachPersistShadow } from "../persist/persistShadow.ts";
import { attachMenuBridge } from "../commands/menuBridge.ts";
import { VERIFIABLE_GRID_OPS, applyGridOp, type GridOp } from "./gridOps.ts";
import { applyClearPattern, applyRandomizePattern } from "./patternOps.ts";
import { mulberry32, randomSeed } from "./rng.ts";
import {
  VERIFIABLE_TRACK_OPS,
  SETTINGS_OWNED_TRACK_OPS,
  fansOutToSelection,
  applyTrackOp,
  applyAdjustCellParameter,
  type TrackOp,
} from "./trackOps.ts";
import { canonicalPatternState, projectPattern } from "./patternCanonical.ts";
import {
  popRedo,
  popUndo,
  pushSwiftMarker,
  recordEdit,
  redoDepth,
  undoDepth,
  undoLabel,
  beginGesture,
  endGesture,
} from "../state/undoStore.ts";

/**
 * P5-06 step D: how long after a publish a track's echoes are treated as our own.
 *
 * Swift re-pushes on a 33 ms debounce, so this only has to outlast an in-flight round trip; it
 * matches the shadow store's settle window so "quiet" means the same thing in both places.
 */
const OWNER_ECHO_QUIET_MS = 300;
import { hasSampleDrag, readSampleDrag } from "./FileBrowserPanel.tsx";
import { MasterRow } from "./MasterRow.tsx";
import { useModulation, type Modulation } from "./useModulation.ts";
import "./grid.css";

/**
 * Sequencer grid — P5-01b READ-ONLY render (panels/grid.md §3).
 * Two-layer canvas: static (cells, vector waveforms, affordances) redrawn
 * only on state change; hot (playhead fills) painted per rAF from the
 * HotFrame trackStep block. No editing — view+command Phase 5 milestone (a).
 */


/**
 * P5-04 shadow evidence readout — the instrument for THE FLIP's evidence gate.
 *
 * It reports in BOTH directions on purpose. The first version rendered only on
 * drift, which meant a blank corner conflated "verified clean across hundreds of
 * edits" with "the store never ran" — so the gate ("zero steady-state drift")
 * was unfalsifiable AND unprovable from the UI. A silent instrument cannot
 * certify anything.
 *
 * Note what does and does not move the counter: it advances on grid EDITS, not
 * on playback (the shadow store only mirrors `gridEdit` ops). Idle transport
 * produces no evidence at all.
 */
/**
 * P5-04 drift alarm — the ONLY persistent shadow chrome, and only when something
 * is wrong.
 *
 * History worth keeping: this badge went through three shapes. It began
 * silent-when-clean (unreadable: "verified" and "never ran" looked identical),
 * then always-on with a coverage readout (which is what let the user drive the
 * gate to 9/9). The gate PASSED 2026-07-12 — so the always-on readout has done
 * its job and is now just chrome in a music-making surface, against the user's
 * standing "zero non-session chrome" rule.
 *
 * What stays: the alarm. Until THE FLIP lands, the shadow store is still the
 * safety net that would catch a reducer regression, so a drift must interrupt.
 * The evidence counts move on-demand → right-click the grid background.
 */
function ShadowDriftAlarm({
  drift,
  lastDrift,
  onInspect,
}: {
  drift: number;
  lastDrift: DriftRecord | null;
  onInspect: () => void;
}) {
  if (drift === 0) return null; // clean = zero chrome (the grid is for music)
  return (
    <div
      className="grid-shadow-badge is-drift"
      title={`${drift} drift event(s) — a TS reducer's prediction diverged from the engine. Click to inspect the diff.`}
      onClick={() => lastDrift && onInspect()}
    >
      SHADOW DRIFT ×{drift}
    </div>
  );
}

/** Evidence summary for the on-demand menu item (no persistent chrome). */
/**
 * P5-06 step A readout. A never-run state must NOT read as a pass — the same ambiguity
 * the shadow badge was fixed for (P5-04d): a blank corner that could mean "verified
 * clean" or "never ran" is worse than no readout at all.
 */
function worldCheckLabel(state: WorldCheck): string {
  if (state === null) return "World wire — not run";
  if (state === "running") return "World wire — checking…";
  if (state.ok) return `World wire ✓ byte-identical (${(state.bytes / 1024).toFixed(0)} KB)`;
  return `World wire ✗ DIVERGED at byte ${state.firstDiff} — see console`;
}

type WorldCheck = RoundTripResult | "running" | null;

function shadowEvidenceLabel(verified: number, verifiedByOp: Record<string, number>): string {
  const { covered, missing } = shadowCoverage(verifiedByOp);
  const total = covered.length + missing.length;
  if (verified === 0) return "Shadow: idle (edits, not playback, feed it)";
  return `Shadow: ✓ ${verified} verified · ${covered.length}/${total} reducers`;
}

/**
 * Where a grid gets its state, where its edits go, and how densely it draws.
 *
 * P6-03 (djmode.md §8 Q1 — REUSE, not fork): the DJ deck strip is the SAME
 * instrument as the compose row, at a different density. Rather than a second
 * implementation, the panel takes its topics / HotFrame slot / edit scope /
 * metrics from here, so every future row fix lands on both surfaces at once.
 */
export interface GridSource {
  /** UiState topic carrying GridMetaState. */
  metaTopic: string;
  /**
   * P5-06 step B — the ownership split. One track now arrives as TWO topics:
   *
   *   patternTopic  the DOCUMENT (GridPatternState) — TS's after the flip
   *   runtimeTopic  Swift's forever (GridRuntimeState) — sample/plugin/transport state
   *
   * A track is only built once BOTH have landed; the two are merged and the derived fields
   * computed (deriveTrackState). Swift pushes runtime FIRST so pattern always completes the
   * pair — see the invariant note in WebGridBinding.pushTrack.
   */
  patternTopic: (i: number) => string;
  runtimeTopic: (i: number) => string;
  /** HotFrame index of track 0's playhead STEP for this surface. */
  hotBase: number;
  /** HotFrame index of track 0's SAMPLE POSITION for this surface (SIG-1). The
      step says which cell; this says where inside the audio. */
  hotPosBase: number;
  /** HotFrame index of track 0's ACTIVITY LEVEL for this surface (SIG-3): real
      post-plugin mix contribution, engine-decayed, 0 = silent. Drives the row
      LED — the one signal that keeps reporting a ringing plugin after stop. */
  hotLevelBase: number;
  /**
   * Deck scope for gridEdit / trackEdit / getSamplePeaks. undefined = the
   * compose resolver's sequencer (unchanged); 0|1|2 = that DJ deck.
   */
  deck?: number;
  /**
   * Feed the P5-04 shadow PatternStore. ONLY the compose surface may: the
   * store is a singleton keyed by TRACK INDEX, and it is the evidence gate for
   * P5-06 THE FLIP. Letting three DJ decks write into it would interleave
   * three different patterns under the same keys and manufacture drift that
   * isn't real — destroying the very evidence it exists to produce.
   */
  shadow: boolean;
  /** Row metrics. "dj" = the compact deck strip. */
  density: "compose" | "dj";
}

/** Cell-row / control-band metrics per density. */
const METRICS = {
  // MIN cell-row height (cells balloon above this to fill; the stack scrolls
  // below it). 68 ≈ native base cell (~63) + margin — room for the top tool
  // band (accent zone + step number) AND the bottom value chip with a legible
  // waveform between.
  compose: { cellRowH: 68, bandH: 116, gap: 7 },
  // DJ: two decks share the window, so the row halves. The cells stay tall
  // enough for the waveform + playhead to read across a room (that IS the
  // performance information); the control band goes compact-horizontal, which
  // the CSS density class handles.
  dj: { cellRowH: 40, bandH: 74, gap: 4 },
} as const;

/** Coarse-pointer metrics. Compose ships UNCHANGED (68px min row already
 *  clears the 44px fingertip minimum); DJ's 40 rounds up to it. The table
 *  exists so post-device-test tuning is a constant edit, not a refactor. */
const METRICS_COARSE = {
  compose: { cellRowH: 68, bandH: 116, gap: 7 },
  dj: { cellRowH: 44, bandH: 74, gap: 4 },
} as const;

/** Row metrics per density + pointer class. Device class, not per-event:
 *  layout can't follow the pointer that happens to press it. */
const gridMetrics = (density: "compose" | "dj") =>
  isCoarsePointer() ? METRICS_COARSE[density] : METRICS[density];

export const COMPOSE_SOURCE: GridSource = {
  metaTopic: "gridMeta",
  patternTopic: (i) => `gridPattern/${i}`,
  runtimeTopic: (i) => `gridRuntime/${i}`,
  hotBase: HotFrameLayout.trackStep0,
  hotPosBase: HotFrameLayout.trackPos0,
  hotLevelBase: HotFrameLayout.trackLevel0,
  shadow: true,
  density: "compose",
};

/** The deck-scoped source for DJ deck `deck` (0=A, 1=B, 2=C). */
export const djSource = (deck: number): GridSource => ({
  metaTopic: `djMeta/${deck}`,
  patternTopic: (i) => DJ_PATTERN_TOPIC(deck, i),
  runtimeTopic: (i) => DJ_RUNTIME_TOPIC(deck, i),
  hotBase: djTrackStepIndex(deck, 0),
  hotPosBase: djTrackPosIndex(deck, 0),
  hotLevelBase: djTrackLevelIndex(deck, 0),
  deck,
  shadow: false, // see GridSource.shadow — never from a DJ deck
  density: "dj",
});

export function GridPanel({
  link,
  source = COMPOSE_SOURCE,
  cellsHidden = false,
  djSlotIndex,
}: {
  link: EngineLink | null;
  source?: GridSource;
  /**
   * Collapse the cell grid away, leaving only the control bands (the DJ deck's
   * GRID toggle). The rows stay fully live — this hides the pattern canvas, not
   * the track.
   */
  cellsHidden?: boolean;
  /**
   * DJ view only: this deck's COLUMN position (0 = left slot, 1 = right slot).
   * Enables the one-ring cross-deck navigation — stepping off this deck's step
   * edge hands the ring to the deck in the neighbouring slot. Undefined in
   * compose (single grid, nothing to cross into).
   */
  djSlotIndex?: number;
}) {
  // MOD-7: sweep bands + arm-to-map live on the track-band controls, so the modulation
  // domain is subscribed once here and threaded down through BandCtx.
  const mod = useModulation(link);
  const metrics = gridMetrics(source.density);
  const CONTROL_BAND_H = metrics.bandH;
  /** Deck scope folded into every outgoing edit/peaks command. */
  const scope = source.deck === undefined ? {} : { deck: source.deck };
  // NAV-11: focus-id scope for THIS panel. The DJ page mounts two grids whose
  // band controls all register `track/<i>/<ctrl>`; a per-slot prefix keeps the
  // GLOBAL focus registry unambiguous (before this, the second deck overwrote
  // the first, and band traversal read the wrong deck's DOM). Compose has no
  // slot → "" → ids unchanged. Stable per mount, so the once-registered keydown
  // listener may close over it directly.
  const focusScope = djSlotIndex !== undefined ? `s${djSlotIndex}/` : "";
  // The band track behind a (scoped) focused-control id — but only when the
  // control belongs to THIS panel, so deck B never treats deck A's focused box
  // (shared global store) as one of its own bands.
  const bandTrackOfFocus = (id: string | null | undefined): number | null => {
    if (!id || !id.startsWith(focusScope)) return null;
    const m = /^track\/(\d+)\//.exec(id.slice(focusScope.length));
    return m ? Number(m[1]) : null;
  };
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const hotRef = useRef<HTMLCanvasElement | null>(null);
  const [meta, setMeta] = useState<GridMetaState | null>(null);
  // PERF (perform mode) rides this grid's meta topic, so it works identically for
  // the compose grid (follows the active deck) and each DJ deck. The pointer
  // handlers are recreated each render, so reading it as a plain derived value
  // here is enough — no ref needed. See onPointerDown/Move/Up.
  const performActive = meta?.performActive ?? false;
  const tracksRef = useRef<(GridTrackState | null)[]>(Array(MAX_GRID_TRACKS).fill(null));
  // P5-06 step D: who owns the pattern (from gridMeta), and when we last published each track —
  // echoes inside that window are OUR OWN and must not be adopted (see publishOwned).
  const ownerRef = useRef(false);
  const lastPublishAt = useRef<number[]>(Array(MAX_GRID_TRACKS).fill(0));
  /**
   * ⚠️ The next `gridPattern` push for this track came from SWIFT, not from us — ADOPT it even
   * inside the owner-quiet window.
   *
   * Without this the window is a silent corruption: Swift changes a track (a sample load, an
   * undo, a native edit), the push lands within 300 ms of our last publish, we DISCARD it — and
   * `tracksRef` keeps the state Swift just overwrote. Every later reducer builds on that stale
   * copy, and the next publish writes it back over Swift's change. The two diverge permanently.
   */
  const adoptNextEcho = useRef<boolean[]>(Array(MAX_GRID_TRACKS).fill(false));
  // How many pattern writes TS has actually made. Without this, "I flipped it and nothing
  // changed" is indistinguishable from "the flag did nothing" — which is exactly the report that
  // came back. A count that climbs as you edit is the difference between the two.
  const [publishCount, setPublishCount] = useState(0);
  const [publishError, setPublishError] = useState<string | null>(null);
  // P5-06 step B: the two wire halves, held until both have landed (see GridSource).
  const patternRef = useRef<(GridPatternState | undefined)[]>(Array(MAX_GRID_TRACKS).fill(undefined));
  const runtimeRef = useRef<(GridRuntimeState | undefined)[]>(Array(MAX_GRID_TRACKS).fill(undefined));
  /** Keyed by sample × resolution (peaksKey) — a density change is new data. */
  const peaksRef = useRef<Map<string, Peaks>>(new Map());
  /** The live waveform style (theme token group), mirrored for the canvas. */
  const styleRef = useRef<WaveformStyle>(DEFAULT_WAVEFORM);
  const layoutRef = useRef<TrackLayout[]>([]);
  const dragRef = useRef<DragState | null>(null);
  // PERF (DJ perform mode): the in-flight locator-window drag. Pure machine in
  // performLocator.ts; the release sends setLocatorRange/setLocatorRepeat.
  const performRef = useRef<PerformDrag | null>(null);
  // The anchor ROW's layout captured at PERF press, so the drag maps steps
  // X-only (row-locked) like the body machine's clampColStep instead of a
  // y-banded hit-test — a drag that drifts off the row still extends the
  // window rather than freezing and resolving as a disengage click.
  const perfLayRef = useRef<TrackLayout | null>(null);
  // In-cell affordance gesture (incell-affordance-ux.md §3.2) — pending until
  // the deadzone resolves toggle (stationary) vs re-dispatch (drag).
  const markRef = useRef<MarkDrag | null>(null);
  // Deferred TOUCH press: a finger press classifies on movement/release, never
  // at pointerdown — pressBody stamps empty cells at press, and a long-press
  // (menu) or abandoned touch must not mutate the pattern. Mouse/pen keep the
  // press-time path (press feedback is a feature there).
  const touchPendingRef = useRef<{
    hit: { lay: TrackLayout; step: number; rect: Rect };
    trackIndex: number;
    x: number;
    y: number;
    keptSelection: boolean;
    tuning: GestureTuning;
  } | null>(null);
  // Live touch points on the canvas (client-space Ys): one finger composes,
  // two fingers pan the scroll container (the canvas is touch-action: none,
  // so native panning cannot).
  const touchPointsRef = useRef<Map<number, number>>(new Map());
  const panAvgYRef = useRef<number | null>(null);
  // Selection + keyboard focus are WEB-side (grid.md P5-02); copy hands the
  // explicit step list to the shared native clipboard.
  const selRef = useRef<GridSelection>({ trackIndex: -1, steps: new Set(), anchor: null });
  const focusRef = useRef<{ trackIndex: number; step: number } | null>(null);
  // P2.1 one focus world: the FocusModel owns the lane; focusRef stays the
  // canvas-side mirror of the cell focus (fast reads inside draw/pointer
  // code). Subscribing to the lane re-renders → redraws the (dimmed) ring.
  const lane = useFocusModel((s) => s.lane);
  // Cross-webview focus: a DragBox in ANOTHER webview owns the controls ring
  // (focusRelay). Treated like the local controls lane for ring dimming and
  // ö/ä yielding, while the lane itself stays "grid" so arrows keep navigating.
  const remoteControls = useFocusModel((s) => s.remoteControls);
  // P5-04 shadow evidence badge. Originally this rendered ONLY on drift, which
  // made a blank corner ambiguous: "verified clean over 400 edits" and "the
  // store never ran" looked identical, so the P5-06 evidence gate was not
  // actually readable. It now always reports — a calm verified count when
  // clean, a --warn drift count when not. Absence of a badge is no longer
  // evidence of anything; a green count is.
  const verifiedCount = usePatternStore((s) => s.verifiedCount);
  const driftCount = usePatternStore((s) => s.driftCount);
  const lastDrift = usePatternStore((s) => s.lastDrift);
  const verifiedByOp = usePatternStore((s) => s.verifiedByOp);
  const [driftDetail, setDriftDetail] = useState(false);
  // NK-5: does this grid hold the keyboard? A REF, not the `meta` state: the
  // keydown listener below is registered once per `link`, so it closes over the
  // first render's `meta` for ever — reading state inside it would answer with
  // whatever was true at mount.
  //
  // NAV-11: the DEFAULT must match Swift's launch-transient rule (isKeyboardActive
  // with a nil activeSequencer): exactly ONE grid owns keys before the first meta
  // push — compose, or DJ SLOT 0. Defaulting every grid to true let BOTH DJ decks
  // handle each key at launch (live now that the webview is first responder from
  // NAV-10) and race `selectTrack`/`activeSequencer` — the exact NK-5 disease.
  const keyboardActiveRef = useRef(djSlotIndex === undefined || djSlotIndex === 0);
  // The CURRENT multi-selection, readable inside the once-registered key
  // handler and setCellFocus (same freeze trap). Synced from meta below.
  const selectedTracksRef = useRef<number[]>([]);
  // Same reason as keyboardActiveRef: the keydown handler is registered once per
  // `link`, so it must read this deck's live slot/deck through refs — otherwise
  // cross-deck nav would freeze on the deck that sat here at mount and break once
  // a deck-C projection swapped which deck occupies this slot.
  const djDeckRef = useRef(source.deck);
  djDeckRef.current = source.deck;
  const djSlotRef = useRef(djSlotIndex);
  djSlotRef.current = djSlotIndex;
  const setCellFocus = (
    cell: { trackIndex: number; step: number },
    opts?: { silent?: boolean },
  ) => {
    const prev = focusRef.current;
    focusRef.current = cell;
    // The canvas draws the focus ring from `focusRef`, and a ref moves without a render — so the
    // move and its repaint tick belong together, here. They used to be apart: the static layer had
    // no dep array and repainted on ANY render, so callers got the ring back by luck rather than by
    // asking, and only some of them bump. Now that the repaint is keyed on `drawTick`, this is what
    // makes the ring follow the cursor. Keep it BEFORE the `silent` return — a silent move (mount
    // seed, ⇧↑/⇧↓) skips telling native, not the drawing.
    if (prev?.trackIndex !== cell.trackIndex || prev?.step !== cell.step) bump((n) => n + 1);
    useFocusModel.getState().setCellFocus(cell);
    // silent: move the web cursor WITHOUT telling native. Two callers: the
    // mount init (native's selection must not be stomped by a ring that merely
    // became visible — and in the DJ page all three grids init, so a non-silent
    // init would race activeSequencer) and ⇧↑/⇧↓ (addTrackToSelection already
    // moved Swift's keyboard index; a second selectTrack would be redundant).
    if (opts?.silent) return;
    // NK-3: the web cursor IS the native track selection.
    //
    // Native acts "on the selected track" — ⌥ chop preview, batch fan-outs,
    // activeSequencer — and the web never told it which track that was, so
    // those fired at a stale index (in practice track 0). Note-in is no longer
    // on that list: routing is pin-only (2026-07-15). Every cursor move lands
    // here, pointer and keyboard alike, so this one line is the whole of
    // "track selection works in the web UI".
    //
    // Only on a TRACK change, not every step: stepping along a row must not spam
    // the wire, and native's selection has no notion of a step anyway.
    //
    // NK-5: …OR when this grid does not currently hold the keyboard. Clicking a
    // track in the OTHER deck must move the keyboard here even if that deck's
    // cursor was already sitting on that very track — otherwise the one gesture
    // that can hand the keyboard to a deck silently does nothing, and the deck you
    // just clicked still ignores your arrows. `selectTrack` → setSelectedTrack also
    // sets `activeSequencer`, so a click IS a deck switch: `-` and clicking are two
    // ways to do one thing.
    //
    // NAV-8: …OR while a multi-selection exists (Finder semantics) — a plain
    // select must COLLAPSE it even when the cursor stays on the same track
    // (click the focused row inside a ⇧-extended set → set becomes just it).
    // Swift's selectTrack collapses unconditionally now; the keep-inside rule
    // lives only behind `keepWithinSelection` (band-control clicks).
    if (
      prev?.trackIndex !== cell.trackIndex ||
      !keyboardActiveRef.current ||
      selectedTracksRef.current.length > 1
    ) {
      link
        ?.command("gridEdit", { op: "selectTrack", trackIndex: cell.trackIndex, ...scope })
        .catch(() => {});
    }
  };
  const dragSelectRef = useRef<{ trackIndex: number } | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const undoBracketRef = useRef<{ track: number; started: boolean } | null>(null);
  const [viewportH, setViewportH] = useState(0);
  // Real control-band height PER TRACK, measured from each rendered strip so
  // every track's reserve matches its own DOM (no clipped sends row, and no
  // dead space under a short band — TR-FT-6).
  const [bandHs, setBandHs] = useState<number[]>([]);
  const bandH = (k: number) => bandHs[k] ?? CONTROL_BAND_H;
  // The static canvas's repaint clock. Every ref the canvas draws from
  // (tracksRef, peaksRef, selRef, focusRef, hoverRef, styleRef, performRef)
  // mutates WITHOUT a render, so each mutation site pairs itself with `bump`.
  // That pairing is the contract the static layer's dep array relies on: the
  // tick — not "every render" — is what says "a ref the canvas reads moved".
  const [drawTick, bump] = useState(0);
  // GR-VIS orientation: explicit beat grouping (user decision 2026-07-12 —
  // explicit setting over adaptive; triplet workflows pick 3/6). Drives the
  // group shading, step-number addresses and the bar rule (every 4 groups).
  const [groupSize, setGroupSize] = useState(4);
  // P5-06 step A: last world-wire round-trip result (on-demand, read-only).
  const [worldCheck, setWorldCheck] = useState<WorldCheck>(null);
  const { openMenu } = useContextMenu();
  // Hovered cell (GR-VIS hover response). A ref + bump so pointermove only
  // redraws when the pointer crosses a cell boundary.
  const hoverRef = useRef<{ trackIndex: number; step: number } | null>(null);

  // Token edits (Appearance panel, possibly another webview) change CSS vars,
  // the universal-track-color override AND the waveform style/motion — none of
  // which reaches the canvas on its own, so mirror + repaint on every
  // applyTokens. A style change can also raise the peak resolution, which is
  // new data: refetch at the new `points` (the old arrays stay cached, so
  // flipping presets back and forth is free).
  useEffect(() => {
    const apply = () => {
      const t = currentTokens();
      styleRef.current = t.waveform;
      if (link) {
        for (let i = 0; i < MAX_GRID_TRACKS; i++) {
          const track = tracksRef.current[i];
          if (track) {
            fetchPeaksIfNeeded(
              link, i, track, peaksRef.current, () => bump((n) => n + 1), scope,
              t.waveform.points, t.waveform.colorMode === "spectrum",
            );
          }
        }
      }
      bump((n) => n + 1);
    };
    apply();
    return onTokensApplied(apply);
  }, [link]);

  // The navigator ring is always on screen: the focus model starts EMPTY, so
  // before this the ring appeared only after the first click/arrow — invisible
  // exactly when a new user is looking for it. Seed the cursor at the first
  // live track / step 0, SILENTLY (no selectTrack: native's selection must not
  // be stomped by a ring that merely became visible, and in the DJ page all
  // three grids run this — a non-silent init would race activeSequencer).
  // Re-seeds whenever the cursor's track stops existing (track deleted, or
  // empty→nonempty), so the ring never dies with its row. Runs every render:
  // the guard is two ref reads, and track pushes don't re-render on a schedule
  // this could subscribe to.
  useEffect(() => {
    const cur = focusRef.current;
    if (cur && tracksRef.current[cur.trackIndex]) return;
    const first = tracksRef.current.findIndex((t) => t !== null);
    if (first < 0) return;
    const cell = { trackIndex: first, step: 0 };
    focusRef.current = cell;
    // Don't steal the lane: if a DragBox already owns the keys (possible when
    // the first track push lands late) — locally OR in another webview — only
    // the canvas mirror moves.
    const fs = useFocusModel.getState();
    if (fs.focused === null && !fs.remoteControls) {
      fs.setCellFocus(cell);
    }
    bump((n) => n + 1);
  });

  // The outer panel's VIEWPORT height sets the floor; the stack grows to the
  // content height (cells + fat bands) and scrolls when it exceeds the
  // viewport. Both the canvas and the DOM band derive tops/heights from the
  // SAME stack height (gridRowLayout), so they stay pixel-aligned incl. split.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, [meta !== null]);

  // NK-3: hand the mode to the relay module, which owns BOTH consequences of it —
  // this panel yielding its letters, and the root deny-list lifting ö/ä (piano E
  // and F on a QWERTZ). One flag, so the two can never disagree and strand a key.
  // Swift reports the FOCUSED sequencer's mode on every deck's meta, so the three
  // DJ grids all write the same value and there is no last-writer race.
  useEffect(() => {
    if (meta) setNoteKeyboardActive(meta.noteKeyboardActive);
  }, [meta?.noteKeyboardActive]);

  // NK-5: keep the ref in step with the deck that holds the keyboard.
  //
  // NAV-12: …and when the keyboard ARRIVES here without a gesture of our own —
  // the `-` deck switch, whose whole effect is Swift moving activeSequencer —
  // bring the ring with it. Without this the focus store stays pointed at the
  // deck you left: this deck swallows the arrows (a foreign-scope id resolves to
  // "none of my bands") and ö/ä keeps driving the other deck's box, so `-` looks
  // like it did nothing and only a click on a box over here unsticks it.
  // See planDeckFocusAdoption for what each lane means here.
  useEffect(() => {
    if (!meta) return;
    const had = keyboardActiveRef.current;
    keyboardActiveRef.current = meta.keyboardActive;
    if (!meta.keyboardActive || had || djSlotIndex === undefined) return;
    const st = useFocusModel.getState();
    const plan = planDeckFocusAdoption({
      lane: st.lane,
      focusedId: st.focused?.id,
      scope: focusScope,
    });
    if (plan.kind === "keep") return;
    if (plan.kind === "control") {
      if (acquireControlFocus(plan.mirrorId)) return;
      if (plan.trackPrefix && acquireFirstControlFocus(plan.trackPrefix)) return;
    }
    // Fall back to the cell cursor this deck keeps seeded. Store-only: Swift's
    // switchActiveDeck already moved the selection, so a selectTrack here would
    // just echo it back (and a non-silent one races the deck we came from).
    if (focusRef.current) st.setCellFocus(focusRef.current);
    bump((n) => n + 1);
  }, [meta?.keyboardActive]);

  // Escape + the Finder-collapse rule need the CURRENT multi-selection inside
  // the once-registered key handler (ref declared with keyboardActiveRef).
  // Keyed on the VALUE, not the array's identity: Zod parses a fresh array on every
  // gridMeta push, so an identity dep re-ran this on every unrelated push (bpm, transport…).
  useEffect(() => {
    if (meta) selectedTracksRef.current = meta.selectedTrackIndices;
  }, [meta?.selectedTrackIndices.join(",")]);

  // DJ view: register this deck with the cross-deck focus bridge so the deck at
  // its step edge can hand us the ring (one ring, L→R across both decks). Compose
  // passes no djSlotIndex and never registers. Re-registers when the slot's deck
  // changes (deck C projecting in or out).
  useEffect(() => {
    if (source.deck === undefined || djSlotIndex === undefined) return;
    const deck = source.deck;
    return registerDjFocus(deck, djSlotIndex, (edge, fromTrackIndex) => {
      const lays = layoutRef.current;
      if (!lays.length) return;
      // Keep the incoming track row where it exists; else land on the nearest end.
      const lay =
        lays.find((l) => l.trackIndex === fromTrackIndex) ??
        (edge === "left" ? lays[0]! : lays[lays.length - 1]!);
      const step = edge === "left" ? 0 : Math.max(0, lay.stepCount - 1);
      const cell = { trackIndex: lay.trackIndex, step };
      focusRef.current = cell;
      useFocusModel.getState().setCellFocus(cell);
      // Take the keyboard: this deck is not currently active, so selectTrack
      // switches HotkeyManager.activeSequencer here (Swift re-pushes both decks'
      // meta.keyboardActive, and the ring lands once ours arrives).
      link
        ?.command("gridEdit", { op: "selectTrack", trackIndex: lay.trackIndex, deck })
        .catch(() => {});
      bump((n) => n + 1);
    });
  }, [link, source.deck, djSlotIndex]);

  // B1-A: the save-time persistence shadow (schema v73). Compose surface only —
  // Swift pushes `persistShadow` to the grid host after every save; this page
  // owns the TS persist model and answers with `persistShadowReport`.
  useEffect(() => {
    if (!link || source.density !== "compose") return;
    return attachPersistShadow(link);
  }, [link, source.density]);

  // --- Subscriptions: gridMeta + per-track topics ------------------------
  useEffect(() => {
    if (!link) return;
    const offs: (() => void)[] = [];
    offs.push(
      link.onUiState(source.metaTopic, (raw) => {
        const parsed = GridMetaState.safeParse(raw);
        // A rejected payload must never be silent (P5-01c: the grid went
        // pure black because every track state failed parse invisibly).
        if (!parsed.success) {
          console.error(`${source.metaTopic} rejected:`, parsed.error.issues, raw);
          return;
        }
        setMeta(parsed.data);
        ownerRef.current = parsed.data.ownerPatterns;
      }),
    );
    for (let i = 0; i < MAX_GRID_TRACKS; i++) {
      // P5-06 step B: a track is the MERGE of two topics. Rebuild it whenever either half
      // lands and both are present, then compute the derived fields.
      const rebuild = (i: number, patternChanged: boolean) => {
        const pattern = patternRef.current[i];
        const runtime = runtimeRef.current[i];
        if (!pattern || !runtime) return; // half a track is not a track
        const track = deriveTrackState({ ...pattern, ...runtime });
        tracksRef.current[i] = track;

        // P5-04 drift detector feed — COMPOSE ONLY (GridSource.shadow), and ONLY when the
        // PATTERN half changed.
        //
        // ⚠️ Feeding it on a runtime change would corrupt the flip's own evidence gate: a
        // transport tick (isStopped / launchScheduled) would arrive as an "authoritative"
        // push, compare clean against an unchanged prediction, and increment the verified
        // count — the gate would climb toward green while the user edits nothing. The counts
        // must only ever come from real edits.
        // ⚠️ NOT under the flip. The shadow store exists to prove the TS reducers match Swift
        // BEFORE ownership moves. Once TS owns the pattern it is comparing its own prediction
        // against its own output — vacuously clean, forever. A gate that cannot fail is not a
        // gate, and a number that cannot fall is not evidence.
        if (source.shadow && patternChanged && !ownerRef.current) shadowAuthoritative(i, track);

        fetchPeaksIfNeeded(
          link,
          i,
          track,
          peaksRef.current,
          () => bump((n) => n + 1),
          scope,
          styleRef.current.points,
          styleRef.current.colorMode === "spectrum",
        );
        bump((n) => n + 1);
      };

      const runtimeTopic = source.runtimeTopic(i);
      offs.push(
        link.onUiState(runtimeTopic, (raw) => {
          const parsed = GridRuntimeState.safeParse(raw);
          if (!parsed.success) {
            console.error(`${runtimeTopic} rejected:`, parsed.error.issues, raw);
            return;
          }
          runtimeRef.current[i] = parsed.data;
          rebuild(i, false);
        }),
      );

      const patternTopic = source.patternTopic(i);
      offs.push(
        link.onUiState(patternTopic, (raw) => {
          const parsed = GridPatternState.safeParse(raw);
          if (!parsed.success) {
            console.error(`${patternTopic} rejected:`, parsed.error.issues, raw);
            return;
          }
          // OWNER MODE echo suppression. While TS is publishing this track, Swift's pushes are
          // just our own edit coming back — and under a drag they can arrive OUT OF ORDER, so
          // adopting one would revert the gesture the user is still making. Ignore them; TS is
          // the owner and already has the answer. Once the track is quiet, echoes are adopted
          // again, which is how a change SWIFT made (a sample load, an undo, a native edit) still
          // reaches us.
          if (adoptNextEcho.current[i]) {
            // Swift changed this track (impure op, undo, native edit) — take it, and let the
            // reducers build on Swift's truth rather than our stale copy.
            adoptNextEcho.current[i] = false;
          } else if (
            ownerRef.current &&
            Date.now() - (lastPublishAt.current[i] ?? 0) < OWNER_ECHO_QUIET_MS
          ) {
            return;
          }
          patternRef.current[i] = parsed.data;
          rebuild(i, true);
        }),
      );
      // Initial pull. RUNTIME first, for the same reason Swift pushes it first: the pattern
      // half must be the one that completes the pair, so the shadow store never misses a
      // baseline (see WebGridBinding.pushTrack).
      link.command("getUiState", { topic: runtimeTopic }).catch(() => {});
      link.command("getUiState", { topic: patternTopic }).catch(() => {});
    }
    link.command("getUiState", { topic: source.metaTopic }).catch(() => {});

    // P5-06 UNDO: the Edit menu delegates ⌘Z / ⇧⌘Z here under the flip. It has to be the menu —
    // an NSMenu key equivalent is consumed before the web view ever sees the keystroke, so the
    // page cannot claim the key for itself.
    offs.push(
      link.onEvent((evt) => {
        // MB-3 prep: the channel is TYPED now — parse against the (repaired)
        // EngineEvent union; an unknown event is another consumer's, not noise.
        const parsed = EngineEvent.safeParse(evt);
        if (!parsed.success) return;
        const e = parsed.data;
        if (e.type === "undo") performUndo(false);
        else if (e.type === "redo") performUndo(true);
        else if (e.type === "swiftEdit") {
          // MB-1d: the DJ link hosts BOTH deck grids on one event channel, so a
          // deck-tagged announcement is adopted only by the grid it names. The
          // compose link filters Swift-side (one link per deck) and sends no deck.
          if (typeof e.deck === "number" && e.deck !== source.deck) return;
          // MB-1 — SWIFT JUST WROTE THE DOCUMENT (a native menu op, a hotkey, the track
          // clipboard). Two things must happen before its push arrives, and skipping either one
          // was a live bug:
          //
          //   1. ADOPT the echo. We normally drop any pattern push landing within
          //      OWNER_ECHO_QUIET_MS of our own publish, because that is how we ignore our own
          //      round-trip. A native edit is indistinguishable from that echo — so it was
          //      DROPPED: the engine played the new pattern, we kept the old one, and the user's
          //      next cell edit published the stale pattern back over it. Silent state loss.
          //   2. MARK the timeline. Without an entry here, ⌘Z drained every TS entry before it
          //      ever reached Swift's stack — so "Clear Grid" followed by ⌘Z undid the last cell
          //      edit, not the clear.
          //
          // We can set this before the echo lands because the announcement is emitted
          // synchronously from Swift's mutator while the pattern push is debounced 33 ms behind
          // the `$tracks` sink.
          adoptNextEcho.current.fill(true);
          pushSwiftMarker(e.scope ?? "pattern");
          reportUndo();
        }
      }),
    );
    return () => offs.forEach((off) => off());
  }, [link, source]);

  // Persisted beat grouping (generic settings channel, no schema change).
  useEffect(() => {
    if (!link) return;
    link
      .command("getSetting", { key: "grid.groupSize" })
      .then((raw) => {
        const v = (raw as { value?: unknown } | null)?.value;
        if (v === 2 || v === 3 || v === 4 || v === 6 || v === 8) setGroupSize(v);
      })
      .catch(() => {});
  }, [link]);

  // --- Static layer: redraw on any state/meta/size change ----------------
  useEffect(() => {
    const canvas = staticRef.current;
    if (!canvas || !meta) return;
    const redraw = () =>
      (layoutRef.current = drawStatic(
        canvas,
        meta,
        tracksRef.current,
        peaksRef.current,
        selRef.current,
        // ONE ring across the DJ view: only the deck that holds the keyboard
        // draws its focus ring, exactly like the row tint (navigatorTrack). The
        // DJ page mounts two grids, and before this each painted its own ring —
        // "both sides look focused" while only one acted. `keyboardActive` is
        // always true for the single compose grid, so its ring is unaffected.
        meta.keyboardActive ? focusRef.current : null,
        bandHs,
        // Parked also when a box in ANOTHER webview owns the ring (focusRelay)
        // — one bright ring across all webviews, not just across the DJ decks.
        lane === "controls" || remoteControls,
        groupSize,
        hoverRef.current,
        metrics,
        styleRef.current,
        performRef.current,
      ));
    redraw();
    const ro = new ResizeObserver(redraw);
    ro.observe(canvas);
    return () => ro.disconnect();
    // ⚠️ PERF — this dep array is load-bearing, and its ABSENCE was the track-selection lag.
    //
    // With no deps this effect re-ran on EVERY render, and a render happens on every `gridMeta`
    // push (`setMeta` stores a freshly Zod-parsed object, so `meta` is a new identity even when
    // one byte moved). So selecting a track — which changes NOTHING this canvas draws — repainted
    // every cell and every waveform of every track, and tore down/rebuilt a ResizeObserver while
    // doing it. Navigating rows queued one full repaint per keystroke on the main thread; the
    // selection tint is a DOM layer (.track-sel-overlay) that could not paint until they drained.
    //
    // The row tint and the selected name-bar are DOM. `drawStatic` reads exactly four fields off
    // `meta` — trackCount, displayMode, horizontalZoom, bpm — plus `keyboardActive` (which gates
    // the focus ring at the call site). It reads NOTHING about track selection. So depend on those
    // five, not on `meta`'s identity, and a selection change no longer touches the canvas at all.
    //
    // Everything else the canvas draws lives in refs and arrives via `drawTick` (see `bump`).
    // If you add a `meta` field to `drawStatic`, add it here too — a field read but not depended
    // on paints one push late, which is exactly the class of bug this comment exists to prevent.

    // `cellsHidden` is here for MOUNT, not for drawing: the canvas is rendered behind
    // `{!cellsHidden && <canvas>}`, so toggling it REMOUNTS the element and this effect must
    // re-run to draw on (and observe) the new one — otherwise it would hold the old canvas
    // and the grid would come back blank.
  }, [
    meta?.trackCount,
    meta?.displayMode,
    meta?.horizontalZoom,
    meta?.bpm,
    meta?.keyboardActive,
    drawTick,
    bandHs,
    lane,
    remoteControls,
    groupSize,
    metrics,
    cellsHidden,
  ]);

  // --- Hot layer: playhead fills at rAF ----------------------------------
  // Playhead ONLY. The waveform never animates (user 2026-07-12: "no animation
  // any longer, just pure performance and information"), so the hot layer has
  // no per-cell work: it clears, fills the playhead rects, and yields.
  useEffect(() => {
    const canvas = hotRef.current;
    if (!canvas || !link) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const trackSteps = new Float64Array(MAX_GRID_TRACKS).fill(-1);
    // SIG-1: where inside its sample each track's newest voice is (0…1). Lands in
    // a typed array, never React state — the hot-surface rule (a 30 Hz setState
    // would re-render the whole grid).
    const trackPos = new Float64Array(MAX_GRID_TRACKS).fill(-1);
    let raf = 0;
    const off = link.onHotFrame((frame) => {
      for (let i = 0; i < MAX_GRID_TRACKS; i++) {
        trackSteps[i] = frame[source.hotBase + i] ?? -1;
        trackPos[i] = frame[source.hotPosBase + i] ?? -1;
      }
    });
    const css = (n: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const paint = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // Live activity renders in the --signal role (DESIGN-SYSTEM §2) — the
      // accent stays reserved for selection/focus, so the playhead can never
      // be confused with either.
      const signal = css("--signal");
      const surface = currentTokens().surface;
      for (const lay of layoutRef.current) {
        const step = trackSteps[lay.trackIndex] ?? -1;
        if (step < 0) continue;
        const rect = lay.cellRect(step as number);
        if (!rect) continue;

        // The CELL wash: which step is playing. Still true, still useful — you
        // read it from across a room.
        ctx.globalAlpha = surface.playheadAlpha;
        ctx.fillStyle = signal;
        fillCell(ctx, rect.x, rect.y, rect.w, rect.h);

        // SIG-1 — THE CURSOR: where inside the audio the voice actually is.
        //
        // The wash above can only say "this cell". This says "this frame", and
        // the two are not the same claim: an eight-step REG cell, a pitched or
        // varispeed voice eating its buffer faster than the clock, a reversed
        // cell running backwards — in all of them the sound is nowhere near
        // where the step boundary implies.
        //
        // Nothing here animates. The waveform is the same frozen drawing it has
        // always been; this is a cursor moving across it, which is information,
        // not decoration. Two fillRects per sounding track per frame.
        const hit = lay.playheadX(step as number, trackPos[lay.trackIndex] ?? -1);
        if (!hit) continue;

        // The column under the cursor burns full-bright: the waveform reads
        // ITSELF as it plays. Clipped to the cell so it can never bleed.
        ctx.save();
        ctx.beginPath();
        ctx.rect(hit.rect.x, hit.rect.y, hit.rect.w, hit.rect.h);
        ctx.clip();
        ctx.globalAlpha = 1;
        ctx.fillRect(Math.round(hit.x), hit.rect.y + 1, 1, hit.rect.h - 2);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(raf);
      off();
    };
    // `meta` was in here but this effect never reads it — it draws from `layoutRef` and the hot
    // frame. Every gridMeta push (a new object identity) therefore unsubscribed the 30 Hz hot
    // frame, cancelled the rAF loop, reallocated both Float64Arrays and restarted — so each
    // selection change also blanked the playhead trail to -1 for a frame. `source` is stable
    // (a module constant in compose, useMemo'd in DjPanel).
    //
    // `cellsHidden` for the same MOUNT reason as the static layer: this canvas is conditionally
    // rendered too, so a toggle must re-bind the loop to the new element. (`meta` used to cover
    // that by accident — a push happens to re-run this — which is exactly the kind of self-heal
    // that hides the real dependency until someone removes the accidental one.)
  }, [link, source, cellsHidden]);

  // --- SIG-3: the row OUTPUT meter ---------------------------------------
  // Each TrackBand registers its .trk-led well here; one loop drives all of
  // them (cap width = bar fill, a peak-hold tick, and a right-edge clip latch).
  // DELIBERATELY its own effect, NOT part of the hot-canvas effect above: that
  // one dies with its canvas in the DJ cellsHidden mode, and a collapsed deck's
  // meters must stay live — a ringing plugin on a hidden grid is exactly the
  // "who is making that sound?" case this exists for. The peak-hold + clip-latch
  // state lives HERE (per-track typed arrays), the same shape as OutputMeter's
  // locals, so the meter reads like the app's other meters.
  const ledRefs = useRef(
    new Map<number, { cap: HTMLElement; hold: HTMLElement; clip: HTMLElement }>(),
  );
  const registerLed = useCallback((i: number, well: HTMLElement | null) => {
    if (!well) {
      ledRefs.current.delete(i);
      return;
    }
    const cap = well.querySelector<HTMLElement>(".trk-led-cap");
    const hold = well.querySelector<HTMLElement>(".trk-led-hold");
    const clip = well.querySelector<HTMLElement>(".trk-led-clip");
    if (cap && hold && clip) ledRefs.current.set(i, { cap, hold, clip });
  }, []);
  useEffect(() => {
    if (!link) return;
    // Levels land in a typed array, never React state — the hot-surface rule.
    const levels = new Float64Array(MAX_GRID_TRACKS);
    // Peak-hold + clip-latch state, mirroring OutputMeter's decay locals.
    const hold = new Float64Array(MAX_GRID_TRACKS);
    const holdAge = new Int32Array(MAX_GRID_TRACKS);
    const clipAge = new Int32Array(MAX_GRID_TRACKS).fill(-1); // -1 = not latched
    // Last-written trackers so an idle meter writes NOTHING.
    const wCap = new Float64Array(MAX_GRID_TRACKS).fill(-1);
    const wHold = new Float64Array(MAX_GRID_TRACKS).fill(-1);
    const wClip = new Int8Array(MAX_GRID_TRACKS).fill(-1);
    const off = link.onHotFrame((frame) => {
      for (let i = 0; i < MAX_GRID_TRACKS; i++) {
        levels[i] = frame[source.hotLevelBase + i] ?? 0;
      }
    });
    // ~0 dBFS clip threshold; peak-hold sits ~0.75 s then bleeds; clip latch
    // holds ~1.5 s (frame counts at rAF ~60 Hz — same feel as OutputMeter).
    const CLIP = 0.99;
    const HOLD_SETTLE = 45;
    const CLIP_HOLD = 90;
    let raf = 0;
    const paint = () => {
      for (const [i, els] of ledRefs.current) {
        const lvl = levels[i] ?? 0;
        if (lvl > hold[i]!) {
          hold[i] = lvl;
          holdAge[i] = 0;
        }
        if (lvl >= CLIP) clipAge[i] = 0;

        // Bar fill: the cap covers the right (1 − fill) of the fixed green→red
        // gradient, so a hot track pushes the bar into the red right end.
        const fill = levelToLedFill(lvl);
        if (fill !== wCap[i]) {
          wCap[i] = fill;
          els.cap.style.width = `${(1 - fill) * 100}%`;
        }
        // Peak-hold tick: parked at the highest recent level (same fill scale),
        // hidden once it bleeds back to silence.
        const hf = levelToLedFill(hold[i]!);
        if (hf !== wHold[i]) {
          wHold[i] = hf;
          if (hf <= 0) {
            els.hold.style.opacity = "0";
          } else {
            els.hold.style.opacity = "1";
            els.hold.style.left = `${hf * 100}%`;
          }
        }
        // Right-edge clip latch: lights --hot and HOLDS after a 0 dBFS peak, so
        // a clip that already decayed off the bar is still visible.
        const clipped: number = clipAge[i]! >= 0 ? 1 : 0;
        if (clipped !== wClip[i]) {
          wClip[i] = clipped;
          els.clip.classList.toggle("on", clipped === 1);
        }

        holdAge[i]!++;
        if (holdAge[i]! > HOLD_SETTLE) hold[i]! *= 0.9;
        if (hold[i]! < 0.001) hold[i] = 0;
        if (clipAge[i]! >= 0) {
          clipAge[i]!++;
          if (clipAge[i]! > CLIP_HOLD) clipAge[i] = -1;
        }
      }
      raf = requestAnimationFrame(paint);
    };
    raf = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(raf);
      off();
    };
    // Deps mirror the hot-canvas lesson above: `meta` identity must NEVER land
    // here (every gridMeta push would tear down the 30 Hz subscription). The
    // meter wells register through a stable callback, so mount churn is
    // invisible to this effect. No `cellsHidden`: the meters live in the DOM
    // band, not the conditionally-rendered canvas.
  }, [link, source]);

  // --- Editing (P5-02 view+command): pointer → gridEdit Commands ---------
  // Every mutation applies OPTIMISTICALLY to the local render state the
  // instant it is sent (gridModel reducers) — the authoritative grid/<i>
  // push overwrites it ~35 ms later. Without this, drags render at
  // round-trip latency and feel dead.
  /**
   * P5-06 step D — THE FLIP. TS owns the pattern: apply the reducer HERE, then tell Swift.
   *
   * The reducer is the write path now, not an intent. Swift's `tracks[i]` becomes a mirror we
   * write through, and its own didSet → pushState chain carries the edit to the engine.
   *
   * ⚠️ ECHO SUPPRESSION is what makes this safe. Swift still pushes `gridPattern/<i>` back
   * (33 ms debounced), and those echoes are OURS. Adopting them would be harmless if they always
   * arrived in order — but under a drag they do not: publish A, publish B, echo A lands, and
   * adopting it would REVERT the user's own gesture mid-drag. So while a track is being published
   * to, its echoes are ignored outright; TS is the owner and already knows the answer. Once the
   * track goes quiet, echoes are adopted again — which is how a change Swift made on its own (a
   * sample load, an undo, a native edit) still reaches us.
   */
  const publishOwned = (trackIndex: number, next: GridTrackState, label = "edit") => {
    // P5-06 UNDO — record BEFORE overwriting. Inside a gesture bracket this is a no-op (the
    // gesture records ONE entry when it closes); outside one it records the discrete edit.
    const prev = patternRef.current[trackIndex];
    const nextPattern = projectPattern(next);
    if (prev) recordEdit(trackIndex, prev, nextPattern, label, samePattern);

    tracksRef.current[trackIndex] = next;
    patternRef.current[trackIndex] = nextPattern;
    lastPublishAt.current[trackIndex] = Date.now();
    bump((n) => n + 1);
    setPublishCount((n) => n + 1);
    reportUndo();
    if (!link) return;
    link
      .command("publishTrackPattern", {
        trackIndex,
        json: JSON.stringify(nextPattern),
        ...scope,
      })
      .then((raw) => {
        const r = COMMANDS.publishTrackPattern.result.parse(raw);
        // Never swallow a refusal: if Swift declined the write, the grid is showing an edit the
        // engine never heard, and silence would make that look like it worked.
        if (!r.applied) {
          setPublishError(r.error ?? "refused");
          console.error("[owner] publishTrackPattern REFUSED:", r.error);
        } else if (publishError) {
          setPublishError(null);
        }
      })
      .catch((err) => {
        setPublishError(String(err));
        console.error("publishTrackPattern failed:", err);
      });
  };

  /** Two patterns are "the same" iff they canonicalize identically (float-normalized). */
  const samePattern = (a: GridPatternState, b: GridPatternState) =>
    canonicalPatternState(a) === canonicalPatternState(b);

  // TR-RND — the per-track TOOL handlers, wired down to each track row. They own
  // NO op string: they apply the TS reducer and publish the whole pattern through
  // the owner write path (publishOwned = one undo entry, one ⌘Z). Owner-mode only
  // (the flip is live); a legacy Swift-owner session has no reducer to run here.
  const handleRandomize = (trackIndex: number) => {
    if (!ownerRef.current) return;
    const cur = tracksRef.current[trackIndex];
    if (!cur) return;
    publishOwned(
      trackIndex,
      applyRandomizePattern(cur, {}, mulberry32(randomSeed())),
      "Randomize track",
    );
  };
  const handleClearTrack = (trackIndex: number) => {
    if (!ownerRef.current) return;
    const cur = tracksRef.current[trackIndex];
    if (!cur) return;
    publishOwned(trackIndex, applyClearPattern(cur), "Clear track");
  };

  /** Keep the Edit menu honest: it can only enable ⌘Z if it knows our depth. */
  const reportUndo = () => {
    link
      ?.command("reportUndoState", {
        undo: undoDepth(),
        redo: redoDepth(),
        label: undoLabel(),
      })
      .catch(() => {});
    // MB-3: undo depth/label are menu-tree inputs (Undo <label>, enablement) —
    // this is the choke point every undo-affecting change already passes.
    menuBridgeRef.current?.publish();
  };

  /**
   * P5-06 UNDO — apply one entry and publish it.
   *
   * Writes tracksRef/patternRef DIRECTLY rather than going through publishOwned, because
   * publishOwned RECORDS history — and an undo must not become a new undo entry.
   */
  const applyUndoEntry = (trackIndex: number, pattern: GridPatternState) => {
    const runtime = runtimeRef.current[trackIndex];
    if (!runtime) return;
    patternRef.current[trackIndex] = pattern;
    tracksRef.current[trackIndex] = deriveTrackState({ ...pattern, ...runtime });
    lastPublishAt.current[trackIndex] = Date.now();
    bump((n) => n + 1);
    link
      ?.command("publishTrackPattern", { trackIndex, json: JSON.stringify(pattern), ...scope })
      .catch((err) => console.error("undo publish failed:", err));
  };

  const performUndo = (redo: boolean) => {
    const entry = redo ? popRedo() : popUndo();
    if (entry && entry.kind === "pattern") {
      applyUndoEntry(entry.trackIndex, redo ? entry.after : entry.before);
      reportUndo();
      return;
    }
    // Two cases arrive here, and they delegate identically:
    //
    //   1. A SWIFT MARKER (MB-1) — a native edit (the Pattern menu, a hotkey, the track clipboard,
    //      bpm, topology) sits at THIS point in the timeline. TS has no payload to replay, so it
    //      hands the step to Swift's stack. The marker is the whole reason ⌘Z can walk a mixed
    //      history in the order the user worked: before it existed, TS drained every one of its own
    //      entries first, so "Clear Grid" then ⌘Z undid your last cell edit instead of the clear.
    //   2. An EXHAUSTED stack — the history predates the page (a session loaded before the flip).
    //
    // Either way Swift's restore rewrites `tracks` and pushes it back, so the next echo MUST be
    // adopted — otherwise the owner-quiet window swallows it and TS keeps (and re-publishes) the
    // un-undone state, diverging from the engine permanently.
    adoptNextEcho.current.fill(true);
    link?.command("swiftUndo", { redo, ...scope }).catch(() => {});
    reportUndo();
  };

  /**
   * P5-06 UNDO — the gesture bracket, owner mode.
   *
   * Under the flip these must NOT reach Swift. `beginUndoActivity` pushes a `.pattern` snapshot
   * that restores none of what TS writes (that dead entry IS why ⌘Z looked broken), and a LOST
   * `endUndo` leaves `isBatchUndoActive` true, which silently kills Swift's recording forever.
   * TS's bracket has neither failure: it records only if the pattern actually CHANGED, and a lost
   * end cannot wedge anything.
   *
   * Returns true when the op was handled here and must not be sent.
   */
  const handleBracket = (op: string, i: unknown): boolean => {
    if (!ownerRef.current || typeof i !== "number") return false;
    const p = patternRef.current[i];
    if (op === "beginUndo") {
      if (p) beginGesture(i, p);
      return true;
    }
    if (op === "endUndo") {
      if (p) {
        endGesture(i, p, "edit", samePattern);
        reportUndo();
      }
      return true;
    }
    return false;
  };

  const sendEdit = (params: Record<string, unknown>) => {
    const op = params.op as string;
    const i = params.trackIndex;
    if (handleBracket(op, i)) return;

    // OWNER MODE: modeled ops are applied by TS and published. The intent is NOT sent — sending
    // it as well would apply the edit twice (once here, once in Swift's mutator).
    if (ownerRef.current && typeof i === "number" && VERIFIABLE_GRID_OPS.has(op)) {
      const cur = tracksRef.current[i];
      if (cur) {
        publishOwned(i, applyGridOp(cur, params as unknown as GridOp));
        return;
      }
    }

    // adjustParameter (per-cell value-drag / ö/ä): the desktop applies it in
    // Swift's adjustStepParameter, but the BROWSER has no Swift — the intent
    // used to reach BrowserLink.gridEdit and be silently dropped, so per-cell
    // pitch/tone/pan/… drag did nothing there. In the browser, apply the TS
    // port through the owner write path. Desktop is untouched (it falls
    // through to link.command and Swift owns it, as before).
    if (
      op === "adjustParameter" &&
      ownerRef.current &&
      typeof i === "number" &&
      link instanceof BrowserLink
    ) {
      const cur = tracksRef.current[i];
      if (cur) {
        publishOwned(
          i,
          applyAdjustCellParameter(cur, Number(params.step), Number(params.delta), !!params.fine),
        );
        return;
      }
    }

    if (!link) return;
    link
      .command("gridEdit", { ...params, ...scope })
      .catch((err) => console.error("gridEdit failed:", err));
    // P5-04 shadow: mirror every sent op into the prediction chain; the
    // drift detector compares against the authoritative push at settle.
    // COMPOSE ONLY — the store is keyed by track index, so three DJ decks
    // writing into it would manufacture drift and destroy the FLIP evidence.
    if (source.shadow && typeof i === "number") {
      shadowLocalOp(i, params as Parameters<typeof shadowLocalOp>[1]);
    }
  };

  // MB-3: the compose grid HOSTS the command registry — it owns undo and the
  // document, which is most of what the surviving menu commands touch. It
  // publishes only the sections it can honestly evaluate (no DJ: this page
  // does not know djMode; that section joins with its own host). The bridge
  // reads through refs so menuCommand selections and republish cues always
  // see the current render's wires.
  const menuStateRef = useRef<() => import("../commands/registry.ts").CommandState>(() => {
    throw new Error("menu state read before first render");
  });
  menuStateRef.current = () => ({
    // COMBINED history — the native Edit menu's rule (`webUndo.canUndo ||
    // canUndoEdit`): Swift's stack (topology/bpm/scenes) keeps ⌘Z alive after
    // the TS stack drains; performUndo falls through via `swiftUndo`.
    canUndo: undoDepth() > 0 || (meta?.swiftCanUndo ?? false),
    canRedo: redoDepth() > 0 || (meta?.swiftCanRedo ?? false),
    undoLabel: undoLabel(),
    isPlaying: meta?.isPlaying ?? false,
    djMode: false, // not this host's section — never published from here
    isBouncing: false,
    isOutputRecording: false,
    sessionNew: () => {},
    sessionSave: () => {},
    sessionSaveAs: () => {},
    sessionLoad: () => {},
    sessionExportZip: () => {},
    sessionBounceToggle: () => {},
    performUndo,
    // menuTransport, NOT transportGlobal*: the menu is deck-targeted (the
    // single-space rule) — the global all-decks controls are the toolbar's.
    //
    // ⚠️ IT NOW CARRIES ITS SCOPE, and that is what makes the rule real here.
    // These went out with no `deck` at all, so even a host that answered them
    // could not tell WHICH deck the space bar meant; in the merged host nothing
    // answered `menuTransport` whatsoever, so Space did nothing in compose and
    // nothing in a deck tile. The companion answers it now (browserLink), and
    // the scope is how it knows which document to start (B1).
    transportPlay: () =>
      void link?.command("menuTransport", { op: "play", ...scope }).catch(() => {}),
    transportStop: () =>
      void link?.command("menuTransport", { op: "stop", ...scope }).catch(() => {}),
    transportRestart: () =>
      void link?.command("menuTransport", { op: "restart", ...scope }).catch(() => {}),
    addTrack: () => void link?.command("addTrack", { ...scope }).catch(() => {}),
    requestClearAll: () => {
      const n = tracksRef.current.filter(Boolean).length;
      if (n === 0) return;
      // The confirm lives in the page (the registry owns intent, never UI).
      if (!window.confirm(`Clear all ${n} tracks? This clears every cell.`)) return;
      for (let i = 0; i < tracksRef.current.length; i++) {
        if (tracksRef.current[i]) sendEdit({ op: "clearGrid", trackIndex: i });
      }
    },
    toggleDjMode: () => void link?.command("toggleDjMode", {}).catch(() => {}),
  });
  const menuBridgeRef = useRef<import("../commands/menuBridge.ts").MenuBridge | null>(null);
  useEffect(() => {
    if (!link || source.density !== "compose") return;
    const bridge = attachMenuBridge(link, {
      // Transport moved to ITS state owner (TransportPanel — per-deck
      // isPlaying + djMode; this page's meta.isPlaying is one deck's view).
      state: () => menuStateRef.current(),
      sections: ["Edit", "Track", "Pattern"],
    });
    menuBridgeRef.current = bridge;
    return () => {
      menuBridgeRef.current = null;
      bridge.detach();
    };
  }, [link, source.density]);
  // Label-relevant state the tree reads: republish when it moves. (TS undo
  // depth rides reportUndo below — the choke point every TS undo change hits;
  // the Swift flags arrive here via the gridMeta re-push from ITS choke point.)
  useEffect(() => {
    menuBridgeRef.current?.publish();
  }, [meta?.isPlaying, meta?.swiftCanUndo, meta?.swiftCanRedo]);

  const optimistic = (
    trackIndex: number,
    reduce: (t: GridTrackState) => GridTrackState,
  ) => {
    // ⚠️ OWNER MODE: DO NOTHING. This is not an optimization — it is a correctness fix.
    //
    // Every caller pairs `optimistic(reduce)` with the matching `sendEdit(op)`. While SWIFT owns
    // the pattern that is right: the optimistic copy is a PREVIEW (instant feel), and Swift
    // applies the op once, authoritatively, then echoes it back.
    //
    // Once TS owns it, `sendEdit` applies the reducer ITSELF — so doing it here too runs the op
    // TWICE. For an absolute setter that is invisible (setting gain to 1.5 twice is 1.5). For a
    // RELATIVE one it is fatal: toggleStep toggles the cell on, then straight back off, and cell
    // painting silently stops working — which is exactly what happened on the first hardware run
    // of the flip.
    //
    // In owner mode the reducer inside send*() IS the local update (publishOwned writes tracksRef
    // and bumps), so there is nothing left for this to do.
    if (ownerRef.current) return;

    const t = tracksRef.current[trackIndex];
    if (!t) return;
    tracksRef.current[trackIndex] = reduce(t);
    bump((n) => n + 1);
  };

  const hitTest = (x: number, y: number) => {
    for (const lay of layoutRef.current) {
      for (const [step, r] of lay.rects) {
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
          return { lay, step, rect: r };
        }
      }
    }
    return null;
  };

  // (dragPointerStep removed — TR-FT-3 replaced the y-banded hit-test with
  // the X-only column mapping `clampColStep`, so resize never stalls on
  // vertical drift; native derives internalIndex from x the same way.)

  /** Row-locked step under (x,y) within ONE track row's layout — the PERF
   *  analogue of clampColStep, split-display aware. See `rowStepFromXY`. */
  const rowStepFromX = (lay: TrackLayout, x: number, y: number): number =>
    rowStepFromXY(lay.rects, x, y);

  const beginUndoOnce = (d: DragState) => {
    if (d.undoBegun) return;
    d.undoBegun = true;
    sendEdit({ op: "beginUndo", trackIndex: d.trackIndex });
  };

  /** OWN vs REG is a SAMPLE-lane concept (slice/window playback semantics). A
   *  note-only track (SMP off) always gets REG interaction in the grid: press
   *  stamps, a horizontal drag EXTENDS the cell — and that extension IS the
   *  note's length (the engine reads cellLengths × GATE% for real note-offs,
   *  UT-1). Without this, a note track left in OWN mode paint-toggled on drag
   *  and could never draw a long note. */
  const ownerInteraction = (t: GridTrackState) =>
    t.playbackMode === "owner" && t.trackType === "audio";

  /** Native isCellPaintable (:2436–2451): active steps always; covered
   *  extension steps only outside owner mode. */
  const isPaintable = (t: GridTrackState, step: number) => {
    if (step < 0 || step >= t.stepCount) return false;
    const r = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, step);
    return r !== null && !r.viaWrap && (r.owner === step || !ownerInteraction(t));
  };

  const setSelectionRange = (trackIndex: number, a: number, b: number) => {
    const sel = selRef.current;
    sel.trackIndex = trackIndex;
    sel.anchor = a;
    sel.steps = new Set(
      Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => Math.min(a, b) + i),
    );
    bump((n) => n + 1);
  };

  const clearSelection = () => {
    if (selRef.current.steps.size === 0 && selRef.current.anchor === null) return;
    selRef.current = { trackIndex: -1, steps: new Set(), anchor: null };
    bump((n) => n + 1);
  };

  /** P2.2 + P2.3: the steps a value-adjust of the ACTIVE param should write.
   *  Candidates = the selection when it's on this track (Elektron "select N,
   *  nudge all"), else the single anchor/focus step; then the per-param
   *  policy (`resolveValueTargets`) remaps owner-cell params to their owner
   *  and dedupes, keeping pitch step-anchored — so a covered/OOB step never
   *  feeds the Swift adjustStepParameter OOB write. */
  const valueTargets = (t: GridTrackState, trackIndex: number, anchor: number): number[] => {
    const sel = selRef.current;
    const candidates =
      sel.steps.size && sel.trackIndex === trackIndex ? [...sel.steps] : [anchor];
    return resolveValueTargets(t, candidates, t.activeCellParameterName);
  };

  /** Send one adjustParameter per policy-resolved target (one undo bracket). */
  const sendAdjust = (t: GridTrackState, trackIndex: number, anchor: number, delta: number, fine: boolean) => {
    for (const s of valueTargets(t, trackIndex, anchor)) {
      sendEdit({ op: "adjustParameter", trackIndex, step: s, delta, fine });
    }
  };

  /** Creates the body DragState + runs the press-time mutations (the existing
   *  pointer machine). Extracted so the affordance re-dispatch (§3.2) can
   *  replay a press from the ORIGINAL coordinates after a mark zone was
   *  grazed by a horizontal drag.
   *
   *  TR-FT-3 rework (sourced from ContentView :2562–2666, minimumDistance 0):
   *  NO deadzone and NO axis-lock — the resize/draw machine arms the moment
   *  the pointer's COLUMN changes (X-only step mapping, like native), and the
   *  web-only vertical value-drag arms only while the pointer stays in the
   *  pressed column. Press feedback: empty cells stamp at press in BOTH
   *  modes; active cells stay press-inert (native REG removes on release;
   *  the value-drag needs the cell to survive the press). */
  const pressBody = (
    hitStep: number,
    hitRect: Rect,
    trackIndex: number,
    t: GridTrackState,
    startX: number,
    startY: number,
    opts: {
      alt: boolean;
      shift: boolean;
      meta: boolean;
      keptSelection: boolean;
      tuning: GestureTuning;
    },
  ) => {
    const resolved = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, hitStep);
    // X-only column math (native internalIndex-from-x): origin of column 0
    // of the pressed ROW, so resize survives any vertical drift and split
    // rows stay row-locked like native splitGridRow.
    const cellW = hitRect.w + 2; // rects are inset 1px each side
    const split = meta !== null && meta.displayMode === "split";
    const zoom = meta?.horizontalZoom ?? 16;
    const sliceStart = split && t.stepCount > zoom ? Math.floor(hitStep / zoom) * zoom : 0;
    const d: DragState = {
      trackIndex,
      anchorStep: hitStep,
      owner: hitStep,
      isWrapResize: false,
      resizingExisting: false,
      // RAW step flag (native regDragStartWasActive = track.steps[start]):
      // the release-removal rule keys off it, NOT off cell coverage.
      startWasActive: t.steps[hitStep] ?? false,
      moved: false,
      undoBegun: false,
      alt: opts.alt,
      shift: opts.shift,
      lastStep: hitStep,
      paint: null,
      startXPx: startX,
      startYPx: startY,
      valueDrag: null,
      // value-drag is meaningful only where a cell covers the pressed step
      canValueDrag: resolved !== null,
      colOriginX: hitRect.x - 1 - (hitStep - sliceStart) * cellW,
      cellW,
      sliceStart,
      keptSelection: opts.keptSelection,
      tuning: opts.tuning,
    };
    dragRef.current = d;
    // ⌘-drag paint ramp (native :2432–2517): the anchor keeps its value.
    if (opts.meta) {
      if (isPaintable(t, hitStep)) {
        beginUndoOnce(d);
        d.paint = { anchor: hitStep, cellsPainted: 1, ascending: opts.alt };
      }
      return;
    }
    if (d.alt) return; // ⌥ gestures mutate on release only (accent/flam)
    if (ownerInteraction(t)) {
      // OWN: an EMPTY cell stamps at press (native toggles at press —
      // "have to click" feedback fix); an active cell stays press-inert so
      // a vertical value-drag can grab it (stationary release removes).
      if (!d.startWasActive) {
        beginUndoOnce(d);
        optimistic(trackIndex, (tt) => applyToggleStep(tt, hitStep));
        sendEdit({ op: "toggleStep", trackIndex, step: hitStep });
        d.pressStamped = true;
      }
      return;
    }
    // REG: a covered NON-OWNER step grabs the covering cell for a tail
    // resize (native regExtendedCellOwner excludes the owner — pressing the
    // owner is the fresh-anchor path, so a stationary release can REMOVE the
    // whole extended cell; the old span>1 arming made removal impossible).
    const grab = regGrabTarget(t, hitStep);
    if (grab) {
      d.owner = grab.owner;
      d.isWrapResize = grab.isWrap;
      d.resizingExisting = true;
      return;
    }
    if (!d.startWasActive) {
      beginUndoOnce(d); // REG empty anchor stamps immediately (press feedback)
      optimistic(trackIndex, (tt) => applyToggleStep(tt, hitStep));
      sendEdit({ op: "toggleStep", trackIndex, step: hitStep });
    }
  };

  /** Stage 1 zone hit-test (incell-affordance-ux.md §3.2): the mark whose
   *  zone the press lands in, on the OWNER step of an active cell. Returns
   *  null (→ body machine) on empty/wrap cells or the center body. */
  const affordanceHitFor = (
    t: GridTrackState,
    hit: { lay: TrackLayout; step: number },
    x: number,
    y: number,
    coarse = false,
  ): { mark: Mark; owner: number } | null => {
    const oc = ownerContext(t, hit.step);
    if (!oc) return null;
    const ownerRect = hit.lay.rects.get(oc.owner);
    if (!ownerRect) return null;
    // Onset fraction of the cell (total lead-in) — so a DETACHED pre-silence
    // handle (preSilence > 0) is hittable at its real position.
    let onsetFrac = 0;
    if (t.sampleKey) {
      const span = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, oc.owner)?.span ?? 1;
      const lead = cellLeadIn(t, meta?.bpm ?? 120, oc.owner, span);
      onsetFrac = preMsToOnsetFrac(lead.preSilenceAbsMs, lead.floorMs, lead.cellDurationMs);
    }
    const mark = affordanceHit(ownerRect, x, y, {
      hasLeftJunction: oc.hasLeftJunction,
      onsetFrac,
      hasSample: !!t.sampleKey,
      coarse,
    });
    return mark ? { mark, owner: oc.owner } : null;
  };

  /** Canvas-local CSS-px coords. NOT nativeEvent.offsetX — offset coords on
   *  touch-derived PointerEvents are unreliable in WebKit. Same semantics for
   *  a mouse (the canvas has no border/padding). */
  const localXY = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  /** Tear down every in-flight pointer gesture. The pointercancel body —
   *  also runs when a second finger arms the two-finger pan, and when the
   *  long-press recognizer fires (its synthetic pointercancel lands here). */
  const cancelGesture = () => {
    performRef.current = null;
    perfLayRef.current = null;
    markRef.current = null;
    touchPendingRef.current = null;
    dragSelectRef.current = null;
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.undoBegun) sendEdit({ op: "endUndo", trackIndex: d.trackIndex });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const { x, y } = localXY(e);
    // TOUCH: a second finger means "scroll", never "compose" — the canvas is
    // touch-action: none, so panning is ours to implement (onPointerMove).
    // The first finger's in-flight gesture cancels; nothing was committed if
    // it was still pending.
    if (e.pointerType === "touch") {
      touchPointsRef.current.set(e.pointerId, e.clientY);
      if (touchPointsRef.current.size === 2) {
        e.currentTarget.setPointerCapture(e.pointerId);
        cancelGesture();
        let sum = 0;
        touchPointsRef.current.forEach((py) => (sum += py));
        panAvgYRef.current = sum / touchPointsRef.current.size;
        return;
      }
      if (touchPointsRef.current.size > 2) return;
    }
    const hit = hitTest(x, y);
    if (!hit) return;
    const trackIndex = hit.lay.trackIndex;
    const t = tracksRef.current[trackIndex];
    if (!t) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // PERF (DJ perform mode): the pointer sets the locator window, never
    // composes. Focus still moves — clicking a deck is the gesture that hands
    // it the keyboard/activeSequencer (NK-5) — but selection, affordance
    // zones and pressBody below are all unreachable.
    if (performActive) {
      setCellFocus({ trackIndex, step: hit.step });
      performRef.current = {
        trackIndex,
        anchor: hit.step,
        last: hit.step,
        downX: x,
        downY: y,
        moved: false,
      };
      perfLayRef.current = hit.lay;
      bump((n) => n + 1);
      return;
    }
    // ⇧-click/⇧-drag = range selection (native :2402–30); never mutates.
    if (e.shiftKey && !e.altKey && !e.metaKey) {
      const sel = selRef.current;
      const anchor =
        sel.trackIndex === trackIndex && sel.anchor !== null
          ? sel.anchor
          : (focusRef.current?.trackIndex === trackIndex ? focusRef.current.step : hit.step);
      setSelectionRange(trackIndex, anchor, hit.step);
      setCellFocus({ trackIndex, step: hit.step });
      dragRef.current = null;
      dragSelectRef.current = { trackIndex };
      return;
    }
    // P2.2: a press INSIDE the current selection keeps it (so a vertical
    // value-drag can fan over the whole selection); a press outside clears it.
    const sel = selRef.current;
    const keptSelection =
      sel.steps.size > 0 && sel.trackIndex === trackIndex && sel.steps.has(hit.step);
    if (!keptSelection) clearSelection();
    setCellFocus({ trackIndex, step: hit.step });
    // Redraw NOW so the ring lands on the clicked cell immediately (NAV-11):
    // setCellFocus moves the focusRef the canvas ring reads, but on a
    // grid→grid click the focus store's lane/focused don't change, so no
    // subscription re-renders — the click was the only nav path that waited
    // on the meta round-trip to move the ring.
    bump((n) => n + 1);

    // TOUCH defers classification entirely (touchPendingRef doc): pressBody
    // stamps empty cells AT PRESS, so classifying now would let a long-press
    // or an abandoned finger mutate the pattern. Movement past the deadzone
    // or a stationary release classifies from the ORIGINAL coords — the same
    // replay pattern the mark machine already uses.
    const tuning = gestureTuning(e.pointerType);
    if (e.pointerType === "touch") {
      touchPendingRef.current = { hit, trackIndex, x, y, keptSelection, tuning };
      return;
    }
    beginPress(
      hit,
      trackIndex,
      t,
      x,
      y,
      { alt: e.altKey, shift: e.shiftKey, meta: e.metaKey },
      keptSelection,
      tuning,
      false,
    );
  };

  /** Classify a body press: affordance zone → markRef, else pressBody. The
   *  press-time half of the gesture — mouse/pen run it at pointerdown; touch
   *  runs it deferred (see onPointerDown). */
  const beginPress = (
    hit: { lay: TrackLayout; step: number; rect: Rect },
    trackIndex: number,
    t: GridTrackState,
    x: number,
    y: number,
    mods: { alt: boolean; shift: boolean; meta: boolean },
    keptSelection: boolean,
    tuning: GestureTuning,
    coarse: boolean,
  ) => {
    // Stage 0/1: affordance zone stage (unmodified input only — ⇧/⌘/⌥ bypass
    // it, keeping selection/paint/⌥-fallback muscle memory). REVERSE is a
    // deadzone-re-dispatch mark: arm it, then a stationary release toggles
    // while any horizontal drag past the deadzone replays a body press.
    if (!mods.alt && !mods.meta && !mods.shift) {
      const z = affordanceHitFor(t, hit, x, y, coarse);
      // reverse/accent = deadzone re-dispatch; flam/glide/pre-silence =
      // commit-at-press.
      if (
        z &&
        (z.mark === "reverse" ||
          z.mark === "accent" ||
          z.mark === "flam" ||
          z.mark === "glide" ||
          z.mark === "preSilence")
      ) {
        const ownerRect = hit.lay.rects.get(z.owner) ?? hit.rect;
        const span = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, z.owner)?.span ?? 1;
        const lead =
          z.mark === "preSilence"
            ? cellLeadIn(t, meta?.bpm ?? 120, z.owner, span)
            : { cellDurationMs: 0, floorMs: 0, preSilenceAbsMs: 0 };
        markRef.current = {
          kind: z.mark,
          trackIndex,
          owner: z.owner,
          hitStep: hit.step,
          hitRect: hit.rect,
          startX: x,
          startY: y,
          keptSelection,
          startLevel:
            z.mark === "accent"
              ? (t.accentLevels[z.owner] ?? 0)
              : z.mark === "flam"
                ? (t.flamCounts[z.owner] ?? 1)
                : 0,
          scrubbing: false,
          undoBegun: false,
          committed: z.mark === "flam" || z.mark === "glide" || z.mark === "preSilence",
          ownerStepW: ownerRect.w,
          ownerRect,
          cancelled: false,
          regionW: ownerRect.w * span,
          cellDurationMs: lead.cellDurationMs,
          floorMs: lead.floorMs,
          tuning,
        };
        return;
      }
    }
    pressBody(hit.step, hit.rect, trackIndex, t, x, y, {
      alt: mods.alt,
      shift: mods.shift,
      meta: mods.meta,
      keptSelection,
      tuning,
    });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = localXY(e);
    // Two-finger pan: scroll the grid's own container (client-space Ys — the
    // scroll moves the canvas under the fingers, so local coords would feed
    // back into the pan).
    if (e.pointerType === "touch" && touchPointsRef.current.size >= 2) {
      if (touchPointsRef.current.has(e.pointerId)) {
        touchPointsRef.current.set(e.pointerId, e.clientY);
      }
      if (touchPointsRef.current.size === 2) {
        let sum = 0;
        touchPointsRef.current.forEach((py) => (sum += py));
        const avg = sum / touchPointsRef.current.size;
        const prev = panAvgYRef.current;
        panAvgYRef.current = avg;
        if (prev !== null && panelRef.current) panelRef.current.scrollTop += prev - avg;
      }
      return;
    }
    // Pending TOUCH press: inside the deadzone it stays a tap/long-press
    // candidate; past it, classify from the ORIGINAL coords and fall through
    // so this very move is processed by whatever machine just armed.
    const tp = touchPendingRef.current;
    if (tp) {
      if (Math.max(Math.abs(x - tp.x), Math.abs(y - tp.y)) < tp.tuning.deadzonePx) return;
      touchPendingRef.current = null;
      const tt = tracksRef.current[tp.trackIndex];
      if (!tt) return;
      beginPress(
        tp.hit,
        tp.trackIndex,
        tt,
        tp.x,
        tp.y,
        { alt: false, shift: false, meta: false },
        tp.keptSelection,
        tp.tuning,
        true,
      );
    }
    // PERF drag: extend the locator preview along the anchor track (row-locked,
    // like ⇧-drag). `moved` arms on a step change OR on pixel travel past the
    // deadzone, so a drag inside one cell still sets a 1-step window.
    const perf = performRef.current;
    if (perf) {
      const lay = perfLayRef.current;
      const step = lay ? rowStepFromX(lay, x, y) : -1;
      const armed = !perf.moved && performDragArmed(perf, x, y);
      if (armed) perf.moved = true;
      if (step >= 0 && step !== perf.last) {
        perf.last = step;
        if (step !== perf.anchor) perf.moved = true;
        bump((n) => n + 1);
      } else if (armed) {
        bump((n) => n + 1);
      }
      return;
    }
    if (performActive) {
      // Hover in perform mode: no affordance cursors, just the set-window tool.
      e.currentTarget.style.cursor = "crosshair";
      return;
    }
    // Pending affordance mark: within the 6-px deadzone it waits (stationary
    // release = toggle). REVERSE re-dispatches on ANY motion past it — a
    // REG tail-resize often grabs near the owner's right edge under the tab,
    // so horizontal drags must reach the body machine (§3.2). Replay a body
    // press from the ORIGINAL coords, then fall through to process this move.
    const m = markRef.current;
    if (m) {
      const sdx = x - m.startX; // signed (flam fan is rightward+)
      const dx = Math.abs(sdx);
      const dy = Math.abs(y - m.startY);
      if (!m.scrubbing && Math.max(dx, dy) < m.tuning.deadzonePx) return; // deadzone: waiting
      // Commit-at-press marks (flam/glide) own the pointer fully.
      if (m.committed) {
        m.scrubbing = true;
        // Glide is a toggle with nothing to drag — a drag > 1 cell width
        // cancels it (aborted-draw guard, §2.3). No continuous op.
        if (m.kind === "glide") {
          if (dx > m.ownerStepW || dy > m.ownerRect.h) m.cancelled = true;
          return;
        }
        // Pre-silence: drag the VISIBLE onset; store the pre-silence the
        // engine needs (floored by non-editable swing/rhythmic lead-in).
        if (m.kind === "preSilence") {
          const localX = x - m.ownerRect.x;
          const ms = leadInPxToPreMs(localX, m.regionW, m.cellDurationMs, m.floorMs);
          const mt = tracksRef.current[m.trackIndex];
          const curAbs = mt ? mt.preSilenceMs + (mt.preSilenceMsOffsets[m.owner] ?? 0) : 0;
          if (mt && Math.round(curAbs) !== ms) {
            if (!m.undoBegun) {
              m.undoBegun = true;
              sendEdit({ op: "beginUndo", trackIndex: m.trackIndex });
            }
            optimistic(m.trackIndex, (tt) => applySetPreSilence(tt, m.owner, ms));
            sendEdit({ op: "setPreSilenceCell", trackIndex: m.trackIndex, step: m.owner, ms });
          }
          return;
        }
        if (m.kind === "flam") {
          const count = fanCount(sdx, m.ownerStepW, m.startLevel);
          const mt = tracksRef.current[m.trackIndex];
          if (mt && (mt.flamCounts[m.owner] ?? 1) !== count) {
            if (!m.undoBegun) {
              m.undoBegun = true;
              sendEdit({ op: "beginUndo", trackIndex: m.trackIndex });
            }
            optimistic(m.trackIndex, (tt) => applySetFlam(tt, m.owner, count));
            sendEdit({ op: "setFlam", trackIndex: m.trackIndex, step: m.owner, count });
          }
        }
        return;
      }
      // ACCENT: a clearly-vertical drag scrubs the absolute level (up =
      // louder, no wrap); a horizontal drag re-dispatches (a paint/draw
      // that grazed the top band is not stolen).
      if (m.kind === "accent" && (m.scrubbing || dy > dx * 1.2)) {
        m.scrubbing = true;
        const level = accentScrubLevel(m.startY - y, m.startLevel, m.tuning.accentPxPerLevel);
        const mt = tracksRef.current[m.trackIndex];
        if (mt && (mt.accentLevels[m.owner] ?? 0) !== level) {
          if (!m.undoBegun) {
            m.undoBegun = true;
            sendEdit({ op: "beginUndo", trackIndex: m.trackIndex });
          }
          optimistic(m.trackIndex, (tt) => applySetAccent(tt, m.owner, level));
          sendEdit({ op: "setAccent", trackIndex: m.trackIndex, step: m.owner, level });
        }
        return;
      }
      // reverse (any motion) or accent horizontal → re-dispatch to the body.
      markRef.current = null;
      const mt = tracksRef.current[m.trackIndex];
      if (!mt) return;
      pressBody(m.hitStep, m.hitRect, m.trackIndex, mt, m.startX, m.startY, {
        alt: false,
        shift: false,
        meta: false,
        keptSelection: m.keptSelection,
        tuning: m.tuning,
      });
      // fall through — dragRef is now armed; process the current move below
    }
    // Live ⇧-drag range extension.
    const ds = dragSelectRef.current;
    if (ds) {
      const hit = hitTest(x, y);
      if (hit && hit.lay.trackIndex === ds.trackIndex && selRef.current.anchor !== null) {
        setSelectionRange(ds.trackIndex, selRef.current.anchor, hit.step);
        setCellFocus({ trackIndex: ds.trackIndex, step: hit.step });
      }
      return;
    }
    const d = dragRef.current;
    if (!d) {
      // Hover cursor: mark zones advertise themselves; else active cells
      // advertise the vertical value-drag.
      const hit = hitTest(x, y);
      // GR-VIS hover response: redraw only when the hovered CELL changes.
      const prev = hoverRef.current;
      if (prev?.trackIndex !== hit?.lay.trackIndex || prev?.step !== hit?.step) {
        hoverRef.current = hit ? { trackIndex: hit.lay.trackIndex, step: hit.step } : null;
        bump((n) => n + 1);
      }
      let cursor = "default";
      if (hit) {
        const t = tracksRef.current[hit.lay.trackIndex];
        const z = t ? affordanceHitFor(t, hit, x, y) : null;
        if (z?.mark === "reverse" || z?.mark === "glide") {
          cursor = "pointer";
        } else if (z?.mark === "accent") {
          cursor = "ns-resize";
        } else if (z?.mark === "flam") {
          cursor = "ew-resize";
        } else if (z?.mark === "preSilence") {
          cursor = "col-resize";
        } else {
          // Cells advertise toggle/draw (pointer) — the always-ns-resize
          // was misleading (TR-FT-3); the resize/value cursors appear once
          // the corresponding gesture actually arms.
          cursor = "pointer";
        }
      }
      e.currentTarget.style.cursor = cursor;
      return;
    }
    if (d.alt) return;
    const t = tracksRef.current[d.trackIndex];
    if (!t) return;
    // Vertical value-drag (web idiom on top of the native machine): 6 px per
    // step, ⌥ held live = fine (DragBox parity).
    if (d.valueDrag) {
      const notch = Math.round((d.valueDrag.startY - y) / d.tuning.valueDragPxPerStep);
      const delta = notch - d.valueDrag.notches;
      if (delta !== 0) {
        d.valueDrag.notches = notch;
        beginUndoOnce(d);
        // Fans over the selection (P2.2) with per-param owner remap (P2.3).
        sendAdjust(t, d.trackIndex, d.anchorStep, delta, e.altKey);
      }
      return;
    }
    // TR-FT-3 arbitration — native has NO deadzone (minimumDistance 0): the
    // horizontal machine arms the moment the pointer's COLUMN changes
    // (X-only mapping, so vertical drift never stalls a resize). The
    // web-only value-drag arms only while the pointer stays in the pressed
    // column AND travels ≥8px vertically over a covered step — vertical
    // motion inside one column can't be a resize, so there is no ambiguity
    // and no ratio/deadzone games.
    const step = clampColStep(d, x);
    if (!d.moved && step === d.anchorStep) {
      if (d.canValueDrag && Math.abs(y - d.startYPx) >= d.tuning.valueDragArmPx) {
        d.valueDrag = { startY: y, notches: 0 };
        d.moved = true;
        e.currentTarget.style.cursor = "ns-resize";
      }
      return; // still within the pressed column
    }
    if (step === d.lastStep) return;
    d.lastStep = step;
    // ⌘ paint: each newly crossed paintable cell gets the next ramp value.
    if (d.paint) {
      if (step >= 0 && step < t.stepCount && isPaintable(t, step)) {
        d.moved = true;
        sendEdit({
          op: "paintCell",
          trackIndex: d.trackIndex,
          step,
          anchorStep: d.paint.anchor,
          cellIndex: d.paint.cellsPainted,
          ascending: d.paint.ascending,
        });
        d.paint.cellsPainted += 1;
      }
      return;
    }
    if (ownerInteraction(t)) {
      // OWN horizontal paint-toggle (native :2622–2638): each newly crossed
      // cell flips. The anchor flipped at press when it was empty
      // (pressStamped); a press-inert ACTIVE anchor flips as the run arms.
      if (step < 0 || step >= t.stepCount) return;
      if (!d.moved) {
        d.moved = true;
        beginUndoOnce(d);
        if (!d.pressStamped) {
          optimistic(d.trackIndex, (tt) => applyToggleStep(tt, d.anchorStep));
          sendEdit({ op: "toggleStep", trackIndex: d.trackIndex, step: d.anchorStep });
        }
      }
      optimistic(d.trackIndex, (tt) => applyToggleStep(tt, step));
      sendEdit({ op: "toggleStep", trackIndex: d.trackIndex, step });
      return;
    }
    // REG live extend/resize from the owner (native :2598–2621), incl.
    // wrap: pointer past the pattern end (or remapped low indices while
    // resizing a wrapped tail) overflows into wrapLength. The owner column
    // is a valid endpoint — it shrinks the cell to length 1 (a press that
    // never left the owner column is caught above, so no false arm).
    d.moved = true;
    beginUndoOnce(d);
    e.currentTarget.style.cursor = "ew-resize";
    const endRef = dragEndRef(d.owner, step, t.stepCount, d.isWrapResize);
    const { length, wrapLength } = computeDragEnd(d.owner, endRef, t.stepCount);
    const owner = d.owner;
    if (!t.steps[owner]) {
      optimistic(d.trackIndex, (tt) => applyToggleStep(tt, owner));
      sendEdit({ op: "toggleStep", trackIndex: d.trackIndex, step: owner });
    }
    optimistic(d.trackIndex, (tt) => applySetCellLength(tt, owner, length, wrapLength));
    sendEdit({ op: "setCellLength", trackIndex: d.trackIndex, step: owner, length, wrapLength });
  };

  /** X-only pointer→step for an armed body drag (native internalIndex-from-x,
   *  row-locked): floor((x − colOriginX) / cellW), clamped ≥ 0 (native's
   *  negative-index abs() blowup is deliberately not ported) and open-ended
   *  to the right (past the pattern end = wrap territory). */
  const clampColStep = (d: DragState, x: number): number => {
    const col = Math.floor((x - d.colOriginX) / d.cellW);
    return Math.max(0, d.sliceStart + col);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "touch") {
      touchPointsRef.current.delete(e.pointerId);
      if (panAvgYRef.current !== null) {
        // A pan finger lifted: the pan ends when fewer than two remain. The
        // composing gesture was already cancelled at pan arm — nothing below
        // may run for this release.
        if (touchPointsRef.current.size < 2) panAvgYRef.current = null;
        return;
      }
      // Stationary tap: classify NOW from the original press coords, then
      // fall through — the stationary-release logic below commits it (tap =
      // toggle on finger-up, the standard touch idiom).
      const tp = touchPendingRef.current;
      if (tp) {
        touchPendingRef.current = null;
        const tt = tracksRef.current[tp.trackIndex];
        if (tt) {
          beginPress(
            tp.hit,
            tp.trackIndex,
            tt,
            tp.x,
            tp.y,
            { alt: false, shift: false, meta: false },
            tp.keptSelection,
            tp.tuning,
            true,
          );
        }
      }
    }
    // PERF release: a drag sets (and engages) the window, a plain click
    // disengages. sendTrackEditRaw = no undo bracket (locator mutators are
    // undo-free live-perf ops throughout) + owner-mode echo adoption.
    const perf = performRef.current;
    if (perf) {
      performRef.current = null;
      perfLayRef.current = null;
      const pt = tracksRef.current[perf.trackIndex];
      if (pt) {
        const act = resolvePerformRelease(perf, pt.stepCount, pt.locatorRepeatActive);
        if (act.kind === "setRange") {
          sendTrackEditRaw({
            op: "setLocatorRange",
            trackIndex: perf.trackIndex,
            startStep: act.startStep,
            value: act.lengthSteps,
            engage: true,
          });
        } else if (act.kind === "disengage") {
          sendTrackEditRaw({ op: "setLocatorRepeat", trackIndex: perf.trackIndex, value: 0 });
        }
      }
      bump((n) => n + 1);
      return;
    }
    dragSelectRef.current = null;
    // A pending mark that never crossed the deadzone = a stationary click:
    // commit the mark's click action (reverse = toggle), one undo bracket.
    const m = markRef.current;
    markRef.current = null;
    if (m) {
      const mt = tracksRef.current[m.trackIndex];
      if (m.scrubbing) {
        // Accent scrub already committed per notch; close its bracket.
        if (m.undoBegun) sendEdit({ op: "endUndo", trackIndex: m.trackIndex });
      } else if (mt && m.kind === "reverse") {
        const on = !(mt.reverseSteps[m.owner] ?? false);
        sendEdit({ op: "beginUndo", trackIndex: m.trackIndex });
        optimistic(m.trackIndex, (tt) => applySetReverse(tt, m.owner, on));
        sendEdit({ op: "setReverse", trackIndex: m.trackIndex, step: m.owner, on });
        sendEdit({ op: "endUndo", trackIndex: m.trackIndex });
      } else if (mt && m.kind === "accent") {
        // Stationary release = cycle off→soft→hard→off (native ⌥-click parity).
        optimistic(m.trackIndex, (tt) => applyCycleAccent(tt, m.owner));
        sendEdit({ op: "cycleAccent", trackIndex: m.trackIndex, step: m.owner });
      } else if (mt && m.kind === "flam") {
        // Stationary grip click cycles ×1→×2→×3→×4→×1 (user CONFIRM: fast
        // small counts, distinct from the ⌥⇧ 1…16 cycle).
        const cur = mt.flamCounts[m.owner] ?? 1;
        const next = cur >= 4 ? 1 : cur + 1;
        sendEdit({ op: "beginUndo", trackIndex: m.trackIndex });
        optimistic(m.trackIndex, (tt) => applySetFlam(tt, m.owner, next));
        sendEdit({ op: "setFlam", trackIndex: m.trackIndex, step: m.owner, count: next });
        sendEdit({ op: "endUndo", trackIndex: m.trackIndex });
      } else if (mt && m.kind === "glide" && !m.cancelled) {
        // Toggle glide-INTO the owner cell (legacy materialization in the
        // reducer + Swift mutator). The ramp length lives on the track
        // glide% slider, per the locked per-cell model.
        const on = !(mt.glideSteps[m.owner] ?? false);
        sendEdit({ op: "beginUndo", trackIndex: m.trackIndex });
        optimistic(m.trackIndex, (tt) => applySetGlide(tt, m.owner, on));
        sendEdit({ op: "setGlide", trackIndex: m.trackIndex, step: m.owner, on });
        sendEdit({ op: "endUndo", trackIndex: m.trackIndex });
      }
      return;
    }
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const trackIndex = d.trackIndex;
    const t = tracksRef.current[trackIndex];
    const finish = () => {
      if (d.undoBegun) sendEdit({ op: "endUndo", trackIndex });
    };
    if (!t || d.paint) {
      finish(); // paint gesture already committed live
      return;
    }
    // ⌥ clicks (owner-anchored native idiom): ⌥⇧ = flam cycle, ⌥ = accent.
    if (d.alt && !d.moved) {
      if (d.shift) {
        const res = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, d.anchorStep);
        if (res) {
          optimistic(trackIndex, (tt) => applyCycleFlam(tt, res.owner));
          sendEdit({ op: "cycleFlam", trackIndex, step: res.owner });
        }
      } else {
        // Owner-anchored (native idiom): resolve explicitly — d.owner is the
        // resize-grab target since TR-FT-3, not a general owner cache.
        const res = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, d.anchorStep);
        const step = res ? res.owner : d.anchorStep;
        optimistic(trackIndex, (tt) => applyCycleAccent(tt, step));
        sendEdit({ op: "cycleAccent", trackIndex, step });
      }
      finish();
      return;
    }
    // Stationary release (no drag). Empty anchors already stamped at press
    // (both modes — pressStamped). An ACTIVE anchor is removed on release
    // (native REG :2650; the press stays inert so a value-drag can grab it).
    // A grabbed extension (resizingExisting) never auto-removes — but the
    // OWNER of an extended cell is a fresh anchor, so clicking it removes
    // the whole cell (native regExtendedCellOwner excludes the owner).
    if (!d.moved) {
      // P2.2: a click that landed inside a kept selection (no value-drag
      // happened) collapses to the normal single-cell gesture — clear the
      // selection first, then toggle (native clear+toggle).
      if (d.keptSelection) clearSelection();
      if (d.startWasActive && !d.resizingExisting && !d.pressStamped) {
        beginUndoOnce(d);
        optimistic(trackIndex, (tt) => applyToggleStep(tt, d.anchorStep));
        sendEdit({ op: "toggleStep", trackIndex, step: d.anchorStep });
      }
    }
    finish();
  };

  // Keyboard lane: ⌘C/⌘V + arrow focus navigation (⇧ extends selection).
  useEffect(() => {
    if (!link) return;
    // KB-01: the grid CLAIMS the keyboard by default and releases only where it
    // explicitly declines (the "forward" result below) — the root relay in App
    // forwards whatever comes back unclaimed. Claim-by-default reproduces the
    // old behaviour exactly: the keys that used to reach the local
    // forwardKeyToNative call are precisely the ones that return "forward"
    // here; every other path (handled, or deliberately swallowed) stayed
    // native-silent before and stays native-silent now.
    // ⇧↑/⇧↓: extend the multi-track selection track-wise — jump one track
    // (clamped, no wrap: wrapping an extension from track 0 to the LAST track
    // would select the wrong end) and ADD the landed track to Swift's
    // selectedTrackIds. Add-only, so walking back does not deselect (deselect
    // stays ⌘-click on the name); the anchor is auto-seeded Swift-side from
    // the keyboard track when the set is empty (BeatSequencer
    // .addTrackToSelection). The cursor move is SILENT: addTrackToSelection
    // already moves Swift's keyboard index, so a selectTrack on top would be
    // a redundant second command racing the first.
    const extendTrackSelection = (origin: number, dir: 1 | -1) => {
      const lays = layoutRef.current;
      const keptStep = focusRef.current?.step ?? useFocusModel.getState().cell?.step ?? 0;
      const target = nextTrackJump(lays, origin, keptStep, dir, false);
      if (!target) return; // at the edge — claimed no-op
      link
        ?.command("gridEdit", { op: "addTrackToSelection", trackIndex: target.trackIndex, ...scope })
        .catch(() => {});
      setCellFocus(target, { silent: true });
      if (selRef.current.trackIndex !== target.trackIndex) clearSelection();
      bump((n) => n + 1);
    };
    const handleKey = (e: KeyboardEvent): "forward" | void => {
      const focus = focusRef.current;
      const key = e.key;
      // NK-5: this grid does not hold the keyboard — yield EVERYTHING.
      //
      // The DJ view mounts two GridPanels in ONE page, and each listens on
      // `window`. Without this gate both of them handle every press: arrows moved
      // both decks' cursors at once, and once NK-3 made the cursor publish a
      // selection, the two decks raced to claim `activeSequencer` on every arrow —
      // the keyboard ended up wherever the last listener happened to run.
      //
      // Returning "forward" (rather than swallowing) is what keeps the shortcut
      // library alive: the root relay still sends the key to native, which routes
      // it to the deck that DOES hold the keyboard. Exactly one grid acts, and no
      // key is lost. Always true in compose, where there is only one grid.
      if (!keyboardActiveRef.current) return "forward";
      // KB-03: in a DECK grid the bare nudge keys (T/Y · G/H) are the DJ's, not
      // the pattern's — yield them so the hold gesture reaches native, where it
      // is implemented. `g` was the loud one: it is this grid's accent cycle, so
      // deck 2's nudge-down edited a cell instead of bending the deck.
      if (source.deck !== undefined && isDjNudgeKey(e)) return "forward";
      if ((e.metaKey || e.ctrlKey) && key.toLowerCase() === "c") {
        const sel = selRef.current;
        const trackIndex = sel.steps.size ? sel.trackIndex : focus?.trackIndex;
        const steps = sel.steps.size ? [...sel.steps] : focus ? [focus.step] : [];
        if (trackIndex !== undefined && trackIndex >= 0 && steps.length) {
          link.command("gridEdit", { op: "copyCells", trackIndex, steps }).catch(() => {});
          e.preventDefault();
        }
        return;
      }
      if ((e.metaKey || e.ctrlKey) && key.toLowerCase() === "v") {
        if (focus) {
          link
            .command("gridEdit", { op: "pasteCells", trackIndex: focus.trackIndex, step: focus.step })
            .catch(() => {});
          e.preventDefault();
        }
        return;
      }
      // NK-3: while Musical Keyboard Mode is on, the LETTERS ARE PIANO KEYS —
      // yield every bare printable key to native.
      //
      // This is not defensive coding, it is the difference between the feature
      // working and looking like it works. The piano layout wants a·f·g·j·k·l and
      // (on a QWERTZ) ö·ä; the grid claims every one of them — accent, flam,
      // glide, reverse, the param cycle, the value nudge. Claim-by-default would
      // swallow six notes out of the middle of the scale, and the only symptom
      // would be a keyboard that plays some notes and not others.
      //
      // Yielding ALL bare printables (not just the 18 mapped ones) mirrors native
      // exactly: in this mode HotkeyManager absorbs keyCodes 0…50 wholesale
      // (:236), so an unmapped letter is meant to do nothing — not to fall
      // through to a grid edit the user never asked for. Arrows and Tab are not
      // length-1, so the cursor still moves.
      if (isNoteKeyboardActive() && !e.metaKey && !e.ctrlKey && !e.altKey && key.length === 1) {
        return "forward";
      }
      // Tab = NEXT TRACK (wraps last→first), keeping the column. The old lane
      // toggle (grid↔controls) is gone — the band is reached by ↓ traversal or
      // pointer. From the controls lane Tab jumps from the BAND's track and
      // lands in the grid lane (setCellFocus drops the control ring).
      if (key === "Tab") {
        // ⇧Tab is native's compose/DJ view toggle (HotkeyManager :357). The
        // old branch matched Tab regardless of shift and silently swallowed
        // it — forwarding RESTORES the view switch; Tab's wrap is the way
        // back up. (forwardKeyToNative preventDefaults, so the browser's
        // focus traversal never runs.)
        if (e.shiftKey) return "forward";
        const lays = layoutRef.current;
        const st = useFocusModel.getState();
        const bandTrack = st.lane === "controls" ? bandTrackOfFocus(st.focused?.id) : null;
        const origin =
          bandTrack !== null
            ? bandTrack
            : focus?.trackIndex ?? st.cell?.trackIndex ?? lays[0]?.trackIndex;
        const keptStep = focus?.step ?? st.cell?.step ?? 0;
        if (lays.length && origin !== undefined) {
          const target = nextTrackJump(lays, origin, keptStep, 1, true);
          if (target) {
            // Non-silent: Tab is plain navigation, so native's selection
            // follows (NK-3) — replacing an outside multi-selection, exactly
            // like clicking the track.
            setCellFocus(target);
            if (selRef.current.trackIndex !== target.trackIndex) clearSelection();
            bump((n) => n + 1);
          }
        }
        e.preventDefault();
        return;
      }
      // Escape backs out INNERMOST-FIRST: the cell-step selection, then the
      // track multi-selection (new clearTrackSelection op — ⌘-click is one
      // track per click, and a select-ALL has no outside track left to
      // replace it via selectTrack, so a full selection was unclearable).
      // With nothing selected it forwards, so native keeps using Escape to
      // close its overlay panels.
      if (key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        if (selRef.current.steps.size) {
          clearSelection();
          bump((n) => n + 1);
          e.preventDefault();
          return;
        }
        if (selectedTracksRef.current.length) {
          link
            ?.command("gridEdit", {
              op: "clearTrackSelection",
              trackIndex: focus?.trackIndex ?? 0,
              ...scope,
            })
            .catch(() => {});
          e.preventDefault();
          return;
        }
        return "forward";
      }
      // ö/ä = VALUE −/+ on the selection (else focused cell) — the native
      // grid-lane grammar (HotkeyManager :1611–24), ⌥ = fine. Grid.md §8.4
      // delta 2. The lane arbitrates: a controls-lane DragBox owns ö/ä
      // (focusModel's listener), the grid owns it otherwise (P2.1).
      if ((key === "ö" || key === "ä") && !e.metaKey && !e.ctrlKey) {
        // Yield on remote ownership too: a DragBox in ANOTHER webview holds
        // the ring. The claim this return produces is only a forwarding marker
        // (ö/ä is web-owned anyway) — focusModel's module listener still runs
        // and relays the adjust to the owner.
        const fs = useFocusModel.getState();
        if (fs.lane === "controls" || fs.remoteControls) return;
        if (!focus) return;
        const t = tracksRef.current[focus.trackIndex];
        if (!t) return;
        // Same target resolution as the value-drag: selection-else-focus,
        // per-param owner remap (P2.2/P2.3).
        sendAdjust(t, focus.trackIndex, focus.step, key === "ä" ? 1 : -1, e.altKey);
        e.preventDefault();
        return;
      }
      // P5-PCE selection core (P1.2): switch the armed dial param WITHOUT
      // touching cell focus. k/l = cycle prev/next (TR-FT-9: the p/t/n/v/s/e
      // direct-jump set COLLIDED with native shortcuts — p record-arm,
      // e/t finger drums, v reverse transport — those now forward again;
      // K·L sit left of Ö·Ä on the German layout: one cluster of
      // param-cycle + value-dial). [ ] and Ö/Ä stay as cycle aliases.
      // Grid lane only (yields to a controls-lane DragBox); grid.md §8.2.
      if (!e.metaKey && !e.ctrlKey && !e.altKey && useFocusModel.getState().lane === "grid") {
        const armParam = (mode: string) => {
          if (!focus) return;
          const t = tracksRef.current[focus.trackIndex];
          if (!t) return;
          tracksRef.current[focus.trackIndex] = { ...t, activeCellParameterName: mode };
          bump((n) => n + 1);
          link
            .command("trackEdit", { op: "setActiveCellParameter", trackIndex: focus.trackIndex, mode })
            .catch(() => {});
          e.preventDefault();
        };
        if (key === "k" || key === "l" || key === "[" || key === "]" || key === "Ö" || key === "Ä") {
          if (!focus) return;
          const track = tracksRef.current[focus.trackIndex];
          const cur = track?.activeCellParameterName ?? "pitch";
          // The cycle walks the track's OWN dial set, so k/l on a MIDI row steps
          // NOTE→VEL→LEN→CHD rather than through sample dials it has no use for.
          const params = track ? dialParamsFor(track) : undefined;
          armParam(cycleDialParam(cur, key === "l" || key === "]" || key === "Ä" ? 1 : -1, params));
          return;
        }
        // In-cell mark keys (§3.3): `j` = reverse toggle (moved off `r` —
        // native finger-drum track 4; j completes the J·K·L·Ö·Ä cluster),
        // `a` = accent cycle, on the focused cell's owner (selection when
        // present). f/⇧F/g land with their marks. Shared owner collection +
        // one undo bracket.
        if ((key === "j" || key === "a" || key === "g") && focus) {
          const t = tracksRef.current[focus.trackIndex];
          if (!t) return;
          const sel = selRef.current;
          const cand =
            sel.steps.size && sel.trackIndex === focus.trackIndex ? [...sel.steps] : [focus.step];
          const owners = new Set<number>();
          for (const s of cand) {
            const oc = ownerContext(t, s);
            if (oc) owners.add(oc.owner);
          }
          if (owners.size === 0) return;
          const ti = focus.trackIndex;
          link.command("gridEdit", { op: "beginUndo", trackIndex: ti }).catch(() => {});
          for (const owner of owners) {
            if (key === "j") {
              const on = !(tracksRef.current[ti]?.reverseSteps[owner] ?? false);
              optimistic(ti, (tt) => applySetReverse(tt, owner, on));
              link.command("gridEdit", { op: "setReverse", trackIndex: ti, step: owner, on }).catch(() => {});
            } else if (key === "g") {
              const on = !(tracksRef.current[ti]?.glideSteps[owner] ?? false);
              optimistic(ti, (tt) => applySetGlide(tt, owner, on));
              link.command("gridEdit", { op: "setGlide", trackIndex: ti, step: owner, on }).catch(() => {});
            } else {
              optimistic(ti, (tt) => applyCycleAccent(tt, owner));
              link.command("gridEdit", { op: "cycleAccent", trackIndex: ti, step: owner }).catch(() => {});
            }
          }
          link.command("gridEdit", { op: "endUndo", trackIndex: ti }).catch(() => {});
          e.preventDefault();
          return;
        }
        // `f` = flam +1, `⇧F` = −1 (clamped 1…16, no wrap — adjustStepFlam
        // idiom). Owner-anchored, selection-aware.
        if ((key === "f" || key === "F") && focus) {
          const t = tracksRef.current[focus.trackIndex];
          if (!t) return;
          const sel = selRef.current;
          const cand =
            sel.steps.size && sel.trackIndex === focus.trackIndex ? [...sel.steps] : [focus.step];
          const owners = new Set<number>();
          for (const s of cand) {
            const oc = ownerContext(t, s);
            if (oc) owners.add(oc.owner);
          }
          if (owners.size === 0) return;
          const ti = focus.trackIndex;
          const dir = key === "F" ? -1 : 1;
          link.command("gridEdit", { op: "beginUndo", trackIndex: ti }).catch(() => {});
          for (const owner of owners) {
            const cur = tracksRef.current[ti]?.flamCounts[owner] ?? 1;
            const next = Math.max(1, Math.min(16, cur + dir));
            optimistic(ti, (tt) => applySetFlam(tt, owner, next));
            link.command("gridEdit", { op: "setFlam", trackIndex: ti, step: owner, count: next }).catch(() => {});
          }
          link.command("gridEdit", { op: "endUndo", trackIndex: ti }).catch(() => {});
          e.preventDefault();
          return;
        }
        // "." = draw/erase the note at the focused cell (or fan over the
        // selection) — native HotkeyManager :1113. Grid-domain, owned web-side.
        if (key === "." && focus) {
          const t = tracksRef.current[focus.trackIndex];
          if (!t) return;
          const sel = selRef.current;
          const steps =
            sel.steps.size && sel.trackIndex === focus.trackIndex ? [...sel.steps] : [focus.step];
          const ti = focus.trackIndex;
          link.command("gridEdit", { op: "beginUndo", trackIndex: ti }).catch(() => {});
          for (const s of steps) {
            if (s < 0 || s >= t.stepCount) continue;
            optimistic(ti, (tt) => applyToggleStep(tt, s));
            link.command("gridEdit", { op: "toggleStep", trackIndex: ti, step: s }).catch(() => {});
          }
          link.command("gridEdit", { op: "endUndo", trackIndex: ti }).catch(() => {});
          e.preventDefault();
          return;
        }
        // TR-FT-13: "," = the extension tool. Sets the owning REG cell's END
        // to the focused step (extend or shrink); focus before the owner
        // extends the wrap-around portion. Replaces native option+←/→ on the
        // web surface (arrows are pure navigation here). Focused-step-only —
        // deliberately ignores the selection. Claimed even as a no-op so it
        // never forwards to native.
        if (key === "," && focus) {
          const t = tracksRef.current[focus.trackIndex];
          const tgt = t ? commaEndTarget(t, focus.step) : null;
          if (tgt) {
            const ti = focus.trackIndex;
            link.command("gridEdit", { op: "beginUndo", trackIndex: ti }).catch(() => {});
            optimistic(ti, (tt) => applySetCellLength(tt, tgt.owner, tgt.length, tgt.wrapLength));
            link
              .command("gridEdit", {
                op: "setCellLength",
                trackIndex: ti,
                step: tgt.owner,
                length: tgt.length,
                wrapLength: tgt.wrapLength,
              })
              .catch(() => {});
            link.command("gridEdit", { op: "endUndo", trackIndex: ti }).catch(() => {});
          }
          e.preventDefault();
          return;
        }
      }
      // ⌥. / ⌥⇧. = paint the selection ramp (native :1172; ⇧ ascending). The
      // ramp VALUE math is Swift-side (paintCell), so the web just sends the
      // sequence position for each selected cell after the anchor.
      if (key === "." && e.altKey && !e.metaKey && focus) {
        if (useFocusModel.getState().lane !== "grid") return;
        const sel = selRef.current;
        if (sel.steps.size < 2 || sel.trackIndex !== focus.trackIndex) return;
        const ti = focus.trackIndex;
        const sorted = [...sel.steps].sort((a, b) => a - b);
        const anchor = sorted[0]!;
        link.command("gridEdit", { op: "beginUndo", trackIndex: ti }).catch(() => {});
        for (let k = 1; k < sorted.length; k++) {
          link
            .command("gridEdit", {
              op: "paintCell",
              trackIndex: ti,
              step: sorted[k]!,
              anchorStep: anchor,
              cellIndex: k,
              ascending: e.shiftKey,
            })
            .catch(() => {});
        }
        link.command("gridEdit", { op: "endUndo", trackIndex: ti }).catch(() => {});
        e.preventDefault();
        return;
      }
      // TR-FT-12: Enter/'.' on a focused band toggle/button belongs to the
      // focusModel press listener — never forward it to native.
      if ((key === "Enter" || key === ".") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const st = useFocusModel.getState();
        if (st.lane === "controls" && st.focused?.press) return;
      }
      if (!key.startsWith("Arrow") || e.metaKey || e.ctrlKey) {
        // TR-FT-5 / KB-01: anything the grid didn't handle above and isn't a
        // bare arrow → release it, so the root relay forwards it to the native
        // HotkeyManager and the full shortcut library (transport/record/undo/
        // mute-all/zoom…) stays live under the web grid.
        //
        // Ctrl+arrow is released for the same reason ⌘-arrow is: it is native's,
        // not ours. It steers BEAT REPEAT (length zoom ↑/↓, region shift ←/→) —
        // and the cursor code below would otherwise move the grid cursor AND
        // claim the key, so the repeat never heard it. The grid has no Ctrl+arrow
        // gesture of its own to give up.
        return "forward";
      }
      // TR-FT-12 lane merge: in the controls lane the arrows traverse the
      // focused track's band (←/→, DOM order) and cross into the neighbour
      // cell rows (↑ = own cells, ↓ = next track's cells). Non-band controls
      // (other panels' boxes) stay inert under arrows, exactly as before.
      const focusState = useFocusModel.getState();
      if (focusState.lane === "controls") {
        const bandTrack = bandTrackOfFocus(focusState.focused?.id);
        // Not one of THIS panel's band controls (a foreign-deck or non-band
        // control owns the store): claim the arrow so the browser never scrolls
        // the page, but do nothing (NAV-11 — a bare return here let a
        // `.grid-panel` scroll, which read as "the other deck scrolls").
        if (bandTrack === null) {
          e.preventDefault();
          return;
        }
        if (key === "ArrowLeft" || key === "ArrowRight") {
          const ctrls = bandControls(bandTrack, panelRef.current);
          const idx = ctrls.findIndex((c) => c.id === focusState.focused!.id);
          const next = ctrls[stepIndex(idx, key === "ArrowRight" ? 1 : -1, ctrls.length)];
          if (next && next.id !== focusState.focused!.id) acquireControlFocus(next.id);
          e.preventDefault();
          return;
        }
        // ⇧↑/⇧↓ from the band: track-level gesture — extend the selection
        // from the BAND's track and land in the grid lane on the new row.
        if (e.shiftKey) {
          extendTrackSelection(bandTrack, key === "ArrowDown" ? 1 : -1);
          e.preventDefault();
          return;
        }
        // ↑/↓ HOP the band's visual rows first (TR-FT-12 follow-up,
        // user-approved: a ~40-stop band walks vertically too) — nearest-x
        // landing in the next row; only past the band's edge rows do they
        // exit to the neighbouring cell rows.
        const rows = groupRows(bandControls(bandTrack, panelRef.current));
        const rowIdx = rows.findIndex((r) => r.some((c) => c.id === focusState.focused!.id));
        const hopped = rowIdx >= 0 ? rows[rowIdx + (key === "ArrowUp" ? -1 : 1)] : undefined;
        if (hopped) {
          const fromX = rows[rowIdx]!.find((c) => c.id === focusState.focused!.id)!.centerX;
          acquireControlFocus(hopped[nearestIndexByX(hopped.map((c) => c.centerX), fromX)]!.id);
          e.preventDefault();
          return;
        }
        const bandLays = layoutRef.current;
        const li = bandLays.findIndex((l) => l.trackIndex === bandTrack);
        // Claim even when the band's track isn't in this layout — never scroll.
        if (li < 0) {
          e.preventDefault();
          return;
        }
        const target = key === "ArrowUp" ? bandLays[li] : bandLays[li + 1];
        if (target) {
          // The parked cell focus survived the band transit — same step back.
          const parked = focusState.cell;
          const step = Math.max(0, Math.min(target.stepCount - 1, parked?.step ?? 0));
          setCellFocus({ trackIndex: target.trackIndex, step });
          // Same-track selection stays parked through a band round-trip;
          // landing on ANOTHER track drops it (old ↑/↓ semantics).
          if (selRef.current.trackIndex !== target.trackIndex) clearSelection();
          bump((n) => n + 1);
        }
        e.preventDefault(); // ↓ from the last band clamps
        return;
      }
      const lays = layoutRef.current;
      // No layout yet — claim the arrow so the page never scrolls (NAV-11).
      if (!lays.length) {
        e.preventDefault();
        return;
      }
      const cur = focus ?? { trackIndex: lays[0]!.trackIndex, step: 0 };
      // Arrows are NAVIGATION ONLY (grid.md §8.1 lock): ←/→ steps, ↑/↓
      // rows. ⇧↑/⇧↓ = extend the track selection (the long-reserved gesture).
      if (e.shiftKey && (key === "ArrowUp" || key === "ArrowDown")) {
        extendTrackSelection(cur.trackIndex, key === "ArrowDown" ? 1 : -1);
        e.preventDefault();
        return;
      }
      const laneIdx = lays.findIndex((l) => l.trackIndex === cur.trackIndex);
      if (key === "ArrowUp" || key === "ArrowDown") {
        // TR-FT-12: ↑/↓ from the cells lands in a control band — ↓ = this
        // track's band (it sits directly below the cells), ↑ = the previous
        // track's band. Nearest-x landing keeps the hand where the eye is;
        // the cell focus stays parked for the way back out.
        const bandLay =
          key === "ArrowDown" ? lays[laneIdx] : laneIdx > 0 ? lays[laneIdx - 1] : undefined;
        if (bandLay) {
          // Entry lands on the SPATIALLY ADJACENT visual row of the band:
          // ↓ = the band's top row, ↑ = the previous band's bottom row
          // (row hopping then walks the rest — TR-FT-12 follow-up).
          const rows = groupRows(bandControls(bandLay.trackIndex, panelRef.current));
          const entryRow = key === "ArrowDown" ? rows[0] : rows[rows.length - 1];
          if (entryRow?.length) {
            const canvasRect = staticRef.current?.getBoundingClientRect();
            const rect = lays[laneIdx]?.cellRect(cur.step) ?? null;
            const x = canvasRect && rect ? canvasRect.left + rect.x + rect.w / 2 : null;
            const landing =
              x === null
                ? entryRow[0]!
                : entryRow[nearestIndexByX(entryRow.map((c) => c.centerX), x)]!;
            if (acquireControlFocus(landing.id)) {
              // Reaching another track's band IS reaching that track: ↑ enters
              // the PREVIOUS track's band (it sits below its cells), so waiting
              // for its cell row would leave native's selection one keypress
              // behind the ring. ↓ enters the SAME track's band — no-op there.
              if (bandLay.trackIndex !== cur.trackIndex) {
                link
                  ?.command("gridEdit", {
                    op: "selectTrack",
                    trackIndex: bandLay.trackIndex,
                    ...scope,
                  })
                  .catch(() => {});
              }
              bump((n) => n + 1);
              e.preventDefault();
              return;
            }
          }
          // Band without focusables: legacy track jump so focus never strands.
          const trackIndex =
            key === "ArrowUp" ? lays[laneIdx - 1]!.trackIndex : lays[laneIdx + 1]?.trackIndex;
          if (trackIndex !== undefined) {
            const sc = lays.find((l) => l.trackIndex === trackIndex)?.stepCount ?? 16;
            setCellFocus({ trackIndex, step: Math.max(0, Math.min(sc - 1, cur.step)) });
            clearSelection();
            bump((n) => n + 1);
          }
        }
        e.preventDefault(); // ↑ from the first track clamps
        return;
      }
      const { trackIndex } = cur;
      const stepCount = lays.find((l) => l.trackIndex === trackIndex)?.stepCount ?? 16;
      const raw = cur.step + (key === "ArrowRight" ? 1 : -1);
      // DJ view: stepping off this deck's step edge crosses into the deck in the
      // neighbouring slot (one ring, L→R across both). Not while ⇧-extending a
      // selection (there is no cross-deck cell selection), and only where a
      // neighbour exists — the far outer edges clamp exactly as before.
      if (
        !e.shiftKey &&
        (raw < 0 || raw >= stepCount) &&
        djDeckRef.current !== undefined &&
        djSlotRef.current !== undefined
      ) {
        const crossed = crossDjFocus(
          djDeckRef.current,
          key === "ArrowRight" ? "right" : "left",
          trackIndex,
        );
        if (crossed !== null) {
          e.preventDefault();
          return;
        }
      }
      const step = Math.max(0, Math.min(stepCount - 1, raw));
      setCellFocus({ trackIndex, step });
      if (e.shiftKey) {
        const anchor =
          selRef.current.trackIndex === trackIndex && selRef.current.anchor !== null
            ? selRef.current.anchor
            : cur.step;
        setSelectionRange(trackIndex, anchor, step);
      } else {
        clearSelection();
      }
      bump((n) => n + 1);
      e.preventDefault();
    };
    const onKey = (e: KeyboardEvent) => {
      if (handleKey(e) !== "forward") claimKey(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  if (!meta) {
    return <main className="grid-panel mono dim" ref={panelRef}>waiting for pattern state…</main>;
  }

  // Content height = cells + fat bands; scrolls when it exceeds the viewport.
  const liveTracks = tracksRef.current
    .map((t, i) => ({ t, i }))
    .filter((x): x is { t: GridTrackState; i: number } => x.t !== null)
    .slice(0, meta.trackCount);
  // Grid cells BALLOON to fill the viewport (user: the grid should fill all
  // space). gridRowLayout divides `stackH` across cell rows after reserving
  // each track's control band, so when few tracks are present the CELLS grow
  // to use the slack — the bands stay a fixed height. contentH (min-content
  // at CELL_ROW_H) is the scroll floor for many/tall tracks.
  const contentH = contentHeight(
    liveTracks.map(({ t }) => ({ stepCount: t.stepCount })),
    meta.horizontalZoom,
    meta.displayMode === "split",
    liveTracks.map((_x, k) => bandH(k)),
    metrics,
    cellsHidden,
  );
  // With the cells hidden the bands are the whole content: they must NOT
  // stretch to fill the viewport (a 2-track deck would spread its two rows
  // over the whole slot), so the stack is exactly as tall as it needs to be.
  const stackH = cellsHidden ? contentH : Math.max(viewportH, contentH);

  // Selected-track overlay geometry + membership. The tinted set is the UNION
  // of Swift's multi-selection and the navigator's track — visual only, the
  // cursor track is never written into selectedTrackIds. That union mirrors
  // `effectiveSelectedTrackIds` (empty set → keyboard track), so what is
  // tinted is exactly what a selection-scoped fan-out would hit. Navigator
  // tint only on the keyboard-owning grid (NK-5): the focus store carries no
  // deck, so without the gate deck A's cursor would tint the same row index
  // on B and C.
  const rowBlocks =
    liveTracks.length > 0 && stackH > 0
      ? gridRowLayout(
          liveTracks.map(({ t, i }) => ({ trackIndex: i, stepCount: t.stepCount })),
          meta.horizontalZoom,
          meta.displayMode === "split",
          stackH,
          metrics.gap,
          liveTracks.map((_x, k) => bandH(k)),
          cellsHidden,
        ).blocks
      : [];
  // NAV-11: the tint is Swift's EFFECTIVE selection and NOTHING else — one
  // source of truth. `meta.selectedTrackIndices` already includes the cursor
  // track (Swift substitutes the keyboard track when the explicit set is
  // empty), so the old navigator-union arm (a non-reactive focusRef read that
  // could strand the previous track) is gone. The web-owned navigator visual
  // is the accent ring on the canvas, not this tint.
  const tintedTracks = new Set<number>(meta.selectedTrackIndices);

  // The instrument picker is a WINDOW, not an in-page popover — a popover cannot
  // escape its host WKWebView (MIX-R8), which is why the FX slots have one too.
  // The row just asks the host to open it; the window owns the scan and the list.
  const openInstrumentWindow = (trackIndex: number) => {
    link?.command("openInstrumentWindow", { trackIndex, ...scope }).catch(() => {});
  };

  // TR-2/3 edits: optimistic local echo (grid feel) + trackEdit command.
  const sendTrackEditRaw = (params: Record<string, unknown>) => {
    const opName = params.op as string;
    const ti = params.trackIndex;
    if (handleBracket(opName, ti)) return;

    // A selection-scoped edit is SWIFT'S — it moves tracks this panel's
    // per-track reducer chain does not model, so it must not take the owner
    // fast-path below (that would apply it to the touched track only and then
    // publish a pattern contradicting the fan-out Swift is about to push).
    // Falls through to the unmodeled send, which already adopts Swift's echo.
    // `selectedTracksRef` is Swift's effective selection, mirrored from the meta
    // push — the same list the row tint paints.
    const fanOut = fansOutToSelection(opName, ti, selectedTracksRef.current);
    // Strip the marker when it does not apply, so Swift never sees an intent on
    // an edit that is not selection-scoped.
    if (!fanOut) delete params.selectionIntent;

    // OWNER MODE: the 45 modeled trackEdit ops are applied by TS and published.
    //
    // begin/endUndo are NOT modeled and must still be SENT — undo stays Swift's (it holds the
    // authoritative mirror, and keeping one ordered stack is the only way ⌘Z still walks edits in
    // the order they were made, across pattern/topology/global). Everything else unmodeled — the
    // impure ops, the selection-scoped ones — is also still sent: Swift does the work, pushes the
    // result, and TS adopts it once the track goes quiet.
    if (!fanOut && ownerRef.current && typeof ti === "number" && VERIFIABLE_TRACK_OPS.has(opName)) {
      const cur = tracksRef.current[ti];
      if (cur) {
        publishOwned(ti, applyTrackOp(cur, params as unknown as TrackOp));
        // Settings-scene-owned ops (chokeGroup) are NOT carried in the pattern payload Swift
        // adopts, so the desktop only learns them via a dedicated trackEdit. The publish above
        // covers the browser companion / optimistic UI; also send the command and adopt Swift's
        // authoritative echo. Other verifiable ops return here as before.
        if (SETTINGS_OWNED_TRACK_OPS.has(opName) && link) {
          adoptNextEcho.current[ti] = true;
          link
            .command("trackEdit", { ...params, ...scope })
            .catch((err) => console.error("trackEdit failed:", err));
        }
        return;
      }
    }

    // An UNMODELED op is done by SWIFT (a sample load, a selection-scoped fan-out, a rename), so
    // its result is Swift's to tell us — adopt the next push instead of suppressing it as an echo.
    if (ownerRef.current && typeof ti === "number" && opName !== "beginUndo" && opName !== "endUndo") {
      adoptNextEcho.current[ti] = true;
    }
    if (!link) return;
    link
      .command("trackEdit", { ...params, ...scope })
      .catch((err) => console.error("trackEdit failed:", err));
    // P5-06 step C: trackEdits used to poison the shadow chain WHOLESALE — TS had no reducer
    // for any of them, so the flip's evidence gate said nothing about anything a track-row
    // control did. 45 of them are modeled now (trackOps.ts, golden-verified against the real
    // Swift mutators), so they FEED the chain like a grid op instead of poisoning it.
    //
    // The rest still poison it, and that is correct: they are the impure ones (loadSample opens
    // a panel, loadInstrument hosts an AU), the selection-scoped ones (they touch tracks this
    // per-track chain does not model), and the ones whose fields are not on the pattern wire at
    // all. An unmodeled op MUST poison — silently adopting its result would count a verification
    // TS never made.
    //
    // COMPOSE ONLY (GridSource.shadow).
    if (
      source.shadow &&
      typeof params.trackIndex === "number" &&
      params.op !== "beginUndo" &&
      params.op !== "endUndo"
    ) {
      const op = params.op as string;
      // `!fanOut` is the "selection-scoped" clause above, made real (NAV-12):
      // the op IS modeled for one track, but this edit moved SEVERAL, and the
      // reducer only saw the touched one. Feeding the chain here would claim a
      // verification TS never made — so it poisons, exactly like an impure op.
      if (VERIFIABLE_TRACK_OPS.has(op) && !fanOut) {
        shadowTrackOp(params.trackIndex, params as unknown as TrackOp);
      } else {
        shadowUnmodeledEdit(params.trackIndex);
      }
    }
  };
  // One undo entry per gesture — but LAZILY: beginUndoActivity pushes a
  // snapshot unconditionally, so a focus-only click (pointerdown with no edit)
  // must NOT bracket. The bracket opens on the FIRST real edit within a
  // gesture and closes on pointer-up.
  const sendTrackEdit = (params: Record<string, unknown>) => {
    const g = undoBracketRef.current;
    // setActiveCellParameter is focus-only (arms the dial, mutates no
    // pattern data) — it must not push an undo snapshot.
    const nonEdit =
      params.op === "beginUndo" || params.op === "endUndo" || params.op === "setActiveCellParameter";
    if (g && !g.started && !nonEdit) {
      g.started = true;
      sendTrackEditRaw({ op: "beginUndo", trackIndex: g.track });
    }
    sendTrackEditRaw(params);
  };
  const beginBracket = (i: number) => {
    undoBracketRef.current = { track: i, started: false };
    const end = () => {
      const g = undoBracketRef.current;
      if (g?.started) sendTrackEditRaw({ op: "endUndo", trackIndex: g.track });
      undoBracketRef.current = null;
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  // Grid-background menu (beat grouping + on-demand shadow evidence). Built
  // at click time so the counts are current.
  const backgroundMenu = (): MenuItem[] => [
            ...[2, 3, 4, 6, 8].map(
              (n): MenuItem => ({
                kind: "item",
                label: `Beat grouping: ${n}`,
                checked: groupSize === n,
                onSelect: () => {
                  setGroupSize(n);
                  link?.command("setSetting", { key: "grid.groupSize", value: n }).catch(() => {});
                },
              }),
            ),
            // Shadow-store evidence, on demand. It lives here rather than as a
            // permanent badge because the flip's evidence gate has PASSED (9/9,
            // zero drift) — the readout is now diagnostics, and the compose
            // window carries zero non-session chrome. A DRIFT still alarms
            // on its own (ShadowDriftAlarm); this is just where you read the
            // counts or clear them.
            { kind: "sep" },
            {
              kind: "info",
              label: meta.ownerPatterns
                ? "Shadow store — RETIRED (TS owns the pattern; nothing left to predict)"
                : shadowEvidenceLabel(verifiedCount, verifiedByOp),
            },
            ...(driftCount > 0 && lastDrift
              ? [
                  {
                    kind: "item" as const,
                    label: `Inspect drift ×${driftCount}…`,
                    onSelect: () => setDriftDetail(true),
                  },
                ]
              : []),
            {
              kind: "item",
              label: "Reset shadow evidence",
              onSelect: () => {
                resetShadowEvidence();
                setDriftDetail(false);
              },
            },
            // P5-06 step A — the world wire, on demand. Read-only: it asks Swift for the
            // live pattern, round-trips it through the TS model and byte-compares. The
            // fixtures only ever proved the sessions someone thought to capture; this
            // proves the session in front of you. Nothing is written, so it is safe with
            // the ownership flag off — which is the only state that ships today.
            // P5-06 step D — WHO OWNS THE PATTERN. The flip is meant to be invisible, which makes
            // it indistinguishable from a flag that did nothing. This says which world you are in,
            // and the publish count proves TS's write path is actually carrying your edits.
            { kind: "sep" },
            {
              kind: "info",
              label: meta.ownerPatterns
                ? `Pattern owner: TS · THE FLIP is LIVE · ${publishCount} published`
                : "Pattern owner: Swift (flip off)",
            },
            ...(publishError
              ? [{ kind: "info" as const, label: `⚠ publish REFUSED: ${publishError}` }]
              : []),
            { kind: "sep" },
            { kind: "info", label: worldCheckLabel(worldCheck) },
            {
              kind: "item",
              label: "Verify world round-trip…",
              onSelect: () => {
                // Selecting an item CLOSES the menu, so the result cannot live in the menu —
                // it opens the panel below. (It briefly did live in the menu, which meant
                // clicking the check appeared to do nothing at all: it ran, then hid the only
                // place its answer was shown.)
                setWorldCheck("running");
                if (!link) {
                  // Never fail silently: "no link" and "clean" must not look the same.
                  setWorldCheck({ ok: false, bytes: 0, firstDiff: -1, detail: "no engine link" });
                  return;
                }
                verifyWorldRoundTrip(link, source.deck)
                  .then((r) => {
                    setWorldCheck(r);
                    if (!r.ok) {
                      console.warn(
                        `[world-wire] TS re-encode DIVERGED at byte ${r.firstDiff}\n${r.detail}`,
                      );
                    }
                  })
                  .catch((e) =>
                    setWorldCheck({ ok: false, bytes: 0, firstDiff: -1, detail: String(e) }),
                  );
              },
            },
            ];

  // Compose focus ring (2026-07-14): the compose window wears its deck's
  // identity color as a 1px inset ring, matching the ring on that deck's
  // transport box — one fact ("this deck is the compose target") read twice,
  // replacing the deleted DJ deck header's letter badge. Compose only: the DJ
  // slots carry the accent `.active` ring instead (a different fact).
  const focusDeck = source.density === "compose" ? (meta.deckIndex ?? null) : null;

  return (
    <FocusScopeContext.Provider value={focusScope}>
    <main
      className={`grid-panel${focusDeck !== null ? " sem deck-focus" : ""}`}
      style={
        focusDeck !== null
          ? ({ "--sem-color": semanticColor("deck", focusDeck) } as React.CSSProperties)
          : undefined
      }
      ref={panelRef}
      onContextMenu={(e) => {
        // CATCH-ALL. A WKWebView answers any un-prevented right-click with its own native
        // menu ("Reload"), so every square inch of a web panel that lacks a handler leaks
        // browser chrome into the instrument. The canvas, the DSP boxes and the sliders all
        // own their menus; this catches everything else — the control band, the master row,
        // the padding — and gives it the grid menu rather than WebKit's.
        //
        // Guarded on defaultPrevented so the specific handlers keep winning: child controls
        // call preventDefault + stopPropagation, so they never even reach here. This only
        // fires where nothing else claimed the click.
        if (e.defaultPrevented) return;
        e.preventDefault();
        openMenu(backgroundMenu(), e.clientX, e.clientY);
      }}
    >
      {/* MASTER TRACK ROW (P6-08) — BPM · VOL · DRV · sends. The same component
          the DJ deck mounts; the row is the deck's MASTER TRACK, so DRV and the
          master sends render on every surface (DRV reaches DSP on every deck now
          — each deck drives its own signal pre-sum). It sits ABOVE the cells
          because it describes the whole pattern, not one track. */}
      <MasterRow
        link={link}
        meta={meta}
        deck={source.deck}
        showMod={source.density === "compose"}
        showAdd={source.density === "compose"}
      />
      <div className="grid-canvas-stack" style={{ height: stackH }}>
        {/* Cells hidden (DJ GRID toggle): the canvases don't mount at all, so
            there is no pointer surface, no rAF playhead loop and no static
            redraw — the control bands are the whole row. */}
        {!cellsHidden && (
        <canvas
          ref={staticRef}
          className="grid-static"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => {
            if (!hoverRef.current) return;
            hoverRef.current = null;
            bump((n) => n + 1);
          }}
          onContextMenu={(e) => {
            // Right-click anywhere on the cell canvas — over a cell or not.
            //
            // This used to bail out (no preventDefault) when the click landed on a CELL,
            // on the theory that cells "keep their gesture surface untouched". But a
            // context menu is not a gesture, and bailing let the event through to the
            // WKWebView, which answered with its OWN menu — the user got "Reload". The
            // grid menu was then reachable only in the hairline gaps between rows, i.e.
            // effectively not at all.
            //
            // If cells ever earn their own menu, branch on hitTest HERE and open that one.
            // What must never happen again is falling through to WebKit's default.
            e.preventDefault();
            openMenu(backgroundMenu(), e.clientX, e.clientY);
          }}
          onPointerCancel={(e) => {
            touchPointsRef.current.delete(e.pointerId);
            if (touchPointsRef.current.size < 2) panAvgYRef.current = null;
            cancelGesture();
          }}
        />
        )}
        {!cellsHidden && <canvas ref={hotRef} className="grid-hot" />}
        <div className="track-sel-overlay" aria-hidden>
          {rowBlocks
            .filter((b) => tintedTracks.has(b.trackIndex))
            .map((b) => {
              // NAV-9 (user): the tint is the TRACK'S OWN color, not accent —
              // a selected row reads as ITSELF, lit, so a multi-selection is
              // a set of identities rather than an anonymous pink block.
              // Same resolution as the canvas cells (universal-color test
              // toggle included); same 18% as the cell-selection tint.
              const rowColor = trackDisplayColor(
                tracksRef.current[b.trackIndex]?.colorHex ?? UNSET_TRACK_HEX,
              );
              return (
                <div
                  key={b.trackIndex}
                  className="tso-row"
                  style={{
                    top: b.top,
                    height: b.height,
                    left: PAD,
                    right: PAD,
                    background: `color-mix(in srgb, ${rowColor} ${Math.round(
                      currentTokens().surface.selectionAlpha * 100,
                    )}%, transparent)`,
                  }}
                />
              );
            })}
        </div>
        <TrackStrips
          meta={meta}
          tracks={tracksRef.current}
          registerLed={registerLed}
          onToggleTrackSelect={(i) => {
            link?.command("gridEdit", { op: "toggleTrackSelection", trackIndex: i, ...scope })
              .catch(() => {});
          }}
          onSelectFocus={(i) => {
            // NAV-8: clicking a track CONTROL selects its track (user ask —
            // a DragBox press must move the selection focus). Manual, not the
            // local setCellFocus: this select must NOT collapse a
            // multi-selection the clicked track belongs to
            // (keepWithinSelection — Finder's drag-within-selection rule; a
            // STEP drag on a selected track fans across the set). The store
            // write parks the cell on the clicked track; the DragBox's own
            // focus lands right after (capture → bubble), keeping the lane.
            const cur = focusRef.current;
            if (cur?.trackIndex === i && keyboardActiveRef.current) return;
            const sc = tracksRef.current[i]?.stepCount ?? 16;
            const cell = { trackIndex: i, step: Math.max(0, Math.min(sc - 1, cur?.step ?? 0)) };
            focusRef.current = cell;
            useFocusModel.getState().setCellFocus(cell);
            link
              ?.command("gridEdit", {
                op: "selectTrack",
                trackIndex: i,
                keepWithinSelection: true,
                ...scope,
              })
              .catch(() => {});
            bump((n) => n + 1);
          }}
          mod={mod}
          height={stackH}
          bandHs={bandHs}
          peaks={peaksRef.current}
          points={styleRef.current.points}
          spectrum={styleRef.current.colorMode === "spectrum"}
          cellsHidden={cellsHidden}
          onMeasureBand={(hs) =>
            setBandHs((prev) =>
              prev.length === hs.length && hs.every((h, k) => Math.abs((prev[k] ?? 0) - h) <= 1)
                ? prev
                : hs,
            )
          }
          openInstrumentWindow={openInstrumentWindow}
          send={sendTrackEdit}
          optimistic={optimistic}
          onRandomize={handleRandomize}
          onClearTrack={handleClearTrack}
          beginBracket={beginBracket}
          metrics={metrics}
          density={source.density}
          deck={source.deck}
          onDropSample={(trackIndex, path, asStretch) => {
            // The browser row was dropped ON a track: same `fileBrowser/load`
            // intent the LOAD button sends, only with a destination. Swift's
            // ONE loader still does the work (BR-3), so a dropped sample and a
            // browsed one land identically.
            link?.command("fileBrowser", { op: "load", path, trackIndex, asStretch }).catch(
              (err) => console.error("fileBrowser load failed:", err),
            );
          }}
        />
      </div>
      {/* Shadow evidence is a COMPOSE-surface instrument (the store only runs
          there — GridSource.shadow); a DJ deck must not show a badge that
          reports on someone else's pattern. */}
      {source.shadow && (
        <ShadowDriftAlarm
          drift={driftCount}
          lastDrift={lastDrift}
          onInspect={() => setDriftDetail(true)}
        />
      )}
      {driftDetail && lastDrift && (
        <div className="grid-drift-detail" role="dialog" aria-label="Shadow drift detail">
          <div className="gdd-head">
            <span>
              SHADOW DRIFT — track {lastDrift.trackIndex} ·{" "}
              {new Date(lastDrift.at).toLocaleTimeString()}
            </span>
            <button onClick={() => setDriftDetail(false)} title="Close">✕</button>
          </div>
          <p className="gdd-note">
            The TS reducer predicted a different pattern than the engine reported. This is a
            reducer gap — it must be fixed and pinned with a golden fixture before THE FLIP.
          </p>
          {/* The FIELD LIST is the diagnosis. The comparison now covers the whole pattern
              (~80 fields, P5-06 step C), so two canonical blobs side by side are unreadable —
              what you need first is which field broke, and doing what. */}
          {lastDrift.fields.length > 0 && (
            <p className="gdd-note">
              <strong>Fields:</strong> {lastDrift.fields.join(", ")}
              {lastDrift.ops.length > 0 && (
                <>
                  {" · "}
                  <strong>after:</strong> {lastDrift.ops.join(", ")}
                </>
              )}
            </p>
          )}
          <div className="gdd-diff">
            <div className="gdd-col">
              <div className="gdd-label">predicted (TS)</div>
              <pre>{lastDrift.predicted}</pre>
            </div>
            <div className="gdd-col">
              <div className="gdd-label">authoritative (Swift)</div>
              <pre>{lastDrift.authoritative}</pre>
            </div>
          </div>
          <button
            className="gdd-copy"
            onClick={() => {
              void navigator.clipboard?.writeText(
                `track ${lastDrift.trackIndex}\npredicted:     ${lastDrift.predicted}\nauthoritative: ${lastDrift.authoritative}`,
              );
            }}
          >
            Copy diff
          </button>
        </div>
      )}
      {worldCheck !== null && (
        <div className="grid-drift-detail" role="dialog" aria-label="World wire round-trip">
          <div className="gdd-head">
            <span>WORLD WIRE — round-trip (P5-06 step A)</span>
            <button onClick={() => setWorldCheck(null)} title="Close">✕</button>
          </div>
          {worldCheck === "running" ? (
            <p className="gdd-note">Asking Swift for the live pattern…</p>
          ) : worldCheck.ok ? (
            <p className="gdd-note">
              ✓ <strong>Byte-identical.</strong> Swift's live pattern ({(worldCheck.bytes / 1024).toFixed(0)} KB)
              decoded through the TS model and re-encoded to the exact same bytes. The model is a faithful
              mirror of the session you are editing right now — not just of the captured fixtures. Nothing
              was written: Swift still owns the document.
            </p>
          ) : (
            <>
              <p className="gdd-note">
                ✗ <strong>Diverged</strong>
                {worldCheck.firstDiff >= 0 ? ` at byte ${worldCheck.firstDiff}` : ""}. The TS model does not
                reproduce this session's bytes — a gap that must be closed before TS is allowed to own the
                document. Copy this and hand it over; it becomes a fix plus a golden fixture.
              </p>
              <div className="gdd-diff">
                <div className="gdd-col">
                  <div className="gdd-label">first divergence</div>
                  <pre>{worldCheck.detail}</pre>
                </div>
              </div>
              <button
                className="gdd-copy"
                onClick={() => {
                  void navigator.clipboard?.writeText(
                    `world-wire divergence at byte ${worldCheck.firstDiff}\n${worldCheck.detail}`,
                  );
                }}
              >
                Copy diff
              </button>
            </>
          )}
        </div>
      )}
    </main>
    </FocusScopeContext.Provider>
  );
}

// --------------------------------------------------------------------------
// TR-2/3 fat track-row control band (panels/trackrow.md §8). A DOM band sitting
// directly BELOW each track's grid cells (same width), in the gridRowLayout-
// reserved control band. Header identity (name/color/mode/M·S/param) + the
// 3-row TrackBand (transport · DSP paired sliders · sends), edited live via
// trackEdit with optimistic echo. Derived from the grid/<i> payload.
// --------------------------------------------------------------------------
function TrackStrips({
  meta,
  tracks,
  onToggleTrackSelect,
  onSelectFocus,
  mod,
  height,
  bandHs,
  peaks,
  points,
  spectrum,
  onMeasureBand,
  openInstrumentWindow,
  send,
  optimistic,
  onRandomize,
  onClearTrack,
  beginBracket,
  metrics,
  density,
  deck,
  cellsHidden,
  onDropSample,
  registerLed,
}: {
  meta: GridMetaState;
  tracks: (GridTrackState | null)[];
  /** C3: ⌘-click a track name → toggle its membership of the multi-selection. */
  onToggleTrackSelect: (trackIndex: number) => void;
  /** NAV-8: pointer-down anywhere in a band → selection focus moves to that
      track (fires on the CAPTURE phase, so a DragBox's own focus lands after
      the cursor has already moved — the control ring wins the lane). */
  onSelectFocus: (trackIndex: number) => void;
  /** MOD-7: modulation domain for the sweep bands + arm-to-map rings. */
  mod: Modulation;
  height: number;
  bandHs: number[];
  openInstrumentWindow: (trackIndex: number) => void;
  peaks: Map<string, Peaks>;
  /** Peak cache key parts the theme currently uses (waveform.points/colorMode). */
  points: number;
  spectrum: boolean;
  onMeasureBand: (hs: number[]) => void;
  send: (params: Record<string, unknown>) => void;
  optimistic: (trackIndex: number, reduce: (t: GridTrackState) => GridTrackState) => void;
  /** TR-RND — regenerate / clear THIS track's pattern (owner write path). */
  onRandomize: (trackIndex: number) => void;
  onClearTrack: (trackIndex: number) => void;
  beginBracket: (trackIndex: number) => void;
  metrics: GridMetrics;
  density: GridSource["density"];
  /** Deck scope — MIDI learn must resolve against THIS deck's sequencer (CM-6). */
  deck?: number;
  cellsHidden: boolean;
  /** BR-4: a row dragged out of the file browser, dropped on this track. */
  onDropSample: (trackIndex: number, path: string, asStretch: boolean) => void;
  /** SIG-3: each band's activity-LED element, registered into the panel's
      one lighting loop (a stable callback — never re-binds the hot effect). */
  registerLed: (trackIndex: number, el: HTMLElement | null) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dropTarget, setDropTarget] = useState<number | null>(null);

  // Measure EACH strip's real content height and report the per-track array
  // (TR-FT-6: a shared max meant a track with no sample/mod-slots inherited
  // the tallest band and rendered dead space below its sends row). Measure
  // `.trk-band` (flex:0 0 auto → natural height, unaffected by the strip's
  // fixed height) so each shrinks AND grows exactly; height = the band's
  // bottom offset within the strip + the strip's bottom padding+border.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const hs: number[] = [];
    el.querySelectorAll<HTMLElement>(".trk-band").forEach((band) => {
      const bottomChrome = 7; // strip padding-bottom (6) + border-bottom (1)
      hs.push(band.offsetTop + band.offsetHeight + bottomChrome);
    });
    if (hs.length) onMeasureBand(hs);
  });

  const live = tracks
    .map((t, i) => ({ t, i }))
    .filter((x): x is { t: GridTrackState; i: number } => x.t !== null)
    .slice(0, meta.trackCount);
  if (live.length === 0 || height <= 0)
    return <div className={`track-strips density-${density}`} ref={containerRef} />;

  // Solo makes the mix collapse to the soloed track(s). The canvas already dims
  // the silenced cells (hasSolo greyMultiplier, :2961); mirror it on the control
  // band so a whole silenced ROW recedes and the soloed one stands out — the
  // "why did everything go quiet?" answer, findable at a glance.
  const hasSolo = live.some(({ t }) => t.soloed);

  const { blocks } = gridRowLayout(
    live.map(({ t, i }) => ({ trackIndex: i, stepCount: t.stepCount })),
    meta.horizontalZoom,
    meta.displayMode === "split",
    height,
    metrics.gap,
    live.map((_x, k) => bandHs[k] ?? metrics.bandH),
    cellsHidden,
  );

  return (
    <div className={`track-strips density-${density}`} ref={containerRef}>
      {live.map(({ t, i }, k) => {
        const b = blocks[k]!;
        return (
          <div
            key={i}
            className={`trk-strip${t.muted ? " muted" : ""}${
              hasSolo && t.soloed ? " solo-on" : ""
            }${hasSolo && !t.soloed && !t.muted ? " soloed-out" : ""}${
              dropTarget === i ? " drop" : ""
            }`}
            data-track-index={i}
            style={{
              top: b.controlTop,
              height: b.controlHeight,
              left: PAD,
              right: PAD,
            }}
            onPointerDownCapture={() => {
              beginBracket(i);
              onSelectFocus(i);
            }}
            // Drop a browser row here to load it INTO this track (the native
            // row `.onDrop`). Only audio tracks take a sample — a MIDI row
            // refuses the drag outright rather than accepting it and failing.
            onDragOver={(e) => {
              if (!hasSampleDrag(e.dataTransfer)) return;
              if (t.trackType !== "audio") return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              if (dropTarget !== i) setDropTarget(i);
            }}
            onDragLeave={() => setDropTarget((prev) => (prev === i ? null : prev))}
            onDrop={(e) => {
              const path = readSampleDrag(e.dataTransfer);
              setDropTarget(null);
              if (!path || t.trackType !== "audio") return;
              e.preventDefault();
              onDropSample(i, path, e.altKey);
            }}
          >
            {/* TR-FT-4: the name-only head row is gone — identity lives in
                the band's header row (name·browse·LOAD·M/S·mode). */}
            {/* The trim bar keeps its own whole-sample renderer (handles, chop
                markers, trim shading — a different instrument from a cell), but
                it reads the SAME cache, so it must use the same
                sample × resolution key. */}
            <TrackBand
              t={t}
              i={i}
              mod={mod}
              deck={deck}
              muteGroupActive={meta.muteGroupActive}
              peaks={
                t.sampleKey ? peaks.get(peaksKey(t.sampleKey, points, spectrum)) : undefined
              }
              openInstrumentWindow={openInstrumentWindow}
              send={send}
              optimistic={(reduce) => optimistic(i, reduce)}
              onRandomize={() => onRandomize(i)}
              onClearTrack={() => onClearTrack(i)}
              variant={density}
              // C3: the ⌘-click multi-selection. Swift owns it (view+command), so the ring is
              // rendered from the pushed meta rather than local state — which also means a
              // selection made in the NATIVE rows or on a DJ deck is finally VISIBLE here
              // instead of silently fanning a STEP change out across tracks you never touched.
              selected={meta.selectedTrackIndices.includes(i)}
              onToggleSelect={() => onToggleTrackSelect(i)}
              registerLed={registerLed}
            />
          </div>
        );
      })}
    </div>
  );
}

/** A pending in-cell affordance gesture (incell-affordance-ux.md §3.2). */
interface MarkDrag {
  kind: Mark;
  trackIndex: number;
  owner: number;
  hitStep: number;
  /** The pressed step's rect (re-dispatch rebuilds the column math from it). */
  hitRect: Rect;
  startX: number;
  startY: number;
  keptSelection: boolean;
  /** Accent scrub start level / flam start count at press. */
  startLevel: number;
  /** A continuous adjust (accent scrub, flam/pre-silence drag) has begun. */
  scrubbing: boolean;
  undoBegun: boolean;
  /** Commit-at-press marks (flam/glide/preSilence) own the pointer — no
   *  re-dispatch. Re-dispatch marks (reverse/accent) leave this false. */
  committed: boolean;
  /** Owner step width in CSS px (flam fan / pre-silence px↔ms math). */
  ownerStepW: number;
  /** Owner cell rect (pre-silence lead-in mapping). */
  ownerRect: Rect;
  /** Glide: a drag > 1 cell width cancels the toggle (aborted-draw guard). */
  cancelled: boolean;
  /** Pre-silence onset drag: the full cell region width + lead-in math. */
  regionW: number;
  cellDurationMs: number;
  floorMs: number;
  /** Thresholds of the pointer that STARTED the gesture (mouse vs touch). */
  tuning: GestureTuning;
}

/** One pointer gesture (native row-drag state machine, ContentView :2553–2650). */
interface DragState {
  trackIndex: number;
  anchorStep: number;
  /** Extend/resize owner: the covering cell's owner, else the anchor. */
  owner: number;
  /** Grabbed a wrapped tail → low pointer indices remap past the end. */
  isWrapResize: boolean;
  /** Grabbed an existing extended cell (stationary release never removes). */
  resizingExisting: boolean;
  startWasActive: boolean;
  moved: boolean;
  undoBegun: boolean;
  alt: boolean;
  shift: boolean;
  lastStep: number | null;
  /** ⌘-drag ramp state (anchor keeps its value; cellIndex = paint order). */
  paint: { anchor: number; cellsPainted: number; ascending: boolean } | null;
  startXPx: number;
  startYPx: number;
  /** Vertical drag = continuous value adjust (per-cell drag-box idiom). */
  valueDrag: { startY: number; notches: number } | null;
  /** A cell covers the pressed step — the value-drag has something to edit. */
  canValueDrag: boolean;
  /** X-only column mapping for the pressed ROW (native internalIndex-from-x):
   *  step = sliceStart + floor((x − colOriginX) / cellW). Resize/draw never
   *  stalls on vertical drift; split rows stay row-locked like native. */
  colOriginX: number;
  cellW: number;
  sliceStart: number;
  /** OWN empty press already toggled at press (release must not re-toggle). */
  pressStamped?: boolean;
  /** Thresholds of the pointer that STARTED the gesture (mouse vs touch). */
  tuning: GestureTuning;
  /** Press landed inside the live selection (P2.2 — kept, not cleared). */
  keptSelection: boolean;
}

// --------------------------------------------------------------------------
// Static renderer (pure canvas painting; token colors read at paint time).
// --------------------------------------------------------------------------

type Rect = { x: number; y: number; w: number; h: number };

interface TrackLayout {
  trackIndex: number;
  stepCount: number;
  /** Every step's rect (split-aware) — hit-testing iterates these. */
  rects: Map<number, Rect>;
  /** Maps a track-local step index to its cell rect (split-aware). */
  cellRect: (step: number) => Rect | null;
  /**
   * SIG-1 — where the SOUNDING audio is, in device-independent canvas x.
   *
   * `posFrac` is the engine's own answer: how far into the source sample the
   * newest voice on this track has got (0…1). This runs the cell's segment map
   * backwards to find the exact column that audio was drawn at.
   *
   * null when the track is silent, when the position is outside what this cell
   * draws (an OWN tail ringing under a later, empty step), or when the cell has
   * no waveform (a note cell). The caller then draws nothing — a playhead that
   * guesses is worse than one that admits it doesn't know.
   */
  playheadX: (step: number, posFrac: number) => { x: number; rect: Rect } | null;
}

const PAD = 2;
// Track controls moved to a full-width DOM band BELOW each track's cells
// (native TrackRowView = VStack[cells, modifiersSection]). The canvas draws
// pure cells edge-to-edge in the top sub-band; the fat control band (3 rows)
// overlays the reserved bottom. When content exceeds the viewport the whole
// stack scrolls (native vertical-zoom/scroll parity).
const LABEL_W = 0;
// MIN cell-row height (cells balloon above this to fill; the stack scrolls
// below it). 68 ≈ native base cell (~63) + margin: room for the top tool
// band (accent zone + step number, ~12px) AND the bottom value chip (15px)
// with a legible waveform between — at the old 46 the in-cell tools
// overlapped and the cell top read as cut off once the fat band grew.
/** Row metrics for one density (see METRICS). Threaded rather than global so
 *  the compose grid and the DJ deck strips can render side by side. */
type GridMetrics = { cellRowH: number; bandH: number; gap: number };

/** Content height that yields ≥cellRowH per cell row + a full control band
 *  per track. When it exceeds the viewport the stack scrolls; when it's
 *  smaller, gridRowLayout balloons the cells to fill the viewport. */
function contentHeight(
  live: { stepCount: number }[],
  zoom: number,
  split: boolean,
  bandHs: number[],
  m: GridMetrics,
  cellsHidden = false,
): number {
  const totalRows = live.reduce((s, l) => s + rowSlices(l.stepCount, zoom, split).length, 0) || 1;
  const bandTotal = live.reduce((s, _l, k) => s + (bandHs[k] ?? m.bandH), 0);
  const cellsTotal = cellsHidden ? 0 : totalRows * m.cellRowH;
  return cellsTotal + bandTotal + m.gap * (live.length + 1);
}

interface GridSelection {
  trackIndex: number;
  steps: Set<number>;
  anchor: number | null;
}

/**
 * The grid's quiet field — the RATIOS between its marks.
 *
 * These are design, not theme. A 2px flam dot needs more alpha than a
 * full-width band to read as equally present; the span-interior boundary
 * recedes below the gridline so a multi-step cell reads as one unbroken region;
 * the bar rule sits above both so a long pattern stays navigable. Letting a look
 * re-weight these would let a look break the grid's legibility.
 *
 * So the theme does NOT get fourteen alpha sliders. It gets ONE — surface.chromeInk —
 * which scales this whole family together. The theme sets the level; the code keeps
 * the balance. (Every value below is exactly what the grid has always drawn with.)
 */
const FIELD = {
  groupShade: 0.03, // alternating groupSize bands
  // The beat-repeat region, washed in --signal behind the cells. Well above groupShade (it
  // must read instantly across a room mid-performance) and well under the playhead's own
  // wash, so the playhead stays the brightest thing inside the region it is trapped in.
  beatRepeat: 0.14,
  gridline: 0.35, // hairlines + the row frame
  barRule: 0.7, // the stronger rule every 4 groups
  spanInterior: 0.12, // boundaries INSIDE a multi-step cell recede
  stepNumber: 0.6, // the absolute address at each group start
  startFlag: 0.9, // the per-track pattern-start flag
  hoverLift: 0.05, // the hovered cell
  hoverGhostBand: 0.12, // ghost-revealed accent band
  hoverGhostGrip: 0.2, // ghost-revealed flam grip (small mark → more alpha)
  hoverGhostMark: 0.15, // ghost-revealed dog-ear / glide nub
  seam: 0.5, // row-break dashed seam ("cut here, continues on the next row")
  // The PERF drag preview: the in-flight window, half-lit, so the brackets you
  // are dragging read as provisional against the ones already committed.
  performPreview: 0.5,
  chipBg: 0.8, // value-chip ground (0.92 when focused)
  chipBgFocus: 0.92,
  chipEdge: 0.6,
  chipInk: 0.95,
  focusParked: 0.4, // focus ring, dimmed when the keys are elsewhere
  // In-cell affordance marks — the annotation layer over the waveform.
  noteBlock: 0.62, // a note cell's filled block
  noteInk: 0.95, // the note name inside it
  accentTick: 0.55, // hard-accent rule across the owner's top edge
  dogEar: 0.7, // reverse flip-tab
  glideHook: 0.9, // glide junction hook (0.6 legacy-all, 0.8 when % is 0)
  glideHookLegacy: 0.6,
  glideHookZero: 0.8,
  leadIn: 0.45, // pre-silence onset mark
  hiddenData: 0.45, // bottom-right dot: this cell edits an un-marked, un-armed lane
  noteRest: 0.62, // vel-0 rest — the note block drawn hollow (same weight as noteBlock)
} as const;

/** A FIELD ratio at the look's ink level (chrome only — see inkAlpha). */
const ink = inkAlpha;

/**
 * The look's corner radius, clamped so a cell can never round itself away.
 * Canvas can't read CSS vars, so shape comes through the token object — the same
 * route as the colours and alphas.
 */
const cellRadius = (w: number, h: number): number =>
  Math.max(0, Math.min(currentTokens().shape.radiusPx, w / 2, h / 2));

/**
 * A cell-shaped fill. THE reason the grid was still hard-cornered while every
 * other surface rounded: the cells are canvas, so no stylesheet could reach them,
 * and `ctx.roundRect` was documented but never actually called.
 * Falls back to a plain rect at radius 0 — the sharp default pays nothing.
 */
function fillCell(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = cellRadius(w, h);
  if (r < 0.5) {
    ctx.fillRect(x, y, w, h);
    return;
  }
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function strokeCell(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = cellRadius(w, h);
  if (r < 0.5) {
    ctx.strokeRect(x, y, w, h);
    return;
  }
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.stroke();
}
/** The look's canvas surface tokens. */
const surf = () => currentTokens().surface;

function drawStatic(
  canvas: HTMLCanvasElement,
  meta: GridMetaState,
  tracks: (GridTrackState | null)[],
  peaks: Map<string, Peaks>,
  sel: GridSelection,
  focus: { trackIndex: number; step: number } | null,
  bandHs: number[],
  focusParked: boolean,
  groupSize: number,
  hover: { trackIndex: number; step: number } | null,
  m: GridMetrics,
  style: WaveformStyle,
  performDrag: PerformDrag | null,
): TrackLayout[] {
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = (n: string) =>
    getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const cBg = css("--bg");
  const cLine = css("--line");
  const cText = css("--text");
  const cDim = css("--text-dim");
  const fontMono = css("--font-mono") || "monospace";
  ctx.fillStyle = cBg;
  ctx.fillRect(0, 0, w, h);

  const live = tracks
    .map((t, i) => ({ t, i }))
    .filter((x): x is { t: GridTrackState; i: number } => x.t !== null)
    .slice(0, meta.trackCount);

  // Meta arrived but no track state yet (or every payload was rejected —
  // see console): say so instead of painting a bare background.
  if (live.length === 0) {
    ctx.fillStyle = cDim;
    ctx.font = `11px ${css("--font-mono") || "monospace"}`;
    ctx.textBaseline = "top";
    ctx.fillText("waiting for track state…", 12, 12);
    return [];
  }

  // Row height budget: cells + a per-track fat control band share the height.
  // The DOM control band (TrackBand) reads the SAME gridRowLayout so it aligns
  // pixel-for-pixel below each track's cells (trackrow.md §8 native
  // TrackRowView = VStack[cells, modifiersSection]). `h` = canvas height =
  // the (possibly scrolled) content height.
  const split = meta.displayMode === "split";
  const zoom = meta.horizontalZoom;
  const { rowH, blocks } = gridRowLayout(
    live.map(({ t, i }) => ({ trackIndex: i, stepCount: t.stepCount })),
    zoom,
    split,
    h,
    m.gap,
    live.map((_x, k) => bandHs[k] ?? m.bandH),
  );
  const gridW = w - LABEL_W - PAD * 2;
  // Cell width is SHARED across every track (native `calculatePadSize`:
  // divisor = min(maxStepCount, zoom)). So a column lines up across tracks of
  // different lengths — a shorter track shows fewer cells from the left and
  // leaves the right empty; it does NOT stretch its cells to fill the row.
  // This is the fix for the "expands wrong with length / dirty" misalignment.
  const maxStepCount = Math.max(1, ...live.map(({ t }) => t.stepCount));
  const cellW = sharedCellWidth(gridW, maxStepCount, zoom);

  const layouts: TrackLayout[] = [];
  // Native greyMultiplier parity (:11098): muted and not-soloed-while-solo
  // tracks recede as a whole on the canvas, not just in the control strip.
  const hasSolo = live.some(({ t }) => t.soloed);

  for (let li = 0; li < live.length; li++) {
    const { t, i } = live[li]!;
    const presence = t.muted ? 0.35 : hasSolo && !t.soloed ? 0.45 : 1;
    const slices = rowSlices(t.stepCount, zoom, split);
    let y = blocks[li]!.cellsTop;
    const rects = new Map<number, { x: number; y: number; w: number; h: number }>();

    // A column boundary interior to one cell's span recedes so a multi-step
    // cell reads as ONE unbroken region (refined-sharp chrome, GR-VIS).
    const interiorBoundary = (step: number) => {
      const a = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, step - 1);
      const b = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, step);
      return !!a && !!b && a.owner === b.owner && a.viaWrap === b.viaWrap && b.owner !== step;
    };

    for (const slice of slices) {
      for (let c = 0; c < slice.count; c++) {
        const step = slice.startStep + c;
        const x = LABEL_W + PAD + c * cellW;
        const rect = { x: x + 1, y: y + 1, w: cellW - 2, h: rowH - 2 };
        rects.set(step, rect);
      }
      // Pass 1: quiet field — group shading, hairline gridlines, bar rules,
      // step-number addresses. No per-cell boxes (the old full-alpha stroke
      // + inset gap read as a wire mesh — GR-VIS user decision 2026-07-12).
      const x0 = LABEL_W + PAD;
      const x1 = x0 + slice.count * cellW;
      // Group shading: alternating groupSize-step bands. Derived from --text
      // at whisper alpha, NOT --bg-raised: raised is the CONTROL color
      // (troughs/boxes/buttons) and must never tint the grid field — the grid
      // stays on the app background (transparent look, colored waveforms).
      ctx.fillStyle = cText;
      ctx.globalAlpha = ink(FIELD.groupShade);
      for (let c = 0; c < slice.count; c++) {
        const step = slice.startStep + c;
        if (Math.floor(step / groupSize) % 2 === 1) {
          ctx.fillRect(x0 + c * cellW, y, cellW, rowH);
        }
      }
      ctx.globalAlpha = 1;

      // THE BEAT-REPEAT REGION — the steps the deck is currently trapped in.
      //
      // Native fills them blue behind the playhead (ContentView:12655). Here they burn in
      // `--signal`, the SAME role the playhead uses, because they are the same claim: signal
      // is what is LIVE, and while a repeat is engaged the live region IS these steps — the
      // playhead is just the brightest point inside it. One colour language, read twice (the
      // frozen waveform against the live carve). Reusing --accent would have collided with
      // selection/focus, and --warn is the locator's.
      //
      // It lands in the FIELD pass, under the waveform, so the region lights the cells from
      // BEHIND instead of tinting the waveform's own track colour — the waveform keeps saying
      // what the audio is, the field says where the loop is caught. Static layer, not hot:
      // this moves when you press a key, not every frame.
      //
      // Steps arrive PRE-RESOLVED from Swift (`beatRepeatSteps`) — already mapped through this
      // track's speed/direction/phase, so a 2:1 track lights every other cell exactly as native
      // does, and TS never re-derives the fold.
      if (t.beatRepeatSteps.length > 0) {
        ctx.fillStyle = css("--signal");
        ctx.globalAlpha = ink(FIELD.beatRepeat);
        for (const step of t.beatRepeatSteps) {
          const c = step - slice.startStep;
          if (c >= 0 && c < slice.count) ctx.fillRect(x0 + c * cellW, y, cellW, rowH);
        }
        ctx.globalAlpha = 1;
      }
      // Sub-1 fractional window (1/2 … 1/32): a fractional-width inset of ONE cell at the resolved
      // sub-cell offset — so a 1/2 on the back half of a step lights the cell's right half. Swift
      // empties `beatRepeatSteps` while this is active, so the two never double-paint the cell.
      if (t.beatRepeatSubStep >= 0 && t.beatRepeatSubLen > 0) {
        const c = t.beatRepeatSubStep - slice.startStep;
        if (c >= 0 && c < slice.count) {
          ctx.fillStyle = css("--signal");
          ctx.globalAlpha = ink(FIELD.beatRepeat);
          ctx.fillRect(x0 + (c + t.beatRepeatSubStart) * cellW, y, t.beatRepeatSubLen * cellW, rowH);
          ctx.globalAlpha = 1;
        }
      }
      // Hairlines in DEVICE pixels (same crispness discipline as
      // waveRender): 1 device px @0.35; bar rule every 4 groups = 1 CSS px
      // @0.7; span-interior boundaries recede to 0.12.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = cLine;
      const yTop = Math.round(y * dpr);
      const yBot = Math.round((y + rowH) * dpr);
      const xL = Math.round(x0 * dpr);
      const xR = Math.round(x1 * dpr);
      ctx.globalAlpha = ink(FIELD.gridline);
      ctx.fillRect(xL, yTop, xR - xL, 1);
      ctx.fillRect(xL, yBot - 1, xR - xL, 1);
      for (let c = 0; c <= slice.count; c++) {
        const step = slice.startStep + c;
        const bx = Math.round((x0 + c * cellW) * dpr);
        const lx = c === slice.count ? xR - 1 : bx; // right frame stays inside
        const inner = c > 0 && c < slice.count;
        const isBar = inner && step % (groupSize * 4) === 0;
        ctx.globalAlpha = ink(
          isBar
            ? FIELD.barRule
            : inner && interiorBoundary(step)
              ? FIELD.spanInterior
              : FIELD.gridline,
        );
        ctx.fillRect(lx, yTop, isBar ? Math.max(1, Math.round(dpr)) : 1, yBot - yTop);
      }
      ctx.restore();
      // Step numbers at group starts (native n%4==1 idiom, :11140): the
      // absolute address that shading alone can't give in long patterns.
      ctx.fillStyle = cDim;
      ctx.globalAlpha = ink(FIELD.stepNumber);
      ctx.font = `8px ${fontMono}`;
      ctx.textBaseline = "top";
      for (let c = 0; c < slice.count; c++) {
        const step = slice.startStep + c;
        if (step % groupSize !== 0) continue;
        // The pattern-start flag owns that cell's top-left corner.
        if (t.patternStartStep === step) continue;
        ctx.fillText(String(step + 1), x0 + c * cellW + 4, y + 4);
      }
      ctx.globalAlpha = 1;
      y += rowH;
    }

    // Pass 2: cells (owner spans as one region + waveform + affordances).
    // The focused cell's owner drops its own value chip — the focus readout
    // chip (drawn later) replaces it, so a cell never shows a number twice.
    const focusOwner =
      focus && focus.trackIndex === i
        ? (resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, focus.step)?.owner ?? null)
        : null;
    for (let step = 0; step < t.stepCount; step++) {
      if (!t.steps[step]) continue;
      const resolved = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, step);
      if (!resolved || resolved.owner !== step) continue;
      drawOwnerCell(ctx, t, meta.bpm, step, resolved.span, rects, peaks, css, style, presence, false, focusOwner === step);
    }
    // Wrap continuation region at step 0.
    if (t.wrapSourceStep !== null) {
      const r0 = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, 0);
      if (r0?.viaWrap) drawOwnerCell(ctx, t, meta.bpm, 0, r0.span, rects, peaks, css, style, presence, true);
    }

    // Per-track pattern start point (native yellow flag parity, :10305): the
    // step this track launches from, when the offset is active.
    if (t.patternStartStep !== null) {
      const r = rects.get(t.patternStartStep);
      if (r) {
        ctx.fillStyle = css("--warn");
        ctx.globalAlpha = ink(FIELD.startFlag);
        ctx.beginPath();
        ctx.moveTo(r.x + 2, r.y + 2);
        ctx.lineTo(r.x + 9, r.y + 5);
        ctx.lineTo(r.x + 2, r.y + 8);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // GR-VIS hover response: a subtle lift on the hovered cell, plus ghost
    // hints of the in-cell mark zones on its covering cell — the
    // hover-revealed hit zones grid.md §3 calls for (no persistent chrome).
    // Geometry comes from the SAME zoneSizes the hit-test uses.
    if (hover && hover.trackIndex === i) {
      const hr = rects.get(hover.step);
      if (hr) {
        ctx.fillStyle = cText;
        ctx.globalAlpha = ink(FIELD.hoverLift);
        fillCell(ctx, hr.x, hr.y, hr.w, hr.h);
        const res = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, hover.step);
        const or = res && !res.viaWrap ? rects.get(res.owner) : undefined;
        if (res && or) {
          const { corner, topBand } = zoneSizes(or);
          // accent band (top edge)
          ctx.globalAlpha = ink(FIELD.hoverGhostBand) * presence;
          ctx.fillRect(or.x + 1, or.y + topBand, or.w - 2, 1);
          // flam grip (lower-left)
          ctx.globalAlpha = ink(FIELD.hoverGhostGrip) * presence;
          ctx.fillRect(or.x + 3, or.y + or.h - 5, 2, 2);
          // reverse dog-ear outline (top-right; the filled tab replaces it)
          if (!(t.reverseSteps[res.owner] ?? false)) {
            const leg = Math.min(6, corner - 2);
            ctx.globalAlpha = ink(FIELD.hoverGhostMark) * presence;
            ctx.strokeStyle = cText;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(or.x + or.w - 1 - leg, or.y + 1);
            ctx.lineTo(or.x + or.w - 1, or.y + 1 + leg);
            ctx.stroke();
          }
          // glide junction nub (left edge; only where a junction exists)
          const hasLeftJunction =
            res.owner > 0 &&
            resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, res.owner - 1) !== null;
          if (hasLeftJunction && !(t.glideSteps[res.owner] ?? false)) {
            ctx.globalAlpha = ink(FIELD.hoverGhostMark) * presence;
            ctx.fillRect(or.x - 1, or.y + Math.round(or.h * 0.24), 4, 1);
          }
          // Hidden-edit readout on hover: spell out the lanes the bottom-right
          // dot only hinted at, by repainting THIS owner's chip in place (pass 2
          // already drew the plain chip; the focus block would override it, so
          // skip when this owner is the focused cell). Same one-chip slot.
          ctx.globalAlpha = 1;
          const hidden = cellHiddenLaneTags(t, res.owner, t.activeCellParameterName);
          if (hidden.length > 0 && focusOwner !== res.owner) {
            const armed = cellValueLabel(t, res.owner); // "" when armed lane is default
            const parts = armed ? [armed, ...hidden] : hidden;
            ctx.font = `600 9px ${css("--font-mono") || "monospace"}`;
            const budget = w - PAD - (or.x + 2);
            const label = fitReadout(parts[0]!, parts.slice(1), (s) =>
              ctx.measureText(s).width + 8 <= budget,
            );
            drawChip(ctx, css, or.x + 2, or.y + or.h - 2, label, { presence });
          }
        }
        ctx.globalAlpha = 1;
      }
    }

    // Selection tint + focus ring (web-side state, accent idiom).
    if (sel.trackIndex === i && sel.steps.size > 0) {
      ctx.fillStyle = css("--accent");
      ctx.globalAlpha = surf().selectionAlpha;
      for (const s of sel.steps) {
        const r = rects.get(s);
        if (r) fillCell(ctx, r.x, r.y, r.w, r.h);
      }
      ctx.globalAlpha = 1;
    }
    if (focus && focus.trackIndex === i) {
      const r = rects.get(focus.step);
      if (r) {
        // The ring IS the lane indicator (P2.1): full accent when the grid
        // owns the keys, dimmed when a DragBox does ("focus parked here,
        // keys are elsewhere"). Exactly one accent ring on screen.
        ctx.globalAlpha = focusParked ? FIELD.focusParked : 1;
        ctx.strokeStyle = css("--accent");
        ctx.lineWidth = 2;
        strokeCell(ctx, r.x + 1, r.y + 1, r.w - 2, r.h - 2);
        ctx.lineWidth = 1;
        ctx.globalAlpha = 1;
        // P5-PCE P1.4 focus readout (armed param + effective value), moved
        // into the bottom-left CHIP slot (GR-VIS follow-up: the top-left
        // label duplicated the owner chip — pitch showed twice — and
        // crowded the step number). It REPLACES the owner chip on this cell
        // (suppressChip in pass 2), so a cell shows exactly one number.
        // Covered steps show the OWNER's value — what ö/ä actually edits.
        // Empty cell: armed param short only, dimmed.
        const res = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, focus.step);
        // The readout is the armed param's value, then every OTHER lane this
        // cell secretly edits (` · VEL 90 · NDG +0.25`), degrading to ` +N` and
        // finally to the bare armed value as the cell narrows — still exactly
        // ONE chip in the one slot. Budget = chip-left → grid right edge.
        let readout: string;
        if (res) {
          const base = cellParamValueLabel(t, res.owner);
          const tags = cellHiddenLaneTags(t, res.owner, t.activeCellParameterName);
          ctx.font = `600 9px ${css("--font-mono") || "monospace"}`;
          const budget = w - PAD - (r.x + 2);
          readout = fitReadout(base, tags, (s) => ctx.measureText(s).width + 8 <= budget);
        } else {
          readout = cellParamChipLabel(t.activeCellParameterName);
        }
        drawChip(ctx, css, r.x + 2, r.y + r.h - 2, readout, {
          focus: true,
          dim: focusParked || !res,
        });
      }
    }

    // Locator window brackets.
    if (t.locatorStart !== null && t.locatorLength !== null) {
      ctx.strokeStyle = css("--warn");
      ctx.lineWidth = 1.5;
      for (let k = 0; k < t.locatorLength; k++) {
        const rect = rects.get((t.locatorStart + k) % t.stepCount);
        if (rect) ctx.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
      }
    }

    // PERF drag preview: the in-flight window at half alpha — it previews the
    // exact brackets the release commits (the Swift echo paints them full).
    if (performDrag && performDrag.trackIndex === i) {
      const pr = performRange(performDrag, t.stepCount);
      ctx.strokeStyle = css("--warn");
      ctx.globalAlpha = FIELD.performPreview;
      ctx.lineWidth = 1.5;
      for (let k = 0; k < pr.lengthSteps; k++) {
        const rect = rects.get(pr.startStep + k);
        if (rect) ctx.strokeRect(rect.x + 1, rect.y + 1, rect.w - 2, rect.h - 2);
      }
      ctx.globalAlpha = 1;
    }

    // SIG-1: the segment map, cached per owner cell. A track sounds ONE cell at a
    // time, so this computes at most once per cell per pass and is then free —
    // the hot layer must never do real work, it runs at 60 Hz over 16 tracks.
    const waveCache = new Map<number, CellWaveform | null>();
    const waveFor = (owner: number, span: number, isWrap: boolean): CellWaveform | null => {
      const key = isWrap ? -1 : owner;
      let w = waveCache.get(key);
      if (w === undefined) {
        w = computeCellSegments(t, meta.bpm, owner, span, isWrap) ?? null;
        waveCache.set(key, w);
      }
      return w;
    };

    layouts.push({
      trackIndex: i,
      stepCount: t.stepCount,
      rects,
      cellRect: (s) => rects.get(s) ?? null,
      playheadX: (step, posFrac) => {
        if (t.trackType !== "audio" || posFrac < 0 || !t.sampleDurationMs) return null;
        const res = resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, step);
        if (!res) return null;
        const owner = res.viaWrap ? (t.wrapSourceStep ?? res.owner) : res.owner;
        const wave = waveFor(owner, res.span, res.viaWrap);
        if (!wave) return null;
        // The engine reports a fraction of the SOURCE buffer; the cell was drawn
        // from those same frames, so the map inverts straight back to a column.
        const frac = sourceMsToCellFrac(wave, posFrac * t.sampleDurationMs);
        if (frac === null) return null;
        // Which fragment of a row-split span the column falls in.
        const frags = spanFragments(res.viaWrap ? 0 : owner, res.span, (s) => rects.get(s));
        const hit = frags.find((f) => frac >= f.v0 - 1e-6 && frac <= f.v1 + 1e-6) ?? frags[0];
        if (!hit) return null;
        const local = (frac - hit.v0) / Math.max(1e-6, hit.v1 - hit.v0);
        return {
          x: hit.x + local * hit.w,
          rect: { x: hit.x, y: hit.y, w: hit.w, h: hit.h },
        };
      },
    });
  }
  return layouts;
}

/**
 * Bottom-left value chip — THE one number a cell shows (GR-VIS follow-up:
 * the focus label lived top-left while the owner chip sat bottom-left, so a
 * focused note showed its pitch twice and the cell top was a label pile-up).
 * `focus` styles it as the focused-cell readout (accent border/text);
 * `dim` marks an inert readout (parked lane, or armed param on an empty cell).
 */
function drawChip(
  ctx: CanvasRenderingContext2D,
  css: (n: string) => string,
  x: number,
  yBottom: number,
  label: string,
  opts: { presence?: number; focus?: boolean; dim?: boolean } = {},
) {
  const presence = opts.presence ?? 1;
  const dim = opts.dim ? 0.5 : 1;
  ctx.font = `600 9px ${css("--font-mono") || "monospace"}`;
  const tw = Math.ceil(ctx.measureText(label).width);
  const chipH = 13;
  const chipY = yBottom - chipH;
  ctx.fillStyle = css("--bg");
  ctx.globalAlpha = ink(opts.focus ? FIELD.chipBgFocus : FIELD.chipBg) * presence;
  ctx.fillRect(x, chipY, tw + 6, chipH);
  ctx.strokeStyle = opts.focus ? css("--accent") : css("--line");
  ctx.lineWidth = 1;
  ctx.globalAlpha = (opts.focus ? 1 : ink(FIELD.chipEdge)) * dim * presence;
  ctx.strokeRect(x + 0.5, chipY + 0.5, tw + 5, chipH - 1);
  ctx.fillStyle = opts.focus ? css("--accent") : css("--text");
  ctx.globalAlpha = (opts.focus ? 1 : ink(FIELD.chipInk)) * dim * presence;
  ctx.textBaseline = "bottom";
  ctx.fillText(label, x + 3, chipY + chipH - 2);
  ctx.globalAlpha = 1;
}

/** One owner cell: span fill, segment-mapped waveform, accent ticks, flam copies. */
/**
 * A note cell: a flat filled block carrying the note it plays.
 *
 * There is no waveform to draw — the track sounds a synth, not a sample — so the cell
 * states the one thing that matters and nothing it cannot know: WHICH NOTE. The block is
 * uniform on purpose (the user's call): a mark that varies with velocity or pitch would
 * make every cell a slightly different shade of the same thing, and "uniform texture
 * carries no information" is the lesson the waveform round already taught.
 *
 * The engine's own timing is honoured, so what you see is what you hear:
 *   · FLAM  — the owner step splits into N sub-blocks (the ratchet the generator fires)
 *   · PRE-SILENCE — the block's left edge insets by the delay before the note-on
 *   · LENGTH — the block spans the cell, which IS the note's length
 * Accent, glide and chord keep their existing in-cell marks, drawn by the caller.
 */
function drawNoteCell(
  ctx: CanvasRenderingContext2D,
  t: GridTrackState,
  bpm: number,
  owner: number,
  span: number,
  frags: { x: number; y: number; w: number; h: number; v0: number; v1: number }[],
  css: (n: string) => string,
  presence: number,
  isWrap: boolean,
) {
  const color = trackDisplayColor(t.colorHex);
  const hits = isWrap ? 1 : Math.max(1, Math.min(16, t.flamCounts[owner] ?? 1));
  // A velocity of exactly 0 is a gate/rest — the cell occupies the step but
  // sounds nothing. Drawn hollow (outline, not fill) so an inaudible cell can
  // never be mistaken for a hit — the same "mark the inaudible state" idea the
  // amber zero-glide hook uses, expressed without adding a colour.
  const isRest = t.midiVelocities[owner] === 0;
  // Pre-silence delays the note INSIDE its cell; the visible gap IS the delay —
  // measured in real ms against the cell's own duration, as the generator does
  // (:1636). It used to be a made-up 500 ms full-scale, so the gap you saw was
  // not the delay you heard, and it drifted with tempo.
  const stepFrac = 1 / span;
  const onset = isWrap ? 0 : preSilenceOnsetFrac(t, bpm, owner, span);

  const block = (v0: number, v1: number) => {
    for (const { x, w } of sliceSpanInterval(frags, v0, v1)) {
      const fr = frags.find((f) => f.v0 <= v0 + 1e-6 && f.v1 >= v0 - 1e-6) ?? frags[0]!;
      const bx = Math.round(x) + 1;
      const by = Math.round(fr.y) + 3;
      const bw = Math.max(1, Math.round(w) - 2);
      const bh = Math.round(fr.h) - 6;
      ctx.globalAlpha = FIELD.noteBlock * presence;
      if (isRest) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(bx + 0.5, by + 0.5, Math.max(1, bw - 1), Math.max(1, bh - 1));
      } else {
        ctx.fillStyle = color;
        ctx.fillRect(bx, by, bw, bh);
      }
    }
  };

  if (hits <= 1) {
    block(onset, 1);
  } else {
    // The ratchet fans inside the OWNER STEP — exactly where the generator fires it.
    const sub = stepFrac / hits;
    for (let h = 0; h < hits; h++) {
      const a = onset + sub * h;
      const b = h === hits - 1 ? 1 : a + sub * 0.8;
      block(a, Math.min(1, Math.max(a + sub * 0.25, b)));
    }
  }
  ctx.globalAlpha = 1;

  // The note itself, in the block. A name ("C3") says what a number ("+0") never
  // could — and when a chord is armed on the cell its short label rides along
  // ("C3 MIN"), so a voicing stays visible without the CHD dial being armed.
  // Wide cells show the full label; when the chord suffix won't fit it drops
  // first (note survives); below the note's own width nothing is drawn.
  const first = frags[0]!;
  if (first.h >= 16) {
    const note = noteName(t.midiRootNote + Math.round((t.pitchOffsets[owner] ?? 0) / 2));
    const full = noteCellLabel(t, owner);
    ctx.font = "600 9px var(--font-mono), monospace";
    const fits = (s: string) => Math.ceil(ctx.measureText(s).width) + 10 <= first.w;
    const label = fits(full) ? full : fits(note) ? note : "";
    if (label) {
      ctx.textBaseline = "middle";
      // A rest carries no filled ground, so its label reads in --text (dim)
      // rather than the block-ink --bg that only shows against a fill.
      ctx.fillStyle = isRest ? css("--text") : css("--bg");
      ctx.globalAlpha = ink(FIELD.noteInk) * (isRest ? 0.6 : 1) * presence;
      ctx.fillText(label, Math.round(first.x) + 5, Math.round(first.y + first.h / 2));
      ctx.globalAlpha = 1;
    }
  }
}

function drawOwnerCell(
  ctx: CanvasRenderingContext2D,
  t: GridTrackState,
  bpm: number,
  startStep: number,
  span: number,
  rects: Map<number, { x: number; y: number; w: number; h: number }>,
  peaks: Map<string, Peaks>,
  css: (n: string) => string,
  style: WaveformStyle,
  presence = 1,
  isWrap = false,
  suppressChip = false,
) {
  const first = rects.get(startStep);
  if (!first) return;
  // Visual fragments: one contiguous run per grid row (gridModel
  // spanFragments). Full-width mode yields a single fragment; in SPLIT mode
  // a span crossing a row boundary (e.g. 12–20 over 16-step rows) yields
  // one fragment per row, so waveform/onset/tint distribute across rows by
  // step position. (The old code truncated the region at the row break and
  // mapped the WHOLE waveform into that first fragment; native split for
  // free by rendering per-step, but broke the cell into bordered singles.)
  const frags = spanFragments(startStep, span, (s) => rects.get(s));
  if (frags.length === 0) return;
  const owner = isWrap ? (t.wrapSourceStep ?? startStep) : startStep;

  // Whisper fill (GR-VIS color-carrier flip, native inverted-mode parity
  // :11128): the tint only marks the cell's extent — the track color lives
  // in the waveform. Owner step slightly stronger, wrap continuation dimmer.
  ctx.fillStyle = trackDisplayColor(t.colorHex);
  ctx.globalAlpha = (isWrap ? surf().wrapTintAlpha : surf().cellTintAlpha) * presence;
  for (const fr of frags) fillCell(ctx, fr.x, fr.y, fr.w, fr.h);
  if (!isWrap) {
    ctx.globalAlpha = surf().wrapTintAlpha * presence;
    fillCell(ctx, first.x, first.y, first.w, first.h);
  }
  // Row-break seam: a broken edge is NOT a cell end — mark it with a short
  // dashed hairline in track color (a real end just stops at the grid
  // hairline; the dashes read as "cut here, continues on the next row").
  ctx.globalAlpha = ink(FIELD.seam) * presence;
  for (let f = 0; f < frags.length; f++) {
    const fr = frags[f]!;
    const seam = (sx: number) => {
      for (let sy = fr.y + 2; sy < fr.y + fr.h - 2; sy += 6) {
        ctx.fillRect(sx, sy, 1, 3);
      }
    };
    if (f < frags.length - 1) seam(Math.round(fr.x + fr.w) - 1);
    if (f > 0) seam(Math.round(fr.x));
  }
  ctx.globalAlpha = 1;

  // Segment-mapped waveform (P5-02c): each per-step segment maps its own
  // audio window (pitch/varispeed consumption, stretch, loop wrap, chop,
  // wrap continuation, lead-in silence) at its own amplitude (volume
  // offsets × accent). Reverse mirrors segments inside the audio window.
  // WHAT THE CELL DRAWS follows what the track SOUNDS, not what it happens to own.
  // The waveform used to render whenever a sample was ASSIGNED — so switching a track
  // to notes still drew the old sample's audio, because the flip deliberately keeps the
  // sample loaded. The rule is now: a waveform iff the SAMPLE output is on; otherwise
  // the cell is a note block. (A layered track — sample + MIDI — draws the waveform:
  // it is the audio you actually hear, and the notes it sends are the very pitches that
  // waveform is already pitched to, so nothing is hidden.)
  const soundsSample = t.trackType === "audio";
  if (!soundsSample) {
    drawNoteCell(ctx, t, bpm, owner, span, frags, css, presence, isWrap);
    return;
  }

  const wave = computeCellSegments(t, bpm, owner, span, isWrap);
  const pk = t.sampleKey
    ? peaks.get(peaksKey(t.sampleKey, style.points, style.colorMode === "spectrum"))
    : undefined;
  if (wave && pk && pk.minMax.length >= 4) {
    const dur = t.sampleDurationMs;
    // The waveform IS the color carrier (GR-VIS): track color columns over
    // the whisper tint — the audio is the figure, the cell is the ground.
    const color = trackDisplayColor(t.colorHex);
    const flam = isWrap ? 1 : (t.flamCounts[owner] ?? 1);
    const stepFrac = 1 / span;
    const drawSeg = (
      a0: number,
      a1: number,
      v0: number,
      v1: number,
      amp: number,
    ) => {
      if (v1 - v0 <= 0.0005 || a1 - a0 <= 0) return;
      // A segment crossing a row break renders per fragment, slicing its
      // audio window proportionally (mirroring composes: slice forward
      // audio first, THEN mirror the slice inside the window).
      for (const { fr, x, w, t0, t1 } of sliceSpanInterval(frags, v0, v1)) {
        let s0 = a0 + t0 * (a1 - a0);
        let s1 = a0 + t1 * (a1 - a0);
        if (wave.reversed) {
          const m0 = wave.windowStartMs + (wave.windowEndMs - s1);
          const m1 = wave.windowStartMs + (wave.windowEndMs - s0);
          s0 = m0;
          s1 = m1;
        }
        drawWave(
          ctx,
          pk,
          { x: x + 1, y: fr.y + 2, w: w - 2, h: fr.h - 4 },
          {
            startFrac: Math.max(0, s0 / dur),
            endFrac: Math.min(1, s1 / dur),
            reversed: wave.reversed,
            color,
            gain: amp,
            presence,
          },
          style,
        );
      }
    };
    // Lead-in as a fraction of the OWNER STEP (flamCopySpan works step-local).
    const silenceLocal = wave.silenceFrac / stepFrac;
    for (const seg of wave.segments) {
      const amp = stepAmplitude(t, seg.stepIndex, owner);
      if (flam > 1 && seg.visualStartFrac < stepFrac - 1e-6) {
        // Flam: the owner step re-fires N× — draw N compressed copies confined
        // to the owner step's width (native idiom :7943–75). The pre-silence
        // rides ALONG: every sub-hit takes the full delay, so each copy keeps a
        // full-size gap and the group sits later by it (see flamCopySpan).
        const local0 = seg.visualStartFrac / stepFrac;
        const local1 = Math.min(1, seg.visualEndFrac / stepFrac);
        for (let f = 0; f < flam; f++) {
          const c = flamCopySpan(local0, local1, silenceLocal, stepFrac, flam, f);
          if (c) drawSeg(seg.audioStartMs, seg.audioEndMs, c.v0, c.v1, amp);
        }
      } else {
        drawSeg(seg.audioStartMs, seg.audioEndMs, seg.visualStartFrac, seg.visualEndFrac, amp);
      }
    }
    // GHOST TAILS (native OWN idiom :10432ff): an owner voice keeps
    // sounding past its cell — draw the remaining audio at reduced
    // presence across the following empty steps until the next owner
    // cuts it (or the pattern ends), so what will be AUDIBLE is visible.
    if (t.playbackMode === "owner" && !isWrap && !t.loopEnabled && wave.segments.length) {
      const last = wave.segments[wave.segments.length - 1]!;
      const rate = stepRate(t, owner);
      const stepMs = gridStepMs(bpm) / Math.max(0.001, t.speedMultiplier || 1);
      let tailPos = last.audioEndMs;
      const ownerAmp = stepAmplitude(t, owner, owner);
      for (let s = startStep + span; s < t.stepCount && tailPos < wave.windowEndMs; s++) {
        if (t.steps[s]) break; // next owner chokes the voice
        const r = rects.get(s);
        const tailEnd = Math.min(wave.windowEndMs, tailPos + stepMs * rate);
        if (r) {
          let g0 = tailPos;
          let g1 = tailEnd;
          if (wave.reversed) {
            g0 = wave.windowStartMs + (wave.windowEndMs - tailEnd);
            g1 = wave.windowStartMs + (wave.windowEndMs - tailPos);
          }
          drawWave(
            ctx,
            pk,
            { x: r.x + 1, y: r.y + 2, w: r.w - 2, h: r.h - 4 },
            {
              startFrac: Math.max(0, g0 / dur),
              endFrac: Math.min(1, g1 / dur),
              reversed: wave.reversed,
              color,
              gain: ownerAmp,
              ghost: true,
              presence,
            },
            style,
          );
        }
        tailPos = tailEnd;
      }
    }
  }

  // Value label (bottom-left of the owner step): the track's ACTIVE cell
  // parameter, only when off-default — matches the native per-cell label.
  // Chip form (bg + hairline) so it stays legible over waveform columns
  // (native badge parity, :10783–92). Suppressed when this owner is the
  // focused cell — the focus readout chip replaces it (one number per cell).
  let chipRightX = -Infinity;
  if (!isWrap && !suppressChip) {
    const label = cellValueLabel(t, owner);
    if (label) {
      drawChip(ctx, css, first.x + 2, first.y + first.h - 2, label, { presence });
      ctx.font = `600 9px ${css("--font-mono") || "monospace"}`;
      chipRightX = first.x + 2 + Math.ceil(ctx.measureText(label).width) + 6;
    }
  }

  // Hidden-edit dot (bottom-right): this cell carries a non-default value in a
  // lane that has no standing mark AND isn't the armed param — so the edit would
  // otherwise be invisible until you arm that lane. A 2px --text tick in the one
  // corner no other mark claims; hover/focus spells out the actual values. Skip
  // when the value chip reaches into the corner (the chip already says "data
  // here"), and on cells too small to place it clear of the gesture body.
  if (
    !isWrap &&
    first.w >= 14 &&
    first.h >= 14 &&
    cellHasHiddenData(t, owner, t.activeCellParameterName)
  ) {
    const dotX = first.x + first.w - 4;
    const dotY = first.y + first.h - 4;
    if (chipRightX + 4 <= dotX) {
      ctx.fillStyle = css("--text");
      ctx.globalAlpha = ink(FIELD.hiddenData) * presence;
      ctx.fillRect(dotX, dotY, 2, 2);
      ctx.globalAlpha = 1;
    }
  }

  // Accent: 1 (soft) or 2 (hard) short ticks at the top edge; hard adds a
  // 1-px line across the whole owner-step top edge (user CONFIRM 2026-07-12).
  const accent = t.accentLevels[owner] ?? 0;
  if (accent > 0) {
    ctx.strokeStyle = css("--text");
    if (accent >= 2) {
      ctx.globalAlpha = ink(FIELD.accentTick) * presence;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(first.x + 1, first.y + 1.5);
      ctx.lineTo(first.x + first.w - 1, first.y + 1.5);
      ctx.stroke();
    }
    ctx.globalAlpha = presence;
    ctx.lineWidth = 2;
    // Ticks centered on the top edge — the top-LEFT belongs to the step
    // number (GR-VIS follow-up: left-anchored ticks sat on the numbers).
    const ticksW = accent * 6 - 2;
    const tx = first.x + Math.max(4, Math.round((first.w - ticksW) / 2));
    for (let a = 0; a < accent; a++) {
      ctx.beginPath();
      ctx.moveTo(tx + a * 6, first.y + 2);
      ctx.lineTo(tx + 4 + a * 6, first.y + 2);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
  }

  // Reverse flip-tab (§2.5, user CONFIRM: top-right corner): a filled
  // "dog-ear" right-triangle in the owner step's top-right, hypotenuse
  // facing the cell body — reads as a folded-back corner (sample runs
  // backwards). Owner step only; the waveform itself already mirrors (XOR).
  if (!isWrap && (t.reverseSteps[owner] ?? false)) {
    const { corner } = zoneSizes(first);
    const leg = Math.min(6, corner - 2);
    const rx = first.x + first.w - 1;
    const ry = first.y + 1;
    ctx.fillStyle = css("--text");
    ctx.globalAlpha = ink(FIELD.dogEar) * presence;
    ctx.beginPath();
    ctx.moveTo(rx - leg, ry);
    ctx.lineTo(rx, ry);
    ctx.lineTo(rx, ry + leg);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  // Glide tie-hook (§2.3, NEW draw): a squared bridge at the owner step's
  // LEFT edge marking "the transition INTO this cell glides". A half-tie
  // (right hook only) when the left neighbor is a gap. glidePercent==0 =
  // armed-but-inaudible → drawn in --warn (user CONFIRM), never looks normal.
  if (!isWrap) {
    const legacyAll = t.glideSteps.length === 0 && t.glidePercent > 0;
    const glided = (t.glideSteps[owner] ?? false) || legacyAll;
    if (glided) {
      const hookW = Math.max(5, Math.min(9, Math.round(first.w * 0.22)));
      const hookH = 4;
      const xb = first.x - 1; // on the shared border (1px cell inset)
      const yTie = first.y + Math.round(first.h * 0.24);
      const leftCovered =
        owner > 0 &&
        resolveCellAt(t.steps, t.cellLengths, t.wrapSourceStep, owner - 1) !== null;
      ctx.fillStyle = t.glidePercent === 0 ? css("--warn") : css("--text");
      ctx.globalAlpha =
        ink(
          t.glidePercent === 0
            ? FIELD.glideHookZero
            : legacyAll
              ? FIELD.glideHookLegacy
              : FIELD.glideHook,
        ) * presence;
      // right hook (into this cell): horizontal + vertical drop
      ctx.fillRect(xb, yTie, hookW, 1);
      ctx.fillRect(xb + hookW - 1, yTie, 1, hookH);
      // left hook (mirror into the previous cell) — only with a real junction
      if (leftCovered) {
        ctx.fillRect(xb - hookW, yTie, hookW, 1);
        ctx.fillRect(xb - hookW, yTie, 1, hookH);
      }
      ctx.globalAlpha = 1;
    }
  }

  // Pre-silence onset hairline (§2.4): a faint vertical line at the total
  // lead-in position — the gap IS the delay, exactly as the engine fires.
  // Span-relative, so on a row-split cell it lands on the onset's OWN row
  // (on an exact row break the onset belongs to the incoming fragment).
  if (!isWrap && wave && wave.silenceFrac > 0.001) {
    const on = spanPointX(frags, wave.silenceFrac);
    if (on) {
      const { topBand } = zoneSizes(first);
      ctx.fillStyle = css("--text");
      ctx.globalAlpha = ink(FIELD.leadIn) * presence;
      ctx.fillRect(Math.round(on.x), on.fr.y + topBand, 1, on.fr.h - topBand - 1);
      ctx.globalAlpha = 1;
    }
  }
}

/**
 * Peaks are per SAMPLE × RESOLUTION, fetched once and cached — a value edit
 * never re-crosses the bridge for them (the shape is re-derived from the same
 * arrays by gridWave). Raising the style's `points` is the one thing that asks
 * for new data; Swift clamps 16…1024 and serves from its own LRU.
 */
function fetchPeaksIfNeeded(
  link: EngineLink,
  trackIndex: number,
  track: GridTrackState,
  cache: Map<string, Peaks>,
  onLoaded: () => void,
  /** Deck scope (P6-03) — peaks must come from the deck that owns the row. */
  scope: { deck?: number } = {},
  points = DEFAULT_WAVEFORM.points,
  spectrum = false,
) {
  if (!track.sampleKey) return;
  const key = peaksKey(track.sampleKey, points, spectrum);
  if (cache.has(key)) return;
  cache.set(key, { minMax: [], rms: [] }); // in-flight marker
  link
    .command("getSamplePeaks", { trackIndex, points, spectrum, ...scope })
    .then((raw) => {
      const parsed = COMMANDS.getSamplePeaks.result.parse(raw);
      if (parsed.sampleKey) {
        cache.delete(key);
        cache.set(peaksKey(parsed.sampleKey, points, spectrum), {
          minMax: parsed.minMax,
          rms: parsed.rms,
          brightness: parsed.brightness,
        });
        onLoaded();
      }
    })
    .catch(() => cache.delete(key));
}
