/**
 * P3.5-E8g-h — APPENDING A TRACK, AND REFUSING TO.
 *
 * The user, after E8g-e made the wrong target stable: *"yes it lands on track 1,
 * however it should create a new track."* This file pins the document half —
 * that a track really is added to ALL EIGHT sections, that it is added at the
 * END, and that the ceiling refuses OUT LOUD rather than no-opping.
 *
 * **This row is a port, not a design.** The shipping app answers most of it
 * already, and the pins below cite it so a later "tidy-up" cannot quietly
 * redesign what was matched deliberately:
 *
 *   `BeatSequencer.addTrackInternal`      (../scoopyloops, :15599)
 *   `BeatSequencer.makeEmptyTrack`        (:15507)
 *   `WebFileBrowserBinding.loadBrowserSample` (:203) — "trackIndex == nil means
 *     **create a track**, which is what the native browser's double-click and
 *     `load` button both do; a value arrives only when a browser row was dropped
 *     onto an existing track row". The user's ruling and the original agree
 *     exactly; this is the same contract, in the same words.
 *
 * ⚠️ THE ONE PLACE THE ORIGINAL IS DELIBERATELY NOT FOLLOWED: it refuses at the
 * ceiling by `print`ing to the console and returning (:15609) — the schema's own
 * comment calls that out as "how you get a button that does nothing". The user
 * ruled the refusal must be spoken, so it is.
 *
 * No jsdom (the P6-2b house rule). The engine is not running, so `publish()` is
 * a no-op and the autosaver only arms a timer — nothing here touches OPFS or audio.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

vi.stubGlobal("window", {});
vi.stubGlobal("requestAnimationFrame", () => 0);
vi.stubGlobal("cancelAnimationFrame", () => {});
vi.stubGlobal("navigator", {
  storage: { getDirectory: () => Promise.reject(new Error("no OPFS here")) },
});
vi.stubGlobal("localStorage", {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});

const { MAX_TRACKS, idleDeck, useCompanion } = await import("./companionEngine.ts");
const { SECTION_KEYS } = await import("../audio/sceneProjection.ts");

type Doc = Record<string, unknown>;

/** A document with `tracks` rows in every section — the shape the sections agree on. */
function doc(tracks: number): Doc {
  const rows = () => Array.from({ length: tracks }, (_, i) => ({ id: `T${i}` }));
  const pattern: Doc = { bpm: 120 };
  for (const key of SECTION_KEYS) pattern[key] = rows();
  pattern.baseSettings = {
    trackSettings: Array.from({ length: tracks }, () => ({ colorHex: "#000000" })),
  };
  return pattern;
}

function openDoc(tracks: number, name = "My Session"): void {
  useCompanion.setState((s) => ({
    decks: s.decks.map((d, i) =>
      i === 0
        ? {
            ...d,
            session: {
              name,
              pattern: doc(tracks),
              kit: { id: "k", name: "kit", samples: [] },
              extras: new Map(),
            },
          }
        : d,
    ),
  }) as never);
}

const openSession = () => useCompanion.getState().decks[0]!.session!;
const sectionA = () => openSession().pattern.sectionA as Doc[];

beforeEach(() => {
  vi.useFakeTimers();
  useCompanion.setState({
    decks: Array.from({ length: useCompanion.getState().decks.length }, idleDeck),
    error: null,
    notice: null,
  });
});
afterEach(() => {
  vi.clearAllTimers(); // never let a scheduled autosave actually write
  vi.useRealTimers();
});

