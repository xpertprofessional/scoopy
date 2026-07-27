/**
 * P5-06 step C — canonical serialization of the WHOLE pattern half.
 *
 * The P5-04 drift detector compared `canonicalGridSubset`: nine hand-listed cell arrays. That
 * was right when only nine reducers existed, but it means a `trackEdit` reducer could get
 * `gain` or `stepCount` wrong and the detector would report CLEAN — it never looked. The
 * evidence gate would be green about the wrong thing.
 *
 * Step B made a better comparison possible: `gridPattern/<i>` is now exactly the set of fields
 * TS can own, so comparing the ENTIRE payload is both meaningful and total. No hand-maintained
 * field list to fall out of date, and a new pattern field is covered the day it is added.
 *
 * ⚠️ THE FLOAT TRAP. Most of these are Swift `Float`. TS sends `gain: 0.3`; Swift stores
 * Float(0.3) and pushes back `0.30000001192092896`. A naive compare drifts on EVERY edit and
 * the detector becomes noise. So both sides are normalized through `Math.fround` — the nearest
 * float32, as a double. Applied to BOTH sides it cannot manufacture a difference: a value Swift
 * already stored as Float is unchanged by fround (it is already float32-exact), and a genuine
 * Double round-trips identically on both sides. The only thing it hides is a divergence smaller
 * than float32 epsilon, which cannot change what the pattern does or how it is saved.
 */
import { GRID_PATTERN_KEYS, type GridPatternState, type GridTrackState } from "../../protocol/schema";

/**
 * Project a full (merged + derived) track onto the PATTERN half.
 *
 * The reducers work on `GridTrackState` — the merged view — but only the pattern half is
 * comparable: the runtime half is Swift's and TS makes no claim about it, and the two derived
 * fields aren't on the wire at all. Comparing those would drift constantly and mean nothing.
 */
export function projectPattern(t: GridTrackState): GridPatternState {
  const out: Record<string, unknown> = {};
  for (const k of GRID_PATTERN_KEYS) out[k] = (t as Record<string, unknown>)[k];
  return out as GridPatternState;
}

/**
 * Deterministic string for a pattern payload: keys sorted, numbers normalized to float32.
 *
 * Not JSON.stringify — that preserves key insertion order (so two equal patterns could
 * serialize differently) and prints full double precision (the float trap above).
 */
export function canonicalPatternState(t: GridPatternState): string {
  return enc(t as unknown);
}

function enc(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "number") return num(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(enc).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${enc(o[k])}`).join(",")}}`;
  }
  return "null";
}

function num(v: number): string {
  if (!Number.isFinite(v)) return "null"; // NaN/±Inf can't survive JSON anyway
  // Float32-normalize, then drop -0 (Swift prints 0; JS prints -0) and trailing noise.
  const f = Math.fround(v);
  if (Object.is(f, -0)) return "0";
  return Number.isInteger(f) ? String(f) : String(f);
}

/**
 * The fields a divergence actually landed on — so a drift report says "gain" rather than
 * handing the user two 4 KB strings and asking them to spot the difference.
 */
export function patternDiffFields(a: GridPatternState, b: GridPatternState): string[] {
  const out: string[] = [];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of [...keys].sort()) {
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    if (enc(av) !== enc(bv)) out.push(k);
  }
  return out;
}
