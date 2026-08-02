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
 * identity, lifecycle, rate, planar render, the tape surface (§5), session
 * snapshots (§6) and HotFrame (§8). The world builder (§4), keyed params (§3)
 * and transport (§7) are NOT declared here until they exist. No dead ABI.
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

/** The monotonic engine clock, in samples (Law C-2).
 *
 * Advanced by exactly `frames` on every render that happens, REGARDLESS of
 * transport state, so realigning two takes recorded at different moments is a
 * pure subtraction. Every take stamp, the record→loop handoff ordering and
 * (later) the §7 master transport are rooted here; a render the engine refused
 * does not advance it, because nothing was rendered. */
uint64_t sl_engine_time_samples(const sl_engine* e);

/* ── Deck-scope parameters (§3) ─────────────────────────────────────────────
 *
 * THE TEMPO AXIS OF A GRID DECK, and the second of the ABI's two param
 * families. `sl_track_param_id` (§6) keys a track INSIDE a deck's session;
 * these key the DECK ITSELF, and the difference is not cosmetic — it is a
 * difference of LIFETIME:
 *
 *   session scope   rebuilt wholesale by every sl_snapshot_begin…commit.
 *                   The document owns it; a publish is how it changes.
 *   deck scope      SURVIVES a publish. The engine holds it in a persistent
 *                   per-deck block and re-stamps it onto each rebuilt world.
 *
 * That distinction is the entire point of this surface. Before P3-2 the sync
 * ratio lived only on the published world, so editing one step in the grid
 * un-synced the deck, and the plane carried a re-assert pass to paper over it.
 * Deck scope removes the hazard class rather than working around it: a session
 * publish may not touch the tempo axis, because the tempo axis is not the
 * session's.
 *
 * Names, never hardcoded integers — resolve once at boot and cache the ints
 * (the same discipline, and the same reason, as the track params).
 *
 *   syncRatio   target_bpm / deck_bpm; 1.0 = free-running at its own tempo.
 *               TS computes it (djMix.ts, golden-pinned against the Swift
 *               original); the engine only carries it.
 *   tempoMode   HOW the deck follows that ratio, and the control the merge
 *               exists to expose:
 *                 0 timePitch    varispeed — tempo and pitch move together
 *                 1 timeStretch  the bus stretcher — tempo moves, pitch does not
 *                 2 tempoOnly    the step clock alone; sample playback untouched
 *               One place decides which core field the ratio lands in, so the
 *               three paths can never disagree about which is active.
 *   rate        signed varispeed multiplier, independent of sync. Negative is
 *               reserved for reverse and is REFUSED here until the core's
 *               per-deck reverse exists — declare-only-what-is-implemented.
 *   transpose   semitones on the deck's stretch bus. One of the two params here
 *               that do not republish: the core carries a realtime setter for
 *               it, so it is a fader you can ride. It is what lets a deck sit in
 *               its own key while staying tempo-locked, which is the half of
 *               "tempo and pitch" that sync alone does not give you.
 *   texture     0…1 window texture across the deck's stretch node bank — the
 *               donor's WIN control (`paramWrite("deckBusTexture", …)` in
 *               WebToolbarBinding.swift). The grain character of the stretch:
 *               low is tight and transient-preserving, high is smeared and
 *               smooth. Realtime like transpose, and out of [0,1] is REFUSED
 *               rather than clamped. Inaudible in tempoOnly, where the stretch
 *               bus is neutral by definition.
 *
 * Master globals (mainGain, master bpm) are NOT here: mainGain is
 * sl_master_set_level, and master bpm is the host's, carried to each deck as
 * the ratio above. A param that means something different per deck and a
 * global that means one thing do not belong in one keyed space. */

/** Resolve a deck param by name; SL_PARAM_UNKNOWN if unknown. */
int32_t sl_param_id_for_name(const char* name);

/** Introspection, so a host can enumerate rather than hardcode. */
uint32_t    sl_param_count(void);
const char* sl_param_name(uint32_t id);   /* NULL if out of range */

/** Write/read a deck param. An unknown id, an out-of-range deck, a null engine
    or a value the param refuses is IGNORED — never misapplied to something
    else. `set` republishes the deck world so the change is immediate; that is
    a control-thread publish at human rate (a knob, not an audio-thread write),
    exactly as sl_deck_set_tempo_sync has always done. */
void   sl_param_set(sl_engine* e, uint32_t deck, int32_t id, double value);
double sl_param_get(const sl_engine* e, uint32_t deck, int32_t id);

/* ── Host modulation offsets (D-SL-DECKPLUGIN-04) ───────────────────────────
 *
 * What a DAW automation lane writes. Every value here is an OFFSET added on
 * top of what the session already says — 0 is neutral — which is the whole
 * design: the web UI keeps owning every base value and the host owns only its
 * contribution, so the two never fight over one number and an idle lane is
 * bit-identical to no lane at all. It is also the shape the donor's M1–M4
 * modulation bank used (additive semitones on pitch, additive tone units on
 * the filter), so replacing that bank with host automation is a change of
 * SOURCE, not of meaning.
 *
 * ⚠️ These are the one param family an audio thread MAY write. Everything else
 * on this surface republishes a deep-copied world (see sl_param_set above);
 * these are plain relaxed atomics that the render callback reads as it
 * composes each track's base ramp, so the plugin applies automation per block
 * — which is what makes a fast LFO sound like an LFO instead of like the 40 Hz
 * control pump. Track offsets join the existing 4 ms declick ramp, so they
 * reach RINGING voices and need no smoothing of their own.
 *
 * Track targets, by name:
 *   pitch          semitones, additive on the track's globalPitchOffset
 *   volume         linear, composed value clamped to 0…2
 *   pan            additive, composed value clamped to ±1
 *   tone           filter cutoff in tone units, composed clamped to ±100
 *   send1…send4    additive send level, composed clamped at ≥ 0
 * Deck targets: transpose (semitones) and texture (composed clamped to 0…1).
 *
 * A track index beyond the session's track count is accepted and simply does
 * nothing until a session that deep arrives — a plugin's parameter list is
 * fixed at load time and cannot wait for a document. */

/** Resolve a track/deck mod target by name; SL_PARAM_UNKNOWN if unknown. */
int32_t sl_track_mod_id_for_name(const char* name);
int32_t sl_deck_mod_id_for_name(const char* name);

/** Introspection, so a host can enumerate rather than hardcode. */
uint32_t    sl_track_mod_count(void);
const char* sl_track_mod_name(uint32_t id);   /* NULL if out of range */
uint32_t    sl_deck_mod_count(void);
const char* sl_deck_mod_name(uint32_t id);    /* NULL if out of range */

