// Output buses & spatial playback (P4-05, playback-composer.md §4 + §8 #4).
//
// CONCEPT §4 claims quad / 5.1 / octophonic "falls out of the bus map for free".
// This fixture is where that claim is either true or marketing: there is no
// spatial engine, no panner matrix, no layout enum — a spatial layout is
// literally strips assigned to different output buses, and buses mapped to
// device channel pairs.
//
// The honesty assertion: a layout WIDER than the device must be reported
// unmapped and dropped, never silently folded into another bus (which would put
// audio somewhere the user never routed it).
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
constexpr uint32_t kQ = 64;
constexpr double kRate = 48000.0;

// One strip per input channel, each assigned to its own output bus, hard-left
// at unity so the bus's L channel carries that input verbatim.
void buildSpatialWorld(wz_engine* e, uint32_t strips) {
    wz_world_begin(e);
    for (uint32_t i = 0; i < strips; ++i) {
        char key[16];
        std::snprintf(key, sizeof(key), "s%u", i);
        wz_world_channel_begin(e, key);
        wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 1); // deviceInput
        wz_world_channel_set(e, wz_world_key_for_name("srcChan0"), i);
        wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75); // unity dB
        wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0);  // hard L
        wz_world_channel_set(e, wz_world_key_for_name("outBus"), i);  // its OWN bus
        wz_world_channel_end(e);
    }
    wz_world_commit(e);
}
} // namespace

int main() {
    // --- 1. the mapping arithmetic ------------------------------------------
    CHECK(wz_engine_max_out_buses() == 8);
    CHECK(wz_engine_mappable_buses(0) == 0);
    CHECK(wz_engine_mappable_buses(1) == 0); // a mono device carries no stereo bus
    CHECK(wz_engine_mappable_buses(2) == 1); // stereo: main only
    CHECK(wz_engine_mappable_buses(4) == 1); // main + cue, no room for bus 1
    CHECK(wz_engine_mappable_buses(6) == 2); // + bus 1 on device 4/5  → QUAD
    CHECK(wz_engine_mappable_buses(8) == 3); // + bus 2 on device 6/7  → 5.1-ish
    CHECK(wz_engine_mappable_buses(18) == 8); // clamped at the compiled maximum
    CHECK(wz_engine_mappable_buses(64) == 8);

    // --- 2. QUAD: 4 strips, 4 buses, an 8-channel device --------------------
    wz_engine* e = wz_engine_create(kRate, kQ, 9);
    CHECK(e != nullptr);
    wz_engine_set_watchdog_enabled(e, 0); // distinct per-bus test levels, not audio

    constexpr uint32_t kIns = 4;
    constexpr uint32_t kOuts = 10; // main 0/1 · cue 2/3 · bus1 4/5 · bus2 6/7 · bus3 8/9
    std::vector<std::vector<float>> inBuf(kIns, std::vector<float>(kQ, 0.0f));
    std::vector<std::vector<float>> outBuf(kOuts, std::vector<float>(kQ, 0.0f));
    std::vector<const float*> ins(kIns);
    std::vector<float*> outs(kOuts);
    for (uint32_t i = 0; i < kIns; ++i) ins[i] = inBuf[i].data();
    for (uint32_t i = 0; i < kOuts; ++i) outs[i] = outBuf[i].data();

    buildSpatialWorld(e, kIns);
    // Each input gets a distinct level so we can tell the buses apart.
    for (uint32_t i = 0; i < kIns; ++i)
        for (uint32_t f = 0; f < kQ; ++f) inBuf[i][f] = 0.1f * static_cast<float>(i + 1);

    for (int b = 0; b < 300; ++b) // settle the gain/pan smoothers
        wz_engine_render_io(e, ins.data(), kIns, outs.data(), kOuts, kQ);

    // Strip 0 → bus 0 → device 0/1 (main).  Strip 1 → bus 1 → device 4/5.
    // Strip 2 → bus 2 → device 6/7.        Strip 3 → bus 3 → device 8/9.
    const double got0 = outBuf[0][kQ - 1];
    const double got1 = outBuf[4][kQ - 1];
    const double got2 = outBuf[6][kQ - 1];
    const double got3 = outBuf[8][kQ - 1];
    CHECK(std::abs(got0 - 0.1) < 1e-3);
    CHECK(std::abs(got1 - 0.2) < 1e-3);
    CHECK(std::abs(got2 - 0.3) < 1e-3);
    CHECK(std::abs(got3 - 0.4) < 1e-3);
    std::printf("  octo-style map: bus0=%.3f bus1=%.3f bus2=%.3f bus3=%.3f\n",
                got0, got1, got2, got3);

    // Each bus carries ONLY its own strip — no bleed between spatial positions.
    CHECK(std::abs(outBuf[2][kQ - 1]) < 1e-6); // cue: nothing assigned to it
    CHECK(std::abs(outBuf[3][kQ - 1]) < 1e-6);
    CHECK(std::abs(outBuf[5][kQ - 1]) < 1e-6); // bus1 R (strips are hard-left)
    CHECK(std::abs(outBuf[7][kQ - 1]) < 1e-6);

    // --- 3. HONESTY: a layout wider than the device is DROPPED, not folded --
    // Same world, but a 4-channel device: buses 1..3 have nowhere to go. They
    // must NOT appear on main (that would put audio where nobody routed it).
    constexpr uint32_t kNarrow = 4;
    std::vector<float*> narrow(kNarrow);
    for (uint32_t i = 0; i < kNarrow; ++i) narrow[i] = outBuf[i].data();
    for (uint32_t i = 0; i < kOuts; ++i) std::fill(outBuf[i].begin(), outBuf[i].end(), 0.0f);
    for (int b = 0; b < 8; ++b)
        wz_engine_render_io(e, ins.data(), kIns, narrow.data(), kNarrow, kQ);
    // Main still carries ONLY strip 0 — the unmapped buses did not fold in.
    CHECK(std::abs(outBuf[0][kQ - 1] - 0.1) < 1e-3);
    CHECK(wz_engine_mappable_buses(kNarrow) == 1); // and the host is told so
    std::printf("  narrow device: main=%.3f (strips 1-3 dropped, not folded)\n",
                outBuf[0][kQ - 1]);

    // --- 4. an out-of-range bus assignment falls back to main, never OOB ----
    wz_world_begin(e);
    wz_world_channel_begin(e, "bad");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 1);
    wz_world_channel_set(e, wz_world_key_for_name("srcChan0"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
    wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0);
    wz_world_channel_set(e, wz_world_key_for_name("outBus"), 99); // no such bus
    wz_world_channel_end(e);
    wz_world_commit(e);
    for (int b = 0; b < 300; ++b)
        wz_engine_render_io(e, ins.data(), kIns, outs.data(), kOuts, kQ);
    CHECK(std::abs(outBuf[0][kQ - 1] - 0.1) < 1e-3); // landed on main
    for (uint32_t c = 0; c < kOuts; ++c)
        for (uint32_t f = 0; f < kQ; ++f) CHECK(std::isfinite(outBuf[c][f]));

    wz_engine_destroy(e);
    std::printf("output_map_test OK\n");
    return 0;
}
