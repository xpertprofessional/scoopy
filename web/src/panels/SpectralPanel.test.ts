import { describe, expect, it } from "vitest";
import { chaosLabel, windowMs } from "./SpectralPanel.tsx";

// Parity checklist items 2 and 4 from docs/migration/panels/spectral.md §6.
describe("spectral display mappings", () => {
  it("texture nodes hit the spec values", () => {
    expect(windowMs(0)).toBeCloseTo(25, 0);
    expect(windowMs(2 / 5)).toBeCloseTo(120, 0);
    expect(windowMs(4 / 5)).toBeCloseTo(480, 0);
    expect(windowMs(1)).toBeCloseTo(960, 0);
  });

  it("interpolation is geometric, not arithmetic", () => {
    // Halfway between the 25 and 60 ms nodes: geometric mean ≈ 38.7, not 42.5.
    expect(windowMs(0.1)).toBeCloseTo(Math.sqrt(25 * 60), 1);
  });

  it("chaos edge labels", () => {
    expect(chaosLabel(-1)).toBe("roll");
    expect(chaosLabel(0)).toBe("metallic");
    expect(chaosLabel(1)).toBe("airy");
    expect(chaosLabel(0.5)).toBe("+0.50");
  });
});