/** Write/read a host mod offset. An unknown id, an out-of-range deck or track,
    a null engine or a non-finite value is IGNORED — never misapplied. RT-safe:
    callable from the audio thread. */
void   sl_track_mod_set(sl_engine* e, uint32_t deck, uint32_t track, int32_t id, double value);
double sl_track_mod_get(const sl_engine* e, uint32_t deck, uint32_t track, int32_t id);
void   sl_deck_mod_set(sl_engine* e, uint32_t deck, int32_t id, double value);
double sl_deck_mod_get(const sl_engine* e, uint32_t deck, int32_t id);

/** Master level offset: a GAIN MULTIPLIER on sl_master_set_level's value, 1.0
    neutral. A multiplier rather than an added dB so the plane's fader and the
    host's automation compose without either having to know the other's units.
    Rides the same smoothing ramp as the level itself. RT-safe. */
void   sl_master_set_mod(sl_engine* e, double gain);
double sl_master_mod(const sl_engine* e);

/* ── Tape decks (§5) ────────────────────────────────────────────────────────
 *
 * A TAPE is a continuous audio buffer with a playhead: record / scrub /
 * varispeed / loop-region / overdub, draining to crash-safe stamped takes.
 * It is the looper, the recorder AND the file player — one object, different
 * fills (docs/archive/STRIP-MODEL.md).
 *
 * NAMING — this AMENDS SL-ABI-V3 §5, which listed these as `sl_deck_*`. §6 had
 * already spent `sl_deck_*` on scoopy's GRID decks (sequenced sampler sessions,
 * a different index space with a different engine behind it). Two objects
 * called "deck" in one ABI is a permanent ambiguity, so wizard's deck arrives
 * as `sl_tape_*` — which is also the word the strip model uses for it. Tape
 * indices and deck indices are INDEPENDENT: sl_tape_count() tapes and
 * sl_deck_count() grid decks coexist.
 *
 * Transplanted from wizard's wz_deck_* (chunked planar storage, seqlock loop,
 * scrub mailbox, overdub SUM/REPLACE, insert splice, 256 MB cap, Law C-2
 * stamps, the Law C-3 same-block record→loop handoff), which is a donor, not a
 * survivor. Every entry point is null-safe and range-checked.
 *
 * THREADING: everything here is control-thread (message thread) except
 * sl_tape_record_service and sl_tape_drain, which are the host's service
 * thread. sl_tape_load and sl_tape_insert ALLOCATE and replace storage the
 * render reads — the host must detach the render callback around them. */

/** How many tapes exist. A tape index must be < this. */
uint32_t sl_tape_count(void);

/** Fill a tape from planar audio (a file, or a carved region). Rebuilds the
    tape's storage, so the render must be detached. Returns 1 on success. */
int32_t sl_tape_load(sl_engine* e, uint32_t tape, uint32_t channels,
                     uint64_t frames, const float* const* data, double rate);

/** Committed length in frames. Grows while recording; safe to poll. */
uint64_t sl_tape_frames(const sl_engine* e, uint32_t tape);

/** The tape's channel count (0 = no material yet). Set by whatever gave the
    tape material — a load, or a record start. The host needs it to size a
    sl_tape_drain buffer and to open the take's WAV at the right width. */
uint32_t sl_tape_channels(const sl_engine* e, uint32_t tape);

/** 0 = loop, 1 = one-shot, 2 = stop, 3 = retrigger (from idle: one-shot).
    A trigger fires from the armed cue point if one was set by a scrub or seek
    (D-WZ-SCRUBCUE-01), otherwise from the loop region's entry edge. */
void sl_tape_trigger(sl_engine* e, uint32_t tape, uint32_t mode);

/** Post a playhead target; the render applies it at the top of its next block
    and arms it as the cue. Jumps at unchanged pitch — the scrub verbs below are
    the turntable gesture, this is the seek. */
void sl_tape_seek(sl_engine* e, uint32_t tape, uint64_t frame);

/** The published playhead (frames, fractional at non-unity rates). */
double sl_tape_playhead(const sl_engine* e, uint32_t tape);

/** 0 = idle, 1 = looping, 2 = one-shot, 3 = recording (schema deck 'state'). */
uint32_t sl_tape_state(const sl_engine* e, uint32_t tape);

/** Splice `frames` of planar audio in at `at`, lengthening the tape. The one
    operation that grows a tape outside recording, so it checks the cap itself.
    Carries the transport, playhead and loop region across the rebuild. Render
    must be detached. Returns 1 on success. */
int32_t sl_tape_insert(sl_engine* e, uint32_t tape, uint64_t at, uint32_t channels,
                       uint64_t frames, const float* const* planar);

/** Sound-on-sound into the material already there (D-WZ-OVERDUB-01), while the
    tape keeps playing: mode 0 = SUM, 1 = REPLACE. Destructive in RAM — each
    pass still drains to its OWN stamped take, so the material survives on disk
    even though the pre-mix buffer does not.

    Refused on an empty tape (that is what record is for), while recording, and
    for a non-deviceInput record source: overdub reads its input during the
    playback pass, which runs before the mix exists, so a mix-sourced overdub
    could only layer the PREVIOUS block — silently early against a take that is
    sample-exact. Refusing beats faking it. */
void sl_tape_overdub_start(sl_engine* e, uint32_t tape, uint32_t mode);
void sl_tape_overdub_stop(sl_engine* e, uint32_t tape);

/** Turntable scrub. begin/end bracket the gesture; `to` posts where the finger
    is, in frames. RATE IS DERIVED FROM THE GAP between playhead and finger, so
    a faster hand is a higher rate and therefore a pitch bend — one mechanism,
    both behaviours, no dependence on pixels or zoom level. A scrubbing tape
    sounds even when stopped; a RECORDING tape refuses (the write head is not
    the user's to drag). Release fades on the 10 ms ramp, so it cannot click. */
void sl_tape_scrub_begin(sl_engine* e, uint32_t tape);
void sl_tape_scrub_to(sl_engine* e, uint32_t tape, double frame);
void sl_tape_scrub_end(sl_engine* e, uint32_t tape);

/** The scrub rate the render is publishing, in playback speeds (signed;
    0 when not scrubbing). The readback for a value that was WRITE-ONLY —
    `pubScrubRate` had no getter, no HotFrame slot and no reader anywhere. */
double sl_tape_scrub_rate(const sl_engine* e, uint32_t tape);

