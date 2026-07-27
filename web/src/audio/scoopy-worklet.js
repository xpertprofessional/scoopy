/**
 * P8-2 — the AudioWorklet driver. This is where the browser makes sound.
 *
 * The engine's `render()` was ALREADY an AudioWorklet callback in all but name — the desktop calls
 * it from a CoreAudio callback with the same contract (no allocation, no locks, fixed block). So
 * this file is a shell, not a port: it owns the WASM instance and hands `process()` straight to
 * `sl_render`.
 *
 * ⚠️ THINGS A WORKLET CANNOT DO, and how each is handled — these are the reasons a naive
 * Emscripten build fails here:
 *
 *   • NO `fetch`, NO `document`, NO `window`. So the module is built with `-sSINGLE_FILE=1`: the
 *     .wasm is embedded in the .js as base64 and there is no sidecar to load.
 *   • `process()` is SYNCHRONOUS, but WASM instantiation is ASYNC. So the constructor kicks off
 *     the load and `process()` OUTPUTS SILENCE until it lands. It must never block the audio
 *     thread waiting — that is a guaranteed glitch.
 *   • NO allocation on the audio thread. Every buffer this needs is malloc'd once, at init.
 *
 * The quantum is fixed at 128 frames by the spec. The engine is configured for exactly that, so a
 * block is never split or padded.
 */
import createScoopyEngine from "./scoopy-engine.js";

const QUANTUM = 128; // AudioWorklet's fixed render quantum — not a tunable

/**
 * ⚠️ `AudioWorkletGlobalScope` HAS NO `crypto`.
 *
 * It is one of the most stripped-down scopes on the platform — no `window`, no `document`, no
 * `fetch`, no `crypto`, no `setTimeout`. Emscripten's glue calls `crypto.getRandomValues` (for
 * `getentropy`), so the module throws `ReferenceError: crypto is not defined` the instant it
 * loads, and the worklet dies before `process()` is ever called.
 *
 * The engine does not need real entropy — nothing in the audio path is cryptographic — so a plain
 * deterministic PRNG is not just acceptable here, it is preferable: a deterministic worklet is one
 * you can null-test against a native render, which is exactly what we do.
 *
 * ⚠️ And it CANNOT be fixed with a dynamic import either: **`import()` is DISALLOWED on
 * WorkletGlobalScope** outright ("import() is disallowed on WorkletGlobalScope"). So the polyfill
 * has to sit in this module's body and rely on the fact that Emscripten touches `crypto` inside the
 * FACTORY (called from `boot()`), not at module top-level — which is why a static import is fine
 * and the order still works out.
 */
/**
 * ⚠️ …and no `performance` either.
 *
 * Emscripten's glue calls `performance.now()`. In a worklet that throws — and a throw inside
 * `process()` is the WORST failure mode on this platform: Chrome kills the processor SILENTLY.
 * No console error, no page error, no exception anywhere the app can see. The node just outputs
 * zeros forever and everything else looks healthy. It surfaces ONLY on
 * `AudioWorkletNode.onprocessorerror`, which is why the browser test hooks it — without that, a
 * broken worklet is indistinguishable from a quiet one.
 *
 * The worklet scope DOES give us `currentTime` (seconds, audio-clock), which is a better clock for
 * audio than the wall clock anyway.
 */
if (typeof globalThis.performance === "undefined") {
  globalThis.performance = {
    now() {
      return (typeof currentTime === "number" ? currentTime : 0) * 1000;
    },
  };
}

if (typeof globalThis.crypto === "undefined") {
  let seed = 0x9e3779b9 >>> 0;
  globalThis.crypto = {
    getRandomValues(array) {
      for (let i = 0; i < array.length; i++) {
        seed ^= seed << 13; seed >>>= 0;
        seed ^= seed >>> 17;
        seed ^= seed << 5; seed >>>= 0;
        array[i] = seed & 0xff;
      }
      return array;
    },
  };
}

