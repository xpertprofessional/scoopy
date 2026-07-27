import { create } from "zustand";
import type { GridTrackState } from "../../protocol/schema.ts";
import {
  BOOKKEEPING_GRID_OPS,
  VERIFIABLE_GRID_OPS,
  applyGridOp,
  type GridOp,
} from "../panels/gridOps.ts";
import {
  canonicalPatternState,
  patternDiffFields,
  projectPattern,
} from "../panels/patternCanonical.ts";
import { VERIFIABLE_TRACK_OPS, applyTrackOp, type TrackOp } from "../panels/trackOps.ts";

/**
 * P5-04 shadow PatternStore. The store OWNS NOTHING yet (Domain Ownership:
 * patterns stay Swift until THE FLIP, P5-06) — it runs the fixture-verified
 * TS reducers (gridOps.ts, byte-compared against the Swift mutators by the
 * P5-03 golden harness) in parallel with every gridEdit the web sends, and
 * the DRIFT DETECTOR compares its prediction against the authoritative
 * grid/<i> push once the track goes quiet. Zero steady-state drift across
 * real sessions is the evidence gate P5-06 needs.
 *
 * Comparison protocol (pushes are dirty-diffed, not periodic):
 * - local verifiable op → prediction chain advances (predicted = reducer(prev))
 * - local unmodeled op (adjustParameter/paintCell/pasteCells — values are
 *   computed Swift-side) or any trackEdit → the chain is poisoned; the next
 *   settle ADOPTS without comparing
 * - authoritative push while EDITING (op < SETTLE_MS ago) → stashed, not
 *   adopted (the chain must stay initial+ops, exactly the harness model)
 * - SETTLE_MS of quiet → compare predicted vs the last stashed push
 *   (byte-canonical, per-step subset only), count verified/drift, adopt.
 */

export const SETTLE_MS = 300;

interface TrackShadow {
  predicted: GridTrackState | null;
  pendingAuthoritative: GridTrackState | null;
  lastOpAt: number;
  dirty: boolean;
  verifiable: boolean;
  /** Distinct reducers applied since the last settle — credited on verify. */
  opsSinceSettle: Set<string>;
}

export interface DriftRecord {
  trackIndex: number;
  at: number;
  predicted: string;
  authoritative: string;
  /** The pattern fields that actually diverged — the diagnosis, not the haystack. */
  fields: string[];
  /** The ops applied since the last settle — what was being done when it broke. */
  ops: string[];
}

interface PatternStoreState {
  verifiedCount: number;
  driftCount: number;
  lastDrift: DriftRecord | null;
  /**
   * Verifications per REDUCER (op name → count). The bare total is not the
   * evidence the flip needs: 500 verified `toggleStep`s say nothing about
   * `setCellLength`, and the wrap/length reducers are exactly where the P5-03
   * golden harness already caught two real bugs. The gate is COVERAGE — every
   * verifiable reducer exercised — not a big number on the easiest one.
   */
  verifiedByOp: Record<string, number>;
}

/**
 * The evidence gate is CUMULATIVE across sessions, so the counters must outlive
 * a page reload — the store's own state is module-scoped and dies with the web
 * view. A drift seen once and lost to a reload is exactly the failure this
 * persistence prevents (it happened: user saw a badge once, could never find it
 * again, and the console diff was gone with it).
 */
/**
 * ⚠️ v1 → v2 (P5-06 step C): the KEY IS BUMPED ON PURPOSE, so the old counts are discarded.
 *
 * The comparison changed from nine cell arrays to the WHOLE pattern half. Every count earned
 * under v1 — including the user's 9/9 zero-drift pass — was earned against a weaker test: it
 * proved the reducers got `steps`/`cellLengths`/accents right and said NOTHING about whether
 * they also left `gain`, `stepCount` or `chopPoints` alone. Carrying those counts forward would
 * let them masquerade as evidence for a property they were never tested against, and the flip's
 * gate would read green on the strength of a check that never ran.
 *
 * Evidence does not survive a change to what it is evidence OF. It has to be re-earned.
 */
const PERSIST_KEY = "sl.shadowEvidence.v2";

function loadEvidence(): PatternStoreState {
  const empty = { verifiedCount: 0, driftCount: 0, lastDrift: null, verifiedByOp: {} };
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<PatternStoreState>;
    return {
      verifiedCount: p.verifiedCount ?? 0,
      driftCount: p.driftCount ?? 0,
      lastDrift: p.lastDrift ?? null,
      verifiedByOp: p.verifiedByOp ?? {},
    };
  } catch {
    return empty; // never let a bad cache break the grid
  }
}

function saveEvidence(s: PatternStoreState) {
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(s));
  } catch {
    /* quota/private mode — evidence degrades to in-session, grid still works */
  }
}

/** Reactive counters only (UI badge); shadows live module-side to avoid
 *  re-render churn on every pointer-move op. */