/** TURNTABLISM SCRATCH (docs/specs/scratching.md). A tempo-locked pattern that
    runs for as long as it is held, driving the SAME scrub path a finger does —
    which is the point: the 10 ms rate one-pole is what produces the phantom
    click (the momentary silence at every direction change that gives a baby
    scratch its rhythm with no fader at all), and a generator that bypassed it
    to "drive the playhead properly" would delete the articulation.

    IT LIVES IN THE ENGINE rather than in a host block callback because
    `processBlock` exists only in the plugins — the app renders through a thin
    sink adapter with no per-block hook — and because per-sample evaluation
    removes the ~94 Hz control-rate ceiling that otherwise smears each reversal
    across a block. Measured: 7 ms of reversal silence per sample against 11 ms
    at a 512-frame control grain, where the sources put a real turntable at ~5.

    `technique` indexes the table generated from
    `slengine/scratch-techniques.json`; THE INDEX IS THE WIRE, and the UI's copy
    of that table is emitted from the same authority (`scratch:check`).
    `period_beats` is one full back-and-forth in beats — musical divisions, never
    milliseconds, because crossfader IOIs cluster on 1/32, 1/16 and 1/8.
    `span` is a fraction of the loop, and measured spans are SMALL.

    Refused while recording, exactly as sl_tape_scrub_begin is: the write head is
    not the user's to drag, and a pattern is only a faster drag. Out-of-range
    period/span are CLAMPED rather than refused — these come from a UI control,
    and a refused start is a button that does nothing.

    `stop` completes the current stroke before releasing (reversals land at the
    extrema; strokes are whole units), then hands over to the ordinary 10 ms
    scrub release fade. */
void sl_tape_scratch_start(sl_engine* e, uint32_t tape, uint32_t technique,
                           double period_beats, double span);
/** Retune while held. Deliberately does NOT re-seed the phase: a period change
    mid-stroke should change speed, not restart the figure. */
void sl_tape_scratch_set(sl_engine* e, uint32_t tape, double period_beats, double span);
void sl_tape_scratch_stop(sl_engine* e, uint32_t tape);

/** The tempo scratch patterns lock to, engine-wide. Pushed by whoever knows —
    ScoopyTape from HostSync inside processBlock, Studio from the master tempo —
    because the engine has no tempo of its own to read: its only tempo concept is
    a per-deck sync RATIO. Engine-wide rather than per-tape because a pattern is
    locked to THE tempo, and eight tapes disagreeing about the length of a 1/8
    note would be eight clocks. Ignored unless finite and positive. */
void sl_tape_set_scratch_tempo(sl_engine* e, double bpm);

/** Half-open loop region [start, end), published torn-free (seqlock). A region
    set before recording stops is honored by the Law C-3 handoff if it fits the
    captured length; otherwise the take itself becomes the loop. */
void sl_tape_set_loop(sl_engine* e, uint32_t tape, uint32_t enabled,
                      uint64_t start, uint64_t end);

/** Min/max envelope over [start_frame, end_frame) into `columns` buckets, for
    drawing. A degenerate range means the whole buffer. Returns columns written.
    Message-thread: it walks the buffer, so never call it from the render. */
uint32_t sl_tape_waveform(const sl_engine* e, uint32_t tape, uint32_t channel,
                          uint64_t start_frame, uint64_t end_frame,
                          uint32_t columns, float* out_min, float* out_max);

/** Signed varispeed; negative is reverse, |rate| clamped to [1/16, 16]. The
    rate glides on the one 10 ms ramp, and SNAPS to exactly ±1 once inaudibly
    close — which is what keeps the bit-exact identity read path reachable by
    dragging a slider rather than only by typing a number. */
void sl_tape_set_rate(sl_engine* e, uint32_t tape, double rate);
double sl_tape_rate(const sl_engine* e, uint32_t tape);

/** How this tape follows a tempo (P3-2b-5, TAPE-STRETCH.md): 0 timePitch —
    varispeed, zero latency, pitch moves with rate (the default) · 1 timeStretch
    — the Signalsmith stretcher restores pitch, costing its group delay. The
    MODE decides what the one rate number drives; the ratio still arrives via
    sl_tape_set_rate. Entering timeStretch lazily allocates this tape's
    stretcher with an async warm-up; the render stays DRY until
    sl_tape_stretch_ready answers 1. */
void sl_tape_set_tempo_mode(sl_engine* e, uint32_t tape, uint32_t mode);
uint32_t sl_tape_tempo_mode(const sl_engine* e, uint32_t tape);
uint32_t sl_tape_stretch_ready(const sl_engine* e, uint32_t tape);

/** Where this tape's recording comes from. THE one place the transplant is not
    1:1 — wizard's deck could only record device input channels, but the strip
    model's closing argument is that recording is always "capture this bus",
    identical for a sequencer output, a live input or a file.

    kind 0 = deviceInput: `chan0` = L/mono, `chan1` = R or -1. Captured before
             anything renders, so the take is this block's input.
    kind 1 = mainMix: the engine's main L/R after everything, including the
             tapes' own playback ("what left the app"). Captured AFTER the mix
             is summed, so it is this block's mix under this block's stamp — not
             a borrowed previous block.

    An unknown kind is REFUSED (returns 0) rather than silently treated as
    input 0. `channelBus` joins this list when the strip channel exists.
    Returns 1 on success. */
int32_t sl_tape_set_record_source(sl_engine* e, uint32_t tape, uint32_t kind,
                                  int32_t chan0, int32_t chan1);

/** Arm capture. Resets the tape, seeds capacity and the drain, then hands the
    arm to the render, which stamps the exact engine sample capture begins
    (Law C-2) at the top of its next block. */
void sl_tape_record_start(sl_engine* e, uint32_t tape);

/** Stop capture; returns the take's start stamp. The render finalizes at its
    next block: THE LAW C-3 HANDOFF — the record buffer IS the playback buffer
    (same chunks, no copy, no file round-trip), so with a loop enabled the tape
    plays what it just captured in that same block. */
uint64_t sl_tape_record_stop(sl_engine* e, uint32_t tape);

/** Service thread, ~20 ms: keep chunk allocation AHEAD of the render's write
    head so the RT append never touches an unallocated chunk and never
    allocates. Cheap and idempotent when nothing is recording. */
void sl_tape_record_service(sl_engine* e);

/** Test seam only (D-WZ-DECK-01's cap is not a tunable). 0 restores the signed
    256 MB/tape default for the tape's current channel count. */
void sl_tape_set_record_cap_frames(sl_engine* e, uint32_t tape, uint64_t cap_frames);

/** 1 once a recording hit the 256 MB cap and stopped itself. The take is fine
    and already on disk — this is a status, not an error. */
uint32_t sl_tape_record_cap_reached(const sl_engine* e, uint32_t tape);

