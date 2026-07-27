import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as schema from "./schema.ts";
import {
  HOT_FRAME_LENGTH,
  HOT_FRAME_SCALARS,
  HOT_FRAME_SPECTRUM_BASE,
  HotFrameLayout,
  MAX_GRID_TRACKS,
  PARAM_IDS,
  SPECTRUM_BIN_COUNT,
  djTrackLevelIndex,
} from "./schema.ts";

describe("SLP schema invariants", () => {
  it("param ids are unique", () => {
    expect(new Set(PARAM_IDS).size).toBe(PARAM_IDS.length);
  });

  it("hot frame scalar indices are contiguous from 0", () => {
    const indices = HOT_FRAME_SCALARS.map((n) => HotFrameLayout[n]);
    expect(indices).toEqual(indices.map((_, i) => i));
  });

  it("track level blocks are contiguous per deck (SIG-3)", () => {
    for (let deck = 0; deck < 3; deck++) {
      const base = djTrackLevelIndex(deck, 0);
      for (let t = 0; t < MAX_GRID_TRACKS; t++) {
        expect(djTrackLevelIndex(deck, t)).toBe(base + t);
      }
    }
    const composeBase = HotFrameLayout.trackLevel0;
    expect(HotFrameLayout.trackLevel15).toBe(composeBase + 15);
  });

  it("spectrum bins sit directly after the scalars", () => {
    expect(HOT_FRAME_SPECTRUM_BASE).toBe(HOT_FRAME_SCALARS.length);
    expect(HOT_FRAME_LENGTH).toBe(HOT_FRAME_SPECTRUM_BASE + SPECTRUM_BIN_COUNT);
  });

  // P0-A convergence: unknown keys are a loud failure everywhere
  // (preserve-don't-drop). Walks every exported schema plus the COMMANDS
  // table and asserts every object — however deeply nested — is `.strict()`.
  it("every schema object is .strict()", () => {
    const seen = new Set<z.ZodTypeAny>();
    const offenders: string[] = [];

    const walk = (s: z.ZodTypeAny, path: string): void => {
      if (seen.has(s)) return;
      seen.add(s);
      // deno-lint-ignore no-explicit-any
      const def = (s as any)._def;
      switch (def?.typeName) {
        case "ZodObject": {
          if (def.unknownKeys !== "strict") offenders.push(path);
          for (const [k, v] of Object.entries(def.shape()))
            walk(v as z.ZodTypeAny, `${path}.${k}`);
          break;
        }
        case "ZodArray":
          walk(def.type, `${path}[]`);
          break;
        case "ZodOptional":
        case "ZodNullable":
        case "ZodDefault":
        case "ZodReadonly":
        case "ZodBranded":
          walk(def.innerType, path);
          break;
        case "ZodEffects":
          walk(def.schema, path);
          break;
        case "ZodUnion":
        case "ZodDiscriminatedUnion":
          def.options.forEach((o: z.ZodTypeAny, i: number) =>
            walk(o, `${path}|${i}`),
          );
          break;
        case "ZodTuple":
          def.items.forEach((o: z.ZodTypeAny, i: number) =>
            walk(o, `${path}[${i}]`),
          );
          break;
        case "ZodRecord":
        case "ZodMap":
          walk(def.valueType, `${path}{}`);
          break;
        case "ZodLazy":
          walk(def.getter(), path);
          break;
        case "ZodIntersection":
          walk(def.left, `${path}&L`);
          walk(def.right, `${path}&R`);
          break;
      }
    };

    for (const [name, value] of Object.entries(schema))
      if (value instanceof z.ZodType) walk(value, name);
    for (const [method, spec] of Object.entries(schema.COMMANDS)) {
      walk(spec.params, `COMMANDS.${method}.params`);
      walk(spec.result, `COMMANDS.${method}.result`);
    }

    expect(offenders).toEqual([]);
  });
});
