/**
 * P5-06 step A — the world wire.
 *
 * The wire's whole job is to be lossless, so these tests pin the two ways it could lie:
 * a divergence that reports clean, and a refusal that reports success.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { EngineLink } from "../engineLink";
import { decodePatternFileAnyVersion } from "./migrations";
import { encodePatternFile } from "./patternFile";
import { fetchPatternJson, publishWorld, verifyWorldRoundTrip } from "./worldWire";

/** A real session, saved by Swift's own canonical encoder (the P5-06b corpus). */
const SWIFT_BYTES = readFileSync(
  new URL("../../fixtures/patternfile/edited-busy.json", import.meta.url),
  "utf8",
);

/** A link stub: `command` answers getPattern/worldPublish, everything else is unused. */
function stubLink(handlers: Partial<Record<string, (p: unknown) => unknown>>): EngineLink {
  return {
    command: vi.fn(async (method: string, params: unknown) => {
      const h = handlers[method];
      if (!h) throw new Error(`unexpected command: ${method}`);
      return h(params);
    }),
    paramWrite: vi.fn(),
    onHotFrame: vi.fn(() => () => {}),
    onEvent: vi.fn(() => () => {}),
    onUiState: vi.fn(() => () => {}),
  } as unknown as EngineLink;
}

describe("world wire — round-trip verification", () => {
  it("reports byte-identical for a real Swift-authored pattern", async () => {
    const link = stubLink({ getPattern: () => ({ json: SWIFT_BYTES }) });

    const r = await verifyWorldRoundTrip(link);

    expect(r.ok).toBe(true);
    expect(r.firstDiff).toBe(-1);
    expect(r.bytes).toBe(SWIFT_BYTES.length);
  });

  it("CATCHES a divergence rather than reporting clean", async () => {
    // A verifier that always says "ok" is worse than none, so prove it can fail.
    //
    // The corruption has to be one the model can actually detect, which makes this a live
    // test of the P5-06a Float/Double rule: `masterVolume` is a Swift **Float** (the
    // fixture holds `0.33333334`), while `bpm` is a **Double**. Feeding a Double-precision
    // literal into the Float field is precisely the byte corruption a type-blind encoder
    // would emit — TS knows the field is Float32 and re-encodes it short, so it diverges.
    //
    // (Corrupting `bpm` the same way does NOT diverge — any valid double re-encodes to
    // itself. That is correct behaviour, and it is why this test targets a Float.)
    const corrupted = SWIFT_BYTES.replace(
      '"masterVolume" : 0.33333334',
      '"masterVolume" : 0.3333333333333333',
    );
    expect(corrupted).not.toBe(SWIFT_BYTES); // the fixture really did hold that Float
    const link = stubLink({ getPattern: () => ({ json: corrupted }) });

    const r = await verifyWorldRoundTrip(link);

    expect(r.ok).toBe(false);
    expect(r.firstDiff).toBeGreaterThanOrEqual(0);
    expect(r.detail).toContain("swift:");
  });

  it("passes the deck scope through, and omits it for the compose surface", async () => {
    const seen: unknown[] = [];
    const link = stubLink({
      getPattern: (p) => {
        seen.push(p);
        return { json: SWIFT_BYTES };
      },
    });

    await fetchPatternJson(link);
    await fetchPatternJson(link, 2);

    expect(seen).toEqual([{}, { deck: 2 }]);
  });
});

describe("world wire — publish", () => {
  it("sends the pattern in canonical form", async () => {
    let sent = "";
    const link = stubLink({
      worldPublish: (p) => {
        sent = (p as { json: string }).json;
        return { applied: true, error: null };
      },
    });
    const file = decodePatternFileAnyVersion(SWIFT_BYTES);

    const r = await publishWorld(link, file);

    expect(r.applied).toBe(true);
    expect(sent).toBe(encodePatternFile(file));
  });

  it("SURFACES a refusal instead of swallowing it", async () => {
    // Swift refuses while `web.owner.patterns` is off. That must reach the caller as a
    // failure: a refusal quietly reported as success is how you end up believing the wire
    // works when nothing is listening.
    const link = stubLink({
      worldPublish: () => ({
        applied: false,
        error: "web.owner.patterns is off — Swift owns the document; publish refused",
      }),
    });

    const r = await publishWorld(link, decodePatternFileAnyVersion(SWIFT_BYTES));

    expect(r.applied).toBe(false);
    expect(r.error).toContain("web.owner.patterns is off");
  });
});
