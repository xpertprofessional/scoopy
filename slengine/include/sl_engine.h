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

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* SL_ENGINE_V3_H */
