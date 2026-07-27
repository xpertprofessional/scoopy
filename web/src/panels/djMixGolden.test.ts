import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonNum,
  canonicalCrossfade,
  canonicalTempo,
  crossfadeGainLaw,
  djSyncLaw,
  runCrossfadeFixture,
  type CarveEntry,
  type CrossfadeFixtureInput,
  type DJSyncInput,
} from "./djMix.ts";

/**
 * P6-01 golden-fixture harness, TS half (djmode.md §6). The SAME fixture file
 * (web/fixtures/dj-mix.json) is executed by DJMixGoldenTests.swift through the
 * real NativeDJCoordinator laws + BeatSequencer.applyDJMasterSync, and here
 * through the djMix.ts mirrors; both canonicalize and byte-compare against the
 * checked-in `expected`. Divergence on either side = drift caught before it is
 * audible on stage.
 */

interface CrossfadeFixture {
  name: string;
  description: string;
  input: CrossfadeFixtureInput;
  expected: { gains: number[]; carve: CarveEntry[] };
}

interface TempoFixture {
  name: string;
  description: string;
  input: DJSyncInput;
  expected: {
    syncRatio: number;
    syncedBpm: number | null;
    busRatio: number;
    deckVarispeed: number;
    deckMasterSpeed: number;
  };
}

const file: { crossfade: CrossfadeFixture[]; tempo: TempoFixture[] } = JSON.parse(
  readFileSync(new URL("../../fixtures/dj-mix.json", import.meta.url), "utf8"),
);

describe("dj-mix golden fixtures (P6-01)", () => {
  it("has both fixture families", () => {
    expect(file.crossfade.length).toBeGreaterThan(0);
    expect(file.tempo.length).toBeGreaterThan(0);
  });

  for (const f of file.crossfade) {
    it(`crossfade: ${f.name}`, () => {
      const got = canonicalCrossfade(runCrossfadeFixture(f.input));
      const want = canonicalCrossfade({ gains: f.expected.gains, carve: f.expected.carve });
      expect(got, f.description).toBe(want);
    });
  }

  for (const f of file.tempo) {
    it(`tempo: ${f.name}`, () => {
      const got = canonicalTempo(djSyncLaw(f.input));
      const want = canonicalTempo({
        syncRatio: f.expected.syncRatio,
        syncedBpm: f.expected.syncedBpm,
        busRatio: f.expected.busRatio,
        deckVarispeed: f.expected.deckVarispeed,
        deckMasterSpeed: f.expected.deckMasterSpeed,
      });
      expect(got, f.description).toBe(want);
    });
  }
});

describe("dj-mix invariants", () => {
  it("classic curve is constant-power: gainA² + gainB² = vol² across the travel", () => {
    for (const pos of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const a = crossfadeGainLaw("a", true, pos, 1, false);
      const b = crossfadeGainLaw("b", true, pos, 1, false);
      expect(a * a + b * b).toBeCloseTo(1, 6);
    }
  });

  it("canonNum stays out of exponent notation in the freeze/tape-stop zone", () => {
    expect(canonNum(8e-6)).toBe("0.000008");
    expect(canonNum(127999.99392)).toBe("127999.99392");
    expect(canonNum(-0)).toBe("0");
    expect(canonNum(1)).toBe("1");
  });
});
