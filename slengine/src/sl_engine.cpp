// SL ABI v3 — implementation. Thin by design: all behaviour lives in the
// vendored scoopy core, which this tier is forbidden to edit (engine.lock.json;
// apps/scoopy is the only writable home until the P3 flip).
#include "sl_engine.h"

#include "sl_channel.h"
#include "sl_tape.h"
#include "sl_watchdog.h"

#include "NativeAudioEngineCore.hpp"
#include "NativeToneFilter.hpp"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstring>
#include <array>
#include <cstddef>
#include <new>
#include <vector>

// XP-0d, carried into v3 — the denormal guard at the ABI boundary.
//
// On macOS the render callback is protected by juce::ScopedNoDenormals in the
// host layer, which means any host calling sl_render directly (a bare test
// harness, a future Tauri/Rust shell) would run UNPROTECTED and hit the x86
// subnormal CPU cliff in feedback tails. Owning FTZ/DAZ here makes forgetting
// impossible. Duplicated from the vendored v2 wrapper rather than shared: it
// lives in that .cpp, not a header, and this tier may not edit the vendored
// copy to hoist it.
//
// Deliberately NOT applied to the core itself — scoopy_denormal_test links the
// core directly and runs with NO FTZ on purpose, proving the engine does not
// EMIT subnormals. That gate is what makes this guard numerically inert (pure
// CPU insurance), so WASM, which has no FTZ control at all, stays identical.
#if defined(__SSE2__) || defined(_M_X64) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2)
    #include <pmmintrin.h>
    #define SL_V3_DENORMAL_SSE 1
#elif defined(__aarch64__) || defined(_M_ARM64)
    #define SL_V3_DENORMAL_AARCH64 1
#endif

namespace {

struct ScopedFlushDenormals {
#if defined(SL_V3_DENORMAL_SSE)
    unsigned int saved;
    ScopedFlushDenormals() : saved(_mm_getcsr()) { _mm_setcsr(saved | 0x8040u); } // FTZ | DAZ
    ~ScopedFlushDenormals() { _mm_setcsr(saved); }
#elif defined(SL_V3_DENORMAL_AARCH64)
    std::uint64_t saved;
    ScopedFlushDenormals() {
        __asm__ __volatile__("mrs %0, fpcr" : "=r"(saved));
        __asm__ __volatile__("msr fpcr, %0" ::"r"(saved | (1ull << 24))); // FZ
    }
    ~ScopedFlushDenormals() { __asm__ __volatile__("msr fpcr, %0" ::"r"(saved)); }
#else
    // Any target with no denormal control: a deliberate no-op, not an omission.
    ScopedFlushDenormals() = default;
#endif
    ScopedFlushDenormals(const ScopedFlushDenormals&) = delete;
    ScopedFlushDenormals& operator=(const ScopedFlushDenormals&) = delete;
};

} // namespace

using namespace scoopyloops;

struct sl_engine {
    NativeAudioEngineCore core;

    // Scratch lane buffers, allocated ONCE at create/reconfigure. The render
    // callback must not allocate: in an AudioWorklet an allocation is a glitch,
    // and in WASM it may be a heap growth.
    std::array<std::vector<float>, NativeAudioEngineCore::laneCount> lanes;
    std::array<float*, NativeAudioEngineCore::laneCount> lanePtrs{};
    // The decks-in-strips world (SL-ABI-V3 §6): up to kMaxDecks sessions coexist,
    // each its OWN snapshot (hence its own BPM/transport) — the core's DJ-mode
    // multi-deck model, published atomically by publishDJWorld. The array is
    // PERSISTENT: each sl_snapshot_begin(deck)…commit rebuilds one deck's slot
    // and republishes all, so a strip publishes its deck independently and the
    // engine retains the others.
    std::array<DeckWorld, kMaxDecks> deckWorlds{};
    std::size_t currentDeck = 0;         // which deck sl_snapshot_* is building
    NativeTrackSnapshot track;
    bool trackOpen = false;
    MixerState mixer;                    // held so commit can hand it to publishDJWorld

    // The tape bank (SL-ABI-V3 §5): 8 continuous record/scrub/loop buffers,
    // an index space independent of the grid decks above.
    sl::TapeBank tapes;
    // The uniform strip channel. Owns the gain stage for TAPE sources; for
    // grid-deck sources it projects onto the core's own per-deck controls, so
    // there is never a second gain stage in front of a deck the core already
    // mixed (sl_channel.h has the full reasoning).
    sl::ChannelBank channels;
    // Guard G1. The channel sum lands AFTER the core's master clipper, so
    // without this the strips — and any regenerating feedback route between
    // them — reach the device with nothing in the way.
    sl::Watchdog watchdog;

    std::vector<float> silenceIn;
    std::uint32_t blockFrames = 0;
    double sampleRate = 0.0;
    std::int32_t schemaVersion = 0;

    // LAW C-2 — the monotonic engine clock. Advanced by exactly `frames` on
    // every render that happens, regardless of transport, so realigning two
    // takes recorded at different moments is a pure subtraction. Take stamps,
    // the record→loop handoff ordering and the §7 transport all root here.
    std::atomic<std::uint64_t> engineTimeSamples{0};

    // The plane's front-of-house level. Control-thread target, render-owned
    // smoothed value; negative means "not seeded yet" so the first block after
    // a rate change takes the target outright rather than fading in.
    std::atomic<double> masterLevel{1.0};
    double masterSmoothed = -1.0;

    // HotFrame telemetry. The counter is monotonic per emitted frame (the UI
    // detects dropped frames from its gaps); `created` anchors hostTimeMs, which
    // the UI uses only for relative dead-reckoning between frames.
    std::uint64_t hotFrameCounter = 0;
    std::chrono::steady_clock::time_point created = std::chrono::steady_clock::now();