export const usePatternStore = create<PatternStoreState>(() => loadEvidence());

usePatternStore.subscribe(saveEvidence);

/** Clear the accumulated evidence (the badge's reset action). */
export function resetShadowEvidence() {
  usePatternStore.setState({
    verifiedCount: 0,
    driftCount: 0,
    lastDrift: null,
    verifiedByOp: {},
  });
}

/**
 * Reducer-coverage readout for the flip's evidence gate: which verifiable
 * reducers have actually been exercised, and which have never run. The gate is
 * `missing.length === 0 && driftCount === 0` — a large `verifiedCount` on one
 * reducer proves nothing about the other eight.
 *
 * Since step C it spans BOTH families — the 9 `gridEdit` cell reducers and the 45 modeled
 * `trackEdit` ops. Before that it counted only the 9, which is why "9/9 clean" read as proof of
 * the write path when it covered nine of ~85 ops and nothing a track-row control did.
 *
 * ⚠️ STILL NOT COVERED, by construction: the impure ops (loadSample, loadInstrument…), the
 * selection-scoped ones, and the ones whose fields are not on the pattern wire. Those poison the
 * chain rather than being counted, and the GOLDEN harness — not this — is what verifies the two
 * with hidden restore buffers (setStepCount, cyclePlaybackMode). Neither tool alone covers the
 * write path; that is the whole lesson of step C.
 */
export function shadowCoverage(verifiedByOp: Record<string, number>): {
  covered: string[];
  missing: string[];
} {
  const all = [...VERIFIABLE_GRID_OPS, ...VERIFIABLE_TRACK_OPS].sort();
  return {
    covered: all.filter((op) => (verifiedByOp[op] ?? 0) > 0),
    missing: all.filter((op) => (verifiedByOp[op] ?? 0) === 0),
  };
}

const shadows = new Map<number, TrackShadow>();
const settleTimers = new Map<number, ReturnType<typeof setTimeout>>();

function shadow(trackIndex: number): TrackShadow {
  let s = shadows.get(trackIndex);
  if (!s) {
    s = {
      predicted: null,
      pendingAuthoritative: null,
      lastOpAt: 0,
      dirty: false,
      verifiable: true,
      opsSinceSettle: new Set(),
    };
    shadows.set(trackIndex, s);
  }
  return s;
}

function scheduleSettle(trackIndex: number) {
  clearTimeout(settleTimers.get(trackIndex));
  settleTimers.set(
    trackIndex,
    setTimeout(() => settle(trackIndex), SETTLE_MS),
  );
}

function settle(trackIndex: number) {
  const s = shadows.get(trackIndex);
  if (!s || !s.dirty) return;
  const auth = s.pendingAuthoritative;
  if (auth) {
    if (s.verifiable && s.predicted) {
      // P5-06 step C: compare the WHOLE pattern half, not the nine cell arrays.
      //
      // The old comparison (canonicalGridSubset) looked at steps/cellLengths/accents/… and
      // NOTHING else — so a reducer that also corrupted `gain`, `stepCount` or `chopPoints`
      // was reported CLEAN. The gate was green about the wrong thing. Step B is what made the
      // better comparison possible: `gridPattern` is exactly the set of fields TS can own, so
      // comparing all of it is both meaningful and total, and a field added tomorrow is
      // covered without anyone remembering to list it.
      const predicted = canonicalPatternState(projectPattern(s.predicted));
      const authoritative = canonicalPatternState(projectPattern(auth));
      if (predicted === authoritative) {
        const ops = [...s.opsSinceSettle];
        usePatternStore.setState((st) => {
          const verifiedByOp = { ...st.verifiedByOp };
          for (const op of ops) verifiedByOp[op] = (verifiedByOp[op] ?? 0) + 1;
          return { verifiedCount: st.verifiedCount + 1, verifiedByOp };
        });
      } else {
        // NAME the fields. The old report handed over two canonical strings and left you to
        // spot the difference by eye — and now that the comparison covers ~80 fields instead
        // of 9, that would be unreadable. The field list IS the diagnosis.
        const fields = patternDiffFields(projectPattern(s.predicted), projectPattern(auth));
        const rec: DriftRecord = {
          trackIndex,
          at: Date.now(),
          predicted,
          authoritative,
          fields,
          ops: [...s.opsSinceSettle],
        };
        console.warn(
          `[patternStore] SHADOW DRIFT on track ${trackIndex} — fields: ${fields.join(", ")} (after ops: ${rec.ops.join(", ")})`,
          rec,
        );
        usePatternStore.setState((st) => ({ driftCount: st.driftCount + 1, lastDrift: rec }));
      }
    }
    s.predicted = auth;
    s.pendingAuthoritative = null;
  }
  s.dirty = false;
  s.verifiable = true;
  s.opsSinceSettle.clear();
}

