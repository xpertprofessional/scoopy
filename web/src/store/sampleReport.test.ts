/**
 * P3.5-E9a — the silence explains itself, and says the RIGHT thing.
 *
 * The defect this closes is not a wrong message, it is NO message: three
 * causes of a silent deck were collected by the store and rendered only by the
 * browser-only companion panel P3-L1 deleted. So these pin the wording rules
 * that make the report worth having — engine before samples, nothing while the
 * engine is still starting, and never a silent truncation of the list.
 */
import { describe, expect, it } from "vitest";

import { silenceNote } from "./sampleReport.ts";

describe("silenceNote", () => {
  it("says nothing when a session loads clean on a running engine", () => {
    expect(
      silenceNote("Beach", { engine: "running", decodeFailures: [], missingSamples: [] }),
    ).toBeNull();
  });

  it("names a dead engine FIRST — a sample list under it sends you hunting files", () => {
    const note = silenceNote("Beach", {
      engine: "failed",
      decodeFailures: [{ name: "kick", error: "boom" }],
      missingSamples: ["id-1"],
    });
    expect(note).toContain("engine is not running");
    expect(note).not.toContain("kick"); // the samples are not the story yet
  });

  it("stays SILENT while the engine is still starting", () => {
    // Every surface boots its sink asynchronously, so a status read the instant
    // a session lands is mid-flight; a warning that flashes on every load is
    // how a real warning gets learned as noise.
    expect(silenceNote("Beach", { engine: "starting" })).toBeNull();
    expect(
      silenceNote("Beach", { engine: "starting", decodeFailures: [{ name: "k", error: "e" }] }),
    ).toBeNull();
  });

  it("names the samples that would not decode, and says they are silent", () => {
    const note = silenceNote("Beach", {
      engine: "running",
      decodeFailures: [
        { name: "kick", error: "not audio" },
        { name: "snare", error: "not audio" },
      ],
    });
    expect(note).toContain("2 samples did not load");
    expect(note).toContain("kick, snare");
    expect(note).toContain("silent");
  });

  it("counts what it does not name — no silent truncation", () => {
    const note = silenceNote("Beach", {
      engine: "running",
      decodeFailures: ["a", "b", "c", "d", "e", "f"].map((name) => ({ name, error: "x" })),
    });
    expect(note).toContain("a, b, c, d +2 more");
  });

  it("reports the OTHER shape too — a track naming a sample the kit does not carry", () => {
    const note = silenceNote("Beach", {
      engine: "running",
      missingSamples: ["11111111-0000-0000-0000-000000000000"],
    });
    expect(note).toContain("1 track name");
    expect(note).toContain("silent");
  });

  it("reports both causes in one line when both are true", () => {
    const note = silenceNote("Beach", {
      engine: "running",
      decodeFailures: [{ name: "kick", error: "x" }],
      missingSamples: ["id-1", "id-2"],
      missingNames: ["Track 3", "Track 7"],
    });
    expect(note).toContain("1 sample did not load");
    expect(note).toContain("2 tracks name a sample");
    expect(note).toContain("Track 3, Track 7");
  });

  it("carries the session's name — a plane with several strips needs to know WHICH", () => {
    expect(
      silenceNote("Beach", { engine: "running", decodeFailures: [{ name: "k", error: "x" }] }),
    ).toMatch(/^Beach:/);
  });
});
