// The generated track-param mapping: does it compile, and do values land in the
// field the NAME says?
//
// This is the gate that makes generation trustworthy. The generator proves
// COMPLETENESS (every enum member has a case and a name); this proves the
// transcription is real C++ that assigns what it claims — including the awkward
// ones the generator deliberately does not understand (enum casts, clamps, raw
// doubles, and the per-step array helpers).
#include "NativeAudioEngineCore.hpp"
#include "NativeToneFilter.hpp"

#include <cstdio>
#include <cstring>
#include <vector>

using namespace scoopyloops;

namespace {
#include "sl_track_params.inc"

/** Resolve a param BY NAME — the surface v3 exposes. Hardcoding the integer is
    the failure mode the whole keyed design exists to prevent. */
int scalarId(const char* name) {
    for (int k = 0; k < SL_T_SCALAR_COUNT; ++k)
        if (std::strcmp(kScalarParamNames[k], name) == 0) return k;
    return -1;
}

int arrayId(const char* name) {
    for (int k = 0; k < SL_TA_COUNT; ++k)
        if (std::strcmp(kArrayParamNames[k], name) == 0) return k;
    return -1;
}

void applyScalar(NativeTrackSnapshot& t, int param, double v) {
    SL_V3_SCALAR_PARAM_LAMBDAS
    switch (param) {
        SL_V3_SCALAR_PARAM_CASES
        default: break; // unknown key is IGNORED, never misread (v2 semantics)
    }
}

void applyArray(NativeTrackSnapshot& t, int param, const double* v, std::uint32_t n) {
    SL_V3_ARRAY_PARAM_LAMBDAS
    switch (param) {
        SL_V3_ARRAY_PARAM_CASES
        default: break;
    }
}
} // namespace

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

int main() {
    // The mapping is complete and name-resolvable in both directions.
    CHECK(SL_T_SCALAR_COUNT == 91);
    CHECK(SL_TA_COUNT == 21);
    for (int k = 0; k < SL_T_SCALAR_COUNT; ++k) {
        CHECK(kScalarParamNames[k] != nullptr);
        CHECK(scalarId(kScalarParamNames[k]) == k); // name ⇄ index round-trips
    }
    for (int k = 0; k < SL_TA_COUNT; ++k) CHECK(arrayId(kArrayParamNames[k]) == k);
    CHECK(scalarId("SL_T_NOT_A_REAL_PARAM") == -1);
    CHECK(arrayId("") == -1);

    NativeTrackSnapshot t;

    // Plain float / bool / int conversions.
    applyScalar(t, scalarId("SL_T_VOLUME"), 0.75);
    CHECK(t.volume > 0.749f && t.volume < 0.751f);
    applyScalar(t, scalarId("SL_T_PAN"), -0.5);
    CHECK(t.pan < -0.499f && t.pan > -0.501f);
    applyScalar(t, scalarId("SL_T_MUTED"), 1.0);
    CHECK(t.muted);
    applyScalar(t, scalarId("SL_T_MUTED"), 0.0);
    CHECK(!t.muted);
    applyScalar(t, scalarId("SL_T_OUTPUT_ASSIGN"), 3.0);
    CHECK(t.outputAssign == 3);

    // A raw double must NOT be truncated through the float/int helpers — these
    // are the cases the generator transcribes as a bare `v`.
    applyScalar(t, scalarId("SL_T_GLOBAL_PITCH"), -3.25);
    CHECK(t.globalPitchOffset < -3.24 && t.globalPitchOffset > -3.26);
    applyScalar(t, scalarId("SL_T_LOOP_START_MS"), 1234.5);
    CHECK(t.loopStartMs > 1234.4 && t.loopStartMs < 1234.6);

    // Enum casts survive transcription.
    applyScalar(t, scalarId("SL_T_TONE_MODE"), 2.0);
    CHECK(t.toneMode == NativeToneFilter::Mode::highPass);

    // The clamp helper is carried, not dropped: 1…8 valid, anything else off.
    applyScalar(t, scalarId("SL_T_CHOKE_GROUP"), 5.0);
    CHECK(t.chokeGroup == 5);
    applyScalar(t, scalarId("SL_T_CHOKE_GROUP"), 99.0); // legacy artifact → off
    CHECK(t.chokeGroup == 0);
    applyScalar(t, scalarId("SL_T_CHOKE_GROUP"), -1.0);
    CHECK(t.chokeGroup == 0);

    // An unknown key is ignored rather than landing somewhere arbitrary.
    const auto volumeBefore = t.volume;
    applyScalar(t, 100000, 0.123);
    applyScalar(t, -1, 0.123);
    CHECK(t.volume == volumeBefore);

    // Per-step arrays, including the narrowing helpers.
    const double pitches[4] = {0.0, 12.0, -12.0, 7.0};
    applyArray(t, arrayId("SL_TA_PITCH_OFFSETS"), pitches, 4);
    CHECK(t.pitchOffsets.size() == 4);
    CHECK(t.pitchOffsets[1] > 11.9 && t.pitchOffsets[1] < 12.1);
    CHECK(t.pitchOffsets[2] < -11.9 && t.pitchOffsets[2] > -12.1);

    const double reverses[3] = {1.0, 0.0, 1.0};
    applyArray(t, arrayId("SL_TA_REVERSE_STEPS"), reverses, 3);
    CHECK(t.reverseSteps.size() == 3);
    CHECK(t.reverseSteps[0] && !t.reverseSteps[1] && t.reverseSteps[2]);

    std::printf("track_params_test OK (%d scalar + %d array mappings)\n",
                static_cast<int>(SL_T_SCALAR_COUNT), static_cast<int>(SL_TA_COUNT));
    return 0;
}
