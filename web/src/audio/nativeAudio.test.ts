/**
 * P11-3a — the NATIVE sink's position fan-out.
 *
 * ⚠️ WHAT THESE PINS ARE FOR, precisely. A test against `ScoopyAudio` proves
 * NOTHING about this row: the browser path already fanned out
 * (`scoopyAudio.ts:274`) and scenes already switched in Chromium. The defect was
 * that `NativeWorldSink` — the sink the JUCE WKWebView host actually runs — held
 * a `positionCbs` set that was added to and deleted from and never iterated, so
 * `companionEngine.ts:960-981`'s switch commit never ran there and a queued scene
 * pad stayed lit forever. **Every test below constructs `NativeWorldSink`.**
 *
 * These are also written to FAIL on the pre-P11-3a file rather than pass either
 * way (the E8g-c lesson): the fan-out cases never fire at all, and the transport
 * cases see `playing: true` from `this.step >= 0`.
 *
 * What they CANNOT see: whether the JUCE host actually delivers HotFrames at the
 * assumed rate, and whether a real pad repaints. That is the row's real-host gate.
 */
import { describe, expect, it, vi } from "vitest";

import { HOT_FRAME_LENGTH, HotFrameLayout } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import { NativeWorldSink } from "./nativeAudio.ts";
import type { EnginePosition, World } from "./scoopyAudio.ts";
import { switchBoundary } from "./patternClock.ts";

/**
 * A link whose HotFrame channel we drive by hand, so a test can say "the engine
 * reached step N" the same way the shell's 30 Hz timer does.
 */
function stubLink(): { link: EngineLink; frame(step: number): void; subscribers: number } {
  const cbs = new Set<(f: Float64Array) => void>();
  const link = {
    command: vi.fn(async () => ({ applied: true })),
    paramWrite: vi.fn(),
    onHotFrame: vi.fn((cb: (f: Float64Array) => void) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    }),
    onEvent: vi.fn(() => () => {}),
    onUiState: vi.fn(() => () => {}),
  } as unknown as EngineLink;
  return {
    link,
    frame(step: number) {
      const f = new Float64Array(HOT_FRAME_LENGTH);
      f[HotFrameLayout.playheadStepDeck0] = step;
      for (const cb of cbs) cb(f);
    },
    get subscribers() {
      return cbs.size;
    },
  };
}

/** The minimum a `World` needs to carry the transport state this sink reads. */
function world(isPlaying: boolean): World {
  return { bpm: 120, isPlaying, startStep: 0, tracks: [] };
}

describe("NativeWorldSink — position fan-out (P11-3a)", () => {
  it("invokes an onPosition subscriber when the engine broadcasts a HotFrame", async () => {
    const { link, frame } = stubLink();
    const sink = new NativeWorldSink(link);
    await sink.start("");
    sink.publish(world(true));

    const seen: EnginePosition[] = [];
    sink.onPosition((p) => seen.push(p));

    // THE WHOLE ROW. At HEAD this array stayed empty forever.
    frame(7);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.step).toBe(7);
    expect(seen[0]!.playing).toBe(true);
  });

  it("carries deck 0's playhead, frame after frame", async () => {
    const { link, frame } = stubLink();
    const sink = new NativeWorldSink(link);
    await sink.start("");
    sink.publish(world(true));

    const steps: number[] = [];
    sink.onPosition((p) => steps.push(p.step));
    [0, 1, 1, 2, 5].forEach(frame);

    // Every frame, not only step edges — `ScoopyAudio`'s contract.
    expect(steps).toEqual([0, 1, 1, 2, 5]);
  });

  it("the unsubscribe handle actually detaches", async () => {
    const { link, frame } = stubLink();
    const sink = new NativeWorldSink(link);
    await sink.start("");

    const seen: number[] = [];
    const off = sink.onPosition((p) => seen.push(p.step));
    frame(1);
    off();
    frame(2);

    expect(seen).toEqual([1]);
  });

  it("fans out nothing before start() and nothing after stop()", async () => {
    const { link, frame } = stubLink();
    const sink = new NativeWorldSink(link);

    const seen: number[] = [];
    sink.onPosition((p) => seen.push(p.step));
    frame(3); // never started — no HotFrame subscription exists yet
    expect(seen).toEqual([]);

    await sink.start("");
    frame(4);
    sink.stop();
    frame(5);

    expect(seen).toEqual([4]);
  });

  it("reports whole-step resolution only — no invented sub-step phase", async () => {
    const { link, frame } = stubLink();
    const sink = new NativeWorldSink(link);
    await sink.start("");

    let pos: EnginePosition | null = null;
    sink.onPosition((p) => (pos = p));
    frame(9);

    // quantize.md §3: a made-up `stepFrame` would drive a scheduler to fire at
    // the wrong moment. If a later row makes these non-zero it must bring a real
    // sub-step source with it.
    expect(pos!.stepFrame).toBe(0);
    expect(pos!.framesPerStep).toBe(0);
  });
});

