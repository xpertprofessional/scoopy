/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * XP-5 / P8-2 — `sl_engine.h`, the C ABI.
 *
 * Phase 7 recorded this row as "there is none today", and there wasn't: `grep 'extern "C"'` across
 * the engine returned nothing. Every caller was Swift, reaching into C++ through an Objective-C++
 * bridge. That works exactly once — on a Mac.
 *
 * This is the boundary the engine actually needs: a flat C surface with no C++ types, no
 * exceptions, no ownership subtleties. Emscripten exports it directly to JavaScript, so the
 * AudioWorklet calls the SAME functions any future host would.
 *
 * DESIGN NOTES, because the shape is not arbitrary:
 *
 *   • The snapshot is BUILT INCREMENTALLY (begin → add_track → commit) rather than passed as one
 *     struct. `NativeSequencerSnapshot` is a tree of `std::vector`s; flattening it into a C struct
 *     would mean inventing a second serialization format and keeping it in step with the first.
 *     Building it call-by-call keeps ONE definition of the truth — the C++ struct — and the ABI
 *     just fills it.
 *
 *   • `sl_render` takes ONLY main L/R, not all ~28 lanes. A browser has two output channels; the
 *     send/cue/deck lanes exist for hardware routing that the companion explicitly does not offer
 *     (P8-9). They are still rendered internally — the sends still feed the delay and reverb, so
 *     the SOUND is unchanged — they are simply not handed out.
 *
 *   • Everything is nothrow and returns a status. An exception crossing a WASM boundary is not a
 *     debuggable event.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */
#ifndef SL_ENGINE_H
#define SL_ENGINE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct sl_engine sl_engine;

/* Create / destroy. Returns NULL on failure. */
sl_engine* sl_engine_create(void);
void sl_engine_destroy(sl_engine* e);

/**
 * Configure and start. `block_frames` should be the host's quantum — 128 in an AudioWorklet.
 * Returns 1 on success, 0 on failure.
 */
int sl_engine_configure(sl_engine* e, double sample_rate, uint32_t block_frames);
int sl_engine_start(sl_engine* e);
void sl_engine_stop(sl_engine* e);

/**
 * Register decoded audio. The engine COPIES the samples, so the caller may free `left`/`right`
 * immediately — which matters in WASM, where the JS side owns the heap and would otherwise have to
 * keep every kit sample alive forever.
 *
 * `right` may be NULL for mono. Returns 1 on success.
 */
int sl_engine_register_sample(sl_engine* e,
                              const char* sample_id,
                              const float* left,
                              const float* right,
                              uint32_t frames,
                              double sample_rate);

/* ── Snapshot building ──────────────────────────────────────────────────────────────────────── */

/** Begin a new world. Any snapshot in progress is discarded. */
void sl_snapshot_begin(sl_engine* e, double bpm, int is_playing, int32_t start_step);

/**
 * Track parameters, addressed BY KEY.
 *
 * ⚠️ THIS REPLACED A TWELVE-ARGUMENT `sl_snapshot_add_track`, AND THE REASON IS P8-10(a): that
 * function carried twelve of `NativeTrackSnapshot`'s 125 fields, and every other field took its C++
 * default. The defaults are not "off" — they are a DIFFERENT TRACK. `toneMode` defaulted to the
 * legacy tone tilt, so a band-pass track was not band-passed. `sampleStartFrame` defaulted to 0, so
 * a trimmed sample played from the top. Swing, accents, transpose, drive and multi-step cells simply
 * did not exist. Measured: rendering one ordinary scene through the old ABI diverged from the
 * desktop by **−3.2 dBFS peak — louder than the reference signal**. The browser was not playing the
 * session; it was playing a reduction of it, silently, and every test passed because every test sat
 * on one side of the ABI or the other (`tools/abi_fidelity_test.cpp`).
 *
 * WHY KEYS AND NOT A STRUCT. The old header's instinct was right — "a struct would have to be laid
 * out identically on both sides, and the first time someone reordered a field the failure would be
 * silent and audible" — and it is *more* true across a WASM heap, where JS would be writing raw
 * offsets. But the answer is not a wider argument list (125 arguments is not an interface). Keys are
 * layout-free: adding a parameter is a new enum value, never a re-layout, and an unknown key is
 * ignored rather than misread. One call per field per track happens on PUBLISH, not per block, so
 * the cost is irrelevant.
 *
 * Scalars all travel as `double` — it is lossless for every float, int, bool and enum below, and one
 * setter is harder to misuse than four.
 */
