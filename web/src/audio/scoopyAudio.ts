/**
 * P8-2 — the main-thread side of the browser engine.
 *
 * Mounts the AudioWorklet, hands it the kit and the world, and gets out of the way. The audio
 * thread is the worklet; nothing here runs per block.
 *
 * ⚠️ NOT YET DRIVEN IN A REAL BROWSER. The engine is proven — it renders identically to macOS
 * (null test, −153 dBFS) and JavaScript already drives it across the C ABI and makes sound
 * (`engine/tools/wasm_smoke.mjs`, under node). What is unproven is the AudioWorklet shell itself:
 * whether the module loads in a worklet scope, and whether the timing holds under a real audio
 * clock. That is a hardware gate, not a test I can write.
 */

/**
 * One track, as the ENGINE sees it.
 *
 * ⚠️ THE FIELD LIST IS THE SESSION (P8-10a). The C ABI used to take twelve arguments and therefore
 * carried twelve of the engine's 125 track fields; every other field took its C++ default, and the
 * defaults are not "off" — they are a DIFFERENT TRACK. A band-pass track was not band-passed. A
 * trimmed sample played whole. Swing, accents, transpose, drive and multi-step cells did not exist.
 * Measured against the desktop at −3.2 dBFS peak — louder than the reference signal.
 *
 * Anything left `undefined` here keeps the engine's default, deliberately: that is how a field the
 * document does not carry stays out of the way. Anything SET must reach the engine, and
 * `engine/tools/abi_fidelity_test.cpp` is what proves it still does.
 */
export interface WorldTrack {
  sampleId: string;
  /** 0/1 per step. */
  steps: Uint8Array;

  // mix
  volume?: number;
  pan?: number;
  trackGain?: number;
  muted?: boolean;
  /** Mixer-true mute: user mute (native adds the solo mask) — the mute-GAIN kill, vs `muted`
   *  which is the trigger gate. Mirrors NativeTrackSnapshot.mixMuted / SL_T_MIX_MUTED. */
  mixMuted?: boolean;
  reversed?: boolean;
  polyphonic?: boolean;
  stereoMode?: number;
  outputAssign?: number;
  chokeGroup?: number;

  // filter
  tone?: number;
  toneQ?: number;
  filterDrive?: number;
  /** 0=tone 1=lowPass 2=highPass 3=bandPass 4=notch. */
  toneMode?: number;

  // sends
  send1Level?: number;
  send2Level?: number;
  send3Level?: number;
  send4Level?: number;

  // pitch / speed
  globalPitchOffset?: number;
  fineTuneCents?: number;
  tuningIndex?: number;
  speedMultiplier?: number;
  /** The step RATCHET density — the raw multiplier in every mode, where `speedMultiplier`
   *  carries only the mode-gated grain-pitch factor (Facade:2139-2142). */
  patternSpeedMultiplier?: number;
  melodicPitchMode?: boolean;
  preserveFormants?: boolean;
  useTimeStretch?: boolean;
  stretchEnabled?: boolean;
  stretchTimeOnly?: boolean;
  freeRateEnabled?: boolean;
  freeRate?: number;

  // sample region / playback
  sampleStartFrame?: number;
  sampleEndFrame?: number;
  playbackMode?: number;
  loopEnabled?: boolean;
  loopStartMs?: number;
  loopEndMs?: number;
  loopCrossfadeMs?: number;
  defaultChopIndex?: number;
  chopCount?: number;

  // envelope / feel
  attackPercent?: number;
  releasePercent?: number;
  fadeCurve?: number;
  swingAmount?: number;
  humanize?: number;
  preSilenceMs?: number;
  glidePercent?: number;
  ownerGate?: number;
  ownerAttack?: number;
  randomize?: boolean;
  playbackDirectionBackward?: boolean;

  // modulation
  lfo1PitchDepth?: number;
  lfo1VolDepth?: number;
  lfo1PanDepth?: number;
  lfo1FilterDepth?: number;
  lfo1GainDepth?: number;
  lfo2PitchDepth?: number;
  lfo2VolDepth?: number;
  lfo2PanDepth?: number;
  lfo2FilterDepth?: number;
  lfo2GainDepth?: number;
  lfo3PitchDepth?: number;
  lfo3VolDepth?: number;
  lfo3PanDepth?: number;
  lfo3FilterDepth?: number;
  lfo3GainDepth?: number;
  lfo4PitchDepth?: number;
  lfo4VolDepth?: number;
  lfo4PanDepth?: number;
  lfo4FilterDepth?: number;
  lfo4GainDepth?: number;
  grainModeEnabled?: boolean;
  grainRateMode?: number;
  grainRateHz?: number;
  grainSyncRatio?: number;
  grainLengthMs?: number;
  grainWindow?: number;
  grainScanPosition?: number;
  grainScanSpeed?: number;
  grainPitchSemitones?: number;
  grainRandomize?: number;
  grainKeyTrack?: boolean;
  locatorStartStep?: number;
  locatorEndStep?: number;
  locatorRepeatActive?: boolean;
  rhythmicOffset?: number;
  hasFlamCells?: boolean;
  hasChordCells?: boolean;
  lfo1FreeRateDepth?: number;
  lfo2FreeRateDepth?: number;
  lfo3FreeRateDepth?: number;
  lfo4FreeRateDepth?: number;

