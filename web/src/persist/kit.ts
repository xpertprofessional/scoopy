/**
 * Kit model in TS (P8-0) — the session package's SAMPLE MANIFEST.
 *
 * This is the piece that was missing, and its absence is why the browser companion could not open
 * a session at ALL. `web/src/persist/` modelled `PatternFile` only — so TS could read the pattern
 * (every note, every parameter) and had no idea which audio files it referred to. A pattern
 * without its kit is not a session.
 *
 * A `.scoopySession` is a self-contained PACKAGE (PersistenceService.saveSession):
 *
 *     MySession.scoopySession/
 *       pattern.json     the PatternFile          (patternFile.ts)
 *       kit.json         THIS — the sample manifest
 *       Samples/         every sample, copied in
 *
 * The good news the ledger recorded is real: `saveSession` already copies every sample into the
 * package and REWRITES the paths relative to it (`Samples/kick.wav`), resolving them on load. So
 * the format is already portable — nothing here needs a filesystem.
 *
 * ⚠️ USES THE SAME MACHINERY AS `patternFile.ts`, deliberately: one field table drives the strict
 * zod schema, the float32 paths, float narrowing on decode and decode-only stripping. A second
 * hand-rolled codec would be free to drift from the one that is byte-proven, and the whole point
 * of this file is that the bytes match.
 *
 * ⚠️ `defaultVolume` / `defaultPan` are Swift **Float** (Kit.swift:13-14). This is the P5-06a trap
 * again and it is invisible in the JSON: a Float marked Double re-encodes 0.3 as
 * `0.3333333432674408` instead of `0.33333334` and the round-trip fails. Mark them F.
 */
import { z } from "zod";
import { encodeFoundationJSON } from "./foundationJson.ts";
import {
  F,
  S,
  arr,
  narrowFloats,
  req,
  st,
  stripForEncode,
  zodOf,
  collectPaths,
  type Spec,
} from "./patternFile.ts";

/** Kit.SampleInfo — Kit.swift:7-17, synthesized Codable. */
const SAMPLE_INFO = st({
  id: req(S), // UUID
  name: req(S),
  /**
   * RELATIVE to the package (`Samples/kick.wav`) once saved; `saveSession` rewrites it on the way
   * out and `loadSession` resolves it on the way back in (PersistenceService:76 / :210). It is an
   * absolute path only for a kit that was never packaged. The companion must never write an
   * absolute path — a browser has no such thing, and it would not resolve on the desktop either.
   */
  filePath: req(S),
  defaultVolume: req(F), // Swift Float — see the header
  defaultPan: req(F), // Swift Float
});

/** Kit — Kit.swift:6-25. */
const KIT: Spec = st({
  id: req(S), // UUID
  name: req(S),
  samples: req(arr(SAMPLE_INFO)),
});

const FLOAT32 = new Set<string>();
const DICTS = new Set<string>();
collectPaths(KIT, "", FLOAT32, DICTS);

export const KIT_FLOAT32_PATHS: ReadonlySet<string> = FLOAT32;
export const KitSchema = zodOf(KIT) as z.ZodType<KitJson>;
export type KitJson = Record<string, unknown>;

/** One entry of the sample manifest, typed for callers that walk it. */
export interface KitSample {
  id: string;
  name: string;
  filePath: string;
  defaultVolume: number;
  defaultPan: number;
}

/**
 * Decode a `kit.json`. STRICT — an unmodeled key throws rather than being silently dropped,
 * which is the same contract `PatternFile` has and for the same reason: this file gets RE-SAVED,
 * and a key we quietly ignored on the way in is a key we quietly delete on the way out.
 */
export function decodeKit(text: string): KitJson {
  return narrowFloats(KitSchema.parse(JSON.parse(text)), KIT) as KitJson;
}

/** Re-encode exactly as `PersistenceService.saveSession` now does (canonical, P8-0). */
export function encodeKit(kit: KitJson): string {
  return encodeFoundationJSON(stripForEncode(kit, KIT), { float32Paths: KIT_FLOAT32_PATHS });
}

/** The manifest, as a list — what a sample store (OPFS, P8-6) actually needs. */
export function kitSamples(kit: KitJson): KitSample[] {
  return (kit.samples as KitSample[]) ?? [];
}
