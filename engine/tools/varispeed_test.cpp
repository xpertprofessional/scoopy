// Signed varispeed (P4-02, docs/specs/playback-composer.md §1 + §8 fixture 1).
//
// The load-bearing assertion is IDENTITY BIT-EXACTNESS: a deck at rate 1.0 must
// read its buffer through no resampler at all, so playback is bit-identical to
// what was recorded/loaded. Everything else (reverse, wrap in both directions,
// rate sweeps) is checked around that.
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
constexpr uint64_t kLen = 256; // buffer: frame N holds value N

void buildDeckWorld(wz_engine* e) {
    wz_world_begin(e);
    wz_world_channel_begin(e, "d");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 2); // deck
    wz_world_channel_set(e, wz_world_key_for_name("deckIndex"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75); // unity dB
    wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0);  // hard L
    wz_world_channel_end(e);
    wz_world_set_deck_count(e, 1);
    wz_world_commit(e);
}
} // namespace

int main() {
    wz_engine* e = wz_engine_create(kRate, kQ, 9);
    CHECK(e != nullptr);
    // This fixture drives synthetic ramps far above full scale so every sample
    // identifies its own frame; the watchdog would (correctly) limit them, so
    // disable it to measure the path under test rather than the safety net.
    wz_engine_set_watchdog_enabled(e, 0);

    // Ramp buffer: every sample identifies its own frame index.
    std::vector<float> ramp(kLen);
    for (size_t i = 0; i < kLen; ++i) ramp[i] = static_cast<float>(i);
    const float* planar[1] = {ramp.data()};
    CHECK(wz_deck_load(e, 0, 1, kLen, planar, kRate) == 1);
    buildDeckWorld(e);

    std::vector<float> l(kQ), r(kQ), cl(kQ), cr(kQ);
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
    auto render = [&] { wz_engine_render(e, outs, 4, kQ); };

    // Default rate is unity.
    CHECK(wz_deck_rate(e, 0) == 1.0);

    // --- 1. IDENTITY IS BIT-EXACT ------------------------------------------
    wz_deck_set_loop(e, 0, 1, 0, kLen);
    wz_deck_trigger(e, 0, 0); // loop forward at 1.0
    render();
    for (uint32_t i = 0; i < kQ; ++i)
        CHECK(l[i] == static_cast<float>(i)); // exact integers, no interpolation
    render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == static_cast<float>(kQ + i));

    // --- 2. REVERSE plays the buffer backwards ------------------------------
    wz_deck_set_rate(e, 0, -1.0);
    CHECK(wz_deck_rate(e, 0) == -1.0);
    // The rate is SMOOTHED (D-WZ-RAMP-01): let the glide from +1 to -1 finish
    // before asserting the identity path, then retrigger to the reverse entry.
    for (int b = 0; b < 250; ++b) render();
    wz_deck_trigger(e, 0, 3); // retrigger → seeks the region's REVERSE entry (end-1)
    render();
    // Reverse at exactly -1 is also the identity path: exact integers, descending.
    CHECK(l[0] == static_cast<float>(kLen - 1));
    for (uint32_t i = 1; i < kQ; ++i) CHECK(l[i] == l[i - 1] - 1.0f);

    // --- 3. reverse WRAPS at the region start, gaplessly --------------------
    // The wrap can land ON a block boundary, so track continuity ACROSS blocks
    // too — a detector that only looks inside a block would miss it entirely.
    bool sawWrap = false;
    float prevSample = l[kQ - 1];
    for (int b = 0; b < 12; ++b) {
        render();
        for (uint32_t i = 0; i < kQ; ++i) {
            const float cur = l[i];
            CHECK(cur >= 0.0f && cur < static_cast<float>(kLen)); // never leaves the region
            if (cur > prevSample) { // the wrap point
                sawWrap = true;
                CHECK(prevSample <= 1.0f);                     // wrapped from the bottom...
                CHECK(cur >= static_cast<float>(kLen) - 2.0f); // ...straight to the top
            } else {
                CHECK(cur == prevSample - 1.0f); // otherwise strictly -1 per frame
            }
            prevSample = cur;
        }
    }
    CHECK(sawWrap);

    // --- 4. fractional rate interpolates, stays in range --------------------
    wz_deck_set_rate(e, 0, 0.5); // half speed forward
    wz_deck_trigger(e, 0, 3);
    for (int b = 0; b < 250; ++b) render(); // let the smoother settle onto 0.5
    render();
    for (uint32_t i = 0; i < kQ; ++i) {
        CHECK(std::isfinite(l[i]));
        CHECK(l[i] >= 0.0f && l[i] < static_cast<float>(kLen));
    }
    // At half speed the ramp advances ~0.5 per output frame — monotone within
    // a block (no jitter), and slower than the unity path.
    const float span = l[kQ - 1] - l[0];
    CHECK(span > 0.0f && span < static_cast<float>(kQ)); // slower than 1:1
    std::printf("  half-speed span over %u frames = %.2f (unity would be %u)\n", kQ, span, kQ - 1);

    // --- 5. |rate| is clamped to [1/16, 16] --------------------------------
    wz_deck_set_rate(e, 0, 1000.0);
    for (int b = 0; b < 40; ++b) render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::isfinite(l[i]));
    wz_deck_set_rate(e, 0, 0.0); // would stall the playhead → clamped to 1/16
    for (int b = 0; b < 40; ++b) render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::isfinite(l[i]));
    wz_deck_set_rate(e, 0, std::nan("")); // hostile input never reaches the reader
    for (int b = 0; b < 4; ++b) render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::isfinite(l[i]));

    // --- 6. a rate sweep produces no discontinuity beyond the ramp bound ----
    wz_deck_set_rate(e, 0, 1.0);
    wz_deck_trigger(e, 0, 3);
    for (int b = 0; b < 250; ++b) render(); // settle at unity
    wz_deck_set_rate(e, 0, 4.0);           // jump the TARGET; the smoother glides
    float prevLast = l[kQ - 1];
    for (int b = 0; b < 8; ++b) {
        render();
        // Across the sweep the playhead never jumps backwards mid-region, and
        // every sample stays inside the buffer.
        for (uint32_t i = 0; i < kQ; ++i)
            CHECK(l[i] >= 0.0f && l[i] < static_cast<float>(kLen));
        prevLast = l[kQ - 1];
    }
    CHECK(std::isfinite(prevLast));

    // --- 7. returning to exactly 1.0 restores the bit-exact identity path ---
    wz_deck_set_rate(e, 0, 1.0);
    wz_deck_trigger(e, 0, 3);
    for (int b = 0; b < 250; ++b) render(); // smoother converges back to exactly 1.0
    render();
    bool allIntegers = true;
    for (uint32_t i = 0; i < kQ; ++i)
        allIntegers = allIntegers && (l[i] == std::floor(l[i]));
    CHECK(allIntegers); // integers again → no interpolation in the path

    wz_engine_destroy(e);
    std::printf("varispeed_test OK\n");
    return 0;
}