// ─── the ABI's parameters, BY NAME ────────────────────────────────────────────────────────────
// Left: the field on a WorldTrack (worldFromSession.ts). Right: the name the ENGINE knows it by
// (sl_engine.h). The integers are resolved from the engine at boot via sl_param_id — JavaScript
// never hardcodes them, because a hand-mirrored enum lets a reorder write a value into the WRONG
// parameter, which is worse than not carrying it at all.
const SCALAR_FIELDS = [
  ["volume", "SL_T_VOLUME"], ["pan", "SL_T_PAN"], ["trackGain", "SL_T_TRACK_GAIN"],
  ["muted", "SL_T_MUTED"], ["mixMuted", "SL_T_MIX_MUTED"],
  ["reversed", "SL_T_REVERSED"], ["polyphonic", "SL_T_POLYPHONIC"],
  ["stereoMode", "SL_T_STEREO_MODE"], ["outputAssign", "SL_T_OUTPUT_ASSIGN"],
  ["chokeGroup", "SL_T_CHOKE_GROUP"],
  ["tone", "SL_T_TONE"], ["toneQ", "SL_T_TONE_Q"], ["toneMode", "SL_T_TONE_MODE"],
  ["filterDrive", "SL_T_FILTER_DRIVE"],
  ["send1Level", "SL_T_SEND1"], ["send2Level", "SL_T_SEND2"],
  ["send3Level", "SL_T_SEND3"], ["send4Level", "SL_T_SEND4"],
  ["globalPitchOffset", "SL_T_GLOBAL_PITCH"], ["fineTuneCents", "SL_T_FINE_TUNE_CENTS"],
  ["tuningIndex", "SL_T_TUNING_INDEX"], ["speedMultiplier", "SL_T_SPEED_MULTIPLIER"],
  ["patternSpeedMultiplier", "SL_T_PATTERN_SPEED_MULTIPLIER"],
  ["melodicPitchMode", "SL_T_MELODIC_PITCH_MODE"], ["preserveFormants", "SL_T_PRESERVE_FORMANTS"],
  ["useTimeStretch", "SL_T_USE_TIME_STRETCH"], ["stretchEnabled", "SL_T_STRETCH_ENABLED"],
  ["stretchTimeOnly", "SL_T_STRETCH_TIME_ONLY"],
  ["freeRateEnabled", "SL_T_FREE_RATE_ENABLED"], ["freeRate", "SL_T_FREE_RATE"],
  ["sampleStartFrame", "SL_T_SAMPLE_START_FRAME"], ["sampleEndFrame", "SL_T_SAMPLE_END_FRAME"],
  ["playbackMode", "SL_T_PLAYBACK_MODE"], ["loopEnabled", "SL_T_LOOP_ENABLED"],
  ["loopStartMs", "SL_T_LOOP_START_MS"], ["loopEndMs", "SL_T_LOOP_END_MS"],
  ["loopCrossfadeMs", "SL_T_LOOP_CROSSFADE_MS"],
  ["defaultChopIndex", "SL_T_DEFAULT_CHOP_INDEX"], ["chopCount", "SL_T_CHOP_COUNT"],
  ["attackPercent", "SL_T_ATTACK_PERCENT"], ["releasePercent", "SL_T_RELEASE_PERCENT"],
  ["fadeCurve", "SL_T_FADE_CURVE"], ["swingAmount", "SL_T_SWING_AMOUNT"],
  ["humanize", "SL_T_HUMANIZE"], ["preSilenceMs", "SL_T_PRE_SILENCE_MS"],
  ["glidePercent", "SL_T_GLIDE_PERCENT"],
  ["ownerGate", "SL_T_OWNER_GATE"], ["ownerAttack", "SL_T_OWNER_ATTACK"],
  ["randomize", "SL_T_RANDOMIZE"], ["playbackDirectionBackward", "SL_T_PLAYBACK_DIR_BACK"],
  ["lfo1PitchDepth", "SL_T_LFO1_PITCH_DEPTH"],
  ["lfo1VolDepth", "SL_T_LFO1_VOL_DEPTH"],
  ["lfo1PanDepth", "SL_T_LFO1_PAN_DEPTH"],
  ["lfo1FilterDepth", "SL_T_LFO1_FILTER_DEPTH"],
  ["lfo1GainDepth", "SL_T_LFO1_GAIN_DEPTH"],
  ["lfo2PitchDepth", "SL_T_LFO2_PITCH_DEPTH"],
  ["lfo2VolDepth", "SL_T_LFO2_VOL_DEPTH"],
  ["lfo2PanDepth", "SL_T_LFO2_PAN_DEPTH"],
  ["lfo2FilterDepth", "SL_T_LFO2_FILTER_DEPTH"],
  ["lfo2GainDepth", "SL_T_LFO2_GAIN_DEPTH"],
  ["lfo3PitchDepth", "SL_T_LFO3_PITCH_DEPTH"],
  ["lfo3VolDepth", "SL_T_LFO3_VOL_DEPTH"],
  ["lfo3PanDepth", "SL_T_LFO3_PAN_DEPTH"],
  ["lfo3FilterDepth", "SL_T_LFO3_FILTER_DEPTH"],
  ["lfo3GainDepth", "SL_T_LFO3_GAIN_DEPTH"],
  ["lfo4PitchDepth", "SL_T_LFO4_PITCH_DEPTH"],
  ["lfo4VolDepth", "SL_T_LFO4_VOL_DEPTH"],
  ["lfo4PanDepth", "SL_T_LFO4_PAN_DEPTH"],
  ["lfo4FilterDepth", "SL_T_LFO4_FILTER_DEPTH"],
  ["lfo4GainDepth", "SL_T_LFO4_GAIN_DEPTH"],
  ["grainModeEnabled", "SL_T_GRAIN_MODE_ENABLED"],
  ["grainRateMode", "SL_T_GRAIN_RATE_MODE"],
  ["grainRateHz", "SL_T_GRAIN_RATE_HZ"],
  ["grainSyncRatio", "SL_T_GRAIN_SYNC_RATIO"],
  ["grainLengthMs", "SL_T_GRAIN_LENGTH_MS"],
  ["grainWindow", "SL_T_GRAIN_WINDOW"],
  ["grainScanPosition", "SL_T_GRAIN_SCAN_POSITION"],
  ["grainScanSpeed", "SL_T_GRAIN_SCAN_SPEED"],
  ["grainPitchSemitones", "SL_T_GRAIN_PITCH_SEMITONES"],
  ["grainRandomize", "SL_T_GRAIN_RANDOMIZE"],
  ["grainKeyTrack", "SL_T_GRAIN_KEY_TRACK"],
  ["locatorStartStep", "SL_T_LOCATOR_START_STEP"],
  ["locatorEndStep", "SL_T_LOCATOR_END_STEP"],
  ["locatorRepeatActive", "SL_T_LOCATOR_REPEAT_ACTIVE"],
  ["rhythmicOffset", "SL_T_RHYTHMIC_OFFSET"],
  ["hasFlamCells", "SL_T_HAS_FLAM_CELLS"],
  ["hasChordCells", "SL_T_HAS_CHORD_CELLS"],
  ["lfo1FreeRateDepth", "SL_T_LFO1_FREE_RATE_DEPTH"],
  ["lfo2FreeRateDepth", "SL_T_LFO2_FREE_RATE_DEPTH"],
  ["lfo3FreeRateDepth", "SL_T_LFO3_FREE_RATE_DEPTH"],
  ["lfo4FreeRateDepth", "SL_T_LFO4_FREE_RATE_DEPTH"],
];

