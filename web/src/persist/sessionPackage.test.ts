/**
 * P8-0 — the SESSION PACKAGE, TS half. The browser companion's foundation.
 *
 * Phase 8's product: write a session away from the studio, come back, and it opens in the full app
 * exactly as you wrote it. So the round-trip — both manifests, byte-for-byte — IS the product, and
 * `preserve-don't-drop` is its first-class correctness property. A companion that strips your
 * plugin chain while you fix a hi-hat is worse than no companion.
 *
 * The fixtures come from `SessionPackageGoldenTests.swift`, which drives the REAL
 * `PersistenceService.saveSession`. Swift is the oracle.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { decodeKit, encodeKit, kitSamples } from "./kit";
import { decodePatternFile, encodePatternFile } from "./patternFile";
import { KIT_ENTRY, PATTERN_ENTRY, packageFromEntries } from "./sessionPackage";

const read = (name: string) =>
  readFileSync(new URL(`../../fixtures/session/${name}`, import.meta.url), "utf8");

const KIT_JSON = read("session-kit.json");
const PATTERN_JSON = read("session-pattern.json");

describe("kit.json — the sample manifest TS could not read at all until now", () => {
  it("round-trips byte-for-byte", () => {
    expect(encodeKit(decodeKit(KIT_JSON))).toBe(KIT_JSON);
  });

  it("survives the Float trap (defaultVolume/defaultPan are Swift Float, not Double)", () => {
    // The fixture stores 1/3 as a Float: Swift writes `0.33333334`. A model that marked these
    // Double would re-encode `0.3333333432674408` and the byte compare above would fail. This
    // asserts the VALUE so the reason is visible when it breaks, not just the byte length.
    const samples = kitSamples(decodeKit(KIT_JSON));
    expect(samples[0]!.defaultVolume).toBeCloseTo(0.33333334, 8);
    expect(KIT_JSON).toContain("0.33333334");
    expect(KIT_JSON).not.toContain("0.3333333333333333");
  });

  it("exposes the samples the companion has to fetch (relative to the package)", () => {
    const samples = kitSamples(decodeKit(KIT_JSON));
    expect(samples).toHaveLength(2);
    // `saveSession` rewrites every path relative to the package — which is exactly what makes the
    // format portable to a browser that has no filesystem.
    expect(samples.map((s) => s.filePath)).toEqual(["Samples/kick.wav", "Samples/snare.wav"]);
    expect(samples.every((s) => !s.filePath.startsWith("/"))).toBe(true);
  });
});

describe("pattern.json — the package form, now CANONICAL", () => {
  it("round-trips byte-for-byte", () => {
    // ⚠️ This is NEW. `saveSession` used to write pattern.json with a PLAIN JSONEncoder, so the
    // P5-06b byte-identity proof covered the standalone `.scoopyPattern` file and NOT the package
    // — the one form the companion must actually read and write. Both use the canonical encoder
    // now (P8-0), so the package inherits the proof instead of being a form nothing verifies.
    expect(encodePatternFile(decodePatternFile(PATTERN_JSON))).toBe(PATTERN_JSON);
  });
});

describe("PRESERVE-DON'T-DROP — the phase's first-class property", () => {
  // A browser cannot host an AU/VST3, cannot pick an audio device, cannot route to channel 3/4.
  // Those are NON-GOALS, not losses — they were never part of composing. But the FILE still
  // carries them, and a companion that edits a hi-hat and silently deletes your plugin chain on
  // re-save is worse than no companion at all.
  const track = (i: number) =>
    (decodePatternFile(PATTERN_JSON).sectionA as Record<string, unknown>[])[i]!;

  it("the plugin binding, the instrument output and the hardware routing are all THERE", () => {
    const t = track(0);
    expect(t.instrumentPluginIdentifier).toBe("AudioUnit:aumu:Diva:UHE1");
    expect(t.instrumentPluginName).toBe("Diva");
    expect(t.instrumentOutEnabled).toBe(true);
    expect(t.outputAssign).toBe(2); // a hardware route the browser cannot offer
  });

  it("…and a full decode → re-encode brings every one of them back UNTOUCHED", () => {
    // This is the actual guarantee. It holds for a structural reason, not by luck: the TS schema
    // is STRICT, so an unmodeled key is a LOUD FAILURE rather than a silent drop-on-re-encode.
    // You cannot quietly lose a field you were forced to model.
    const round = decodePatternFile(encodePatternFile(decodePatternFile(PATTERN_JSON)));
    const t = (round.sectionA as Record<string, unknown>[])[0]!;

    expect(t.instrumentPluginIdentifier).toBe("AudioUnit:aumu:Diva:UHE1");
    expect(t.instrumentPluginName).toBe("Diva");
    expect(t.instrumentOutEnabled).toBe(true);
    expect(t.outputAssign).toBe(2);
  });

  it("⚠️ the DESKTOP APP was dropping these first — regression lock", () => {
    // Found building this fixture: `createSequencerStateTrack` — the builder savePattern and
    // saveSession use — never passed the instrument binding, the MIDI destination, the chopper's
    // default slice, the free/tape rate, or ANY of the granular mode. The memberwise init supplied
    // its defaults and the data was gone the moment you saved.
    //
    // It was invisible: the JSON stayed well-formed, every key was present, and the file
    // round-tripped byte-identically. The keys just held defaults.
    //
    // If any of these ever reads as a default again, the save path has regressed.
    const t = track(0);
    expect(t.instrumentPluginIdentifier).not.toBeNull(); // was: always null
    expect(t.instrumentOutEnabled).not.toBe(false); // was: always false
  });
});

describe("cross-platform path hygiene (XP-0b-4, CROSS-PLATFORM.md §3.3 hazard 4)", () => {
  const enc = new TextEncoder();
  const sampleBytes = new Uint8Array([1, 2, 3, 4]);

  it("a Windows-zipped package (backslash separators) still finds its samples", () => {
    // A zip written on Windows names entries with backslashes. The kit refers to samples with
    // forward slashes and the reader classifies on `startsWith("Samples/")`, so without
    // normalization every sample would be misclassified as an unknown extra and lost on import.
    const files = new Map<string, Uint8Array>([
      [PATTERN_ENTRY.replace(/\//g, "\\"), enc.encode(PATTERN_JSON)],
      [KIT_ENTRY.replace(/\//g, "\\"), enc.encode(KIT_JSON)],
      ["Samples\\kick.wav", sampleBytes],
    ]);

    const pkg = packageFromEntries(files);
    expect([...pkg.samples.keys()]).toEqual(["Samples/kick.wav"]);
    expect(pkg.samples.get("Samples/kick.wav")).toEqual(sampleBytes);
    expect([...pkg.extras.keys()]).toEqual([]); // the sample must NOT leak into extras
  });

  it("a backslash-separated FOLDER-rooted package (Windows Finder-equivalent) opens too", () => {
    const files = new Map<string, Uint8Array>([
      [`MySession.scoopySession\\${PATTERN_ENTRY}`, enc.encode(PATTERN_JSON)],
      [`MySession.scoopySession\\${KIT_ENTRY}`, enc.encode(KIT_JSON)],
      ["MySession.scoopySession\\Samples\\kick.wav", sampleBytes],
    ]);

    const pkg = packageFromEntries(files);
    expect([...pkg.samples.keys()]).toEqual(["Samples/kick.wav"]);
  });
});
