#include "wz_engine.h"

#include "asrc.h"
#include "deck.h"
#include "fader.h"
#include "source_ring.h"
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
    "gain", "pan", "mute", "solo", "deckIndex", "ringId", "outBus",
};
constexpr uint32_t kWorldKeyCount = sizeof(kWorldKeyNames) / sizeof(kWorldKeyNames[0]);
enum WorldKey : int32_t {
    kWkSrcKind = 0, kWkSrcChan0, kWkSrcChan1, kWkToMonitor,
    kWkGain, kWkPan, kWkMute, kWkSolo, kWkDeckIndex, kWkRingId, kWkOutBus,
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

// Feedback watchdog (P4-04, playback-composer.md §3). PROVISIONAL values —
// morning decision #6 governs them; the mechanism is what is being built here.
// RMS, not peak: a single transient must NEVER trip the limiter.
constexpr double kWatchdogThresholdDb = 6.0;    // +6 dBFS sustained...
constexpr double kWatchdogWindowSec = 0.250;    // ...over 250 ms
constexpr double kWatchdogHoldSec = 1.000;      // stay engaged this long after it clears
constexpr double kWatchdogCeiling = 1.0;        // the hard ceiling the limiter enforces
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
    // 8 stereo output buses (P4-05). Bus 0 is "main"; a spatial layout is just
    // a wider map over the same array — there is no separate spatial engine.
    std::vector<double> accBusL[wz::kMaxOutBuses], accBusR[wz::kMaxOutBuses];
    std::vector<double> accMonL, accMonR;
    // LoopbackBus (P4-03, spec §2): the PREVIOUS block of each bus, kept so a
    // patch may route a bus back into a channel. The one-block delay is what
    // makes the cycle well-defined and keeps the render schedule acyclic BY
    // CONSTRUCTION — no cycle detection ever runs on the audio thread.
    std::vector<float> loopbackMainL, loopbackMainR, loopbackMonL, loopbackMonR;
    uint32_t loopbackFrames = 0; // valid frames in the snapshot
    // Watchdog state (render-thread-owned): a leaky RMS integrator over the
    // main bus, the engaged flag + its hold countdown, and the limiter's
    // smoothed gain (never a step — D-WZ-RAMP-01).
    double wdMeanSquare = 0.0;
    double wdHoldRemaining = 0.0;
    double wdLimiterGain = 1.0;
    std::atomic<uint32_t> wdEngaged{0};
    // PER-BUS watchdog state for buses 1..7. The detector and limiter used to
    // exist only in the bus-0 loop, so a runaway on any other bus reached the
    // device unlimited and unflagged — and external feedback enters on whatever
    // bus its strip targets, which is not necessarily main. D-WZ-WATCHDOG-01
    // says "a bus's RMS"; this makes the code mean it.
    double wdBusMeanSquare[wz::kMaxOutBuses] = {};
    double wdBusHold[wz::kMaxOutBuses] = {};
    double wdBusGain[wz::kMaxOutBuses] = {};
    std::atomic<uint32_t> wdEnabled{1}; // test seam only; always 1 in the app

    // Deck units — stable engine objects (world commits never rebuild them) —
    // plus per-deck preallocated block scratch the deck strips read from.
    wz::Deck decks[wz::kMaxDecks];
    std::vector<float> deckOutL[wz::kMaxDecks];
    std::vector<float> deckOutR[wz::kMaxDecks];
    // Per-deck parallel file drain (render writes captured frames, host pulls).
    wz::SourceRing deckDrain[wz::kMaxDecks];

    // --- GLOBAL RECORD (P7-GREC-01, D-WZ-GREC-01) ---------------------------
    // The archivist: a stereo tap of bus 0 taken POST master fader and POST
    // limiter, drained to file by the host. Deliberately NOT a deck — no RAM
    // buffer, no 256 MB cap, not live-loopable — which is what lets it run for a
    // three-hour set while a deck caps at 11:39 stereo.
    wz::SourceRing globalDrain;
    std::atomic<uint32_t> globalArm{0};    // control → render: 1 = arm, 2 = stop
    std::atomic<uint32_t> globalOn{0};     // render's own state, published for the UI
    uint64_t globalStartSample = 0;        // Law C-2: the session's time origin
    std::vector<float> globalScratch;      // interleaved, maxBlockFrames × 2
    std::atomic<uint32_t> deckRecArm[wz::kMaxDecks]; // control→render: 1=start,2=stop
    std::vector<float> recScratch; // interleaved capture staging (maxBlock*2)

