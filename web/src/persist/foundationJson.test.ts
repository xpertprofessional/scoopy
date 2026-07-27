import { describe, expect, it } from "vitest";
import {
  encodeFoundationJSON,
  formatDouble,
  formatFloat32,
  foundationKeyOrder,
} from "./foundationJson.ts";

/**
 * These fixtures are REAL BYTES emitted by Swift's JSONEncoder with the
 * production settings (`[.prettyPrinted, .sortedKeys]`, PersistenceService:22),
 * captured from a standalone Foundation harness. They are not hand-written
 * expectations — if TS reproduces these exactly, it reproduces what the app
 * actually writes to disk. That is THE FLIP's hard gate in miniature (P5-06).
 */

// Verbatim Swift output for a struct mixing Float / Double / Int / optionals.
const SWIFT_PROBE_JSON = `{
  "boolVal" : true,
  "doubleBpm" : 120,
  "doubles" : [
    0.8,
    0.5,
    1,
    0
  ],
  "doubleSwing" : 0.1,
  "doubleThird" : 0.3333333333333333,
  "floatIntegral" : 1,
  "floats" : [
    0.8,
    0.5,
    1,
    0
  ],
  "floatSmall" : 0.1,
  "floatThird" : 0.33333334,
  "floatVolume" : 0.8,
  "int32Val" : -1,
  "intVal" : 42,
  "uint8Val" : 3
}`;

describe("foundationJson — byte-parity with Swift's JSONEncoder", () => {
  it("reproduces a real Swift-encoded payload byte-for-byte", () => {
    // The value as TS would hold it after decoding. `optNil` is absent, exactly
    // as Swift omitted it. Float fields are declared via float32Paths — that
    // type information does NOT exist in the JSON and must come from the model.
    const value = {
      floatVolume: 0.8,
      floatThird: Math.fround(1 / 3),
      floatIntegral: 1,
      floatSmall: 0.1,
      doubleBpm: 120,
      doubleSwing: 0.1,
      doubleThird: 1 / 3,
      intVal: 42,
      uint8Val: 3,
      int32Val: -1,
      boolVal: true,
      floats: [0.8, 0.5, 1, 0],
      doubles: [0.8, 0.5, 1, 0],
    };
    const float32Paths = new Set([
      "floatVolume",
      "floatThird",
      "floatIntegral",
      "floatSmall",
      "floats[]",
    ]);

    expect(encodeFoundationJSON(value, { float32Paths })).toBe(SWIFT_PROBE_JSON);
  });

  it("round-trips: decode Swift's bytes → re-encode → identical bytes", () => {
    const parsed = JSON.parse(SWIFT_PROBE_JSON);
    // The float fields must be re-narrowed to float32 on decode — a Double-only
    // decode would already be lossless HERE (the text is a valid double), but
    // an EDITED float would then re-encode with double precision. The model
    // narrows on decode; this mirrors that.
    for (const k of ["floatVolume", "floatThird", "floatIntegral", "floatSmall"]) {
      parsed[k] = Math.fround(parsed[k]);
    }
    parsed.floats = parsed.floats.map(Math.fround);
    const float32Paths = new Set([
      "floatVolume",
      "floatThird",
      "floatIntegral",
      "floatSmall",
      "floats[]",
    ]);
    expect(encodeFoundationJSON(parsed, { float32Paths })).toBe(SWIFT_PROBE_JSON);
  });
});

describe("rule 1 — key order is ICU collation, not lexicographic", () => {
  it("matches Foundation's .sortedKeys exactly (verbatim Swift order)", () => {
    // Swift emitted precisely this order for these keys. Note lowercase sorts
    // BEFORE uppercase at equal letters — the opposite of a byte sort.
    const swiftOrder = ["ab", "aB", "Ab", "AB", "ac", "aC", "optPresent", "z1", "Z2"];
    const keys = ["aB", "ab", "aC", "ac", "Ab", "AB", "z1", "Z2", "optPresent"];
    expect(foundationKeyOrder(keys)).toEqual(swiftOrder);
  });

  it("a naive lexicographic sort would produce a DIFFERENT file (the trap)", () => {
    const keys = ["aB", "ab", "aC", "ac", "Ab", "AB", "z1", "Z2", "optPresent"];
    expect([...keys].sort()).not.toEqual(foundationKeyOrder(keys));
  });
});

