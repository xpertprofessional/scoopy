import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { encodePatternFile } from "./patternFile.ts";
import {
  DEFAULT_MOD_CHANNEL,
  legacyToneQ,
  migrateLfoClockDivision,
  migratePatternFile,
} from "./migrations.ts";

/**
 * P5-06c — THE LEGACY GATE.
 *
 * `ScoopyLoopsTests/PatternFileLegacyTests.swift` writes, for each scenario,
 * BOTH halves of the truth:
 *
 *   <name>.json           a session in an OLDER build's shape
 *   <name>.expected.json  Swift's OWN decode of it, re-encoded canonically
 *
 * That second file is the definition of "correctly migrated" — it is literally
 * what the app writes when it opens that old session and saves it. So the gate
 * is simply: our migration + our encoder must reproduce those bytes exactly.
 *
 * Swift is the oracle. No hand-written expectations, nothing to argue with: if
 * TS disagrees by one byte, TS is wrong.
 */

const LEGACY_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/patternfile/legacy",
);

const scenarios = readdirSync(LEGACY_DIR)
  .filter((f) => f.endsWith(".json") && !f.endsWith(".expected.json"))
  .map((f) => f.replace(/\.json$/, ""))
  .sort();

describe("legacy migration — byte-identical to Swift's own decoder", () => {
  it("the corpus exists (regenerate: PatternFileLegacyTests)", () => {
    expect(scenarios.length).toBeGreaterThan(0);
  });

  for (const name of scenarios) {
    it(`${name}: migrate → encode == Swift's migrated bytes`, () => {
      const legacy = readFileSync(join(LEGACY_DIR, `${name}.json`), "utf8");
      const expected = readFileSync(join(LEGACY_DIR, `${name}.expected.json`), "utf8");

      const migrated = migratePatternFile(JSON.parse(legacy));
      const ours = encodePatternFile(migrated);

      // Byte-for-byte. A mismatch means our migration diverges from Swift's —
      // i.e. after the flip, this old session would open DIFFERENTLY.
      expect(ours).toBe(expected);
    });
  }
});

describe("the value-dependent rules (the ones a naive port gets wrong)", () => {
  it("LfoClockDivision: legacy beat raws (<1000) are REMAPPED, not passed through", () => {
    expect(migrateLfoClockDivision(1)).toBe(2000); // whole note → lcmCycle
    expect(migrateLfoClockDivision(4)).toBe(1002); // quarter → step4
    expect(migrateLfoClockDivision(8)).toBe(1003); // 1/8 → step8
    expect(migrateLfoClockDivision(800)).toBe(1006); // 1/8 triplet → step3
    expect(migrateLfoClockDivision(64)).toBe(2003); // 2 bars → lcmDouble
  });

  it("LfoClockDivision: modern raws pass through; unknown ones fall back to step8", () => {
    expect(migrateLfoClockDivision(1006)).toBe(1006);
    expect(migrateLfoClockDivision(2007)).toBe(2007);
    expect(migrateLfoClockDivision(9999)).toBe(1003); // unknown ≥1000 → step8
    expect(migrateLfoClockDivision(7)).toBe(1003); // unknown <1000 → step8
  });

  it("LfoClockDivision: Swift's 1600/3200 branches are DEAD (they never run)", () => {
    // The Swift table lists 1600 → step6 and 3200 → step6, but the remap only
    // fires for raw < 1000, so those rows are unreachable: both are ≥1000 and
    // not valid raws, so they land on step8. Porting the WRITTEN table instead
    // of the REACHABLE one would silently change these sessions.
    expect(migrateLfoClockDivision(1600)).toBe(1003);
    expect(migrateLfoClockDivision(3200)).toBe(1003);
  });

  it("toneQ: absent Q restores the per-filter-mode legacy value (sound-preserving)", () => {
    expect(legacyToneQ("lowPass")).toBe(0.976);
    expect(legacyToneQ("highPass")).toBe(0.892);
    expect(legacyToneQ("tone")).toBe(0.707);
    expect(legacyToneQ("bandPass")).toBe(0.707);
  });
});

describe("migratePatternFile is safe on a CURRENT file (idempotent, non-mutating)", () => {
  const CURRENT_DIR = join(
    dirname(fileURLToPath(import.meta.url)),
    "../../fixtures/patternfile",
  );

  it("a current session survives migration untouched, byte-for-byte", () => {
    // Every branch keys off KEY PRESENCE, so a file that already has the keys
    // must come out unchanged. This is what lets the flip run one code path for
    // every file instead of branching on schemaVersion (which may be absent).
    const text = readFileSync(join(CURRENT_DIR, "edited-busy.json"), "utf8");
    const migrated = migratePatternFile(JSON.parse(text));
    expect(encodePatternFile(migrated)).toBe(text);
  });

  it("does not mutate its input", () => {
    const raw = JSON.parse(
      readFileSync(join(CURRENT_DIR, "fresh-default.json"), "utf8"),
    );
    const before = JSON.stringify(raw);
    migratePatternFile(raw);
    expect(JSON.stringify(raw)).toBe(before);
  });

  it("sanitizes a legacy chokeGroup > 8 to OFF (0), not to 8", () => {
    // Old sessions could auto-assign choke groups up to 255 (index-based / first-unused). No edit
    // path can produce > 8, so those are meaningless artifacts. Clamping to 8 (as the wire round
    // trip once did) MERGES unrelated tracks into group 8; the correct repair is OFF.
    const raw = JSON.parse(
      readFileSync(join(CURRENT_DIR, "fresh-default.json"), "utf8"),
    );
    raw.sectionA[0].chokeGroup = 9;
    raw.sectionA[1].chokeGroup = 200;
    raw.baseSettings.trackSettings[0].chokeGroup = 42;
    const migrated = migratePatternFile(raw) as Record<string, unknown>;
    const secA = migrated.sectionA as Array<Record<string, unknown>>;
    const ts = (migrated.baseSettings as Record<string, unknown>)
      .trackSettings as Array<Record<string, unknown>>;
    expect(secA[0]!.chokeGroup).toBe(0);
    expect(secA[1]!.chokeGroup).toBe(0);
    expect(ts[0]!.chokeGroup).toBe(0);
  });

  it("leaves a valid chokeGroup (1…8) untouched", () => {
    const raw = JSON.parse(
      readFileSync(join(CURRENT_DIR, "fresh-default.json"), "utf8"),
    );
    raw.sectionA[0].chokeGroup = 5;
    const migrated = migratePatternFile(raw) as Record<string, unknown>;
    const secA = migrated.sectionA as Array<Record<string, unknown>>;
    expect(secA[0]!.chokeGroup).toBe(5);
  });

  it("DEFAULT_MOD_CHANNEL still matches what Swift actually writes", () => {
    // A file with no `modChannels` gets ModChannel.defaultChannels. Those
    // defaults are a hand-carried constant on our side, so pin them against a
    // REAL fresh session — an earlier hand-transcription of this struct got the
    // field names and the envelope wrong, and only a byte-diff caught it. If
    // Swift's defaults move, this fails loudly rather than rotting quietly.
    const fresh = JSON.parse(
      readFileSync(join(CURRENT_DIR, "fresh-default.json"), "utf8"),
    );
    const swiftDefaults = fresh.modChannels;
    expect(swiftDefaults).toHaveLength(4);
    for (const ch of swiftDefaults) {
      expect(ch).toEqual(DEFAULT_MOD_CHANNEL);
    }
  });
});