typedef enum {
    /* mix */
    SL_T_VOLUME = 0,          /* float  */
    SL_T_PAN,                 /* float  */
    SL_T_TRACK_GAIN,          /* float — >1 engages the per-track clipper */
    SL_T_MUTED,               /* bool   */
    SL_T_REVERSED,            /* bool   */
    SL_T_POLYPHONIC,          /* bool   */
    SL_T_STEREO_MODE,         /* enum StereoMode */
    SL_T_OUTPUT_ASSIGN,       /* int    */
    SL_T_CHOKE_GROUP,         /* uint8  */

    /* filter */
    SL_T_TONE,                /* float  */
    SL_T_TONE_Q,              /* float  */
    SL_T_FILTER_DRIVE,        /* float  — resonance drive 0…100; saturates the SVF band-pass state */
    SL_T_TONE_MODE,           /* enum NativeToneFilter::Mode — 0=tone 1=lowPass 2=highPass 3=bandPass 4=notch */

    /* sends */
    SL_T_SEND1,               /* float  */
    SL_T_SEND2,
    SL_T_SEND3,
    SL_T_SEND4,

    /* pitch / speed */
    SL_T_GLOBAL_PITCH,        /* double — semitones */
    SL_T_FINE_TUNE_CENTS,     /* double */
    SL_T_TUNING_INDEX,        /* int    */
    SL_T_SPEED_MULTIPLIER,    /* double */
    SL_T_MELODIC_PITCH_MODE,  /* bool   */
    SL_T_PRESERVE_FORMANTS,   /* bool   */
    SL_T_USE_TIME_STRETCH,    /* bool   */
    SL_T_STRETCH_ENABLED,     /* bool   */
    SL_T_STRETCH_TIME_ONLY,   /* bool   */
    SL_T_FREE_RATE_ENABLED,   /* bool   */
    SL_T_FREE_RATE,           /* double */

    /* sample region / playback */
    SL_T_SAMPLE_START_FRAME,  /* size_t — trim start; 0 = beginning */
    SL_T_SAMPLE_END_FRAME,    /* size_t — trim end;   0 = full length */
    SL_T_PLAYBACK_MODE,       /* enum   */
    SL_T_LOOP_ENABLED,        /* bool   */
    SL_T_LOOP_START_MS,       /* double */
    SL_T_LOOP_END_MS,         /* double */
    SL_T_LOOP_CROSSFADE_MS,   /* double */
    SL_T_DEFAULT_CHOP_INDEX,  /* int    */
    SL_T_CHOP_COUNT,          /* int    */

    /* envelope / feel */
    SL_T_ATTACK_PERCENT,      /* float  */
    SL_T_RELEASE_PERCENT,     /* float  */
    SL_T_FADE_CURVE,          /* double */
    SL_T_SWING_AMOUNT,        /* double — 0..1 */
    SL_T_HUMANIZE,            /* double */
    SL_T_PRE_SILENCE_MS,      /* double */
    SL_T_GLIDE_PERCENT,       /* double */
    SL_T_OWNER_GATE,          /* float  */
    SL_T_OWNER_ATTACK,        /* float  */
    SL_T_RANDOMIZE,           /* bool   */
    SL_T_PLAYBACK_DIR_BACK,   /* bool   */

    /* modulation — the LFO depths a composer actually turns. Added with the coverage check
       (engine/tools/check-abi-coverage.mjs), which now FAILS if a new engine field reaches
       neither the browser nor the allowlist. */
    SL_T_LFO1_PITCH_DEPTH,
    SL_T_LFO1_VOL_DEPTH,
    SL_T_LFO1_PAN_DEPTH,
    SL_T_LFO1_FILTER_DEPTH,
    SL_T_LFO1_GAIN_DEPTH,
    SL_T_LFO2_PITCH_DEPTH,
    SL_T_LFO2_VOL_DEPTH,
    SL_T_LFO2_PAN_DEPTH,
    SL_T_LFO2_FILTER_DEPTH,
    SL_T_LFO2_GAIN_DEPTH,
    SL_T_LFO3_PITCH_DEPTH,
    SL_T_LFO3_VOL_DEPTH,
    SL_T_LFO3_PAN_DEPTH,
    SL_T_LFO3_FILTER_DEPTH,
    SL_T_LFO3_GAIN_DEPTH,
    SL_T_LFO4_PITCH_DEPTH,
    SL_T_LFO4_VOL_DEPTH,
    SL_T_LFO4_PAN_DEPTH,
    SL_T_LFO4_FILTER_DEPTH,
    SL_T_LFO4_GAIN_DEPTH,
    SL_T_GRAIN_MODE_ENABLED,
    SL_T_GRAIN_RATE_MODE,
    SL_T_GRAIN_RATE_HZ,
    SL_T_GRAIN_SYNC_RATIO,
    SL_T_GRAIN_LENGTH_MS,
    SL_T_GRAIN_WINDOW,
    SL_T_GRAIN_SCAN_POSITION,
    SL_T_GRAIN_SCAN_SPEED,
    SL_T_GRAIN_PITCH_SEMITONES,
    SL_T_GRAIN_RANDOMIZE,
    SL_T_GRAIN_KEY_TRACK,
    SL_T_LOCATOR_START_STEP,
    SL_T_LOCATOR_END_STEP,
    SL_T_LOCATOR_REPEAT_ACTIVE,
    SL_T_RHYTHMIC_OFFSET,
    SL_T_HAS_FLAM_CELLS,

    SL_T_HAS_CHORD_CELLS,
    SL_T_LFO1_FREE_RATE_DEPTH,
    SL_T_LFO2_FREE_RATE_DEPTH,
    SL_T_LFO3_FREE_RATE_DEPTH,
    SL_T_LFO4_FREE_RATE_DEPTH,

    /* Mixer-true mute: user mute OR solo mask, decomposed from SL_T_MUTED (which keeps the
     * stop/pause TRIGGER gate). Drives the per-track mute-gain ramp — immediate audio kill
     * on ringing voices. Append-only position (keyed setters must keep their numbering). */
    SL_T_MIX_MUTED,           /* bool   */

    /* The step RATCHET/density multiplier — always the track's raw speedMultiplier, in every
     * speed mode (AudioEngineFacade.swift:2142), where SL_T_SPEED_MULTIPLIER carries only the
     * mode-gated GRAIN-PITCH factor. Without this key the core kept its 1.0 default and a ×2
     * track played at 1:1 density in the browser. Append-only position. */
    SL_T_PATTERN_SPEED_MULTIPLIER, /* double */

    SL_T_SCALAR_COUNT
} sl_track_param;

