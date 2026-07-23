#include "wz_engine.h"

#include "fader.h"
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
    0.75, // mainGain (fader POSITION — unity detent, D-WZ-FADER-01)
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
constexpr double kPi = 3.14159265358979323846;
constexpr double kRampSeconds = 0.010; // D-WZ-RAMP-01: one 10 ms constant
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
    // Bus output peaks (linear) of the most recent render block, published
    // into HotFrame. Written on the render thread, read on the UI/timer thread.
    std::atomic<double> mainPeakL;
    std::atomic<double> mainPeakR;
    std::atomic<double> monitorPeakL;
    std::atomic<double> monitorPeakR;
    // Master-fader smoother state (render-thread-only); -1 = seed from target.
    double smMain;
    // Preallocated float64 bus accumulators (D-WZ-DSP-01), maxBlockFrames each
    // — sized at create so render never allocates.
    std::vector<double> accMainL, accMainR, accMonL, accMonR;

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
    e->monitorPeakL.store(0.0, std::memory_order_relaxed);
    e->monitorPeakR.store(0.0, std::memory_order_relaxed);
    e->smMain = -1.0;
    e->accMainL.assign(max_block_frames, 0.0);
    e->accMainR.assign(max_block_frames, 0.0);
    e->accMonL.assign(max_block_frames, 0.0);
    e->accMonR.assign(max_block_frames, 0.0);
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

namespace {

// Raised-cosine shape over ramp position r ∈ [0,1] (D-WZ-RAMP-01): 0 = closed,
// 1 = open, smooth at both ends.
inline double rampShape(double r) { return 0.5 * (1.0 - std::cos(kPi * r)); }

// Advance a ramp position toward `target` (0 or 1) by one sample step.
inline double rampStep(double r, double target, double step) {
    if (r < target) return std::min(target, r + step);
    if (r > target) return std::max(target, r - step);
    return r;
}

inline double sanitize(float s) {
    return std::isfinite(s) ? static_cast<double>(s) : 0.0; // NaN/Inf squelched at strip input
}

} // namespace

