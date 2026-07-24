// Scrub (wz_deck_seek): the playhead goes where the user drags it.
//
// Turntable-style scrubbing is a CONTROL-thread post consumed by the render
// thread, so the properties that matter are: it lands where asked, it survives
// the loop-region clamp (you must be able to scrub OUTSIDE the region to find
// the part you want to loop), and an out-of-range drag is clamped rather than
// reading off the end of the buffer.
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
constexpr uint32_t kFrames = 4000;

/** Playhead as the UI sees it: the deck block's 'playhead' field. */
double playheadOf(wz_engine* e, uint32_t channelCount, uint32_t deck) {
    const uint32_t len = wz_engine_hotframe_length(e);
    std::vector<double> hot(len, 0.0);
    wz_engine_hotframe(e, hot.data(), len);
    // scalars + channels*7 + deck*8 + 1 (playhead is field index 1)
    const uint32_t idx = 8 + channelCount * 7 + deck * 8 + 1;
    return idx < len ? hot[idx] : -1.0;
}

void render(wz_engine* e, uint32_t frames) {
    std::vector<float> l(frames), r(frames), cl(frames), cr(frames);
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
    wz_engine_render(e, outs, 4, frames);
}
} // namespace

int main() {
    wz_engine* e = wz_engine_create(kRate, 256, 5);
    CHECK(e != nullptr);

    // A ramp buffer so a position is identifiable, loaded as one deck.
    std::vector<float> buf(kFrames);
    for (uint32_t i = 0; i < kFrames; ++i) buf[i] = static_cast<float>(i) / kFrames;
    const float* planar[1] = {buf.data()};
    CHECK(wz_deck_load(e, 0, 1, kFrames, planar, kRate) == 1);

    wz_world_begin(e);
    wz_world_channel_begin(e, "s");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 2);
    wz_world_channel_set(e, wz_world_key_for_name("deckIndex"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
    wz_world_channel_end(e);
    wz_world_set_deck_count(e, 1);
    wz_world_commit(e);
    wz_deck_trigger(e, 0, 0); // loop

    render(e, 256);
    const double afterStart = playheadOf(e, 1, 0);
    CHECK(afterStart >= 0.0);

    // --- a scrub lands where it was asked ------------------------------------
    wz_deck_seek(e, 0, 3000);
    render(e, 64);
    const double scrubbed = playheadOf(e, 1, 0);
    // It advanced from 3000 by the block, but must be in that neighbourhood —
    // decisively past where free-running playback could have reached.
    CHECK(scrubbed >= 3000.0 && scrubbed < 3000.0 + 256.0);

    // --- with a loop region, a scrub FOLDS BACK into it ----------------------
    // A loop is a loop: seeking past an active region does not escape it, the
    // wrap pulls the playhead in on the same block. Documented here because the
    // first draft of this feature claimed the opposite, and the fixture caught
    // it: seeking 3500 with region [0,1000) lands at 3500 % 1000 = 500, then
    // advances by the block.
    wz_deck_set_loop(e, 0, 1, 0, 1000);
    render(e, 64);
    wz_deck_seek(e, 0, 3500);
    render(e, 64);
    const double folded = playheadOf(e, 1, 0);
    CHECK(folded >= 0.0 && folded < 1000.0 + 256.0);

    // --- an out-of-range drag is CLAMPED, never read off the end -------------
    wz_deck_seek(e, 0, kFrames + 100000);
    render(e, 64);
    const double clamped = playheadOf(e, 1, 0);
    CHECK(clamped >= 0.0 && clamped <= static_cast<double>(kFrames));

    // --- and the engine is still producing finite audio afterwards -----------
    std::vector<float> l(256), r(256), cl(256), cr(256);
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
    wz_engine_render(e, outs, 4, 256);
    for (size_t i = 0; i < 256; ++i) CHECK(std::isfinite(l[i]) && std::isfinite(r[i]));

    wz_engine_destroy(e);
    std::printf("deck_seek_test OK\n");
    return 0;
}
