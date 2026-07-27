/**
 * P5-06 step C — the trackEdit golden harness, TS half.
 *
 * `TrackOpGoldenTests.swift` drives the REAL Swift dispatch (`WebEngineLink.applyTrackEdit` —
 * the same entry the web hits, so the handler's own pre-clamps are included) from a known start
 * state, and writes the before/after wire payloads. **Swift is the oracle: its output DEFINES
 * correct.** Here the TS reducers must reproduce it byte-for-byte.
 *
 * This is the tool the shadow store cannot be. The shadow chain joins mid-session from a pushed
 * state, so it can only predict ops whose result is a function of what was pushed — and several
 * ops are not (hidden restore buffers, selection scope, invisible inputs). A golden fixture
 * starts from a KNOWN state, so the buffers start empty and every effect is captured.
 *
 * Regenerate the corpus (the test host is sandboxed — strip entitlements to let it write):
 *   xcodebuild test -project ScoopyLoops.xcodeproj -scheme ScoopyLoops \
 *     -destination 'platform=macOS' \
 *     -only-testing:ScoopyLoopsTests/TrackOpGoldenTests CODE_SIGN_ENTITLEMENTS=
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { GridPatternState, GridRuntimeState, GridTrackState } from "../../protocol/schema";
import { deriveTrackState } from "./deriveTrackState";
import { canonicalPatternState, patternDiffFields, projectPattern } from "./patternCanonical";
import { VERIFIABLE_TRACK_OPS, applyTrackOp, type TrackOp } from "./trackOps";

interface Fixture {
  name: string;
  note: string;
  ops: TrackOp[];
  initial: GridPatternState;
  expected: GridPatternState;
  runtime: GridRuntimeState;
}

const fixtures: Fixture[] = JSON.parse(
  readFileSync(new URL("../../fixtures/track-ops.json", import.meta.url), "utf8"),
);

describe("trackEdit reducers — byte-identical to the real Swift mutators", () => {
  it("the corpus exists (regenerate: TrackOpGoldenTests)", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const f of fixtures) {
    it(`${f.name}: ${f.note || "matches Swift"}`, () => {
      // The reducers work on the MERGED view: several PATTERN clamps read RUNTIME scalars
      // (sampleDurationMs bounds setSampleStart/End, setChopPoint and clampLoopParameters).
      // That dependency is exactly why these ops were never modelable from the pattern topic
      // alone — and why the fixture ships the runtime half too.
      let t: GridTrackState = deriveTrackState({ ...f.initial, ...f.runtime });

      for (const op of f.ops) {
        expect(
          VERIFIABLE_TRACK_OPS.has(op.op),
          `${op.op} is in the corpus but not in VERIFIABLE_TRACK_OPS — it would silently poison the shadow chain instead of being modeled`,
        ).toBe(true);
        t = applyTrackOp(t, op);
      }

      const got = projectPattern(t);
      const want = f.expected;

      // Name the fields on failure. "expected 4021 chars to be 4021 chars" is not a diagnosis.
      expect(patternDiffFields(got, want), `diverged on: ${patternDiffFields(got, want).join(", ")}`)
        .toEqual([]);
      expect(canonicalPatternState(got)).toBe(canonicalPatternState(want));
    });
  }
});

describe("the corpus is honest about what it proves", () => {
  it("every fixture CHANGES the pattern, unless it says in its name why it doesn't", () => {
    // A fixture whose expected state equals its initial state is passed by a reducer that does
    // nothing at all. The Swift generator guards against this too; this is the second lock,
    // because it is the single easiest way to build a harness that agrees with your bug. (The
    // generator caught four such fixtures on its first run.)
    //
    // Two kinds are legitimate, and each must SAY SO:
    //   NOOP       the no-op IS the behaviour (an off-table setSpeedMultiplier is ignored).
    //   ROUNDTRIP  the op is losslessly reversible and returning to the start IS the property
    //              (shrink→grow restores the tail; OWN→REG restores the flattened cells).
    for (const f of fixtures) {
      if (canonicalPatternState(f.initial) === canonicalPatternState(f.expected)) {
        expect(
          f.name,
          `${f.name} leaves the pattern unchanged — it proves nothing unless that IS the point`,
        ).toMatch(/NOOP|ROUNDTRIP/);
      }
    }
  });

  it("every ROUNDTRIP is BACKED by a one-way fixture an inert reducer cannot pass", () => {
    // The honest weakness of a lossless round-trip: a reducer that does nothing also lands on the
    // start state. So each one is only meaningful because a ONE-WAY fixture for the same op
    // exists — setStepCount-shrink and cyclePlaybackMode-to-OWN-flattens-cells both CHANGE the
    // pattern, and no inert reducer survives them. This test refuses to let that pairing rot.
    const names = fixtures.map((f) => f.name);
    const oneWay = (prefix: string) =>
      fixtures.some(
        (f) =>
          f.name.startsWith(prefix) &&
          !f.name.includes("ROUNDTRIP") &&
          canonicalPatternState(f.initial) !== canonicalPatternState(f.expected),
      );
    for (const rt of names.filter((n) => n.includes("ROUNDTRIP"))) {
      const op = rt.split("-")[0]!;
      expect(oneWay(op), `${rt} has no one-way ${op} fixture to rule out an inert reducer`).toBe(
        true,
      );
    }
  });
});
