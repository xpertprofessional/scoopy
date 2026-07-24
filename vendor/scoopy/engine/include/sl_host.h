/* ─────────────────────────────────────────────────────────────────────────────────────────────
 * XP-6b — `sl_host.h`, the HOST half of the C ABI. Design: docs/migration/XP-6B-HOST-ABI.md.
 *
 * `sl_engine.h` carries the audio. This carries the things a desktop host must do AROUND the
 * audio — enumerate devices, open one, notice when the machine's audio topology changes.
 *
 * WHY IT EXISTS. Device enumeration lives twice today: `AudioDeviceManager.swift` is ~1,600 lines
 * of raw CoreAudio HAL, while the device is actually OPENED by `NativeJuceDeviceHost` in C++ —
 * through JUCE, which already abstracts CoreAudio, WASAPI and ALSA. The Swift half is Apple-only,
 * so a second shell would have to reimplement it from scratch to reach a service JUCE already
 * ships. Pushing it down here is what decides whether the Windows/Linux shell costs 2k lines or
 * 20k: with it, a shell shrinks to transport + windows + dialogs + lifecycle.
 *
 * DESIGN NOTES, because the shape is not arbitrary:
 *
 *   • CHANGE NOTIFICATION IS POLLED, NOT A CALLBACK. `sl_host_topology_generation` returns a
 *     counter that ticks whenever the device set changes; the shell re-enumerates when it moves.
 *     A C callback firing from CoreAudio's HAL thread into Swift/Rust would re-import every
 *     threading hazard the vendored-JUCE HAL-listener-liveness patch exists to contain (a
 *     device-change arriving during teardown was a real use-after-free crash). The shell already
 *     polls at 30 Hz for the HotFrame, so this costs nothing. ⚠️ Do not "improve" this into a
 *     callback without re-reading that patch in juce_CoreAudio_mac.cpp.
 *
 *   • DEVICE IDS ARE OPAQUE UTF-8 STRINGS, not CoreAudio's AudioDeviceID (a uint32 that is
 *     Apple-only and not stable across reboots). The host mints them; callers only ever compare
 *     and pass them back.
 *
 *   • NOT COMPILED INTO WASM. A browser has no device selection — that is a stated non-goal of the
 *     companion, not a gap. This header is desktop-only by construction.
 *
 *   • CONTROL PLANE ONLY. Nothing here is callable from the render callback.
 *
 *   • Strings are written into caller-owned buffers with an in/out length, so the ABI never hands
 *     back memory the caller has to free. Every call is nothrow and status-returning.
 * ───────────────────────────────────────────────────────────────────────────────────────────── */
#ifndef SL_HOST_H
#define SL_HOST_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Status codes. 0 is success; everything else is a reason, not a bool. */
typedef enum sl_host_status {
    SL_HOST_OK = 0,
    SL_HOST_ERR_INVALID_ARG = 1,
    SL_HOST_ERR_NOT_FOUND = 2,   /* no device with that id */
    SL_HOST_ERR_OPEN_FAILED = 3, /* the driver refused, or the format is unsupported */
    SL_HOST_ERR_NO_DEVICE = 4    /* the call needs an open device and there is none */
} sl_host_status;

/* Opaque handle. One per process — see the DJ note on sl_host_create. */
typedef struct sl_host sl_host;

/* A device as the shell should present it. `id` is what you pass back to open it. */
typedef struct sl_device_info {
    const char* id;        /* NUL-terminated, owned by the host, valid until the next enumerate */
    const char* name;      /* human-readable, for the picker */
    uint32_t input_channels;
    uint32_t output_channels;
    uint32_t is_default;   /* 1 if this is the system default OUTPUT device */
} sl_device_info;

/* What the driver actually gave us, which is frequently not what was asked for. */
typedef struct sl_device_status {
    double sample_rate;
    uint32_t block_frames;
    uint32_t input_channels;
    uint32_t output_channels;
    uint32_t output_latency_frames;
    uint32_t is_open;
} sl_device_status;

