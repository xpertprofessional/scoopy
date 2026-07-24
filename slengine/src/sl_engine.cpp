// SL ABI v3 — implementation. Thin by design: all behaviour lives in the
// vendored scoopy core, which this tier is forbidden to edit (engine.lock.json;
// apps/scoopy is the only writable home until the P3 flip).
#include "sl_engine.h"

#include "NativeAudioEngineCore.hpp"

#include <algorithm>
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
    std::vector<float> silenceIn;
    std::uint32_t blockFrames = 0;
    double sampleRate = 0.0;
    std::int32_t schemaVersion = 0;

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

        MixerState mixer;
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

} // extern "C"