/** Pull captured frames (interleaved) out of the tape's crash-safe drain ring
    for the host to write to a WAV. `out_start_sample` receives the take's Law
    C-2 stamp. Returns frames read; draining a partially-full ring is normal,
    not an underrun.

    `out` MUST hold capacity_frames × sl_tape_channels() floats — the ring is
    interleaved at the tape's width, and a mono tape hands back one float per
    frame where a stereo tape hands back two. */
uint32_t sl_tape_drain(sl_engine* e, uint32_t tape, float* out,
                       uint32_t capacity_frames, uint64_t* out_start_sample);

/* ── The uniform strip channel ──────────────────────────────────────────────
 *
 * STRIP-MODEL.md's channel: identical for every strip, whatever it hosts —
 * level · 4 FX sends · output · record-arm.
 *
 * ONE SURFACE, TWO BACKINGS, and the distinction is load-bearing. A grid deck
 * ALREADY has a channel inside scoopy's core (crossfaderGain/deckGain are its
 * level, setDeckMasterSend its sends, deckMasterDrive its drive). A tape has
 * none. So a channel bound to a tape is implemented here, and a channel bound
 * to a grid deck PROJECTS onto the core's existing per-deck controls. Putting a
 * fresh gain stage in front of a deck the core already mixed would multiply a
 * gain twice — a bug that is inaudible until someone moves a fader and the
 * wrong amount happens.
 *
 * The channel's output is the RECORD TAP: post-level, post-mute, exactly what
 * this strip contributes to the mix (the tap point settled in
 * ROUTING-MATRIX.md), and what a `channelBus` record source captures. */

/** How many channels exist. A channel index must be < this. */
uint32_t sl_channel_count(void);

/** Bind a channel to what it carries.
    kind 0 = none (a fresh strip's resting state — not an error)
    kind 1 = tape, `index` a tape index
    kind 2 = gridDeck, `index` a deck index
    An unknown kind or an out-of-range tape is REFUSED. Returns 1 on success. */
int32_t sl_channel_set_source(sl_engine* e, uint32_t channel, uint32_t kind, uint32_t index);
uint32_t sl_channel_source_kind(const sl_engine* e, uint32_t channel);
uint32_t sl_channel_source_index(const sl_engine* e, uint32_t channel);

/** Level, sends and mute. All glide on the one 10 ms constant (D-WZ-RAMP-01) —
    no parameter reaches the summing math as a step — and SNAP when inaudibly
    close, so a channel parked at unity multiplies by exactly 1.0 and a tape's
    bit-exact identity path survives the channel. Sends are post-fader.
    A negative or non-finite value is ignored rather than allowed to poison the
    mix. */
void sl_channel_set_level(sl_engine* e, uint32_t channel, double level);
double sl_channel_level(const sl_engine* e, uint32_t channel);
void sl_channel_set_send(sl_engine* e, uint32_t channel, uint32_t send, double level);
double sl_channel_send(const sl_engine* e, uint32_t channel, uint32_t send);
void sl_channel_set_mute(sl_engine* e, uint32_t channel, uint32_t muted);
uint32_t sl_channel_muted(const sl_engine* e, uint32_t channel);

/** Per-strip DRV (P3-X2) — STRIP-MODEL's "master DSP reaches every strip, not
    just full decks", the core's own pre-sum deck drive stage one tier over.

    `curve` 0 soft / 1 tanh / 2 hard / 3 fold (the core's MasterDriveCurve);
    `amount` is an always-on input gain into a fixed 0 dBFS ceiling, clamped to
    [1, 32] with 1.0 = OFF — bypassed as a branch, so an untouched strip keeps
    the bit-exact identity path. Applied POST-element PRE-level, the deck
    stage's own topology (drive before the fader: character constant while
    fading). An unknown curve keeps the old curve; a non-finite amount is
    ignored — the two are validated independently.

    ⚠️ A gridDeck-sourced channel: this stage shapes only what is ROUTED INTO
    the strip's channel. The DECK's own signal is driven by the core
    (deckMasterDrive_, fed by the session document's masterClipper block), so a
    grid strip's DRV control must write the DOCUMENT — the same projection rule
    as level/sends, except the core's stage is document-fed rather than
    live-set, so the projection happens at the document tier, not here. */
void sl_channel_set_drive(sl_engine* e, uint32_t channel, uint32_t curve, double amount);
uint32_t sl_channel_drive_curve(const sl_engine* e, uint32_t channel);
double sl_channel_drive_amount(const sl_engine* e, uint32_t channel);

/** THE MONITOR SWITCH — whether this strip's DEVICE INPUT reaches the channel.
    Default 0. Ramped like every other gain, so flipping it live is a 10 ms fade.

    IT IS NOT A SECOND MUTE, and the difference is the whole point. `mute` is the
    channel's OUTPUT: it silences the strip and everything routed from it,
    including a tape playing back. This gates only the input's path INTO the
    channel, and it does not touch the record path at all:

        input ──┬─▶ REC                        always captured
                └─▶ [monitor] ─▶ channel ─▶ main

    So a take recorded with the monitor CLOSED contains exactly the same audio as
    one recorded with it open — which is what makes recording a mic without
    hearing it possible, and what lets a feedback loop be broken without losing
    the take. Before the split those were the same signal path and neither was
    possible (see sl_channel.h's Channel::monitor for the collision it resolves).

    Cables from other strips, FX returns and send taps are UNAFFECTED: monitoring
    is about this strip's own input, and gating everything would just be `mute`
    spelled differently.

    THE ENGINE MOVES THIS SWITCH ITSELF at exactly two instants, per the signed
    monitor decisions — `sl_tape_record_start` opens it when the tape's source is
    a device input (D-WZ-MON-01), and the Law C-3 record→loop handoff closes it
    in the SAME render block (D-WZ-MON-02; overdub never does, so layering keeps
    the input live). A UI must therefore display `sl_channel_monitor()`, not what
    it last asked for — the same discipline `sl_deck_tempo_sync` exists for. */
void sl_channel_set_monitor(sl_engine* e, uint32_t channel, uint32_t on);
uint32_t sl_channel_monitor(const sl_engine* e, uint32_t channel);

/** This channel's OUTPUT peak since the last call — the strip meter's source.

    READ-AND-RESET, mirroring the core's own output peak, so the caller's 30 Hz
    frame reports "peak since the previous frame". Two consecutive calls
    therefore do NOT return the same number; this is a consuming read and the
    HotFrame emitter is its one intended caller.

    Measured at the channel output: post-level, post-mute, post-ceiling — the
    same tap a route and the record bus take. So a muted strip reads 0, which is
    the truth about what it is contributing.

    ⚠️ A gridDeck-sourced channel reads 0. The core already summed that deck and
    this tier deliberately mixes nothing for it (the channel is a PROJECTION,
    not a second mixer — sl_channel.h). A grid strip's meter must come from the
    core's per-deck telemetry instead. Not a defect to fix here: adding a meter
    tap would mean adding the gain stage this design exists to avoid.

    Safe off the audio thread; 0 for an out-of-range channel. */
