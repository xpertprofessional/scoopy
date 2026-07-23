#include "wz_engine.h"

#include <atomic>
#include <cmath>
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

void wz_engine_render(wz_engine* e,
                      float* const* bus_out,
                      uint32_t bus_count,
                      uint32_t frames) {
    if (e == nullptr) return;
    // P0: no world, no sources — every bus is silence. mainGain is loaded so
    // the atomic path is exercised (scaling 0 stays 0); real summing arrives
    // with channels in P1.
    const double mainGain = e->params[0].load(std::memory_order_relaxed);
    (void)mainGain;
    if (bus_out != nullptr) {
        for (uint32_t b = 0; b < bus_count; ++b) {
            float* buf = bus_out[b];
            if (buf == nullptr) continue;
            for (uint32_t i = 0; i < frames; ++i) buf[i] = 0.0f;
        }
    }
    // The clock advances regardless of transport state (D-CLOCK-01 model).
    e->engineTimeSamples.fetch_add(frames, std::memory_order_relaxed);
}

uint32_t wz_engine_hotframe(const wz_engine* e, double* out, uint32_t capacity) {
    if (e == nullptr || out == nullptr || capacity < kHotFrameLength) return 0;
    out[0] = static_cast<double>(e->schemaVersion);
    out[1] = static_cast<double>(e->engineTimeSamples.load(std::memory_order_relaxed));
    out[2] = 0.0; // cpuLoad — placeholder until the render path has work to measure
    out[3] = 0.0; // feedbackAlarm — watchdog lands in P4
    out[4] = 0.0; // mainPeakL
    out[5] = 0.0; // mainPeakR
    out[6] = 0.0; // monitorPeakL
    out[7] = 0.0; // monitorPeakR
    return kHotFrameLength;
}

} // extern "C"