const ARRAY_FIELDS = [
  ["pitchOffsets", "SL_TA_PITCH_OFFSETS"], ["accentLevels", "SL_TA_ACCENT_LEVELS"],
  ["cellLengths", "SL_TA_CELL_LENGTHS"], ["reverseSteps", "SL_TA_REVERSE_STEPS"],
  ["glideSteps", "SL_TA_GLIDE_STEPS"], ["volumeOffsets", "SL_TA_VOLUME_OFFSETS"],
  ["mixVolumeOffsets", "SL_TA_MIX_VOLUME_OFFSETS"], ["panOffsets", "SL_TA_PAN_OFFSETS"],
  ["toneOffsets", "SL_TA_TONE_OFFSETS"],
  ["sampleStartMsOffsets", "SL_TA_SAMPLE_START_MS_OFFSETS"],
  ["sampleEndMsOffsets", "SL_TA_SAMPLE_END_MS_OFFSETS"],
  ["preSilenceMsOffsets", "SL_TA_PRE_SILENCE_MS_OFFSETS"],
  ["cellChopIndices", "SL_TA_CELL_CHOP_INDICES"],
  ["send1Offsets", "SL_TA_SEND1_OFFSETS"],
  ["send2Offsets", "SL_TA_SEND2_OFFSETS"],
  ["send3Offsets", "SL_TA_SEND3_OFFSETS"],
  ["send4Offsets", "SL_TA_SEND4_OFFSETS"],
  ["flamCounts", "SL_TA_FLAM_COUNTS"],
  ["rhythmicOffsetSteps", "SL_TA_RHYTHMIC_OFFSET_STEPS"],
  ["chopPoints", "SL_TA_CHOP_POINTS"],
  ["chordIntervals", "SL_TA_CHORD_INTERVALS"],
];

