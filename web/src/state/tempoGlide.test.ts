import { describe, expect, it } from "vitest";
import { RAMP, glideStep } from "./tempoGlide.ts";
import { mapTapeRateOps, mapTempoIntents } from "../persist/tempo.ts";
import { emptyMap, type PlaneMap } from "../persist/mapDocument.ts";

/**
 * S3 — the motorised master tempo.
 *
 * `glideStep` is where everything that can be wrong about a ramp lives, so it
 * is pure and this is where the ramp is proved. The timer around it is a
 * `setInterval` calling it; the interesting part is the curve, and a curve that
 * is subtly wrong sounds like a tempo that "lags" or "snaps" and would never be
 * traced back to a constant.
 */

const TICK = 40; // the module's 25 Hz

/** Run the ramp to completion and report how long it took. */
function rampTo(from: number, to: number, seconds: number): { ticks: number; value: number } {
  let v = from;
  let ticks = 0;
  while (v !== to && ticks < 10_000) {
    v = glideStep(v, to, TICK, seconds);
    ticks++;
  }
  return { ticks, value: v };
}

describe("glideStep — the donor's exponential approach", () => {
  it("moves toward the target without overshooting", () => {
    const next = glideStep(120, 140, TICK, 0.3);
    expect(next).toBeGreaterThan(120);
    expect(next).toBeLessThan(140);
  });

  it("covers ~95% of the jump in the nominal ramp time (tau = duration/3)", () => {
    // The sizing that makes "0.3 s" mean the same thing here as in the donor.
    // After exactly one ramp-length of ticks, most of the distance is gone.
    const seconds = 0.4;
    let v = 120;
    for (let t = 0; t < Math.round((seconds * 1000) / TICK); t++) v = glideStep(v, 140, TICK, seconds);
    const covered = (v - 120) / 20;
    expect(covered).toBeGreaterThan(0.9);
    expect(covered).toBeLessThan(1.0);
  });

  it("arrives, rather than approaching forever", () => {
    // An exponential never mathematically reaches its target; without the snap
    // the timer would run for the life of the app, pushing tempo ops at 25 Hz.
    const { ticks, value } = rampTo(120, 140, 0.3);
    expect(value).toBe(140);
    expect(ticks).toBeLessThan(100);
  });

  it("a longer ramp takes more ticks — the setting does something", () => {
    expect(rampTo(120, 140, 1.0).ticks).toBeGreaterThan(rampTo(120, 140, 0.2).ticks);
  });

  it("rides DOWN as well as up — the tape stop is the point", () => {
    // Dragging toward 0 is the move this whole feature exists for.
    const { value, ticks } = rampTo(140, 20, 0.3);
    expect(value).toBe(20);
    expect(ticks).toBeGreaterThan(1); // it rode there, it did not jump
  });

  it("is already there when it is already there", () => {
    expect(glideStep(120, 120, TICK, 0.3)).toBe(120);
  });

  it("survives a zero ramp reaching it — the divisor is floored", () => {
    // The module catches ramp<=0 before starting a timer, but the pure function
    // must not produce NaN/Infinity if one ever arrives.
    // Measured: the 0.02 s floor makes ONE tick cover 99.75% of the jump, so it
    // lands on the next tick rather than the first — near-instant without ever
    // being NaN or Infinity, which is all this path is asked for.
    const v = glideStep(120, 140, TICK, 0);
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(139.9);
    expect(rampTo(120, 140, 0).ticks).toBeLessThanOrEqual(2);
  });

  it("keeps the donor's numbers", () => {
    expect(RAMP.def).toBe(0.3);
    expect(RAMP.min).toBe(0);
    expect(RAMP.max).toBe(5);
  });
});

describe("the live override reaches BOTH readers", () => {
  /** A map with one grid strip and one tape strip, both synced to the master. */
  const twoStrips = (): PlaneMap => {
    const m = emptyMap();
    m.transport.masterBpm = 140;
    m.strips = [
      {
        key: "g", name: "G", cell: { x: 0, y: 0, w: 340, h: 196 }, channel: 0, level: 1,
        mute: false, sends: [0, 0, 0, 0], drive: { curve: 0, amount: 1 }, recordArm: false,
        monitor: false, recordTap: null, sessionPerf: {},
        element: {
          kind: "grid", deck: 0, sessionId: "S", bpm: 140, syncToMaster: true,
          tempoMode: "timeStretch", pulseRelation: "auto", pitchMode: false,
          transpose: 0, launchRef: "auto",
        },
      },
      {
        key: "t", name: "T", cell: { x: 0, y: 0, w: 340, h: 196 }, channel: 1, level: 1,
        mute: false, sends: [0, 0, 0, 0], drive: { curve: 0, amount: 1 }, recordArm: false,
        monitor: false, recordTap: null, sessionPerf: {},
        element: {
          kind: "tape", index: 0, bpm: 140, syncToMaster: true,
          tempoMode: "timeStretch", rate: 1, pulseRelation: "auto",
        },
      },
    ] as PlaneMap["strips"];
    return m;
  };

  it("omitted, both fall back to the document — nothing changes at rest", () => {
    const m = twoStrips();
    expect(mapTempoIntents(m)[0]?.syncedBpm).toBeCloseTo(140, 3);
    expect(mapTapeRateOps(m)[0]?.rate).toBeCloseTo(1, 3);
  });

  it("supplied, BOTH follow it — or the decks ramp while the tapes jump", () => {
    // The defect this parameter exists to prevent, and the reason it is
    // threaded through mapTapeRateOps as well: mid-ramp the two tiers would be
    // running at different tempos, which nobody would think to look for.
    const m = twoStrips();
    // 100 rather than 70, and the reason is worth recording: at 70 against a
    // 140 deck the law's `auto` pulse resolves to 1:2 — the SAME pulse at half
    // time — so the ratio stays 1.0 and the override is invisible. That is the
    // law working exactly as `persist/tempo.ts` describes, and it makes an
    // octave a useless probe.
    const deckAtRest = mapTempoIntents(m)[0]!;
    const tapeAtRest = mapTapeRateOps(m)[0]!;
    const deck = mapTempoIntents(m, undefined, 100)[0]!;
    const tape = mapTapeRateOps(m, 100)[0]!;
    expect(deck.syncRatio).not.toBeCloseTo(deckAtRest.syncRatio, 3);
    expect(tape.rate).not.toBeCloseTo(tapeAtRest.rate, 3);
    // ⚠️ DELIBERATELY NOT ASSERTING A DIRECTION. The first cut expected both to
    // slow with the master and the deck went the other way: at 100 against a
    // 140 deck `auto` resolves toward a 3:2 pulse, so the ratio rises to ~1.07.
    // Which way a tier moves is the pulse resolver's business, and pinning a
    // direction here would be this test inventing a law it never checked. What
    // IS this parameter's business is that neither reader ignores it.
  });
});
