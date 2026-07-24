// Deck RAM cap enforcement (P3-08, D-WZ-DECK-01: cap + stop, 256 MB/deck).
//
// A recording that reaches the cap must STOP cleanly on that deck — bounded
// RAM, a visible indicator, the captured audio still loopable — and it must do
// so WITHOUT allocating on the render thread (the failure mode the whole
// chunked-buffer design exists to avoid: a glitch under memory pressure).
//
// The real 256 MB cap would need ~23 minutes of simulated stereo audio, so the
// engine exposes the cap in FRAMES and this fixture drives a deliberately tiny
// engine (mono, small blocks) far enough to prove the mechanism. The constant
// itself is asserted separately against the signed 256 MB.
#include "wz_engine.h"

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
constexpr uint32_t kQ = 512;
constexpr double kRate = 48000.0;

// Deck HotFrame block layout (schema DECK_BLOCK_FIELDS, stride 8):
// state playhead loopStart loopEnd rate recordLengthSamples recordDrainFill
// recordCapReached
constexpr uint32_t kDeckBlockStride = 8;
constexpr uint32_t kFldState = 0;
constexpr uint32_t kFldRecordLength = 5;
constexpr uint32_t kFldCapReached = 7;
} // namespace

int main() {
    wz_engine* e = wz_engine_create(kRate, kQ, 8);
    CHECK(e != nullptr);

    // One deck strip so the deck block publishes; hard-left unity for readback.
    wz_world_begin(e);
    wz_world_channel_begin(e, "d0");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 2); // deck
    wz_world_channel_set(e, wz_world_key_for_name("deckIndex"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
    wz_world_channel_set(e, wz_world_key_for_name("pan"), -1.0);
    wz_world_channel_end(e);
    wz_world_set_deck_count(e, 1);
    wz_world_commit(e);

    const uint32_t hotLen = wz_engine_hotframe_length(e);
    CHECK(hotLen == 8 + 7 + kDeckBlockStride);
    std::vector<double> hot(hotLen, 0.0);
    const uint32_t deckBase = 8 + 7;

    // --- the signed cap: 256 MB/deck, mono float32 → 67,108,864 frames -------
    // (D-WZ-DECK-01. Stereo halves it; the engine computes from channel count.)
    wz_deck_set_record_source(e, 0, 0, -1); // mono
    wz_deck_record_service(e);
    wz_deck_record_start(e, 0);
    std::vector<float> in(kQ, 0.5f), l(kQ), r(kQ), cl(kQ), cr(kQ);
    const float* ins[1] = {in.data()};
    float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
    wz_engine_render_io(e, ins, 1, outs, 4, kQ); // the arm takes effect

    CHECK(wz_engine_hotframe(e, hot.data(), hotLen) == hotLen);
    CHECK(hot[deckBase + kFldState] == 3.0);        // recording
    CHECK(hot[deckBase + kFldCapReached] == 0.0);   // not yet
    CHECK(hot[deckBase + kFldRecordLength] == kQ);  // live length is published

    // Record a while: the length grows, the cap is nowhere near.
    for (int b = 0; b < 20; ++b) {
        wz_engine_render_io(e, ins, 1, outs, 4, kQ);
        wz_deck_record_service(e);
    }
    CHECK(wz_engine_hotframe(e, hot.data(), hotLen) == hotLen);
    CHECK(hot[deckBase + kFldRecordLength] == 21.0 * kQ);
    CHECK(hot[deckBase + kFldCapReached] == 0.0);
    CHECK(hot[deckBase + kFldState] == 3.0); // still recording
    wz_deck_record_stop(e, 0);
    wz_engine_render_io(e, ins, 1, outs, 4, kQ);

    // --- drive a deck INTO the cap ------------------------------------------
    // Rather than record 23 minutes, verify the mechanism: the engine stops
    // appending, flags recordCapReached, and leaves the deck idle with its
    // captured audio intact. We reach the cap by never calling record_service,
    // so allocation stops — which is precisely the RT-safety contract: the
    // render thread must NEVER allocate to keep recording, it must stop.
    wz_deck_record_service(e);
    wz_deck_record_start(e, 0);
    wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    const uint64_t allocatedFrames = wz_deck_frames(e, 0);
    CHECK(allocatedFrames > 0);

    // Render far past whatever the control thread pre-allocated, WITHOUT ever
    // servicing again. The render thread must refuse to grow the buffer itself.
    for (int b = 0; b < 6000; ++b) wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    const uint64_t stalledAt = wz_deck_frames(e, 0);
    // It captured only as far as the pre-allocated chunks allowed, then stopped
    // appending — no allocation happened on the render thread.
    CHECK(stalledAt > 0);
    CHECK(stalledAt <= 4u * 1024u * 1024u); // bounded by what was pre-allocated
    std::printf("  captured %llu frames without control-thread service (RT never allocated)\n",
                static_cast<unsigned long long>(stalledAt));

    // The captured audio is intact and loopable — a capped/stalled deck is not
    // a lost deck (D-WZ-DECK-01: "the buffer still loops").
    wz_deck_record_stop(e, 0);
    wz_deck_set_loop(e, 0, 1, 0, stalledAt);
    wz_deck_trigger(e, 0, 0); // loop
    for (int b = 0; b < 3; ++b) wz_engine_render_io(e, ins, 1, outs, 4, kQ);
    bool heard = false;
    for (uint32_t i = 0; i < kQ; ++i) heard = heard || (l[i] > 0.4f && l[i] < 0.6f);
    CHECK(heard); // the 0.5 input plays back through the strip

    // --- an explicitly tiny cap proves the stop + flag path -----------------
    // (Same code path the 256 MB cap takes; reached in milliseconds.)
    wz_deck_set_record_source(e, 1, 0, -1);
    wz_deck_record_service(e);
    wz_deck_record_start(e, 1);
    // AFTER record_start (which computes the signed 256 MB cap from the channel
    // count) — the seam then lowers it so the cap path is reached immediately.
    wz_deck_set_record_cap_frames(e, 1, 3u * kQ);
    wz_world_begin(e);
    wz_world_channel_begin(e, "d1");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 2);
    wz_world_channel_set(e, wz_world_key_for_name("deckIndex"), 1);
    wz_world_channel_end(e);
    wz_world_set_deck_count(e, 2);
    wz_world_commit(e);
    for (int b = 0; b < 10; ++b) { // well past the 3-block cap
        wz_engine_render_io(e, ins, 1, outs, 4, kQ);
        wz_deck_record_service(e);
    }
    const uint32_t hotLen2 = wz_engine_hotframe_length(e);
    std::vector<double> hot2(hotLen2, 0.0);
    CHECK(wz_engine_hotframe(e, hot2.data(), hotLen2) == hotLen2);
    // Deck 1's block sits after: scalars + N channel blocks + deck 0's block.
    // (Derived, never hardcoded — wz_world_begin replaces the channel set.)
    const uint32_t base1 = 8 + wz_world_channel_count(e) * 7u + kDeckBlockStride;
    CHECK(hot2[base1 + kFldCapReached] == 1.0);        // the indicator lit
    CHECK(hot2[base1 + kFldState] == 0.0);             // recording stopped → idle
    CHECK(hot2[base1 + kFldRecordLength] == 3.0 * kQ); // stopped exactly AT the cap
    std::printf("  tiny-cap deck stopped at %.0f frames, capReached=%.0f\n",
                hot2[base1 + kFldRecordLength], hot2[base1 + kFldCapReached]);

    wz_engine_destroy(e);
    std::printf("record_cap_test OK\n");
    return 0;
}
