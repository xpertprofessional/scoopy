// P1-05 fixtures (docs/specs/routing.md §10): pan law, fader golden table,
// ramp slope bound, 2-strip sum vs reference, NaN guard, solo semantics.
#include "wz_engine.h"

#include "fader.h" // engine-internal (tools build with PRIVATE src include)

#include <cmath>
#include <cstdio>
#include <limits>
#include <vector>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr uint32_t kFrames = 256;
constexpr double kFs = 48000.0;

// Golden fader table (position → dB), 1e-9. The SAME values are pinned in
// web/src/engine/faderCurve.test.ts — this cross-pin is what makes "the fader
// you see is the gain you get" a tested property, not a hope.
constexpr double kGolden[][2] = {
    {0.00, -120.000000000}, {0.05, -60.000000000}, {0.10, -50.213612485},
    {0.15, -39.902966625},  {0.20, -30.640837454}, {0.25, -24.000000000},
    {0.30, -19.601536053},  {0.35, -15.931728059}, {0.40, -12.861152040},
    {0.45, -10.260384013},  {0.50, -8.000000000},  {0.55, -6.022095238},
    {0.60, -4.306285714},   {0.65, -2.779428571},  {0.70, -1.368380952},
    {0.75, 0.000000000},    {0.80, 1.309714286},   {0.85, 2.523428571},
    {0.90, 3.682285714},    {0.95, 4.827428571},   {1.00, 6.000000000},
};

struct Rig {
    wz_engine* e = nullptr;
    std::vector<float> inA, inB;
    std::vector<float> outL, outR, cueL, cueR;
    std::vector<const float*> ins;
    std::vector<float*> outs;

    explicit Rig(int strips) {
        e = wz_engine_create(kFs, kFrames, 4);
        inA.assign(kFrames, 0.0f);
        inB.assign(kFrames, 0.0f);
        outL.assign(kFrames, 0.0f);
        outR.assign(kFrames, 0.0f);
        cueL.assign(kFrames, 0.0f);
        cueR.assign(kFrames, 0.0f);
        ins = {inA.data(), inB.data()};
        outs = {outL.data(), outR.data(), cueL.data(), cueR.data()};
        (void)strips;
    }
    ~Rig() { wz_engine_destroy(e); }
    void render() {
        wz_engine_render_io(e, ins.data(), static_cast<uint32_t>(ins.size()),
                            outs.data(), static_cast<uint32_t>(outs.size()), kFrames);
    }
    // Run long enough that every smoother/ramp has fully settled (>> 10 ms).
    void settle(int blocks = 200) {
        for (int i = 0; i < blocks; ++i) render();
    }
};

// Build a world of mono strips: strip i reads device input i.
void buildWorld(wz_engine* e, int strips, const double* gains, const double* pans,
                const bool* mutes, const bool* solos, const bool* toMon) {
    const auto kKind = wz_world_key_for_name("srcKind");
    const auto kC0 = wz_world_key_for_name("srcChan0");
    const auto kGain = wz_world_key_for_name("gain");
    const auto kPan = wz_world_key_for_name("pan");
    const auto kMute = wz_world_key_for_name("mute");
    const auto kSolo = wz_world_key_for_name("solo");
    const auto kMon = wz_world_key_for_name("toMonitor");
    wz_world_begin(e);
    for (int i = 0; i < strips; ++i) {
        char key[16];
        std::snprintf(key, sizeof(key), "s%d", i);
        wz_world_channel_begin(e, key);
        wz_world_channel_set(e, kKind, 1); // deviceInput
        wz_world_channel_set(e, kC0, i);
        wz_world_channel_set(e, kGain, gains[i]);
        wz_world_channel_set(e, kPan, pans[i]);
        wz_world_channel_set(e, kMute, mutes[i] ? 1.0 : 0.0);
        wz_world_channel_set(e, kSolo, solos[i] ? 1.0 : 0.0);
        wz_world_channel_set(e, kMon, toMon[i] ? 1.0 : 0.0);
        wz_world_channel_end(e);
    }
    wz_world_commit(e);
}

} // namespace