/* ── lifecycle ─────────────────────────────────────────────────────────────────────────────────
 * The host owns the device stack; engines attach to it.
 *
 * ⚠️ PROCESS-LEVEL, not per-engine. DJ mode runs FOUR engines against ONE device, so a host per
 * engine would have four objects contending to open the same hardware. `sl_host_attach_engine`
 * is how an engine joins the render; the arbiter's owner concept stays above this ABI.
 */
sl_host* sl_host_create(void);
void     sl_host_destroy(sl_host* h);

/* ── enumeration ───────────────────────────────────────────────────────────────────────────────
 * `sl_host_refresh_devices` takes the snapshot; `_count`/`_info` read it. Two calls, so a shell
 * can iterate a stable list instead of racing a device that vanishes mid-loop.
 */
sl_host_status sl_host_refresh_devices(sl_host* h);
uint32_t       sl_host_device_count(sl_host* h);
sl_host_status sl_host_device_info(sl_host* h, uint32_t index, sl_device_info* out);

/* ── open / close ──────────────────────────────────────────────────────────────────────────────
 * `sample_rate` 0 or `block_frames` 0 means "the device's own default".
 */
sl_host_status sl_host_open_device(sl_host* h, const char* device_id,
                                   double sample_rate, uint32_t block_frames);
sl_host_status sl_host_close_device(sl_host* h);
sl_host_status sl_host_device_status(sl_host* h, sl_device_status* out);

/* Id of the currently open device, written into `buf` (NUL-terminated, truncated to `buf_len`).
 * Returns SL_HOST_ERR_NO_DEVICE when nothing is open. */
sl_host_status sl_host_current_device_id(sl_host* h, char* buf, size_t buf_len);

/* ── topology changes ──────────────────────────────────────────────────────────────────────────
 * Monotonic. Poll it; re-enumerate when it moves. See the design note above on why this is not a
 * callback — the answer is a use-after-free crash we already fixed once.
 */
uint64_t sl_host_topology_generation(sl_host* h);

/* ── MIDI port enumeration ─────────────────────────────────────────────────────────────────────
 * The listing half only. Opening a port, binding clock/note output, and clock config all touch the
 * shipping MIDI path (NativeMidiHost, MIDIManager) and belong to the cutover slice; they are not
 * here yet. Enumeration is pure and side-effect-free, exactly like the device listing above.
 *
 * Port ids are JUCE's own `MidiDeviceInfo::identifier` — already a STABLE opaque string per OS
 * ("coremidi:...", and the winmm/ALSA equivalents), so unlike the audio devices there is nothing
 * to mint. This is the schema change the design flags: MIDIUniqueID (int32) becomes an opaque id.
 */
typedef struct sl_midi_port_info {
    const char* id;    /* stable opaque id, owned by the host, valid until the next refresh */
    const char* name;  /* human-readable, for the picker */
} sl_midi_port_info;

/* Snapshot the current input and output ports. Cheap (a static JUCE query), but still explicit so a
 * caller iterates a stable list rather than racing a port that appears or vanishes mid-loop. */
sl_host_status sl_host_refresh_midi(sl_host* h);
uint32_t       sl_host_midi_in_count(sl_host* h);
sl_host_status sl_host_midi_in_info(sl_host* h, uint32_t index, sl_midi_port_info* out);
uint32_t       sl_host_midi_out_count(sl_host* h);
sl_host_status sl_host_midi_out_info(sl_host* h, uint32_t index, sl_midi_port_info* out);

/* ── mic input ─────────────────────────────────────────────────────────────────────────────────
 * ⚠️ Its OWN call, deliberately not folded into sl_host_open_device. Input channel selection
 * changes independently of opening a device (the user picks channel 3 of an interface that is
 * already running), and folding it in would force a device reopen — an audible dropout — to change
 * an input channel. `channel` is a 0-based index into the device's inputs; `stereo` pairs it with
 * channel+1.
 */
sl_host_status sl_host_set_input_channel(sl_host* h, uint32_t channel, uint32_t stereo);

#ifdef __cplusplus
}  /* extern "C" */
#endif

#endif /* SL_HOST_H */