    /** Size the scratch to (rate, block) and prime the mixer. Shared by create
        and set_sample_rate so a rate change cannot drift from the initial
        configuration — the two used to be one function for a reason. */
    bool configure(double rate, std::uint32_t block) {
        if (block == 0 || !(rate > 0.0)) return false;
        if (!core.configure(rate, block, 0)) return false;

        blockFrames = block;
        sampleRate = rate;
        for (std::size_t i = 0; i < lanes.size(); ++i) {
            lanes[i].assign(block, 0.0f);
            lanePtrs[i] = lanes[i].data();
        }
        silenceIn.assign(block, 0.0f);
        // Tape scratch/drains are sized here so no render phase allocates. Tape
        // MATERIAL is deliberately untouched: a rate change must not silently
        // discard a take. (The clock is untouched too — it is monotonic, and a
        // rate change is the host's teardown/rebuild, D-WZ-RATE-01.)
        tapes.configure(rate, block);
        channels.configure(rate, block);
        watchdog.configure(rate);

        mixer = MixerState{};
        mixer.mainGain = 1.0f;
        mixer.send1Gain = 1.0f;
        mixer.send2Gain = 1.0f;
        mixer.cueGain = 1.0f;
        mixer.deckGain = 1.0f;
        core.submitMixerState(mixer);
        return true;
    }
};

