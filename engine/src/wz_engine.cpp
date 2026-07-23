#include "wz_engine.h"

#include "world.h"

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <new>
#include <vector>

namespace {

// Order MUST match WZProtocol.h's ParamId (generated from schema.ts). The ABI
// coverage gate (P0-08) verifies this table against the schema so a param can
// never be carried on one side of the boundary and not the other.
// mainGain is master-global; gain/pan/mute/solo address the CURRENT world's
// channel atomics (per-strip).
constexpr const char* kParamNames[] = {
    "mainGain", "gain", "pan", "mute", "solo",
};
constexpr uint32_t kParamCount = sizeof(kParamNames) / sizeof(kParamNames[0]);

constexpr double kParamDefaults[kParamCount] = {
    1.0,  // mainGain (linear master output trim)
    0.75, // gain (fader position; unity detent — D-WZ-FADER-01)
    0.0,  // pan
    0.0,  // mute
    0.0,  // solo
};

// World-builder channel field keys (wz_world_key_for_name). Distinct from
// ParamIds: these describe TOPOLOGY + initial values at build time.
constexpr const char* kWorldKeyNames[] = {
    "srcKind", "srcChan0", "srcChan1", "toMonitor",
    "gain", "pan", "mute", "solo", "deckIndex",
};
constexpr uint32_t kWorldKeyCount = sizeof(kWorldKeyNames) / sizeof(kWorldKeyNames[0]);
enum WorldKey : int32_t {
    kWkSrcKind = 0, kWkSrcChan0, kWkSrcChan1, kWkToMonitor,
    kWkGain, kWkPan, kWkMute, kWkSolo, kWkDeckIndex,
};

int32_t indexOfName(const char* name, const char* const* table, uint32_t count) {
    if (name == nullptr) return WZ_PARAM_UNKNOWN;
    for (uint32_t i = 0; i < count; ++i)
        if (std::strcmp(name, table[i]) == 0) return static_cast<int32_t>(i);
    return WZ_PARAM_UNKNOWN;
}

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
    // Master-global params (mainGain). Per-channel params live in the World's
    // ChannelState atomics.
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

    // --- world (RCU) -----------------------------------------------------
    // `world` is the installed snapshot the render thread reads (one load per
    // block). Control side (message thread, single-writer): builder state +
    // the retired list. A retired world is freed on a LATER commit, once
    // renderWorldRev shows the render thread has moved past its revision —
    // bounded by edit count, each world is tiny (topology only, no audio).
    std::atomic<wz::World*> world;
    std::atomic<uint64_t> renderWorldRev; // last revision seen by render()
    wz::World* builder;                   // non-null between begin() and commit()
    wz::ChannelState* builderChannel;     // open channel inside the builder
    uint64_t revisionCounter;
    std::vector<std::unique_ptr<wz::World>> retired;
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
    e->world.store(new (std::nothrow) wz::World(), std::memory_order_release);
    e->renderWorldRev.store(0, std::memory_order_relaxed);
    e->builder = nullptr;
    e->builderChannel = nullptr;
    e->revisionCounter = 0;
    if (e->world.load(std::memory_order_relaxed) == nullptr) { // OOM on the empty world
        delete e;
        return nullptr;
    }
    return e;
}

void wz_engine_destroy(wz_engine* e) {
    if (e == nullptr) return;
    delete e->world.load(std::memory_order_relaxed);
    delete e->builder;
    e->retired.clear();
    delete e;
}

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
    return indexOfName(name, kParamNames, kParamCount);
}

uint32_t wz_param_count(void) { return kParamCount; }

const char* wz_param_name(uint32_t id) {
    return id < kParamCount ? kParamNames[id] : nullptr;
}

namespace {

// ParamId → the channel atomic it addresses (nullptr for master-global ids).
std::atomic<double>* channelParamSlot(wz::ChannelState& ch, int32_t id) {
    switch (id) {
        case 1: return &ch.params.gain;
        case 2: return &ch.params.pan;
        case 3: return &ch.params.mute;
        case 4: return &ch.params.solo;
        default: return nullptr;
    }
}

} // namespace

void wz_param_set(wz_engine* e, uint32_t channel, int32_t id, double value) {
    if (e == nullptr || id < 0 || static_cast<uint32_t>(id) >= kParamCount) return;
    if (id == 0) { // mainGain — master-global
        e->params[0].store(value, std::memory_order_relaxed);
        return;
    }
    auto* w = e->world.load(std::memory_order_acquire);
    if (w == nullptr || channel >= w->channels.size()) return; // no such strip: no-op
    if (auto* slot = channelParamSlot(*w->channels[channel], id))
        slot->store(value, std::memory_order_relaxed);
}