double sl_channel_peak_l(sl_engine* e, uint32_t channel);
double sl_channel_peak_r(sl_engine* e, uint32_t channel);

/* ── Routing (§4) — the modular patchbay ────────────────────────────────────
 *
 * Any strip's output can feed any other strip's input, re-patchable live.
 * A strip hears its ELEMENT (tape/grid) plus everything routed into it, which
 * is why a live "input" element needs no separate code path — it is simply a
 * route with no element beside it.
 *
 * THE SCHEDULING RULE, and the reason this is not just a list of cables:
 *
 *   forward route (feedback = 0) — the render visits channels in DEPENDENCY
 *     ORDER, so the destination reads the source's CURRENT block. ZERO added
 *     latency. A route that would close a cycle is REFUSED here, at edit time.
 *
 *   feedback route (feedback = 1) — reads the source's PREVIOUS block, so the
 *     block boundary breaks the loop. Costs exactly one block (~10.7 ms at
 *     512/48k). The only edge allowed to close a cycle, and only on request.
 *
 * ROUTING-MATRIX.md originally specified every route as one-block-delayed,
 * which needs no scheduler. That was amended (2026-07-25) because with strip →
 * strip chaining the per-hop delay ACCUMULATES and parallel paths of different
 * depth comb-filter — silent, undiagnosable, and the failure
 * docs/archive/pd-modular-routing.md §1.3 flags as the one that will actually
 * burn a user.
 *
 * Every route gain is RAMPED: patching fades in, unpatching fades out and is
 * dropped only once it reaches zero. Re-patching a live signal is a crossfade,
 * never a click. */

/** ENDPOINT KINDS. A cable's ends are typed, so the matrix is genuinely
    any-source → any-destination rather than strips-only.

    Source (`src_kind`):
      0 channelOut  — index = channel. Its post-level, post-mute output.
      1 channelSend — index = channel, sub = send 0..3. That strip's output at
                      that send's level. THIS is what makes sends routable
                      (decision 5): the channel owns the send's LEVEL, this
                      route owns where it GOES — so send 3 can feed another
                      strip's input and drive its looper instead of an effect.
      2 deviceInput — index = input channel (L), sub = input channel (R) or
                      0xFFFFFFFF for mono. A live input needs no "input
                      element": it is simply a route into a strip.
      3 fxReturn    — index = return 0..3. The wet lane, so a return can be
                      re-used rather than only summed to main.
      4 deckOut     — index = grid deck 0..sl_deck_count()-1. That DECK's dry
                      stereo output (pre-crossfader, pre-deck-drive), so a deck
                      can be recorded or chained into a looper strip (P3.5-E3).

                      ⚠️ IT IS NOT THE GRID STRIP'S `channelOut`, and the
                      difference is load-bearing. A grid deck's channel is a
                      PROJECTION — the core owns that deck's gain stage and has
                      already summed it into main, so this tier mixes nothing
                      for it and its bus is EMPTY by construction. That is why
                      P3-R3's "REC on a grid strip spawns its looper" recorded
                      silence: there was no source that named the deck. Giving
                      the grid channel's own bus the deck's audio instead would
                      make `channelOut` mean the deck when it feeds a strip and
                      not mean it when it feeds main (already delivered) — one
                      endpoint, two meanings. Hence a kind of its own.

                      EXTERNAL like a device input: the deck is rendered before
                      the channels, so it constrains no render order and can
                      never be part of a cycle.

    Destination (`dst_kind`):
      0 channelIn   — index = channel.
      1 sendBus     — index = 0..3 (the core's send buses are MONO; a stereo
                      source folds rather than losing a side).
      2 main.

    An out-of-range endpoint is REFUSED, never clamped — clamping would patch a
    cable somewhere nobody asked for. */
int32_t sl_route_add_ex(sl_engine* e, uint32_t src_kind, uint32_t src_index, uint32_t src_sub,
                        uint32_t dst_kind, uint32_t dst_index, double gain, uint32_t feedback);

/** The common case: channel `src`'s output into channel `dst`'s input.
    Returns a route id (>= 0), or -1 if refused: an out-of-range channel, a
    channel feeding itself, no free slot, or — the important one — the route
    would close a cycle and `feedback` was 0. Pass feedback = 1 to consent to
    the loop and take the one-block delay. */
int32_t sl_route_add(sl_engine* e, uint32_t src, uint32_t dst, double gain, uint32_t feedback);

/** Drop EVERY route, including the defaults. What a document load calls before
    installing its own wiring, so a loaded patch is exactly what was saved and
    not the saved patch layered over the boot defaults. */
void sl_route_clear_all(sl_engine* e);
/** Re-install the boot wiring: every channel → main, every send → its matching
    FX bus. A fresh engine already has these — they are real, visible, removable
    routes, the way a mixer's channel 1 is wired to jack 1 — so a strip you just
    made is audible and its sends reach their effects without ceremony. */
void sl_route_install_defaults(sl_engine* e);
/** How many routes are currently live. */
uint32_t sl_route_count_active(const sl_engine* e);

/** How many route SLOTS exist. Iterate 0..this-1 and skip the inactive ones to
    walk every cable — a patchbay you can only write to is not a patchbay: the
    matrix has to draw the cables that exist, and a document has to be able to
    save what it FINDS rather than only what it remembers issuing. */
uint32_t sl_route_capacity(void);
uint32_t sl_route_source_kind(const sl_engine* e, uint32_t id);
uint32_t sl_route_source_index(const sl_engine* e, uint32_t id);
/** The send index for a `channelSend` source, or the right-hand input channel
    for a `deviceInput` source; 0xFFFFFFFF when the kind has no sub-index. */
uint32_t sl_route_source_sub(const sl_engine* e, uint32_t id);
uint32_t sl_route_dest_kind(const sl_engine* e, uint32_t id);
uint32_t sl_route_dest_index(const sl_engine* e, uint32_t id);
/** 1 if this cable is a one-block-delayed feedback edge. */
uint32_t sl_route_feedback(const sl_engine* e, uint32_t id);
/** 1 if this cable came from the boot wiring rather than from a user edit — so
    a UI can show it differently, and a document can decide whether re-saving
    the defaults is meaningful or just noise. */
