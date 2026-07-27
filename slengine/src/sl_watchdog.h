// The output watchdog — guard G1 from docs/specs/pd-modular-routing.md §5,
// carried forward from D-WZ-WATCHDOG-01.
//
// WHY THIS IS NEEDED HERE SPECIFICALLY, and it is not a theoretical guard:
// the merged engine renders scoopy's core first and the strip channels sum in
// AFTERWARDS. The core's master clipper has already run by then, so every
// channel — every tape, and every routed copy of one — reaches the output lanes
// with NOTHING between it and the device. Before routing existed that was
// merely untidy, because a channel could only be as loud as its material. Now
// that a consented feedback edge can regenerate, an unguarded path can grow
// without bound. Adding the edge type without adding the detector would be
// shipping the exact hole pd-modular-routing §2.1 called the hardest blocker.
//
// WHAT IT IS: a leaky RMS detector over the main pair with a ramped gain
// reduction — a LIMITER, not a breaker. It clamps and reports; it never mutes
// the app or tears a route down behind the user's back. A performer whose
// feedback patch is a bit hot should hear it held, not hear it stop.
//
// RMS rather than peak is deliberate (D-WZ-WATCHDOG-01): a single transient —
// a kick, a scratch, a punched-in edit — must never trip it. Only sustained
// energy does, which is what a runaway actually looks like.
#pragma once

#include <atomic>
#include <cstdint>

namespace sl {

/** Provisional values, carried from wizard's watchdog. The mechanism is the
    thing being built; these numbers are expected to be tuned by ear. */
inline constexpr double kWatchdogThresholdDb = 6.0;  // +6 dBFS RMS...
inline constexpr double kWatchdogWindowSec = 0.250;  // ...sustained this long
inline constexpr double kWatchdogHoldSec = 1.000;    // stay engaged after it clears
inline constexpr double kWatchdogCeiling = 1.0;      // the RMS ceiling enforced

class Watchdog {
public:
    void configure(double sampleRate);

    /** Limit `l`/`r` in place. Returns nothing; engagement is readable below so
        the UI can light a lamp — an alarm the user cannot see is not one. */
    void process(float* l, float* r, uint32_t frames, double sampleRate);

    /** 1 while limiting (including the hold tail). */
    uint32_t engaged() const { return engaged_.load(std::memory_order_relaxed); }
    /** The gain currently being applied, for metering/diagnostics. */
    double gain() const { return pubGain_.load(std::memory_order_relaxed); }

    /** Test seam ONLY — fixtures that drive deliberately hot synthetic signal
        need to measure the path under test rather than the safety net. Always
        enabled in the app. Disabling also clears any residual limiting, so a
        re-enable does not inherit a stale gain. */
    void setEnabled(uint32_t enabled);
    uint32_t enabled() const { return enabled_.load(std::memory_order_relaxed); }

private:
    std::atomic<uint32_t> enabled_{1};
    std::atomic<uint32_t> engaged_{0};
    std::atomic<double> pubGain_{1.0};
    // Render-thread-owned.
    double meanSquare_ = 0.0;
    double holdRemaining_ = 0.0;
    double limiterGain_ = 1.0;
};

} // namespace sl
