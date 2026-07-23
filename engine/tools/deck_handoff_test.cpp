// THE P3 CENTERPIECE (Law C-3): record → stop-with-loop → the deck plays the
// just-captured buffer IN THE SAME BLOCK, gapless and sample-exact. No copy, no
// file round-trip, no gap at the seam.
//
// Method: feed a RAMP into the record input (frame N carries value N), so every
// played sample identifies exactly which captured frame it came from. After the
// stop-block the output must be the captured ramp from its very first sample,
// and must wrap seamlessly at the loop end.
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
constexpr uint32_t kQ = 64; // small block → the seam lands mid-test
constexpr double kRate = 48000.0;

// A deck strip, hard-left at unity, so main L carries the deck signal 1:1.
void buildDeckWorld(wz_engine* e, uint32_t deck) {
    wz_world_begin(e);
    wz_world_channel_begin(e, "d");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 2); // deck
    wz_world_channel_set(e, wz_world_key_for_name("deckIndex"), static_cast<double>(deck));
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75); // unity dB
    wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0);  // hard L
    wz_world_channel_end(e);
    wz_world_set_deck_count(e, 1);
    wz_world_commit(e);
}
} // namespace

int main() {
    wz_engine* e = wz_engine_create(kRate, kQ, 7);
    CHECK(e != nullptr);
    buildDeckWorld(e, 0);

    // Record engine input channel 0 (mono) into deck 0.
    wz_deck_set_record_source(e, 0, 0, -1);
    wz_deck_set_loop(e, 0, 1, 0, 0); // loop ENABLED, degenerate → "the take is the loop"

    std::vector<float> in(kQ), l(kQ), r(kQ), cl(kQ), cr(kQ);
    const float* ins[1] = {in.data()};
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};

    // --- record 3 blocks of a ramp: captured frame N holds value N -----------
    wz_deck_record_service(e);
    wz_deck_record_start(e, 0);
    uint32_t ramp = 0;
    for (int b = 0; b < 3; ++b) {
        for (uint32_t i = 0; i < kQ; ++i) in[i] = static_cast<float>(ramp++);
        wz_engine_render_io(e, ins, 1, outs, 4, kQ);
        wz_deck_record_service(e);
    }
    const uint64_t recorded = wz_deck_frames(e, 0);
    CHECK(recorded == 3 * kQ); // every input frame captured, none dropped

    // Stop returns the take's engine-sample stamp (Law C-2 anchor).
    const uint64_t stamp = wz_deck_record_stop(e, 0);
    CHECK(stamp == 0); // recording began at engine sample 0 in this fixture

    // --- THE HANDOFF BLOCK: the deck must play the take from sample 0 --------
    for (uint32_t i = 0; i < kQ; ++i) in[i] = -999.0f; // input now garbage; must not appear
    wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    for (uint32_t i = 0; i < kQ; ++i) {
        // Sample-exact: output frame i IS captured frame i. No gap, no silence,
        // no repeat, no leftover input.
        CHECK(l[i] == static_cast<float>(i));
    }

    // --- continues seamlessly, and wraps at the end of the take -------------
    for (int b = 1; b < 3; ++b) {
        wz_engine_render_io(e, ins, 1, outs, 4, kQ);
        for (uint32_t i = 0; i < kQ; ++i)
            CHECK(l[i] == static_cast<float>(static_cast<uint32_t>(b) * kQ + i));
    }
    // Next block wraps to the top of the take — gapless, no repeated/skipped sample.
    wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == static_cast<float>(i));

    // --- stop WITHOUT loop leaves the buffer retained, deck idle ------------
    wz_deck_set_loop(e, 0, 0, 0, 0);
    wz_deck_record_service(e);
    wz_deck_record_start(e, 0);
    for (uint32_t i = 0; i < kQ; ++i) in[i] = 5.0f;
    wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    wz_deck_record_stop(e, 0);
    wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    CHECK(wz_deck_frames(e, 0) == kQ); // the new take replaced the old, retained
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == 0.0f); // idle → silent, not looping
    // ...and it can be triggered into playback afterwards (buffer really is there).
    wz_deck_trigger(e, 0, 0); // loop
    wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == 5.0f);

    // --- the stamp is the engine clock at record start (Law C-2) ------------
    const uint64_t before = 0; // clock advanced by every render above
    (void)before;
    wz_deck_record_service(e);
    wz_deck_record_start(e, 0);
    wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    const uint64_t stamp2 = wz_deck_record_stop(e, 0);
    CHECK(stamp2 > 0);           // a later take carries a later stamp
    CHECK(stamp2 % kQ == 0);     // stamped at a block boundary, exactly

    wz_engine_destroy(e);
    std::printf("deck_handoff_test OK\n");
    return 0;
}