uint32_t sl_route_is_default(const sl_engine* e, uint32_t id);
/** Unpatch. The cable ramps out first, so this is a fade, not a cut. */
int32_t sl_route_remove(sl_engine* e, uint32_t id);
void sl_route_set_gain(sl_engine* e, uint32_t id, double gain);
double sl_route_gain(const sl_engine* e, uint32_t id);
/** 1 while the route is live. A route that has been removed reports 0
    immediately, even though its gain is still ramping out — "is this cable
    patched?" is a question about the document, not about whether the last few
    milliseconds of its fade have finished. */
uint32_t sl_route_active(const sl_engine* e, uint32_t id);
/** Would a forward route src→dst be refused? True if dst already reaches src
    over forward routes, i.e. adding it would close a cycle. Exposed so a
    document layer can explain the refusal instead of just failing. */
uint32_t sl_route_would_cycle(const sl_engine* e, uint32_t src, uint32_t dst);
/** The render order — channels sorted so each comes after everything feeding
    it. `out` must hold sl_channel_count() entries. Mostly a test/diagnostic
    surface; the render uses it internally. */
void sl_route_render_order(const sl_engine* e, uint32_t* out);

/* ── The master output ──────────────────────────────────────────────────────
 *
 * The plane's front-of-house level: one gain on the main pair, applied ONCE by
 * the core's own master stage. Live — the caller does not republish per move.
 *
 * ⚠️ WHY THIS IS NOT `MixerState::mainGain`. That gain is applied INSIDE
 * core.render, and the strip channels sum in AFTER it (render phase 5) — so a
 * master routed through the mixer state moves the GRID DECKS and leaves every
 * tape, input and routed strip untouched. A fader that works on half the mixer
 * is worse than none. It is the same finding the watchdog produced ("the strip
 * channels sum in after core.render, so scoopy's master clipper is already
 * behind them"), and it applies to level for the same reason.
 *
 * So the gain is applied by the render on the SUMMED main pair, before the
 * watchdog — the guard still protects what actually leaves, and the `mainMix`
 * record source stays literally "what left the app". Ramped on the one 10 ms
 * constant and snapped at the target, so a master parked at unity multiplies by
 * exactly 1.0.
 *
 * A second trap avoided on the way: `submitMixerState` publishes through
 * `buildWorld()`, the SINGLE-DECK path, which sets `djMode = false` — so even
 * writing the mixer state would have wiped every grid deck the moment anyone
 * touched the fader. This touches no world at all. Pinned by
 * plane_audio_test §13.
 *
 * A negative or non-finite value is ignored rather than allowed to poison the
 * mix. Above 1.0 is permitted — the core's master clipper is behind this, which
 * is what makes it a fader and not a limiter. */
void sl_master_set_level(sl_engine* e, double level);
double sl_master_level(const sl_engine* e);

/* ── The output watchdog (guard G1) ─────────────────────────────────────────
 *
 * A leaky-RMS detector and ramped limiter on the main pair. It exists because
 * the strip channels sum in AFTER scoopy's core has rendered — so the core's
 * master clipper is already behind them, and a regenerating feedback route
 * would otherwise reach the device with nothing in the way.
 *
 * A LIMITER, not a breaker: it clamps and reports. It never mutes the app or
 * tears a route down, because a performer whose feedback patch runs hot should
 * hear it held, not hear it stop. RMS rather than peak, so a single transient
 * never trips it (D-WZ-WATCHDOG-01). */

/** 1 while limiting, including the hold tail — drive a lamp with this; an
    alarm nobody can see is not one. */
uint32_t sl_watchdog_engaged(const sl_engine* e);
/** The gain currently applied (1.0 = not limiting), for metering. */
double sl_watchdog_gain(const sl_engine* e);
/** TEST SEAM ONLY. Fixtures that drive deliberately hot synthetic signal need
    to measure the path under test rather than the safety net. Always enabled in
    the app; disabling also clears residual limiting so a re-enable starts
    clean. */
void sl_watchdog_set_enabled(sl_engine* e, uint32_t enabled);

/** THE RETURN'S DESTINATION. `1` = EXTERNAL (the send leaves on its own send
    lane and nothing comes back into the main sum); `2` = HOST PLUGIN (a hosted
    effect processes it and its wet is summed into main). Two is the core's
    default; mode 0, the legacy internal delay, is retired.

    Exposed because it had NO caller anywhere in this tree, and the default is
    wrong for one of the hosts: ScoopyDeck hosts no plugins by decision
    (D-SL-DECKPLUGIN-01), so every send was being handed to an effect that can
    never exist and consumed there. Its four Send output buses — the entire
    point of the five-bus layout D-SL-DECKPLUGIN-02 · D1 settled on — were
    therefore silent, with nothing on screen or in a log to say why.

    Per-return, so a host can mix the two: the APP leaves its returns on host
    mode and only a plugin-less host flips them. Message thread; the audio side
    reads it lock-free and picks it up on the next block. */
void sl_return_set_external(sl_engine* e, uint32_t return_index, uint32_t external);

/* ── FX-return plugin slots (P6-2) ──────────────────────────────────────────
 *
 * Doors onto the core's per-return NativePluginSlot machinery (compiled in
 * since P6-1 behind SCOOPY_PLUGIN_HOST). The SCANNER stays host-owned — plugin
 * discovery is a JUCE/message-thread affair the engine tier must not run — so
 * it crosses this C boundary as an opaque pointer (scoopyloops::
 * NativePluginScanner*). On a flag-OFF build every function refuses/answers
 * empty, never pretends.
 *
 * Loading is ASYNC (the JUCE message thread instantiates the plugin); a select
 * returning 1 means "accepted", not "loaded" — poll sl_fx_plugin_name until
 * the name lands. returnIndex is 1…4 everywhere, matching the schema. */

/** Load `identifier` (createIdentifierString) into return slot 1…4, resolving
    it through `scanner`; identifier NULL/empty = unload. Returns 1 accepted /
    0 refused (bad index, no scanner on a load, or a hostless build). */
int sl_fx_plugin_select(sl_engine* e, int returnIndex, void* scanner,
                        const char* identifier);
/** THE RESTORING LOAD (P6-5): the same select, plus the plugin's own opaque
    state applied at instantiation — which is the only moment it can be applied
    without the user hearing the plugin's defaults first.

    `state_base64` NULL/empty behaves exactly like `sl_fx_plugin_select`, so the
    two share one implementation and cannot drift. A blob that fails to decode,
    or that the plugin rejects, leaves the plugin LOADED AT ITS DEFAULTS rather
    than failing the load: a map that remembers the wrong settings is a bad
    afternoon, and a map that refuses to open is a lost set. The caller cannot be
    told from here either way — the load is async on the message thread — so a UI
    that must report this compares what came back (name / identifier) instead. */
