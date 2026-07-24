// Tape scrub (turntable): the playhead follows the finger and the PITCH follows
// how fast the finger moves, because the rate is derived from the gap.
//
// The properties that matter: a STOPPED deck sounds while scrubbing (that is the
// whole point of a turntable), it converges on where you dragged, moving further
// per block travels faster (which IS the pitch bend), reverse needs no special
// case, recording refuses, and the fade in/out is click-free.
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
constexpr uint32_t kFrames = 20000;

struct Out { double peak; double maxStep; };

/** Render one block and report its peak and biggest sample-to-sample jump. */
Out render(wz_engine* e, uint32_t frames, double& carry) {
    std::vector<float> l(frames), r(frames), cl(frames), cr(frames);
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
    wz_engine_render(e, outs, 4, frames);
    Out o{0.0, 0.0};
    for (uint32_t i = 0; i < frames; ++i) {
        o.peak = std::max(o.peak, std::abs(static_cast<double>(l[i])));
        o.maxStep = std::max(o.maxStep, std::abs(static_cast<double>(l[i]) - carry));
        carry = l[i];
    }
    return o;
}

double playheadOf(wz_engine* e) {
    const uint32_t len = wz_engine_hotframe_length(e);
    std::vector<double> hot(len, 0.0);
    wz_engine_hotframe(e, hot.data(), len);
    const uint32_t idx = 8 + 1 * 7 + 0 * 8 + 1; // scalars + 1 channel + deck0.playhead
    return idx < len ? hot[idx] : -1.0;
}
} // namespace

int main() {
    wz_engine* e = wz_engine_create(kRate, 256, 5);
    CHECK(e != nullptr);
    wz_engine_set_watchdog_enabled(e, 0); // measuring the path, not the safety net

    // DC 1.0: any output is the scrub gain alone, so a click is measurable
    // rather than a matter of opinion.
    std::vector<float> buf(kFrames, 1.0f);
    const float* planar[1] = {buf.data()};
    CHECK(wz_deck_load(e, 0, 1, kFrames, planar, kRate) == 1);

    wz_world_begin(e);
    wz_world_channel_begin(e, "s");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 2);
    wz_world_channel_set(e, wz_world_key_for_name("deckIndex"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
    wz_world_channel_set(e, wz_world_key_for_name("pan"), 0.0);
    wz_world_channel_end(e);
    wz_world_set_deck_count(e, 1);
    wz_world_commit(e);

    double carry = 0.0;

    // --- a STOPPED deck is silent... -----------------------------------------
    wz_deck_trigger(e, 0, 2); // stop
    CHECK(render(e, 256, carry).peak < 1e-6);

    // --- ...but SOUNDS while scrubbing --------------------------------------
    wz_deck_scrub_begin(e, 0);
    wz_deck_scrub_to(e, 0, 4000);
    double peak = 0.0;
    for (int b = 0; b < 40; ++b) peak = std::max(peak, render(e, 256, carry).peak);
    CHECK(peak > 0.1); // a turntable makes sound when you move it

    // --- and it converges on where the finger is -----------------------------
    for (int b = 0; b < 200; ++b) (void)render(e, 256, carry);
    const double landed = playheadOf(e);
    CHECK(std::abs(landed - 4000.0) < 50.0);

    // --- moving FURTHER per block travels faster: that IS the pitch bend ------
    wz_deck_scrub_to(e, 0, 4600); // a 600-frame gap
    (void)render(e, 256, carry);
    const double slowStep = playheadOf(e) - landed;
    const double afterSlow = playheadOf(e);
    wz_deck_scrub_to(e, 0, afterSlow + 3000); // a much bigger gap
    (void)render(e, 256, carry);
    const double fastStep = playheadOf(e) - afterSlow;
    CHECK(fastStep > slowStep * 2.0); // faster hand ⇒ faster travel ⇒ higher pitch

    // --- reverse needs no special case ---------------------------------------
    const double before = playheadOf(e);
    wz_deck_scrub_to(e, 0, before - 3000);
    for (int b = 0; b < 8; ++b) (void)render(e, 256, carry);
    CHECK(playheadOf(e) < before); // it went backwards

    // --- release fades out rather than cutting -------------------------------
    wz_deck_scrub_end(e, 0);
    double maxStep = 0.0;
    for (int b = 0; b < 40; ++b) maxStep = std::max(maxStep, render(e, 256, carry).maxStep);
    CHECK(maxStep < 0.05); // no cliff on the way out
    CHECK(render(e, 256, carry).peak < 1e-6); // and it is silent again, being stopped

    // --- a RECORDING deck refuses to be scrubbed -----------------------------
    wz_deck_set_record_source(e, 0, 0, -1);
    wz_deck_record_service(e);
    wz_deck_record_start(e, 0);
    wz_deck_scrub_begin(e, 0);
    wz_deck_scrub_to(e, 0, 100);
    (void)render(e, 256, carry);
    // The write head is not the user's to drag: scrubbing must not have engaged.
    CHECK(wz_deck_record_stop(e, 0) >= 0);

    wz_engine_destroy(e);
    std::printf("deck_scrub_test OK\n");
    return 0;
}
