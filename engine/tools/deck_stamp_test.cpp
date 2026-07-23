// Law C-2 proof (P3-07): timestamps make multitrack.
//
// Record on deck 1; mid-take, start deck 2 from a DIFFERENT input; stop both.
// The delta of their engine-sample stamps must equal the real inter-start gap
// EXACTLY — that delta is the entire multitrack relationship (no timeline, no
// editing session; "align deck 2 to deck 1" is a subtraction).
#include "wz_engine.h"

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
constexpr uint32_t kQ = 128;
constexpr double kRate = 48000.0;
} // namespace

int main() {
    wz_engine* e = wz_engine_create(kRate, kQ, 8);
    CHECK(e != nullptr);

    // Two decks, two DIFFERENT inputs: deck 0 ← input 0, deck 1 ← input 1.
    wz_deck_set_record_source(e, 0, 0, -1);
    wz_deck_set_record_source(e, 1, 1, -1);

    std::vector<float> in0(kQ), in1(kQ), l(kQ), r(kQ), cl(kQ), cr(kQ);
    const float* ins[2] = {in0.data(), in1.data()};
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
    auto renderBlock = [&](float v0, float v1) {
        for (uint32_t i = 0; i < kQ; ++i) { in0[i] = v0; in1[i] = v1; }
        wz_engine_render_io(e, ins, 2, outs, 4, kQ);
    };

    // Let the clock run first, so neither stamp is trivially 0.
    for (int b = 0; b < 3; ++b) renderBlock(0.0f, 0.0f);

    // --- deck 0 starts ------------------------------------------------------
    wz_deck_record_service(e);
    wz_deck_record_start(e, 0);
    renderBlock(1.0f, 2.0f); // the block in which deck 0's capture begins
    wz_deck_record_service(e);

    constexpr int kBlocksBetween = 5; // deck 1 joins 5 blocks later, mid-take
    for (int b = 0; b < kBlocksBetween; ++b) {
        renderBlock(1.0f, 2.0f);
        wz_deck_record_service(e);
    }

    // --- deck 1 joins MID-TAKE (deck 0 is still recording) ------------------
    wz_deck_record_start(e, 1);
    renderBlock(1.0f, 2.0f);
    wz_deck_record_service(e);
    for (int b = 0; b < 4; ++b) {
        renderBlock(1.0f, 2.0f);
        wz_deck_record_service(e);
    }

    // --- stop both ----------------------------------------------------------
    const uint64_t stamp0 = wz_deck_record_stop(e, 0);
    const uint64_t stamp1 = wz_deck_record_stop(e, 1);
    renderBlock(0.0f, 0.0f); // the render applies both stops

    // THE LAW: the stamp delta IS the real inter-start gap, sample-exact.
    const uint64_t delta = stamp1 - stamp0;
    CHECK(delta == static_cast<uint64_t>(kBlocksBetween + 1) * kQ);
    CHECK(stamp0 == 3ull * kQ);  // deck 0 began after the 3 warm-up blocks
    CHECK(stamp1 > stamp0);      // deck 1 genuinely started later
    std::printf("  stamp0=%llu stamp1=%llu delta=%llu (%.3f s)\n",
                static_cast<unsigned long long>(stamp0),
                static_cast<unsigned long long>(stamp1),
                static_cast<unsigned long long>(delta),
                static_cast<double>(delta) / kRate);

    // Each deck captured its OWN input, not the other's — the takes are
    // genuinely different material recorded simultaneously.
    CHECK(wz_deck_frames(e, 0) > wz_deck_frames(e, 1)); // deck 0 ran longer
    // Play deck 0 back: it must contain input 0's value (1.0), not input 1's.
    wz_world_begin(e);
    wz_world_channel_begin(e, "d0");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 2);
    wz_world_channel_set(e, wz_world_key_for_name("deckIndex"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
    wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0); // hard L
    wz_world_channel_end(e);
    wz_world_set_deck_count(e, 2);
    wz_world_commit(e);
    wz_deck_trigger(e, 0, 0); // loop
    renderBlock(0.0f, 0.0f);
    renderBlock(0.0f, 0.0f);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] > 0.9f && l[i] < 1.1f); // input 0's 1.0

    // The alignment math the UI runs (mirrored in web/src/engine/takeAlign.ts):
    // deck 1 needs `delta` samples of leading silence to sit under deck 0.
    const uint64_t leadingSilenceForDeck1 = stamp1 - stamp0;
    CHECK(leadingSilenceForDeck1 == delta);

    // A third take after everything: stamps stay monotonic with the clock.
    wz_deck_record_service(e);
    wz_deck_record_start(e, 2);
    renderBlock(0.0f, 0.0f);
    const uint64_t stamp2 = wz_deck_record_stop(e, 2);
    CHECK(stamp2 > stamp1);
    CHECK(stamp2 % kQ == 0); // stamped at a block boundary, exactly

    wz_engine_destroy(e);
    std::printf("deck_stamp_test OK\n");
    return 0;
}
