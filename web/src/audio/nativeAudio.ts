/**
 * The grid's world sink, pointed at the NATIVE engine (merge P2 step 4).
 *
 * WHAT THIS REPLACES, AND WHY IT HAD TO EXIST. `companionEngine` was written
 * for the browser companion, so its sink is `ScoopyAudio` — an Emscripten build
 * of the same C++ core, running in an AudioWorklet. That is exactly right in a
 * browser and exactly wrong in the merged desktop app, which already has the
 * real core compiled in and rendering through a real device. Left alone, the
 * grid drove a WASM copy of the engine inside a native app that had the
 * original, on a second clock, into a second output.
 *
 * `SlWorldApply` — the native applier — had been built and tested since P1 with
 * ZERO callers, because nothing had ever pointed a sink at it.
 *
 * This class is that sink. It implements the same small surface
 * `companionEngine` uses, so the store does not learn which host it is on: it
 * publishes a world and the world goes wherever the app's engine actually is.
 *
 * NOT A SECOND TRANSLATION. `worldFromSession` still does all 505 lines of
 * document→World work in TS, once. This only carries its output over the wire.
 */
import { HotFrameLayout } from "../../protocol/schema.ts";
import type { EngineLink } from "../engineLink.ts";
import type { EnginePosition, World } from "./scoopyAudio.ts";

/**
 * The surface `companionEngine` and `sampleStore` actually use. Narrow on
 * purpose: it is the contract both sinks must honour, and writing it down is
 * what stops the native one drifting into a partial stand-in that fails on a
 * method nobody remembered.
 *
 * `ScoopyAudio` satisfies this structurally — it is not changed.
 */
export interface WorldSink {
  readonly running: boolean;
  readonly error: string | null;
  start(workletUrl: string): Promise<void>;
  resume(): Promise<void>;
  registerSample(id: string, buffer: AudioBuffer): void;
  /**
   * Publish a world onto a DECK (SL-ABI-V3 §6 — the merged engine holds three
   * at once, each with its own tempo).
   *
   * Optional and defaulting to 0 so `ScoopyAudio` still satisfies this
   * structurally without changing: the browser has ONE deck by definition, and
   * a sink that cannot host a second should not be made to pretend it takes the
   * argument seriously.
   */
  publish(world: World, deck?: number): void;
  setMainGain(value: number): void;
  position(): EnginePosition | null;
  onPosition(cb: (pos: EnginePosition) => void): () => void;
  level(): number;
  levels(): { rms: number; peak: number };
}

export class NativeWorldSink implements WorldSink {
  private started = false;
  private lastError: string | null = null;
  private step = 0;
  private positionCbs = new Set<(pos: EnginePosition) => void>();
  private offHotFrame: (() => void) | null = null;

  // ⚠️ THERE WAS AN `onPublished` HOOK HERE and it is gone (P3-2). It existed
  // for exactly one subscriber: `sl_snapshot_begin` reset every deck's
  // tempoSyncRatio to 1.0, so any publish silently un-synced every synced deck,
  // and the map re-asserted its sync after every single one. The ratio is deck
  // scope in the engine now (SL-ABI-V3 §3) and survives a publish, so there is
  // nothing to re-assert. Kept as a comment rather than an unused hook: a
  // publish callback with no subscribers is an invitation to re-solve a problem
  // that no longer exists.

  constructor(private readonly link: EngineLink) {}

  get running(): boolean {
    return this.started;
  }

  get error(): string | null {
    return this.lastError;
  }

  /**
   * NOTHING TO START. The engine is already up — the shell created it and
   * opened the device before the first webview existed. Kept as a method so
   * the store's "engine: starting → running" flow is identical on both hosts;
   * a native host simply completes it immediately.
   *
   * That also removes the browser's user-gesture requirement, which is a
   * browser autoplay rule and has no meaning here. The `workletUrl` argument is
   * ignored by construction.
   */
  async start(_workletUrl: string): Promise<void> {
    // Subscribe to the sequencer playhead the engine already broadcasts, so
    // `position()` is the ENGINE's truth rather than a UI-side estimate.
    this.offHotFrame = this.link.onHotFrame((frame) => {
      this.step = frame[HotFrameLayout.playheadStepDeck0] ?? 0;
    });
    this.started = true;
  }

