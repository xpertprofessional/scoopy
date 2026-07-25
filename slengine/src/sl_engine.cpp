// SL ABI v3 — implementation. Thin by design: all behaviour lives in the
// vendored scoopy core, which this tier is forbidden to edit (engine.lock.json;
// apps/scoopy is the only writable home until the P3 flip).
#include "sl_engine.h"

#include "NativeAudioEngineCore.hpp"
#include "NativeToneFilter.hpp"

#include <algorithm>
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

    std::vector<float> silenceIn;
    std::uint32_t blockFrames = 0;
    double sampleRate = 0.0;
    std::int32_t schemaVersion = 0;

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

int lookupName(const char* const* table, uint32_t count, const char* name) {
    if (name == nullptr) return SL_PARAM_UNKNOWN;
    for (uint32_t k = 0; k < count; ++k)
        if (std::strcmp(table[k], name) == 0) return static_cast<int>(k);
    return SL_PARAM_UNKNOWN;
}

/** The one render path; sl_render is sl_render_io with no inputs. Kept single
    so the input-carrying and silent cases can never diverge in lane handling. */
void renderInto(sl_engine* e,
                const float* inL, const float* inR,
                float* const* bus_out, std::uint32_t bus_count,
                std::uint32_t frames) {
    if (e == nullptr || bus_out == nullptr) return;
    if (frames == 0 || frames > e->blockFrames) return; // never render past the configured block

    const ScopedFlushDenormals noDenormals;

    for (auto& lane : e->lanes) std::fill_n(lane.begin(), frames, 0.0f);
    e->core.render(inL, inR, e->lanePtrs, frames);

    // Buses the engine has no lane for are left ALONE — the caller owns those
    // buffers and may be summing something else into them. Zeroing here would
    // be this tier silently deciding it owns memory it was only lent.
    const auto n = std::min<std::size_t>(bus_count, NativeAudioEngineCore::laneCount);
    for (std::size_t i = 0; i < n; ++i)
        if (bus_out[i] != nullptr)
            std::copy_n(e->lanes[i].data(), frames, bus_out[i]);
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
    // The core takes two input channels. A mono input feeds both sides rather
    // than leaving one silent; no input at all feeds the pre-allocated silence.
    const float* inL = e->silenceIn.data();
    const float* inR = e->silenceIn.data();
    if (in_bus != nullptr && in_count >= 1 && in_bus[0] != nullptr) {
        inL = in_bus[0];
        inR = (in_count >= 2 && in_bus[1] != nullptr) ? in_bus[1] : in_bus[0];
    }
    renderInto(e, inL, inR, bus_out, bus_count, frames);
}

void sl_render(sl_engine* e,
               float* const* bus_out, uint32_t bus_count,
               uint32_t frames) {
    if (e == nullptr) return;
    renderInto(e, e->silenceIn.data(), e->silenceIn.data(), bus_out, bus_count, frames);
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

uint32_t sl_deck_count(void) { return static_cast<uint32_t>(kMaxDecks); }

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

    // Per-track step/pos/level and the carve blocks stay 0 (idle meters) until
    // v3 exposes the sequencer detail behind them — zero-filled, never faked.
    return SL_HOTFRAME_LENGTH;
}

} // extern "C"
