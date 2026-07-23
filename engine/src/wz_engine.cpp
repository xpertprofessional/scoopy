#include "wz_engine.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <new>

namespace {

// Order MUST match WZProtocol.h's ParamId (generated from schema.ts). The ABI
// coverage gate (P0-08) verifies this table against the schema so a param can
// never be carried on one side of the boundary and not the other.
constexpr const char* kParamNames[] = {
    "mainGain",
};
constexpr uint32_t kParamCount = sizeof(kParamNames) / sizeof(kParamNames[0]);

constexpr double kParamDefaults[kParamCount] = {
    1.0, // mainGain (linear master output trim)
};

// Hotframe slots — order MUST match schema.ts HOT_FRAME_SCALARS:
// 0 schemaVersion echo · 1 engineTimeSamples · 2 cpuLoad · 3 feedbackAlarm ·
// 4 mainPeakL · 5 mainPeakR · 6 monitorPeakL · 7 monitorPeakR.
constexpr uint32_t kHotFrameLength = 8;

} // namespace

namespace {
constexpr double kTwoPi = 6.283185307179586;
constexpr double kTestToneHz = 440.0;
constexpr double kTestToneAmp = 0.125892541; // -18 dBFS
} // namespace

struct wz_engine {
    std::atomic<double> sampleRate;
    uint32_t maxBlockFrames;
    int32_t schemaVersion;
    // Master-global params (indexed by ParamId). Per-channel storage becomes a
    // 2D table keyed by (channel, id) in P1; the ABI signature already carries
    // the channel index so that growth is not a re-layout.
    std::atomic<double> params[kParamCount];
    // Monotonic sample counter — the authoritative engine clock (parlante
    // D-CLOCK-01 model). Advanced by exactly `frames` every render, regardless
    // of transport, so realignment across takes (Law C-2) is a pure delta.
    std::atomic<uint64_t> engineTimeSamples;
    // Main-bus output peak (linear) of the most recent render block, published
    // into HotFrame. Written on the render thread, read on the UI/timer thread.
    std::atomic<double> mainPeakL;
    std::atomic<double> mainPeakR;
    // Boot-tone (P0 skeleton). `phase` is render-thread-only mutable state.
    std::atomic<uint32_t> testTone;
    double tonePhase;
};