namespace {

// The keyed track-param mapping, GENERATED from the pinned v2 ABI. Never edit
// it here: `npm run trackparams:generate`, and CI's trackparams:check fails if
// this copy drifts from the vendored source it was derived from.
#include "sl_track_params.inc"

// The HotFrame layout (SL_HF_* indices + SL_HOTFRAME_LENGTH), generated from
// scoopy's HOT_FRAME_SCALARS. Same rule: never hand-count these.
#include "sl_hotframe.inc"

/** Where the channel mixer puts things, DERIVED from the core's lane enum
    rather than transcribed. The four send buses are consecutive MONO lanes, not
    stereo pairs — writing that assumption down as `send2` rather than
    `send1 + 1` is what stops a future reorder from routing a channel's right
    side into the next send. */
constexpr sl::LaneMap kLaneMap = {
    static_cast<std::uint32_t>(AudioLane::mainLeft),
    static_cast<std::uint32_t>(AudioLane::mainRight),
    {static_cast<std::uint32_t>(AudioLane::send1), static_cast<std::uint32_t>(AudioLane::send2),
     static_cast<std::uint32_t>(AudioLane::send3), static_cast<std::uint32_t>(AudioLane::send4)},
    // The return WET lanes (stereo pairs), so a return can be patched back into
    // a strip — the resampling/feedback want ROUTING-MATRIX calls first-class.
    {static_cast<std::uint32_t>(AudioLane::returnWet1L),
     static_cast<std::uint32_t>(AudioLane::returnWet2L),
     static_cast<std::uint32_t>(AudioLane::returnWet3L),
     static_cast<std::uint32_t>(AudioLane::returnWet4L)},
};

int lookupName(const char* const* table, uint32_t count, const char* name) {
    if (name == nullptr) return SL_PARAM_UNKNOWN;
    for (uint32_t k = 0; k < count; ++k)
        if (std::strcmp(table[k], name) == 0) return static_cast<int>(k);
    return SL_PARAM_UNKNOWN;
}

/** The one render path; sl_render is sl_render_io with no inputs. Kept single
    so the input-carrying and silent cases can never diverge in lane handling.
    Takes the raw input array rather than a resolved pair, because the tapes
    address device input channels BY INDEX and a pre-resolved L/R would have
    thrown that away.

    BLOCK ORDER (the tape phases sit at the points where their signals actually
    exist — see sl::TapeBank's header comment for why that is five calls and not
    one):

      1. tape arm + Law C-3 handoff   — before any playback, so a tape that
                                        stopped-with-loop plays what it just
                                        captured in THIS block
      2. tape capture (device inputs) — the input exists before anything renders
      3. tape playback                — into per-tape scratch
      4. core render                  — the grid decks' sequenced world, which
                                        the core mixes itself (so a grid-deck
                                        channel adds nothing here — it projected
                                        its controls onto the core instead)
      5. channels mix                 — each tape-sourced channel: level/mute
                                        glided, dry into main, post-fader into
                                        the send lanes, and its own output kept
                                        as that strip's record tap
      6. tape capture (channel bus)   — this block's channel output
      7. tape capture (main mix)      — this block's mix, this block's stamp
      8. copy lanes out, advance the clock */
void renderInto(sl_engine* e,
                const float* const* in_bus, std::uint32_t in_count,
                float* const* bus_out, std::uint32_t bus_count,
                std::uint32_t frames) {
    if (e == nullptr || bus_out == nullptr) return;
    if (frames == 0 || frames > e->blockFrames) return; // never render past the configured block

    const ScopedFlushDenormals noDenormals;

    // The core takes two input channels. A mono input feeds both sides rather
    // than leaving one silent; no input at all feeds the pre-allocated silence.
    const float* inL = e->silenceIn.data();
    const float* inR = e->silenceIn.data();
    if (in_bus != nullptr && in_count >= 1 && in_bus[0] != nullptr) {
        inL = in_bus[0];
        inR = (in_count >= 2 && in_bus[1] != nullptr) ? in_bus[1] : in_bus[0];
    }

    const std::uint64_t blockStartSample =
        e->engineTimeSamples.load(std::memory_order_relaxed);

    e->tapes.beginBlock(blockStartSample);

    // D-WZ-MON-02, HONOURED IN THE SAME BLOCK AS THE HANDOFF. A tape that just
    // became a loop has replaced the live input it was capturing, so the strip
    // carrying it stops monitoring — otherwise input + loop play together and
    // the first thing you hear after closing a loop is a doubled beat.
    //
    // It sits between phase 1 (which performs the handoff) and phase 5 (which
    // applies the gate) because that is the only point where both banks are
    // visible AND the block has not been mixed yet. Doing it on the message
    // thread from the record-stop reply would be a frame or two late — audible,
    // and at the exact instant the ear is listening for the loop.
    //
    // Overdub is untouched by construction: it never passes through the C-3
    // handoff, so it sets no bit here and the switch stays open, which is the
    // half of D-WZ-MON-02 that exists because hearing the input against the loop
    // IS the point of overdubbing.
    if (const uint32_t handed = e->tapes.consumeLoopHandoffs(); handed != 0u) {
        for (std::uint32_t ti = 0; ti < sl::TapeBank::count(); ++ti) {
            if ((handed & (1u << ti)) == 0u) continue;
            const int32_t ch = e->channels.channelForTape(ti);
            if (ch >= 0) e->channels.setMonitor(static_cast<uint32_t>(ch), 0u);
        }
    }

    e->tapes.captureInputs(in_bus, in_count, frames, e->sampleRate, blockStartSample);
    e->tapes.renderPlayback(in_bus, in_count, frames, e->sampleRate, blockStartSample);

    for (auto& lane : e->lanes) std::fill_n(lane.begin(), frames, 0.0f);
    e->core.render(inL, inR, e->lanePtrs, frames);

    const auto laneCount = static_cast<std::uint32_t>(NativeAudioEngineCore::laneCount);
    e->channels.mixInto(e->lanePtrs.data(), laneCount, frames, e->tapes, e->sampleRate,
                        kLaneMap, in_bus, in_count);
    // Guard G1, applied to the main pair once every contributor is in — the
    // core's mix, the strips, and any regenerating feedback path between them.
    // A channel-bus tap is deliberately taken BEFORE this (a strip's own
    // contribution is not the limited master), while the mainMix tap below is
    // taken after, so "what left the app" stays literally true.
    // THE MASTER FADER, applied HERE and not through the core's mixer state.
    //
    // ⚠️ `MixerState::mainGain` is applied INSIDE core.render — and the strip
    // channels sum in AFTER that (phase 5). So a master routed through the
    // mixer state would move the grid decks and leave every tape, input and
    // routed strip untouched: a master fader that only works on half the mixer,
    // which is worse than none. It is the same finding the WATCHDOG produced —
    // "the strip channels sum in after core.render, so scoopy's master clipper
    // is already behind them" — and it applies to level for the same reason.
    //
    // Placed BEFORE the watchdog so the guard still protects what actually
    // leaves, and so the `mainMix` capture below stays literally "what left the
    // app". Ramped on the same 10 ms constant as every other gain
    // (D-WZ-RAMP-01) and SNAPPED at the target, so a master parked at unity
    // multiplies by exactly 1.0 and the bit-exact paths survive it.
    {
        const double target = e->masterLevel.load(std::memory_order_relaxed);
        const double alpha = 1.0 - std::exp(-1.0 / (0.010 * e->sampleRate));
        float* mL = e->lanes[kLaneMap.mainL].data();
        float* mR = e->lanes[kLaneMap.mainR].data();
        double sm = e->masterSmoothed;
        if (sm < 0.0) sm = target; // seed, so the first block does not fade in
        for (std::uint32_t i = 0; i < frames; ++i) {
            sm += alpha * (target - sm);
            if (std::abs(target - sm) < 1e-9) sm = target;
            mL[i] = static_cast<float>(mL[i] * sm);
            mR[i] = static_cast<float>(mR[i] * sm);
        }
        e->masterSmoothed = sm;
    }

    e->watchdog.process(e->lanes[kLaneMap.mainL].data(), e->lanes[kLaneMap.mainR].data(),
                        frames, e->sampleRate);
    e->tapes.captureChannels(frames, e->sampleRate, blockStartSample, e->channels);
    e->tapes.captureMix(e->lanes[0].data(), e->lanes[1].data(), frames,
                        e->sampleRate, blockStartSample);

    // Buses the engine has no lane for are left ALONE — the caller owns those
    // buffers and may be summing something else into them. Zeroing here would
    // be this tier silently deciding it owns memory it was only lent.
    const auto n = std::min<std::size_t>(bus_count, NativeAudioEngineCore::laneCount);
    for (std::size_t i = 0; i < n; ++i)
        if (bus_out[i] != nullptr)
            std::copy_n(e->lanes[i].data(), frames, bus_out[i]);

    // Law C-2: exactly `frames`, and only for a render that actually happened —
    // a refused block above advanced nothing because it rendered nothing.
    e->engineTimeSamples.fetch_add(frames, std::memory_order_relaxed);
}

/** THE PROJECTION. A grid deck's gain stage lives in the core, so a channel
    bound to one forwards its controls there instead of building a second one.
    These are the core's LIVE setters (one atomic store each, no republish), so
    a fader drag is heard on already-ringing voices — the same analog-desk
    immediacy the core's own per-track overrides exist for.

    Called after every channel control write. A no-op for tape channels, which
    this tier mixes itself. */
void projectToCore(sl_engine* e, std::uint32_t channel) {
    if (e->channels.sourceKind(channel) !=
        static_cast<std::uint32_t>(sl::ChannelSourceKind::gridDeck))
        return;
    const auto deck = static_cast<int>(e->channels.sourceIndex(channel));
    // Mute is folded into the projected level: the core has no per-deck mute,
    // and a muted strip must be silent whichever engine is carrying it.
    const double lvl = e->channels.muted(channel) != 0 ? 0.0 : e->channels.level(channel);
    e->core.setDeckGainOverride(deck, static_cast<float>(lvl));
    for (std::uint32_t s = 0; s < sl::kNumSends; ++s)
        e->core.setDeckMasterSend(deck, static_cast<int>(s) + 1,
                                  static_cast<float>(e->channels.sendLevel(channel, s)));
}

} // namespace

