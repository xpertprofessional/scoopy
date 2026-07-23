// Tap strip → ring → ASRC → mix, end to end in the render path (P2-04).
// A drifting source is written into a ring; a strip of kind appTap bound to
// that ring must render its (rate-corrected) signal into the main bus, and the
// per-strip HotFrame block must carry live srcRingFill / srcDriftPpm.
#include "wz_engine.h"

#include <cmath>
#include <cstdio>
#include <vector>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {
constexpr double kTwoPi = 6.283185307179586;
constexpr double kEngineRate = 48000.0;
constexpr double kTrueRate = 48000.6; // ~12.5 ppm fast (the drift to discover)
constexpr uint32_t kQ = 512;
} // namespace

int main() {
    wz_engine* e = wz_engine_create(kEngineRate, kQ, 7);
    CHECK(e != nullptr);

    // Open a stereo ring + its ASRC; nominal (reported) rate is 48000.
    const int32_t ring = wz_source_ring_open(e, "spotify", 2, 16 * kQ, kEngineRate);
    CHECK(ring >= 0);

    // A strip of kind appTap (3) bound to that ring, hard-left so main L carries
    // it at unity for an easy amplitude check.
    wz_world_begin(e);
    wz_world_channel_begin(e, "tap");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 3); // appTap
    wz_world_channel_set(e, wz_world_key_for_name("ringId"), ring);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75); // unity dB
    wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0);  // hard L
    wz_world_channel_end(e);
    wz_world_commit(e);
    CHECK(wz_world_channel_count(e) == 1);

    // Drive: feed the ring at the TRUE rate (drifted, nominal reported), pull
    // engine blocks. Interleaved stereo sine at -6 dBFS.
    std::vector<float> in(kQ * 2), l(kQ), r(kQ), cl(kQ), cr(kQ);
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
    double phase = 0.0, srcAccum = 0.0;
    uint64_t hostNs = 0;
    const double inc = kTwoPi * 1000.0 / kTrueRate;
    // Prime so block 0 isn't starved.
    for (uint32_t i = 0; i < kQ * 2; ++i) in[i] = 0.0f;
    wz_source_write(e, ring, in.data(), kQ, kEngineRate, 0);

    double peak = 0.0;
    for (int b = 0; b < 400; ++b) { // a few seconds — the ASRC estimate locks
        srcAccum += kQ * (kTrueRate / kEngineRate);
        uint32_t feed = static_cast<uint32_t>(srcAccum);
        srcAccum -= feed;
        if (feed > kQ) feed = kQ;
        for (uint32_t i = 0; i < feed; ++i) {
            const float s = static_cast<float>(0.5 * std::sin(phase));
            in[i * 2] = s;
            in[i * 2 + 1] = s;
            phase += inc;
            if (phase >= kTwoPi) phase -= kTwoPi;
        }
        hostNs += static_cast<uint64_t>((static_cast<double>(feed) / kTrueRate) * 1e9 + 0.5);
        wz_source_write(e, ring, in.data(), feed, kEngineRate, hostNs);
        wz_engine_render(e, outs, 4, kQ);
        for (uint32_t i = 0; i < kQ; ++i) peak = std::max(peak, std::abs(static_cast<double>(l[i])));
    }
    // The tap's 0.5-amplitude sine reaches main L at ~unity → peak near 0.5.
    CHECK(peak > 0.4 && peak < 0.6);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::isfinite(l[i]));

    // HotFrame: scalars + one channel block (stride 7). srcRingFill in (0,1],
    // srcDriftPpm ~12.5 discovered from timestamps, srcDropouts 0.
    const uint32_t len = wz_engine_hotframe_length(e);
    CHECK(len == 8 + 7);
    std::vector<double> hot(len, 0.0);
    CHECK(wz_engine_hotframe(e, hot.data(), len) == len);
    const double ringFill = hot[8 + 4];
    const double driftPpm = hot[8 + 5];
    const double dropouts = hot[8 + 6];
    CHECK(ringFill >= 0.0 && ringFill <= 1.0); // valid fraction (a snapshot of a sawtooth)
    CHECK(driftPpm > 11.0 && driftPpm < 14.0); // ~12.5 ppm discovered — the live telemetry
    CHECK(dropouts == 0.0);

    // An unresolved tap (ringId = -1) is a silent, preserved strip (a vanished
    // source leaves its strip in place — preserve-don't-drop).
    wz_world_begin(e);
    wz_world_channel_begin(e, "ghost");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 3); // appTap
    wz_world_channel_set(e, wz_world_key_for_name("ringId"), -1); // unresolved
    wz_world_channel_end(e);
    wz_world_commit(e);
    wz_engine_render(e, outs, 4, kQ);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == 0.0f); // silent, no crash

    wz_source_ring_close(e, ring);
    wz_engine_destroy(e);
    std::printf("source_strip_test OK\n");
    return 0;
}
