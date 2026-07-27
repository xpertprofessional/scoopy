import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DICT_PATHS,
  FLOAT32_PATHS,
  PatternFileSchema,
  decodePatternFile,
  encodePatternFile,
} from "./patternFile.ts";

/**
 * P5-06b — THE FLIP's persistence gate, full-format edition.
 *
 * The corpus in web/fixtures/patternfile/ is written by the REAL Swift save
 * path (ScoopyLoopsTests/PatternFileGoldenTests.swift → BeatSequencer
 * .savePattern → the production `[.prettyPrinted, .sortedKeys]` encoder).
 * Decoding each session with the TS model and re-encoding must reproduce the
 * bytes exactly — that proves no key, no value, and no numeric precision is
 * lost in the ownership transfer.
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/patternfile");

function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
}

describe("PatternFile corpus — decode → re-encode is byte-identical", () => {
  it("has a generated corpus (run PatternFileGoldenTests to build it)", () => {
    expect(fixtureNames().length).toBeGreaterThan(0);
  });

  it("round-trips every fixture byte-for-byte", () => {
    for (const name of fixtureNames()) {
      const text = readFileSync(join(FIXTURES_DIR, name), "utf8");
      const decoded = decodePatternFile(text);
      const reencoded = encodePatternFile(decoded);
      expect(reencoded, name).toBe(text);
    }
  });
});

describe("decode-only asymmetry — legacy keys parse but never re-encode", () => {
  // A minimal synthetic PatternFile: only what this test needs, wrapped in a
  // schema-bypassing strip/encode call (the real corpus never carries legacy
  // keys, so this path needs synthetic input).
  it("strips top-level legacy keys exactly like a Swift re-save", () => {
    const base = {
      schemaVersion: 26,
      bpm: 120,
      settingsSceneA: { bpm: 120 }, // decode-only (schema ≤23)
      patternToSettingsMapping: { A: "sceneA" }, // decode-only
      return1GateSceneA: { gateEnabled: false, gateStepCount: 16, gateSteps: [], gateMode: 1 },
    };
    const out = encodePatternFile(base as never);
    expect(out).not.toContain("settingsSceneA");
    expect(out).not.toContain("patternToSettingsMapping");
    expect(out).not.toContain("return1GateSceneA");
    expect(out).toContain('"bpm"');
  });

  it("strips Track playThroughSteps/preCachedWaveform and return bufferFxRate/Pitch", () => {
    const out = encodePatternFile({
      sectionA: [{ playThroughSteps: [true], preCachedWaveform: [0.5], steps: [true] }],
      returnTrack1: { bufferFxRate: 1.5, bufferFxPitch: 0, volume: 1 },
    } as never);
    expect(out).not.toContain("playThroughSteps");
    expect(out).not.toContain("preCachedWaveform");
    expect(out).not.toContain("bufferFxRate");
    expect(out).not.toContain("bufferFxPitch");
    expect(out).toContain('"steps"'); // non-legacy siblings survive
    expect(out).toContain('"volume"');
  });

  it("omits scene2ActiveOverrides when EMPTY (Swift's `if !isEmpty`, :3313)", () => {
    const empty = encodePatternFile({
      baseSettings: { bpm: 120, scene2ActiveOverrides: [] },
    } as never);
    expect(empty).not.toContain("scene2ActiveOverrides");

    const nonEmpty = encodePatternFile({
      baseSettings: { bpm: 120, scene2ActiveOverrides: ["volume"] },
    } as never);
    expect(nonEmpty).toContain("scene2ActiveOverrides");
  });
});

describe("model strictness — silent data loss is impossible", () => {
  it("rejects an unmodeled key instead of dropping it on re-encode", () => {
    const minimal = { schemaVersion: 26, someKeySwiftAddedLater: 1 };
    expect(() => PatternFileSchema.parse(minimal)).toThrow();
  });
});

describe("float32 path derivation (from the field tables, not hand-listed)", () => {
  it("marks the known Float fields across nesting styles", () => {
    // top level
    expect(FLOAT32_PATHS.has("masterVolume")).toBe(true);
    expect(FLOAT32_PATHS.has("bpm")).toBe(false); // Double
    // array of structs (all 8 sections share the Track table)
    expect(FLOAT32_PATHS.has("sectionA[].volume")).toBe(true);
    expect(FLOAT32_PATHS.has("sectionH[].volumeOffsets[]")).toBe(true);
    expect(FLOAT32_PATHS.has("sectionA[].pitchOffsets[]")).toBe(false); // [Double]
    // Swift [Int: Float] dictionary → wildcard segment
    expect(FLOAT32_PATHS.has("sectionA[].storedExtensionVolumeOffsets.{}")).toBe(true);
    expect(FLOAT32_PATHS.has("sectionA[].storedExtensionPitchOffsets.{}")).toBe(false); // [Int: Double]
    expect(DICT_PATHS.has("sectionA[].storedExtensionVolumeOffsets")).toBe(true);
    // dictionary of structs: sceneSettingsLayers[scene].values.trackSettings[]
    expect(FLOAT32_PATHS.has("sceneSettingsLayers.{}.values.masterVolume")).toBe(true);
    expect(FLOAT32_PATHS.has("sceneSettingsLayers.{}.values.trackSettings[].toneQ")).toBe(true);
    expect(DICT_PATHS.has("sceneSettingsLayers")).toBe(true);
    // mod channels: the three Float fields among Doubles
    expect(FLOAT32_PATHS.has("modChannels[].followerGain")).toBe(true);
    expect(FLOAT32_PATHS.has("modChannels[].lfoRate")).toBe(false);
    // vintage snapshot is all-Float numerics
    expect(FLOAT32_PATHS.has("vintageImport.preGain")).toBe(true);
    // returns
    expect(FLOAT32_PATHS.has("returnTrack1.bufferFxRates[]")).toBe(true);
  });

  it("decode-only subtrees contribute no encode paths", () => {
    // settingsSceneA is never encoded, so its floats must not pollute the set
    expect(FLOAT32_PATHS.has("settingsSceneA.masterVolume")).toBe(false);
  });
});

describe("dictionary wildcard — Float values under arbitrary keys", () => {
  it("formats [Int: Float] dict values as float32 (fixtures carry them empty)", () => {
    // Float(1/3) narrows to 0.33333334; a Double-typed dict value would print
    // the 16-digit expansion. The key "7" is arbitrary — the {} wildcard path
    // must match it.
    const out = encodePatternFile({
      sectionA: [
        {
          storedExtensionVolumeOffsets: { "7": Math.fround(1 / 3) }, // [Int: Float]
          storedExtensionPitchOffsets: { "7": 1 / 3 }, // [Int: Double]
        },
      ],
    } as never);
    expect(out).toContain('"7" : 0.33333334');
    expect(out).toContain('"7" : 0.3333333333333333');
  });
});

describe("float narrowing on decode", () => {
  it("re-narrows Float fields so an edited value re-encodes at float32", () => {
    const text = readFileSync(join(FIXTURES_DIR, fixtureNames()[0]!), "utf8");
    const decoded = decodePatternFile(text) as { masterVolume: number };
    expect(decoded.masterVolume).toBe(Math.fround(decoded.masterVolume));
  });
});
