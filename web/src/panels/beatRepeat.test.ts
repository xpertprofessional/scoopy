import { describe, expect, it } from "vitest";
// REHOMED (B1-RETIRE): this pure readout lived in `TransportPanel`, which is
// being deleted — its every verb is unanswered. The scale it reads is the same
// one `BR_SCALE` walks, so `stripOps` is where it belongs. The PIN moved with
// it rather than being deleted: the fused-scale law is still live on the deck
// row's BR control.
import { beatRepeatLabel } from "../plane/stripOps.ts";

/**
 * The BR length cycler. Native's `nudgeBeatRepeatScale` walks ONE fused scale and the readout
 * changes NOTATION halfway down it:
 *
 *     16 … 3  2  1 │ 1/2  1/4  1/8  1/16  1/32
 *                  └── micro zone: length pins to 1, the SUBDIVISION carries the value
 *
 * That fold is why the web could not show a length before this: `beatRepeatLength` alone renders
 * "1" for six distinct settings, so half the scale was unnameable — and unreachable, since the
 * cycler that walks it had nothing to display.
 */
describe("beatRepeatLabel", () => {
  it("names the whole-step half by its step count", () => {
    expect(beatRepeatLabel({ beatRepeatLength: 16, beatRepeatSubdivision: 1 })).toBe("16");
    expect(beatRepeatLabel({ beatRepeatLength: 4, beatRepeatSubdivision: 1 })).toBe("4");
    expect(beatRepeatLabel({ beatRepeatLength: 1, beatRepeatSubdivision: 1 })).toBe("1");
  });

  it("names the micro half as a FRACTION of a step — the six settings a length alone cannot tell apart", () => {
    // Every one of these carries beatRepeatLength === 1. Read the length and they are all "1".
    expect(beatRepeatLabel({ beatRepeatLength: 1, beatRepeatSubdivision: 2 })).toBe("1/2");
    expect(beatRepeatLabel({ beatRepeatLength: 1, beatRepeatSubdivision: 4 })).toBe("1/4");
    expect(beatRepeatLabel({ beatRepeatLength: 1, beatRepeatSubdivision: 8 })).toBe("1/8");
    expect(beatRepeatLabel({ beatRepeatLength: 1, beatRepeatSubdivision: 16 })).toBe("1/16");
    expect(beatRepeatLabel({ beatRepeatLength: 1, beatRepeatSubdivision: 32 })).toBe("1/32");
  });

  it("lets the subdivision win — the micro zone pins length to 1, so it is the live half", () => {
    expect(beatRepeatLabel({ beatRepeatLength: 1, beatRepeatSubdivision: 8 })).toBe("1/8");
  });
});
