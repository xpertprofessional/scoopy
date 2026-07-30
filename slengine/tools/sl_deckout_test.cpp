// P3.5-E3 — A GRID DECK REACHES A LOOPER STRIP, AUDIBLY.
//
// The defect this closes was a hole under a SIGNED decision. D-SL-MORPH-01 made
// strips one-kind-each, so "a scoopy deck with a looper recording the deck's own
// output" became TWO ROUTED STRIPS — and P3-R3 shipped that gesture: REC on a
// grid strip spawns a looper patched from the source. But the cable it authored
// was `channelOut` of the grid strip, and a grid deck's channel is a PROJECTION:
// the core owns that deck's gain stage and already summed it into main, so this
// tier mixes nothing for it and its bus is empty by construction
// (sl_channel.h/sl_channel.cpp both say so). The gesture worked, the take was
// silence, and nothing anywhere said why.
//
// The fix is a source kind that names the deck itself — `deckOut` (kind 4), the
// core's dry per-deck output. This file is the gate: not "the route exists" but
// "the deck is IN the take".
//
// ⚠️ WHY THE ASSERTIONS ARE ABOUT ENERGY AND NOT SAMPLES. A sequenced deck's
// output depends on the whole core (step clock, voice envelopes, bus stretcher),
// so pinning sample values here would pin the core's DSP, which is not this
// tier's business and is covered where it belongs. What IS this tier's business
// is whether the deck's audio arrives at all — which is exactly what was broken.
#include "sl_engine.h"

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
constexpr uint32_t kLanes = 6;
constexpr uint32_t kMainL = 0;

// Endpoint kinds, spelled out rather than imported: this is the ABI's numbering
// and a test that took it from the same enum could not catch a renumbering.
constexpr uint32_t kSrcChannelOut = 0, kSrcDeckOut = 4;
constexpr uint32_t kDstChannelIn = 0, kDstMain = 2;
constexpr uint32_t kNoSub = 0xFFFFFFFFu;

double peakOf(const std::vector<float>& v, uint32_t n) {
    double p = 0.0;
    for (uint32_t i = 0; i < n; ++i) p = std::fmax(p, std::fabs((double) v[i]));
    return p;
}
} // namespace

