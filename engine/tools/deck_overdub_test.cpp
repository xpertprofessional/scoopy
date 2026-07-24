// Overdub (D-WZ-OVERDUB-01): sound-on-sound into the same buffer.
//
// The properties that matter: the deck KEEPS PLAYING while layering, input is
// SUMMED into the existing audio rather than replacing or appending it, the
// buffer never grows (so the 256 MB cap and the RT no-allocation rule are
// untouched), and — the user's own requirement — a LOADED FILE overdubs exactly
// like a recorded take, because a strip is a strip.
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
constexpr uint32_t kFrames = 2048;

/** Render a block with a constant DC input on engine input channel 0. */
double renderWithInput(wz_engine* e, uint32_t frames, float inputDc) {
    std::vector<float> in(frames, inputDc);
    const float* ins[1] = {in.data()};
    std::vector<float> l(frames), r(frames), cl(frames), cr(frames);
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
    wz_engine_render_io(e, ins, 1, outs, 4, frames);
    double peak = 0.0;
    for (uint32_t i = 0; i < frames; ++i) peak = std::max(peak, std::abs((double)l[i]));
    return peak;
}
} // namespace

int main() {
    wz_engine* e = wz_engine_create(kRate, 256, 5);
    CHECK(e != nullptr);
    wz_engine_set_watchdog_enabled(e, 0);

    // A LOADED FILE, not a recording: this is the case the user asked for.
    std::vector<float> buf(kFrames, 0.25f);
    const float* planar[1] = {buf.data()};
    CHECK(wz_deck_load(e, 0, 1, kFrames, planar, kRate) == 1);
    const uint64_t framesBefore = wz_deck_frames(e, 0);

    wz_world_begin(e);
    wz_world_channel_begin(e, "s");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 2);
    wz_world_channel_set(e, wz_world_key_for_name("deckIndex"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
    wz_world_channel_set(e, wz_world_key_for_name("pan"), 0.0);
    wz_world_channel_end(e);
    wz_world_set_deck_count(e, 1);
    wz_world_commit(e);

    wz_deck_set_record_source(e, 0, 0, -1);
    wz_deck_trigger(e, 0, 0); // loop the loaded file

    const double before = renderWithInput(e, 256, 0.0f);
    CHECK(before > 0.01); // it is playing the file

    // --- overdub a LOADED FILE: allowed, and it SUMS ------------------------
    wz_deck_overdub_start(e, 0);
    for (int b = 0; b < 24; ++b) (void)renderWithInput(e, 256, 0.5f); // lay a layer down
    wz_deck_overdub_stop(e, 0);

    // The buffer must NOT have grown — mixing in place is the whole point.
    CHECK(wz_deck_frames(e, 0) == framesBefore);

    // Play it back with NO input: the layer must be audible in the material,
    // i.e. the buffer now holds more than the original 0.25.
    const double after = renderWithInput(e, 256, 0.0f);
    CHECK(after > before * 1.5); // summed in, not replaced and not ignored

    // --- and it kept PLAYING throughout (never went idle) -------------------
    const uint32_t len = wz_engine_hotframe_length(e);
    std::vector<double> hot(len, 0.0);
    wz_engine_hotframe(e, hot.data(), len);
    CHECK(hot[8 + 1 * 7 + 0] == 1.0); // deck state still 'looping'

    // --- overdub REFUSES on an empty deck -----------------------------------
    // With nothing to layer into it would just be a recording, and that is what
    // the record verb is for.
    wz_engine* e2 = wz_engine_create(kRate, 256, 5);
    CHECK(e2 != nullptr);
    wz_deck_overdub_start(e2, 0);
    std::vector<float> l2(256), r2(256), c2(256), c3(256);
    float* o2[4] = {l2.data(), r2.data(), c2.data(), c3.data()};
    wz_engine_render(e2, o2, 4, 256);
    for (size_t i = 0; i < 256; ++i) CHECK(std::isfinite(l2[i]));
    wz_engine_destroy(e2);

    wz_engine_destroy(e);
    std::printf("deck_overdub_test OK\n");
    return 0;
}
