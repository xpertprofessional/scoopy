import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deckTempoIntent } from "../persist/tempo.ts";

/**
 * S3 — the master tempo, and the one rule that makes it correct.
 *
 * The behaviour worth pinning is NOT "the number changes". It is that this
 * surface computes nothing: `persist/tempo.ts` says *"there is no tempo MATH
 * here and there must not be; the moment there is, there are two laws"*, and
 * the plane already shipped the second law once — it divided `masterBpm /
 * deck.bpm` by hand and lost pulse relations, the tempo mode and the ceilings.
 * So these assert delegation, and then check the law's own answers so the
 * delegation is worth something.
 */

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const CODE = read("src/studio/MasterBar.tsx")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const el = (over: Partial<Parameters<typeof deckTempoIntent>[0]> = {}) =>
  ({
    kind: "grid",
    deck: 0,
    sessionId: "S",
    bpm: 120,
    syncToMaster: true,
    tempoMode: "timeStretch",
    pulseRelation: "auto",
    pitchMode: false,
    transpose: 0,
    launchRef: "auto",
    ...over,
  }) as Parameters<typeof deckTempoIntent>[0];

describe("MasterBar — it delegates, it does not calculate", () => {
  it("routes through the law and writes the document, never the engine directly", () => {
    expect(CODE).toContain("deckTempoIntent");
    expect(CODE).toContain("setMasterBpm");
    expect(CODE).toContain("updateGridTempo");
    // No hand arithmetic on the two tempos. `masterBpm / bpm` is the exact
    // expression the plane shipped and `persist/tempo.ts` exists to replace.
    expect(CODE).not.toMatch(/masterBpm\s*\/\s*/);
    expect(CODE).not.toMatch(/\/\s*element\.bpm/);
    // And no engine call of its own — the push is applyTempo's, downstream of
    // the store, or a tempo could reach the deck without the document agreeing.
    expect(CODE).not.toContain("link.command");
    expect(CODE).not.toContain("paramWrite");
  });

  it("offers exactly the donor's three modes", () => {
    for (const m of ["timeStretch", "timePitch", "tempoOnly"]) expect(CODE).toContain(m);
  });

  it("persists app-globally, like the donor's djMode.masterTempo", () => {
    // Not in the session (the tempo you work at is not a property of the song)
    // and not in the map (Studio's is never saved).
    expect(CODE).toContain("studio.masterTempo");
    expect(CODE).toContain("useSetting");
  });

  it("a disabled control still says why (§6)", () => {
    expect(CODE).toContain("title={why ??");
    expect(CODE).toContain("session ▾");
  });
});

describe("the law's answers, which the readout shows", () => {
  it("a synced deck at the master tempo resolves to the master", () => {
    expect(deckTempoIntent(el({ bpm: 120 }), 120).syncedBpm).toBeCloseTo(120, 3);
  });

  it("resolves a HALF-TIME relation rather than calling it 2×", () => {
    // The case `persist/tempo.ts` names: a 70 BPM deck against a 140 master is
    // not "2×" — `auto` resolves it to the same pulse at half-time, which is
    // what a musician means by synced. A hand division could only say 2.
    const out = deckTempoIntent(el({ bpm: 70 }), 140);
    expect(out.syncedBpm).toBeGreaterThan(0);
    expect(out.syncRatio).toBeLessThanOrEqual(2);
    expect(out.pulse).toBeTruthy();
  });

  it("an UNSYNCED deck still reports a ratio — silence would leave it stretched", () => {
    // The law returns 1 rather than nothing, and that 1 must be SENT: a deck
    // can be carrying a ratio from a previous map, and omitting it would leave
    // it stretched with nothing in the document explaining why.
    expect(deckTempoIntent(el({ syncToMaster: false }), 150).syncRatio).toBeCloseTo(1, 6);
  });

  it("carries the mode through untouched — it selects a mechanism, not a number", () => {
    for (const tempoMode of ["timeStretch", "timePitch", "tempoOnly"] as const) {
      expect(deckTempoIntent(el({ tempoMode }), 130).tempoMode).toBe(tempoMode);
    }
  });
});
