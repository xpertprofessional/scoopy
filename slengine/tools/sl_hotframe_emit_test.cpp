// The HotFrame emitter: engine telemetry -> the 284-slot frame, at the indices
// scoopy's UI reads. Headless (no WebView, no device).
//
// The layout header is covered by sl_hotframe_test; this covers the EMITTER —
// that it fills the right slots from real engine state: a monotonic counter, a
// refused-short buffer, and an output-peak slot that lights when a committed
// world is actually rendering sound.
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
// The load-bearing indices, independently restated (NOT included from the
// generated header): if the emitter and the schema ever disagree, this test
// must fail rather than move in lockstep with a regenerated header. These are
// the positions scoopy's HotFrameLayout fixes.
constexpr int kFrameCounter = 0;
constexpr int kOutputPeakL = 5;
constexpr int kOutputPeakR = 6;
constexpr int kCallbackLoad = 9;
constexpr int kLength = 284;
} // namespace

int main() {
    CHECK((int) sl_hotframe_length() == kLength);

    sl_engine* e = sl_engine_create(48000.0, 512, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);

    std::vector<double> frame(kLength, -1.0);

    // Refuse-short: a buffer under length writes NOTHING and returns 0 — never a
    // partial frame the UI would misread.
    CHECK(sl_hotframe(e, frame.data(), kLength - 1) == 0);
    CHECK(frame[0] == -1.0); // untouched
    CHECK(sl_hotframe(nullptr, frame.data(), kLength) == 0);
    CHECK(sl_hotframe(e, nullptr, kLength) == 0);

    // A full emit writes the whole frame and returns its length.
    CHECK(sl_hotframe(e, frame.data(), (uint32_t) frame.size()) == (uint32_t) kLength);

    // frameCounter is monotonic across emits — the UI detects dropped frames
    // from its gaps, so a stuck counter is a real defect.
    const double c1 = frame[kFrameCounter];
    sl_hotframe(e, frame.data(), (uint32_t) frame.size());
    const double c2 = frame[kFrameCounter];
    sl_hotframe(e, frame.data(), (uint32_t) frame.size());
    const double c3 = frame[kFrameCounter];
    CHECK(c2 == c1 + 1.0 && c3 == c2 + 1.0);

    // Silent engine: the output-peak slots are 0 (nothing rendered since the
    // last emit), and every slot is finite (a NaN would poison the UI).
    for (int i = 0; i < kLength; ++i) CHECK(std::isfinite(frame[i]));
    // Drain any residual, then confirm silence reads as 0 on the meter.
    sl_hotframe(e, frame.data(), (uint32_t) frame.size());
    CHECK(frame[kOutputPeakL] == 0.0 && frame[kOutputPeakR] == 0.0);
    CHECK(frame[kCallbackLoad] >= 0.0);

    // Now make the engine SOUND and prove the meter lights. Register a tone,
    // commit a world that triggers it, render, then emit: the output-peak slots
    // must be non-zero, and L==R (the core exposes one main-bus peak, mirrored).
    {
        std::vector<float> tone(4800);
        for (size_t i = 0; i < tone.size(); ++i)
            tone[i] = 0.5f * std::sin(2.0 * 3.14159265358979 * 220.0 * (double) i / 48000.0);
        CHECK(sl_engine_register_sample(e, "tone", tone.data(), nullptr,
                                        (uint32_t) tone.size(), 48000.0) == 1);
        CHECK(sl_snapshot_begin(e, 0, 120.0, 1, 0) == 1);
        const uint8_t steps[8] = {1, 1, 1, 1, 1, 1, 1, 1};
        CHECK(sl_snapshot_track_begin(e, "tone", steps, 8) == 1);
        sl_snapshot_track_set(e, sl_track_param_id("SL_T_VOLUME"), 1.0);
        sl_snapshot_track_end(e);
        CHECK(sl_snapshot_commit(e) > 0);

        std::vector<float> l(512, 0.0f), r(512, 0.0f);
        float* buses[2] = {l.data(), r.data()};
        for (int b = 0; b < 100; ++b) {
            std::fill(l.begin(), l.end(), 0.0f);
            std::fill(r.begin(), r.end(), 0.0f);
            sl_render(e, buses, 2, 512);
        }
        sl_hotframe(e, frame.data(), (uint32_t) frame.size());
        CHECK(frame[kOutputPeakL] > 0.0001);
        CHECK(frame[kOutputPeakL] == frame[kOutputPeakR]); // mirrored mono peak
    }

    sl_engine_stop(e);
    sl_engine_destroy(e);
    std::printf("sl_hotframe_emit_test OK\n");
    return 0;
}
