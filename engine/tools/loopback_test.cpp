// LoopbackBus — the one legal cycle (P4-03, playback-composer.md §2 + §8 #2).
//
// Wizard's differentiator needs a deck to be able to record Wizard's OWN output
// (record-own-output, resample the mix). That is a cycle, which the graph
// otherwise forbids. The LoopbackBus makes it well-defined by reading the
// PREVIOUS block of a bus — so the render schedule stays acyclic by
// construction and no cycle detection ever runs on the audio thread.
//
// The load-bearing assertion: the delay is EXACTLY one block. Not zero (which
// would be a true cycle / self-reference), not two (which would be a bug that
// only shows up as mysterious latency).
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
constexpr uint32_t kQ = 32;
constexpr double kRate = 48000.0;
constexpr int32_t kBusMain = 0;
constexpr int32_t kBusMonitor = 1;
} // namespace

int main() {
    wz_engine* e = wz_engine_create(kRate, kQ, 9);
    CHECK(e != nullptr);

    // Strip 0: a device input, hard-left at unity → drives the main bus.
    // Strip 1: a busTap of MAIN, hard-left at unity → reads main's previous
    //          block. Its own contribution is what closes the loop, one block
    //          behind, which is exactly the send~/receive~ idiom.
    auto build = [&](bool withLoopback) {
        wz_world_begin(e);
        wz_world_channel_begin(e, "in");
        wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 1); // deviceInput
        wz_world_channel_set(e, wz_world_key_for_name("srcChan0"), 0);
        wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75); // unity dB
        wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0);  // hard L
        wz_world_channel_end(e);
        if (withLoopback) {
            wz_world_channel_begin(e, "loop");
            wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 6); // busTap
            wz_world_channel_set(e, wz_world_key_for_name("srcChan0"), kBusMain);
            wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
            wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0);
            wz_world_channel_end(e);
        }
        wz_world_commit(e);
    };

    std::vector<float> in(kQ), l(kQ), r(kQ), cl(kQ), cr(kQ);
    const float* ins[1] = {in.data()};
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
    auto renderWith = [&](float v) {
        for (uint32_t i = 0; i < kQ; ++i) in[i] = v;
        wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    };

    // --- 1. WITHOUT loopback: a plain input strip, for the baseline ---------
    build(false);
    for (int b = 0; b < 200; ++b) renderWith(0.0f); // settle every smoother
    renderWith(0.25f);
    const double plain = l[kQ - 1];
    CHECK(std::abs(plain - 0.25) < 1e-5); // hard-left unity: input arrives as-is
    renderWith(0.0f);
    CHECK(std::abs(l[kQ - 1]) < 1e-5); // and stops when the input stops

    // --- 2. WITH loopback: EXACTLY one block of delay ------------------------
    build(true);
    for (int b = 0; b < 300; ++b) renderWith(0.0f); // settle; buses at silence
    CHECK(std::abs(l[kQ - 1]) < 1e-5);

    // Block A: feed 0.25. The loopback strip is reading the PREVIOUS block,
    // which was silence — so this block must be the input ALONE.
    renderWith(0.25f);
    const double blockA = l[kQ - 1];
    CHECK(std::abs(blockA - 0.25) < 1e-5); // no zero-delay self-sum

    // Block B: input silent. Now the loopback strip replays block A's output —
    // proving the delay is exactly ONE block, not zero and not two.
    renderWith(0.0f);
    const double blockB = l[kQ - 1];
    CHECK(std::abs(blockB - blockA) < 1e-5);
    std::printf("  blockA(in only)=%.6f  blockB(loopback of A)=%.6f\n", blockA, blockB);

    // Block C: still silent. The loopback now replays block B — a decaying
    // echo train at unity, each block one behind. (At exactly unity gain this
    // sustains; the watchdog in P4-04 is what guards a runaway.)
    renderWith(0.0f);
    const double blockC = l[kQ - 1];
    CHECK(std::abs(blockC - blockB) < 1e-5);

    // --- 3. the delay is genuinely ONE block, sample-aligned ----------------
    // Feed a per-sample ramp so each frame is identifiable, then check the next
    // block reproduces it frame-for-frame.
    for (int b = 0; b < 300; ++b) renderWith(0.0f); // quiesce the echo train
    for (uint32_t i = 0; i < kQ; ++i) in[i] = static_cast<float>(i) / 100.0f;
    wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    std::vector<float> ramped(l.begin(), l.end());
    for (uint32_t i = 0; i < kQ; ++i) in[i] = 0.0f;
    wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    for (uint32_t i = 0; i < kQ; ++i)
        CHECK(std::abs(l[i] - ramped[i]) < 1e-5); // frame-for-frame, not smeared

    // --- 4. a monitor-bus loopback is independent of main -------------------
    wz_world_begin(e);
    wz_world_channel_begin(e, "in");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 1);
    wz_world_channel_set(e, wz_world_key_for_name("srcChan0"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
    wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0);
    wz_world_channel_set(e, wz_world_key_for_name("toMonitor"), 1.0); // feeds cue
    wz_world_channel_end(e);
    wz_world_channel_begin(e, "cueloop");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 6); // busTap
    wz_world_channel_set(e, wz_world_key_for_name("srcChan0"), kBusMonitor);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
    wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0);
    wz_world_channel_end(e);
    wz_world_commit(e);
    for (int b = 0; b < 300; ++b) renderWith(0.0f);
    renderWith(0.3f);
    const double cueA = cl[kQ - 1]; // the cue bus carried it
    CHECK(cueA > 0.0);
    renderWith(0.0f);
    // Next block, the monitor loopback appears on MAIN (the busTap strip feeds
    // main like any strip) — the cue bus is tapped, not re-entered.
    CHECK(std::abs(l[kQ - 1] - cueA) < 1e-4);

    // --- 5. an unresolved/OOB bus index is silent, never a crash ------------
    wz_world_begin(e);
    wz_world_channel_begin(e, "bad");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 6);
    wz_world_channel_set(e, wz_world_key_for_name("srcChan0"), 99); // no such bus
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
    wz_world_channel_end(e);
    wz_world_commit(e);
    for (int b = 0; b < 4; ++b) renderWith(0.5f);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::isfinite(l[i]));

    wz_engine_destroy(e);
    std::printf("loopback_test OK\n");
    return 0;
}
