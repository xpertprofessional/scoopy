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
/* RT-safe, atomic. `channel` selects the strip in the CURRENT world;
 * master-global params (mainGain) ignore it. Unknown id or out-of-range
 * channel is a no-op. Control-thread single-writer (the message thread). */
void wz_param_set(wz_engine* e, uint32_t channel, int32_t id, double value);
double wz_param_get(const wz_engine* e, uint32_t channel, int32_t id);

/* --- world (topology) ----------------------------------------------------
 * Snapshot builder + RCU commit (docs/ARCHITECTURE.md §2 graph.cpp). The
 * CONTROL thread builds a world off the render path; wz_world_commit installs
 * it with one atomic pointer swap (lock-free publish — the render thread picks
 * it up at its next block). TS owns the document: builder values ARE the
 * document's values (a ParamWrite racing a commit self-heals on the next
 * publish, which carries the same params).
 *
 * Channel FIELDS are keyed by name like params: resolve once at boot via
 * wz_world_key_for_name ("srcKind","srcChan0","srcChan1","toMonitor","gain",
 * "pan","mute","solo","deckIndex"); unknown key writes are ignored, never
 * misread. srcKind values follow the schema enum order: 0 none · 1 deviceInput
 * · 2 deck · 3 appTap · 4 systemMixExcept · 5 virtualDeviceInput · 6 busTap.
 * All world calls are control-thread only, not RT-safe. */
void wz_world_begin(wz_engine* e); /* discards any unfinished builder */
int32_t wz_world_key_for_name(const char* name); /* WZ_PARAM_UNKNOWN if unknown */
uint32_t wz_world_channel_begin(wz_engine* e, const char* channel_key);
void wz_world_channel_set(wz_engine* e, int32_t key, double value);
void wz_world_channel_end(wz_engine* e);
uint64_t wz_world_commit(wz_engine* e); /* returns the new revision; without a
                                           begin() it is a no-op returning the
                                           current revision */
uint32_t wz_world_channel_count(const wz_engine* e);
uint64_t wz_world_revision(const wz_engine* e);
/* Deck count 1-8 is a world property (how many deck HotFrame blocks publish);
 * the deck UNITS themselves are stable engine objects that survive commits. */
void wz_world_set_deck_count(wz_engine* e, uint32_t count); /* builder-scoped */
uint32_t wz_world_deck_count(const wz_engine* e);

/* --- source rings (P2: async-clock capture) ------------------------------
 * A per-source SPSC lock-free ring, opened from the control thread, written by
 * ONE host capture thread, read by the render thread / ASRC. Every write
 * carries {host_time_ns, source_rate} -- the timestamp discipline the ASRC
 * needs (D-WZ-CLOCK-01). Device inputs on the duplex clock do NOT use rings
 * (same-clock, D-WZ-RATE-01); rings are for taps, the virtual-device input, and
 * anything independently clocked. The strip<->ring binding (a source-kind strip
 * reads its ring through the ASRC) lands in P2-03/04; P2-02 is the ring
 * plumbing + telemetry. */
/* Opening a ring also creates its per-source ASRC (SINC_BEST, D-WZ-ASRC-01),
 * which pulls the ring onto the engine rate. `nominal_rate` is the source's
 * FORMAT-reported rate (for the srcDriftPpm readout + ASRC fallback); the true
 * rate is discovered from write timestamps. Control thread (allocates). */
int32_t wz_source_ring_open(wz_engine* e, const char* source_key,
                            uint32_t channels, uint32_t capacity_frames,
                            double nominal_rate);
/* RT-safe, lock-free, SINGLE writer. `interleaved` is frames x channels. */
void    wz_source_write(wz_engine* e, int32_t ring, const float* interleaved,
                        uint32_t frames, double source_rate, uint64_t host_time_ns);
void    wz_source_ring_close(wz_engine* e, int32_t ring);
/* Telemetry for HotFrame (control/UI thread). Bad/closed ring returns 0. */
uint64_t wz_source_ring_fill(const wz_engine* e, int32_t ring);
uint64_t wz_source_ring_overruns(const wz_engine* e, int32_t ring);
uint64_t wz_source_ring_underruns(const wz_engine* e, int32_t ring);

