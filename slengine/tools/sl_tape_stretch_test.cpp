// timeStretch on a tape (P3-2b-5, TAPE-STRETCH.md) — the engine half.
//
// What only a fixture can pin: under a 2× ratio the TIMELINE runs twice as
// fast (the loop comes around in half the wall time) while the PITCH stays
// where the material put it — the exact pair varispeed cannot deliver
// (varispeed at 2× doubles both). Measured on a sine whose frequency a
// zero-crossing count can read.
#include "sl_engine.h"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <thread>
#include <vector>

#define CHECK(cond)                                                              \
    do {                                                                         \
        if (!(cond)) {                                                           \
            std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
            return 1;                                                            \
        }                                                                        \
    } while (0)

namespace {
constexpr uint32_t kQ = 512;
constexpr double kRate = 48000.0;
constexpr double kToneHz = 440.0;
constexpr uint64_t kLen = 1u << 16; // ~1.37 s of material

// Zero crossings per second over a rendered stretch — a crude but unfoolable
// pitch meter: sine at f has 2f crossings/s.
double crossingsHz(const std::vector<float>& seq) {
    size_t n = 0;
    for (size_t i = 1; i < seq.size(); ++i)
        if ((seq[i - 1] < 0.0f) != (seq[i] < 0.0f)) ++n;
    return (static_cast<double>(n) / 2.0) / (static_cast<double>(seq.size()) / kRate);
}
} // namespace

int main() {
    sl_engine* e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    sl_watchdog_set_enabled(e, 0);
    for (uint32_t t = 0; t < sl_channel_count(); ++t)
        CHECK(sl_channel_set_source(e, t, 1 /* tape */, t) == 1);

    std::vector<float> tone(kLen);
    for (size_t i = 0; i < kLen; ++i)
        tone[i] = 0.5f * std::sin(2.0 * M_PI * kToneHz * static_cast<double>(i) / kRate);
    const float* planar[1] = {tone.data()};
    CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);
    sl_tape_set_loop(e, 0, 1, 0, kLen);
    sl_tape_trigger(e, 0, 0); // loop forward

    std::vector<float> l(kQ), r(kQ);
    float* outs[2] = {l.data(), r.data()};
    auto render = [&] { sl_render(e, outs, 2, kQ); };

    // Mode defaults to timePitch; the setter round-trips.
    CHECK(sl_tape_tempo_mode(e, 0) == 0u);
    sl_tape_set_tempo_mode(e, 0, 1u);
    CHECK(sl_tape_tempo_mode(e, 0) == 1u);

    // The stretcher warms up ASYNC — the render stays dry (and must stay
    // usable) until ready. Render while polling: this also proves the warm-up
    // never blocks or corrupts the dry path.
    bool warm = false;
    for (int tries = 0; tries < 200 && !warm; ++tries) {
        render();
        warm = sl_tape_stretch_ready(e, 0) == 1u;
        if (!warm) std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }
    CHECK(warm); // a stretcher that never warms is a broken feature, not a skip

    // Engage at 2× and let the engage crossfade + rate glide + vocoder latency
    // pass before measuring.
    sl_tape_set_rate(e, 0, 2.0);
    for (int b = 0; b < 300; ++b) render();

    // --- 1. PITCH IS PRESERVED under a 2× ratio -----------------------------
    // Varispeed at 2× would read ~880 Hz; the stretcher must keep ~440. The
    // vocoder is not sample-exact, so the band is generous — but 880 is far
    // outside it, which is the distinction that matters.
    std::vector<float> seq;
    for (int b = 0; b < 64; ++b) {
        render();
        seq.insert(seq.end(), l.begin(), l.end());
    }
    const double hz = crossingsHz(seq);
    CHECK(hz > kToneHz * 0.85 && hz < kToneHz * 1.15);

    // --- 2. THE TIMELINE RUNS AT THE RATIO ----------------------------------
    // The playhead advances ~2 source frames per output frame (mod the loop).
    const double p0 = sl_tape_playhead(e, 0);
    constexpr int kBlocks = 16;
    for (int b = 0; b < kBlocks; ++b) render();
    const double p1 = sl_tape_playhead(e, 0);
    double advanced = p1 - p0;
    while (advanced < 0.0) advanced += static_cast<double>(kLen); // wrapped
    const double perFrame = advanced / static_cast<double>(kBlocks * kQ);
    CHECK(perFrame > 1.9 && perFrame < 2.1);

    // --- 3. DISENGAGE returns to varispeed, still rendering -----------------
    sl_tape_set_tempo_mode(e, 0, 0u);
    for (int b = 0; b < 300; ++b) render();
    std::vector<float> seq2;
    for (int b = 0; b < 64; ++b) {
        render();
        seq2.insert(seq2.end(), l.begin(), l.end());
    }
    const double hz2 = crossingsHz(seq2);
    // Back on varispeed at 2×: pitch doubles — the two modes are audibly
    // different things, which is the whole reason the mode exists.
    CHECK(hz2 > kToneHz * 2.0 * 0.85 && hz2 < kToneHz * 2.0 * 1.15);

    sl_engine_destroy(e);
    std::printf("sl_tape_stretch_test OK — 2x timeline, pitch held at ~%.0f Hz (stretch) vs ~%.0f Hz (varispeed)\n",
                hz, hz2);
    return 0;
}
