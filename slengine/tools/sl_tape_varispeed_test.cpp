// Signed varispeed. Ported from wizard's varispeed_test.
//
// The load-bearing assertion is IDENTITY BIT-EXACTNESS: a tape at rate 1.0 must
// read its buffer through no resampler at all, so playback is bit-identical to
// what was recorded or loaded. Everything else (reverse, wrap in both
// directions, rate sweeps, hostile inputs) is checked around that.
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
constexpr uint64_t kLen = 256; // buffer: frame N holds value N
} // namespace

int main() {
    sl_engine* e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    sl_watchdog_set_enabled(e, 0); // measure the path under test, not the safety net
    // A tape is heard through its channel; bind 1:1 at unity (see sl_tape_test).
    // The identity assertions below therefore also pin that a channel at unity
    // multiplies by EXACTLY 1.0 — the reason its ramp snaps rather than only
    // approaching its target.
    for (uint32_t t = 0; t < sl_channel_count(); ++t)
        CHECK(sl_channel_set_source(e, t, 1 /* tape */, t) == 1);

    // Ramp buffer: every sample identifies its own frame index.
    std::vector<float> ramp(kLen);
    for (size_t i = 0; i < kLen; ++i) ramp[i] = static_cast<float>(i);
    const float* planar[1] = {ramp.data()};
    CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);

    std::vector<float> l(kQ), r(kQ);
    float* outs[2] = {l.data(), r.data()};
    auto render = [&] { sl_render(e, outs, 2, kQ); };

    CHECK(sl_tape_rate(e, 0) == 1.0); // default rate is unity

    // --- 1. IDENTITY IS BIT-EXACT ------------------------------------------
    sl_tape_set_loop(e, 0, 1, 0, kLen);
    sl_tape_trigger(e, 0, 0); // loop forward at 1.0
    render();
    for (uint32_t i = 0; i < kQ; ++i)
        CHECK(l[i] == static_cast<float>(i)); // exact integers, no interpolation
    render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == static_cast<float>(kQ + i));

    // --- 2. REVERSE plays the buffer backwards ------------------------------
    sl_tape_set_rate(e, 0, -1.0);
    CHECK(sl_tape_rate(e, 0) == -1.0);
    // The rate is SMOOTHED (D-WZ-RAMP-01): let the glide from +1 to -1 finish
    // before asserting the identity path, then retrigger to the reverse entry.
    for (int b = 0; b < 250; ++b) render();
    sl_tape_trigger(e, 0, 3); // retrigger → seeks the region's REVERSE entry (end-1)
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
            if (cur > prevSample) {                              // the wrap point
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
    sl_tape_set_rate(e, 0, 0.5); // half speed forward
    sl_tape_trigger(e, 0, 3);
    for (int b = 0; b < 250; ++b) render(); // let the smoother settle onto 0.5
    render();
    for (uint32_t i = 0; i < kQ; ++i) {
        CHECK(std::isfinite(l[i]));
        CHECK(l[i] >= 0.0f && l[i] < static_cast<float>(kLen));
    }
    // At half speed the ramp advances ~0.5 per output frame — slower than 1:1.
    const float span = l[kQ - 1] - l[0];
    CHECK(span > 0.0f && span < static_cast<float>(kQ));

    // --- 5. |rate| is clamped to [1/16, 16], hostile input never reaches the reader
    sl_tape_set_rate(e, 0, 1000.0);
    for (int b = 0; b < 40; ++b) render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::isfinite(l[i]));
    sl_tape_set_rate(e, 0, 0.0); // would stall the playhead → clamped to 1/16
    for (int b = 0; b < 40; ++b) render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::isfinite(l[i]));
    sl_tape_set_rate(e, 0, std::nan(""));
    for (int b = 0; b < 4; ++b) render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::isfinite(l[i]));

    // --- 6. a rate sweep stays inside the buffer throughout -----------------
    sl_tape_set_rate(e, 0, 1.0);
    sl_tape_trigger(e, 0, 3);
    for (int b = 0; b < 250; ++b) render(); // settle at unity
    sl_tape_set_rate(e, 0, 4.0);            // jump the TARGET; the smoother glides
    for (int b = 0; b < 8; ++b) {
        render();
        for (uint32_t i = 0; i < kQ; ++i)
            CHECK(l[i] >= 0.0f && l[i] < static_cast<float>(kLen));
    }

    // --- 7. returning to exactly 1.0 restores the bit-exact identity path ---
    // This is what the 1 ppm snap buys: a one-pole only APPROACHES its target,
    // so without it "unity" would interpolate forever and the identity path
    // would be unreachable by dragging a slider.
    sl_tape_set_rate(e, 0, 1.0);
    sl_tape_trigger(e, 0, 3);
    for (int b = 0; b < 250; ++b) render();
    render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == std::floor(l[i])); // integers again

    sl_engine_destroy(e);
    std::printf("sl_tape_varispeed_test OK\n");
    return 0;
}