/* --- decks (P1: playback only; record states land P3) --------------------
 * Buffers are planar float32 AT THE ENGINE RATE (D-WZ-DECKSRC-01: the host
 * resamples at load, SINC_BEST). wz_deck_load copies the data in; NOT RT-safe
 * -- the host detaches the render callback around it (whileSuspended). `rate`
 * records the buffer's rate for sanity; playback is a straight read.
 * Returns 1 on success, 0 on bad args/alloc failure. */
int32_t wz_deck_load(wz_engine* e, uint32_t deck, uint32_t channels,
                     uint64_t frames, const float* const* data, double rate);
uint64_t wz_deck_frames(const wz_engine* e, uint32_t deck);

/* Transport intent (control thread, RT-safe atomics):
 * mode 0 = loop (play the loop region, wrap), 1 = oneShot (play region once ->
 * idle), 2 = stop (-> idle), 3 = retrigger (seek region start, keep/enter the
 * current play mode; from idle it starts a oneShot). State truth streams back
 * via the HotFrame deck block, never a reply. */
void wz_deck_trigger(wz_engine* e, uint32_t deck, uint32_t mode);

/* SCRUB: put the playhead at `frame` (turntable-style dragging). Posted to a
 * mailbox the render thread consumes at the top of its next block, so dragging
 * never races the reader. Clamped to the buffer, NOT to the loop region —
 * scrubbing outside the region is how you find the part you want to loop.
 * Control thread. */
void wz_deck_seek(wz_engine* e, uint32_t deck, uint64_t frame);

/* --- TAPE SCRUB (turntable) ---------------------------------------------
 * Hold the record and move it: the playhead follows the finger and the PITCH
 * follows how fast the finger moves, because the rate is DERIVED from the gap
 * between where the deck is and where you have dragged to.
 *
 * This is deliberately not the same gesture as wz_deck_seek, which jumps the
 * read position at unchanged pitch (a granular stutter). Both are wanted.
 *
 * A scrubbing deck SOUNDS even when it is idle — that is the whole point of a
 * turntable — and it renders through the same reader, so reverse is not a
 * special case. Recording decks refuse. Control thread; the render thread reads
 * the posted target and never locks.
 *
 *   begin: capture the current position and fade the scrub in
 *   to:    post where the finger is now (call as often as you like)
 *   end:   fade out and hand the deck back to its transport state
 */
/* --- OVERDUB (D-WZ-OVERDUB-01) -------------------------------------------
 * Sound-on-sound: the deck keeps playing its loop and SUMS the input into the
 * same buffer at the playhead. Destructive in RAM by design — mixing in place
 * grows nothing, so the 256 MB cap and the RT no-allocation rule are untouched.
 * The drain still runs, so every pass lands as its own crash-safe stamped take
 * file even though the pre-mix buffer state does not survive.
 *
 * Works on ANY material, whatever its origin: a strip is a strip, so a LOADED
 * FILE overdubs exactly like a recorded take. Uses the deck's existing record
 * source (wz_deck_set_record_source). Control thread. */
/* mode: 0 = SUM (sound-on-sound) · 1 = REPLACE (erase and write).
 * While punching, the deck's OWN OUTPUT carries the live input on top of the
 * material, so you hear yourself against the loop — the engine renders one
 * source per channel, so this is the only place both can exist at once.
 * INSERT is not a mode here: splicing changes the buffer LENGTH, which needs
 * allocation and moving audio, neither of which is allowed on the render
 * thread. It must be a control-thread splice at stop. */
void wz_deck_overdub_start(wz_engine* e, uint32_t deck, uint32_t mode);

/* INSERT (P3-14): splice `frames` of audio INTO the deck at `at`, shifting the
 * existing material from `at` onwards later. The buffer GROWS, so unlike SUM and
 * REPLACE this can never be a live punch mode: it allocates and moves audio, and
 * the render thread may do neither.
 *
 * Call it exactly as you call wz_deck_load — from the control thread WITH THE
 * RENDER CALLBACK DETACHED. It rebuilds the deck's chunk storage.
 *
 * Returns 1 on success, 0 if the deck/args are invalid or the result would
 * exceed the D-WZ-DECK-01 per-deck cap — checked AT the splice, because this is
 * the one operation that makes a deck longer. */
int32_t wz_deck_insert(wz_engine* e, uint32_t deck, uint64_t at, uint32_t channels,
                       uint64_t frames, const float* const* planar);

/* The deck's current read position, as published to the UI each block. Read-only
 * accessor for callers that need to act AT the playhead (splice, cue) without
 * decoding a HotFrame. Any thread. */
