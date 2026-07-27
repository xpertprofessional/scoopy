// Insert splice — the one operation that lengthens a tape outside recording.
// Ported from wizard's deck_insert_test.
//
// Splicing must not silently stop the loop you were listening to, and anything
// pointing INTO the material after the splice point has to move with it or it
// now points at different sound.
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
constexpr uint64_t kLen = 128;
constexpr uint64_t kIns = 32;
} // namespace

int main() {
    sl_engine* e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    sl_watchdog_set_enabled(e, 0); // measure the path under test, not the safety net
    // A tape is heard through its channel; bind 1:1 at unity (see sl_tape_test).
    for (uint32_t t = 0; t < sl_channel_count(); ++t)
        CHECK(sl_channel_set_source(e, t, 1 /* tape */, t) == 1);

    // Material: frame N holds N. Insert: a block of -1, so the splice is
    // unmistakable in the output.
    std::vector<float> base(kLen);
    for (size_t i = 0; i < kLen; ++i) base[i] = static_cast<float>(i);
    std::vector<float> patch(kIns, -1.0f);
    const float* basePlanar[1] = {base.data()};
    const float* patchPlanar[1] = {patch.data()};

    CHECK(sl_tape_load(e, 0, 1, kLen, basePlanar, kRate) == 1);

    // Bad arguments return 0 and change nothing.
    CHECK(sl_tape_insert(e, 0, 0, 1, 0, patchPlanar) == 0);   // no frames
    CHECK(sl_tape_insert(e, 0, 0, 1, kIns, nullptr) == 0);    // no data
    CHECK(sl_tape_insert(e, sl_tape_count(), 0, 1, kIns, patchPlanar) == 0);
    CHECK(sl_tape_insert(nullptr, 0, 0, 1, kIns, patchPlanar) == 0);
    // A tape with NOTHING in it has nothing to insert into — that is a load.
    CHECK(sl_tape_insert(e, 1, 0, 1, kIns, patchPlanar) == 0);
    CHECK(sl_tape_frames(e, 0) == kLen); // untouched by all of the above

    // --- splice at 64: material after it shifts later by exactly kIns -------
    sl_tape_set_loop(e, 0, 1, 0, kLen);
    sl_tape_trigger(e, 0, 0); // LOOPING across the splice
    std::vector<float> l(kQ), r(kQ);
    float* outs[2] = {l.data(), r.data()};
    sl_render(e, outs, 2, kQ);

    CHECK(sl_tape_insert(e, 0, 64, 1, kIns, patchPlanar) == 1);
    CHECK(sl_tape_frames(e, 0) == kLen + kIns); // grew by exactly the splice
    // The transport SURVIVED: a splice must not stop the loop you were playing.
    CHECK(sl_tape_state(e, 0) == 1);

    // Read the whole spliced buffer back through the waveform surface: it is
    // the same chunk storage the render reads, so this pins the material.
    const uint32_t cols = static_cast<uint32_t>(kLen + kIns);
    std::vector<float> mn(cols, 0.0f), mx(cols, 0.0f);
    CHECK(sl_tape_waveform(e, 0, 0, 0, kLen + kIns, cols, mn.data(), mx.data()) == cols);
    for (uint64_t i = 0; i < 64; ++i)
        CHECK(mn[i] == static_cast<float>(i)); // before the splice: unmoved
    for (uint64_t i = 64; i < 64 + kIns; ++i)
        CHECK(mn[i] == -1.0f);                 // the spliced-in material
    for (uint64_t i = 64 + kIns; i < kLen + kIns; ++i)
        CHECK(mn[i] == static_cast<float>(i - kIns)); // after: shifted, not rewritten

    // The loop region CONTAINED the splice point, so it grew to include the new
    // material — the loop you were playing now has the inserted part in it,
    // which is the point of inserting into a loop.
    sl_tape_trigger(e, 0, 3);
    bool sawPatch = false;
    for (int b = 0; b < 4; ++b) {
        sl_render(e, outs, 2, kQ);
        for (uint32_t i = 0; i < kQ; ++i) if (l[i] == -1.0f) sawPatch = true;
    }
    CHECK(sawPatch);

    // --- `at` past the end clamps to the end rather than refusing -----------
    const uint64_t lenNow = sl_tape_frames(e, 0);
    CHECK(sl_tape_insert(e, 0, lenNow + 9999, 1, kIns, patchPlanar) == 1);
    CHECK(sl_tape_frames(e, 0) == lenNow + kIns);
    std::vector<float> mn2(8, 0.0f), mx2(8, 0.0f);
    // The tail of the buffer is now the spliced block.
    CHECK(sl_tape_waveform(e, 0, 0, lenNow, lenNow + kIns, 1, mn2.data(), mx2.data()) == 1);
    CHECK(mn2[0] == -1.0f && mx2[0] == -1.0f);

    // --- the cap bounds insert too (it is the one growth path outside record)
    sl_tape_set_record_cap_frames(e, 0, sl_tape_frames(e, 0) + 4);
    CHECK(sl_tape_insert(e, 0, 0, 1, kIns, patchPlanar) == 0); // would exceed the cap
    CHECK(sl_tape_frames(e, 0) == lenNow + kIns);              // and changed nothing

    sl_engine_destroy(e);
    std::printf("sl_tape_insert_test OK\n");
    return 0;
}