double wz_param_get(const wz_engine* e, uint32_t channel, int32_t id) {
    if (e == nullptr || id < 0 || static_cast<uint32_t>(id) >= kParamCount) return 0.0;
    if (id == 0) return e->params[0].load(std::memory_order_relaxed);
    auto* w = e->world.load(std::memory_order_acquire);
    if (w == nullptr || channel >= w->channels.size()) return 0.0;
    if (auto* slot = channelParamSlot(*w->channels[channel], id))
        return slot->load(std::memory_order_relaxed);
    return 0.0;
}

/* --- world builder (control thread, single-writer) ---------------------- */

int32_t wz_world_key_for_name(const char* name) {
    return indexOfName(name, kWorldKeyNames, kWorldKeyCount);
}

void wz_world_begin(wz_engine* e) {
    if (e == nullptr) return;
    delete e->builder; // discard any unfinished builder
    e->builder = new (std::nothrow) wz::World();
    e->builderChannel = nullptr;
}

uint32_t wz_world_channel_begin(wz_engine* e, const char* channel_key) {
    if (e == nullptr || e->builder == nullptr) return 0;
    auto ch = std::make_unique<wz::ChannelState>();
    ch->key = channel_key != nullptr ? channel_key : "";
    e->builderChannel = ch.get();
    e->builder->channels.push_back(std::move(ch));
    return static_cast<uint32_t>(e->builder->channels.size() - 1);
}

void wz_world_channel_set(wz_engine* e, int32_t key, double value) {
    if (e == nullptr || e->builderChannel == nullptr) return;
    auto& ch = *e->builderChannel;
    switch (key) {
        case kWkSrcKind: ch.srcKind = static_cast<wz::SourceKind>(static_cast<int32_t>(value)); break;
        case kWkSrcChan0: ch.srcChan0 = static_cast<int32_t>(value); break;
        case kWkSrcChan1: ch.srcChan1 = static_cast<int32_t>(value); break;
        case kWkToMonitor: ch.toMonitor = value != 0.0; break;
        case kWkGain: ch.params.gain.store(value, std::memory_order_relaxed); break;
        case kWkPan: ch.params.pan.store(value, std::memory_order_relaxed); break;
        case kWkMute: ch.params.mute.store(value, std::memory_order_relaxed); break;
        case kWkSolo: ch.params.solo.store(value, std::memory_order_relaxed); break;
        case kWkDeckIndex: ch.deckIndex = static_cast<int32_t>(value); break;
        default: break; // unknown key ignored, never misread
    }
}

void wz_world_channel_end(wz_engine* e) {
    if (e != nullptr) e->builderChannel = nullptr;
}

uint64_t wz_world_commit(wz_engine* e) {
    if (e == nullptr) return 0;
    auto* current = e->world.load(std::memory_order_relaxed);
    if (e->builder == nullptr) // commit without begin: no-op
        return current != nullptr ? current->revision : 0;

    e->builder->revision = ++e->revisionCounter;
    e->builderChannel = nullptr;
    auto* installed = e->builder;
    e->builder = nullptr;

    auto* old = e->world.exchange(installed, std::memory_order_acq_rel);
    if (old != nullptr) e->retired.emplace_back(old);

    // Free retired snapshots the render thread has provably moved past. If the
    // device is closed (render never runs) the list simply grows with edits —
    // topology-only objects, bounded by session activity.
    const auto renderRev = e->renderWorldRev.load(std::memory_order_acquire);
    e->retired.erase(
        std::remove_if(e->retired.begin(), e->retired.end(),
                       [renderRev](const std::unique_ptr<wz::World>& w) {
                           return renderRev > w->revision;
                       }),
        e->retired.end());
    return installed->revision;
}

uint32_t wz_world_channel_count(const wz_engine* e) {
    if (e == nullptr) return 0;
    auto* w = e->world.load(std::memory_order_acquire);
    return w != nullptr ? static_cast<uint32_t>(w->channels.size()) : 0;
}

uint64_t wz_world_revision(const wz_engine* e) {
    if (e == nullptr) return 0;
    auto* w = e->world.load(std::memory_order_acquire);
    return w != nullptr ? w->revision : 0;
}

void wz_engine_set_test_tone(wz_engine* e, uint32_t enabled) {
    if (e != nullptr) e->testTone.store(enabled ? 1u : 0u, std::memory_order_relaxed);
}

void wz_engine_render(wz_engine* e,
                      float* const* bus_out,
                      uint32_t bus_count,
                      uint32_t frames) {
    if (e == nullptr) return;

    // Pick up the current world snapshot (RCU: one acquire load per block) and
    // acknowledge its revision so the control thread can retire older ones.
    auto* world = e->world.load(std::memory_order_acquire);
    if (world != nullptr)
        e->renderWorldRev.store(world->revision, std::memory_order_release);

    // Channel summing lands in P1-04; this block still renders silence (+ the
    // P0 boot tone below). Every bus starts as silence. The main bus is
    // output channels 0 (L) and 1 (R).
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