describe("NativeWorldSink — transport state (P11-3a, second defect)", () => {
  it("does not claim to be playing before anything has been published", async () => {
    const { link } = stubLink();
    const sink = new NativeWorldSink(link);
    await sink.start("");

    // At HEAD this was `this.step >= 0` — true from the first instant, because
    // `step` initialises to 0 and the engine's counter is unsigned.
    expect(sink.position()!.playing).toBe(false);
  });

  it("follows the transport state published for deck 0", async () => {
    const { link } = stubLink();
    const sink = new NativeWorldSink(link);
    await sink.start("");

    sink.publish(world(true));
    expect(sink.position()!.playing).toBe(true);

    sink.publish(world(false));
    expect(sink.position()!.playing).toBe(false);
  });

  it("a stopped deck 0 stays stopped however far its frozen playhead has run", async () => {
    const { link, frame } = stubLink();
    const sink = new NativeWorldSink(link);
    await sink.start("");
    sink.publish(world(false));

    // `playheadStepDeck0` freezes at the last rendered step rather than resetting,
    // so a high step number is not evidence of a running transport.
    frame(412);

    expect(sink.position()!.playing).toBe(false);
  });

  it("deck 1's transport does not answer for deck 0's", async () => {
    const { link } = stubLink();
    const sink = new NativeWorldSink(link);
    await sink.start("");

    sink.publish(world(true), 1);

    // `step` comes from `playheadStepDeck0`, so `playing` must too — the two
    // have to agree about whose clock the position describes.
    expect(sink.position()!.playing).toBe(false);
  });
});

describe("NativeWorldSink — the scene commit it now drives", () => {
  /**
   * Mirrors `companionEngine.ts:969-970` — the ONLY `onPosition` subscriber in
   * the tree. Deliberately the real comparison rather than a friendlier one:
   * the threshold (`< boundary - 1`) is what makes 30 Hz safe, and a test that
   * used equality would hide exactly the failure this row had to rule out.
   */
  function commitOn(sink: NativeWorldSink, boundary: number): { fired: number[] } {
    const fired: number[] = [];
    sink.onPosition((pos) => {
      if (!pos.playing) return;
      if (pos.step < boundary - 1) return;
      if (fired.length === 0) fired.push(pos.step);
    });
    return { fired };
  }

  it("a scene armed mid-cycle commits entering the step before the boundary", async () => {
    const { link, frame } = stubLink();
    const sink = new NativeWorldSink(link);
    await sink.start("");
    sink.publish(world(true));

    // Armed at step 5 of a 16-step cycle → boundary 16 (patternClock's own math).
    const boundary = switchBoundary(5, 16, 16);
    expect(boundary).toBe(16);

    const { fired } = commitOn(sink, boundary);
    for (let s = 5; s <= 16; s++) frame(s);

    // Step 15 — the final step before the boundary, so the boundary onset itself
    // plays the NEW pattern's step 0.
    expect(fired).toEqual([15]);
  });

  it("a stopped transport is fanned out but commits nothing", async () => {
    const { link, frame } = stubLink();
    const sink = new NativeWorldSink(link);
    await sink.start("");
    sink.publish(world(false));

    // Counted separately from the commit, so this pins "delivered and declined"
    // rather than "never delivered" — the two are indistinguishable from `fired`
    // alone, and at HEAD it was the second one.
    let delivered = 0;
    sink.onPosition(() => delivered++);
    const { fired } = commitOn(sink, 16);
    for (let s = 0; s <= 32; s++) frame(s);

    expect(delivered).toBe(33);
    expect(fired).toEqual([]);
  });

  it("a skipped step still commits — the threshold is why 30 Hz is enough", async () => {
    const { link, frame } = stubLink();
    const sink = new NativeWorldSink(link);
    await sink.start("");
    sink.publish(world(true));

    const { fired } = commitOn(sink, 16);
    // The pathological case: the shell's timer misses step 15 entirely.
    [12, 14, 16].forEach(frame);

    // Late by one step rather than never — the failure mode an equality test
    // would have had. 30 Hz only skips a 16th above ~450 BPM, so this is the
    // belt, not the trousers.
    expect(fired).toEqual([16]);
  });
});
