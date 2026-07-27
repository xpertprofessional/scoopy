// Overdub (D-WZ-OVERDUB-01): destructive sound-on-sound INTO material that is
// already there, while the tape keeps playing. Ported from wizard's
// deck_overdub_test, plus the refusals this port adds and one regression.
//
// The load-bearing case is overdubbing a LOADED file, not a recorded take:
// a tape is a tape, so a file overdubs exactly like a capture.
#include "sl_engine.h"

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
constexpr uint64_t kLen = 64; // one block per lap: a pass lines up with a render
} // namespace

int main() {
    sl_engine* e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    // A tape is heard through its channel; bind 1:1 at unity (see sl_tape_test).
    for (uint32_t t = 0; t < sl_channel_count(); ++t)
        CHECK(sl_channel_set_source(e, t, 1 /* tape */, t) == 1);

    // A loaded file at DC 1.0 — every overdub pass adds a countable layer.
    std::vector<float> buf(kLen, 1.0f);
    const float* planar[1] = {buf.data()};
    CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);

    std::vector<float> zero(kQ, 0.0f), in(kQ), l(kQ), r(kQ);
    const float* ins[3] = {zero.data(), zero.data(), in.data()};
    float* outs[2] = {l.data(), r.data()};

    // --- refusals, before anything is armed ---------------------------------
    // An EMPTY tape refuses: layering onto nothing is just recording, and
    // that is what the record verb is for.
    sl_tape_overdub_start(e, 1, 0);
    for (uint32_t i = 0; i < kQ; ++i) in[i] = 0.5f;
    sl_render_io(e, ins, 3, outs, 2, kQ);
    CHECK(sl_tape_frames(e, 1) == 0); // nothing was written anywhere

    // --- THE REGRESSION: overdub on a LOADED, never-recorded tape -----------
    // The donor only ever init'd the drain ring inside record_start, so this
    // exact case wrote into a zero-capacity ring — dead code at -O3, a SIGFPE
    // on the modulo at -O0. It must simply work, at any optimisation level.
    CHECK(sl_tape_set_record_source(e, 0, 0 /* deviceInput */, 2, -1) == 1);
    sl_tape_set_loop(e, 0, 1, 0, kLen);
    sl_tape_trigger(e, 0, 0); // looping
    sl_tape_overdub_start(e, 0, 0); // SUM

    for (uint32_t i = 0; i < kQ; ++i) in[i] = 0.5f;
    sl_render_io(e, ins, 3, outs, 2, kQ);
    // HEAR YOURSELF: this pass carries material + the live input on top
    // (D-WZ-MON-02 — "the input AGAINST the loop").
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::abs(l[i] - 1.5f) < 1e-5f);
    // The tape stays LOOPING throughout — overdub is not a transport state.
    CHECK(sl_tape_state(e, 0) == 1);
    // And the buffer did not GROW: overdub writes in place, which is why it
    // costs no allocation and leaves the 256 MB cap untouched.
    CHECK(sl_tape_frames(e, 0) == kLen);

    // Each pass drains to its own crash-safe stamped take: the RAM mix is
    // destructive, so the file is what preserves this pass's material.
    // A LOADED tape's drain must already be shaped to its width — this is the
    // second half of the regression above, and the half ASan caught: sizing
    // every ring at a guessed stereo overflowed this very buffer.
    CHECK(sl_tape_channels(e, 0) == 1);
    std::vector<float> drained(kQ * sl_tape_channels(e, 0), 0.0f);
    CHECK(sl_tape_drain(e, 0, drained.data(), kQ, nullptr) == kQ);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::abs(drained[i] - 0.5f) < 1e-6f);

    // Next lap: the buffer now holds 1.5, and the input is still summing in.
    sl_render_io(e, ins, 3, outs, 2, kQ);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::abs(l[i] - 2.0f) < 1e-5f);

    // Stopping the overdub leaves the layers in the buffer (destructive).
    sl_tape_overdub_stop(e, 0);
    sl_render_io(e, ins, 3, outs, 2, kQ);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::abs(l[i] - 2.0f) < 1e-5f);
    CHECK(sl_tape_frames(e, 0) == kLen);

    // --- REPLACE erases what was under the playhead -------------------------
    sl_tape_overdub_start(e, 0, 1); // REPLACE
    for (uint32_t i = 0; i < kQ; ++i) in[i] = 0.25f;
    sl_render_io(e, ins, 3, outs, 2, kQ);
    sl_tape_overdub_stop(e, 0);
    sl_render_io(e, ins, 3, outs, 2, kQ);
    // The 2.0 is gone — replaced by the input alone, not summed with it.
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::abs(l[i] - 0.25f) < 1e-5f);

    // --- a RECORDING tape refuses to overdub --------------------------------
    // That path appends and GROWS; overdub writes in place. One tape cannot do
    // both at once, and the refusal is what keeps the two buffers honest.
    sl_tape_trigger(e, 0, 2);
    CHECK(sl_tape_set_record_source(e, 3, 0, 2, -1) == 1);
    sl_tape_record_service(e);
    sl_tape_record_start(e, 3);
    sl_render_io(e, ins, 3, outs, 2, kQ);
    CHECK(sl_tape_state(e, 3) == 3);
    sl_tape_overdub_start(e, 3, 0);
    const uint64_t lenBefore = sl_tape_frames(e, 3);
    sl_render_io(e, ins, 3, outs, 2, kQ);
    CHECK(sl_tape_state(e, 3) == 3);                     // still just recording
    CHECK(sl_tape_frames(e, 3) == lenBefore + kQ);       // still appending, once
    sl_tape_record_stop(e, 3);
    sl_render_io(e, ins, 3, outs, 2, kQ);

    // --- a MIX-sourced tape refuses to overdub ------------------------------
    // Overdub reads its input during the PLAYBACK pass, which runs before the
    // mix exists — so a mainMix overdub could only ever layer the PREVIOUS
    // block, silently ~10 ms early against a take that is sample-exact.
    // Refusing beats faking it.
    CHECK(sl_tape_load(e, 6, 1, kLen, planar, kRate) == 1);
    CHECK(sl_tape_set_record_source(e, 6, 1 /* mainMix */, -1, -1) == 1);
    sl_tape_set_loop(e, 6, 1, 0, kLen);
    sl_tape_trigger(e, 6, 0);
    sl_tape_overdub_start(e, 6, 0);
    for (uint32_t i = 0; i < kQ; ++i) in[i] = 9.0f;
    sl_render_io(e, ins, 3, outs, 2, kQ);
    // Material only — the input never got layered in.
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::abs(l[i] - 1.0f) < 1e-5f);

    sl_engine_destroy(e);
    std::printf("sl_tape_overdub_test OK\n");
    return 0;
}
