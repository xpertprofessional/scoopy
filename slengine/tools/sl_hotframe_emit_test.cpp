// The HotFrame emitter: engine telemetry -> the 326-slot frame, at the indices
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
// The plane's block (merge P2 step 4), likewise restated by hand.
constexpr int kChanPeakL0 = 268;
constexpr int kChanPeakR0 = 276;
constexpr int kTapePlayhead0 = 284;
constexpr int kTapeState0 = 292;
constexpr int kTapeCap0 = 300;
constexpr int kWatchdogEngaged = 308;
constexpr int kWatchdogGain = 309;
constexpr int kMonitorMask = 310;
constexpr int kLength = 327;
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

    // --- the plane's block (merge P2 step 4) --------------------------------
    // A tape on a channel, so there is something real to measure. This is the
    // strip meter's whole data path, end to end: channel output → peak → frame.
    {
        std::vector<float> dc(1024, 0.5f);
        const float* planar[1] = {dc.data()};
        CHECK(sl_tape_load(e, 0, 1, 1024, planar, 48000.0) == 1);
        sl_tape_set_loop(e, 0, 1, 0, 1024);
        CHECK(sl_channel_set_source(e, 0, 1 /* tape */, 0) == 1);

        // Idle first: the tape is loaded but not triggered.
        std::vector<float> l(512, 0.0f), r(512, 0.0f);
        float* buses[2] = {l.data(), r.data()};
        sl_render(e, buses, 2, 512);
        sl_hotframe(e, frame.data(), (uint32_t) frame.size());
        CHECK(frame[kTapeState0] == 0.0); // idle
        CHECK(frame[kTapeCap0] == 0.0);   // no cap hit

        // Now play it. The channel's meter lights and the tape reports looping.
        sl_tape_trigger(e, 0, 0 /* loop */);
        for (int b = 0; b < 20; ++b) sl_render(e, buses, 2, 512);
        sl_hotframe(e, frame.data(), (uint32_t) frame.size());
        CHECK(frame[kTapeState0] == 1.0);      // looping
        CHECK(frame[kChanPeakL0] > 0.4);       // ~0.5 through a unity channel
        CHECK(frame[kChanPeakR0] > 0.4);
        CHECK(frame[kTapePlayhead0] >= 0.0);

        // CONSUME-AND-RESET, at the frame level: emitting twice with no render
        // in between must leave the meter at 0. If the emitter did not consume,
        // every strip meter would latch at its loudest moment forever.
        sl_hotframe(e, frame.data(), (uint32_t) frame.size());
        CHECK(frame[kChanPeakL0] == 0.0);
        CHECK(frame[kChanPeakR0] == 0.0);

        // An UNBOUND channel is silent on the frame — no stale value from a
        // previous binding, which is what a plain (non-consuming) read would
        // leave behind when a strip's element is removed.
        CHECK(frame[kChanPeakL0 + 7] == 0.0);
        CHECK(frame[kTapeState0 + 7] == 0.0);

        // The watchdog lamp: not engaged on ordinary material, and its gain is
        // exactly 1.0 — the "not limiting" value, so the UI can test equality
        // rather than guess a threshold.
        CHECK(frame[kWatchdogEngaged] == 0.0);
        CHECK(std::abs(frame[kWatchdogGain] - 1.0) < 1e-9);

        // THE MONITOR MASK — one bit per channel, and the frame is the ONLY way
        // a strip can know: the engine opens the switch at record-start and
        // closes it at the Law C-3 handoff, so the document's intent and the
        // engine's state are routinely different on purpose.
        CHECK(frame[kMonitorMask] == 0.0); // every monitor closed by default
        sl_channel_set_monitor(e, 2, 1u);
        sl_channel_set_monitor(e, 5, 1u);
        sl_render(e, buses, 2, 512);
        sl_hotframe(e, frame.data(), (uint32_t) frame.size());
        // Bits 2 and 5 → 4 + 32. Asserted as the exact number rather than a
        // bit test, so a mask emitted with the wrong SHIFT cannot pass.
        CHECK(frame[kMonitorMask] == 36.0);
        sl_channel_set_monitor(e, 2, 0u);
        sl_channel_set_monitor(e, 5, 0u);

        // Still no NaNs anywhere now that the whole frame has real sources.
        for (int i = 0; i < kLength; ++i) CHECK(std::isfinite(frame[i]));
    }

    sl_engine_stop(e);
    sl_engine_destroy(e);
    std::printf("sl_hotframe_emit_test OK\n");
    return 0;
}