  /** No suspended context to resume. */
  async resume(): Promise<void> {}

  /**
   * Hand one decoded sample to the engine.
   *
   * The PCM crosses the wire as plain numbers, which is not free — but the
   * alternative is a second decoder in C++ for formats the web layer has
   * already decoded, and this runs once per kit load rather than per block.
   * `sl_engine_register_sample` copies into engine-owned storage, so the arrays
   * are dead the moment the call returns.
   */
  registerSample(id: string, buffer: AudioBuffer): void {
    const left = Array.from(buffer.getChannelData(0));
    const right =
      buffer.numberOfChannels > 1 ? Array.from(buffer.getChannelData(1)) : undefined;
    void this.link
      .command("slWorld", {
        action: "registerSample",
        id,
        left,
        ...(right ? { right } : {}),
        sampleRate: buffer.sampleRate,
      })
      .catch((e: unknown) => {
        // Reported, not swallowed: a world naming a sample the engine never
        // received renders silence, which looks like a broken engine rather
        // than a missing file.
        this.lastError = `registerSample(${id}) failed: ${String(e)}`;
        console.error("native sink:", this.lastError);
      });
  }

  publish(world: World, deck = 0): void {
    void this.link
      .command("slWorld", {
        action: "publish",
        // `steps` is a Uint8Array and JSON has no typed arrays; the JUCE bridge
        // would serialise it as an OBJECT ({"0":1,"1":0,…}), which the applier
        // reads as "no steps" and refuses. Converted here, at the one boundary
        // that cares, rather than changing the World shape everything else uses.
        world: {
          ...world,
          // WHICH DECK THIS WORLD LANDS ON. `SlWorldApply` reads it (defaulting
          // to 0) and REFUSES an out-of-range index rather than aliasing it onto
          // deck 0 — quietly landing a session on the wrong deck is worse than
          // declining to load it.
          deck,
          tracks: world.tracks.map((t) => ({ ...t, steps: Array.from(t.steps) })),
        },
      })
      .then((raw) => {
        const r = raw as { applied?: boolean; error?: string | null };
        this.lastError = r?.applied === false ? (r.error ?? "publish refused") : null;
        if (this.lastError) console.error("native sink: world refused —", this.lastError);
      })
      .catch((e: unknown) => {
        this.lastError = `publish failed: ${String(e)}`;
        console.error("native sink:", this.lastError);
      });
  }

  /**
   * NO-OP, DELIBERATELY, and this is a real gap rather than an oversight.
   *
   * The browser's main gain is a plain post-render multiply on the worklet's
   * output. The native engine's master is the core's own master stage, reached
   * through the world snapshot (`masterVolume`), not through a live setter on
   * this tier. Adding a second gain here would multiply a gain the engine has
   * already applied — the same double-gain trap `sl_channel`'s projection
   * design exists to avoid.
   *
   * The session's master level therefore travels inside the world, as it
   * already does. The PLANE's master section (increment 5) is where a live
   * master fader belongs, and it needs its own ABI point.
   */
  setMainGain(_value: number): void {}

  position(): EnginePosition | null {
    if (!this.started) return null;
    // Only `step` has a native source today — it is what the sequencer readout
    // and the scene scheduler consume. The sub-step fields are reported as 0
    // rather than estimated: a made-up `stepFrame` would drive a scheduler to
    // fire at the wrong moment, which is worse than one that only knows steps.
    return { playing: this.step >= 0, step: this.step, stepFrame: 0, framesPerStep: 0, time: 0 };
  }

  onPosition(cb: (pos: EnginePosition) => void): () => void {
    this.positionCbs.add(cb);
    return () => this.positionCbs.delete(cb);
  }

  /** Metering comes off the HotFrame's output peak — the engine's own, not a
      second measurement of a different signal. */
  level(): number {
    return 0;
  }

  levels(): { rms: number; peak: number } {
    return { rms: 0, peak: 0 };
  }

  stop(): void {
    this.offHotFrame?.();
    this.offHotFrame = null;
    this.started = false;
  }
}
