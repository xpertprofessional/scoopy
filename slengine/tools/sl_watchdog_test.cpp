// The output watchdog (guard G1).
//
// The case it exists for: the strip channels sum in AFTER scoopy's core has
// rendered, so the core's master clipper is already behind them. A consented
// feedback route can therefore regenerate straight into the device with nothing
// in the way. This drives exactly that — a loop with round-trip gain above
// unity — and asserts the output stays BOUNDED instead of growing forever.
//
// It is a limiter, not a breaker, so the other half of the contract matters
// just as much: normal material must pass untouched, and a single loud
// transient must not trip it.
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
constexpr uint32_t kQ = 256;
constexpr double kRate = 48000.0;
constexpr uint64_t kLen = 256;
constexpr uint32_t kLanes = 6;

double peakOf(const std::vector<float>& v) {
    double p = 0.0;
    for (float s : v) p = std::max(p, std::abs(static_cast<double>(s)));
    return p;
}
} // namespace

int main() {
    CHECK(sl_watchdog_engaged(nullptr) == 0);
    CHECK(sl_watchdog_gain(nullptr) == 1.0);
    sl_watchdog_set_enabled(nullptr, 0);

    sl_engine* e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);

    std::vector<std::vector<float>> lane(kLanes, std::vector<float>(kQ, 0.0f));
    std::vector<float*> lanes;
    for (auto& l : lane) lanes.push_back(l.data());
    auto render = [&] {
        for (auto& l : lane) std::fill(l.begin(), l.end(), 0.0f);
        sl_render(e, lanes.data(), kLanes, kQ);
    };

    // --- ORDINARY MATERIAL PASSES UNTOUCHED ---------------------------------
    // A full-scale loop is not a fault. If the guard leans on this, every
    // normal session is quietly compressed and nobody knows why.
    std::vector<float> dc(kLen, 1.0f);
    const float* dcp[1] = {dc.data()};
    CHECK(sl_tape_load(e, 0, 1, kLen, dcp, kRate) == 1);
    CHECK(sl_channel_set_source(e, 0, 1 /* tape */, 0) == 1);
    sl_tape_set_loop(e, 0, 1, 0, kLen);
    sl_tape_trigger(e, 0, 0);
    for (int b = 0; b < 200; ++b) render();
    CHECK(sl_watchdog_engaged(e) == 0);
    CHECK(sl_watchdog_gain(e) == 1.0);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(lane[0][i] == 1.0f); // bit-exact, untouched

    // --- A SINGLE TRANSIENT MUST NOT TRIP IT --------------------------------
    // RMS, not peak, precisely so a kick or a punched edit is not mistaken for
    // a runaway (D-WZ-WATCHDOG-01).
    std::vector<float> spike(kLen, 0.0f);
    spike[0] = 8.0f; // way over full scale, but for one sample in 256
    const float* sp[1] = {spike.data()};
    CHECK(sl_tape_load(e, 1, 1, kLen, sp, kRate) == 1);
    CHECK(sl_channel_set_source(e, 1, 1, 1) == 1);
    sl_tape_set_loop(e, 1, 1, 0, kLen);
    sl_tape_trigger(e, 1, 1); // one-shot: exactly one spike
    render();
    render();
    CHECK(sl_watchdog_engaged(e) == 0); // a transient is not a runaway

    // --- THE RUNAWAY: a consented feedback loop with gain above unity -------
    sl_engine_destroy(e);
    e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    CHECK(sl_tape_load(e, 0, 1, kLen, dcp, kRate) == 1);
    CHECK(sl_channel_set_source(e, 0, 1, 0) == 1);
    CHECK(sl_channel_set_source(e, 1, 0, 0) == 1);
    sl_tape_set_loop(e, 0, 1, 0, kLen);
    sl_tape_trigger(e, 0, 0);
    // 0 → 1 forward, and 1 → 0 as a FEEDBACK edge at gain 1.5. Round-trip gain
    // above 1 is the definition of a runaway; the block boundary makes it a
    // rising stair rather than an instant one, which is exactly the case
    // pd-modular-routing §2.2 works through.
    // Capture the ids: a fresh engine already holds the DEFAULT wiring (every
    // channel → main, every send → its FX bus), so low ids are taken and
    // assuming 0/1 here would unpatch the boot routes instead of these.
    const int32_t fwd = sl_route_add(e, 0, 1, 1.0, 0);
    const int32_t loop = sl_route_add(e, 1, 0, 1.5, 1);
    CHECK(fwd >= 0 && loop >= 0);

    double worst = 0.0;
    for (int b = 0; b < 400; ++b) {
        render();
        worst = std::max(worst, peakOf(lane[0]));
        // NEVER non-finite. Round-trip gain 1.5 per block over 400 blocks is
        // 1.5^400 — without a bound where the loop CLOSES (the channel output,
        // not the main bus) this is infinity long before the end, and a limiter
        // on the output cannot rescue it because limiting infinity is infinity.
        for (uint32_t i = 0; i < kQ; ++i) CHECK(std::isfinite(lane[0][i]));
    }
    // ENGAGED, and the lamp says so.
    CHECK(sl_watchdog_engaged(e) == 1);
    CHECK(sl_watchdog_gain(e) < 1.0);
    // BOUNDED, and the audible output pulled back near the ceiling. The exact
    // number is a tuning question; "does not run away" is the contract.
    CHECK(std::isfinite(worst));
    const double settled = peakOf(lane[0]);
    CHECK(settled < 4.0);
    std::printf("  runaway peaked at %.3f, settled %.3f, limiter gain %.4f\n",
                worst, settled, sl_watchdog_gain(e));

    // --- it RECOVERS once the loop is unpatched ------------------------------
    // A limiter that never lets go would leave the session quiet for the rest
    // of the night with no indication why.
    // Remove BOTH cables. Leaving the forward one would keep two unity copies
    // summed on main, whose mean square sits just above the threshold — the
    // guard would be right to stay engaged, and the test would be measuring
    // that rather than recovery.
    CHECK(sl_route_remove(e, static_cast<uint32_t>(loop)) == 1);
    CHECK(sl_route_remove(e, static_cast<uint32_t>(fwd)) == 1);
    // Release takes a few seconds after a runaway this severe, and that is the
    // detector's arithmetic rather than a bug: its mean square is integrated
    // over a 250 ms window, so falling from the runaway's level back under the
    // threshold is ~16 time constants, plus the 1 s hold. The output is HELD at
    // the ceiling throughout, not muted — but the release time is a tuning
    // question the provisional numbers in sl_watchdog.h expect to revisit by
    // ear. 1500 blocks at 256 frames is ~8 s, comfortably past it.
    for (int b = 0; b < 1500; ++b) render();
    CHECK(sl_watchdog_engaged(e) == 0);
    CHECK(sl_watchdog_gain(e) > 0.99);

    // --- the test seam really disables it ------------------------------------
    sl_watchdog_set_enabled(e, 0);
    CHECK(sl_watchdog_engaged(e) == 0);
    CHECK(sl_watchdog_gain(e) == 1.0);

    sl_engine_destroy(e);
    std::printf("sl_watchdog_test OK\n");
    return 0;
}
