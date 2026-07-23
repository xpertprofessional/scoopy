// Fake capture backend contract (P2-01): create/destroy, polled topology
// generation, enumerate, open/close, the 16-tap soft cap (D-WZ-TAPCAP-01),
// timestamped delivery at a chosen rate, source-gone notify.
#include "wz_capture.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {
struct Sink {
    uint32_t blocks = 0;
    uint64_t lastHost = 0;
    uint64_t firstHost = 0;
    double lastRate = 0;
    uint32_t lastFrames = 0;
    uint32_t lastChannels = 0;
    bool gone = false;
};
void onDeliver(void* ctx, const float* in, uint32_t frames, uint32_t channels,
               double rate, uint64_t host) {
    auto* s = static_cast<Sink*>(ctx);
    if (s->blocks == 0) s->firstHost = host;
    s->lastHost = host;
    s->lastRate = rate;
    s->lastFrames = frames;
    s->lastChannels = channels;
    ++s->blocks;
    (void)in;
}
void onNotify(void* ctx, wz_cap_event evt) {
    if (evt == WZ_CAP_EVT_SOURCE_GONE) static_cast<Sink*>(ctx)->gone = true;
}
} // namespace

int main() {
    CHECK(wz_cap_abi_version() == WZ_CAP_ABI_VERSION);

    // Unknown backend declines with UNSUPPORTED, not a crash or a lie.
    wz_cap* bad = nullptr;
    CHECK(wz_cap_create("pipewire", &bad) == WZ_CAP_UNSUPPORTED);
    CHECK(bad == nullptr);

    wz_cap* c = nullptr;
    CHECK(wz_cap_create("fake", &c) == WZ_CAP_OK);
    CHECK(c != nullptr);

    // Topology generation bumps on every add/remove (the polled integer).
    const auto g0 = wz_cap_topology_generation(c);
    CHECK(wz_cap_fake_add_source(c, "spotify", "Spotify", WZ_SRC_PROCESS, 2) == WZ_CAP_OK);
    CHECK(wz_cap_fake_add_source(c, "sysmix", "System (except Wizard)", WZ_SRC_SYSTEM_MIX_EXCEPT, 2) == WZ_CAP_OK);
    CHECK(wz_cap_topology_generation(c) > g0);
    CHECK(wz_cap_fake_add_source(c, "spotify", "dup", WZ_SRC_PROCESS, 2) == WZ_CAP_BAD_ARG);
    CHECK(wz_cap_source_count(c) == 2);

    wz_cap_source_info info;
    CHECK(wz_cap_source_info_at(c, 0, &info) == WZ_CAP_OK);
    CHECK(std::strcmp(info.id, "spotify") == 0);
    CHECK(info.kind == WZ_SRC_PROCESS && info.channels == 2);
    CHECK(wz_cap_source_info_at(c, 99, &info) == WZ_CAP_BAD_ARG);

    // Open + deliver: timestamps advance at the ACTUAL rate; the reported rate
    // is carried on every block.
    Sink sink;
    wz_cap_handle* h = nullptr;
    CHECK(wz_cap_open(c, "nope", onDeliver, onNotify, &sink, &h) == WZ_CAP_NOT_FOUND);
    CHECK(wz_cap_open(c, "spotify", onDeliver, onNotify, &sink, &h) == WZ_CAP_OK);
    CHECK(wz_cap_active_tap_count(c) == 1);

    for (int b = 0; b < 10; ++b) CHECK(wz_cap_fake_deliver(h, 512, 440.0, 44100.0) == WZ_CAP_OK);
    CHECK(sink.blocks == 10);
    CHECK(sink.lastFrames == 512 && sink.lastChannels == 2);
    CHECK(sink.lastRate == 44100.0);
    // 9 inter-block gaps × 512/44100 s ≈ 104.49 ms; first block at t=0.
    CHECK(sink.firstHost == 0);
    const double elapsedMs = static_cast<double>(sink.lastHost) / 1e6;
    CHECK(elapsedMs > 104.0 && elapsedMs < 105.0);

    // Source-gone notify on removal — the handle STAYS open (preserve-don't-
    // drop: a vanished source keeps its strip, silent, reference intact); the
    // host closes it in response to the notify.
    CHECK(wz_cap_fake_remove_source(c, "spotify") == WZ_CAP_OK);
    CHECK(sink.gone);
    CHECK(wz_cap_active_tap_count(c) == 1); // still held
    CHECK(wz_cap_close(h) == WZ_CAP_OK);
    CHECK(wz_cap_active_tap_count(c) == 0);

    // Soft cap: 16 concurrent, the 17th refused, existing ones untouched.
    std::vector<wz_cap_handle*> handles;
    for (int i = 0; i < 20; ++i) {
        std::string id = "src" + std::to_string(i);
        wz_cap_fake_add_source(c, id.c_str(), id.c_str(), WZ_SRC_PROCESS, 1);
    }
    for (int i = 0; i < WZ_CAP_MAX_CONCURRENT_TAPS; ++i) {
        std::string id = "src" + std::to_string(i);
        wz_cap_handle* hh = nullptr;
        CHECK(wz_cap_open(c, id.c_str(), onDeliver, onNotify, &sink, &hh) == WZ_CAP_OK);
        handles.push_back(hh);
    }
    CHECK(wz_cap_active_tap_count(c) == WZ_CAP_MAX_CONCURRENT_TAPS);
    wz_cap_handle* over = nullptr;
    CHECK(wz_cap_open(c, "src16", onDeliver, onNotify, &sink, &over) == WZ_CAP_AT_CAPACITY);
    CHECK(over == nullptr);
    CHECK(wz_cap_active_tap_count(c) == WZ_CAP_MAX_CONCURRENT_TAPS); // unchanged
    // Closing one frees a slot.
    CHECK(wz_cap_close(handles[0]) == WZ_CAP_OK);
    CHECK(wz_cap_open(c, "src16", onDeliver, onNotify, &sink, &over) == WZ_CAP_OK);

    wz_cap_destroy(c); // frees remaining open handles
    std::printf("capture_fake_test OK\n");
    return 0;
}