// ---------------------------------------------------------------------------
// Shadow COW undo (the "+ undo" half of P5-04). The reducers are immutable
// (slice/spread copy-on-write), so a snapshot is a reference-hold — zero
// copying. Mirrors Swift's model: beginUndo pushes ONE snapshot per gesture
// bracket. Until THE FLIP (P5-06) undo AUTHORITY stays with Swift — this
// stack shadows the mechanics so the flip swaps owners, not machinery.
// ---------------------------------------------------------------------------

const undoStacks = new Map<number, GridTrackState[]>();
const inBracket = new Set<number>();
const MAX_SHADOW_UNDO = 128;

export function shadowUndoDepth(trackIndex: number): number {
  return undoStacks.get(trackIndex)?.length ?? 0;
}

/** Pop the last gesture snapshot (shadow-only — becomes the real undo at
 *  the flip). Returns null when the stack is empty. */
export function shadowUndoPop(trackIndex: number): GridTrackState | null {
  const stack = undoStacks.get(trackIndex);
  const snap = stack?.pop() ?? null;
  if (snap) {
    const s = shadow(trackIndex);
    s.predicted = snap;
    s.verifiable = false; // Swift's own undo will push the real state
  }
  return snap;
}

/** Mirror a gridEdit the web just sent into the prediction chain. */
export function shadowLocalOp(trackIndex: number, op: GridOp) {
  if (BOOKKEEPING_GRID_OPS.has(op.op)) {
    // COW snapshot per gesture bracket (one per beginUndo, like Swift's
    // beginUndoActivity → pushUndoSnapshot).
    if (op.op === "beginUndo" && !inBracket.has(trackIndex)) {
      inBracket.add(trackIndex);
      const s = shadow(trackIndex);
      if (s.predicted) {
        const stack = undoStacks.get(trackIndex) ?? [];
        stack.push(s.predicted);
        if (stack.length > MAX_SHADOW_UNDO) stack.shift();
        undoStacks.set(trackIndex, stack);
      }
    } else if (op.op === "endUndo") {
      inBracket.delete(trackIndex);
    }
    return;
  }
  const s = shadow(trackIndex);
  s.lastOpAt = Date.now();
  s.dirty = true;
  if (s.predicted === null || !VERIFIABLE_GRID_OPS.has(op.op)) {
    s.verifiable = false; // no baseline yet, or value computed Swift-side
  } else if (s.verifiable) {
    s.predicted = applyGridOp(s.predicted, op);
    s.opsSinceSettle.add(op.op); // credited to coverage only if this settle verifies
  }
  scheduleSettle(trackIndex);
}

/**
 * Mirror a MODELED trackEdit into the prediction chain (P5-06 step C).
 *
 * Until step C every trackEdit poisoned the chain, so the flip's evidence gate said nothing
 * about anything a track-row control did — "9/9 clean" covered nine CELL reducers and none of
 * the ~69 track ops. 45 of them are modeled now and golden-verified against the real Swift
 * mutators, so they advance the chain instead of killing it.
 */
export function shadowTrackOp(trackIndex: number, op: TrackOp) {
  const s = shadow(trackIndex);
  s.lastOpAt = Date.now();
  s.dirty = true;
  if (s.predicted === null || !VERIFIABLE_TRACK_OPS.has(op.op)) {
    s.verifiable = false;
  } else if (s.verifiable) {
    s.predicted = applyTrackOp(s.predicted, op);
    s.opsSinceSettle.add(op.op);
  }
  scheduleSettle(trackIndex);
}

/** An UNMODELED trackEdit — impure (loadSample, loadInstrument), selection-scoped (it touches
 *  tracks this per-track chain does not model), or writing fields that are not on the pattern
 *  wire. Poison the chain: silently adopting the result would credit a verification TS never
 *  made, and the gate would climb toward green on work it never checked. */
export function shadowUnmodeledEdit(trackIndex: number) {
  const s = shadow(trackIndex);
  s.lastOpAt = Date.now();
  s.dirty = true;
  s.verifiable = false;
  scheduleSettle(trackIndex);
}

/** Feed every authoritative grid/<i> push. While editing it is stashed;
 *  when clean it adopts immediately (external/native edits, initial load). */
export function shadowAuthoritative(trackIndex: number, state: GridTrackState) {
  const s = shadow(trackIndex);
  if (!s.dirty) {
    s.predicted = state;
    s.pendingAuthoritative = null;
    return;
  }
  s.pendingAuthoritative = state;
  // The settle timer from the op keeps running; a push does not extend it.
}

/** Test/reset hook (panel unmount, session switch). */
export function resetShadows() {
  shadows.clear();
  undoStacks.clear();
  inBracket.clear();
  for (const t of settleTimers.values()) clearTimeout(t);
  settleTimers.clear();
  resetShadowEvidence();
}
