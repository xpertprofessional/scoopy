/**
 * P3.5-E9a — WHY A LOADED SESSION IS SILENT, SAID OUT LOUD.
 *
 * The store has always KNOWN why a deck makes no sound. `open()` collects
 * `decodeFailures` (a kit sample whose bytes would not decode) and
 * `missingSamples` (a track naming a sampleId the kit does not carry), and
 * `publish()` no-ops entirely while the engine sink is not running. All three
 * were written into deck state and **read by exactly one surface —
 * `CompanionPanel`, the browser-only shell whose door P3-L1 deleted.** So in
 * the merged app a session could load, look completely normal, and play
 * nothing, with no report on any screen: "a loaded scoopy session makes no
 * sound" (user, real host, 2026-07-30) with nothing to distinguish a missing
 * file from a dead engine.
 *
 * This is the sentence that distinction becomes. Pure on purpose (no jsdom
 * here — P6-2b's house rule): the plane's note line and the compose window's
 * bar both render what it returns, so there is one wording and one truth.
 */

/** What `SampleStore.registerKit` reports about a kit that would not fully load. */
export interface DecodeFailure {
  name: string;
  error: string;
}

/** How many names to spell out before counting the rest — never a silent cut. */
const NAMED = 4;

function list(names: readonly string[]): string {
  if (names.length <= NAMED) return names.join(", ");
  return `${names.slice(0, NAMED).join(", ")} +${names.length - NAMED} more`;
}

/**
 * One line naming why this deck will be quiet, or `null` when nothing is wrong.
 *
 * ENGINE FIRST, and it short-circuits: while the sink is not running NOTHING
 * sounds and no kit was even registered, so reporting a sample list underneath
 * that would send a person hunting for files when the engine never started.
 *
 * `starting` reports NOTHING. The sink boots asynchronously on every surface,
 * so a status read the instant a session lands is mid-flight by definition —
 * and a warning that appears for 200 ms on every single load is how a real
 * warning gets learned as noise.
 */
export function silenceNote(
  sessionName: string,
  opts: {
    engine: "idle" | "starting" | "running" | "failed";
    decodeFailures?: readonly DecodeFailure[];
    missingSamples?: readonly string[];
    /** Track/sample names for the ids in `missingSamples`, where known. */
    missingNames?: readonly string[];
  },
): string | null {
  if (opts.engine === "starting") return null;
  if (opts.engine !== "running") {
    return `${sessionName} loaded, but the audio engine is not running — nothing will sound`;
  }
  const failures = opts.decodeFailures ?? [];
  const missing = opts.missingSamples ?? [];
  if (failures.length === 0 && missing.length === 0) return null;

  const parts: string[] = [];
  if (failures.length > 0) {
    parts.push(
      `${failures.length} sample${failures.length === 1 ? "" : "s"} did not load (${list(
        failures.map((f) => f.name),
      )})`,
    );
  }
  if (missing.length > 0) {
    const names = opts.missingNames?.length ? list(opts.missingNames) : `${missing.length}`;
    parts.push(
      `${missing.length} track${missing.length === 1 ? "" : "s"} name a sample this kit does not carry (${names})`,
    );
  }
  // The consequence, not just the count: a list of names without "silent"
  // reads as a warning about metadata rather than an explanation of silence.
  return `${sessionName}: ${parts.join(" · ")} — those tracks are silent`;
}
