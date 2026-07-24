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
    // Length and the spectrum split (schema.ts: 268 scalars + 16 bins = 284).
    CHECK(SL_HOTFRAME_LENGTH == 284);
    CHECK(SL_HOTFRAME_SCALAR_COUNT == 268);
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

    // Every scalar index is inside the scalar region — a sanity net on the enum.
    CHECK(SL_HF_carveN7B5 < SL_HOTFRAME_SCALAR_COUNT);

    std::printf("sl_hotframe_test OK (length %d)\n", SL_HOTFRAME_LENGTH);
    return 0;
}