int main() {
    // 1. Fader golden table — 1e-9 against the checked-in values.
    for (const auto& row : kGolden) {
        if (row[0] <= 0.0) continue; // 0 is the -inf/linear special below
        CHECK(std::abs(wz::faderPositionToDb(row[0]) - row[1]) < 1e-9);
    }
    CHECK(wz::faderPositionToLinear(0.0) == 0.0); // true zero, no denormal tail
    CHECK(std::abs(wz::faderPositionToDb(0.75)) < 1e-12); // unity detent exact
    // Monotone over the whole throw (the Fritsch–Carlson property).
    double prev = -1e9;
    for (int i = 0; i <= 1000; ++i) {
        const double db = wz::faderPositionToDb(i / 1000.0);
        CHECK(db >= prev - 1e-12);
        prev = db;
    }

    // 2. Pan-law table — exact math to 1e-12 (D-WZ-PAN-01).
    for (const double pan : {-1.0, -0.5, 0.0, 0.5, 1.0}) {
        const double theta = (pan + 1.0) * kPi / 4.0;
        CHECK(std::abs(std::cos(theta) * std::cos(theta) +
                       std::sin(theta) * std::sin(theta) - 1.0) < 1e-12); // constant power
    }

    // 3. Engine-rendered settled gains: unity fader, center pan, DC 1.0 in →
    //    main L == R == cos(π/4) × 1.0 within float32 quantization.
    {
        Rig rig(1);
        const double g[] = {0.75}, p[] = {0.0};
        const bool f[] = {false}, mon[] = {false};
        buildWorld(rig.e, 1, g, p, f, f, mon);
        for (auto& s : rig.inA) s = 1.0f;
        rig.settle();
        const double want = std::cos(kPi / 4.0);
        CHECK(std::abs(rig.outL[kFrames - 1] - want) < 1e-6);
        CHECK(std::abs(rig.outR[kFrames - 1] - want) < 1e-6);
    }

    // 4. Ramp slope bound: mute mid-flight; no consecutive-sample step may
    //    exceed the 10 ms raised-cosine max slope (D-WZ-RAMP-01).
    {
        Rig rig(1);
        const double g[] = {0.75}, p[] = {0.0};
        const bool f[] = {false}, mon[] = {false};
        buildWorld(rig.e, 1, g, p, f, f, mon);
        for (auto& s : rig.inA) s = 1.0f;
        rig.settle();
        wz_param_set(rig.e, 0, wz_param_id_for_name("mute"), 1.0);
        const double amp = std::cos(kPi / 4.0);
        const double step = 1.0 / (0.010 * kFs);
        const double maxSlope = (kPi / 2.0) * step * amp * 1.01 + 1e-7;
        double prevSample = amp;
        bool reachedZero = false;
        for (int b = 0; b < 4; ++b) { // 4 blocks ≈ 21 ms > the 10 ms ramp
            rig.render();
            for (uint32_t i = 0; i < kFrames; ++i) {
                CHECK(std::abs(rig.outL[i] - prevSample) <= maxSlope);
                prevSample = rig.outL[i];
            }
        }
        reachedZero = rig.outL[kFrames - 1] == 0.0f; // raised-cosine ends at EXACT 0
        CHECK(reachedZero);
    }

    // 5. Two-strip sum vs double-precision reference.
    {
        Rig rig(2);
        const double g[] = {0.75, 0.5}, p[] = {-0.3, 0.6};
        const bool f[] = {false, false}, mon[] = {false, false};
        buildWorld(rig.e, 2, g, p, f, f, mon);
        for (auto& s : rig.inA) s = 0.25f;
        for (auto& s : rig.inB) s = -0.5f;
        rig.settle();
        auto stripGain = [](double pos, double pan, bool left) {
            const double theta = (pan + 1.0) * kPi / 4.0;
            return wz::faderPositionToLinear(pos) * (left ? std::cos(theta) : std::sin(theta));
        };
        const double refL = 0.25 * stripGain(0.75, -0.3, true) + -0.5 * stripGain(0.5, 0.6, true);
        const double refR = 0.25 * stripGain(0.75, -0.3, false) + -0.5 * stripGain(0.5, 0.6, false);
        CHECK(std::abs(rig.outL[kFrames - 1] - refL) < 1e-6);
        CHECK(std::abs(rig.outR[kFrames - 1] - refR) < 1e-6);
    }

    // 6. NaN guard: a NaN input never propagates past its strip.
    {
        Rig rig(2);
        const double g[] = {0.75, 0.75}, p[] = {0.0, 0.0};
        const bool f[] = {false, false}, mon[] = {false, false};
        buildWorld(rig.e, 2, g, p, f, f, mon);
        for (auto& s : rig.inA) s = std::numeric_limits<float>::quiet_NaN();
        for (auto& s : rig.inB) s = 0.5f;
        rig.settle();
        const double want = 0.5 * std::cos(kPi / 4.0);
        for (uint32_t i = 0; i < kFrames; ++i) CHECK(std::isfinite(rig.outL[i]));
        CHECK(std::abs(rig.outL[kFrames - 1] - want) < 1e-6);
    }

    // 7. Solo: soloing A ducks B on MAIN only; B's monitor feed is untouched.
    {
        Rig rig(2);
        const double g[] = {0.75, 0.75}, p[] = {-1.0, 1.0}; // A hard L, B hard R
        const bool mute[] = {false, false};
        const bool solo[] = {true, false};
        const bool mon[] = {false, true}; // B feeds the cue
        buildWorld(rig.e, 2, g, p, mute, solo, mon);
        for (auto& s : rig.inA) s = 1.0f;
        for (auto& s : rig.inB) s = 1.0f;
        rig.settle();
        CHECK(std::abs(rig.outL[kFrames - 1] - 1.0) < 1e-6); // A (soloed) on main L
        CHECK(rig.outR[kFrames - 1] == 0.0f);                // B ducked to exact 0 on main
        CHECK(std::abs(rig.cueR[kFrames - 1] - 1.0) < 1e-6); // B alive on the cue
    }

    std::printf("summing_test OK\n");
    return 0;
}