int sl_fx_plugin_select_state(sl_engine* e, int returnIndex, void* scanner,
                              const char* identifier, const char* state_base64);
/** The loaded plugin's display name into out (NUL-terminated, truncated to
    cap). Returns the full length in bytes, 0 = no plugin (or still loading —
    loads are async). */
uint32_t sl_fx_plugin_name(const sl_engine* e, int returnIndex, char* out,
                           uint32_t cap);
/** WHAT A DOCUMENT MUST STORE TO FIND THIS PLUGIN AGAIN (P6-5) — the identifier
    the slot was loaded from (JUCE's `createIdentifierString`), NUL-terminated
    into `out`, return value = full length in bytes, 0 = nothing loaded.

    Deliberately NOT the display name, which `sl_fx_plugin_name` is for: a name
    is for people and collides across formats and vendors, so a document keyed on
    it would reload a different plugin on a machine that has both. */
uint32_t sl_fx_plugin_identifier(const sl_engine* e, int returnIndex, char* out,
                                 uint32_t cap);
/** The loaded plugin's OPAQUE STATE as base64 (P6-5) — every knob the plugin
    itself considers worth saving. NUL-terminated into `out`, truncated to `cap`;
    the return value is the FULL length in bytes, so the honest way to call this
    is twice: once with cap 0 to size the buffer, then once to fill it. 0 = no
    plugin loaded.

    ⚠️ IT CAN BE BIG — plugins with impulse responses or sample content run to
    hundreds of KB — which is exactly why this is a sized pull rather than a field
    on the ~2 Hz toolbar push. Truncating it silently would persist a blob that
    the plugin will reject on restore, so a short `cap` gives you the length and
    no illusions. Reads under the slot lock (non-RT, never the audio thread). */
uint32_t sl_fx_plugin_state(const sl_engine* e, int returnIndex, char* out,
                            uint32_t cap);
/** Plugin-reported latency for the slot, in milliseconds at the engine's
    configured rate. 0 when empty. */
double sl_fx_plugin_latency_ms(const sl_engine* e, int returnIndex);
/** THE PLUGIN'S OWN EDITOR, per return (P6-4) — the job the desktop's
    FxSlotWindowController did, done by the JUCE host that already owns the
    plugin instance.

    `sl_fx_editor_set_visible` shows or hides a standalone always-on-top window
    holding the plugin's editor. Hiding does NOT destroy it (nor the plugin), so
    re-showing is instant with the editor's own state intact. Marshalled to the
    JUCE message thread and returns IMMEDIATELY — plugin lifecycle calls are not
    safe anywhere else — so the state it produces is readable a moment later,
    never synchronously.

    ⚠️ THEREFORE: DISPLAY `sl_fx_editor_visible`, NEVER THE REQUEST. It follows
    the window, not the ask, and the three ways those differ are all reachable:
    a plugin with no editor makes "show" a no-op, a slot with nothing loaded
    likewise, and the user can close the window by its own close box at any time
    — which no caller is told about. Echoing the request lights an EDIT lamp over
    a window that is not there. Same rule, same reason as
    `sl_channel_set_monitor` / `sl_channel_monitor`.

    `sl_fx_editor_available` is 1 only when a plugin is loaded AND has an editor
    of its own, so a UI can disable the door with a reason instead of offering a
    button that silently does nothing.

    All three are 0/no-ops for an out-of-range return, on a build without the
    plugin host compiled in, and on the headless/stub host. */
int  sl_fx_editor_available(const sl_engine* e, int returnIndex);
int  sl_fx_editor_visible(const sl_engine* e, int returnIndex);
void sl_fx_editor_set_visible(sl_engine* e, int returnIndex, int visible);

/** Synchronous plugin teardown — MAIN/MESSAGE THREAD ONLY, call during app
    shutdown BEFORE the engine is destroyed (a plugin destructor may pump the
    message loop; the async unload path never runs once the loop is stopping). */
void sl_fx_teardown(sl_engine* e);

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

/** Begin building `deck`'s session. Returns 1, or 0 if `deck` is out of range
    (>= sl_deck_count()) or the engine is null.

    Multi-deck (§6): up to sl_deck_count() sessions coexist, EACH WITH ITS OWN
    BPM/transport — this is what lets a strip host a deck at 120 while another
    hosts one at 90. The deck array is persistent: building and committing one
    deck retains the others, so a strip publishes its deck independently. commit
    swaps all decks atomically (the core's DJ-mode multi-deck path). `bpm` is
    THIS deck's own tempo. */
int sl_snapshot_begin(sl_engine* e, uint32_t deck, double bpm, int is_playing, int32_t start_step);

/** How many decks coexist (the core's kMaxDecks). A deck index must be < this. */
uint32_t sl_deck_count(void);

/** Remove `deck` from the world — it goes silent, its slot inactive, the OTHER
    decks retained. This is a strip dropping its deck: the counterpart to
    sl_snapshot_begin/commit adding one. Republishes so it takes effect
    immediately. An out-of-range deck or null engine is ignored. */
void sl_deck_clear(sl_engine* e, uint32_t deck);

/** Master sync, the engine half — now a thin alias for the `syncRatio` deck
    param (§3 above), kept because it is the spelling P2/P3-1 callers and
    `plane_audio_test` already use. Set `deck`'s tempo-sync ratio =
    target_bpm / deck_bpm (1.0 = free-running at its own bpm). `ratio <= 0` or
    an out-of-range deck is ignored. Transport play/stop is sl_engine_start /
    sl_engine_stop. */
void sl_deck_set_tempo_sync(sl_engine* e, uint32_t deck, double ratio);

/** This deck's current tempo-sync ratio (1.0 = its own tempo, unstretched).

    SURVIVES A PUBLISH, as of P3-2. It used to be reset to 1.0 by
    `sl_snapshot_begin`, so every world publish silently un-synced every synced
    deck and the plane had to re-assert the ratio afterwards (TS carried a
    `reapplyAfterPublish` for exactly this). It is now deck scope, held in the
    engine's persistent param block and re-stamped onto the rebuilt world — a
    session publish no longer touches the tempo axis. Equivalent to
    sl_param_get(e, deck, id_of("syncRatio")). */
double sl_deck_tempo_sync(const sl_engine* e, uint32_t deck);