void wz_engine_render_io(wz_engine* e,
                         const float* const* in_bus,
                         uint32_t in_count,
                         float* const* bus_out,
                         uint32_t bus_count,
                         uint32_t frames) {
    if (e == nullptr) return;
    if (frames > e->maxBlockFrames) frames = e->maxBlockFrames; // never overrun the accumulators

    // Pick up the current world snapshot (RCU: one acquire load per block) and
    // acknowledge its revision so the control thread can retire older ones.
    auto* world = e->world.load(std::memory_order_acquire);
    if (world != nullptr)
        e->renderWorldRev.store(world->revision, std::memory_order_release);

    const double sr = e->sampleRate.load(std::memory_order_relaxed);
    const double fs = sr > 0.0 ? sr : 48000.0;
    // One-pole coefficient for ~10 ms settling; ramp step for the 10 ms
    // raised-cosine (both from the single D-WZ-RAMP-01 constant).
    const double alpha = 1.0 - std::exp(-1.0 / (kRampSeconds * fs));
    const double step = 1.0 / (kRampSeconds * fs);

    double* accL = e->accMainL.data();
    double* accR = e->accMainR.data();
    double* monL = e->accMonL.data();
    double* monR = e->accMonR.data();
    for (uint32_t i = 0; i < frames; ++i) accL[i] = accR[i] = monL[i] = monR[i] = 0.0;

    if (world != nullptr) {
        // In-place solo: any solo engaged anywhere ducks non-soloed strips on
        // MAIN only (monitor/cue unaffected) — spec §2.
        bool anySolo = false;
        for (const auto& ch : world->channels)
            if (ch->params.solo.load(std::memory_order_relaxed) != 0.0) { anySolo = true; break; }

        for (const auto& chPtr : world->channels) {
            auto& ch = *chPtr;

            // Source pointers for this block (same-clock duplex inputs only in
            // P1; decks join in P1-07, rings in P2).
            const float* srcL = nullptr;
            const float* srcR = nullptr;
            if (ch.srcKind == wz::SourceKind::deviceInput && in_bus != nullptr) {
                if (ch.srcChan0 >= 0 && static_cast<uint32_t>(ch.srcChan0) < in_count)
                    srcL = in_bus[ch.srcChan0];
                if (ch.srcChan1 >= 0 && static_cast<uint32_t>(ch.srcChan1) < in_count)
                    srcR = in_bus[ch.srcChan1];
                if (srcR == nullptr) srcR = srcL; // mono pick feeds both sides
            }

            // Block-rate targets; per-sample smoothing below.
            const double faderLin =
                wz::faderPositionToLinear(ch.params.gain.load(std::memory_order_relaxed));
            const double pan = ch.params.pan.load(std::memory_order_relaxed);
            const double theta = (std::clamp(pan, -1.0, 1.0) + 1.0) * kPi / 4.0;
            const double tgtL = faderLin * std::cos(theta); // D-WZ-PAN-01
            const double tgtR = faderLin * std::sin(theta);
            const double muteTgt = ch.params.mute.load(std::memory_order_relaxed) != 0.0 ? 0.0 : 1.0;
            const double soloTgt =
                (anySolo && ch.params.solo.load(std::memory_order_relaxed) == 0.0) ? 0.0 : 1.0;

            // Fresh strips start AT their targets: a publish is a document
            // swap, not a gesture (no fade-in on world install).
            if (ch.smGainL < 0.0) { ch.smGainL = tgtL; ch.smGainR = tgtR; }
            if (ch.muteRamp < 0.0) ch.muteRamp = muteTgt;

            double pkL = 0.0, pkR = 0.0, sumSqL = 0.0, sumSqR = 0.0;
            const bool feedsMonitor = ch.toMonitor;

            for (uint32_t i = 0; i < frames; ++i) {
                ch.smGainL += alpha * (tgtL - ch.smGainL);
                ch.smGainR += alpha * (tgtR - ch.smGainR);
                ch.muteRamp = rampStep(ch.muteRamp, muteTgt, step);
                ch.soloRamp = rampStep(ch.soloRamp, soloTgt, step);
                const double muteG = rampShape(ch.muteRamp);
                const double soloG = rampShape(ch.soloRamp);

                const double inL = srcL != nullptr ? sanitize(srcL[i]) : 0.0;
                const double inR = srcR != nullptr ? sanitize(srcR[i]) : 0.0;
                // Post-fader, post-mute strip signal (float64 — D-WZ-DSP-01).
                const double l = inL * ch.smGainL * muteG;
                const double r = inR * ch.smGainR * muteG;

                accL[i] += l * soloG; // solo ducks main only
                accR[i] += r * soloG;
                if (feedsMonitor) {
                    monL[i] += l;
                    monR[i] += r;
                }
                pkL = std::max(pkL, std::abs(l));
                pkR = std::max(pkR, std::abs(r));
                sumSqL += l * l;
                sumSqR += r * r;
            }

            // Per-strip meters: post-fader/mute, pre-solo (a soloed-away strip
            // still shows its own level — console convention).
            ch.mPeakL.store(pkL, std::memory_order_relaxed);
            ch.mPeakR.store(pkR, std::memory_order_relaxed);
            const double n = frames > 0 ? static_cast<double>(frames) : 1.0;
            ch.mRmsL.store(std::sqrt(sumSqL / n), std::memory_order_relaxed);
            ch.mRmsR.store(std::sqrt(sumSqR / n), std::memory_order_relaxed);
        }
    }

    // Master fader (same curve family, smoothed) applied at the main bus sum;
    // monitor is a cue path — unity, unaffected by the main fader.
    const double mainTgt = wz::faderPositionToLinear(e->params[0].load(std::memory_order_relaxed));
    if (e->smMain < 0.0) e->smMain = mainTgt;

    double mainPkL = 0.0, mainPkR = 0.0, monPkL = 0.0, monPkR = 0.0;
    float* outL = (bus_out != nullptr && bus_count >= 1) ? bus_out[0] : nullptr;
    float* outR = (bus_out != nullptr && bus_count >= 2) ? bus_out[1] : nullptr;
    float* cueL = (bus_out != nullptr && bus_count >= 3) ? bus_out[2] : nullptr;
    float* cueR = (bus_out != nullptr && bus_count >= 4) ? bus_out[3] : nullptr;
    for (uint32_t i = 0; i < frames; ++i) {
        e->smMain += alpha * (mainTgt - e->smMain);
        const double l = accL[i] * e->smMain;
        const double r = accR[i] * e->smMain;
        if (outL != nullptr) outL[i] = static_cast<float>(l);
        if (outR != nullptr) outR[i] = static_cast<float>(r);
        if (cueL != nullptr) cueL[i] = static_cast<float>(monL[i]);
        if (cueR != nullptr) cueR[i] = static_cast<float>(monR[i]);
        mainPkL = std::max(mainPkL, std::abs(l));
        mainPkR = std::max(mainPkR, std::abs(r));
        monPkL = std::max(monPkL, std::abs(monL[i]));
        monPkR = std::max(monPkR, std::abs(monR[i]));
    }
    // Any remaining device output channels stay silent.
    if (bus_out != nullptr)
        for (uint32_t b = 4; b < bus_count; ++b)
            if (bus_out[b] != nullptr)
                for (uint32_t i = 0; i < frames; ++i) bus_out[b][i] = 0.0f;

    e->mainPeakL.store(mainPkL, std::memory_order_relaxed);
    e->mainPeakR.store(mainPkR, std::memory_order_relaxed);
    e->monitorPeakL.store(monPkL, std::memory_order_relaxed);
    e->monitorPeakR.store(monPkR, std::memory_order_relaxed);

    // The clock advances regardless of transport state (D-CLOCK-01 model).
    e->engineTimeSamples.fetch_add(frames, std::memory_order_relaxed);
}

