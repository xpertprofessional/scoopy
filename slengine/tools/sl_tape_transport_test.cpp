// Seek and turntable SCRUB — the two distinct gestures on one playhead.
// Ported from wizard's deck_seek_test + deck_scrub_test.
//
// seek  = jump at unchanged pitch, applied at the top of the next block.
// scrub = drag; the playhead follows the finger and the PITCH follows how fast
//         the finger moves, because the rate is DERIVED FROM THE GAP.
//
// The properties that matter: a STOPPED tape sounds while scrubbing (that is
// the whole point of a turntable), it converges on where you dragged, moving
// further per block travels faster (which IS the pitch bend), reverse needs no
// special case, recording refuses, and the fade in/out is click-free.
#include "sl_engine.h"

#include <algorithm>
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
constexpr uint32_t kQ = 256;
constexpr uint32_t kFrames = 20000;

struct Out { double peak; double maxStep; };
} // namespace

int main() {
    sl_engine* e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    // A tape is heard through its channel; bind 1:1 at unity (see sl_tape_test).
    for (uint32_t t = 0; t < sl_channel_count(); ++t)
        CHECK(sl_channel_set_source(e, t, 1 /* tape */, t) == 1);

    std::vector<float> l(kQ), r(kQ);
    float* outs[2] = {l.data(), r.data()};
    double carry = 0.0;
    // Render one block and report its peak and biggest sample-to-sample jump.
    auto render = [&]() -> Out {
        sl_render(e, outs, 2, kQ);
        Out o{0.0, 0.0};
        for (uint32_t i = 0; i < kQ; ++i) {
            o.peak = std::max(o.peak, std::abs(static_cast<double>(l[i])));
            o.maxStep = std::max(o.maxStep, std::abs(static_cast<double>(l[i]) - carry));
            carry = l[i];
        }
        return o;
    };

    // DC 1.0: any output is the scrub gain alone, so a click is measurable
    // rather than a matter of opinion.
    std::vector<float> buf(kFrames, 1.0f);
    const float* planar[1] = {buf.data()};
    CHECK(sl_tape_load(e, 0, 1, kFrames, planar, kRate) == 1);

    // --- SEEK ---------------------------------------------------------------
    sl_tape_set_loop(e, 0, 1, 0, kFrames);
    sl_tape_trigger(e, 0, 0); // loop
    sl_tape_seek(e, 0, 5000);
    (void)render();
    // Lands where asked (the block advanced it by kQ from the target).
    CHECK(sl_tape_playhead(e, 0) >= 5000.0);
    CHECK(sl_tape_playhead(e, 0) < 5000.0 + kQ + 1);

    // A seek on a STOPPED tape still moves the visible head — otherwise
    // dragging a stopped player does nothing at all.
    sl_tape_trigger(e, 0, 2); // stop
    (void)render();
    sl_tape_seek(e, 0, 9000);
    (void)render();
    CHECK(std::abs(sl_tape_playhead(e, 0) - 9000.0) < 1.0);

    // Out of range clamps into the buffer rather than reading past it.
    sl_tape_seek(e, 0, kFrames + 100000);
    (void)render();
    CHECK(sl_tape_playhead(e, 0) < static_cast<double>(kFrames));

    // The seek ARMED A CUE (D-WZ-SCRUBCUE-01): the next trigger fires from
    // there, not from the region entry.
    sl_tape_seek(e, 0, 7000);
    (void)render();
    sl_tape_trigger(e, 0, 0);
    (void)render();
    CHECK(sl_tape_playhead(e, 0) > 7000.0);
    CHECK(sl_tape_playhead(e, 0) < 7000.0 + 2 * kQ);
    // ...and the cue is a ONE-SHOT: the wrap after it returns to the region
    // entry rather than to the cue.
    sl_tape_set_loop(e, 0, 1, 0, 1000);
    sl_tape_trigger(e, 0, 3);
    for (int b = 0; b < 12; ++b) (void)render();
    CHECK(sl_tape_playhead(e, 0) < 1000.0);

    // --- SCRUB --------------------------------------------------------------
    sl_tape_set_loop(e, 0, 1, 0, kFrames);
    sl_tape_trigger(e, 0, 2); // stopped...
    (void)render();
    CHECK(render().peak < 1e-6); // ...and therefore silent

    sl_tape_scrub_begin(e, 0);
    sl_tape_scrub_to(e, 0, 4000);
    double peak = 0.0;
    for (int b = 0; b < 40; ++b) peak = std::max(peak, render().peak);
    CHECK(peak > 0.1); // a turntable makes sound when you move it

    for (int b = 0; b < 200; ++b) (void)render();
    const double landed = sl_tape_playhead(e, 0);
    CHECK(std::abs(landed - 4000.0) < 50.0); // converges on where the finger is

    // Moving FURTHER per block travels faster: that IS the pitch bend.
    sl_tape_scrub_to(e, 0, 4600); // a 600-frame gap
    (void)render();
    const double slowStep = sl_tape_playhead(e, 0) - landed;
    const double afterSlow = sl_tape_playhead(e, 0);
    sl_tape_scrub_to(e, 0, afterSlow + 3000); // a much bigger gap
    (void)render();
    const double fastStep = sl_tape_playhead(e, 0) - afterSlow;
    CHECK(fastStep > slowStep * 2.0);

    // Reverse needs no special case — a negative derived rate, same reader.
    const double before = sl_tape_playhead(e, 0);
    sl_tape_scrub_to(e, 0, before - 3000);
    for (int b = 0; b < 8; ++b) (void)render();
    CHECK(sl_tape_playhead(e, 0) < before);

    // Release fades out rather than cutting.
    sl_tape_scrub_end(e, 0);
    double maxStep = 0.0;
    for (int b = 0; b < 40; ++b) maxStep = std::max(maxStep, render().maxStep);
    CHECK(maxStep < 0.05);       // no cliff on the way out
    CHECK(render().peak < 1e-6); // and it is silent again, being stopped

    // A RECORDING tape refuses to be scrubbed: the write head is not the
    // user's to drag.
    CHECK(sl_tape_set_record_source(e, 0, 0, 0, -1) == 1);
    sl_tape_record_service(e);
    sl_tape_record_start(e, 0);
    (void)render(); // render picks up the arm → state recording
    CHECK(sl_tape_state(e, 0) == 3);
    const double recHead = sl_tape_playhead(e, 0);
    sl_tape_scrub_begin(e, 0);
    sl_tape_scrub_to(e, 0, 100);
    (void)render();
    CHECK(sl_tape_state(e, 0) == 3);                       // still recording
    CHECK(std::abs(sl_tape_playhead(e, 0) - recHead) < 1.0); // head did not move
    sl_tape_record_stop(e, 0);

    sl_engine_destroy(e);
    std::printf("sl_tape_transport_test OK\n");
    return 0;
}
