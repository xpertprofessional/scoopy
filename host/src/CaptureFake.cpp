// Deterministic fake capture backend (P2-01) — the fixture substrate for the
// whole capture layer. No threads, no real audio, no platform APIs: fixtures
// publish a synthetic topology and drive delivery block-by-block at a chosen
// rate/drift, so the source rings + ASRC (P2-02/03) can be tested against known
// clocks headlessly. The real backends (mac/pipewire) implement the SAME
// wz_capture.h behind their platform code.
#include "wz_capture.h"

#include <cmath>
#include <cstring>
#include <string>
#include <vector>

namespace {
constexpr double kTwoPi = 6.283185307179586;
constexpr uint64_t kNsPerSec = 1000000000ull;

struct FakeSource {
    std::string id;
    std::string name;
    wz_cap_kind kind;
    uint32_t channels;
};
} // namespace

struct wz_cap_handle {
    wz_cap* backend;
    std::string sourceId;
    uint32_t channels;
    wz_cap_deliver deliver;
    wz_cap_notify notify;
    void* ctx;
    // Fake per-source host clock + oscillator phase (deterministic, no wall time).
    uint64_t hostTimeNs;
    double phase;
    std::vector<float> scratch; // interleaved delivery buffer
};

struct wz_cap {
    bool isFake;
    std::vector<FakeSource> sources;
    uint64_t generation;
    std::vector<wz_cap_handle*> open;
};