describe("rule 2 — nil optionals are omitted, not null", () => {
  it("drops undefined keys and keeps explicit nulls", () => {
    const out = encodeFoundationJSON({ a: 1, absent: undefined, explicitNull: null });
    expect(out).toBe('{\n  "a" : 1,\n  "explicitNull" : null\n}');
  });
});

describe("rule 3 — Float and Double format differently", () => {
  it("Float uses shortest float32 repr; Double uses shortest double repr", () => {
    expect(formatFloat32(Math.fround(1 / 3))).toBe("0.33333334"); // Swift Float
    expect(formatDouble(1 / 3)).toBe("0.3333333333333333"); // Swift Double
  });

  it("the same field encoded as Double instead of Float would corrupt the bytes", () => {
    // This is what a type-blind encoder emits — the double expansion of a float.
    expect(formatDouble(Math.fround(1 / 3))).toBe("0.3333333432674408");
  });

  it("integral values carry no .0 (Swift prints 120, not 120.0)", () => {
    expect(formatDouble(120)).toBe("120");
    expect(formatFloat32(1)).toBe("1");
    expect(formatDouble(0)).toBe("0");
  });

  it("common Float values stay short (0.8 must not widen)", () => {
    expect(formatFloat32(0.8)).toBe("0.8");
    expect(formatFloat32(Math.fround(0.8))).toBe("0.8");
    expect(formatFloat32(0.1)).toBe("0.1");
  });
});

describe("rule 4 — pretty-print shape", () => {
  it("2-space indent, space both sides of the colon, one array element per line", () => {
    expect(encodeFoundationJSON({ xs: [1, 2] })).toBe('{\n  "xs" : [\n    1,\n    2\n  ]\n}');
  });

  // Verbatim Swift output — an empty array/object is NOT "[]"/"{}" but carries a
  // blank line between the brackets. My first guess here was "[]" and the probe
  // refuted it; most sessions contain an empty array somewhere, so this exact
  // shape is load-bearing for byte-identity.
  it("empty containers keep a blank line (real Swift bytes)", () => {
    expect(encodeFoundationJSON({ e: {}, a: [] })).toBe(
      '{\n  "a" : [\n\n  ],\n  "e" : {\n\n  }\n}',
    );
  });
});

// RULE 5 — Foundation escapes the forward slash; JSON.stringify does not.
//
// Found by the legacy-pre28-outputs fixture, whose plugin identifier was the first string in
// the whole corpus to contain a "/". Verbatim Swift bytes from `JSONEncoder` with the
// production settings (.prettyPrinted, .sortedKeys).
describe("forward slashes (Foundation escapes them, JS does not)", () => {
  it("escapes / as \\/ — the difference is invisible in JSON, load-bearing in BYTES", () => {
    const out = encodeFoundationJSON({ id: "AudioUnit:aumu/xxxx/yyyy" });
    expect(out).toContain('"AudioUnit:aumu\\/xxxx\\/yyyy"');
    // …and it is NOT what JSON.stringify would have written:
    expect(out).not.toContain('"AudioUnit:aumu/xxxx/yyyy"');
  });

  it("a POSIX path round-trips — this is the field that would really have bitten", () => {
    // `originalSamplePath` is on every track that remembers where its sample came from.
    const out = encodeFoundationJSON({ p: "/Users/x/Kick.wav" });
    expect(out).toContain('"\\/Users\\/x\\/Kick.wav"');
    expect(JSON.parse(out).p).toBe("/Users/x/Kick.wav"); // still decodes to the real path
  });
});