  // per-step arrays
  pitchOffsets?: number[];
  accentLevels?: number[];
  cellLengths?: number[];
  reverseSteps?: boolean[];
  glideSteps?: boolean[];
  volumeOffsets?: number[];
  mixVolumeOffsets?: number[];
  panOffsets?: number[];
  toneOffsets?: number[];
  sampleStartMsOffsets?: number[];
  sampleEndMsOffsets?: number[];
  preSilenceMsOffsets?: number[];
  cellChopIndices?: number[];
  send1Offsets?: number[];
  send2Offsets?: number[];
  send3Offsets?: number[];
  send4Offsets?: number[];
  flamCounts?: number[];
  rhythmicOffsetSteps?: number[];
  chopPoints?: number[];
  /** MAX_CHORD_NOTES-1 slots per step, zero-padded — semitones above the root. */
  chordIntervals?: number[];
}

export interface World {
  bpm: number;
  isPlaying: boolean;
  startStep: number;
  tracks: WorldTrack[];
}

/**
 * The engine's transport position, as mirrored by the worklet (scoopy-worklet.js — the C ABI has
 * no position query, so the worklet re-derives the step clock from the frames it rendered, with
 * the core's own integer math). Broadcast finer than one step; `time` is the AudioContext clock.
 */
export interface EnginePosition {
  playing: boolean;
  /** The master step counter — monotonic from play (which always starts at step 0 here). */
  step: number;
  /** Frames into the current step. */
  stepFrame: number;
  /** The current step length in frames (0 until the first play). */
  framesPerStep: number;
  /** AudioContext currentTime at broadcast, seconds. */
  time: number;
}

export class ScoopyAudio {
  private ctx: BaseAudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private ready = false;
  /** Messages posted but not yet acked by the worklet — see `flush()`. */
  private outstanding = 0;
  private flushWaiters: (() => void)[] = [];
  private processorError: string | null = null;
  private analyser: AnalyserNode | null = null;
  private meterBuf = new Float32Array(0);
  private lastPos: EnginePosition | null = null;
  private posCbs = new Set<(pos: EnginePosition) => void>();