double wz_deck_playhead(const wz_engine* e, uint32_t deck);
void wz_deck_overdub_stop(wz_engine* e, uint32_t deck);

void wz_deck_scrub_begin(wz_engine* e, uint32_t deck);
void wz_deck_scrub_to(wz_engine* e, uint32_t deck, double frame);
void wz_deck_scrub_end(wz_engine* e, uint32_t deck);

/* Half-open [start, end) in buffer samples, seqlock-published (never torn).
 * enabled=0 or a degenerate/out-of-range pair plays the whole buffer. */
void wz_deck_set_loop(wz_engine* e, uint32_t deck, uint32_t enabled,
                      uint64_t start, uint64_t end);

/* Waveform envelope for display (P4-06). Fills out_min/out_max[0..columns) with
 * the min/max of `channel` over the half-open range [start, end), one entry per
 * on-screen column. Reads the chunked buffer directly — cheap enough to call on
 * the message thread per view change, and never from the render thread. Returns
 * columns written (0 on bad args / empty deck). */
uint32_t wz_deck_waveform(const wz_engine* e, uint32_t deck, uint32_t channel,
                          uint64_t start_frame, uint64_t end_frame,
                          uint32_t columns, float* out_min, float* out_max);

/* Signed varispeed (P4-02, docs/specs/playback-composer.md §1). Negative =
 * reverse; |rate| is clamped to [1/16, 16]. Exactly +-1.0 takes the IDENTITY
 * path (direct integer read, bit-exact — no resampler in the signal path). The
 * rate is smoothed with the D-WZ-RAMP-01 constant, so a sweep glides. RT-safe. */
void wz_deck_set_rate(wz_engine* e, uint32_t deck, double rate);
double wz_deck_rate(const wz_engine* e, uint32_t deck);

/* --- deck recording (P3, docs/specs/recorder.md) -------------------------
 * The deck records `channels` ENGINE-input channels (chan0 = L/mono, chan1 = R
 * or -1) into its buffer — the same chunked storage playback uses, so stop→loop
 * is a no-copy handoff (Law C-3). The crash-safe file is a parallel host drain.
 * Control thread. */
void wz_deck_set_record_source(wz_engine* e, uint32_t deck,
                               int32_t chan0, int32_t chan1);
/* Arm + begin capturing at the next render block. Clears the deck's buffer,
 * stamps recStartSample = the engine clock (Law C-2). RT-safe flag flip; the
 * host must have called wz_deck_record_service first to allocate initial
 * capacity (it allocates). */
void wz_deck_record_start(wz_engine* e, uint32_t deck);
/* Stop capturing. Returns the take's startEngineSample. If loop is enabled the
 * deck switches to looping playback of the just-captured buffer IN THE SAME
 * block (the Law C-3 handoff, P3-03); else → idle with the buffer retained. */
uint64_t wz_deck_record_stop(wz_engine* e, uint32_t deck);
/* Control-thread service: allocate record-buffer chunks AHEAD of the render's
 * write position (so the RT path never allocates) and enforce the 256 MB cap
 * (D-WZ-DECK-01). The host calls this regularly while any deck records. */
void wz_deck_record_service(wz_engine* e);
/* Test/diagnostic seam: override the deck's RAM cap (D-WZ-DECK-01 = 256 MB per
 * deck, computed from the channel count at record start). Fixtures use it to
 * reach the cap in milliseconds instead of 23 minutes; the shipping app never
 * calls it. 0 restores the signed default. Control thread. */
void wz_deck_set_record_cap_frames(wz_engine* e, uint32_t deck, uint64_t cap_frames);

/* Host drain of a deck's parallel file feed: copies up to `capacity` interleaved
 * frames of captured audio into `out`, returns frames written. Lock-free; an
 * empty drain returns 0. `out_start_sample` receives the take's startEngineSample
 * (Law C-2) for the sidecar. */
uint32_t wz_deck_drain(wz_engine* e, uint32_t deck, float* out,
                       uint32_t capacity_frames, uint64_t* out_start_sample);

/* --- GLOBAL RECORD (D-WZ-GREC-01) ----------------------------------------
 * The archivist, not the instrument. A stereo tap of bus 0 taken POST master
 * fader and POST limiter — what actually left the bus — drained to file by the
 * host. It is deliberately NOT a deck: no RAM buffer, no 256 MB cap, not
 * live-loopable. That is what lets it run a three-hour set while a deck caps at
 * 11 min 39 s stereo.
 *
 * wz_global_record_start ARMS; the render thread picks the arm up at the top of
 * its next block and stamps globalStartSample there, so the stamp is the exact
 * engine sample capture began. Every per-strip file of the same session is
 * written with TimeReference = its startEngineSample − this, which is what makes
 * "drop every file at 0:00" reproduce the session (Law C-2). */
