import { describe, expect, it } from "vitest";
import { CommandEnvelopeSchema, CommandReplySchema } from "./schema.ts";

/**
 * P0-A convergence (shared/ROLLOUT.md phase 5): scoopy speaks the shared
 * command envelope — replies carry `ok` and both envelopes are `.strict()`.
 * The Swift side (WebEngineLink.respond) mirrors the reply byte-for-byte.
 */
describe("shared command envelope", () => {
  it("round-trips a request", () => {
    const req = { id: 7, method: "getCapabilities", params: {} };
    expect(CommandEnvelopeSchema.parse(req)).toEqual(req);
  });

  it("round-trips ok and error replies", () => {
    const ok = { id: 7, ok: true, result: { value: 3 } };
    expect(CommandReplySchema.parse(ok)).toEqual(ok);
    const err = { id: 8, ok: false, error: "unknown method" };
    expect(CommandReplySchema.parse(err)).toEqual(err);
  });

  it("rejects the pre-convergence reply shape (no ok field)", () => {
    // Exactly what the Swift emitter sent before schema v86.
    const legacy = { id: 7, result: { value: 3 } };
    expect(CommandReplySchema.safeParse(legacy).success).toBe(false);
  });

  it("rejects unknown keys on both envelopes", () => {
    expect(
      CommandEnvelopeSchema.safeParse({
        id: 1,
        method: "x",
        params: {},
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      CommandReplySchema.safeParse({ id: 1, ok: true, extra: 1 }).success,
    ).toBe(false);
  });
});
