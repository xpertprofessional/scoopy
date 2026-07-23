/*
 * wz_engine.h — flat C ABI for the Wizard engine core. ABI v1.
 *
 * Contract (see docs/ARCHITECTURE.md §3):
 *  - KEYED, not positional: parameters are addressed by name at the boundary.
 *    Callers resolve names to ids once at boot via wz_param_id_for_name();
 *    hardcoding integer ids outside this header is a defect.
 *  - Unknown names return WZ_PARAM_UNKNOWN and writes to it are ignored,
 *    never misread.
 *  - Params carry a CHANNEL index from day one (Wizard is a mixer): the shape
 *    is wz_param_set(e, channel, id, value). The current param set is master-
 *    global (mainGain), which ignores `channel`; per-channel gain/pan/sends
 *    populate the channel dimension in P1 without re-laying-out this ABI.
 *  - Every field that crosses this boundary is tracked by the ABI coverage
 *    gate (P0-08): carried end-to-end or waived with a reason.
 *  - Dependency-free; includable from the JUCE shell, test tools, and a future
 *    WASM build unchanged.
 *
 * This header is the P0 subset. World/topology (wz_world_*), source rings
 * (wz_source_*), decks (wz_deck_*), and the plugin-insert callback land in
 * their phases (P1–P6) — declared only when implemented, never as dead ABI.
 */
#ifndef WZ_ENGINE_H
#define WZ_ENGINE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define WZ_ABI_VERSION 1
#define WZ_PARAM_UNKNOWN (-1)

typedef struct wz_engine wz_engine;

/* ABI version of the compiled library (compare against WZ_ABI_VERSION). */
int32_t wz_abi_version(void);

/* schema_version is echoed in hotframe slot 0 so a stale shell/UI pairing is
 * loudly detectable at runtime, not just at handshake time.
 * sample_rate = the OUTPUT DEVICE rate (D-WZ-RATE-01: the engine graph runs at
 * the device rate). max_block_frames = the device quantum (D-WZ-CLOCK-01). */
wz_engine* wz_engine_create(double sample_rate,
                            uint32_t max_block_frames,
                            int32_t schema_version);
void wz_engine_destroy(wz_engine* e);

/* The host device layer chunks its device blocks to max_block_frames when
 * driving wz_engine_render. 0 for a null engine. */
uint32_t wz_engine_max_block_frames(const wz_engine* e);

/* The host reports the real device rate here after opening the device
 * (D-WZ-RATE-01). RT-safe atomic. A rate CHANGE tears down + rebuilds the
 * engine at the host layer (loud notice) rather than re-clocking silently;
 * this setter exists so the initial open and future time-based DSP share one
 * truth. Rejects non-positive rates. */
void wz_engine_set_sample_rate(wz_engine* e, double sample_rate);
double wz_engine_sample_rate(const wz_engine* e);

/* --- keyed parameter access ------------------------------------------- */
int32_t wz_param_id_for_name(const char* name); /* WZ_PARAM_UNKNOWN if unknown */
uint32_t wz_param_count(void);
const char* wz_param_name(uint32_t id); /* NULL if out of range */
/* RT-safe, atomic. `channel` selects the strip; master-global params (mainGain)
 * ignore it. Unknown id is a no-op. */
void wz_param_set(wz_engine* e, uint32_t channel, int32_t id, double value);
double wz_param_get(const wz_engine* e, uint32_t channel, int32_t id);

/* --- boot tone (P0 walking-skeleton affordance) -----------------------
 * Toggles a low-level (-18 dBFS) 440 Hz sine on the main bus so the whole
 * device→engine→meter→UI path is provable before real channels exist. Default
 * OFF (the engine boots silent). Removed when P1 builds channels; the metering
 * it exercises stays. RT-safe. */
void wz_engine_set_test_tone(wz_engine* e, uint32_t enabled);

/* --- audio ------------------------------------------------------------- */
/* Renders `frames` (<= max_block_frames) into `bus_count` output buffers, one
 * pointer per output channel in `bus_out` (the host maps up to 8 output buses +
 * monitor to device channels — ARCHITECTURE §3). Real-time safe: no locks, no
 * allocation, no IO. Advances the monotonic engine clock by exactly `frames`.
 * P0: renders silence into every buffer (no world/sources yet) while exercising
 * the clock, mainGain path, and metering taps. */
void wz_engine_render(wz_engine* e,
                      float* const* bus_out,
                      uint32_t bus_count,
                      uint32_t frames);

/* --- hotframe ----------------------------------------------------------
 * Fills `out` with up to `capacity` doubles per the generated index map
 * (shell/generated/WZProtocol.h). Returns the number of values written, or 0
 * if capacity < the frame length (a short buffer is refused, not truncated). */
uint32_t wz_engine_hotframe(const wz_engine* e, double* out, uint32_t capacity);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* WZ_ENGINE_H */
