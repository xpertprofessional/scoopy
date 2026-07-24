// Global record: the engine-side tap (P7-GREC-01, D-WZ-GREC-01).
//
// Global record is the ARCHIVIST. Four properties decide whether the archive it
// produces can be trusted, and none of them are visible by listening:
//   1. the tap is POST master fader and POST limiter — the file is what left
//      the bus, not what might have;
//   2. the stamp is the exact engine sample capture began (Law C-2's origin);
//   3. it is not a deck — no cap, no loop, no RAM buffer to fill;
//   4. a host that falls behind LOSES AUDIO, and is told so.
#include "wz_engine.h"

#include <cmath>
#include <cstdint>
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

void buildInputWorld(wz_engine* e) {
    wz_world_begin(e);
    wz_world_channel_begin(e, "in");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 1); // deviceInput
    wz_world_channel_set(e, wz_world_key_for_name("srcChan0"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75); // unity
    wz_world_channel_set(e, wz_world_key_for_name("pan"), 0.0);
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
    auto feed = [&](float v, int blocks) {
        for (uint32_t i = 0; i < kQ; ++i) in[i] = v;
        for (int b = 0; b < blocks; ++b) wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    };
    std::vector<float> drained(1 << 16);
    auto drain = [&](uint64_t* origin) {
        return wz_global_drain(e, drained.data(),
                               static_cast<uint32_t>(drained.size() / 2), origin);
    };
    // Empty the ring completely. One drain call is bounded by the caller's
    // buffer, so after the overrun test below there is far more sitting in the
    // ring than a single call can take.
    auto drainAll = [&]() {
        uint64_t total = 0, n = 0;
        while ((n = drain(nullptr)) > 0) total += n;
        return total;
    };

    // --- nothing is captured before it is armed ------------------------------
    feed(0.25f, 10);
    CHECK(wz_global_record_active(e) == 0);
    CHECK(drain(nullptr) == 0);

    // --- 1. the stamp is where capture actually began ------------------------
    // Deliberately armed after a PRE-ROLL: recording from sample 0 would make a
    // severed stamp indistinguishable from a correct one, which is exactly how
    // P3-15's broken TimeReference survived for so long.
    const uint32_t preRollBlocks = 10; // already fed above
    wz_global_record_start(e);
    feed(0.25f, 8);
    CHECK(wz_global_record_active(e) == 1);
    uint64_t origin = 0;
    const uint32_t got = drain(&origin);
    CHECK(origin == static_cast<uint64_t>(preRollBlocks) * kQ);
    CHECK(got == 8u * kQ); // every rendered frame, none dropped
    std::printf("  origin=%llu frames=%u\n", static_cast<unsigned long long>(origin), got);

    // --- 2. the tap is POST master fader -------------------------------------
    // Halve main and the capture must halve with it. A pre-fader tap would sail
    // on at full level and the archive would disagree with the room.
    const auto mainGain = wz_param_id_for_name("mainGain");
    wz_param_set(e, 0u, mainGain, 0.5);
    feed(0.25f, 60); // let the fader ramp settle
    (void)drain(nullptr);
    feed(0.25f, 20);
    const uint32_t n2 = drain(nullptr);
    CHECK(n2 > 0);
    double peakHalf = 0.0;
    for (uint32_t i = 0; i < n2 * 2u; ++i) peakHalf = std::max(peakHalf, std::abs(static_cast<double>(drained[i])));
    // Whatever the fader law makes of 0.5, the captured level must match what
    // the OUTPUT carries this block — that is the actual claim.
    double peakOut = 0.0;
    for (uint32_t i = 0; i < kQ; ++i) peakOut = std::max(peakOut, std::abs(static_cast<double>(l[i])));
    CHECK(std::abs(peakHalf - peakOut) < 1e-4);
    CHECK(peakHalf < 0.25); // and it really did come down
    std::printf("  post-fader: captured=%.5f output=%.5f\n", peakHalf, peakOut);
    wz_param_set(e, 0u, mainGain, 0.75); // back to unity
    feed(0.25f, 60);
    (void)drain(nullptr);

    // --- 3. the tap is POST limiter ------------------------------------------
    // Drive a sustained runaway: the watchdog engages, and the CAPTURE must be
    // limited too. A pre-limiter tap would archive the runaway at full level —
    // the one recording nobody wants to discover later.
    feed(4.0f, 400);
    // Discard the ENGAGE transient: the first ~250 ms of a runaway is loud in
    // the output too (the detector is RMS, deliberately), and the archive is
    // supposed to match the output — not to be quieter than it.
    (void)drain(nullptr);
    feed(4.0f, 40);
    const uint32_t n3 = drain(nullptr);
    CHECK(n3 > 0);
    double peakRun = 0.0;
    for (uint32_t i = 0; i < n3 * 2u; ++i) peakRun = std::max(peakRun, std::abs(static_cast<double>(drained[i])));
    double peakRunOut = 0.0;
    for (uint32_t i = 0; i < kQ; ++i)
        peakRunOut = std::max(peakRunOut, std::abs(static_cast<double>(l[i])));
    CHECK(peakRun < 2.0);                        // limited, not the 4.0 fed in
    // Not bit-identical: peakRun is the peak over 40 captured blocks while the
    // limiter gain is still settling, peakRunOut is only the last block. Close
    // is the claim — a PRE-limiter tap would sit at 4.0, not within a few
    // percent of what left the bus.
    CHECK(std::abs(peakRun - peakRunOut) < 0.05);
    for (uint32_t i = 0; i < n3 * 2u; ++i) CHECK(std::isfinite(drained[i]));
    std::printf("  post-limiter: fed 4.0, captured peak=%.4f output peak=%.4f\n",
                peakRun, peakRunOut);
    feed(0.0f, 700); // let the hold expire
    (void)drainAll();

    // --- 4. a host that falls behind is TOLD, not silently truncated ---------
    // Never drain, and keep rendering past the ring's capacity. The render
    // thread must not block on a disk, so the oldest audio is dropped — and the
    // count is how the host discovers it lost some.
    CHECK(wz_global_record_overruns(e) == 0);
    feed(0.25f, static_cast<int>((1u << 18) / kQ) + 40);
    CHECK(wz_global_record_overruns(e) > 0);
    std::printf("  overruns after a stalled host: %llu\n",
                static_cast<unsigned long long>(wz_global_record_overruns(e)));

    // --- 5. stopping stops, and the origin survives for the file's header ----
    const uint64_t reported = wz_global_record_stop(e);
    feed(0.25f, 4); // the render picks the stop up at its next block
    CHECK(wz_global_record_active(e) == 0);
    CHECK(reported == origin);
    CHECK(wz_global_record_start_sample(e) == origin);
    CHECK(drainAll() > 0); // what was captured is still there to be written
    feed(0.25f, 8);
    CHECK(drain(nullptr) == 0); // and nothing more is captured after the stop

    // --- 6. it is NOT a deck -------------------------------------------------
    // Global capture must not have created a deck, consumed a deck slot, or
    // touched deck state — the whole point of D-WZ-GREC-01 is that the archivist
    // is a separate mechanism from the instrument.
    CHECK(wz_deck_frames(e, 0) == 0);

    wz_engine_destroy(e);
    std::printf("global_record_test OK\n");
    return 0;
}
