// Recording the MAIN MIX — the capability wizard's deck did not have, and the
// one STRIP-MODEL's closing argument depends on: "there is no special-case
// recorder; recording is always capture-this-bus", identical whether the sound
// came from a sequencer, a live input or a file.
//
// Wizard could only record device input channels (recSrcChan0/1 indexed the
// raw input array), so capturing the sum meant a post-fader LOOPBACK snapshot
// of the PREVIOUS block — audio ~10 ms older than the stamp written beside it
// (the error flagged in docs/specs/pd-global-record-as-strip.md §1). This
// fixture pins the fix: the mix capture runs AFTER the lanes are summed, so
// the take is THIS block's mix under THIS block's stamp.
//
// Method: a second tape plays a RAMP into the mix, so every mixed sample
// identifies its own frame. A one-block-late capture would start with silence
// and stay shifted; a same-block capture reproduces the ramp exactly.
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
constexpr uint32_t kQ = 64;
constexpr double kRate = 48000.0;
constexpr uint64_t kLen = 256;
} // namespace

int main() {
    sl_engine* e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    // The mix here is a ramp far above full scale; limiting it would change the
    // very samples this fixture compares the take against.
    sl_watchdog_set_enabled(e, 0);
    // A tape is heard through its channel; bind 1:1 at unity (see sl_tape_test).
    // That is what puts the ramp INTO the main mix this fixture then records.
    for (uint32_t t = 0; t < sl_channel_count(); ++t)
        CHECK(sl_channel_set_source(e, t, 1 /* tape */, t) == 1);

    // The source of the mix: tape 1 loops a ramp, frame N holding value N.
    std::vector<float> ramp(kLen);
    for (size_t i = 0; i < kLen; ++i) ramp[i] = static_cast<float>(i);
    const float* planar[1] = {ramp.data()};
    CHECK(sl_tape_load(e, 1, 1, kLen, planar, kRate) == 1);
    sl_tape_set_loop(e, 1, 1, 0, kLen);
    sl_tape_trigger(e, 1, 0);

    // The recorder: tape 0 captures the main mix. Note it names no input
    // channels at all — the mix is not an input.
    CHECK(sl_tape_set_record_source(e, 0, 1 /* mainMix */, -1, -1) == 1);
    CHECK(sl_tape_set_record_source(e, 0, 2 /* not a kind yet */, -1, -1) == 0);
    CHECK(sl_tape_set_record_source(e, 0, 1, -1, -1) == 1);

    std::vector<float> l(kQ), r(kQ);
    float* outs[2] = {l.data(), r.data()};

    sl_tape_record_service(e);
    sl_tape_record_start(e, 0);

    // --- block 0: the mix IS the ramp's first kQ frames, captured as such ---
    sl_render(e, outs, 2, kQ);
    CHECK(sl_tape_frames(e, 0) == kQ);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == static_cast<float>(i)); // the mix
    // A mix source is always stereo, whatever the material feeding it was.
    std::vector<float> drained(kQ * 2, 0.0f);
    uint64_t stamp = 999;
    CHECK(sl_tape_drain(e, 0, drained.data(), kQ, &stamp) == kQ);
    CHECK(stamp == 0); // this fixture's first render is engine sample 0
    for (uint32_t i = 0; i < kQ; ++i) {
        // THE ASSERTION THIS FIXTURE EXISTS FOR: captured frame i is the mix at
        // frame i of the SAME block. One block late would put silence here.
        CHECK(drained[i * 2 + 0] == static_cast<float>(i));
        CHECK(drained[i * 2 + 1] == static_cast<float>(i));
    }

    // --- and it stays aligned as the mix moves on ---------------------------
    for (uint32_t b = 1; b < 4; ++b) {
        sl_render(e, outs, 2, kQ);
        CHECK(sl_tape_drain(e, 0, drained.data(), kQ, nullptr) == kQ);
        for (uint32_t i = 0; i < kQ; ++i)
            CHECK(drained[i * 2 + 0] == static_cast<float>(b * kQ + i));
    }
    CHECK(sl_tape_frames(e, 0) == 4 * kQ);

    // --- Law C-3 works for a mix take exactly as for an input take ----------
    sl_tape_set_loop(e, 0, 1, 0, 0); // degenerate → the take is the loop
    sl_tape_record_stop(e, 0);
    sl_tape_trigger(e, 1, 2); // park the ramp so only the take is audible
    sl_render(e, outs, 2, kQ);
    CHECK(sl_tape_state(e, 0) == 1); // looping in the block that stopped it
    for (uint32_t i = 0; i < kQ; ++i)
        CHECK(l[i] == static_cast<float>(i)); // playing back the captured mix

    // --- the tap is post-everything, so a tape hears its OWN playback -------
    // That is the resample-the-mix instrument, not an accident: recording the
    // main mix while something loops into it captures that loop too.
    sl_tape_record_service(e);
    sl_tape_record_start(e, 2);
    CHECK(sl_tape_set_record_source(e, 2, 1, -1, -1) == 1);
    sl_tape_record_start(e, 2);
    sl_render(e, outs, 2, kQ);
    std::vector<float> d2(kQ * 2, 0.0f);
    CHECK(sl_tape_drain(e, 2, d2.data(), kQ, nullptr) == kQ);
    bool heardTheLoop = false;
    for (uint32_t i = 0; i < kQ; ++i) if (d2[i * 2] != 0.0f) heardTheLoop = true;
    CHECK(heardTheLoop);
    sl_tape_record_stop(e, 2);

    sl_engine_destroy(e);
    std::printf("sl_tape_mix_record_test OK\n");
    return 0;
}
