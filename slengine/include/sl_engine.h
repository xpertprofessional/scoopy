/* SL ABI v3 — the merged engine's C surface.
 *
 * Design of record: docs/merge/SL-ABI-V3.md (P0-C). This header is WIZARD-OWNED
 * and lands in the merged repo first; shipping scoopy stays on v2 until the P3
 * ownership flip.
 *
 * ⚠️ v3 REUSES v2's SPELLINGS WITH DIFFERENT SIGNATURES (sl_engine_create,
 * sl_render, …). That is deliberate — v3 is a clean break, not a coexistence —
 * and it means the v3 library and the vendored v2 library (vendor/scoopy/engine,
 * still built for scoopy's own gates) MUST NEVER share a link line. They cannot:
 * this target links the vendored CORE (scoopy_engine) and not the vendored ABI,
 * so v2's include dir is not on this target's search path. If someone ever wires
 * both in, the duplicate C symbols fail the link loudly, which is the correct
 * failure for a mistake of that shape.
 *
 * Implemented so far (ABI.md rule: declare only what is implemented) —
 * identity, lifecycle, rate, and planar render. The deck surface (§5), world
 * builder (§4), keyed params (§3), session snapshots (§6), transport (§7) and
 * HotFrame (§8) are NOT declared here until they exist. No dead ABI.
 */
#ifndef SL_ENGINE_V3_H
#define SL_ENGINE_V3_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SL_ABI_VERSION 3
#define SL_PARAM_UNKNOWN (-1)

typedef struct sl_engine sl_engine;

/* Renamed from v2's sl_engine_abi_version per ABI.md's naming rule. */
int32_t sl_abi_version(void);

/* Unified create — kills v2's create/configure split (§1). Returns NULL if the
 * engine could not be configured at this rate/block, so a half-built engine is
 * never handed back.
 *
 * `schema_version` is carried for the HotFrame slot-0 echo (§1): a stale
 * shell/UI pairing must be loudly detectable at runtime rather than silently
 * mis-indexed. HotFrame does not exist yet, so until it does the value is
 * readable through sl_engine_schema_version() — that getter is the interim
 * observation point, not a permanent part of the design. */
sl_engine* sl_engine_create(double sample_rate,
                            uint32_t max_block_frames,
                            int32_t schema_version);
void sl_engine_destroy(sl_engine* e);

int  sl_engine_start(sl_engine* e);   /* 1 on success, 0 on failure */
void sl_engine_stop(sl_engine* e);

/* D-WZ-RATE-01: the graph runs at the OUTPUT DEVICE rate. A rate change tears
 * down and rebuilds at the host layer; the engine never re-clocks silently.
 *
 * REFUSED WHILE RUNNING (returns 0, previous rate stands): reconfiguring
 * reallocates the buffers the render callback is reading, so the host must
 * sl_engine_stop() first, set the rate, then sl_engine_start() again. This is
 * the engine half of D-WZ-RATE-01 — the refusal is the guarantee, not a
 * limitation to work around. Also returns 0 for a non-positive rate. */
int      sl_engine_set_sample_rate(sl_engine* e, double sample_rate);
double   sl_engine_sample_rate(const sl_engine* e);
uint32_t sl_engine_max_block_frames(const sl_engine* e);
int32_t  sl_engine_schema_version(const sl_engine* e);

/* How many output buses this build can emit — the compiled-in lane count. A
 * caller asking for more than this gets the buses that exist and no more. */
uint32_t sl_engine_max_out_buses(void);

/* Planar render (§2). Replaces v2's hardcoded sl_render(L, R, frames).
 *
 * `bus_out` is an array of `bus_count` pointers, each to `frames` floats. Bus
 * order is the engine's lane order: 0 = main L, 1 = main R, then sends, cue,
 * per-deck outs and FX-return wets. The desktop passes the full lane set and
 * maps it through the host's output map; the WASM companion passes
 * bus_count = 2 and gets main L/R — v2's stereo behaviour is now simply the
 * narrowest call, not a separate shape.
 *
 * Buses beyond the engine's lane count are left UNTOUCHED, not zeroed: the
 * caller owns those buffers and may be mixing something else into them.
 *
 * RT-safe: no locks, no allocation, no exceptions crossing the boundary.
 * `frames` greater than the configured max_block_frames renders nothing —
 * the engine never renders past the block it allocated for.
 *
 * sl_render_io additionally takes `in_count` input buses on the SAME callback
 * and the same clock (zero SRC, D-WZ-RATE-01) — this is what beat-synced deck
 * recording reads. sl_render is the no-input case. */
