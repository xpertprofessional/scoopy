// The output watchdog — see sl_watchdog.h for why the merged engine needs one
// of its own (the channel sum lands after the core's master clipper).
#include "sl_watchdog.h"

#include <algorithm>
#include <cmath>

namespace sl {
namespace {

constexpr double kRampSeconds = 0.010; // D-WZ-RAMP-01: the one 10 ms constant

/** +6 dBFS expressed as a MEAN SQUARE, since that is what the detector holds:
    10^(dB/10) rather than 10^(dB/20), because mean-square is already the
    square of amplitude. Getting this wrong by using the amplitude form would
    put the threshold at +12 dB and the guard would essentially never fire. */
inline double thresholdMeanSquare() { return std::pow(10.0, kWatchdogThresholdDb / 10.0); }

} // namespace

void Watchdog::configure(double sampleRate) {
    (void)sampleRate;
    meanSquare_ = 0.0;
    holdRemaining_ = 0.0;
    limiterGain_ = 1.0;
    engaged_.store(0, std::memory_order_relaxed);
    pubGain_.store(1.0, std::memory_order_relaxed);
}

void Watchdog::setEnabled(uint32_t enabled) {
    // Only atomics are touched here. `limiterGain_`, `meanSquare_` and
    // `holdRemaining_` are RENDER-OWNED, and clearing them from the control
    // thread would be a plain data race against a running process() — so the
    // clearing moved INTO process(), which observes the disable and does it on
    // the thread that owns them. The published values are reset immediately so
    // a UI reading the lamp never sees stale limiting.
    enabled_.store(enabled != 0 ? 1u : 0u, std::memory_order_relaxed);
    if (enabled == 0) {
        engaged_.store(0, std::memory_order_relaxed);
        pubGain_.store(1.0, std::memory_order_relaxed);
    }
}

void Watchdog::process(float* l, float* r, uint32_t frames, double sampleRate) {
    if (l == nullptr || r == nullptr || frames == 0) return;
    if (enabled_.load(std::memory_order_relaxed) == 0) {
        // Disabled: clear the render-owned state HERE, on the thread that owns
        // it, so a re-enable starts from silence rather than inheriting a
        // half-decayed detector from before.
        meanSquare_ = 0.0;
        holdRemaining_ = 0.0;
        limiterGain_ = 1.0;
        return;
    }

    const double fs = sampleRate > 0.0 ? sampleRate : 48000.0;
    const double dt = 1.0 / fs;
    // One-pole coefficients: the detector integrates over the 250 ms window,
    // the limiter's gain moves on the engine-wide 10 ms ramp so it can never
    // introduce a step of its own while removing someone else's.
    const double detAlpha = 1.0 - std::exp(-dt / kWatchdogWindowSec);
    const double gainAlpha = 1.0 - std::exp(-dt / kRampSeconds);
    const double threshold = thresholdMeanSquare();

    for (uint32_t i = 0; i < frames; ++i) {
        const double a = static_cast<double>(l[i]);
        const double b = static_cast<double>(r[i]);
        // Mean square of the PAIR: a runaway is rarely polite enough to stay on
        // one side, and averaging keeps a hard-panned source from reading 3 dB
        // quiet to the detector.
        const double ms = 0.5 * (a * a + b * b);
        meanSquare_ += detAlpha * (ms - meanSquare_);

        if (meanSquare_ > threshold) {
            holdRemaining_ = kWatchdogHoldSec;
        } else if (holdRemaining_ > 0.0) {
            holdRemaining_ -= dt;
        }
        const bool on = holdRemaining_ > 0.0;

        // Target gain brings the measured RMS back to the ceiling. Computed
        // from the SMOOTHED mean square, so it tracks sustained level and not
        // individual samples — the limiter rides the runaway down rather than
        // chopping at each peak.
        double target = 1.0;
        if (on && meanSquare_ > 0.0) {
            const double rms = std::sqrt(meanSquare_);
            target = std::min(1.0, kWatchdogCeiling / rms);
        }
        limiterGain_ += gainAlpha * (target - limiterGain_);
        if (limiterGain_ < 0.0) limiterGain_ = 0.0;

        l[i] = static_cast<float>(a * limiterGain_);
        r[i] = static_cast<float>(b * limiterGain_);
    }

    engaged_.store(holdRemaining_ > 0.0 ? 1u : 0u, std::memory_order_relaxed);
    pubGain_.store(limiterGain_, std::memory_order_relaxed);
}

} // namespace sl
