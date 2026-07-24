// Feedback watchdog (P4-04, playback-composer.md §3 + §8 fixture 3).
//
// Internal cycles are structurally impossible except through the LoopbackBus.
// An EXTERNAL loop — out → another app → "Wizard Out" → back in — is
// undetectable by construction, and users will build one by accident. This
// level guard is the only defence.
//
// Two assertions carry the weight:
//   1. a SUSTAINED runaway engages the limiter and raises feedbackAlarm;
//   2. a single TRANSIENT does NOT (RMS over 250 ms, not peak) — a watchdog
//      that trips on a snare hit would be worse than none.
#include "wz_engine.h"

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
constexpr uint32_t kQ = 128;
constexpr double kRate = 48000.0;
constexpr uint32_t kAlarmSlot = 3; // HotFrame scalar 3 = feedbackAlarm

void buildInputWorld(wz_engine* e) {
    wz_world_begin(e);
    wz_world_channel_begin(e, "in");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 1); // deviceInput
    wz_world_channel_set(e, wz_world_key_for_name("srcChan0"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75); // unity dB
    wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0);  // hard L
    wz_world_channel_end(e);
    wz_world_commit(e);
}
} // namespace

int main() {
    wz_engine* e = wz_engine_create(kRate, kQ, 9);
    CHECK(e != nullptr);
    buildInputWorld(e);

    std::vector<float> in(kQ), l(kQ), r(kQ), cl(kQ), cr(kQ);
    const float* ins[1] = {in.data()};
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
    std::vector<double> hot(8 + 7, 0.0);
    auto feed = [&](float v) {
        for (uint32_t i = 0; i < kQ; ++i) in[i] = v;
        wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    };
    auto alarm = [&]() {
        const uint32_t len = wz_engine_hotframe_length(e);
        hot.assign(len, 0.0);
        wz_engine_hotframe(e, hot.data(), len);
        return hot[kAlarmSlot];
    };
    auto peakOut = [&]() {
        double p = 0.0;
        for (uint32_t i = 0; i < kQ; ++i) p = std::max(p, std::abs(static_cast<double>(l[i])));
        return p;
    };

    // --- 1. normal programme material never trips it ------------------------
    for (int b = 0; b < 400; ++b) feed(0.5f); // a loud but sane -6 dBFS, for ~1 s
    CHECK(alarm() == 0.0);
    CHECK(std::abs(peakOut() - 0.5) < 1e-3); // passed through untouched
    std::printf("  steady -6 dBFS: alarm=%.0f peak=%.4f\n", alarm(), peakOut());

    // --- 2. a single TRANSIENT does not trip it -----------------------------
    // One block of a huge value, then back to quiet. RMS over 250 ms barely
    // moves — this is exactly the false positive an RMS window exists to avoid.
    feed(8.0f);
    for (int b = 0; b < 20; ++b) feed(0.1f);
    CHECK(alarm() == 0.0);
    std::printf("  after a single 8.0 transient: alarm=%.0f\n", alarm());

    // --- 3. a SUSTAINED runaway engages the limiter + raises the alarm ------
    // Feed well past +6 dBFS continuously — the runaway an external feedback
    // loop produces.
    for (int b = 0; b < 400; ++b) feed(4.0f); // ~+12 dBFS, sustained ~1 s
    CHECK(alarm() == 1.0);
    const double limitedPeak = peakOut();
    // The limiter pulled the output down toward the ceiling instead of letting
    // it run away: far below the 4.0 that was fed in.
    CHECK(limitedPeak < 2.0);
    std::printf("  sustained +12 dBFS: alarm=%.0f limited peak=%.4f (fed 4.0)\n",
                alarm(), limitedPeak);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::isfinite(l[i]));

    // --- 4. the limiter never CLICKS (ramped engage, D-WZ-RAMP-01) ---------
    // Across the engage transition no consecutive-sample jump may exceed what a
    // 10 ms ramp can produce at this level.
    double prev = l[0];
    double maxJump = 0.0;
    for (int b = 0; b < 4; ++b) {
        feed(4.0f);
        for (uint32_t i = 0; i < kQ; ++i) {
            maxJump = std::max(maxJump, std::abs(static_cast<double>(l[i]) - prev));
            prev = l[i];
        }
    }
    // A hard (unramped) engage would drop the signal by ~3.0 in one sample.
    CHECK(maxJump < 0.5);
    std::printf("  max consecutive-sample jump across engage = %.5f\n", maxJump);

    // --- 5. it HOLDS after the level clears, then releases ------------------
    feed(0.0f);
    CHECK(alarm() == 1.0); // still engaged immediately after the runaway stops
    for (int b = 0; b < 600; ++b) feed(0.05f); // ~1.6 s of quiet: past the hold
    CHECK(alarm() == 0.0);
    // ...and normal material passes at full level again afterwards.
    for (int b = 0; b < 400; ++b) feed(0.5f);
    CHECK(alarm() == 0.0);
    CHECK(std::abs(peakOut() - 0.5) < 1e-2);
    std::printf("  after hold + release: alarm=%.0f peak=%.4f\n", alarm(), peakOut());

    // --- 6. a runaway on a NON-MAIN bus is guarded too ---------------------
    // The detector and limiter used to live only in the bus-0 loop, so a strip
    // routed to bus 2 could run away to the PA unlimited and with no alarm.
    // External feedback enters on whatever bus its strip targets — main is not
    // special — so every bus carries its own detector.
    wz_world_begin(e);
    wz_world_channel_begin(e, "in");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 1);
    wz_world_channel_set(e, wz_world_key_for_name("srcChan0"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
    wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0);
    wz_world_channel_set(e, wz_world_key_for_name("outBus"), 1.0); // bus 2
    wz_world_channel_end(e);
    wz_world_commit(e);

    // Bus 1 lands on device channels 4/5, so this render needs a wider device.
    std::vector<float> b2l(kQ), b2r(kQ);
    float* wide[6] = {l.data(), r.data(), cl.data(), cr.data(), b2l.data(), b2r.data()};
    auto feedWide = [&](float v) {
        for (uint32_t i = 0; i < kQ; ++i) in[i] = v;
        wz_engine_render_io(e, ins, 1, wide, 6, kQ);
    };
    auto peakBus2 = [&]() {
        double p = 0.0;
        for (uint32_t i = 0; i < kQ; ++i) p = std::max(p, std::abs(static_cast<double>(b2l[i])));
        return p;
    };

    for (int b = 0; b < 600; ++b) feedWide(0.05f); // let the main-bus hold expire
    CHECK(alarm() == 0.0);
    for (int b = 0; b < 400; ++b) feedWide(0.5f); // sane level on bus 2: untouched
    CHECK(alarm() == 0.0);
    CHECK(std::abs(peakBus2() - 0.5) < 1e-3);
    // Main carries nothing now, so ONLY the bus-2 detector can trip.
    CHECK(peakOut() < 1e-6);

    for (int b = 0; b < 400; ++b) feedWide(4.0f); // sustained +12 dBFS on bus 2
    const double busLimited = peakBus2();
    CHECK(busLimited < 2.0);
    CHECK(alarm() == 1.0); // and it SAYS so — a silent limit is a hidden fault
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::isfinite(b2l[i]));
    std::printf("  sustained +12 dBFS on bus 2: alarm=%.0f limited peak=%.4f (fed 4.0)\n",
                alarm(), busLimited);

    // Ramped there as well: no click when a non-main bus engages.
    double bprev = b2l[0];
    double bmaxJump = 0.0;
    for (int b = 0; b < 4; ++b) {
        feedWide(4.0f);
        for (uint32_t i = 0; i < kQ; ++i) {
            bmaxJump = std::max(bmaxJump, std::abs(static_cast<double>(b2l[i]) - bprev));
            bprev = b2l[i];
        }
    }
    CHECK(bmaxJump < 0.5);

    // ...and it releases, so the bus is not left quietly attenuated.
    for (int b = 0; b < 600; ++b) feedWide(0.05f);
    CHECK(alarm() == 0.0);
    for (int b = 0; b < 400; ++b) feedWide(0.5f);
    CHECK(std::abs(peakBus2() - 0.5) < 1e-2);
    std::printf("  bus 2 after hold + release: peak=%.4f\n", peakBus2());

    wz_engine_destroy(e);
    std::printf("watchdog_test OK\n");
    return 0;
}
