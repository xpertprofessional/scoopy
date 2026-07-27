// THE CENTERPIECE (Law C-3): record → stop-with-loop → the tape plays the
// just-captured buffer IN THE SAME BLOCK, gapless and sample-exact. No copy, no
// file round-trip, no gap at the seam. Ported from wizard's deck_handoff_test.
//
// Method: feed a RAMP into the record input (frame N carries value N), so every
// played sample identifies exactly which captured frame it came from. After the
// stop-block the output must be the captured ramp from its very first sample,
// and must wrap seamlessly at the loop end.
//
// ISOLATION NOTE: the record source is input channel 2, while the core is handed
// channels 0/1 (held silent). So main L/R carries the TAPE and nothing else,
// whatever the core does with its own input — and it also pins that
// recSrcChan indexes the raw input array rather than a pre-resolved L/R pair.
#include "sl_engine.h"

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
} // namespace

int main() {
    sl_engine* e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    sl_watchdog_set_enabled(e, 0); // measure the path under test, not the safety net
    CHECK(sl_engine_time_samples(e) == 0); // Law C-2 origin
    // A tape is heard through its channel; bind 1:1 at unity (see sl_tape_test).
    for (uint32_t t = 0; t < sl_channel_count(); ++t)
        CHECK(sl_channel_set_source(e, t, 1 /* tape */, t) == 1);

    // Record engine input channel 2 (mono) into tape 0.
    CHECK(sl_tape_set_record_source(e, 0, 0 /* deviceInput */, 2, -1) == 1);
    sl_tape_set_loop(e, 0, 1, 0, 0); // loop ENABLED, degenerate → "the take is the loop"

    std::vector<float> zero(kQ, 0.0f), in(kQ), l(kQ), r(kQ);
    const float* ins[3] = {zero.data(), zero.data(), in.data()};
    float* outs[2] = {l.data(), r.data()};

    // --- record 3 blocks of a ramp: captured frame N holds value N -----------
    sl_tape_record_service(e);
    sl_tape_record_start(e, 0);
    uint32_t ramp = 0;
    for (int b = 0; b < 3; ++b) {
        for (uint32_t i = 0; i < kQ; ++i) in[i] = static_cast<float>(ramp++);
        sl_render_io(e, ins, 3, outs, 2, kQ);
        sl_tape_record_service(e);
    }
    const uint64_t recorded = sl_tape_frames(e, 0);
    CHECK(recorded == 3 * kQ); // every input frame captured, none dropped
    CHECK(sl_tape_state(e, 0) == 3); // recording

    // Stop returns the take's engine-sample stamp (Law C-2 anchor).
    const uint64_t stamp = sl_tape_record_stop(e, 0);
    CHECK(stamp == 0); // recording began at engine sample 0 in this fixture

    // --- THE HANDOFF BLOCK: the tape must play the take from sample 0 --------
    for (uint32_t i = 0; i < kQ; ++i) in[i] = -999.0f; // input now garbage; must not appear
    sl_render_io(e, ins, 3, outs, 2, kQ);
    CHECK(sl_tape_state(e, 0) == 1); // looping, in the very block that stopped it
    for (uint32_t i = 0; i < kQ; ++i) {
        // Sample-exact: output frame i IS captured frame i. No gap, no silence,
        // no repeat, no leftover input.
        CHECK(l[i] == static_cast<float>(i));
        CHECK(r[i] == l[i]); // mono material fans out to both sides
    }

    // --- continues seamlessly, and wraps at the end of the take -------------
    for (int b = 1; b < 3; ++b) {
        sl_render_io(e, ins, 3, outs, 2, kQ);
        for (uint32_t i = 0; i < kQ; ++i)
            CHECK(l[i] == static_cast<float>(static_cast<uint32_t>(b) * kQ + i));
    }
    // Next block wraps to the top of the take — gapless, no repeated/skipped sample.
    sl_render_io(e, ins, 3, outs, 2, kQ);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == static_cast<float>(i));

    // --- stop WITHOUT loop leaves the buffer retained, tape idle -------------
    sl_tape_set_loop(e, 0, 0, 0, 0);
    sl_tape_record_service(e);
    sl_tape_record_start(e, 0);
    for (uint32_t i = 0; i < kQ; ++i) in[i] = 5.0f;
    sl_render_io(e, ins, 3, outs, 2, kQ);
    sl_tape_record_stop(e, 0);
    sl_render_io(e, ins, 3, outs, 2, kQ);
    CHECK(sl_tape_frames(e, 0) == kQ); // the new take replaced the old, retained
    CHECK(sl_tape_state(e, 0) == 0);   // idle
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == 0.0f); // idle → silent, not looping
    // ...and it can be triggered into playback afterwards (buffer really is there).
    sl_tape_trigger(e, 0, 0); // loop
    sl_render_io(e, ins, 3, outs, 2, kQ);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == 5.0f);

    // --- the stamp is the engine clock at record start (Law C-2) ------------
    sl_tape_record_service(e);
    sl_tape_record_start(e, 0);
    sl_render_io(e, ins, 3, outs, 2, kQ);
    const uint64_t stamp2 = sl_tape_record_stop(e, 0);
    CHECK(stamp2 > 0);       // a later take carries a later stamp
    CHECK(stamp2 % kQ == 0); // stamped at a block boundary, exactly

    sl_engine_destroy(e);
    std::printf("sl_tape_handoff_test OK\n");
    return 0;
}