extern "C" {

int32_t sl_abi_version(void) { return SL_ABI_VERSION; }

uint32_t sl_engine_max_out_buses(void) {
    return static_cast<uint32_t>(NativeAudioEngineCore::laneCount);
}

sl_engine* sl_engine_create(double sample_rate,
                            uint32_t max_block_frames,
                            int32_t schema_version) {
    auto* e = new (std::nothrow) sl_engine();
    if (e == nullptr) return nullptr;
    // Unified create: a half-built engine is never handed back.
    if (!e->configure(sample_rate, max_block_frames)) {
        delete e;
        return nullptr;
    }
    e->schemaVersion = schema_version;
    // The boot wiring, installed ONCE — here, not in configure(), which also
    // runs on every rate change. A fresh engine is wired straight through so a
    // new strip is audible without ceremony; a reconfigure keeps whatever the
    // user has patched since.
    e->channels.installDefaultRoutes();
    return e;
}

void sl_engine_destroy(sl_engine* e) { delete e; }

int  sl_engine_start(sl_engine* e) { return (e != nullptr && e->core.start()) ? 1 : 0; }
void sl_engine_stop(sl_engine* e) { if (e != nullptr) e->core.stop(); }

int sl_engine_set_sample_rate(sl_engine* e, double sample_rate) {
    if (e == nullptr) return 0;
    const auto previousRate = e->sampleRate;
    if (e->configure(sample_rate, e->blockFrames)) return 1;
    // The previous rate stands: a failed reconfigure must not leave the engine
    // claiming a rate it is not running at.
    e->sampleRate = previousRate;
    return 0;
}

double   sl_engine_sample_rate(const sl_engine* e) { return e == nullptr ? 0.0 : e->sampleRate; }
uint32_t sl_engine_max_block_frames(const sl_engine* e) { return e == nullptr ? 0u : e->blockFrames; }
int32_t  sl_engine_schema_version(const sl_engine* e) { return e == nullptr ? 0 : e->schemaVersion; }

void sl_render_io(sl_engine* e,
                  const float* const* in_bus, uint32_t in_count,
                  float* const* bus_out, uint32_t bus_count,
                  uint32_t frames) {
    if (e == nullptr) return;
    renderInto(e, in_bus, in_count, bus_out, bus_count, frames);
}

void sl_render(sl_engine* e,
               float* const* bus_out, uint32_t bus_count,
               uint32_t frames) {
    if (e == nullptr) return;
    renderInto(e, nullptr, 0, bus_out, bus_count, frames);
}

uint64_t sl_engine_time_samples(const sl_engine* e) {
    return e == nullptr ? 0ull : e->engineTimeSamples.load(std::memory_order_relaxed);
}

/* ── Tape decks (§5) ────────────────────────────────────────────────────────
 *
 * Thin forwarders by design: every range check, every semantic and every
 * comment-of-record lives in sl::TapeBank (src/sl_tape.{h,cpp}), so this file
 * stays what it says it is — an ABI surface, not a second place to look for
 * behaviour. Null engine is the only check that belongs here. */

uint32_t sl_tape_count(void) { return sl::TapeBank::count(); }

int32_t sl_tape_load(sl_engine* e, uint32_t tape, uint32_t channels,
                     uint64_t frames, const float* const* data, double rate) {
    return e == nullptr ? 0 : e->tapes.load(tape, channels, frames, data, rate);
}

uint64_t sl_tape_frames(const sl_engine* e, uint32_t tape) {
    return e == nullptr ? 0ull : e->tapes.frames(tape);
}

uint32_t sl_tape_channels(const sl_engine* e, uint32_t tape) {
    return e == nullptr ? 0u : e->tapes.channels(tape);
}

void sl_tape_trigger(sl_engine* e, uint32_t tape, uint32_t mode) {
    if (e != nullptr) e->tapes.trigger(tape, mode);
}

void sl_tape_seek(sl_engine* e, uint32_t tape, uint64_t frame) {
    if (e != nullptr) e->tapes.seek(tape, frame);
}

double sl_tape_playhead(const sl_engine* e, uint32_t tape) {
    return e == nullptr ? 0.0 : e->tapes.playhead(tape);
}

uint32_t sl_tape_state(const sl_engine* e, uint32_t tape) {
    return e == nullptr ? 0u : e->tapes.state(tape);
}

int32_t sl_tape_insert(sl_engine* e, uint32_t tape, uint64_t at, uint32_t channels,
                       uint64_t frames, const float* const* planar) {
    return e == nullptr ? 0 : e->tapes.insert(tape, at, channels, frames, planar, e->sampleRate);
}

void sl_tape_overdub_start(sl_engine* e, uint32_t tape, uint32_t mode) {
    if (e != nullptr) e->tapes.overdubStart(tape, mode);
}

void sl_tape_overdub_stop(sl_engine* e, uint32_t tape) {
    if (e != nullptr) e->tapes.overdubStop(tape);
}

void sl_tape_scrub_begin(sl_engine* e, uint32_t tape) {
    if (e != nullptr) e->tapes.scrubBegin(tape);
}

void sl_tape_scrub_to(sl_engine* e, uint32_t tape, double frame) {
    if (e != nullptr) e->tapes.scrubTo(tape, frame);
}

void sl_tape_scrub_end(sl_engine* e, uint32_t tape) {
    if (e != nullptr) e->tapes.scrubEnd(tape);
}

void sl_tape_set_loop(sl_engine* e, uint32_t tape, uint32_t enabled,
                      uint64_t start, uint64_t end) {
    if (e != nullptr) e->tapes.setLoop(tape, enabled, start, end);
}

uint32_t sl_tape_waveform(const sl_engine* e, uint32_t tape, uint32_t channel,
                          uint64_t start_frame, uint64_t end_frame,
                          uint32_t columns, float* out_min, float* out_max) {
    return e == nullptr ? 0u
                        : e->tapes.waveform(tape, channel, start_frame, end_frame,
                                            columns, out_min, out_max);
}

void sl_tape_set_rate(sl_engine* e, uint32_t tape, double rate) {
    if (e != nullptr) e->tapes.setRate(tape, rate);
}

double sl_tape_rate(const sl_engine* e, uint32_t tape) {
    return e == nullptr ? 0.0 : e->tapes.rate(tape);
}

int32_t sl_tape_set_record_source(sl_engine* e, uint32_t tape, uint32_t kind,
                                  int32_t chan0, int32_t chan1) {
    return e == nullptr ? 0 : e->tapes.setRecordSource(tape, kind, chan0, chan1);
}

void sl_tape_record_start(sl_engine* e, uint32_t tape) {
    if (e == nullptr) return;
    // D-WZ-MON-01: armed to record means you HEAR what you are capturing. The
    // strip arrives with the monitor closed (that is the feedback fix), so REC
    // is what opens it, and the C-3 handoff in renderInto is what closes it
    // again — the gesture opens and completes on the same object.
    //
    // Scoped to a DEVICE INPUT deliberately. A `mainMix` or `channelBus` capture
    // is audible already by definition; opening the input monitor for one would
    // add a signal the user did not ask to hear, and on a mic it would be the
    // feedback loop this whole split exists to break.
    if (e->tapes.recordSourceKind(tape) ==
        static_cast<uint32_t>(sl::RecordSourceKind::deviceInput)) {
        const int32_t ch = e->channels.channelForTape(tape);
        if (ch >= 0) e->channels.setMonitor(static_cast<uint32_t>(ch), 1u);
    }
    e->tapes.recordStart(tape);
}

uint64_t sl_tape_record_stop(sl_engine* e, uint32_t tape) {
    return e == nullptr ? 0ull : e->tapes.recordStop(tape);
}

void sl_tape_record_service(sl_engine* e) {
    if (e != nullptr) e->tapes.recordService();
}

void sl_tape_set_record_cap_frames(sl_engine* e, uint32_t tape, uint64_t cap_frames) {
    if (e != nullptr) e->tapes.setRecordCapFrames(tape, cap_frames);
}

uint32_t sl_tape_record_cap_reached(const sl_engine* e, uint32_t tape) {
    return e == nullptr ? 0u : e->tapes.capReached(tape);
}

uint32_t sl_tape_drain(sl_engine* e, uint32_t tape, float* out,
                       uint32_t capacity_frames, uint64_t* out_start_sample) {
    return e == nullptr ? 0u : e->tapes.drain(tape, out, capacity_frames, out_start_sample);
}

int sl_engine_register_sample(sl_engine* e, const char* sample_id,
                              const float* left, const float* right,
                              uint32_t frames, double sample_rate) {
    if (e == nullptr || sample_id == nullptr || left == nullptr || frames == 0) return 0;
    NativeSample s;
    s.id = sample_id;
    s.sampleRate = sample_rate;
    // COPY: the caller must be free to release its buffer immediately.
    s.left.assign(left, left + frames);
    const float* r = right != nullptr ? right : left; // mono duplicates into both sides
    s.right.assign(r, r + frames);
    return e->core.registerSample(std::move(s)) ? 1 : 0;
}

/* ── The uniform strip channel ────────────────────────────────────────────── */

uint32_t sl_channel_count(void) { return sl::ChannelBank::count(); }

int32_t sl_channel_set_source(sl_engine* e, uint32_t channel, uint32_t kind, uint32_t index) {
    if (e == nullptr) return 0;
    // A grid-deck binding must name a deck the core actually has — the two
    // index spaces differ (3 grid decks, 8 tapes) and clamping would silently
    // point a strip at the wrong deck.
    if (kind == static_cast<uint32_t>(sl::ChannelSourceKind::gridDeck) && index >= kMaxDecks)
        return 0;

    // RELEASE THE OLD DECK FIRST. setDeckGainOverride stands until a republished
    // world supersedes it, so a channel that moves off a grid deck (or onto a
    // different one) would leave the old deck pinned at this strip's last level
    // and sends — silently, for the rest of the session. Hand it back to the
    // world's defaults instead.
    const bool wasDeck = e->channels.sourceKind(channel) ==
                         static_cast<std::uint32_t>(sl::ChannelSourceKind::gridDeck);
    const std::uint32_t oldDeck = e->channels.sourceIndex(channel);
    const bool staysOnSameDeck =
        wasDeck && kind == static_cast<uint32_t>(sl::ChannelSourceKind::gridDeck) &&
        index == oldDeck;

    const int32_t ok = e->channels.setSource(channel, kind, index);
    if (ok != 1) return ok;

    if (wasDeck && !staysOnSameDeck && oldDeck < kMaxDecks) {
        e->core.setDeckGainOverride(static_cast<int>(oldDeck), 1.0f); // DeckWorld's default
        for (std::uint32_t s = 0; s < sl::kNumSends; ++s)
            e->core.setDeckMasterSend(static_cast<int>(oldDeck), static_cast<int>(s) + 1, 0.0f);
    }
    // ...and push this channel's current settings onto the NEW deck, so binding
    // is what makes the strip's controls take effect rather than the next
    // incidental fader move.
    projectToCore(e, channel);
    return ok;
}

uint32_t sl_channel_source_kind(const sl_engine* e, uint32_t channel) {
    return e == nullptr ? 0u : e->channels.sourceKind(channel);
}

uint32_t sl_channel_source_index(const sl_engine* e, uint32_t channel) {
    return e == nullptr ? 0u : e->channels.sourceIndex(channel);
}

void sl_channel_set_level(sl_engine* e, uint32_t channel, double level) {
    if (e == nullptr) return;
    e->channels.setLevel(channel, level);
    projectToCore(e, channel);
}

double sl_channel_level(const sl_engine* e, uint32_t channel) {
    return e == nullptr ? 0.0 : e->channels.level(channel);
}

void sl_channel_set_send(sl_engine* e, uint32_t channel, uint32_t send, double level) {
    if (e == nullptr) return;
    e->channels.setSend(channel, send, level);
    projectToCore(e, channel);
}

double sl_channel_send(const sl_engine* e, uint32_t channel, uint32_t send) {
    return e == nullptr ? 0.0 : e->channels.sendLevel(channel, send);
}

void sl_channel_set_mute(sl_engine* e, uint32_t channel, uint32_t muted) {
    if (e == nullptr) return;
    e->channels.setMute(channel, muted);
    projectToCore(e, channel);
}

uint32_t sl_channel_muted(const sl_engine* e, uint32_t channel) {
    return e == nullptr ? 0u : e->channels.muted(channel);
}

void sl_channel_set_monitor(sl_engine* e, uint32_t channel, uint32_t on) {
    if (e != nullptr) e->channels.setMonitor(channel, on);
}

uint32_t sl_channel_monitor(const sl_engine* e, uint32_t channel) {
    return e == nullptr ? 0u : e->channels.monitorOn(channel);
}

// Non-const `e` on purpose, unlike every other getter here: these CONSUME the
// peak. A const pointer would advertise a pure read and invite a second caller
// that then silently halves the meter's readings by stealing every other frame.
double sl_channel_peak_l(sl_engine* e, uint32_t channel) {
    return e == nullptr ? 0.0 : e->channels.consumePeakL(channel);
}

double sl_channel_peak_r(sl_engine* e, uint32_t channel) {
    return e == nullptr ? 0.0 : e->channels.consumePeakR(channel);
}

/* ── The master output ───────────────────────────────────────────────────── */

void sl_master_set_level(sl_engine* e, double level) {
    if (e == nullptr || !std::isfinite(level) || level < 0.0) return;
    // Just an atomic. No republish of any kind: the gain is applied by the
    // render on the summed main pair, so the world is not involved — which also
    // means moving the fader cannot disturb the decks, the way a route through
    // submitMixerState would have.
    e->masterLevel.store(level, std::memory_order_relaxed);
}

double sl_master_level(const sl_engine* e) {
    return e == nullptr ? 0.0 : e->masterLevel.load(std::memory_order_relaxed);
}

/* ── The output watchdog (guard G1) ───────────────────────────────────────── */

uint32_t sl_watchdog_engaged(const sl_engine* e) {
    return e == nullptr ? 0u : e->watchdog.engaged();
}

double sl_watchdog_gain(const sl_engine* e) {
    return e == nullptr ? 1.0 : e->watchdog.gain();
}

void sl_watchdog_set_enabled(sl_engine* e, uint32_t enabled) {
    if (e != nullptr) e->watchdog.setEnabled(enabled);
}

/* ── Routing (§4) ─────────────────────────────────────────────────────────── */

int32_t sl_route_add(sl_engine* e, uint32_t src, uint32_t dst, double gain, uint32_t feedback) {
    return e == nullptr ? -1 : e->channels.addRoute(src, dst, gain, feedback);
}

int32_t sl_route_add_ex(sl_engine* e, uint32_t src_kind, uint32_t src_index, uint32_t src_sub,
                        uint32_t dst_kind, uint32_t dst_index, double gain, uint32_t feedback) {
    return e == nullptr ? -1
                        : e->channels.addRoute(src_kind, src_index, src_sub, dst_kind, dst_index,
                                               gain, feedback);
}

void sl_route_clear_all(sl_engine* e) {
    if (e != nullptr) e->channels.clearRoutes();
}

void sl_route_install_defaults(sl_engine* e) {
    if (e != nullptr) e->channels.installDefaultRoutes();
}

uint32_t sl_route_count_active(const sl_engine* e) {
    return e == nullptr ? 0u : e->channels.routeCountActive();
}

uint32_t sl_route_capacity(void) { return sl::ChannelBank::routeCapacity(); }

uint32_t sl_route_source_kind(const sl_engine* e, uint32_t id) {
    return e == nullptr ? 0u : e->channels.routeSourceKind(id);
}
uint32_t sl_route_source_index(const sl_engine* e, uint32_t id) {
    return e == nullptr ? 0u : e->channels.routeSourceIndex(id);
}
uint32_t sl_route_source_sub(const sl_engine* e, uint32_t id) {
    return e == nullptr ? 0xFFFFFFFFu : e->channels.routeSourceSub(id);
}
uint32_t sl_route_dest_kind(const sl_engine* e, uint32_t id) {
    return e == nullptr ? 0u : e->channels.routeDestKind(id);
}
uint32_t sl_route_dest_index(const sl_engine* e, uint32_t id) {
    return e == nullptr ? 0u : e->channels.routeDestIndex(id);
}
uint32_t sl_route_feedback(const sl_engine* e, uint32_t id) {
    return e == nullptr ? 0u : e->channels.routeFeedback(id);
}
uint32_t sl_route_is_default(const sl_engine* e, uint32_t id) {
    return e == nullptr ? 0u : e->channels.routeIsDefault(id);
}

int32_t sl_route_remove(sl_engine* e, uint32_t id) {
    return e == nullptr ? 0 : e->channels.removeRoute(id);
}

void sl_route_set_gain(sl_engine* e, uint32_t id, double gain) {
    if (e != nullptr) e->channels.setRouteGain(id, gain);
}

double sl_route_gain(const sl_engine* e, uint32_t id) {
    return e == nullptr ? 0.0 : e->channels.routeGain(id);
}

uint32_t sl_route_active(const sl_engine* e, uint32_t id) {
    return e == nullptr ? 0u : e->channels.routeActive(id);
}

uint32_t sl_route_would_cycle(const sl_engine* e, uint32_t src, uint32_t dst) {
    if (e == nullptr) return 0u;
    // src == dst is a cycle of length one; the graph walk would not report it.
    if (src == dst) return 1u;
    return e->channels.reaches(dst, src) ? 1u : 0u;
}

void sl_route_render_order(const sl_engine* e, uint32_t* out) {
    if (e != nullptr && out != nullptr) e->channels.renderOrder(out);
}

uint32_t sl_deck_count(void) { return static_cast<uint32_t>(kMaxDecks); }

void sl_deck_clear(sl_engine* e, uint32_t deck) {
    if (e == nullptr || deck >= kMaxDecks) return;
    e->deckWorlds[deck] = DeckWorld{};   // inactive slot → renders silence
    e->core.publishDJWorld(e->deckWorlds, e->mixer);
}

void sl_deck_set_tempo_sync(sl_engine* e, uint32_t deck, double ratio) {
    if (e == nullptr || deck >= kMaxDecks || !(ratio > 0.0)) return;
    e->deckWorlds[deck].tempoSyncRatio = ratio;
    // The ratio lives on the published DeckWorld (no live per-deck setter in the
    // core), so republish. Human-rate: a sync toggle, not an audio-thread write.
    e->core.publishDJWorld(e->deckWorlds, e->mixer);
}

double sl_deck_tempo_sync(const sl_engine* e, uint32_t deck) {
    return (e == nullptr || deck >= kMaxDecks) ? 1.0 : e->deckWorlds[deck].tempoSyncRatio;
}

int sl_snapshot_begin(sl_engine* e, uint32_t deck, double bpm, int is_playing, int32_t start_step) {
    if (e == nullptr || deck >= kMaxDecks) return 0;
    // Build THIS deck's slot; the others in the persistent array are retained so
    // committing one strip's deck does not wipe the rest. Each deck's own bpm
    // lives on its own snapshot — the per-deck-BPM isolation the merge requires.
    DeckWorld& d = e->deckWorlds[deck];
    d.snapshot = NativeSequencerSnapshot{};
    d.snapshot.bpm = bpm;
    d.snapshot.isPlaying = is_playing != 0;
    d.snapshot.startStep = start_step;
    d.active = true;             // this deck slot now renders
    d.crossfaderGain = 1.0f;     // full into the main mix (no DJ crossfade yet)
    d.tempoSyncRatio = 1.0;      // its own bpm, unstretched — master sync is §7
    d.dedicatedOutput = false;
    d.launchArmed = false;
    e->currentDeck = deck;
    e->trackOpen = false; // a half-built track from a discarded world never carries over
    return 1;
}

int sl_snapshot_track_begin(sl_engine* e, const char* sample_id,
                            const uint8_t* steps, uint32_t step_count) {
    if (e == nullptr || sample_id == nullptr || steps == nullptr || step_count == 0) return 0;
    e->track = NativeTrackSnapshot{};
    e->track.sampleId = sample_id;
    e->track.steps.assign(steps, steps + step_count);
    // The engine indexes pitchOffsets per step unconditionally, so it must be
    // step_count long even when the caller never sets it.
    e->track.pitchOffsets.assign(step_count, 0.0);
    e->trackOpen = true;
    return 1;
}

void sl_snapshot_track_set(sl_engine* e, int32_t param, double v) {
    if (e == nullptr || !e->trackOpen) return;
    NativeTrackSnapshot& t = e->track;
    SL_V3_SCALAR_PARAM_LAMBDAS
    switch (param) {
        SL_V3_SCALAR_PARAM_CASES
        default: break; // unknown key is IGNORED, never misread
    }
}

void sl_snapshot_track_set_array(sl_engine* e, int32_t param, const double* v, uint32_t n) {
    if (e == nullptr || !e->trackOpen || v == nullptr || n == 0) return;
    NativeTrackSnapshot& t = e->track;
    SL_V3_ARRAY_PARAM_LAMBDAS
    switch (param) {
        SL_V3_ARRAY_PARAM_CASES
        default: break;
    }
}

void sl_snapshot_track_end(sl_engine* e) {
    if (e == nullptr || !e->trackOpen) return;
    e->deckWorlds[e->currentDeck].snapshot.tracks.push_back(std::move(e->track));
    e->trackOpen = false;
}

int32_t sl_track_param_id(const char* name) {
    return lookupName(kScalarParamNames, SL_T_SCALAR_COUNT, name);
}

int32_t sl_track_array_id(const char* name) {
    return lookupName(kArrayParamNames, SL_TA_COUNT, name);
}

uint32_t sl_track_param_count(void) { return static_cast<uint32_t>(SL_T_SCALAR_COUNT); }
uint32_t sl_track_array_count(void) { return static_cast<uint32_t>(SL_TA_COUNT); }

const char* sl_track_param_name(uint32_t id) {
    return id < static_cast<uint32_t>(SL_T_SCALAR_COUNT) ? kScalarParamNames[id] : nullptr;
}

const char* sl_track_array_name(uint32_t id) {
    return id < static_cast<uint32_t>(SL_TA_COUNT) ? kArrayParamNames[id] : nullptr;
}

uint64_t sl_snapshot_commit(sl_engine* e) {
    if (e == nullptr) return 0;
    // Publish ALL decks in one atomic swap (DJ-mode multi-deck): each active
    // deck renders its own snapshot at its own bpm. publishDJWorld sets
    // djMode=true on the published world, so the render path reads per-deck
    // snapshots rather than the single compose-mode sequencerState.
    return e->core.publishDJWorld(e->deckWorlds, e->mixer);
}

uint32_t sl_hotframe_length(void) { return SL_HOTFRAME_LENGTH; }

uint32_t sl_hotframe(sl_engine* e, double* out, uint32_t capacity) {
    if (e == nullptr || out == nullptr) return 0;
    if (capacity < SL_HOTFRAME_LENGTH) return 0; // refuse-short, never truncate

    std::fill_n(out, SL_HOTFRAME_LENGTH, 0.0);

    out[SL_HF_frameCounter] = static_cast<double>(++e->hotFrameCounter);
    const auto now = std::chrono::steady_clock::now();
    out[SL_HF_hostTimeMs] =
        std::chrono::duration<double, std::milli>(now - e->created).count();

    // consumeOutputPeak/consumeInputPeak read-AND-RESET, so the frame reports
    // the peak since the previous frame — the meter behaviour the UI expects.
    const double outPeak = e->core.consumeOutputPeak();
    // The core exposes ONE main-bus peak; scoopy's frame carries L and R. Mirror
    // it to both rather than invent a stereo split the core does not provide.
    out[SL_HF_outputPeakL] = outPeak;
    out[SL_HF_outputPeakR] = outPeak;
    out[SL_HF_outputClip] = outPeak >= 0.999 ? 1.0 : 0.0; // scoopy clip threshold
    out[SL_HF_inputPeak] = e->core.consumeInputPeak();

    const auto d = e->core.diagnostics();
    out[SL_HF_callbackLoad] = d.callbackLoad;
    out[SL_HF_deadlineMissCount] = static_cast<double>(d.deadlineMissCount);

    out[SL_HF_playheadStepDeck0] = static_cast<double>(e->core.deckPlayheadStep(0));
    out[SL_HF_playheadStepDeck1] = static_cast<double>(e->core.deckPlayheadStep(1));
    out[SL_HF_playheadStepDeck2] = static_cast<double>(e->core.deckPlayheadStep(2));

    // ── The plane (merge P2 step 4) ──────────────────────────────────────────
    // The strip surface's telemetry: what each strip is contributing, what each
    // tape is doing, and whether the watchdog is holding the output. This is
    // the ONLY engine state the plane's UI reads at frame rate — everything
    // else it knows comes from the document it owns.
    for (uint32_t c = 0; c < sl::kMaxChannels; ++c) {
        // Consuming reads: peak SINCE THE LAST FRAME, matching the core's own
        // consumeOutputPeak above. Emitting the frame is what consumes them, so
        // nothing else may call these.
        out[SL_HF_slChanPeakL0 + c] = e->channels.consumePeakL(c);
        out[SL_HF_slChanPeakR0 + c] = e->channels.consumePeakR(c);
    }
    for (uint32_t t = 0; t < sl::kMaxTapes; ++t) {
        out[SL_HF_slTapePlayhead0 + t] = e->tapes.playhead(t);
        out[SL_HF_slTapeState0 + t] = static_cast<double>(e->tapes.state(t));
        // Reported every frame rather than latched at the moment it happens: a
        // cap that fires while the panel is closed would otherwise never be
        // seen, and the tape it stopped looks like an ordinary looping tape.
        out[SL_HF_slTapeCap0 + t] = e->tapes.capReached(t) != 0 ? 1.0 : 0.0;
    }
    out[SL_HF_slWatchdogEngaged] = e->watchdog.engaged() != 0 ? 1.0 : 0.0;
    out[SL_HF_slWatchdogGain] = e->watchdog.gain();

    // THE MONITOR SWITCHES, as a bitmask (bit c = channel c's input reaches its
    // channel). One scalar rather than eight: eight booleans are eight bits and
    // a double carries them exactly.
    //
    // ⚠️ IT HAS TO BE REPORTED, not inferred from the document, because the
    // ENGINE moves these switches itself — `sl_tape_record_start` opens one and
    // the Law C-3 handoff closes it in the same render block (D-WZ-MON-01/02).
    // A strip drawing MON from what it last asked for would show it lit over a
    // closed gate the instant a loop closed, which is the exact drift
    // `sl_deck_tempo_sync` was added to end for tempo sync.
    uint32_t monitorMask = 0;
    for (uint32_t c = 0; c < sl::kMaxChannels; ++c)
        if (e->channels.monitorOn(c) != 0) monitorMask |= (1u << c);
    out[SL_HF_slChanMonitorMask] = static_cast<double>(monitorMask);

    // Per-track step/pos/level and the carve blocks stay 0 (idle meters) until
    // v3 exposes the sequencer detail behind them — zero-filled, never faked.
    return SL_HOTFRAME_LENGTH;
}

} // extern "C"
