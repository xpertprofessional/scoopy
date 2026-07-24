// Parameter ramp trajectories (D-WZ-RAMP-01) — the anti-click guarantee.
//
// summing_test pins the SETTLED gain/pan values. Nothing checked the TRANSITION,
// which is the whole point of a ramp: a gain, mute or solo change must glide,
// never step, or it clicks. The engine builds two shapes from the one 10 ms
// constant, and this locks both:
//   - gain/pan: a one-pole (asymptotic, ~10 ms time constant)
//   - mute/solo: a finite raised-cosine 0.5(1-cos(pi r)) over exactly 10 ms,
//     flat-sloped at both ends
//
// A regression that made either an instant step (or changed the time constant,
// or introduced overshoot) would fail here rather than be discovered as an
// audible tick in the field.
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

constexpr double kRate = 48000.0;
constexpr int kRampSamples = 480; // 10 ms at 48 k (D-WZ-RAMP-01)

// A strip playing DC 1.0 through a deck, so output tracks the gain path
// directly: out = 1.0 * smGain * muteG. Unity fader (position 0.75) + centre pan
// gives a settled level of cos(pi/4) = 0.7071 in each channel.
wz_engine* makeStrip(double gainPos, double mute) {
    wz_engine* e = wz_engine_create(kRate, 256, 5);
    if (e == nullptr) return nullptr;
    std::vector<float> dc(2000, 1.0f);
    const float* planar[1] = {dc.data()};
    if (wz_deck_load(e, 0, 1, 2000, planar, kRate) != 1) { wz_engine_destroy(e); return nullptr; }
    wz_world_begin(e);
    wz_world_channel_begin(e, "strip");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 2); // deck
    wz_world_channel_set(e, wz_world_key_for_name("deckIndex"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), gainPos);
    wz_world_channel_set(e, wz_world_key_for_name("pan"), 0.0);
    wz_world_channel_set(e, wz_world_key_for_name("mute"), mute);
    wz_world_channel_end(e);
    wz_world_set_deck_count(e, 1);
    wz_world_commit(e);
    wz_deck_trigger(e, 0, 0); // loop the DC buffer
    return e;
}

// Change one param as a LIVE gesture. A world commit is a document swap that
// seeds smoothers to target (no fade-in on install); the ramp is exercised by
// wz_param_set, which is the path the UI's fader/mute actually take. Testing the
// ramp therefore MUST use this, not a re-commit.
void setParam(wz_engine* e, const char* name, double value) {
    wz_param_set(e, 0, wz_param_id_for_name(name), value);
}

double renderOne(wz_engine* e) {
    float l = 0, r = 0, cl = 0, cr = 0;
    float* outs[4] = {&l, &r, &cl, &cr};
    wz_engine_render(e, outs, 4, 1);
    return static_cast<double>(l);
}

void settle(wz_engine* e, int frames) {
    for (int i = 0; i < frames; ++i) (void)renderOne(e);
}

} // namespace

int main() {
    // ---- mute: a finite raised-cosine, click-free at both ends -------------
    {
        wz_engine* e = makeStrip(0.75, 0.0); // unity, unmuted
        CHECK(e != nullptr);
        settle(e, 1500);
        const double l0 = renderOne(e);
        CHECK(l0 > 0.70 && l0 < 0.71); // cos(pi/4), unity fader

        setParam(e, "mute", 1.0); // MUTE (live gesture)
        std::vector<double> v;
        v.reserve(700);
        for (int i = 0; i < 700; ++i) v.push_back(renderOne(e));

        // Monotonic non-increasing (a raised-cosine down-ramp never rises).
        for (size_t i = 1; i < v.size(); ++i) CHECK(v[i] <= v[i - 1] + 1e-9);

        // Completes in ~10 ms: still ringing down at 3/4 of the ramp, silent
        // shortly after the ramp length.
        CHECK(v[static_cast<size_t>(kRampSamples * 3 / 4)] > 1e-4);
        CHECK(v[static_cast<size_t>(kRampSamples) + 20] < 1e-4);

        // Raised-cosine midpoint: at half the ramp the level is half (shape
        // 0.5(1-cos(pi/2)) = 0.5). This is what distinguishes it from a linear
        // fade and from a one-pole.
        const double mid = v[static_cast<size_t>(kRampSamples / 2)] / l0;
        CHECK(std::abs(mid - 0.5) < 0.03);

        // Click-free: the biggest single-sample step is a tiny fraction of an
        // instant mute (which would jump the full 0.7071 in one sample).
        double maxStep = std::abs(v[0] - l0);
        for (size_t i = 1; i < v.size(); ++i)
            maxStep = std::max(maxStep, std::abs(v[i] - v[i - 1]));
        CHECK(maxStep < 0.01);              // ~0.0023 in practice; 0.7071 if stepped
        CHECK(std::abs(v[0] - l0) < 5e-4);  // flat slope at the start (no initial tick)

        wz_engine_destroy(e);
    }

    // ---- gain: a one-pole, click-free, correct time constant ---------------
    {
        wz_engine* e = makeStrip(0.75, 0.0);
        CHECK(e != nullptr);
        settle(e, 1500);
        const double l0 = renderOne(e);
        CHECK(l0 > 0.70 && l0 < 0.71);

        setParam(e, "gain", 0.0); // fader to -inf (linear 0), live gesture
        std::vector<double> v;
        v.reserve(3000);
        for (int i = 0; i < 3000; ++i) v.push_back(renderOne(e));

        for (size_t i = 1; i < v.size(); ++i) CHECK(v[i] <= v[i - 1] + 1e-9); // monotonic, no overshoot

        // Click-free start: the first step is a tiny fraction of the total.
        CHECK(std::abs(v[0] - l0) < 0.01);

        // One-pole time constant: after exactly one 10 ms tau, 1/e of the step
        // remains (~36.8%). This is the assertion that would catch a wrong
        // constant or a switch to a different ramp shape.
        const double atTau = v[static_cast<size_t>(kRampSamples) - 1] / l0;
        CHECK(std::abs(atTau - std::exp(-1.0)) < 0.02); // 0.368

        // After five taus it is essentially closed.
        CHECK(v[static_cast<size_t>(kRampSamples) * 5] / l0 < 0.01);

        wz_engine_destroy(e);
    }

    std::printf("ramp_test OK\n");
    return 0;
}