extern "C" {

int32_t wz_cap_abi_version(void) { return WZ_CAP_ABI_VERSION; }

wz_cap_status wz_cap_create(const char* backend_name, wz_cap** out) {
    if (out == nullptr || backend_name == nullptr) return WZ_CAP_BAD_ARG;
    // Only the fake backend exists yet; mac/pipewire are P2-05/07 and decline
    // here (UNSUPPORTED) rather than pretend.
    if (std::strcmp(backend_name, "fake") != 0) {
        *out = nullptr;
        return WZ_CAP_UNSUPPORTED;
    }
    auto* c = new wz_cap();
    c->isFake = true;
    c->generation = 1;
    *out = c;
    return WZ_CAP_OK;
}

void wz_cap_destroy(wz_cap* c) {
    if (c == nullptr) return;
    for (auto* h : c->open) delete h;
    delete c;
}

uint32_t wz_cap_active_tap_count(const wz_cap* c) {
    return c != nullptr ? static_cast<uint32_t>(c->open.size()) : 0;
}

wz_cap_status wz_cap_refresh_sources(wz_cap* c) {
    // The fake topology only changes via wz_cap_fake_add/remove, which bump the
    // generation themselves; refresh is a no-op success for symmetry with real
    // backends (which snapshot the HAL here).
    return c != nullptr ? WZ_CAP_OK : WZ_CAP_BAD_ARG;
}

uint64_t wz_cap_topology_generation(const wz_cap* c) {
    return c != nullptr ? c->generation : 0;
}

uint32_t wz_cap_source_count(const wz_cap* c) {
    return c != nullptr ? static_cast<uint32_t>(c->sources.size()) : 0;
}

wz_cap_status wz_cap_source_info_at(const wz_cap* c, uint32_t index, wz_cap_source_info* out) {
    if (c == nullptr || out == nullptr || index >= c->sources.size()) return WZ_CAP_BAD_ARG;
    const auto& s = c->sources[index];
    out->id = s.id.c_str();
    out->name = s.name.c_str();
    out->kind = s.kind;
    out->pid = -1;
    out->channels = s.channels;
    return WZ_CAP_OK;
}

wz_cap_status wz_cap_open(wz_cap* c, const char* source_id,
                          wz_cap_deliver deliver, wz_cap_notify notify, void* ctx,
                          wz_cap_handle** out) {
    if (c == nullptr || source_id == nullptr || out == nullptr) return WZ_CAP_BAD_ARG;
    *out = nullptr;
    // Only capture sources (taps + virtual input) count against the cap;
    // the fake backend treats every open source as a tap for the envelope test.
    if (c->open.size() >= WZ_CAP_MAX_CONCURRENT_TAPS) return WZ_CAP_AT_CAPACITY;

    const FakeSource* src = nullptr;
    for (const auto& s : c->sources)
        if (s.id == source_id) { src = &s; break; }
    if (src == nullptr) return WZ_CAP_NOT_FOUND;

    auto* h = new wz_cap_handle();
    h->backend = c;
    h->sourceId = source_id;
    h->channels = src->channels;
    h->deliver = deliver;
    h->notify = notify;
    h->ctx = ctx;
    h->hostTimeNs = 0;
    h->phase = 0.0;
    c->open.push_back(h);
    *out = h;
    return WZ_CAP_OK;
}

wz_cap_status wz_cap_close(wz_cap_handle* h) {
    if (h == nullptr) return WZ_CAP_BAD_ARG;
    auto& open = h->backend->open;
    for (size_t i = 0; i < open.size(); ++i)
        if (open[i] == h) { open.erase(open.begin() + static_cast<long>(i)); break; }
    delete h;
    return WZ_CAP_OK;
}

/* --- fake control ------------------------------------------------------- */

wz_cap_status wz_cap_fake_add_source(wz_cap* c, const char* id, const char* name,
                                     wz_cap_kind kind, uint32_t channels) {
    if (c == nullptr || !c->isFake || id == nullptr || channels == 0) return WZ_CAP_BAD_ARG;
    for (const auto& s : c->sources)
        if (s.id == id) return WZ_CAP_BAD_ARG; // duplicate
    c->sources.push_back({id, name != nullptr ? name : "", kind, channels});
    ++c->generation;
    return WZ_CAP_OK;
}

wz_cap_status wz_cap_fake_remove_source(wz_cap* c, const char* id) {
    if (c == nullptr || !c->isFake || id == nullptr) return WZ_CAP_BAD_ARG;
    for (size_t i = 0; i < c->sources.size(); ++i)
        if (c->sources[i].id == id) {
            c->sources.erase(c->sources.begin() + static_cast<long>(i));
            ++c->generation;
            // Notify any open handle on this source that it vanished.
            for (auto* h : c->open)
                if (h->sourceId == id && h->notify != nullptr)
                    h->notify(h->ctx, WZ_CAP_EVT_SOURCE_GONE);
            return WZ_CAP_OK;
        }
    return WZ_CAP_NOT_FOUND;
}

wz_cap_status wz_cap_fake_deliver(wz_cap_handle* h, uint32_t frames, double freq_hz,
                                  double actual_rate) {
    if (h == nullptr || frames == 0 || actual_rate <= 0.0) return WZ_CAP_BAD_ARG;
    if (h->deliver == nullptr) return WZ_CAP_OK;
    const size_t need = static_cast<size_t>(frames) * h->channels;
    if (h->scratch.size() < need) h->scratch.resize(need);

    const double inc = kTwoPi * freq_hz / actual_rate;
    for (uint32_t i = 0; i < frames; ++i) {
        const auto s = static_cast<float>(std::sin(h->phase));
        for (uint32_t ch = 0; ch < h->channels; ++ch)
            h->scratch[static_cast<size_t>(i) * h->channels + ch] = s;
        h->phase += inc;
        if (h->phase >= kTwoPi) h->phase -= kTwoPi;
    }
    // Timestamp = the fake host clock BEFORE this block; then advance it at the
    // ACTUAL rate (the source's true clock — which may differ from what the
    // engine expects; that difference is the drift the ASRC must correct).
    h->deliver(h->ctx, h->scratch.data(), frames, h->channels, actual_rate, h->hostTimeNs);
    h->hostTimeNs += static_cast<uint64_t>(
        (static_cast<double>(frames) / actual_rate) * static_cast<double>(kNsPerSec) + 0.5);
    return WZ_CAP_OK;
}

} // extern "C"
