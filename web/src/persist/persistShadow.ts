/**
 * B1-A — the PERSISTENCE SHADOW GATE (schema v73).
 *
 * Swift pushes the `persistShadow` topic `{seq, kind}` after every successful
 * desktop save. This module answers by running the step-A round-trip prover
 * (`verifyWorldRoundTrip`: getPattern → TS decode → TS re-encode → byte
 * compare — the SAME `makePatternFile()` state the save just wrote) and
 * reporting the verdict back via `persistShadowReport`. Swift accumulates the
 * pass/fail counters that the B1 writer-flip gate reads.
 *
 * Report-only by contract: a save never blocks on this, and a failure here is
 * evidence to investigate, never something to "fix up" silently.
 */
import type { EngineLink } from "../engineLink";
import { verifyWorldRoundTrip } from "./worldWire";

interface ShadowPush {
  seq: number;
  kind: string;
}

function isShadowPush(raw: unknown): raw is ShadowPush {
  return (
    typeof raw === "object" &&
    raw !== null &&
    typeof (raw as ShadowPush).seq === "number"
  );
}

/**
 * Subscribe to save notifications. Returns the unsubscribe function.
 *
 * ⚠️ `onUiState` REPLAYS the last push to a late subscriber, and the host
 * re-runs `configureLink` on deck switches — so the same `seq` can arrive
 * more than once. Deduping by seq keeps one verify per save.
 */
export function attachPersistShadow(link: EngineLink): () => void {
  let lastSeq = -1;
  let running = false;

  return link.onUiState("persistShadow", (raw) => {
    if (!isShadowPush(raw)) return;
    if (raw.seq === lastSeq || running) return;
    lastSeq = raw.seq;
    running = true;

    verifyWorldRoundTrip(link)
      .then((r) => {
        if (!r.ok) {
          console.warn(
            `[persist-shadow] save #${raw.seq} (${raw.kind}): TS re-encode DIVERGED at byte ${r.firstDiff}\n${r.detail}`,
          );
        }
        return link.command("persistShadowReport", {
          seq: raw.seq,
          ok: r.ok,
          bytes: r.bytes,
          firstDiff: r.firstDiff,
          detail: r.detail,
        });
      })
      .catch((e) => {
        console.warn(`[persist-shadow] save #${raw.seq}: verify errored: ${e}`);
        return link.command("persistShadowReport", {
          seq: raw.seq,
          ok: false,
          bytes: 0,
          firstDiff: -1,
          detail: `verify errored: ${e}`,
        });
      })
      .finally(() => {
        running = false;
      });
  });
}