void wz_global_record_start(wz_engine* e);
/* Stops at the render's next block; returns the session's time origin. */
uint64_t wz_global_record_stop(wz_engine* e);
uint64_t wz_global_record_start_sample(wz_engine* e);
uint32_t wz_global_record_active(wz_engine* e); /* render's own state, not the arm */
/* Dropped-oldest events. The render thread never blocks on the host's disk, so
 * a host that falls behind LOSES AUDIO — and this is how it finds out. */
uint64_t wz_global_record_overruns(wz_engine* e);
/* Host drain: interleaved stereo, up to `capacity` frames; returns frames
 * copied. `out_start_sample` receives the session origin (may be NULL). */
uint32_t wz_global_drain(wz_engine* e, float* out, uint32_t capacity_frames,
                         uint64_t* out_start_sample);

/* --- audio ------------------------------------------------------------- */
/* Duplex render (D-WZ-RATE-01: inputs arrive in the SAME callback as the
 * output — same clock, zero SRC). `in_bus` is `in_count` device input channel
 * pointers (may be NULL/0 — deviceInput strips then read silence); `bus_out`
 * is `bus_count` output channels: 0/1 = main L/R, 2/3 = monitor L/R when
 * present (the host applies the Patch's outputMap on its side, P1-09).
 *
 * Sums the current world's channels per docs/specs/routing.md: fader curve
 * (D-WZ-FADER-01), −3 dB constant-power pan (D-WZ-PAN-01), 10 ms raised-cosine
 * mute + one-pole gain/pan smoothing (D-WZ-RAMP-01), float64 accumulation
 * (D-WZ-DSP-01), in-place solo (main bus only). Non-finite input samples are
 * squelched to 0 at the strip input, never propagated.
 *
 * Real-time safe: no locks, no allocation, no IO. Advances the monotonic
 * engine clock by exactly `frames` regardless of world state. */
void wz_engine_render_io(wz_engine* e,
                         const float* const* in_bus,
                         uint32_t in_count,
                         float* const* bus_out,
                         uint32_t bus_count,
                         uint32_t frames);

/* Output-only convenience: wz_engine_render_io with no inputs. */
void wz_engine_render(wz_engine* e,
                      float* const* bus_out,
                      uint32_t bus_count,
                      uint32_t frames);

/* Output buses (P4-05, playback-composer.md §4). Bus 0 IS main — there is no
 * separate main path, which is what makes a spatial layout (quad / 5.1 /
 * octophonic) nothing but a wider bus map. Device channel layout:
 *   bus 0 -> device 0/1 (main) · cue -> device 2/3 · bus 1 -> 4/5 · bus 2 -> 6/7 ...
 * A bus with no device channels is DROPPED, never folded into another bus; the
 * host reports it unmapped so silence is always explained. */
uint32_t wz_engine_max_out_buses(void); /* the compiled-in maximum (8) */
/* How many buses the given device channel count can actually carry. */
uint32_t wz_engine_mappable_buses(uint32_t device_out_channels);

/* Test/diagnostic seam: disable the feedback watchdog (P4-04). The shipping app
 * NEVER calls this — the watchdog is the only guard against an external
 * feedback loop. Fixtures that assert exact sample values use synthetic ramps
 * far above full scale (a ramp buffer holding 0..255 is ~+48 dBFS), which the
 * watchdog would legitimately limit; disabling it lets those tests measure the
 * path under test rather than the safety net. Enabled by default. */
void wz_engine_set_watchdog_enabled(wz_engine* e, uint32_t enabled);

/* --- hotframe ----------------------------------------------------------
 * Frame = scalars + one block per channel + one block per deck (strides in the
 * generated WZProtocol.h; block counts follow the current world). Returns the
 * number of doubles written, or 0 if `capacity` is smaller than the current
 * frame length (a short buffer is refused, not truncated). Callers size their
 * buffer via wz_engine_hotframe_length. */
uint32_t wz_engine_hotframe_length(const wz_engine* e);
uint32_t wz_engine_hotframe(const wz_engine* e, double* out, uint32_t capacity);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* WZ_ENGINE_H */
