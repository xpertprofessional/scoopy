// The generated HotFrame layout compiles and matches scoopy's schema.
//
// The generator (generateHotFrame.ts) proves the indices come from the pinned
// authority; this proves the emitted C header is valid C++ and that the
// load-bearing indices the emitter will use resolve to the positions scoopy's
// UI reads (HotFrameLayout in schema.ts). A drift here is a meter reading a
// neighbour's value, so it is worth a compiled assertion.
#include <cstdio>

namespace {
#include "sl_hotframe.inc"
}

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

int main() {
    // Length and the spectrum split (schema.ts: 311 scalars + 16 bins = 327).
    // Was 268/284 before the plane's 42 scalars were APPENDED (merge P2 step 4),
    // and 310/326 before the monitor mask joined them (merge P2-5).
    //
    // RESTATED BY HAND on purpose: if the emitter and schema.ts ever disagree
    // this has to FAIL rather than move in lockstep with a regenerated header.
    CHECK(SL_HOTFRAME_LENGTH == 327);
    CHECK(SL_HOTFRAME_SCALAR_COUNT == 311);
    CHECK(SL_HOTFRAME_SPECTRUM_COUNT == 16);
    CHECK(SL_HOTFRAME_SPECTRUM_BASE == SL_HOTFRAME_SCALAR_COUNT);
    CHECK(SL_HOTFRAME_SPECTRUM_BASE + SL_HOTFRAME_SPECTRUM_COUNT == SL_HOTFRAME_LENGTH);

    // The scalars the emitter fills from engine telemetry — exact positions
    // from HotFrameLayout, so a shift shows up here, not as a wrong meter.
    CHECK(SL_HF_frameCounter == 0);
    CHECK(SL_HF_hostTimeMs == 1);
    CHECK(SL_HF_outputPeakL == 5);
    CHECK(SL_HF_outputPeakR == 6);
    CHECK(SL_HF_outputClip == 7);
    CHECK(SL_HF_inputPeak == 8);
    CHECK(SL_HF_callbackLoad == 9);
    CHECK(SL_HF_deadlineMissCount == 10);

    // The plane's block (merge P2 step 4). It was APPENDED, so every index
    // above is unchanged — that is the property worth pinning, because an
    // insert anywhere earlier would still compile and would silently re-point
    // every meter in the app.
    CHECK(SL_HF_slChanPeakL0 == 268); // starts exactly where the old frame ended
    CHECK(SL_HF_slChanPeakR0 == 276);
    CHECK(SL_HF_slTapePlayhead0 == 284);
    CHECK(SL_HF_slTapeState0 == 292);
    CHECK(SL_HF_slTapeCap0 == 300);
    CHECK(SL_HF_slWatchdogEngaged == 308);
    CHECK(SL_HF_slWatchdogGain == 309);
    // The split tap's one scalar, APPENDED after the watchdog (merge P2-5).
    CHECK(SL_HF_slChanMonitorMask == 310);

    // The emitter indexes these blocks as `base + i` over 8 channels/tapes, so
    // they must be CONTIGUOUS and in order. If a future schema edit interleaved
    // them, `base + i` would quietly write into a neighbouring block.
    CHECK(SL_HF_slChanPeakL7 == SL_HF_slChanPeakL0 + 7);
    CHECK(SL_HF_slChanPeakR7 == SL_HF_slChanPeakR0 + 7);
    CHECK(SL_HF_slTapePlayhead7 == SL_HF_slTapePlayhead0 + 7);
    CHECK(SL_HF_slTapeState7 == SL_HF_slTapeState0 + 7);
    CHECK(SL_HF_slTapeCap7 == SL_HF_slTapeCap0 + 7);

    // Every scalar index is inside the scalar region — a sanity net on the enum.
    CHECK(SL_HF_carveN7B5 < SL_HOTFRAME_SCALAR_COUNT);
    CHECK(SL_HF_slWatchdogGain < SL_HOTFRAME_SCALAR_COUNT);

    std::printf("sl_hotframe_test OK (length %d)\n", SL_HOTFRAME_LENGTH);
    return 0;
}