const SCALAR_PARAMS = SCALAR_FIELDS.map(([, name]) => name);
const ARRAY_PARAMS = ARRAY_FIELDS.map(([, name]) => name);

class ScoopyProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    this.ready = false;
    this.engine = 0;
    this.dying = false;

    // The audio thread starts pulling immediately; WASM will not be ready for a few ms. Silence is
    // the only honest thing to output until then.
    this.boot(options?.processorOptions ?? {}).catch((err) => {
      this.port.postMessage({ type: "error", error: String(err) });
    });

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  async boot({ sampleRate: sr = sampleRate } = {}) {
    const M = await createScoopyEngine();
    this.M = M;

    if (M.ccall("sl_engine_abi_version", "number", [], []) !== 2) {
      throw new Error("sl_engine ABI mismatch — rebuild the worklet against the engine");
    }

    this.api = {
      create: M.cwrap("sl_engine_create", "number", []),
      configure: M.cwrap("sl_engine_configure", "number", ["number", "number", "number"]),
      start: M.cwrap("sl_engine_start", "number", ["number"]),
      stop: M.cwrap("sl_engine_stop", null, ["number"]),
      registerSample: M.cwrap("sl_engine_register_sample", "number",
        ["number", "string", "number", "number", "number", "number"]),
      snapBegin: M.cwrap("sl_snapshot_begin", null, ["number", "number", "number", "number"]),
      trackBegin: M.cwrap("sl_snapshot_track_begin", null,
        ["number", "string", "number", "number"]),
      trackSet: M.cwrap("sl_snapshot_track_set", null, ["number", "number", "number"]),
      trackSetArray: M.cwrap("sl_snapshot_track_set_array", null,
        ["number", "number", "number", "number"]),
      trackEnd: M.cwrap("sl_snapshot_track_end", null, ["number"]),
      paramId: M.cwrap("sl_param_id", "number", ["string"]),
      arrayParamId: M.cwrap("sl_array_param_id", "number", ["string"]),
      snapCommit: M.cwrap("sl_snapshot_commit", "number", ["number"]),
      render: M.cwrap("sl_render", null, ["number", "number", "number", "number"]),
      setMainGain: M.cwrap("sl_engine_set_main_gain", null, ["number", "number"]),
    };

    // Resolve the parameter keys BY NAME, once. JavaScript never hardcodes the enum's integers: a
    // hand-mirrored table would let an enum reorder silently write a value into the WRONG parameter,
    // which is worse than not carrying it at all. An unknown name resolves to -1 and is ignored.
    this.P = {};
    for (const name of SCALAR_PARAMS) {
      const id = this.api.paramId(name);
      if (id < 0) throw new Error(`engine does not know parameter ${name}`);
      this.P[name] = id;
    }
    this.PA = {};
    for (const name of ARRAY_PARAMS) {
      const id = this.api.arrayParamId(name);
      if (id < 0) throw new Error(`engine does not know array parameter ${name}`);
      this.PA[name] = id;
    }

    this.engine = this.api.create();
    if (!this.engine) throw new Error("sl_engine_create failed");
    if (!this.api.configure(this.engine, sr, QUANTUM)) throw new Error("configure failed");
    if (!this.api.start(this.engine)) throw new Error("start failed");
    this.sr = sr;

    // THE TRANSPORT MIRROR. The C ABI exposes no position query (the core's masterStep/stepFrame
    // are private, sl_engine.h has no getter), so the worklet re-derives the step clock from the
    // frames IT rendered — which are exactly the frames the core's transport advanced by. Same
    // integer math as the core (NativeAudioEngineCore.cpp:4210-4212, :7149-7161): framesPerStep =
    // max(1102, floor(sr·60/(bpm·4))), advanced per rendered frame, tempo re-latched at step
    // boundaries. (Not mirrored: the core's >4× "turntable restart" immediate re-latch — a drastic
    // mid-play tempo jump can offset the mirror by under one step; the companion has no gesture
    // that does that.) Broadcast every 8 blocks = 1024 frames, which is LESS than the 1102-frame
    // step floor, so the main thread observes every step at least once — that bound is what the
    // scheduled scene switch relies on.
    this.pos = { playing: false, masterStep: 0, stepFrame: 0, currentFps: 0, targetFps: 0 };
    this.posBlockCounter = 0;

    // Allocated ONCE. `process()` must not allocate — see the header.
    this.lPtr = M._malloc(QUANTUM * 4);
    this.rPtr = M._malloc(QUANTUM * 4);

    this.ready = true;
    this.port.postMessage({ type: "ready" });
  }

  onMessage(msg) {
    if (!this.ready) {
      // Messages can beat the WASM load. Queue rather than drop — a kit that silently failed to
      // register is a session that plays silence and looks fine.
      (this.queued ??= []).push(msg);
      return;
    }
    this.handle(msg);
    if (this.queued) {
      const q = this.queued;
      this.queued = null;
      for (const m of q) this.handle(m);
    }
    // ACK. The caller needs to know the kit and the world actually LANDED before it starts audio.
    // postMessage is async, and an OfflineAudioContext renders faster than messages are delivered —
    // so without this the render can finish before the engine has ever heard of the samples, and
    // you get four seconds of confident silence. The same hazard exists live, just less visibly.
    this.port.postMessage({ type: "ack", for: msg.type });
  }

  handle(msg) {
    const { M, api, engine } = this;

    switch (msg.type) {
      case "sample": {
        // { id, left: Float32Array, right?: Float32Array, sampleRate }
        const n = msg.left.length;
        const lp = M._malloc(n * 4);
        M.HEAPF32.set(msg.left, lp >> 2);
        let rp = 0;
        if (msg.right) {
          rp = M._malloc(n * 4);
          M.HEAPF32.set(msg.right, rp >> 2);
        }
        api.registerSample(engine, msg.id, lp, rp, n, msg.sampleRate ?? sampleRate);
        // The engine COPIES (see sl_engine.h) — so the browser's decoded audio is freed here and
        // does not sit in the WASM heap twice.
        M._free(lp);
        if (rp) M._free(rp);
        break;
      }

      case "world": {
        // { bpm, isPlaying, startStep, tracks: [ WorldTrack ] } — see worldFromSession.ts.
        //
        // ⚠️ THE FIELD LIST IS THE SESSION. The old ABI took twelve arguments and therefore carried
        // twelve of the engine's 125 track fields; the rest defaulted, and the defaults are a
        // DIFFERENT TRACK (a band-pass track was not band-passed; a trimmed sample played whole).
        // Measured at −3.2 dBFS against the desktop — louder than the signal. Every field below now
        // crosses, addressed by a key the ENGINE named, not one JavaScript guessed.
        api.snapBegin(engine, msg.bpm, msg.isPlaying ? 1 : 0, msg.startStep | 0);

        for (const t of msg.tracks) {
          const sp = M._malloc(t.steps.length);
          M.HEAPU8.set(t.steps, sp);
          api.trackBegin(engine, t.sampleId, sp, t.steps.length);
          M._free(sp);

          for (const [field, name] of SCALAR_FIELDS) {
            const v = t[field];
            if (v === undefined || v === null) continue;   // unset → the engine's default stands
            api.trackSet(engine, this.P[name], typeof v === "boolean" ? (v ? 1 : 0) : v);
          }

          for (const [field, name] of ARRAY_FIELDS) {
            const arr = t[field];
            if (!arr || arr.length === 0) continue;
            const bytes = arr.length * 8;                   // doubles
            const ap = M._malloc(bytes);
            // One transfer type for every array — the engine narrows to its own (float, size_t,
            // bool, int). A per-type ABI would be four times the surface for no benefit.
            M.HEAPF64.set(Float64Array.from(arr, (x) => (typeof x === "boolean" ? (x ? 1 : 0) : x)), ap >> 3);
            api.trackSetArray(engine, this.PA[name], ap, arr.length);
            M._free(ap);
          }

          api.trackEnd(engine);
        }
        api.snapCommit(engine);

        // Keep the transport mirror in step with what the core just did with this world
        // (NativeAudioEngineCore.cpp:4213-4256): stop resets the transport; play seeds it only on
        // the FIRST play (currentFps 0); a mid-play republish is phase-continuous — the mirror,
        // like the core, keeps counting.
        {
          const p = this.pos;
          p.targetFps = Math.max(1102, Math.floor((this.sr * 60) / (msg.bpm * 4)));
          if (!msg.isPlaying) {
            p.playing = false;
            p.masterStep = 0;
            p.stepFrame = 0;
            p.currentFps = 0;
          } else {
            p.playing = true;
            if (p.currentFps === 0) {
              p.currentFps = p.targetFps;
              p.masterStep = msg.startStep | 0;
              p.stepFrame = 0;
            }
          }
        }
        break;
      }

      case "gain":
        api.setMainGain(engine, msg.value);
        break;

      case "close":
        this.dying = true;
        api.stop(engine);
        break;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    if (!out || out.length === 0) return !this.dying;

    // Not ready → silence. NEVER block the audio thread waiting for WASM.
    if (!this.ready) {
      for (const ch of out) ch.fill(0);
      return true;
    }

    const { M, api, engine, lPtr, rPtr } = this;
    api.render(engine, lPtr, rPtr, QUANTUM);

    // ⚠️ Re-derive the views EVERY block. With ALLOW_MEMORY_GROWTH the WASM heap can be replaced,
    // which DETACHES any cached ArrayBuffer view — and a detached view reads as silence. This is
    // the classic Emscripten audio bug: it works, then a sample is loaded, the heap grows, and the
    // output goes quiet forever with no error anywhere.
    const L = new Float32Array(M.HEAPF32.buffer, lPtr, QUANTUM);
    const R = new Float32Array(M.HEAPF32.buffer, rPtr, QUANTUM);

    out[0].set(L);
    if (out.length > 1) out[1].set(R);
    else out[0].set(L); // mono destination: left only, rather than a silent right

    // Advance the transport mirror by the frames just rendered, then broadcast on a cadence
    // guaranteed finer than one step (8 × 128 = 1024 < the 1102-frame step floor — see boot()).
    const p = this.pos;
    if (p.playing && p.currentFps > 0) {
      p.stepFrame += QUANTUM;
      while (p.stepFrame >= p.currentFps) {
        p.stepFrame -= p.currentFps;
        p.masterStep += 1;
        p.currentFps = p.targetFps; // tempo latches at the step boundary, like the core
      }
    }
    if (++this.posBlockCounter >= 8) {
      this.posBlockCounter = 0;
      this.port.postMessage({
        type: "pos",
        playing: p.playing,
        step: p.masterStep,
        stepFrame: p.stepFrame,
        framesPerStep: p.currentFps,
        time: currentTime,
      });
    }

    return !this.dying;
  }
}

registerProcessor("scoopy-engine", ScoopyProcessor);
