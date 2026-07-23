/*
 * wz_capture.h — host-tier C ABI for audio capture backends. (P2)
 *
 * The engine never sees a PID, an AudioObjectID, or a pw_stream — only
 * timestamped float blocks pushed into source rings. This interface is what the
 * platform backends (macOS process taps, Linux PipeWire, a deterministic fake
 * backend for fixtures) implement, in the `ScoopyLoops sl_host.h` idiom:
 *
 *  - STATUS ENUMS, not bools — a backend can degrade gracefully (UNSUPPORTED)
 *    rather than lie with a false.
 *  - Caller-owned string buffers; opaque UTF-8 ids.
 *  - POLLED topology generation, never callbacks into app code from HAL
 *    listeners (Scoopy's use-after-free lesson adopted as law).
 *  - PUSH-with-timestamps delivery: both real backends (CoreAudio IOProc,
 *    pw_stream process callback) are push, and every delivery carries
 *    host_time_ns + the actual sample_rate — the discipline that cannot be
 *    retrofitted (feasibility §4 flagged deviation, adopted).
 *
 * Dependency-free; includable from host TUs, the shell, and test tools.
 */
#ifndef WZ_CAPTURE_H
#define WZ_CAPTURE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define WZ_CAP_ABI_VERSION 1

/* Concurrent-tap cap (D-WZ-TAPCAP-01): soft — the manager refuses the 17th
 * tap, never tears an existing one down. Hardware inputs/decks don't count. */
#define WZ_CAP_MAX_CONCURRENT_TAPS 16

typedef struct wz_cap wz_cap;             /* a backend instance */
typedef struct wz_cap_handle wz_cap_handle; /* one open capture source */

/* Every entry point returns a status; OK == 0. UNSUPPORTED lets a platform
 * decline a capability (e.g. Linux system-mix-except in v1) without failing. */
typedef enum {
    WZ_CAP_OK = 0,
    WZ_CAP_ERR = 1,          /* generic backend failure */
    WZ_CAP_UNSUPPORTED = 2,  /* capability absent on this platform */
    WZ_CAP_NOT_FOUND = 3,    /* source id no longer resolves */
    WZ_CAP_PERMISSION = 4,   /* TCC / capture permission denied */
    WZ_CAP_AT_CAPACITY = 5,  /* WZ_CAP_MAX_CONCURRENT_TAPS reached (D-WZ-TAPCAP-01) */
    WZ_CAP_BAD_ARG = 6,
} wz_cap_status;

/* Source polarity (schema SourceKind subset the capture layer produces). */
typedef enum {
    WZ_SRC_PROCESS = 0,            /* one application's output */
    WZ_SRC_SYSTEM_MIX_EXCEPT = 1,  /* everything EXCEPT a set of processes */
    WZ_SRC_DEVICE_INPUT = 2,       /* a hardware input (same-clock path) */
    WZ_SRC_VIRTUAL_INPUT = 3,      /* the "Wizard Out" virtual device's monitor */
} wz_cap_kind;

typedef struct {
    const char* id;    /* opaque UTF-8, stable across a topology generation */
    const char* name;  /* human label ("Spotify") for the picker */
    wz_cap_kind kind;
    int32_t pid;       /* process id where meaningful, else -1 */
    uint32_t channels; /* current channel count (may change → formatChanged) */
} wz_cap_source_info;

/* Control-thread lifecycle. */
wz_cap_status wz_cap_create(const char* backend_name, wz_cap** out); /* "fake"/"mac"/"pipewire" */
void          wz_cap_destroy(wz_cap*);
int32_t       wz_cap_abi_version(void);
uint32_t      wz_cap_active_tap_count(const wz_cap*);

/* Enumeration — POLLED, never callback-driven (Scoopy law). Refresh snapshots
 * the current topology; count/info read that snapshot; the generation number
 * bumps whenever the snapshot would differ, so the UI polls one integer. */
wz_cap_status wz_cap_refresh_sources(wz_cap*);
uint64_t      wz_cap_topology_generation(const wz_cap*);
uint32_t      wz_cap_source_count(const wz_cap*);
wz_cap_status wz_cap_source_info_at(const wz_cap*, uint32_t index, wz_cap_source_info* out);

/* Delivery: PUSH with timestamps. `interleaved` is `frames`×`channels` float32;
 * `host_time_ns` is the block's presentation host time; `sample_rate` is the
 * ACTUAL rate right now (carried every delivery so a mid-stream format change
 * is just deliveries at the new rate). Host glue is one line: forward to
 * wz_source_write. Called on the backend's capture thread. */
typedef void (*wz_cap_deliver)(void* ctx, const float* interleaved,
                               uint32_t frames, uint32_t channels,
                               double sample_rate, uint64_t host_time_ns);

/* Out-of-band events, delivered on the CONTROL thread (never the audio thread):
 * a format renegotiation, a vanished source, a denied permission. */
typedef enum {
    WZ_CAP_EVT_FORMAT_CHANGED = 0,
    WZ_CAP_EVT_SOURCE_GONE = 1,
    WZ_CAP_EVT_PERMISSION_DENIED = 2,
} wz_cap_event;
typedef void (*wz_cap_notify)(void* ctx, wz_cap_event evt);

/* Open a capture source by id. Returns WZ_CAP_AT_CAPACITY once 16 taps are live
 * (D-WZ-TAPCAP-01). `deliver`/`notify` fire with `ctx`. */
wz_cap_status wz_cap_open(wz_cap*, const char* source_id,
                          wz_cap_deliver deliver, wz_cap_notify notify, void* ctx,
                          wz_cap_handle** out);
wz_cap_status wz_cap_close(wz_cap_handle*);

/* --- fake backend control (test-only; a no-op WZ_CAP_UNSUPPORTED on real
 * backends) — lets fixtures publish a synthetic topology and drive delivery at
 * a chosen rate/drift deterministically, no threads, no real audio. */
wz_cap_status wz_cap_fake_add_source(wz_cap*, const char* id, const char* name,
                                     wz_cap_kind kind, uint32_t channels);
wz_cap_status wz_cap_fake_remove_source(wz_cap*, const char* id);
/* Synthesize + deliver `frames` of a sine at `freq_hz` on every channel of the
 * open handle, timestamped from a clock running at `actual_rate` (which may
 * differ from the nominal rate the engine thinks — that IS the drift the ASRC
 * must correct). Advances the fake host clock. */
wz_cap_status wz_cap_fake_deliver(wz_cap_handle*, uint32_t frames, double freq_hz,
                                  double actual_rate);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* WZ_CAPTURE_H */
