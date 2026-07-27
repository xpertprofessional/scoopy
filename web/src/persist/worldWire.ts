/**
 * THE WORLD WIRE (TS side) — migration P5-06 step A.
 *
 * Step A is a PIPE, not an ownership change. Swift still owns the pattern document,
 * still saves it, still owns undo. What this module adds is the ability to move a whole
 * PatternFile across the link in both directions — and, crucially, to *prove* that the
 * pipe is lossless before anything is allowed to depend on it.
 *
 * The proof is `verifyWorldRoundTrip`, and it is deliberately READ-ONLY: it asks Swift
 * for the live pattern, runs those bytes through the TS model, re-encodes, and compares.
 * If TS can reproduce Swift's own bytes for a pattern the user is actually working on —
 * not a fixture — then the model is faithful to the live document and step D can later
 * hand it the pen. Nothing is written, so this is safe to run at any time, with the
 * ownership flag off.
 *
 * @see MIGRATION.md § P5-06 (the flip, and why it was decomposed)
 * @see ./patternFile.ts — the model; ./foundationJson.ts — the byte-exact encoder
 */
import { COMMANDS } from "../../protocol/schema";
import type { EngineLink } from "../engineLink";
import { encodePatternFile, type PatternFileJson } from "./patternFile";
import { decodePatternFileAnyVersion } from "./migrations";

/** Ask Swift for the live pattern, in the canonical byte form the TS model is pinned to. */
export async function fetchPatternJson(link: EngineLink, deck?: number): Promise<string> {
  const raw = await link.command("getPattern", deck === undefined ? {} : { deck });
  return COMMANDS.getPattern.result.parse(raw).json;
}

/**
 * Push a full pattern back into the engine.
 *
 * ⚠️ Refused by Swift unless `web.owner.patterns` is on (View menu). That is not a bug to
 * work around: this call replaces the ENTIRE document, so while Swift is still the owner
 * it must be inert. A refusal comes back as `{applied: false, error}` — surfaced, never
 * swallowed, because a silent no-op is indistinguishable from a dead wire.
 */
export async function publishWorld(
  link: EngineLink,
  file: PatternFileJson,
  deck?: number,
): Promise<{ applied: boolean; error: string | null }> {
  const raw = await link.command("worldPublish", {
    json: encodePatternFile(file),
    ...(deck === undefined ? {} : { deck }),
  });
  return COMMANDS.worldPublish.result.parse(raw);
}

export interface RoundTripResult {
  /** True only if TS re-encoded Swift's live pattern to the identical byte string. */
  ok: boolean;
  /** Byte length of the pattern Swift produced. */
  bytes: number;
  /** Character offset of the first divergence, or -1 when clean. */
  firstDiff: number;
  /** A readable window around the divergence — empty when clean. */
  detail: string;
}

/**
 * THE STEP-A GATE. Read-only, safe to run any time, ownership flag irrelevant.
 *
 * Swift's live pattern → TS decode (incl. legacy migration) → TS re-encode → byte compare.
 * `ok` means the TS model is a faithful mirror of the document the user is editing *right
 * now*. Anything else means the model has a gap, and that gap must be closed before TS is
 * allowed anywhere near the pen — which is exactly the assurance the fixtures alone cannot
 * give, since fixtures only prove the sessions someone thought to capture.
 */
export async function verifyWorldRoundTrip(
  link: EngineLink,
  deck?: number,
): Promise<RoundTripResult> {
  const original = await fetchPatternJson(link, deck);
  const reencoded = encodePatternFile(decodePatternFileAnyVersion(original));

  if (reencoded === original) {
    return { ok: true, bytes: original.length, firstDiff: -1, detail: "" };
  }

  let i = 0;
  while (i < original.length && i < reencoded.length && original[i] === reencoded[i]) i++;
  const from = Math.max(0, i - 60);
  return {
    ok: false,
    bytes: original.length,
    firstDiff: i,
    detail:
      `swift: …${original.slice(from, i + 60)}\n` +
      `  ts : …${reencoded.slice(from, i + 60)}`,
  };
}