  /**
   * Start the engine. MUST be called from a user gesture — every browser blocks an AudioContext
   * that was not, and the failure is silent-ish (the context sits `suspended` and nothing plays).
   *
   * `context` is for RENDERING OFFLINE: pass an `OfflineAudioContext` and the same engine, the same
   * worklet and the same C ABI render faster than realtime into a buffer you can actually assert on.
   * That is how the audio path is gated (`web/tools/browser_companion_audio_test.mjs`) — a live
   * context in a headless browser is a timing race, and "did it make a sound" deserves a hard answer.
   */
  async start(workletUrl: string, context?: BaseAudioContext): Promise<void> {
    if (this.ctx) return;

    const ctx = context ?? new AudioContext({ latencyHint: "interactive" });
    await ctx.audioWorklet.addModule(workletUrl);

    const node = new AudioWorkletNode(ctx, "scoopy-engine", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sampleRate: ctx.sampleRate },
    });

    await new Promise<void>((resolve, reject) => {
      // ONE persistent handler, installed before anything is sent. The worklet acks every message
      // it processes (scoopy-worklet.js:151) and `flush()` below is what those acks are for.
      node.port.onmessage = (e) => {
        const data = e.data as { type?: string; error?: string } | undefined;
        if (data?.type === "ready") {
          this.ready = true;
          resolve();
        } else if (data?.type === "error") {
          reject(new Error(data.error));
        } else if (data?.type === "ack") {
          this.outstanding = Math.max(0, this.outstanding - 1);
          if (this.outstanding === 0) {
            const waiters = this.flushWaiters;
            this.flushWaiters = [];
            waiters.forEach((done) => done());
          }
        } else if (data?.type === "pos") {
          // The transport mirror's broadcast — NOT acked (it is outbound-only telemetry). Message
          // events keep firing in a hidden tab (audio keeps running), so a scheduled scene switch
          // hooked here survives backgrounding where a rAF-driven check would stall.
          const pos = data as unknown as EnginePosition;
          this.lastPos = pos;
          this.posCbs.forEach((cb) => cb(pos));
        }
      };
    });

    // ⚠️ A throw inside `process()` does NOT surface as a console error or a page error — Chrome
    // kills the processor SILENTLY and the node outputs zeros forever. This is the only place it
    // appears, and a dead worklet is otherwise indistinguishable from a quiet one.
    node.onprocessorerror = () => {
      this.processorError = "the AudioWorklet processor died (see onprocessorerror)";
    };

    // An output tap. It is not decoration: it is the only way anything OUTSIDE the audio thread can
    // tell "the engine is running" from "the engine is running and producing silence" — and those
    // two look identical everywhere else (a dead worklet outputs zeros forever without a word). The
    // companion's transport meter reads it, and so does the shell's gate.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    this.meterBuf = new Float32Array(analyser.fftSize);

    node.connect(analyser);
    analyser.connect(ctx.destination);

    this.analyser = analyser;
    this.ctx = ctx;
    this.node = node;
  }

  /** RMS of the engine's output right now, 0 when idle. See the tap in `start()`. */
  level(): number {
    return this.levels().rms;
  }

  /** RMS + absolute peak in one pass over the same tap — the mixer's meter wants both. */
  levels(): { rms: number; peak: number } {
    if (!this.analyser) return { rms: 0, peak: 0 };
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let sumSquares = 0;
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const s = this.meterBuf[i]!;
      sumSquares += s * s;
      const abs = s < 0 ? -s : s;
      if (abs > peak) peak = abs;
    }
    return { rms: Math.sqrt(sumSquares / this.meterBuf.length), peak };
  }

  /**
   * Resolve once the worklet has processed everything sent so far.
   *
   * ⚠️ THIS IS NOT OPTIONAL FOR AN OfflineAudioContext, and the failure is silent. Offline rendering
   * runs FASTER than `postMessage` delivers, so without this the render finishes before the engine
   * ever hears about the kit or the world — and you get a buffer of confident silence that looks
   * exactly like a broken engine. In a live context the race is benign (messages land within a few
   * ms of realtime), which is precisely why it would never have been noticed until it mattered.
   */
  async flush(): Promise<void> {
    if (this.outstanding === 0) return;
    await new Promise<void>((resolve) => this.flushWaiters.push(resolve));
  }

  /** Set if the worklet's `process()` threw. Non-null means the engine is dead and silent. */
  get error(): string | null {
    return this.processorError;
  }

  /**
   * Give the engine a decoded sample. The worklet COPIES it into the WASM heap and frees the
   * transfer buffer, so the caller's AudioBuffer can be released.
   */
  registerSample(id: string, buffer: AudioBuffer): void {
    if (!this.node) throw new Error("engine not started");
    const left = buffer.getChannelData(0);
    const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : undefined;
    // Copy: `getChannelData` returns a view into the AudioBuffer, which is not transferable and
    // must not be detached by structuredClone.
    this.outstanding++;
    this.node.port.postMessage({
      type: "sample",
      id,
      left: new Float32Array(left),
      right: right ? new Float32Array(right) : undefined,
      sampleRate: buffer.sampleRate,
    });
  }

  /** Publish the world. Lock-free on the engine side; safe to call while playing. */
  publish(world: World): void {
    if (!this.node) throw new Error("engine not started");
    this.outstanding++;
    this.node.port.postMessage({ type: "world", ...world });
  }

  setMainGain(value: number): void {
    if (!this.node) return;
    this.outstanding++;
    this.node.port.postMessage({ type: "gain", value });
  }

  async stop(): Promise<void> {
    this.node?.port.postMessage({ type: "close" });
    this.node?.disconnect();
    // Only a live AudioContext holds a device to give back — an OfflineAudioContext has no `close()`
    // at all, and calling it would throw on the very path that renders the gate.
    const ctx = this.ctx;
    if (ctx instanceof AudioContext) await ctx.close();
    this.ctx = null;
    this.node = null;
    this.ready = false;
    this.lastPos = null;
  }

  get running(): boolean {
    return this.ready;
  }

  /**
   * Re-run a context that the OS paused. iOS suspends the AudioContext when the
   * tab backgrounds (WebKit parks it in a non-standard "interrupted" state) and
   * never resumes it by itself — without this the companion returns from the
   * home screen permanently silent. String-compare the state so the WebKit-only
   * value needs no type games. Offline contexts have no resume and are skipped.
   */
  async resume(): Promise<void> {
    const ctx = this.ctx;
    if (!(ctx instanceof AudioContext)) return;
    if (String(ctx.state) === "running") return;
    await ctx.resume();
  }

  /** The rate the engine was configured at — the DEVICE's rate, which is usually 48k, not 44.1k. */
  get sampleRate(): number | null {
    return this.ctx?.sampleRate ?? null;
  }

  /** The latest transport position, or null before the first broadcast / engine start. */
  position(): EnginePosition | null {
    return this.lastPos;
  }

  /** Subscribe to position broadcasts (~every 1024 frames). Survives across start/stop. */
  onPosition(cb: (pos: EnginePosition) => void): () => void {
    this.posCbs.add(cb);
    return () => this.posCbs.delete(cb);
  }
}