void sl_render_io(sl_engine* e,
                  const float* const* in_bus, uint32_t in_count,
                  float* const* bus_out, uint32_t bus_count,
                  uint32_t frames);
void sl_render(sl_engine* e,
               float* const* bus_out, uint32_t bus_count,
               uint32_t frames);

/* ── Session snapshots (§6) ─────────────────────────────────────────────────
 *
 * The world a deck plays: samples, tracks, per-step patterns. Built
 * incrementally and published to the audio thread by one lock-free commit.
 *
 * Track parameters are KEYED BY NAME, never by hardcoded integer. Resolve once
 * at boot and cache the ints. The mapping behind these names is GENERATED from
 * the pinned v2 ABI (web/scripts/generateTrackParams.ts) rather than
 * hand-written, because a hand-mirrored table's failure mode is a value written
 * silently into the WRONG parameter — worse than one not carried at all. */

/** Register decoded audio under `sample_id`. The engine COPIES, so the caller
    may free `left`/`right` immediately. `right` NULL = mono (duplicated).
    Returns 1 on success. */
int sl_engine_register_sample(sl_engine* e,
                              const char* sample_id,
                              const float* left,
                              const float* right,
                              uint32_t frames,
                              double sample_rate);

/** Begin a new world for `deck`. Any snapshot in progress is discarded.
    Returns 1 if the build started, 0 if it was refused.

    ⚠️ THE DECK AXIS IS DECLARED BUT ONLY DECK 0 IS IMPLEMENTED. §6 specifies up
    to 8 coexisting session worlds; the vendored core holds exactly one
    sequencer state, and giving it more is a CORE change that must happen in
    apps/scoopy (the only writable home until the P3 flip) — not here. So the
    axis is in the signature, where §6 puts it, and any deck > 0 is REFUSED
    rather than silently writing over deck 0's world. A refusal is a bug report;
    a silent aliasing is a mystery. */
int sl_snapshot_begin(sl_engine* e, uint32_t deck, double bpm, int is_playing, int32_t start_step);

/** Begin a track. `steps` is `step_count` bytes (0/1). Returns 1 on success. */
int sl_snapshot_track_begin(sl_engine* e,
                            const char* sample_id,
                            const uint8_t* steps,
                            uint32_t step_count);

/** Set a scalar / per-step array on the track in progress. An unknown key is
    IGNORED, never misread — that is the point of resolving by name. */
void sl_snapshot_track_set(sl_engine* e, int32_t param, double value);
void sl_snapshot_track_set_array(sl_engine* e, int32_t param, const double* values, uint32_t count);

/** Push the track in progress into the pending world. */
void sl_snapshot_track_end(sl_engine* e);

/** Resolve a track parameter by name; SL_PARAM_UNKNOWN if unknown.
    (v2 spelled these sl_param_id / sl_array_param_id — renamed in v3 to free
    the deck-scope param namespace, SL-ABI-V3.md §3.) */
int32_t sl_track_param_id(const char* name);
int32_t sl_track_array_id(const char* name);

/** Introspection, so a host can enumerate rather than hardcode. */
uint32_t    sl_track_param_count(void);
uint32_t    sl_track_array_count(void);
const char* sl_track_param_name(uint32_t id);  /* NULL if out of range */
const char* sl_track_array_name(uint32_t id);

/** Publish the pending world to the audio thread. Returns the world generation,
    or 0 if nothing was published. */
uint64_t sl_snapshot_commit(sl_engine* e);

/* ── HotFrame (§8) — 30 Hz engine→UI telemetry ──────────────────────────────
 *
 * One flat Float64 frame the caller emits at ~30 Hz. The layout is scoopy's
 * (schema.ts `HOT_FRAME_SCALARS`, generated into the native index header), so
 * the UI reads each slot by the position it expects — hand-counting an index
 * would make a meter read a neighbour's value.
 *
 * Refuse-short-buffer, never truncate (wz law): if `capacity` is less than
 * `sl_hotframe_length()`, nothing is written and 0 is returned. Otherwise the
 * frame is fully written (0-filled where v3 has no source yet) and the length
 * returned. Lock-free reads of state the render loop already maintains; safe
 * off the audio thread. */
uint32_t sl_hotframe_length(void);
uint32_t sl_hotframe(sl_engine* e, double* out, uint32_t capacity);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* SL_ENGINE_V3_H */
