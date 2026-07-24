// INSERT (P3-14): splice material INTO a deck, shifting the rest later.
//
// The distinction from SUM and REPLACE is the whole point: those write in place
// and the buffer length never changes, which is why they can be live punch
// modes. Insert LENGTHENS the deck, so it allocates and moves audio — a control
// thread operation, called with the render detached, exactly like wz_deck_load.
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
constexpr double kRate = 48000.0;

/** The strip's settled gain on L: unity fader x centre pan = cos(pi/4). The
    read-back below goes through the mixer, so raw buffer values arrive scaled by
    this — comparing against the raw value would fail for the wrong reason. */
constexpr float kStripGainL = 0.70710678f;

/** Read a deck frame back by rendering a 1-frame block at a known playhead. */
float at(wz_engine* e, uint64_t frame) {
    wz_deck_seek(e, 0, frame);
    float l = 0, r = 0, cl = 0, cr = 0;
    float* outs[4] = {&l, &r, &cl, &cr};
    wz_engine_render(e, outs, 4, 1);
    return l;
}
} // namespace

int main() {
    wz_engine* e = wz_engine_create(kRate, 256, 5);
    CHECK(e != nullptr);
    wz_engine_set_watchdog_enabled(e, 0);

    // Material that identifies its own position: 0.1 in the first half, 0.9 in
    // the second, so a splice is visible as an ORDER change, not just a length.
    constexpr uint32_t kLen = 4000;
    std::vector<float> base(kLen);
    for (uint32_t i = 0; i < kLen; ++i) base[i] = i < kLen / 2 ? 0.1f : 0.9f;
    const float* p0[1] = {base.data()};
    CHECK(wz_deck_load(e, 0, 1, kLen, p0, kRate) == 1);

    wz_world_begin(e);
    wz_world_channel_begin(e, "s");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 2);
    wz_world_channel_set(e, wz_world_key_for_name("deckIndex"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
    wz_world_channel_set(e, wz_world_key_for_name("pan"), 0.0);
    wz_world_channel_end(e);
    wz_world_set_deck_count(e, 1);
    wz_world_commit(e);
    wz_deck_trigger(e, 0, 0);

    // --- splice a marked block into the middle -------------------------------
    constexpr uint32_t kIns = 1000;
    std::vector<float> ins(kIns, 0.5f); // distinct from both halves
    const float* p1[1] = {ins.data()};
    const uint64_t insertAt = kLen / 2;
    CHECK(wz_deck_insert(e, 0, insertAt, 1, kIns, p1) == 1);

    // A splice must NOT stop the loop you were listening to.
    const uint32_t len = wz_engine_hotframe_length(e);
    std::vector<double> hot(len, 0.0);
    wz_engine_hotframe(e, hot.data(), len);
    CHECK(hot[8 + 1 * 7 + 0] == 1.0); // still 'looping' after the splice

    // The deck GREW by exactly the inserted length — this is the property that
    // makes insert impossible as a live mode.
    CHECK(wz_deck_frames(e, 0) == kLen + kIns);

    // ORDER: first half, then the inserted block, then the ORIGINAL second half.
    // Nothing was overwritten; it was pushed later.
    CHECK(std::abs(at(e, 100) - 0.1f * kStripGainL) < 0.03f);                   // before
    CHECK(std::abs(at(e, insertAt + 500) - 0.5f * kStripGainL) < 0.03f);        // the splice
    CHECK(std::abs(at(e, insertAt + kIns + 500) - 0.9f * kStripGainL) < 0.03f); // shifted, not lost

    // --- refusals -------------------------------------------------------------
    CHECK(wz_deck_insert(e, 0, 0, 1, 0, p1) == 0);        // nothing to insert
    CHECK(wz_deck_insert(e, 7, 0, 1, kIns, p1) == 0);     // empty deck: that is a LOAD
    CHECK(wz_deck_insert(nullptr, 0, 0, 1, kIns, p1) == 0);

    // Past the end clamps to the end rather than leaving a hole.
    const uint64_t before = wz_deck_frames(e, 0);
    CHECK(wz_deck_insert(e, 0, before + 999999, 1, kIns, p1) == 1);
    CHECK(wz_deck_frames(e, 0) == before + kIns);

    wz_engine_destroy(e);
    std::printf("deck_insert_test OK\n");
    return 0;
}
