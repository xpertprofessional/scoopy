/**
 * The grid projection, against the REAL Swift-written session.
 *
 * Two properties, and between them they cover all 78 fields without anyone maintaining a list:
 *
 *   1. READ COVERAGE IS FREE. `GridPatternState` is a strict zod object, so if `toGridPattern`
 *      forgets a field, `parse()` throws and names it. No allowlist, nothing to remember.
 *
 *   2. WRITE COVERAGE IS A ROUND TRIP. doc → grid → doc → grid must be identical. A field the writer
 *      drops changes on the second pass and the diff says which one. This is the abi-coverage idea
 *      again, in the one place it can be had for nothing.
 *
 * The point of (2) is not academic. A field the writer silently drops is an edit the user makes,
 * sees on screen, and loses the moment the session saves — which is the single worst failure a
 * companion can have, and the one thing `preserve-don't-drop` exists to prevent.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { GridPatternState } from "../../protocol/schema.ts";
import { decodePatternFileAnyVersion } from "../persist/migrations.ts";
import type { PatternFileJson } from "../persist/patternFile.ts";
import { applyGridPattern, docRows, toGridPattern, toGridRuntime, type DocRow } from "./gridProjection.ts";

const FIXTURE = fileURLToPath(
  new URL("../../fixtures/session/session-pattern.json", import.meta.url),
);

let pattern: PatternFileJson;
let rows: DocRow[];

beforeAll(async () => {
  pattern = decodePatternFileAnyVersion(await readFile(FIXTURE, "utf8"));
  rows = docRows(pattern);
});

describe("toGridPattern (read)", () => {
  it("produces a state the STRICT schema accepts — which is the read-coverage check", () => {
    // If a field is missing, this throws and names it. That is the whole coverage story for the
    // read side: no list to maintain, no way to forget.
    for (const row of rows) {
      expect(() => GridPatternState.parse(toGridPattern(row))).not.toThrow();
    }
  });

  it("assembles the track from BOTH document arrays", () => {
    // colorHex lives ONLY in baseSettings.trackSettings[i]; steps live ONLY in sectionA[i]. A
    // projection that read one array would silently default the other half — and `pattern
    // .trackSettings` does not exist at all, so getting it wrong looks like an empty settings row.
    const grid = toGridPattern(rows[0]!);
    expect(grid.colorHex).toBe(rows[0]!.settings.colorHex);
    expect(grid.steps).toEqual(rows[0]!.track.steps);
    expect(grid.stepCount).toBe((rows[0]!.track.steps as boolean[]).length);
  });

  it("DERIVES what the document does not store", () => {
    const row: DocRow = {
      track: {
        ...rows[0]!.track,
        playbackMode: 0, // regular
        stretchEnabled: true,
        loopEnabled: true,
        isStretchByLength: false,
        rhythmicOffsetSteps: [0, 1, 4],
        trackGain: undefined, // absent → gain must read 1, not 0
      },
      settings: rows[0]!.settings,
    };
    const grid = toGridPattern(row);

    expect(grid.playbackMode).toBe("regular");
    expect(grid.stretchToCell).toBe(true); // regular + stretchEnabled
    expect(grid.loopEnabled).toBe(true); // regular + loopEnabled
    expect(grid.rhythmicOffsetRatios).toEqual([0, 0.25, 1 / 3]); // enum → fraction
    expect(grid.gain).toBe(1); // a missing trackGain is unity, not silence
  });

  it("ships patternStartStep 0 as null — 'no custom start', not 'starts at 0'", () => {
    const grid = toGridPattern({
      track: { ...rows[0]!.track, patternStartStep: 0 },
      settings: rows[0]!.settings,
    });
    expect(grid.patternStartStep).toBeNull();
  });
});

describe("applyGridPattern (write) — the round trip IS the coverage check", () => {
  it("doc → grid → doc → grid is IDENTICAL, for every track in a real session", () => {
    for (const [i, row] of rows.entries()) {
      const once = toGridPattern(row);
      const twice = toGridPattern(applyGridPattern(once, row));
      // A field the writer drops reverts to the document's value on the second read, so it differs
      // here — and the failure names it.
      expect(twice, `track ${i} lost a field on write-back`).toEqual(once);
    }
  });

  it("an EDIT survives the write-back", () => {
    const row = rows[0]!;
    const grid = toGridPattern(row);

    const edited: GridPatternState = {
      ...grid,
      steps: grid.steps.map((_, i) => i % 4 === 0),
      volume: 0.42,
      tone: -33,
      toneFilterMode: "bandPass",
      swing: 0.3,
      chokeGroup: 2,
      accentLevels: grid.accentLevels.map((_, i) => (i === 0 ? 2 : 0)),
      colorHex: "#ff0066",
    };

    const back = toGridPattern(applyGridPattern(edited, row));
    expect(back.steps).toEqual(edited.steps);
    expect(back.volume).toBe(0.42);
    expect(back.tone).toBe(-33);
    expect(back.toneFilterMode).toBe("bandPass");
    expect(back.swing).toBe(0.3);
    expect(back.chokeGroup).toBe(2);
    expect(back.accentLevels[0]).toBe(2);
    expect(back.colorHex).toBe("#ff0066"); // …and it landed in trackSettings, not the track
  });

  it("a SPARSE per-step array writes back DENSE — holes become the neutral, never null", () => {
    // The grid reducers assign by index into a slice (`flamCounts[8] = 2`), and several
    // per-step arrays start [] in a fresh session — so the runtime state can be sparse.
    // JSON.stringify spells holes as null and the strict decoder then refuses the whole
    // session on reopen (the 2026-07-29 real-host find). The document seam must densify.
    const row = rows[0]!;
    const grid = toGridPattern(row);

    const sparseFlams: number[] = [];
    sparseFlams[8] = 2; // one flam click on step 9 of a track whose flamCounts was []
    const sparseSteps: boolean[] = [];
    sparseSteps[3] = true;

    const out = applyGridPattern({ ...grid, flamCounts: sparseFlams, steps: sparseSteps }, row);

    const flams = out.track.flamCounts as number[];
    expect(flams).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 2]);
    expect(out.track.steps).toEqual([false, false, false, true]);
    // The property the session file actually needs: no nulls after JSON round-trip.
    expect(JSON.parse(JSON.stringify(flams))).not.toContain(null);
  });

  it("INVERTS the derived fields instead of writing them blindly", () => {
    const row = rows[0]!;
    const grid = toGridPattern(row);

    // stretchToCell means different things per mode: in `regular` it is the stretch FLAG; in the
    // dedicated `stretch` mode it is the mode itself. Writing it into one field regardless would
    // silently change the playback mode.
    const asRegular = applyGridPattern(
      { ...grid, playbackMode: "regular", stretchToCell: true, loopEnabled: true },
      row,
    );
    expect(asRegular.track.stretchEnabled).toBe(true);
    expect(asRegular.track.isStretchByLength).toBe(false);
    expect(asRegular.track.loopEnabled).toBe(true);
    expect(asRegular.track.playbackMode).toBe(0);

    const asStretch = applyGridPattern(
      { ...grid, playbackMode: "stretch", stretchToCell: true, loopEnabled: true },
      row,
    );
    expect(asStretch.track.isStretchByLength).toBe(true);
    expect(asStretch.track.stretchEnabled).toBe(false);
    expect(asStretch.track.loopEnabled).toBe(false); // loop is not a thing in stretch mode
    expect(asStretch.track.playbackMode).toBe(1);
  });

  it("does not mutate the caller's document", () => {
    const row = rows[0]!;
    const before = JSON.stringify(row.track);
    applyGridPattern({ ...toGridPattern(row), volume: 0.1 }, row);
    expect(JSON.stringify(row.track)).toBe(before);
  });
});

describe("toGridRuntime", () => {
  it("is the half the document cannot know", () => {
    const runtime = toGridRuntime({
      name: "blip",
      sampleKey: "abc",
      sampleDurationMs: 400,
      samplePeakGain: 0.8,
    });
    expect(runtime.name).toBe("blip");
    expect(runtime.sampleDurationMs).toBe(400);
    // The companion has no clip-launch surface, so nothing is ever scheduled.
    expect(runtime.launchScheduled).toBe(false);
  });
});
