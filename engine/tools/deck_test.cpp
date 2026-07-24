// Deck v0 (P1-07, playback only): load, loop-region wrap (sample-exact),
// oneShot completion, retrigger, stop, seqlock loop publish, hotframe block.
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

// A unity strip would scale by cos(π/4); use a hard-left pan so main L carries
// the deck signal at exactly fader gain × cos(0) = 1.0 — sample-exact checks.
void buildDeckWorld(wz_engine* e) {
    wz_world_begin(e);
    wz_world_channel_begin(e, "d0");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 2);
    wz_world_channel_set(e, wz_world_key_for_name("deckIndex"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75); // unity dB
    wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0);  // hard L
    wz_world_channel_end(e);
    wz_world_set_deck_count(e, 1);
    wz_world_commit(e);
}

} // namespace

int main() {
    wz_engine* e = wz_engine_create(48000.0, 64, 5);
    CHECK(e != nullptr);
    // This fixture drives synthetic ramps far above full scale so every sample
    // identifies its own frame; the watchdog would (correctly) limit them, so
    // disable it to measure the path under test rather than the safety net.
    wz_engine_set_watchdog_enabled(e, 0);

    // Ramp buffer 0..99 so every output sample identifies its source index.
    std::vector<float> ramp(100);
    for (size_t i = 0; i < 100; ++i) ramp[i] = static_cast<float>(i);
    const float* planar[1] = {ramp.data()};

    // Bad args rejected.
    CHECK(wz_deck_load(e, 8, 1, 100, planar, 48000.0) == 0);  // deck out of range
    CHECK(wz_deck_load(e, 0, 0, 100, planar, 48000.0) == 0);  // zero channels
    CHECK(wz_deck_load(e, 0, 1, 0, planar, 48000.0) == 0);    // zero frames
    CHECK(wz_deck_load(e, 0, 1, 100, nullptr, 48000.0) == 0); // null data

    CHECK(wz_deck_load(e, 0, 1, 100, planar, 48000.0) == 1);
    CHECK(wz_deck_frames(e, 0) == 100);
    buildDeckWorld(e);

    std::vector<float> l(64), r(64), cl(64), cr(64);
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
    auto renderBlock = [&] { wz_engine_render(e, outs, 4, 64); };
    auto settle = [&](int blocks) { for (int i = 0; i < blocks; ++i) renderBlock(); };

    // Idle deck → silence.
    renderBlock();
    for (size_t i = 0; i < 64; ++i) CHECK(l[i] == 0.0f);

    // Loop the region [10, 20): after the smoothers settle the main-L output
    // must be EXACTLY the 10..19 ramp cycle — the gapless wrap is sample-exact.
    wz_deck_set_loop(e, 0, 1, 10, 20);
    wz_deck_trigger(e, 0, 0); // loop
    settle(100);              // >> 10 ms of smoothing at 48k
    renderBlock();
    // Whatever phase the cycle is in, consecutive samples must follow the
    // 10..19 wrap pattern with no repeated or skipped sample at the seam.
    for (size_t i = 1; i < 64; ++i) {
        const float prev = l[i - 1], cur = l[i];
        CHECK(cur == (prev >= 19.0f ? 10.0f : prev + 1.0f));
        CHECK(cur >= 10.0f && cur <= 19.0f);
    }

    // Stop → silence again (after the mute-free path just goes quiet: deck idle).
    wz_deck_trigger(e, 0, 2);
    settle(2);
    renderBlock();
    for (size_t i = 0; i < 64; ++i) CHECK(l[i] == 0.0f);

    // oneShot with the loop disabled plays the whole buffer once, then idles.
    wz_deck_set_loop(e, 0, 0, 0, 0);
    wz_deck_trigger(e, 0, 1); // oneShot: 100 frames < 2 blocks
    renderBlock();            // frames 0..63
    CHECK(l[0] == 0.0f);      // ramp[0] is literally 0
    CHECK(l[63] == 63.0f);
    renderBlock(); // frames 64..99, then silence
    CHECK(l[0] == 64.0f);
    CHECK(l[35] == 99.0f);
    CHECK(l[36] == 0.0f); // finished mid-block: exact cutoff, no wrap
    std::vector<double> hot(8 + 7 + 8, 0.0); // 1 channel block (7) + 1 deck block (8)
    CHECK(wz_engine_hotframe(e, hot.data(), 8 + 7 + 8) == 8 + 7 + 8);
    CHECK(hot[8 + 7 + 0] == 0.0); // deck state back to idle

    // Retrigger from idle starts a oneShot from the region start.
    wz_deck_trigger(e, 0, 3);
    renderBlock();
    CHECK(l[1] == 1.0f); // playing again from the top

    // Seqlock: publishing a new loop mid-play is picked up next block, never torn.
    wz_deck_set_loop(e, 0, 1, 90, 95);
    wz_deck_trigger(e, 0, 0);
    settle(4);
    renderBlock();
    for (size_t i = 0; i < 64; ++i) CHECK(l[i] >= 90.0f && l[i] <= 94.0f);

    wz_engine_destroy(e);
    std::printf("deck_test OK\n");
    return 0;
}