int main() {
    sl_engine* e = sl_engine_create(kRate, kQ, 93);
    CHECK(e != nullptr);
    CHECK(sl_engine_start(e) == 1);

    std::vector<std::vector<float>> lane(kLanes, std::vector<float>(kQ, 0.0f));
    std::vector<float*> lanes;
    for (auto& l : lane) lanes.push_back(l.data());
    auto render = [&] { sl_render(e, lanes.data(), kLanes, kQ); };

    // ── the deck: a tone on every step of deck 0 ─────────────────────────────
    std::vector<float> tone(4800);
    for (size_t i = 0; i < tone.size(); ++i)
        tone[i] = 0.5f * std::sin(2.0 * 3.14159265358979 * 220.0 * (double) i / kRate);
    CHECK(sl_engine_register_sample(e, "tone", tone.data(), nullptr,
                                    (uint32_t) tone.size(), kRate) == 1);
    const int32_t volumeId = sl_track_param_id("SL_T_VOLUME");
    CHECK(volumeId != SL_PARAM_UNKNOWN);

    const uint8_t steps[8] = {1, 1, 1, 1, 1, 1, 1, 1};
    CHECK(sl_snapshot_begin(e, 0, 120.0, /*is_playing*/ 1, 0) == 1);
    CHECK(sl_snapshot_track_begin(e, "tone", steps, 8) == 1);
    sl_snapshot_track_set(e, volumeId, 1.0);
    sl_snapshot_track_end(e);
    CHECK(sl_snapshot_commit(e) > 0);

    // Strip A is the grid strip: channel 0 bound to deck 0 (kind 2 = gridDeck).
    CHECK(sl_channel_set_source(e, 0, 2, 0) == 1);
    // Strip B is the looper: channel 1 carrying tape 0.
    CHECK(sl_channel_set_source(e, 1, 1, 0) == 1);

    // The deck is audible through the CORE's own sum (it always was — that is
    // the projection working, and the reason the empty bus went unnoticed).
    double deckAudible = 0.0;
    for (int b = 0; b < 200; ++b) { render(); deckAudible = std::fmax(deckAudible, peakOf(lane[kMainL], kQ)); }
    CHECK(deckAudible > 0.01);

    // ── 1. THE DEFECT, PINNED ────────────────────────────────────────────────
    // The grid strip's channel BUS is empty. Asserted rather than assumed,
    // because the fix must not be mistaken for "it works now anyway": this is
    // the projection's documented property, and a future change that fills this
    // bus would ALSO be double-summing the deck into main.
    sl_channel_peak_l(e, 0); // drain
    render();
    CHECK(sl_channel_peak_l(e, 0) == 0.0);

    // …so a cable from that bus carries NOTHING. This is precisely what P3-R3's
    // spawned looper was patched with, and why its take was silence.
    sl_route_clear_all(e);
    CHECK(sl_route_add_ex(e, kSrcChannelOut, 0, kNoSub, kDstChannelIn, 1, 1.0, 0) >= 0);
    CHECK(sl_route_add_ex(e, kSrcChannelOut, 1, kNoSub, kDstMain, 0, 1.0, 0) >= 0);
    for (int b = 0; b < 40; ++b) render();
    sl_channel_peak_l(e, 1); // drain the ramp
    render();
    const double viaChannelOut = sl_channel_peak_l(e, 1);
    CHECK(viaChannelOut < 1e-6); // the looper's bus hears the grid strip: silence

    // ── 2. THE FIX: `deckOut` CARRIES THE DECK ───────────────────────────────
    sl_route_clear_all(e);
    // Refusals first — the deck index space is 3, not the channel space's 8.
    CHECK(sl_route_add_ex(e, kSrcDeckOut, sl_deck_count(), kNoSub, kDstChannelIn, 1, 1.0, 0) == -1);
    CHECK(sl_route_add_ex(e, kSrcDeckOut, 99, kNoSub, kDstChannelIn, 1, 1.0, 0) == -1);
    // …and an unknown kind is still refused, so kind 4 did not open the door to 5.
    CHECK(sl_route_add_ex(e, 5, 0, kNoSub, kDstChannelIn, 1, 1.0, 0) == -1);

    CHECK(sl_route_add_ex(e, kSrcDeckOut, 0, kNoSub, kDstChannelIn, 1, 1.0, 0) >= 0);
    CHECK(sl_route_add_ex(e, kSrcChannelOut, 1, kNoSub, kDstMain, 0, 1.0, 0) >= 0);
    for (int b = 0; b < 60; ++b) render(); // the cable fades in over 10 ms
    double viaDeckOut = 0.0;
    for (int b = 0; b < 200; ++b) {
        render();
        viaDeckOut = std::fmax(viaDeckOut, sl_channel_peak_l(e, 1));
    }
    // THE ASSERTION THE ROW EXISTS FOR: the looper strip's BUS — the thing a
    // `channelBus` record source captures — now carries the deck.
    CHECK(viaDeckOut > 0.01);

    // ── 3. AND THE TAKE HAS ENERGY, NOT SILENCE ──────────────────────────────
    // The gesture end to end: REC on the looper with its tap = its own bus.
    // kind 2 = channelBus, chan0 = the CHANNEL index (recordTapFor's 'bus').
    CHECK(sl_tape_set_record_source(e, 0, 2, 1, -1) == 1);
    sl_tape_record_service(e);
    sl_tape_record_start(e, 0);
    for (int b = 0; b < 80; ++b) render();
    const uint64_t captured = sl_tape_frames(e, 0);
    CHECK(captured > 0);
    sl_tape_record_stop(e, 0);
    render();

    std::vector<float> drained(captured * 2, 0.0f);
    const uint32_t got = sl_tape_drain(e, 0, drained.data(), (uint32_t) captured, nullptr);
    CHECK(got > 0);
    double takePeak = 0.0;
    for (uint32_t i = 0; i < got * 2u; ++i)
        takePeak = std::fmax(takePeak, std::fabs((double) drained[i]));
    CHECK(takePeak > 0.01); // ← "the take has energy, not silence"

    // ── 4. A DECK THAT STOPS GOES SILENT ON THE TAP ──────────────────────────
    // Stale-buffer honesty: the core only WRITES a deck's dry output while the
    // deck renders, so an inactive deck would otherwise leave its last fragment
    // sitting there for a `deckOut` cable to loop forever under a deck that is
    // gone. Zeroed at the source (NativeAudioEngineCore's inactive branch).
    sl_deck_clear(e, 0);
    for (int b = 0; b < 80; ++b) render(); // ramps and voice tails settle
    sl_channel_peak_l(e, 1);
    double afterClear = 0.0;
    for (int b = 0; b < 40; ++b) { render(); afterClear = std::fmax(afterClear, sl_channel_peak_l(e, 1)); }
    CHECK(afterClear < 1e-4);

    // ── 5. IT COMPOSES: NO ORDER, NO CYCLE ───────────────────────────────────
    // A deck is rendered before the channels, so a deckOut cable is EXTERNAL
    // like a device input: it constrains no render order, and it cannot be part
    // of a cycle. Feeding the deck's own grid strip is therefore legal (it is
    // not a loop) — and the render order stays a permutation regardless.
    CHECK(sl_route_add_ex(e, kSrcDeckOut, 0, kNoSub, kDstChannelIn, 0, 1.0, 0) >= 0);
    uint32_t order[8] = {0};
    sl_route_render_order(e, order);
    bool seen[8] = {};
    for (uint32_t i = 0; i < sl_channel_count(); ++i) {
        CHECK(order[i] < sl_channel_count());
        CHECK(!seen[order[i]]);
        seen[order[i]] = true;
    }
    for (int b = 0; b < 40; ++b) render();
    CHECK(std::isfinite(peakOf(lane[kMainL], kQ)));

    sl_engine_destroy(e);
    std::printf("sl_deckout_test OK\n");
    return 0;
}