extern "C" {

int32_t wz_abi_version(void) { return WZ_ABI_VERSION; }

wz_engine* wz_engine_create(double sample_rate,
                            uint32_t max_block_frames,
                            int32_t schema_version) {
    if (sample_rate <= 0.0 || max_block_frames == 0) return nullptr;
    auto* e = new (std::nothrow) wz_engine();
    if (e == nullptr) return nullptr;
    e->sampleRate.store(sample_rate, std::memory_order_relaxed);
    e->maxBlockFrames = max_block_frames;
    e->schemaVersion = schema_version;
    for (uint32_t i = 0; i < kParamCount; ++i)
        e->params[i].store(kParamDefaults[i], std::memory_order_relaxed);
    e->engineTimeSamples.store(0, std::memory_order_relaxed);
    e->mainPeakL.store(0.0, std::memory_order_relaxed);
    e->mainPeakR.store(0.0, std::memory_order_relaxed);
    e->testTone.store(0, std::memory_order_relaxed);
    e->tonePhase = 0.0;
    return e;
}

void wz_engine_destroy(wz_engine* e) { delete e; }

uint32_t wz_engine_max_block_frames(const wz_engine* e) {
    return e ? e->maxBlockFrames : 0u;
}

void wz_engine_set_sample_rate(wz_engine* e, double sample_rate) {
    if (e == nullptr || sample_rate <= 0.0) return;
    e->sampleRate.store(sample_rate, std::memory_order_relaxed);
}

double wz_engine_sample_rate(const wz_engine* e) {
    return e ? e->sampleRate.load(std::memory_order_relaxed) : 0.0;
}

int32_t wz_param_id_for_name(const char* name) {
    if (name == nullptr) return WZ_PARAM_UNKNOWN;
    for (uint32_t i = 0; i < kParamCount; ++i) {
        const char* a = name;
        const char* b = kParamNames[i];
        while (*a != '\0' && *b != '\0' && *a == *b) { ++a; ++b; }
        if (*a == '\0' && *b == '\0') return static_cast<int32_t>(i);
    }
    return WZ_PARAM_UNKNOWN;
}

uint32_t wz_param_count(void) { return kParamCount; }

const char* wz_param_name(uint32_t id) {
    return id < kParamCount ? kParamNames[id] : nullptr;
}

void wz_param_set(wz_engine* e, uint32_t channel, int32_t id, double value) {
    (void)channel; // master-global params ignore the strip index (P0)
    if (e == nullptr || id < 0 || static_cast<uint32_t>(id) >= kParamCount) return;
    e->params[static_cast<uint32_t>(id)].store(value, std::memory_order_relaxed);
}

double wz_param_get(const wz_engine* e, uint32_t channel, int32_t id) {
    (void)channel;
    if (e == nullptr || id < 0 || static_cast<uint32_t>(id) >= kParamCount) return 0.0;
    return e->params[static_cast<uint32_t>(id)].load(std::memory_order_relaxed);
}

void wz_engine_set_test_tone(wz_engine* e, uint32_t enabled) {
    if (e != nullptr) e->testTone.store(enabled ? 1u : 0u, std::memory_order_relaxed);
}

void wz_engine_render(wz_engine* e,
                      float* const* bus_out,
                      uint32_t bus_count,
                      uint32_t frames) {
    if (e == nullptr) return;

    // P0: no world, no sources. Every bus starts as silence. The main bus is
    // output channels 0 (L) and 1 (R); real channel summing arrives in P1.
    if (bus_out != nullptr) {
        for (uint32_t b = 0; b < bus_count; ++b) {
            if (bus_out[b] != nullptr)
                for (uint32_t i = 0; i < frames; ++i) bus_out[b][i] = 0.0f;
        }
    }

    // Boot tone (skeleton proof): a -18 dBFS 440 Hz sine × mainGain on the main
    // bus. Metering below reads whatever ends up on channels 0/1, so it stays
    // correct once P1 replaces the tone with real channel output.
    const double mainGain = e->params[0].load(std::memory_order_relaxed);
    if (e->testTone.load(std::memory_order_relaxed) != 0 && bus_out != nullptr &&
        bus_count >= 1 && bus_out[0] != nullptr) {
        const double sr = e->sampleRate.load(std::memory_order_relaxed);
        const double inc = kTwoPi * kTestToneHz / (sr > 0.0 ? sr : 48000.0);
        double phase = e->tonePhase;
        float* l = bus_out[0];
        float* r = (bus_count >= 2 && bus_out[1] != nullptr) ? bus_out[1] : nullptr;
        for (uint32_t i = 0; i < frames; ++i) {
            const auto s = static_cast<float>(std::sin(phase) * kTestToneAmp * mainGain);
            l[i] = s;
            if (r != nullptr) r[i] = s;
            phase += inc;
            if (phase >= kTwoPi) phase -= kTwoPi;
        }
        e->tonePhase = phase;
    }

    // Main-bus metering (float64 accumulate per D-WZ-DSP-01): the block peak on
    // channels 0/1, published for the next HotFrame read.
    double peakL = 0.0, peakR = 0.0;
    if (bus_out != nullptr && bus_count >= 1 && bus_out[0] != nullptr)
        for (uint32_t i = 0; i < frames; ++i)
            peakL = std::max(peakL, std::abs(static_cast<double>(bus_out[0][i])));
    if (bus_out != nullptr && bus_count >= 2 && bus_out[1] != nullptr)
        for (uint32_t i = 0; i < frames; ++i)
            peakR = std::max(peakR, std::abs(static_cast<double>(bus_out[1][i])));
    else
        peakR = peakL;
    e->mainPeakL.store(peakL, std::memory_order_relaxed);
    e->mainPeakR.store(peakR, std::memory_order_relaxed);

    // The clock advances regardless of transport state (D-CLOCK-01 model).
    e->engineTimeSamples.fetch_add(frames, std::memory_order_relaxed);
}

uint32_t wz_engine_hotframe(const wz_engine* e, double* out, uint32_t capacity) {
    if (e == nullptr || out == nullptr || capacity < kHotFrameLength) return 0;
    out[0] = static_cast<double>(e->schemaVersion);
    out[1] = static_cast<double>(e->engineTimeSamples.load(std::memory_order_relaxed));
    out[2] = 0.0; // cpuLoad — placeholder until the render path has work to measure
    out[3] = 0.0; // feedbackAlarm — watchdog lands in P4
    out[4] = e->mainPeakL.load(std::memory_order_relaxed);
    out[5] = e->mainPeakR.load(std::memory_order_relaxed);
    out[6] = 0.0; // monitorPeakL — the monitor bus lands with channels in P1
    out[7] = 0.0; // monitorPeakR
    return kHotFrameLength;
}

} // extern "C"