void wz_engine_render(wz_engine* e,
                      float* const* bus_out,
                      uint32_t bus_count,
                      uint32_t frames) {
    wz_engine_render_io(e, nullptr, 0, bus_out, bus_count, frames);
}

uint32_t wz_engine_hotframe_length(const wz_engine* e) {
    if (e == nullptr) return 0;
    auto* w = e->world.load(std::memory_order_acquire);
    const uint32_t channels = w != nullptr ? static_cast<uint32_t>(w->channels.size()) : 0;
    // Per-deck blocks join in P1-07 (deck count is a world property).
    return kHotFrameLength + channels * 7u;
}

uint32_t wz_engine_hotframe(const wz_engine* e, double* out, uint32_t capacity) {
    if (e == nullptr || out == nullptr) return 0;
    const uint32_t total = wz_engine_hotframe_length(e);
    if (capacity < total) return 0; // short buffer refused, not truncated

    out[0] = static_cast<double>(e->schemaVersion);
    out[1] = static_cast<double>(e->engineTimeSamples.load(std::memory_order_relaxed));
    out[2] = 0.0; // cpuLoad — placeholder until the render path is measured
    out[3] = 0.0; // feedbackAlarm — watchdog lands in P4
    out[4] = e->mainPeakL.load(std::memory_order_relaxed);
    out[5] = e->mainPeakR.load(std::memory_order_relaxed);
    out[6] = e->monitorPeakL.load(std::memory_order_relaxed);
    out[7] = e->monitorPeakR.load(std::memory_order_relaxed);

    // Per-channel blocks (stride 7, order per schema CHANNEL_BLOCK_FIELDS):
    // peakL peakR rmsL rmsR srcRingFill srcDriftPpm srcDropouts — the last
    // three stay 0 until P2's capture lands (reserved, D-WZ-CLOCK-01).
    auto* w = e->world.load(std::memory_order_acquire);
    uint32_t idx = kHotFrameLength;
    if (w != nullptr) {
        for (const auto& ch : w->channels) {
            out[idx++] = ch->mPeakL.load(std::memory_order_relaxed);
            out[idx++] = ch->mPeakR.load(std::memory_order_relaxed);
            out[idx++] = ch->mRmsL.load(std::memory_order_relaxed);
            out[idx++] = ch->mRmsR.load(std::memory_order_relaxed);
            out[idx++] = 0.0;
            out[idx++] = 0.0;
            out[idx++] = 0.0;
        }
    }
    return idx;
}

} // extern "C"