/** Group delay (frames) of `deck`'s bus stretcher at its CURRENT texture — the
    number a PLUGIN HOST reports for delay compensation (D-SL-DECKPLUGIN-01).

    The stretch bus carries this delay whenever it is engaged, INCLUDING at a
    unity ratio, which is why the core bypasses it outright when every deck is
    neutral. A host inside a DAW cannot follow that engagement with PDC,
    though: latency that toggles as the user nudges the host tempo would have
    the DAW re-compensating mid-performance. So the intended use is
    MODE-SCOPED — sample this when `tempoMode` changes and hold it, reporting
    it for the whole time the deck is in timeStretch, rather than tracking
    moment-to-moment engagement.

    It also varies with `texture` (the node bank's windows differ in length);
    the same rule applies, and for the same reason.

    0 for an out-of-range deck, a null engine, or before the engine has been
    configured at a sample rate. */
uint32_t sl_deck_stretch_latency_frames(const sl_engine* e, uint32_t deck);

/** 1 once `deck`'s bus stretcher is warmed up and can actually stretch.

    While this is 0 the core keeps the bus on its DRY path, so a deck asked to
    follow a tempo during warm-up plays at ITS OWN tempo — wrong, not merely
    late, and it corrects itself a moment later, which is worse to diagnose
    than a steady fault. The deck twin of sl_tape_stretch_ready.

    0 for an out-of-range deck, a null engine, or before configure(). */
uint32_t sl_deck_stretch_ready(const sl_engine* e, uint32_t deck);

/** Warm the deck bus stretchers ON THE CALLING THREAD during configure()
    rather than on background threads. Set it BEFORE the configure you want it
    to affect — i.e. before sl_engine_set_sample_rate — or it does nothing for
    the current one.

    Default OFF, which is the app's behaviour and stays the app's behaviour:
    background warm-up exists because a blocking configure() cost a ~660 ms
    launch hang. A PLUGIN wants the opposite trade — hosts expect
    prepareToPlay to block and may render immediately after it returns — so it
    pays ~200 ms per deck once, at load, and is correct from the first block.
    (D-SL-DECKPLUGIN-01.) */
void sl_engine_set_sync_stretch_warmup(sl_engine* e, uint32_t enabled);

/* ── Quantized launch (P11-3b) ───────────────────────────────────────────────
 *
 * Arm a deck to come in ON the beat, resolved inside the audio callback rather
 * than by a UI-thread poll. The core has carried this since it was vendored
 * (`requestQuantizedLaunch`, NativeAudioEngineCore.hpp:1547) with NO caller
 * anywhere in the tree; the donor reached it through
 * `AudioEngineFacade.requestQuantizedLaunch(deck:refDeck:quantizeSteps:)`.
 *
 * The guarantees are the donor's and must be kept by anything built on top:
 * a held deck stays WARM (its stretcher keeps running, so it does not have to
 * spin up at the boundary), the boundary is CYCLE-relative rather than
 * clock-relative, and a launch waits an extra block rather than align to a grid
 * that is about to move. */

/** Arm `deck` to start when `ref_deck` next crosses a multiple of
    `quantize_steps`. Sets the deck's `launchArmed` and republishes before
    requesting, which is the core's stated precondition. `quantize_steps == 0`,
    `deck == ref_deck` (it would wait on a clock it is not running), an
    out-of-range index or a null engine is IGNORED. */
void sl_deck_request_quantized_launch(sl_engine* e, uint32_t deck, uint32_t ref_deck,
                                      uint16_t quantize_steps);

/** Disarm a pending launch. Safe when nothing is armed. */
void sl_deck_cancel_quantized_launch(sl_engine* e, uint32_t deck);

/** HOST-GRID LAUNCH (D-SL-DECKPLUGIN-03) — arm `deck` to start at an ABSOLUTE
    engine frame, the clock `sl_engine_time_samples` reports.
 *
 *  This is what makes launches line up ACROSS PLUGIN INSTANCES. The quantized
 *  launch above is cycle-relative to another deck IN THIS ENGINE, which cannot
 *  reach an instance the DAW loaded separately. A frame can: every instance
 *  receives the same host `ppqPosition` on the same block boundaries, so each
 *  one independently converts "the next bar" into its own engine frame and they
 *  land on the same sample — with no shared memory and nothing to race.
 *
 *  The caller owns the musical question (which bar, what quantum, whose cycle);
 *  this owns only "release exactly there". `sl_render_io` resolves the frame
 *  against the block it is about to render and hands the core a lead-in.
 *
 *  Preconditions are the quantized launch's, unchanged: publish the deck active
 *  + launchArmed with its start step FIRST, so the world republish happens on
 *  the message thread and the arm itself is one atomic. A frame already in the
 *  past releases on the next block rather than being dropped — a boundary you
 *  missed by a hair should still fire, not hang the deck. `frame == 0`, an
 *  out-of-range deck or a null engine is IGNORED. */
void sl_deck_request_launch_at_frame(sl_engine* e, uint32_t deck, uint64_t frame);

/** Disarm a pending host-grid launch. Safe when nothing is armed. */
void sl_deck_cancel_launch_at_frame(sl_engine* e, uint32_t deck);

/** Monotonic count of launches that have FIRED for `deck`. A host compares it
    against the last value it saw: a bump means the audio actually started,
    which is when a "pending" lamp may honestly clear — the armed flag only says
    the request was accepted. */
uint32_t sl_deck_launch_fired_count(const sl_engine* e, uint32_t deck);

/** SKIP-STEP: jump `deck`'s playhead to absolute `step` at the next step
    boundary, and keep playing. The donor spells this `transportDeck` /
    `skipStep`, beside play and stop (WebToolbarBinding.swift), and it is the one
    deck transport verb the merged host had no seam for.

    A REQUEST, not a write: the core stores one atomic and applies it inside
    render() at the boundary (NativeAudioEngineCore.hpp:1536-1539), so the jump
    lands on the grid instead of wherever the message thread finished. RT-safe,
    no world publish, no allocation.

    `step < 0`, an out-of-range deck or a null engine is IGNORED. Does NOT start
    a stopped deck — it moves the playhead; transport starts it. */
void sl_deck_skip_step(sl_engine* e, uint32_t deck, int64_t step);

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

/** DECK-SCOPE snapshot fields (P3-M-1a) — the transport-verb layer a session
    publish carries: beat repeat and whole-session reverse. Set BETWEEN
    sl_snapshot_begin and commit, on the deck begin opened, keyed by name like
    the track params. Names: beatRepeatActive · beatRepeatStartStep ·
    beatRepeatLength · beatRepeatSubdivision · beatRepeatStartSubcell ·
    reverseTransport. An unknown id is IGNORED, never misread — the applier
    translates and refusals are its job. These are SESSION-scope by design
    (rebuilt by every publish): a beat repeat is a hand gesture the store
    restates, not a document field. */
int32_t sl_snapshot_deck_param_id(const char* name);
void sl_snapshot_deck_set(sl_engine* e, int32_t param, double value);

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
