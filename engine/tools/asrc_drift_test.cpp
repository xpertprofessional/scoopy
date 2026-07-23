// ASRC drift soak (P2-03 — THE phase centerpiece, feasibility §7's #1 failure:
// "my multitrack recording is out of sync at the end").
//
// Two synthetic clocks: the engine at exactly ENGINE_RATE, a source whose FORMAT
// reports the same nominal rate but whose true clock runs 6.25 ppm faster (the
// spec's 48000 vs 48000.3, scaled to 8 kHz to keep the SINC_BEST sample budget
// CI-fast — the control law is ppm-driven, so the behavior is identical). Each
// engine block the source delivers the frames its TRUE clock produced, with
// timestamps advancing at the true rate but the FORMAT rate reported (exactly
// what a drifting device looks like — the drift is invisible in the reported
// rate, only the timestamps reveal it). The engine then pulls a block through
// the ASRC.
//
// GATE: the effective conversion ratio the ASRC settles on must match
// engineRate/trueRate closely enough that accumulated misalignment stays under
// 1 ms across a simulated hour. The measured steady-state ratio error is
// extrapolated to 3600 s — exact for a constant drift. The NEGATIVE CONTROL
// (controller off = "trust the reported rate") must blow far past 1 ms,
// proving the ASRC is what fixes it (not a tautology).
#include "asrc.h"
#include "source_ring.h"

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

constexpr double kEngineRate = 8000.0;
constexpr double kNominalRate = 8000.0;  // what the source's format claims
constexpr double kTrueRate = 8000.05;    // its clock's true rate (6.25 ppm fast)
constexpr uint32_t kQuantum = 128;
constexpr double kWarmupSec = 30.0;      // let the estimate lock before measuring
constexpr double kMeasureSec = 90.0;     // measurement window (drift is a constant rate)
constexpr double kTwoPi = 6.283185307179586;

struct Result {
    double msPerHour; // |effective ratio error| extrapolated to a simulated hour
    double driftPpm;
    uint64_t underruns;
    uint64_t overruns;
};

Result run(bool controller) {
    wz::SourceRing ring;
    ring.init("tap", 1, 16 * kQuantum); // mono — the SINC_BEST budget is per-sample
    wz::SourceAsrc asrc;
    asrc.init(&ring, kEngineRate, kNominalRate, kQuantum);
    asrc.setControllerEnabled(controller);

    std::vector<float> prime(2 * kQuantum, 0.0f);
    ring.write(prime.data(), 2 * kQuantum, kNominalRate, 0); // avoid a t=0 underrun

    std::vector<float> out(kQuantum, 0.0f);
    std::vector<float> in(kQuantum + 4, 0.0f);
    uint64_t hostNs = 0;
    double srcAccum = 0.0, phase = 0.0;
    const double inc = kTwoPi * 997.0 / kTrueRate; // a real tone, not silence
    uint64_t underruns = 0;

    // Average the effective ratio over the post-warmup window. The TIME AVERAGE
    // is the effective conversion ratio, which is what determines long-term
    // alignment (any block-to-block wobble averages out).
    double sumRatio = 0.0;
    uint64_t nRatio = 0;
    const uint64_t warmBlocks = static_cast<uint64_t>(kEngineRate * kWarmupSec / kQuantum);
    const uint64_t totalBlocks =
        static_cast<uint64_t>(kEngineRate * (kWarmupSec + kMeasureSec) / kQuantum);

    for (uint64_t b = 0; b < totalBlocks; ++b) {
        srcAccum += kQuantum * (kTrueRate / kEngineRate);
        uint32_t feed = static_cast<uint32_t>(srcAccum);
        srcAccum -= feed;
        if (feed > in.size()) feed = static_cast<uint32_t>(in.size());
        for (uint32_t i = 0; i < feed; ++i) {
            in[i] = static_cast<float>(std::sin(phase));
            phase += inc;
            if (phase >= kTwoPi) phase -= kTwoPi;
        }
        hostNs += static_cast<uint64_t>((static_cast<double>(feed) / kTrueRate) * 1e9 + 0.5);
        ring.write(in.data(), feed, kNominalRate, hostNs);

        if (asrc.process(out.data(), kQuantum) < kQuantum) ++underruns;
        if (b >= warmBlocks) {
            sumRatio += asrc.currentRatio();
            ++nRatio;
        }
    }

    const double avgRatio = sumRatio / static_cast<double>(nRatio);
    const double ideal = kEngineRate / kTrueRate;
    const double errFrac = std::fabs(avgRatio / ideal - 1.0); // fractional rate error
    return {errFrac * 3600.0 * 1000.0, asrc.driftPpm(), underruns, ring.overruns.load()};
}

} // namespace

int main() {
    // Controller ON: alignment held to well under a millisecond across the hour.
    const Result on = run(true);
    std::printf("ASRC on:  drift=%.3f ppm  %.4f ms/hr  under=%llu over=%llu\n",
                on.driftPpm, on.msPerHour, static_cast<unsigned long long>(on.underruns),
                static_cast<unsigned long long>(on.overruns));
    CHECK(on.underruns == 0);
    CHECK(on.overruns == 0);
    CHECK(on.msPerHour < 1.0); // THE GATE: < 1 ms over a simulated hour
    CHECK(on.driftPpm > 5.5 && on.driftPpm < 7.0); // ~6.25 ppm discovered from timestamps

    // Negative control: no correction → the naive path drifts an order past 1 ms.
    const Result off = run(false);
    std::printf("ASRC off: drift=%.3f ppm  %.4f ms/hr  under=%llu over=%llu\n",
                off.driftPpm, off.msPerHour, static_cast<unsigned long long>(off.underruns),
                static_cast<unsigned long long>(off.overruns));
    CHECK(off.msPerHour > 10.0); // ~22.5 ms/hr — the failure the ASRC exists to kill
    CHECK(off.msPerHour > on.msPerHour * 100.0); // the controller is unambiguously the fix

    std::printf("asrc_drift_test OK\n");
    return 0;
}
