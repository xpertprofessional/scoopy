// Tape playback core (SL-ABI-V3 §5): load, sample-exact loop wrap, one-shot
// cutoff, retrigger, stop, and the boundary behaviour of the C surface.
// Ported from wizard's deck_test.
//
// Tapes sum into main L/R at unity until the strip channel exists, so with a
// silent core scene main L carries the tape 1:1 — every assertion below is on
// exact sample values, not tolerances.
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
constexpr uint64_t kLen = 256; // buffer: frame N holds value N
} // namespace

int main() {
    // Tape and grid-deck index spaces are independent — that is the whole reason
    // this surface is sl_tape_* and not sl_deck_*.
    CHECK(sl_tape_count() == 8);
    CHECK(sl_deck_count() == 3);

    sl_engine* e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    // This fixture drives synthetic signal far above full scale so every sample
    // identifies its own frame. The watchdog would (correctly) limit that, so
    // disable it and measure the path under test rather than the safety net.
    sl_watchdog_set_enabled(e, 0);

    // A tape is heard through its CHANNEL — it has no level of its own, exactly
    // as a tape machine has no fader of its own. Bind them 1:1 at unity so this
    // fixture drives the real signal path; every bit-exact assertion below then
    // doubles as proof that a channel parked at unity is transparent.
    for (uint32_t t = 0; t < sl_channel_count(); ++t)
        CHECK(sl_channel_set_source(e, t, 1 /* tape */, t) == 1);

    // Every entry point is null-safe: the ABI is a boundary, and a boundary that
    // segfaults on a null handle is not one.
    CHECK(sl_tape_load(nullptr, 0, 1, 1, nullptr, kRate) == 0);
    CHECK(sl_tape_frames(nullptr, 0) == 0);
    CHECK(sl_tape_playhead(nullptr, 0) == 0.0);
    CHECK(sl_tape_state(nullptr, 0) == 0);
    CHECK(sl_tape_rate(nullptr, 0) == 0.0);
    CHECK(sl_tape_record_stop(nullptr, 0) == 0);
    CHECK(sl_tape_set_record_source(nullptr, 0, 0, 0, -1) == 0);
    sl_tape_trigger(nullptr, 0, 0);
    sl_tape_seek(nullptr, 0, 0);
    sl_tape_scrub_begin(nullptr, 0);
    sl_tape_record_service(nullptr);
    CHECK(sl_engine_time_samples(nullptr) == 0);

    std::vector<float> ramp(kLen);
    for (size_t i = 0; i < kLen; ++i) ramp[i] = static_cast<float>(i);
    const float* planar[1] = {ramp.data()};

    // An out-of-range tape is refused, not clamped onto tape 0 — a mis-indexed
    // write would land in a buffer the user is listening to.
    CHECK(sl_tape_load(e, sl_tape_count(), 1, kLen, planar, kRate) == 0);
    CHECK(sl_tape_load(e, 0, 0, kLen, planar, kRate) == 0);      // no channels
    CHECK(sl_tape_load(e, 0, 1, 0, planar, kRate) == 0);         // no frames
    CHECK(sl_tape_load(e, 0, 1, kLen, nullptr, kRate) == 0);     // no data
    CHECK(sl_tape_load(e, 0, 1, kLen, planar, 0.0) == 0);        // no rate
    CHECK(sl_tape_frames(e, 0) == 0);                            // nothing was loaded

    CHECK(sl_tape_channels(e, 0) == 0); // no material, no width
    CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);
    CHECK(sl_tape_frames(e, 0) == kLen);
    CHECK(sl_tape_channels(e, 0) == 1); // the width the material arrived at
    CHECK(sl_tape_channels(nullptr, 0) == 0);
    CHECK(sl_tape_state(e, 0) == 0);   // material ARRIVES STOPPED (D-WZ-ARRIVAL-01)
    CHECK(sl_tape_rate(e, 0) == 1.0);  // default rate is unity

    std::vector<float> l(kQ), r(kQ);
    float* outs[2] = {l.data(), r.data()};
    auto render = [&] { sl_render(e, outs, 2, kQ); };

    // --- arriving stopped means silent until triggered ----------------------
    render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == 0.0f);

    // --- loop: sample-exact, and the wrap is gapless ------------------------
    sl_tape_set_loop(e, 0, 1, 0, kLen);
    sl_tape_trigger(e, 0, 0); // loop
    CHECK(sl_tape_state(e, 0) == 1);
    for (uint32_t b = 0; b < kLen / kQ; ++b) {
        render();
        for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == static_cast<float>(b * kQ + i));
    }
    render(); // wrapped back to the top, no repeated or skipped sample
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == static_cast<float>(i));

    // --- a loop REGION plays only its span ----------------------------------
    sl_tape_set_loop(e, 0, 1, 100, 132); // 32 frames
    sl_tape_trigger(e, 0, 3);            // retrigger → region entry
    render();
    for (uint32_t i = 0; i < kQ; ++i) {
        const float v = l[i];
        CHECK(v >= 100.0f && v < 132.0f); // never leaves the region
    }
    CHECK(l[0] == 100.0f);
    CHECK(l[32] == 100.0f); // exactly one lap per 32 frames

    // --- one-shot stops at the region end and goes idle ---------------------
    sl_tape_set_loop(e, 0, 1, 0, 32);
    sl_tape_trigger(e, 0, 1); // oneShot
    CHECK(sl_tape_state(e, 0) == 2);
    render();
    for (uint32_t i = 0; i < 32; ++i) CHECK(l[i] == static_cast<float>(i));
    for (uint32_t i = 32; i < kQ; ++i) CHECK(l[i] == 0.0f); // cut off mid-block, exactly
    CHECK(sl_tape_state(e, 0) == 0);                        // and it parked itself

    // --- stop is immediate --------------------------------------------------
    sl_tape_set_loop(e, 0, 1, 0, kLen);
    sl_tape_trigger(e, 0, 0);
    render();
    // Playing from the region entry again — note frame 0 of this ramp IS 0.0,
    // so "is it audible?" has to be asked of the material, not of one sample.
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == static_cast<float>(i));
    sl_tape_trigger(e, 0, 2); // stop
    render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(l[i] == 0.0f);
    CHECK(sl_tape_state(e, 0) == 0);

    // --- retrigger from idle starts a one-shot ------------------------------
    sl_tape_trigger(e, 0, 3);
    CHECK(sl_tape_state(e, 0) == 2);

    // --- waveform: min/max envelope over the buffer -------------------------
    std::vector<float> mn(8, 0.0f), mx(8, 0.0f);
    CHECK(sl_tape_waveform(e, 0, 0, 0, kLen, 8, mn.data(), mx.data()) == 8);
    CHECK(mn[0] == 0.0f);                          // first bucket starts at frame 0
    CHECK(mx[7] == static_cast<float>(kLen - 1));  // last bucket ends at the last frame
    for (uint32_t c = 1; c < 8; ++c) CHECK(mn[c] > mn[c - 1]); // a ramp climbs
    // A degenerate range means the whole buffer, not an error.
    CHECK(sl_tape_waveform(e, 0, 0, 200, 100, 8, mn.data(), mx.data()) == 8);
    CHECK(mn[0] == 0.0f && mx[7] == static_cast<float>(kLen - 1));
    CHECK(sl_tape_waveform(e, 0, 0, 0, kLen, 0, mn.data(), mx.data()) == 0);
    CHECK(sl_tape_waveform(e, 0, 0, 0, kLen, 8, nullptr, mx.data()) == 0);
    // A tape with no material has no envelope to draw.
    CHECK(sl_tape_waveform(e, 1, 0, 0, 100, 8, mn.data(), mx.data()) == 0);

    // --- tapes are independent ----------------------------------------------
    CHECK(sl_tape_load(e, 3, 1, kLen, planar, kRate) == 1);
    CHECK(sl_tape_frames(e, 3) == kLen);
    CHECK(sl_tape_frames(e, 1) == 0); // untouched neighbour

    sl_engine_destroy(e);
    std::printf("sl_tape_test OK\n");
    return 0;
}