    // --- world (RCU) -----------------------------------------------------
    // `world` is the installed snapshot the render thread reads (one load per
    // block). Control side (message thread, single-writer): builder state +
    // the retired list. A retired world is freed on a LATER commit, once
    // renderWorldRev shows the render thread has moved past its revision —
    // bounded by edit count, each world is tiny (topology only, no audio).
    std::atomic<wz::World*> world;
    std::atomic<uint64_t> renderWorldRev; // last revision seen by render()
    // Source rings (P2). Fixed slots: 16 taps × up to 2 stereo rings + headroom.
    // unique_ptr because SourceRing holds atomics. A null slot is free.
    std::vector<std::unique_ptr<wz::SourceRing>> rings;
    // Per-ring ASRC (created with the ring) + planar engine-rate scratch the
    // render pre-pass fills; tap strips read the scratch like decks read theirs.
    std::vector<std::unique_ptr<wz::SourceAsrc>> ringAsrc;
    std::vector<std::vector<float>> ringOutL, ringOutR;
    std::vector<float> asrcInter; // interleaved ASRC output, deinterleaved into L/R
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
    e->globalScratch.assign(static_cast<size_t>(max_block_frames) * 2u, 0.0f);
    e->mainPeakL.store(0.0, std::memory_order_relaxed);
    e->mainPeakR.store(0.0, std::memory_order_relaxed);
    e->monitorPeakL.store(0.0, std::memory_order_relaxed);
    e->monitorPeakR.store(0.0, std::memory_order_relaxed);
    e->smMain = -1.0;
    for (uint32_t b = 0; b < wz::kMaxOutBuses; ++b) {
        e->accBusL[b].assign(max_block_frames, 0.0);
        e->accBusR[b].assign(max_block_frames, 0.0);
    }
    e->accMonL.assign(max_block_frames, 0.0);
    e->accMonR.assign(max_block_frames, 0.0);
    for (uint32_t d = 0; d < wz::kMaxDecks; ++d) {
        e->deckOutL[d].assign(max_block_frames, 0.0f);
        e->deckOutR[d].assign(max_block_frames, 0.0f);
        e->deckRecArm[d].store(0, std::memory_order_relaxed);
    }
    e->recScratch.assign(static_cast<size_t>(max_block_frames) * 2u, 0.0f);
    e->loopbackMainL.assign(max_block_frames, 0.0f);
    e->loopbackMainR.assign(max_block_frames, 0.0f);
    e->loopbackMonL.assign(max_block_frames, 0.0f);
    e->loopbackMonR.assign(max_block_frames, 0.0f);
    e->loopbackFrames = 0;
    e->wdMeanSquare = 0.0;
    e->wdHoldRemaining = 0.0;
    e->wdLimiterGain = 1.0;
    for (uint32_t b = 0; b < wz::kMaxOutBuses; ++b) {
        e->wdBusMeanSquare[b] = 0.0;
        e->wdBusHold[b] = 0.0;
        e->wdBusGain[b] = 1.0;
    }
    e->wdEngaged.store(0, std::memory_order_relaxed);
    e->wdEnabled.store(1, std::memory_order_relaxed);
    e->world.store(new (std::nothrow) wz::World(), std::memory_order_release);
    e->renderWorldRev.store(0, std::memory_order_relaxed);
    e->rings.resize(40); // fixed slot table; grown-never in steady state
    e->ringAsrc.resize(40);
    e->ringOutL.assign(40, std::vector<float>(max_block_frames, 0.0f));
    e->ringOutR.assign(40, std::vector<float>(max_block_frames, 0.0f));
    e->asrcInter.assign(static_cast<size_t>(max_block_frames) * 2u, 0.0f);
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
        case kWkRingId: ch.ringId = static_cast<int32_t>(value); break;
        case kWkOutBus: {
            const auto b = static_cast<int32_t>(value);
            ch.outBus = (b >= 0 && b < static_cast<int32_t>(wz::kMaxOutBuses)) ? b : 0;
            break;
        }
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

void wz_world_set_deck_count(wz_engine* e, uint32_t count) {
    if (e == nullptr || e->builder == nullptr) return;
    e->builder->deckCount = count <= wz::kMaxDecks ? count : wz::kMaxDecks;
}

uint32_t wz_world_deck_count(const wz_engine* e) {
    if (e == nullptr) return 0;
    auto* w = e->world.load(std::memory_order_acquire);
    return w != nullptr ? w->deckCount : 0;
}

/* --- source rings (P2) --------------------------------------------------- */

int32_t wz_source_ring_open(wz_engine* e, const char* source_key,
                            uint32_t channels, uint32_t capacity_frames,
                            double nominal_rate) {
    if (e == nullptr || channels == 0 || capacity_frames == 0 || nominal_rate <= 0.0)
        return -1;
    for (size_t i = 0; i < e->rings.size(); ++i) {
        if (e->rings[i] == nullptr) {
            auto r = std::make_unique<wz::SourceRing>();
            r->init(source_key, channels, capacity_frames);
            // The per-source ASRC pulls this ring onto the engine rate. Created
            // here on the control thread (it allocates a SINC_BEST state).
            auto a = std::make_unique<wz::SourceAsrc>();
            a->init(r.get(), e->sampleRate.load(std::memory_order_relaxed),
                    nominal_rate, e->maxBlockFrames);
            e->rings[i] = std::move(r);
            e->ringAsrc[i] = std::move(a);
            return static_cast<int32_t>(i);
        }
    }
    return -1; // slot table full
}

void wz_source_write(wz_engine* e, int32_t ring, const float* interleaved,
                     uint32_t frames, double source_rate, uint64_t host_time_ns) {
    if (e == nullptr || ring < 0 || static_cast<size_t>(ring) >= e->rings.size()) return;
    auto* r = e->rings[static_cast<size_t>(ring)].get();
    if (r != nullptr && interleaved != nullptr)
        r->write(interleaved, frames, source_rate, host_time_ns);
}

void wz_source_ring_close(wz_engine* e, int32_t ring) {
    // Control thread only, with capture stopped: freeing a ring the render
    // thread might read is the caller's ordering responsibility (the host stops
    // delivery + detaches the strip before closing), same discipline as decks.
    if (e == nullptr || ring < 0 || static_cast<size_t>(ring) >= e->rings.size()) return;
    e->rings[static_cast<size_t>(ring)].reset();
    e->ringAsrc[static_cast<size_t>(ring)].reset();
}

static const wz::SourceRing* ringAt(const wz_engine* e, int32_t ring) {
    if (e == nullptr || ring < 0 || static_cast<size_t>(ring) >= e->rings.size()) return nullptr;
    return e->rings[static_cast<size_t>(ring)].get();
}

uint64_t wz_source_ring_fill(const wz_engine* e, int32_t ring) {
    auto* r = ringAt(e, ring);
    return r != nullptr ? r->fillFrames() : 0;
}

uint64_t wz_source_ring_overruns(const wz_engine* e, int32_t ring) {
    auto* r = ringAt(e, ring);
    return r != nullptr ? r->overruns.load(std::memory_order_relaxed) : 0;
}

uint64_t wz_source_ring_underruns(const wz_engine* e, int32_t ring) {
    auto* r = ringAt(e, ring);
    return r != nullptr ? r->underruns.load(std::memory_order_relaxed) : 0;
}

/* --- decks --------------------------------------------------------------- */

int32_t wz_deck_load(wz_engine* e, uint32_t deck, uint32_t channels,
                     uint64_t frames, const float* const* data, double rate) {
    if (e == nullptr || deck >= wz::kMaxDecks || channels == 0 || frames == 0 ||
        data == nullptr || rate <= 0.0)
        return 0;
    for (uint32_t c = 0; c < channels; ++c)
        if (data[c] == nullptr) return 0;
    auto& d = e->decks[deck];
    // NOT RT-safe: the host detaches the render callback around this call. Fill
    // the same chunked storage a recording uses, so playback has one path and
    // the Law C-3 handoff (P3-03) is a no-op on representation.
    d.state.store(static_cast<uint32_t>(wz::DeckState::idle), std::memory_order_relaxed);
    d.reset(channels);
    d.ensureCapacity(frames);
    for (uint64_t f = 0; f < frames; ++f) {
        const uint64_t ci = f / wz::kDeckChunkFrames, off = f % wz::kDeckChunkFrames;
        for (uint32_t c = 0; c < channels; ++c)
            d.chunks[ci]->plane[c][off] = data[c][f];
    }
    d.frames.store(frames, std::memory_order_release);
    d.pubPlayhead.store(0.0, std::memory_order_relaxed);
    d.publishLoop(0, 0, 0); // whole-buffer region until the document says otherwise
    return 1;
}

uint64_t wz_deck_frames(const wz_engine* e, uint32_t deck) {
    if (e == nullptr || deck >= wz::kMaxDecks) return 0;
    return e->decks[deck].frames.load(std::memory_order_acquire);
}

void wz_deck_seek(wz_engine* e, uint32_t deck, uint64_t frame) {
    if (e == nullptr || deck >= wz::kMaxDecks) return;
    // Control thread: post the target and return. The render thread applies it
    // at the top of its next block, so a scrub drag never races the reader.
    e->decks[deck].pendingSeek.store(static_cast<int64_t>(frame), std::memory_order_release);
}

double wz_deck_playhead(const wz_engine* e, uint32_t deck) {
    if (e == nullptr || deck >= wz::kMaxDecks) return 0.0;
    return e->decks[deck].pubPlayhead.load(std::memory_order_relaxed);
}

int32_t wz_deck_insert(wz_engine* e, uint32_t deck, uint64_t at, uint32_t channels,
                       uint64_t frames, const float* const* planar) {
    if (e == nullptr || deck >= wz::kMaxDecks || planar == nullptr || frames == 0) return 0;
    auto& d = e->decks[deck];
    const uint64_t oldLen = d.frames.load(std::memory_order_acquire);
    if (oldLen == 0) return 0;              // nothing to insert INTO — that is a load
    const uint32_t ch = d.channels;         // the deck's own channel count wins
    const uint64_t newLen = oldLen + frames;
    // The ONE operation that lengthens a deck, so the cap is checked HERE rather
    // than assumed (D-WZ-DECK-01).
    if (d.recCapFrames != 0 && newLen > d.recCapFrames) return 0;
    const uint64_t clampedAt = at < oldLen ? at : oldLen;

    // Read the deck out, splice, and rebuild. Allocation is legal here: this is
    // the control thread, and the caller has detached the render (as for
    // wz_deck_load) — the chunk storage is being replaced underneath.
    std::vector<std::vector<float>> merged(ch, std::vector<float>(static_cast<size_t>(newLen), 0.0f));
    for (uint32_t c = 0; c < ch; ++c) {
        for (uint64_t i = 0; i < clampedAt; ++i)
            merged[c][static_cast<size_t>(i)] = d.sample(c, i);
        for (uint64_t i = 0; i < frames; ++i) {
            // A mono source fans out; extra source channels are ignored.
            const float* src = planar[c < channels ? c : 0];
            merged[c][static_cast<size_t>(clampedAt + i)] = src != nullptr ? src[i] : 0.0f;
        }
        for (uint64_t i = clampedAt; i < oldLen; ++i)
            merged[c][static_cast<size_t>(frames + i)] = d.sample(c, i);
    }

    // wz_deck_load REBUILDS the deck, which resets its transport — so a splice
    // would silently stop the loop you were listening to. Carry the playing
    // state, the playhead and the loop region across it instead.
    const uint32_t keepState = d.state.load(std::memory_order_acquire);
    const double keepPlayhead = d.playhead;
    uint32_t le = 0; uint64_t ls = 0, lend = 0;
    d.readLoop(le, ls, lend);

    std::vector<const float*> ptrs(ch);
    for (uint32_t c = 0; c < ch; ++c) ptrs[c] = merged[c].data();
    if (wz_deck_load(e, deck, ch, newLen, ptrs.data(), wz_engine_sample_rate(e)) != 1) return 0;

    // Audio AFTER the splice point moved later by exactly `frames`, so anything
    // pointing into it must move with it or it now points at different sound.
    const auto shift = [&](uint64_t v) { return v >= clampedAt ? v + frames : v; };
    if (le != 0) wz_deck_set_loop(e, deck, 1u, shift(ls),
                                  // A region that CONTAINED the splice point grows to
                                  // include the new material — the loop you were
                                  // playing now has the inserted part in it, which is
                                  // the point of inserting into a loop.
                                  lend >= clampedAt ? lend + frames : lend);
    d.playhead = keepPlayhead >= static_cast<double>(clampedAt)
                     ? keepPlayhead + static_cast<double>(frames)
                     : keepPlayhead;
    d.state.store(keepState, std::memory_order_release);
    return 1;
}

void wz_deck_overdub_start(wz_engine* e, uint32_t deck, uint32_t mode) {
    if (e == nullptr || deck >= wz::kMaxDecks) return;
    auto& d = e->decks[deck];
    // Overdub layers INTO existing material; with nothing there it would just be
    // a recording, which is what the record verb is for.
    if (d.frames.load(std::memory_order_acquire) == 0) return;
    // Never while capturing a fresh take: that path appends and grows.
    if (d.state.load(std::memory_order_acquire) ==
        static_cast<uint32_t>(wz::DeckState::recording))
        return;
    d.overdubMode.store(mode, std::memory_order_relaxed);
    d.overdub.store(1, std::memory_order_release);
}

void wz_deck_overdub_stop(wz_engine* e, uint32_t deck) {
    if (e == nullptr || deck >= wz::kMaxDecks) return;
    e->decks[deck].overdub.store(0, std::memory_order_release);
}

void wz_deck_scrub_begin(wz_engine* e, uint32_t deck) {
    if (e == nullptr || deck >= wz::kMaxDecks) return;
    auto& d = e->decks[deck];
    // Recording owns the playhead; a scrub must not move the write head.
    if (d.state.load(std::memory_order_acquire) ==
        static_cast<uint32_t>(wz::DeckState::recording))
        return;
    d.scrubTarget.store(d.pubPlayhead.load(std::memory_order_relaxed), std::memory_order_relaxed);
    d.scrubActive.store(1, std::memory_order_release);
}

void wz_deck_scrub_to(wz_engine* e, uint32_t deck, double frame) {
    if (e == nullptr || deck >= wz::kMaxDecks) return;
    e->decks[deck].scrubTarget.store(frame < 0.0 ? 0.0 : frame, std::memory_order_relaxed);
}

void wz_deck_scrub_end(wz_engine* e, uint32_t deck) {
    if (e == nullptr || deck >= wz::kMaxDecks) return;
    e->decks[deck].scrubActive.store(0, std::memory_order_release);
}

void wz_deck_trigger(wz_engine* e, uint32_t deck, uint32_t mode) {
    if (e == nullptr || deck >= wz::kMaxDecks) return;
    auto& d = e->decks[deck];
    switch (mode) {
        case 0: // loop
            d.pendingReset.store(1, std::memory_order_relaxed);
            d.state.store(static_cast<uint32_t>(wz::DeckState::looping), std::memory_order_release);
            break;
        case 1: // oneShot
            d.pendingReset.store(1, std::memory_order_relaxed);
            d.state.store(static_cast<uint32_t>(wz::DeckState::oneShot), std::memory_order_release);
            break;
        case 2: // stop
            d.state.store(static_cast<uint32_t>(wz::DeckState::idle), std::memory_order_release);
            break;
        case 3: { // retrigger: seek region start; from idle it starts a oneShot
            d.pendingReset.store(1, std::memory_order_relaxed);
            const auto st = d.state.load(std::memory_order_relaxed);
            if (st == static_cast<uint32_t>(wz::DeckState::idle))
                d.state.store(static_cast<uint32_t>(wz::DeckState::oneShot),
                              std::memory_order_release);
            break;
        }
        default: break; // unknown mode ignored
    }
}

void wz_deck_set_loop(wz_engine* e, uint32_t deck, uint32_t enabled,
                      uint64_t start, uint64_t end) {
    if (e == nullptr || deck >= wz::kMaxDecks) return;
    e->decks[deck].publishLoop(enabled, start, end);
}

uint32_t wz_engine_max_out_buses(void) { return wz::kMaxOutBuses; }

uint32_t wz_engine_mappable_buses(uint32_t device_out_channels) {
    // Bus 0 needs device 0/1; every further bus needs a pair beyond the cue
    // pair at 2/3. Fewer than 2 channels carries nothing.
    if (device_out_channels < 2u) return 0u;
    if (device_out_channels < 6u) return 1u; // main only (cue may share 2/3)
    const uint32_t extra = (device_out_channels - 4u) / 2u;
    const uint32_t total = 1u + extra;
    return total < wz::kMaxOutBuses ? total : wz::kMaxOutBuses;
}

void wz_engine_set_watchdog_enabled(wz_engine* e, uint32_t enabled) {
    if (e == nullptr) return;
    e->wdEnabled.store(enabled ? 1u : 0u, std::memory_order_relaxed);
    if (enabled == 0) { // leave no residual limiting behind
        e->wdEngaged.store(0u, std::memory_order_relaxed);
        e->wdLimiterGain = 1.0;
        e->wdMeanSquare = 0.0;
        e->wdHoldRemaining = 0.0;
    }
}

uint32_t wz_deck_waveform(const wz_engine* e, uint32_t deck, uint32_t channel,
                          uint64_t start_frame, uint64_t end_frame,
                          uint32_t columns, float* out_min, float* out_max) {
    if (e == nullptr || deck >= wz::kMaxDecks || columns == 0 ||
        out_min == nullptr || out_max == nullptr)
        return 0;
    const auto& d = e->decks[deck];
    const uint64_t len = d.frames.load(std::memory_order_acquire);
    if (len == 0 || d.channels == 0) return 0;
    uint64_t s0 = start_frame < len ? start_frame : len;
    uint64_t s1 = end_frame < len ? end_frame : len;
    if (s1 <= s0) { s0 = 0; s1 = len; } // degenerate range → the whole buffer
    const uint32_t ch = channel < d.channels ? channel : 0u;

    const double span = static_cast<double>(s1 - s0);
    for (uint32_t c = 0; c < columns; ++c) {
        const uint64_t a = s0 + static_cast<uint64_t>(span * c / columns);
        uint64_t b = s0 + static_cast<uint64_t>(span * (c + 1) / columns);
        if (b <= a) b = a + 1;
        if (b > s1) b = s1;
        float lo = 0.0f, hi = 0.0f;
        bool first = true;
        for (uint64_t f = a; f < b; ++f) {
            const float v = d.sample(ch, f);
            if (first) { lo = hi = v; first = false; }
            else { if (v < lo) lo = v; if (v > hi) hi = v; }
        }
        out_min[c] = lo;
        out_max[c] = hi;
    }
    return columns;
}

void wz_deck_set_rate(wz_engine* e, uint32_t deck, double rate) {
    if (e == nullptr || deck >= wz::kMaxDecks) return;
    e->decks[deck].rate.store(rate, std::memory_order_relaxed);
}

double wz_deck_rate(const wz_engine* e, uint32_t deck) {
    if (e == nullptr || deck >= wz::kMaxDecks) return 0.0;
    return e->decks[deck].rate.load(std::memory_order_relaxed);
}

/* --- deck recording (P3) ------------------------------------------------- */

void wz_deck_set_record_source(wz_engine* e, uint32_t deck,
                               int32_t chan0, int32_t chan1) {
    if (e == nullptr || deck >= wz::kMaxDecks) return;
    e->decks[deck].recSrcChan0 = chan0;
    e->decks[deck].recSrcChan1 = chan1;
}

void wz_deck_record_start(wz_engine* e, uint32_t deck) {
    if (e == nullptr || deck >= wz::kMaxDecks) return;
    auto& d = e->decks[deck];
    const uint32_t ch = d.recSrcChan1 >= 0 ? 2u : 1u;
    // Reset + initial capacity are control-thread work (allocation). The host
    // calls wz_deck_record_service before/around this; here we also seed enough
    // so the first blocks never touch an unallocated chunk.
    d.reset(ch);
    d.recCapFrames = (256ull * 1024ull * 1024ull) / (static_cast<uint64_t>(ch) * 4ull); // D-WZ-DECK-01
    d.ensureCapacity(4u * e->maxBlockFrames);
    // Drain ring sized for a comfortable host lag (interleaved).
    e->deckDrain[deck].init("deckdrain", ch, 1u << 18);
    // The render picks up the arm at its next block and stamps the start there,
    // so the stamp is the exact engine sample recording began.
    e->deckRecArm[deck].store(1u, std::memory_order_release);
}

uint64_t wz_deck_record_stop(wz_engine* e, uint32_t deck) {
    if (e == nullptr || deck >= wz::kMaxDecks) return 0;
    auto& d = e->decks[deck];
    e->deckRecArm[deck].store(2u, std::memory_order_release); // render finalizes at its next block
    return d.recStartSample;
}

void wz_deck_set_record_cap_frames(wz_engine* e, uint32_t deck, uint64_t cap_frames) {
    if (e == nullptr || deck >= wz::kMaxDecks) return;
    auto& d = e->decks[deck];
    if (cap_frames == 0) { // restore the signed default for this deck's channels
        const uint32_t ch = d.channels > 0 ? d.channels : 1u;
        d.recCapFrames = (256ull * 1024ull * 1024ull) / (static_cast<uint64_t>(ch) * 4ull);
    } else {
        d.recCapFrames = cap_frames;
    }
}

void wz_deck_record_service(wz_engine* e) {
    if (e == nullptr) return;
    for (uint32_t di = 0; di < wz::kMaxDecks; ++di) {
        auto& d = e->decks[di];
        if (d.state.load(std::memory_order_acquire) != static_cast<uint32_t>(wz::DeckState::recording))
            continue;
        // Keep allocation AHEAD of the render write position by a few chunks, up
        // to the cap — so the RT append never hits an unallocated chunk.
        const uint64_t pos = d.frames.load(std::memory_order_acquire);
        uint64_t want = pos + 2u * wz::kDeckChunkFrames;
        if (want > d.recCapFrames) want = d.recCapFrames;
        d.ensureCapacity(want);
    }
}

uint32_t wz_deck_drain(wz_engine* e, uint32_t deck, float* out,
                       uint32_t capacity_frames, uint64_t* out_start_sample) {
    if (e == nullptr || deck >= wz::kMaxDecks || out == nullptr) return 0;
    if (out_start_sample != nullptr) *out_start_sample = e->decks[deck].recStartSample;
    // Read only what's present — draining a partially-full ring is normal, not
    // an underrun.
    const uint64_t fill = e->deckDrain[deck].fillFrames();
    uint32_t n = capacity_frames;
    if (fill < n) n = static_cast<uint32_t>(fill);
    return n == 0 ? 0u : e->deckDrain[deck].read(out, n);
}

void wz_global_record_start(wz_engine* e) {
    if (e == nullptr) return;
    // Sized for a generous host lag: at 48 k this is ~5.5 s of stereo. The host
    // drains on its own thread; an overrun is COUNTED, never blocking, because
    // the render thread must not wait on a disk.
    e->globalDrain.init("globaldrain", 2u, 1u << 18);
    e->globalArm.store(1u, std::memory_order_release);
}

uint64_t wz_global_record_stop(wz_engine* e) {
    if (e == nullptr) return 0;
    e->globalArm.store(2u, std::memory_order_release); // render finalizes next block
    return e->globalStartSample;
}

uint64_t wz_global_record_start_sample(wz_engine* e) {
    return e != nullptr ? e->globalStartSample : 0ull;
}

uint32_t wz_global_record_active(wz_engine* e) {
    return e != nullptr ? e->globalOn.load(std::memory_order_acquire) : 0u;
}

uint64_t wz_global_record_overruns(wz_engine* e) {
    return e != nullptr ? e->globalDrain.overruns.load(std::memory_order_relaxed) : 0ull;
}

uint32_t wz_global_drain(wz_engine* e, float* out, uint32_t capacity_frames,
                         uint64_t* out_start_sample) {
    if (e == nullptr || out == nullptr) return 0;
    if (out_start_sample != nullptr) *out_start_sample = e->globalStartSample;
    const uint64_t fill = e->globalDrain.fillFrames();
    uint32_t n = capacity_frames;
    if (fill < n) n = static_cast<uint32_t>(fill);
    return n == 0 ? 0u : e->globalDrain.read(out, n);
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

    // Deck RECORD pass (P3): arm transitions + capture of each recording deck's
    // input into its buffer + the parallel drain. Runs before playback so a deck
    // that just stopped-with-loop can play in this same block (Law C-3, P3-03).
    const uint64_t blockStartSample = e->engineTimeSamples.load(std::memory_order_relaxed);
    for (uint32_t di = 0; di < wz::kMaxDecks; ++di) {
        auto& d = e->decks[di];
        const uint32_t arm = e->deckRecArm[di].exchange(0, std::memory_order_acq_rel);
        if (arm == 1u) { // start: stamp the exact engine sample capture begins
            d.recStartSample = blockStartSample;
            d.state.store(static_cast<uint32_t>(wz::DeckState::recording), std::memory_order_release);
        } else if (arm == 2u) { // stop — THE LAW C-3 HANDOFF
            if (d.state.load(std::memory_order_relaxed) ==
                static_cast<uint32_t>(wz::DeckState::recording)) {
                // The record buffer IS the playback buffer (same chunks, no copy,
                // no realloc, no file touch). With loop enabled the deck becomes
                // looping playback of what it just captured IN THIS BLOCK — the
                // instant turnaround. Otherwise → idle, buffer retained.
                uint32_t le = 0; uint64_t ls = 0, lend = 0;
                d.readLoop(le, ls, lend);
                const uint64_t len = d.frames.load(std::memory_order_acquire);
                if (le != 0 && len > 0) {
                    // A loop region set before/while recording is honored if it
                    // fits the captured length; otherwise the take IS the loop.
                    if (!(ls < lend && lend <= len)) d.publishLoop(1u, 0, len);
                    d.playhead = static_cast<double>(ls < lend && lend <= len ? ls : 0);
                    d.pendingReset.store(0, std::memory_order_relaxed);
                    d.state.store(static_cast<uint32_t>(wz::DeckState::looping),
                                  std::memory_order_release);
                } else {
                    d.state.store(static_cast<uint32_t>(wz::DeckState::idle),
                                  std::memory_order_release);
                }
            }
        }
        if (d.state.load(std::memory_order_acquire) != static_cast<uint32_t>(wz::DeckState::recording))
            continue;

        const uint32_t rch = d.channels;
        const float* r0 = (in_bus != nullptr && d.recSrcChan0 >= 0 &&
                           static_cast<uint32_t>(d.recSrcChan0) < in_count)
                              ? in_bus[d.recSrcChan0] : nullptr;
        const float* r1 = (in_bus != nullptr && d.recSrcChan1 >= 0 &&
                           static_cast<uint32_t>(d.recSrcChan1) < in_count)
                              ? in_bus[d.recSrcChan1] : nullptr;
        uint64_t pos = d.frames.load(std::memory_order_relaxed);
        const uint64_t allocFrames =
            static_cast<uint64_t>(d.chunkCount.load(std::memory_order_acquire)) * wz::kDeckChunkFrames;
        float* drs = e->recScratch.data();
        uint32_t captured = 0;
        for (uint32_t i = 0; i < frames; ++i) {
            if (pos >= d.recCapFrames) { // D-WZ-DECK-01 cap → stop appending
                d.recCapReached.store(1u, std::memory_order_relaxed);
                d.state.store(static_cast<uint32_t>(wz::DeckState::idle), std::memory_order_release);
                break;
            }
            if (pos >= allocFrames) break; // service hasn't allocated ahead (never in practice)
            float vals[2];
            vals[0] = r0 != nullptr ? static_cast<float>(sanitize(r0[i])) : 0.0f;
            if (rch > 1) vals[1] = r1 != nullptr ? static_cast<float>(sanitize(r1[i])) : vals[0];
            d.appendFrame(pos, vals, rch);
            for (uint32_t c = 0; c < rch; ++c)
                drs[static_cast<size_t>(captured) * rch + c] = vals[c];
            ++pos;
            ++captured;
        }
        d.frames.store(pos, std::memory_order_release); // committed length
        if (captured > 0) e->deckDrain[di].write(drs, captured, fs, blockStartSample);
    }

    double* monL = e->accMonL.data();
    double* monR = e->accMonR.data();
    for (uint32_t i = 0; i < frames; ++i) monL[i] = monR[i] = 0.0;
    for (uint32_t b = 0; b < wz::kMaxOutBuses; ++b) {
        double* bl = e->accBusL[b].data();
        double* br = e->accBusR[b].data();
        for (uint32_t i = 0; i < frames; ++i) bl[i] = br[i] = 0.0;
    }
    double* accL = e->accBusL[0].data(); // bus 0 == main
    double* accR = e->accBusR[0].data();

    // Source-ring ASRC pre-pass: each open ring's ASRC produces ONE block of
    // engine-rate output into planar scratch (deinterleaved); tap strips read
    // it. Runs once per ring so multiple strips can share a source.
    for (size_t r = 0; r < e->rings.size(); ++r) {
        auto* asrc = e->ringAsrc[r].get();
        auto* ring = e->rings[r].get();
        float* dl = e->ringOutL[r].data();
        float* dr = e->ringOutR[r].data();
        if (asrc == nullptr || ring == nullptr) {
            for (uint32_t i = 0; i < frames; ++i) { dl[i] = 0.0f; dr[i] = 0.0f; }
            continue;
        }
        const uint32_t ch = ring->channels;
        const uint32_t got = asrc->process(e->asrcInter.data(), frames);
        for (uint32_t i = 0; i < frames; ++i) {
            if (i < got) {
                dl[i] = e->asrcInter[static_cast<size_t>(i) * ch];
                dr[i] = ch > 1 ? e->asrcInter[static_cast<size_t>(i) * ch + 1] : dl[i];
            } else {
                dl[i] = 0.0f; dr[i] = 0.0f; // starved: silence (counted on the ring)
            }
        }
    }

    // Deck pre-pass: each playing deck advances ONCE per block, into its
    // preallocated scratch; deck strips read the scratch like any source.
    for (uint32_t di = 0; di < wz::kMaxDecks; ++di) {
        auto& d = e->decks[di];
        float* dl = e->deckOutL[di].data();
        float* dr = e->deckOutR[di].data();
        const auto st = d.state.load(std::memory_order_acquire);
        const uint64_t dFrames = d.frames.load(std::memory_order_acquire);
        // A recording deck's playback pass is silent (it is capturing, handled in
        // the record pass below); playback resumes on the Law C-3 stop→loop.
        // A SCRUBBING deck sounds even when idle — that is what makes it a
        // turntable rather than a seek bar. Recording still refuses: the write
        // head is not the user's to drag.
        const bool scrubHeld = d.scrubActive.load(std::memory_order_acquire) != 0;
        // Keep rendering the scrub path while its gain is still ramping DOWN.
        // Without this, releasing a scrub dropped straight into the idle
        // early-out and wrote zeros on the very next sample — the fade existed in
        // the code but never actually rendered, so release CLICKED. The fixture
        // caught it; a listener would have too.
        const bool scrubbing = (scrubHeld || d.scrubGain > 0.0) && dFrames > 0 &&
                               st != static_cast<uint32_t>(wz::DeckState::recording);

        if (!scrubbing &&
            (st == static_cast<uint32_t>(wz::DeckState::idle) ||
             st == static_cast<uint32_t>(wz::DeckState::recording) || dFrames == 0)) {
            // DRAIN THE SCRUB MAILBOX EVEN WHEN NOT PLAYING. Two reasons, both
            // bugs before this: a scrub on a STOPPED deck must still move the
            // visible head (otherwise dragging a stopped player does nothing at
            // all), and a request left pending here would be applied on some
            // LATER block — overriding the next trigger's reset, so ⟳ would
            // silently start from wherever you last scrubbed instead of the
            // region entry.
            const int64_t idleSeek = d.pendingSeek.exchange(-1, std::memory_order_acq_rel);
            // While RECORDING the playhead is the write head and is not the
            // user's to move: drain and discard, never apply.
            if (idleSeek >= 0 && dFrames > 0 &&
                st != static_cast<uint32_t>(wz::DeckState::recording)) {
                const double t = static_cast<double>(idleSeek);
                d.playhead = t < static_cast<double>(dFrames)
                                 ? t
                                 : static_cast<double>(dFrames - 1);
                // Arm the cue here too (D-WZ-SCRUBCUE-01). Scrubbing a STOPPED
                // deck is the most common way to set one — you park the head
                // where you want the next ⟳ to fire — so the stopped path must
                // arm it exactly like the playing path does.
                d.cueFrame = d.playhead;
            }
            for (uint32_t i = 0; i < frames; ++i) { dl[i] = 0.0f; dr[i] = 0.0f; }
            d.pubPlayhead.store(d.playhead, std::memory_order_relaxed);
            continue;
        }
        if (scrubbing) {
            // RATE IS DERIVED FROM THE GAP. Travelling the distance to the
            // finger over this block is exactly what makes pitch follow hand
            // speed: move faster, open a bigger gap, get a higher rate. One
            // mechanism, both behaviours, and no dependence on pixels or zoom.
            const double target = d.scrubTarget.load(std::memory_order_relaxed);
            // On the way out, stop chasing: coast to a halt instead of lunging
            // at a target the finger has already left.
            const double gap = scrubHeld ? target - d.playhead : 0.0;
            const double want = std::clamp(gap / static_cast<double>(frames), -4.0, 4.0);
            for (uint32_t i = 0; i < frames; ++i) {
                // Smoothed on the ONE D-WZ-RAMP-01 constant, so a flick glides
                // like tape instead of stepping, and reverse is just a negative
                // rate through the same reader.
                d.scrubRate += alpha * (want - d.scrubRate);
                d.scrubGain = rampStep(d.scrubGain, scrubHeld ? 1.0 : 0.0, step);
                d.playhead += d.scrubRate;
                if (d.playhead < 0.0) d.playhead = 0.0;
                const double lastFrame = static_cast<double>(dFrames) - 1.0;
                if (d.playhead > lastFrame) d.playhead = lastFrame;
                const double sg = rampShape(d.scrubGain);
                const float scrubL = d.sampleLerp(0, d.playhead);
                const float scrubR = d.channels > 1 ? d.sampleLerp(1, d.playhead) : scrubL;
                dl[i] = static_cast<float>(scrubL * sg);
                dr[i] = static_cast<float>(scrubR * sg);
            }
            d.cueFrame = d.playhead; // arm: a trigger starts where you let go
            d.pubPlayhead.store(d.playhead, std::memory_order_relaxed);
            d.pubScrubRate.store(d.scrubRate, std::memory_order_relaxed);
            continue;
        }
        d.pubScrubRate.store(0.0, std::memory_order_relaxed);

        // Loop region, read torn-free once per block; degenerate → whole buffer.
        uint32_t le = 0; uint64_t ls = 0, lend = 0;
        d.readLoop(le, ls, lend);
        uint64_t rs = 0, re = dFrames;
        if (le != 0 && ls < lend && ls < dFrames) { rs = ls; re = lend < dFrames ? lend : dFrames; }
        // A (re)trigger seeks the region's ENTRY edge, which depends on
        // direction: forward starts at `rs`, reverse starts just inside `re`.
        const bool reversing = d.rate.load(std::memory_order_relaxed) < 0.0;
        const double entry = reversing ? static_cast<double>(re) - 1.0 : static_cast<double>(rs);
        if (d.pendingReset.exchange(0, std::memory_order_acq_rel) != 0) {
            // D-WZ-SCRUBCUE-01: a trigger fires from where you last scrubbed, if
            // you scrubbed. Consumed here, so the NEXT wrap goes back to the
            // region entry — the cue is a one-shot, not a moved loop start.
            d.playhead = d.cueFrame >= 0.0 ? d.cueFrame : entry;
            d.cueFrame = -1.0;
        }
        // A SCRUB wins over the region clamp below: land exactly where the user
        // dragged, bounded only by the buffer. Note the loop WRAP further down
        // still applies, so scrubbing outside an active loop region folds back
        // into it — a loop is a loop.
        const int64_t seek = d.pendingSeek.exchange(-1, std::memory_order_acq_rel);
        if (seek >= 0) {
            const double target = static_cast<double>(seek);
            d.playhead = target < static_cast<double>(dFrames)
                             ? target
                             : static_cast<double>(dFrames > 0 ? dFrames - 1 : 0);
            d.cueFrame = d.playhead; // arm: a trigger now starts here
        } else
        if (d.playhead < static_cast<double>(rs) || d.playhead >= static_cast<double>(re))
            d.playhead = entry;

        // --- signed varispeed (P4-02, docs/specs/playback-composer.md §1) ----
        // The rate is smoothed with the ONE D-WZ-RAMP-01 constant so a knob
        // sweep glides like tape instead of zippering. Reverse is NOT a special
        // case: a negative rate advances the playhead backwards through the very
        // same reader.
        double tgtRate = d.rate.load(std::memory_order_relaxed);
        if (!std::isfinite(tgtRate)) tgtRate = 1.0;
        // Clamp |rate| into [1/16, 16] (spec §1); 0 would stall the playhead.
        const double mag = std::abs(tgtRate);
        if (mag < 1.0 / 16.0) tgtRate = tgtRate < 0.0 ? -1.0 / 16.0 : 1.0 / 16.0;
        else if (mag > 16.0) tgtRate = tgtRate < 0.0 ? -16.0 : 16.0;
        if (d.smRate == 0.0) d.smRate = tgtRate; // seed: no glide on first block

        // --- OVERDUB (D-WZ-OVERDUB-01) --------------------------------------
        // Sound-on-sound: keep playing, and SUM the input into the same buffer
        // at the playhead. Works on ANY material — a loaded file overdubs
        // exactly like a recorded take, because a strip is a strip.
        const bool overdubbing = d.overdub.load(std::memory_order_acquire) != 0;
        const uint32_t odMode = d.overdubMode.load(std::memory_order_relaxed);
        const float* od0 = (overdubbing && in_bus != nullptr && d.recSrcChan0 >= 0 &&
                            static_cast<uint32_t>(d.recSrcChan0) < in_count)
                               ? in_bus[d.recSrcChan0] : nullptr;
        const float* od1 = (overdubbing && in_bus != nullptr && d.recSrcChan1 >= 0 &&
                            static_cast<uint32_t>(d.recSrcChan1) < in_count)
                               ? in_bus[d.recSrcChan1] : nullptr;
        float* odScratch = e->recScratch.data();
        uint32_t odCaptured = 0;

        const double regionLen = static_cast<double>(re) - static_cast<double>(rs);
        bool finished = false;
        for (uint32_t i = 0; i < frames; ++i) {
            if (finished) { dl[i] = 0.0f; dr[i] = 0.0f; continue; }
            d.smRate += alpha * (tgtRate - d.smRate);
            // SNAP once the glide is inaudibly close. A one-pole only approaches
            // its target asymptotically, so without this the smoothed rate would
            // never EQUAL ±1 and the bit-exact identity path below would be
            // unreachable — the deck would interpolate forever at "unity".
            // 1e-6 = 1 ppm of rate: inaudible as a pitch/speed error, and it
            // lets a settled deck reach EXACT identity in ~0.1 s rather than
            // creeping toward it forever.
            if (std::abs(tgtRate - d.smRate) < 1e-6) d.smRate = tgtRate;
            // IDENTITY PATH: at exactly ±1 the reader does a direct integer read
            // — no interpolation, no filter, bit-exact (spec §1).
            const bool identity = d.smRate == 1.0 || d.smRate == -1.0;
            if (identity) {
                const auto idx = static_cast<uint64_t>(d.playhead);
                dl[i] = d.sample(0, idx);
                dr[i] = d.channels > 1 ? d.sample(1, idx) : dl[i];
            } else {
                dl[i] = d.sampleLerp(0, d.playhead);
                dr[i] = d.channels > 1 ? d.sampleLerp(1, d.playhead) : dl[i];
            }
            // Sum the input in at the position we just READ, so this pass and
            // the next hear it at the same point in the loop.
            if (overdubbing) {
                float vals[2];
                vals[0] = od0 != nullptr ? static_cast<float>(sanitize(od0[i])) : 0.0f;
                if (d.channels > 1)
                    vals[1] = od1 != nullptr ? static_cast<float>(sanitize(od1[i])) : vals[0];
                const auto wpos = static_cast<uint64_t>(d.playhead);
                if (wpos < dFrames) {
                    // SUM layers on top; REPLACE erases what was there. Both write
                    // in place, so neither grows the buffer or allocates.
                    if (odMode == 1u) d.appendFrame(wpos, vals, d.channels);
                    else d.mixFrame(wpos, vals, d.channels);
                }
                // HEAR YOURSELF. The deck's own output carries the live input on
                // top of the material, because the engine renders ONE source per
                // channel: routing the strip to the input instead would have
                // un-routed the loop, and you would be layering against silence.
                // D-WZ-MON-02 asks for "the input AGAINST the loop" — this is the
                // only place both can exist at once.
                dl[i] += vals[0];
                dr[i] += d.channels > 1 ? vals[1] : vals[0];
                // The RAM mix is destructive, so the drain is what preserves
                // this pass: every overdub lands as its own stamped take file
                // (recorder.md §9), even though the pre-mix buffer does not.
                for (uint32_t c = 0; c < d.channels; ++c)
                    odScratch[static_cast<size_t>(odCaptured) * d.channels + c] = vals[c];
                ++odCaptured;
            }
            d.playhead += d.smRate;

            if (d.smRate >= 0.0) {
                if (d.playhead >= static_cast<double>(re)) {
                    if (st == static_cast<uint32_t>(wz::DeckState::looping)) {
                        // Gapless forward wrap: carry the fractional overshoot so
                        // the loop stays phase-continuous at non-unity rates.
                        d.playhead = regionLen > 0.0
                            ? static_cast<double>(rs) +
                                  std::fmod(d.playhead - static_cast<double>(rs), regionLen)
                            : static_cast<double>(rs);
                    } else {
                        finished = true; // oneShot: region done → idle
                        d.state.store(static_cast<uint32_t>(wz::DeckState::idle),
                                      std::memory_order_release);
                        d.playhead = static_cast<double>(rs);
                    }
                }
            } else {
                // REVERSE: the region's other edge is the wrap point.
                if (d.playhead < static_cast<double>(rs)) {
                    if (st == static_cast<uint32_t>(wz::DeckState::looping)) {
                        d.playhead = regionLen > 0.0
                            ? static_cast<double>(re) -
                                  std::fmod(static_cast<double>(rs) - d.playhead, regionLen)
                            : static_cast<double>(rs);
                    } else {
                        finished = true; // reverse oneShot ends at the region start
                        d.state.store(static_cast<uint32_t>(wz::DeckState::idle),
                                      std::memory_order_release);
                        d.playhead = static_cast<double>(re) - 1.0;
                    }
                }
            }
        }
        // Each overdub PASS drains to its own crash-safe stamped take file: the
        // RAM mix is destructive, so the file is what preserves the material of
        // every pass (recorder.md §9's invariant).
        if (odCaptured > 0) e->deckDrain[di].write(odScratch, odCaptured, fs, blockStartSample);
        d.pubPlayhead.store(d.playhead, std::memory_order_relaxed);
    }

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
            } else if (ch.srcKind == wz::SourceKind::deck && ch.deckIndex >= 0 &&
                       static_cast<uint32_t>(ch.deckIndex) < wz::kMaxDecks) {
                srcL = e->deckOutL[ch.deckIndex].data();
                srcR = e->deckOutR[ch.deckIndex].data();
            } else if (ch.srcKind == wz::SourceKind::busTap) {
                // THE ONE LEGAL CYCLE: a busTap strip reads the PREVIOUS block
                // of a bus (srcChan0: 0 = main, 1 = monitor). One block of
                // latency — the honest price, stated in the UI, never hidden.
                if (ch.srcChan0 == 1) {
                    srcL = e->loopbackMonL.data();
                    srcR = e->loopbackMonR.data();
                } else {
                    srcL = e->loopbackMainL.data();
                    srcR = e->loopbackMainR.data();
                }
            } else if ((ch.srcKind == wz::SourceKind::appTap ||
                        ch.srcKind == wz::SourceKind::systemMixExcept ||
                        ch.srcKind == wz::SourceKind::virtualDeviceInput) &&
                       ch.ringId >= 0 &&
                       static_cast<size_t>(ch.ringId) < e->rings.size() &&
                       e->rings[static_cast<size_t>(ch.ringId)] != nullptr) {
                srcL = e->ringOutL[static_cast<size_t>(ch.ringId)].data();
                srcR = e->ringOutR[static_cast<size_t>(ch.ringId)].data();
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
            const uint32_t ob = (ch.outBus >= 0 &&
                                 ch.outBus < static_cast<int32_t>(wz::kMaxOutBuses))
                                    ? static_cast<uint32_t>(ch.outBus) : 0u;
            double* busL = e->accBusL[ob].data();
            double* busR = e->accBusR[ob].data();

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

                // Route into the strip's OUTPUT BUS (bus 0 == main). Solo
                // ducks the output path only; the cue feed below is untouched.
                busL[i] += l * soloG;
                busR[i] += r * soloG;
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

    // --- feedback watchdog (P4-04) ------------------------------------------
    // Internal cycles are structurally impossible except through the
    // LoopbackBus; an EXTERNAL loop (out → another app → "Wizard Out" → back in)
    // is undetectable by construction, so this level guard is the only defence.
    const double wdAlpha = 1.0 - std::exp(-1.0 / (kWatchdogWindowSec * fs));
    const double wdThresholdSq = std::pow(10.0, kWatchdogThresholdDb / 10.0); // dB→power
    const double wdReleaseStep = 1.0 / (kRampSeconds * fs);

    // GLOBAL RECORD arm/stop is picked up HERE, at the top of the block, so the
    // stamp is the exact engine sample capture began — Law C-2's whole point.
    {
        const uint32_t arm = e->globalArm.exchange(0u, std::memory_order_acq_rel);
        if (arm == 1u) {
            e->globalStartSample = blockStartSample;
            e->globalOn.store(1u, std::memory_order_release);
        } else if (arm == 2u) {
            e->globalOn.store(0u, std::memory_order_release);
        }
    }
    const bool globalRecording = e->globalOn.load(std::memory_order_relaxed) != 0 &&
                                 frames <= e->maxBlockFrames;
    float* gScratch = e->globalScratch.data();

    double mainPkL = 0.0, mainPkR = 0.0, monPkL = 0.0, monPkR = 0.0;
    float* outL = (bus_out != nullptr && bus_count >= 1) ? bus_out[0] : nullptr;
    float* outR = (bus_out != nullptr && bus_count >= 2) ? bus_out[1] : nullptr;
    float* cueL = (bus_out != nullptr && bus_count >= 3) ? bus_out[2] : nullptr;
    float* cueR = (bus_out != nullptr && bus_count >= 4) ? bus_out[3] : nullptr;
    for (uint32_t i = 0; i < frames; ++i) {
        e->smMain += alpha * (mainTgt - e->smMain);
        double l = accL[i] * e->smMain;
        double r = accR[i] * e->smMain;

        // Leaky RMS integrator over the main bus (mono power sum). Because it
        // integrates over 250 ms, a single transient cannot move it past the
        // threshold — only a SUSTAINED runaway can.
        const bool wdOn = e->wdEnabled.load(std::memory_order_relaxed) != 0;
        const double power = wdOn ? 0.5 * (l * l + r * r) : 0.0;
        if (wdOn) e->wdMeanSquare += wdAlpha * (power - e->wdMeanSquare);
        if (wdOn && e->wdMeanSquare > wdThresholdSq) {
            e->wdHoldRemaining = kWatchdogHoldSec; // (re)arm the hold
        } else if (wdOn && e->wdHoldRemaining > 0.0) {
            e->wdHoldRemaining -= 1.0 / fs; // still holding after the level cleared
        }

        // Hard ceiling, engaged/released through a ramp so it can never click.
        // Driven by THIS bus's own hold, not by the published alarm: the alarm is
        // now the OR across all buses, and a runaway on bus 3 must not pull the
        // main bus down with it.
        const double target = e->wdHoldRemaining > 0.0
                                  ? kWatchdogCeiling / std::sqrt(std::max(e->wdMeanSquare,
                                                                          wdThresholdSq))
                                  : 1.0;
        if (e->wdLimiterGain > target) {
            e->wdLimiterGain = std::max(target, e->wdLimiterGain - wdReleaseStep);
        } else if (e->wdLimiterGain < target) {
            e->wdLimiterGain = std::min(target, e->wdLimiterGain + wdReleaseStep);
        }
        if (e->wdLimiterGain < 1.0) { l *= e->wdLimiterGain; r *= e->wdLimiterGain; }

        if (outL != nullptr) outL[i] = static_cast<float>(l);
        if (outR != nullptr) outR[i] = static_cast<float>(r);
        // Tapped HERE: after the master fader and after the limiter, so the
        // archive is what actually left the bus. Taking it earlier would produce
        // a file that disagrees with what the room heard — and, once the
        // watchdog engaged, one that still contains the runaway.
        if (globalRecording) {
            gScratch[2u * i] = static_cast<float>(l);
            gScratch[2u * i + 1u] = static_cast<float>(r);
        }
        if (cueL != nullptr) cueL[i] = static_cast<float>(monL[i]);
        if (cueR != nullptr) cueR[i] = static_cast<float>(monR[i]);
        mainPkL = std::max(mainPkL, std::abs(l));
        mainPkR = std::max(mainPkR, std::abs(r));
        monPkL = std::max(monPkL, std::abs(monL[i]));
        monPkR = std::max(monPkR, std::abs(monR[i]));
    }
    // Output buses 1..7 → device channel pairs beyond the main/cue block
    // (P4-05). A layout wider than the device simply has no device channels to
    // write into, so it is dropped here and reported unmapped by the host —
    // never silently folded into another bus.
    for (uint32_t b = 1; b < wz::kMaxOutBuses; ++b) {
        const uint32_t chL = 2u * b + 2u; // bus 1 → device 4/5, bus 2 → 6/7, ...
        const uint32_t chR = chL + 1u;
        if (bus_out == nullptr || chR >= bus_count) break;
        float* busOutL = bus_out[chL];
        float* busOutR = bus_out[chR];
        const double* srcBusL = e->accBusL[b].data();
        const double* srcBusR = e->accBusR[b].data();
        const bool wdBusOn = e->wdEnabled.load(std::memory_order_relaxed) != 0;
        for (uint32_t i = 0; i < frames; ++i) {
            double bl = srcBusL[i] * e->smMain;
            double br = srcBusR[i] * e->smMain;
            // Same detector and same ramped ceiling as main, with this bus's own
            // state — RMS not peak, so a transient cannot trip it.
            if (wdBusOn) {
                const double p = 0.5 * (bl * bl + br * br);
                e->wdBusMeanSquare[b] += wdAlpha * (p - e->wdBusMeanSquare[b]);
                if (e->wdBusMeanSquare[b] > wdThresholdSq) e->wdBusHold[b] = kWatchdogHoldSec;
                else if (e->wdBusHold[b] > 0.0) e->wdBusHold[b] -= 1.0 / fs;
                const double tgt = e->wdBusHold[b] > 0.0
                                       ? kWatchdogCeiling / std::sqrt(std::max(
                                             e->wdBusMeanSquare[b], wdThresholdSq))
                                       : 1.0;
                if (e->wdBusGain[b] > tgt)
                    e->wdBusGain[b] = std::max(tgt, e->wdBusGain[b] - wdReleaseStep);
                else if (e->wdBusGain[b] < tgt)
                    e->wdBusGain[b] = std::min(tgt, e->wdBusGain[b] + wdReleaseStep);
                if (e->wdBusGain[b] < 1.0) { bl *= e->wdBusGain[b]; br *= e->wdBusGain[b]; }
            }
            if (busOutL != nullptr) busOutL[i] = static_cast<float>(bl);
            if (busOutR != nullptr) busOutR[i] = static_cast<float>(br);
        }
    }
    if (globalRecording) e->globalDrain.write(gScratch, frames, fs, blockStartSample);

    // ONE alarm lamp for the whole engine: the OR of every bus's hold. "Something
    // is running away" is the fact the user needs, and a runaway limited silently
    // on bus 3 would be worse than no lamp at all. Computed here, after every
    // bus, so no bus can clear a lamp another bus is still holding up.
    {
        bool anyHold = e->wdHoldRemaining > 0.0;
        for (uint32_t b = 1; b < wz::kMaxOutBuses; ++b) anyHold |= e->wdBusHold[b] > 0.0;
        e->wdEngaged.store(anyHold ? 1u : 0u, std::memory_order_relaxed);
    }

    // Any device channel with no bus mapped to it stays silent.
    for (uint32_t c = 4u + 2u * (wz::kMaxOutBuses - 1u); c < bus_count; ++c)
        if (bus_out != nullptr && bus_out[c] != nullptr)
            for (uint32_t i = 0; i < frames; ++i) bus_out[c][i] = 0.0f;

    // Snapshot the buses for the next block's LoopbackBus reads. Taken AFTER
    // the master fader so a loopback strip hears what actually left the bus.
    // (A block shorter than the last leaves stale tail frames unread: readers
    // only ever consume `frames`, which is why loopbackFrames is tracked.)
    for (uint32_t i = 0; i < frames; ++i) {
        e->loopbackMainL[i] = outL != nullptr ? outL[i] : 0.0f;
        e->loopbackMainR[i] = outR != nullptr ? outR[i] : 0.0f;
        e->loopbackMonL[i] = cueL != nullptr ? cueL[i] : 0.0f;
        e->loopbackMonR[i] = cueR != nullptr ? cueR[i] : 0.0f;
    }
    e->loopbackFrames = frames;

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
    const uint32_t decks = w != nullptr ? w->deckCount : 0;
    return kHotFrameLength + channels * 7u + decks * 8u;
}

uint32_t wz_engine_hotframe(const wz_engine* e, double* out, uint32_t capacity) {
    if (e == nullptr || out == nullptr) return 0;
    const uint32_t total = wz_engine_hotframe_length(e);
    if (capacity < total) return 0; // short buffer refused, not truncated

    out[0] = static_cast<double>(e->schemaVersion);
    out[1] = static_cast<double>(e->engineTimeSamples.load(std::memory_order_relaxed));
    out[2] = 0.0; // cpuLoad — placeholder until the render path is measured
    out[3] = static_cast<double>(e->wdEngaged.load(std::memory_order_relaxed));
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
            // srcRingFill (0..1), srcDriftPpm, srcDropouts — populated for
            // tap strips bound to a ring (D-WZ-CLOCK-01: drift visible live).
            double fill = 0.0, drift = 0.0, drops = 0.0;
            if (ch->ringId >= 0 && static_cast<size_t>(ch->ringId) < e->rings.size()) {
                const auto* ring = e->rings[static_cast<size_t>(ch->ringId)].get();
                const auto* asrc = e->ringAsrc[static_cast<size_t>(ch->ringId)].get();
                if (ring != nullptr) {
                    const double cap = static_cast<double>(ring->capacityFrames);
                    fill = cap > 0.0 ? static_cast<double>(ring->fillFrames()) / cap : 0.0;
                    drops = static_cast<double>(ring->overruns.load(std::memory_order_relaxed) +
                                                ring->underruns.load(std::memory_order_relaxed));
                }
                if (asrc != nullptr) drift = asrc->driftPpm();
            }
            out[idx++] = fill;
            out[idx++] = drift;
            out[idx++] = drops;
        }
        // Per-deck blocks (stride 7, order per schema DECK_BLOCK_FIELDS):
        // state playhead loopStart loopEnd rate recordLengthSamples
        // recordDrainFill — record fields stay 0 until P3.
        for (uint32_t di = 0; di < w->deckCount && di < wz::kMaxDecks; ++di) {
            const auto& d = e->decks[di];
            uint32_t le = 0; uint64_t ls = 0, lend = 0;
            d.readLoop(le, ls, lend);
            out[idx++] = static_cast<double>(d.state.load(std::memory_order_relaxed));
            out[idx++] = d.pubPlayhead.load(std::memory_order_relaxed);
            out[idx++] = static_cast<double>(ls);
            out[idx++] = static_cast<double>(lend);
            out[idx++] = d.rate.load(std::memory_order_relaxed);
            // P3 record telemetry: committed buffer length, drain backlog (0..1),
            // and the D-WZ-DECK-01 cap indicator.
            out[idx++] = static_cast<double>(d.frames.load(std::memory_order_acquire));
            const auto& drain = e->deckDrain[di];
            const double cap = static_cast<double>(drain.capacityFrames);
            out[idx++] = cap > 0.0 ? static_cast<double>(drain.fillFrames()) / cap : 0.0;
            out[idx++] = static_cast<double>(d.recCapReached.load(std::memory_order_relaxed));
        }
    }
    return idx;
}

} // extern "C"
