// The uniform strip channel: binding, level, mute, the 4 sends, the ramp
// discipline, and the CHANNEL BUS record tap.
//
// The two assertions that carry the design:
//   * a channel parked at unity is BIT-EXACT — the strip model adds a channel
//     around the engines, it does not degrade them, and a fader nobody has
//     touched must not quietly scale every sample by 0.99999;
//   * a `channelBus` take equals that channel's post-level output — which is
//     STRIP-MODEL's closing argument ("recording is always capture this strip's
//     bus") reduced to an equality a test can check.
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
constexpr uint64_t kLen = 1024;

// Lane indices (scoopy's AudioLane): main L/R then four MONO send buses.
constexpr uint32_t kMainL = 0, kMainR = 1, kSend1 = 2, kSend2 = 3;
constexpr uint32_t kLanes = 6;
} // namespace

int main() {
    CHECK(sl_channel_count() == 8);

    sl_engine* e = sl_engine_create(kRate, kQ, 86);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);
    // This fixture sums to 2.0, whose mean square sits just above the +6 dBFS
    // threshold — with the guard live the assertions would depend on how long
    // the detector had been integrating, which is not what is under test here.
    sl_watchdog_set_enabled(e, 0);

    // Null-safety: the ABI is a boundary.
    CHECK(sl_channel_set_source(nullptr, 0, 1, 0) == 0);
    CHECK(sl_channel_source_kind(nullptr, 0) == 0);
    CHECK(sl_channel_level(nullptr, 0) == 0.0);
    CHECK(sl_channel_send(nullptr, 0, 0) == 0.0);
    CHECK(sl_channel_muted(nullptr, 0) == 0);
    sl_channel_set_level(nullptr, 0, 1.0);
    sl_channel_set_mute(nullptr, 0, 1);

    // --- binding refusals ---------------------------------------------------
    // A fresh channel carries NOTHING — a strip starts empty, and that is a
    // resting state rather than an error.
    CHECK(sl_channel_source_kind(e, 0) == 0);
    CHECK(sl_channel_set_source(e, 0, 9 /* no such kind */, 0) == 0);
    CHECK(sl_channel_set_source(e, 0, 1 /* tape */, sl_tape_count()) == 0);
    // Grid decks and tapes are DIFFERENT index spaces (3 vs 8), so a deck
    // binding is checked against the deck count, not clamped into it.
    CHECK(sl_channel_set_source(e, 0, 2 /* gridDeck */, sl_deck_count()) == 0);
    CHECK(sl_channel_set_source(e, 0, 2, 0) == 1);
    CHECK(sl_channel_set_source(e, sl_channel_count(), 1, 0) == 0);
    CHECK(sl_channel_source_kind(e, 0) == 2);

    // Hostile values never reach the mix.
    sl_channel_set_level(e, 0, -1.0);
    sl_channel_set_level(e, 0, std::nan(""));
    CHECK(sl_channel_level(e, 0) == 1.0); // still the default
    sl_channel_set_send(e, 0, 99, 0.5);
    CHECK(sl_channel_send(e, 0, 99) == 0.0);

    // --- material: DC 1.0 on tape 0, looping --------------------------------
    std::vector<float> dc(kLen, 1.0f);
    const float* planar[1] = {dc.data()};
    CHECK(sl_tape_load(e, 0, 1, kLen, planar, kRate) == 1);
    sl_tape_set_loop(e, 0, 1, 0, kLen);
    sl_tape_trigger(e, 0, 0);

    std::vector<std::vector<float>> lane(kLanes, std::vector<float>(kQ, 0.0f));
    std::vector<float*> lanes;
    for (auto& l : lane) lanes.push_back(l.data());
    auto render = [&] { sl_render(e, lanes.data(), kLanes, kQ); };

    // --- an UNBOUND channel is silent ---------------------------------------
    CHECK(sl_channel_set_source(e, 0, 0 /* none */, 0) == 1);
    render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(lane[kMainL][i] == 0.0f);

    // --- a GRID-DECK channel contributes nothing to OUR mixer ---------------
    // Not because it is silent, but because the core already summed that deck
    // and this channel projected its controls onto the core's own per-deck
    // gain. Mixing it again here would be the double-gain bug.
    CHECK(sl_channel_set_source(e, 0, 2 /* gridDeck */, 0) == 1);
    render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(lane[kMainL][i] == 0.0f);

    // --- unity is BIT-EXACT --------------------------------------------------
    CHECK(sl_channel_set_source(e, 0, 1 /* tape */, 0) == 1);
    render();
    for (uint32_t i = 0; i < kQ; ++i) {
        CHECK(lane[kMainL][i] == 1.0f); // exactly, not 0.99999
        CHECK(lane[kMainR][i] == 1.0f);
    }

    // --- level scales, and the move is RAMPED, never stepped ----------------
    sl_channel_set_level(e, 0, 0.5);
    double maxStep = 0.0;
    double prev = 1.0;
    for (int b = 0; b < 20; ++b) {
        render();
        for (uint32_t i = 0; i < kQ; ++i) {
            maxStep = std::max(maxStep, std::abs(static_cast<double>(lane[kMainL][i]) - prev));
            prev = lane[kMainL][i];
        }
    }
    CHECK(maxStep < 0.05); // D-WZ-RAMP-01: no parameter reaches the mix as a step
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::abs(lane[kMainL][i] - 0.5f) < 1e-4f);

    // --- and settles EXACTLY, so a level is the level you asked for ---------
    sl_channel_set_level(e, 0, 1.0);
    for (int b = 0; b < 40; ++b) render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(lane[kMainL][i] == 1.0f);

    // --- mute silences, also ramped -----------------------------------------
    sl_channel_set_mute(e, 0, 1);
    CHECK(sl_channel_muted(e, 0) == 1);
    maxStep = 0.0;
    prev = 1.0;
    for (int b = 0; b < 20; ++b) {
        render();
        for (uint32_t i = 0; i < kQ; ++i) {
            maxStep = std::max(maxStep, std::abs(static_cast<double>(lane[kMainL][i]) - prev));
            prev = lane[kMainL][i];
        }
    }
    CHECK(maxStep < 0.05);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::abs(lane[kMainL][i]) < 1e-4f);
    sl_channel_set_mute(e, 0, 0);
    for (int b = 0; b < 40; ++b) render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(lane[kMainL][i] == 1.0f);

    // --- the strip METER (the plane's only frame-rate engine read) -----------
    // Null-safe, and out of range reads 0 rather than walking off the array.
    CHECK(sl_channel_peak_l(nullptr, 0) == 0.0);
    CHECK(sl_channel_peak_r(e, sl_channel_count()) == 0.0);

    // It reports the channel's OUTPUT: DC 1.0 through a unity channel is 1.0.
    // Both sides read, because each is consumed INDEPENDENTLY — reading L does
    // not drain R.
    render();
    CHECK(std::abs(sl_channel_peak_l(e, 0) - 1.0) < 1e-6);
    CHECK(std::abs(sl_channel_peak_r(e, 0) - 1.0) < 1e-6);

    // CONSUME-AND-RESET. Reading again with no render in between gives 0 —
    // "peak since the last frame", not a latched maximum. Getting this wrong
    // gives a meter that rises once and never falls, which reads as a stuck
    // strip rather than as a bug in the meter.
    CHECK(sl_channel_peak_l(e, 0) == 0.0);
    CHECK(sl_channel_peak_r(e, 0) == 0.0);

    // Level scales what the meter sees, because the tap is POST-level: the
    // meter answers "what is this strip contributing", not "what is in it".
    sl_channel_set_level(e, 0, 0.25);
    for (int b = 0; b < 40; ++b) render(); // let the ramp settle
    sl_channel_peak_l(e, 0);               // drain the ramp's higher values
    render();
    CHECK(std::abs(sl_channel_peak_l(e, 0) - 0.25) < 1e-6);
    sl_channel_set_level(e, 0, 1.0);
    for (int b = 0; b < 40; ++b) render();

    // A MUTED strip reads 0. Same reason: mute is post-tap, so a muted strip
    // contributes nothing and its meter says so — which is what lets a user
    // see at a glance which strip went quiet on purpose.
    sl_channel_set_mute(e, 0, 1);
    for (int b = 0; b < 40; ++b) render();
    sl_channel_peak_l(e, 0); // drain the fade-out
    render();
    CHECK(sl_channel_peak_l(e, 0) < 1e-4);
    sl_channel_set_mute(e, 0, 0);
    for (int b = 0; b < 40; ++b) render();
    sl_channel_peak_l(e, 0);

    // A GRID-DECK channel reads 0 — documented in sl_engine.h, and pinned here
    // so it stays a known property rather than being rediscovered as a dead
    // meter on a strip that is plainly making sound. The core already summed
    // that deck; this bank mixes nothing for it, so it has nothing to measure.
    CHECK(sl_channel_set_source(e, 1, 2 /* gridDeck */, 0) == 1);
    render();
    CHECK(sl_channel_peak_l(e, 1) == 0.0);
    CHECK(sl_channel_set_source(e, 1, 0 /* none */, 0) == 1);

    // --- sends: dry stays on main, wet appears on the send bus --------------
    for (uint32_t i = 0; i < kQ; ++i) CHECK(lane[kSend1][i] == 0.0f); // nothing sent yet
    sl_channel_set_send(e, 0, 0, 0.5);
    CHECK(sl_channel_send(e, 0, 0) == 0.5);
    for (int b = 0; b < 40; ++b) render();
    for (uint32_t i = 0; i < kQ; ++i) {
        CHECK(lane[kMainL][i] == 1.0f);                        // the dry path is untouched
        CHECK(std::abs(lane[kSend1][i] - 0.5f) < 1e-4f);       // and the send carries the wet
        CHECK(lane[kSend2][i] == 0.0f);                        // only the send that was set
    }

    // --- sends are POST-FADER: pulling the strip down takes its reverb ------
    sl_channel_set_level(e, 0, 0.5);
    for (int b = 0; b < 40; ++b) render();
    for (uint32_t i = 0; i < kQ; ++i)
        CHECK(std::abs(lane[kSend1][i] - 0.25f) < 1e-4f); // 0.5 level × 0.5 send
    sl_channel_set_level(e, 0, 1.0);
    sl_channel_set_send(e, 0, 0, 0.0);
    for (int b = 0; b < 40; ++b) render();

    // --- THE CHANNEL BUS RECORD TAP -----------------------------------------
    // Record channel 0 into tape 1. The take must equal channel 0's POST-LEVEL
    // output — that is the tap point ROUTING-MATRIX settled on, and the reason
    // "record the input" and "record the deck output" are one operation.
    sl_channel_set_level(e, 0, 0.5);
    for (int b = 0; b < 40; ++b) render(); // let the level settle before capturing
    CHECK(sl_tape_set_record_source(e, 1, 2 /* channelBus */, 0, -1) == 1);
    // A channel tap must name a channel that exists.
    CHECK(sl_tape_set_record_source(e, 1, 2, static_cast<int32_t>(sl_channel_count()), -1) == 0);
    CHECK(sl_tape_set_record_source(e, 1, 2, -1, -1) == 0);
    CHECK(sl_tape_set_record_source(e, 1, 2, 0, -1) == 1);

    sl_tape_record_service(e);
    sl_tape_record_start(e, 1);
    CHECK(sl_tape_channels(e, 1) == 2); // a bus is always stereo
    render();
    CHECK(sl_tape_frames(e, 1) == kQ);

    std::vector<float> drained(kQ * 2, 0.0f);
    CHECK(sl_tape_drain(e, 1, drained.data(), kQ, nullptr) == kQ);
    for (uint32_t i = 0; i < kQ; ++i) {
        // 1.0 material × 0.5 channel level — the strip's contribution to the
        // mix, which is exactly what was captured.
        CHECK(std::abs(drained[i * 2 + 0] - 0.5f) < 1e-5f);
        CHECK(std::abs(drained[i * 2 + 1] - 0.5f) < 1e-5f);
    }
    sl_tape_record_stop(e, 1);
    render();

    // --- a channel bus tap follows the fader it taps ------------------------
    sl_channel_set_level(e, 0, 1.0);
    for (int b = 0; b < 40; ++b) render();
    sl_tape_record_service(e);
    sl_tape_record_start(e, 1);
    render();
    CHECK(sl_tape_drain(e, 1, drained.data(), kQ, nullptr) == kQ);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::abs(drained[i * 2] - 1.0f) < 1e-5f);
    sl_tape_record_stop(e, 1);

    // --- PER-STRIP DRV (P3-X2) ----------------------------------------------
    // The core's pre-sum deck drive stage, one tier over: post-element,
    // PRE-level, engaged strictly above the 1.0 floor. Assertions are the
    // audible laws, not the DSP internals — those live with the core.
    // Clear the stage: only the drive channel contributes to main below.
    CHECK(sl_channel_set_source(e, 0, 0 /* none */, 0) == 1);

    // Null-safety and hostile values at the boundary.
    sl_channel_set_drive(nullptr, 2, 1, 8.0);
    CHECK(sl_channel_drive_curve(nullptr, 2) == 0);
    CHECK(sl_channel_drive_amount(nullptr, 2) == 1.0);
    CHECK(sl_channel_drive_curve(e, sl_channel_count()) == 0);
    CHECK(sl_channel_drive_amount(e, sl_channel_count()) == 1.0);

    // DC 0.25 on tape 2 — quiet enough that a driven copy is DISTINGUISHABLE
    // (tanh(0.25 × 8) ≈ 0.964; DC 1.0 would saturate to ~1.0 either way).
    std::vector<float> dcq(kLen, 0.25f);
    const float* planarq[1] = {dcq.data()};
    CHECK(sl_tape_load(e, 2, 1, kLen, planarq, kRate) == 1);
    sl_tape_set_loop(e, 2, 1, 0, kLen);
    sl_tape_trigger(e, 2, 0);
    CHECK(sl_channel_set_source(e, 2, 1 /* tape */, 2) == 1);

    // OFF is the default, and off is BIT-EXACT — the identity path survives.
    for (int b = 0; b < 40; ++b) render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(lane[kMainL][i] == 0.25f);

    // Engaged: the strip is audibly DRIVEN. tanh curve, amount 8 → steady-state
    // DC lands on tanh(2) ≈ 0.9640 (the ADAA chord degenerates to the curve
    // itself on constant input, after the one-sample engage transient).
    sl_channel_set_drive(e, 2, 1 /* tanh */, 8.0);
    CHECK(sl_channel_drive_curve(e, 2) == 1);
    CHECK(sl_channel_drive_amount(e, 2) == 8.0);
    for (int b = 0; b < 4; ++b) render();
    const float driven = std::tanh(2.0f);
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::abs(lane[kMainL][i] - driven) < 1e-3f);

    // PRE-level, the tap-point law: pulling the fader scales the DRIVEN signal
    // (0.5 × tanh(2) ≈ 0.482) — it does not back the material off the curve
    // (tanh(0.25 × 0.5 × 8) = tanh(1) ≈ 0.762 would be the wrong topology).
    // Character constant while fading, exactly like the deck's own stage.
    sl_channel_set_level(e, 2, 0.5);
    for (int b = 0; b < 40; ++b) render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(std::abs(lane[kMainL][i] - 0.5f * driven) < 1e-3f);
    sl_channel_set_level(e, 2, 1.0);

    // Independent validation: a typo'd curve keeps the old curve but the good
    // amount lands; a NaN amount keeps the old amount but the good curve lands;
    // out-of-range amounts clamp to the MasterRow's [1, 32].
    sl_channel_set_drive(e, 2, 9 /* no such curve */, 4.0);
    CHECK(sl_channel_drive_curve(e, 2) == 1);
    CHECK(sl_channel_drive_amount(e, 2) == 4.0);
    sl_channel_set_drive(e, 2, 2, std::nan(""));
    CHECK(sl_channel_drive_curve(e, 2) == 2);
    CHECK(sl_channel_drive_amount(e, 2) == 4.0);
    sl_channel_set_drive(e, 2, 2, 100.0);
    CHECK(sl_channel_drive_amount(e, 2) == 32.0);
    sl_channel_set_drive(e, 2, 2, 0.0);
    CHECK(sl_channel_drive_amount(e, 2) == 1.0); // floor = off

    // Disengaged again: back to the BIT-EXACT identity path, not merely close.
    sl_channel_set_drive(e, 2, 1, 1.0);
    for (int b = 0; b < 40; ++b) render();
    for (uint32_t i = 0; i < kQ; ++i) CHECK(lane[kMainL][i] == 0.25f);

    sl_engine_destroy(e);
    std::printf("sl_channel_test OK\n");
    return 0;
}