/** Per-step arrays. All travel as `double[step_count]`; the engine narrows to its own type. */
typedef enum {
    SL_TA_PITCH_OFFSETS = 0,
    SL_TA_ACCENT_LEVELS,
    SL_TA_CELL_LENGTHS,
    SL_TA_REVERSE_STEPS,
    SL_TA_GLIDE_STEPS,
    SL_TA_VOLUME_OFFSETS,
    SL_TA_MIX_VOLUME_OFFSETS,
    SL_TA_PAN_OFFSETS,
    SL_TA_TONE_OFFSETS,
    SL_TA_SAMPLE_START_MS_OFFSETS,
    SL_TA_SAMPLE_END_MS_OFFSETS,
    SL_TA_PRE_SILENCE_MS_OFFSETS,
    SL_TA_CELL_CHOP_INDICES,

    SL_TA_SEND1_OFFSETS,
    SL_TA_SEND2_OFFSETS,
    SL_TA_SEND3_OFFSETS,
    SL_TA_SEND4_OFFSETS,
    SL_TA_FLAM_COUNTS,
    SL_TA_RHYTHMIC_OFFSET_STEPS,
    SL_TA_CHOP_POINTS,

    SL_TA_CHORD_INTERVALS,

    SL_TA_COUNT
} sl_track_array;

/**
 * Begin a track. `steps` is `step_count` bytes (0/1). Every other field starts at the engine's
 * default and is set by the calls below; `sl_snapshot_track_end` pushes it into the pending world.
 */
void sl_snapshot_track_begin(sl_engine* e,
                             const char* sample_id,
                             const uint8_t* steps,
                             uint32_t step_count);

/** Set a scalar on the track in progress. An unknown key is IGNORED, never misread. */
void sl_snapshot_track_set(sl_engine* e, int param, double value);

/** Set a per-step array on the track in progress. `count` should be the track's step count. */
void sl_snapshot_track_set_array(sl_engine* e, int param, const double* values, uint32_t count);

/** Push the track in progress into the pending world. */
void sl_snapshot_track_end(sl_engine* e);

/**
 * Resolve a parameter key BY NAME ("SL_T_TONE_MODE" → SL_T_TONE_MODE). Returns -1 if unknown.
 *
 * ⚠️ THIS EXISTS SO JAVASCRIPT NEVER HARDCODES THE ENUM. A JS copy of these integers is a
 * hand-mirrored table, and this codebase has been bitten by hand-mirrored tables before — the
 * failure mode is that a field is silently written into the WRONG parameter, which is worse than
 * not being carried at all. The worklet resolves the names it needs ONCE at boot and caches the
 * ints; from then on publishing is integer calls. Unknown name → -1 → the setter ignores it.
 */
int sl_param_id(const char* name);
int sl_array_param_id(const char* name);

/** Commit the snapshot to the audio thread (lock-free publish). Returns the world generation. */
uint64_t sl_snapshot_commit(sl_engine* e);

/* ── Render ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * Render `frames` into main L/R. This IS the AudioWorklet callback — the core's `render()` was
 * already shaped like one; this only narrows ~28 lanes to the two a browser has.
 *
 * Realtime-safe: no allocation, no locks, no exceptions.
 */
void sl_render(sl_engine* e, float* out_left, float* out_right, uint32_t frames);

/** Master output gain (the mixer's main gain), 0…1+. */
void sl_engine_set_main_gain(sl_engine* e, float gain);

/** ABI version — bump on any breaking change; the JS side asserts on it. */
uint32_t sl_engine_abi_version(void);
#define SL_ENGINE_ABI_VERSION 2u  /* 2: keyed track params (P8-10a) — the 12-field add_track is gone */

#ifdef __cplusplus
}  /* extern "C" */
#endif

#endif /* SL_ENGINE_H */
