import { useEffect, useState } from "react";
import { Caption } from "../design/controls.tsx";

/**
 * The "waiting for engine state…" placeholder, with a DEADLINE.
 *
 * During the 2026-07-17 incident this string sat on screen for an hour and told
 * nobody anything: the bridge was up, the page was healthy, and Swift simply never
 * published the topic (the app copy was reading an empty data world). A wait state
 * that can be entered forever must eventually say WHAT it is waiting for — that
 * turns a silent mystery into a bug report that names its own suspect.
 *
 * Normal launches resolve in well under a second, so the deadline only ever shows
 * on genuinely broken runs.
 */
const DEADLINE_MS = 5000;

/** True once the panel has waited past the deadline. */
export function useStateWaitDeadline(): boolean {
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setTimedOut(true), DEADLINE_MS);
    return () => window.clearTimeout(id);
  }, []);
  return timedOut;
}

/** The message for a wait that blew the deadline, naming the missing topic(s). */
export function stateWaitMessage(topics: string[], timedOut: boolean): string {
  if (!timedOut) return "waiting for engine state…";
  return (
    `no “${topics.join("” / “")}” push after ${DEADLINE_MS / 1000}s — the page is up ` +
    "but the app never published this topic. Likely: the panel's binding never " +
    "attached, the engine did not start, or this app copy is reading an empty " +
    "data world (wrong sandbox container)."
  );
}

/** Drop-in placeholder for panels whose wait state is a bare <main>. */
export function WaitingForState({
  topics,
  className,
}: {
  topics: string[];
  className: string;
}) {
  const timedOut = useStateWaitDeadline();
  return <main className={className}>{stateWaitMessage(topics, timedOut)}</main>;
}

/** Same, as a Caption — for panels whose wait state sits under their own title. */
export function WaitingCaption({ topics }: { topics: string[] }) {
  const timedOut = useStateWaitDeadline();
  return <Caption>{stateWaitMessage(topics, timedOut)}</Caption>;
}