describe("the append itself", () => {
  it("adds one row at the END and returns its index", async () => {
    openDoc(8);
    const index = await useCompanion.getState().appendTrack();
    expect(index).toBe(8);
    expect(sectionA()).toHaveLength(9);
    // At the END, not inserted after the selection: the ruling, and the only
    // shape where no existing index shifts under a drag already in flight.
    expect((sectionA()[7] as { id: string }).id).toBe("T7");
  });

  it("adds it to ALL EIGHT sections, not just the visible one", async () => {
    // The `SECTION_KEYS` injury, one layer up: a hand-typed loop here once
    // stopped at F, and a track that exists in A–F renumbers when you switch to
    // scene G. The original appends one `PatternData` to all eight
    // `patternScene*Patterns` arrays for the same reason.
    openDoc(3);
    await useCompanion.getState().appendTrack();
    for (const key of SECTION_KEYS) {
      expect((openSession().pattern as Doc)[key]).toHaveLength(4);
    }
  });

  it("gives every section the SAME track id — eight views of one track", async () => {
    openDoc(2);
    await useCompanion.getState().appendTrack();
    const ids = SECTION_KEYS.map((k) => (((openSession().pattern as Doc)[k] as Doc[])[2] as { id: string }).id);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe("T0"); // a fresh UUID, not a copy of an existing row's
  });

  it("does not alias arrays between two appended tracks", async () => {
    // The template is shared and cached, so a shallow spread would let track 9's
    // `steps` BE track 10's — an edit on one silently showing up on the other.
    openDoc(1);
    await useCompanion.getState().appendTrack();
    await useCompanion.getState().appendTrack();
    const a = sectionA()[1] as { cellLengths: number[] };
    const b = sectionA()[2] as { cellLengths: number[] };
    expect(Array.isArray(a.cellLengths)).toBe(true);
    expect(a.cellLengths).not.toBe(b.cellLengths);
  });

  it("carries the fresh-session template's defaults, at UNITY gain", async () => {
    openDoc(0);
    await useCompanion.getState().appendTrack();
    const row = sectionA()[0] as Record<string, unknown>;
    // From `makeEmptyTrack`: 16 steps (templateStepCount default), volume 0.8,
    // cellLengths 1 per step. `volume` comes from the template and is unchanged.
    expect((row.steps as unknown[]).length).toBe(16);
    expect((row.cellLengths as number[]).every((n) => n === 1)).toBe(true);
    expect(row.volume).toBe(0.8);
    // `trackGain` is the ONE field where we depart from the original, so it is
    // pinned rather than left to drift back. The shipping app gives an ADDED
    // track 0.80 (BeatSequencer.swift:15576) while a fresh session's tracks sit
    // at 1.0 — the same sample is quieter depending on how its track came to
    // exist, which is an inconsistency rather than a headroom policy.
    // RULED 2026-07-30 (user): unity, and no load-time normalisation — a sample
    // plays at the level it was authored at, so a kit's balance survives.
    expect(row.trackGain).toBe(1.0);
    expect(row.sampleId ?? null).toBeNull(); // an EMPTY track — nothing is playing yet
  });

  it("cycles the eight-colour palette rather than repeating one hue", async () => {
    openDoc(0);
    const colors: string[] = [];
    for (let i = 0; i < 9; i++) {
      await useCompanion.getState().appendTrack();
      const settings = (openSession().pattern.baseSettings as { trackSettings: Doc[] }).trackSettings;
      colors.push(settings[i]!.colorHex as string);
    }
    // `palette[index % palette.count]` — BeatSequencer.swift:15515. The ninth
    // track restarts the ramp; it does not repeat the eighth.
    expect(new Set(colors.slice(0, 8)).size).toBe(8);
    expect(colors[8]).toBe(colors[0]);
  });

  it("leaves the track ROW LIST of a document it refused completely untouched", async () => {
    openDoc(MAX_TRACKS);
    const before = openSession().pattern;
    await useCompanion.getState().appendTrack();
    expect(openSession().pattern).toBe(before); // not even a new object
  });
});

describe("the refusals — spoken, never silent", () => {
  it("says so at the ceiling instead of no-opping", async () => {
    openDoc(MAX_TRACKS);
    const index = await useCompanion.getState().appendTrack();
    expect(index).toBeNull();
    expect(sectionA()).toHaveLength(MAX_TRACKS);
    // ⚠️ The original only `print`s here. The user ruled it must SAY so — this
    // codebase has shipped enough accepted-and-discarded intents (E8c's dropped
    // asStretch, the inert launchQuantize) for a silent refusal to be a defect.
    expect(useCompanion.getState().error).toContain(String(MAX_TRACKS));
    expect(useCompanion.getState().notice).toBeNull();
  });

  it("refuses one BELOW the ceiling — the boundary is >=, not >", async () => {
    openDoc(MAX_TRACKS - 1);
    expect(await useCompanion.getState().appendTrack()).toBe(MAX_TRACKS - 1);
    expect(await useCompanion.getState().appendTrack()).toBeNull();
  });

  it("says so when no session is open", async () => {
    expect(await useCompanion.getState().appendTrack()).toBeNull();
    expect(useCompanion.getState().error).toContain("session");
  });
});

describe("loading into a track that is not there", () => {
  it("refuses instead of reporting success on a row it never wrote", async () => {
    // Measured while building this row: the section loop skips every section the
    // index is past, so an out-of-range load used to fall all the way through and
    // still set `<name> → track 99`. The original answers "No such track."
    openDoc(4);
    await useCompanion.getState().loadSample(9, "/samples/kick.wav");
    expect(useCompanion.getState().error).toContain("no track 10");
    expect(useCompanion.getState().notice).toBeNull();
  });
});

describe("the ceiling is stated in two files and they must agree", () => {
  it("matches MasterRow's MAX_TRACKS", () => {
    // ⚠️ THE CEILING IS A UI CONVENTION, and until this row NOTHING enforced it:
    // MasterRow only greys the `+`, the pattern-file decoder bounds no section
    // length, and neither the WASM engine nor the world builder counts tracks.
    // The two constants cannot import one another — MasterRow is shared GridPanel
    // chrome that mounts on the native host too, where this store does not exist —
    // so the drift is CAUGHT here rather than prevented.
    const src = readFileSync(resolve(here, "../panels/MasterRow.tsx"), "utf8");
    const literal = /const MAX_TRACKS = (\d+)/.exec(src)?.[1];
    expect(literal).toBeDefined();
    expect(Number(literal)).toBe(MAX_TRACKS);
    // …and both still agree with the app being ported (BeatSequencer.swift:15491,
    // `private let maxAudioTrackCount = 16`).
    expect(MAX_TRACKS).toBe(16);
  });
});
