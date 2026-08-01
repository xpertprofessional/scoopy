// HOST-GRID LAUNCH — the claim is SAMPLE-EXACT, so this measures the sample.
//
// D-SL-DECKPLUGIN-03: launches across separate plugin instances line up because
// every instance converts the same host `ppqPosition` into its own engine frame
// and releases there, sharing nothing. That only holds if "release at frame N"
// means frame N and not "the block containing N" — at 512/48k a block is 10.7 ms,
// which is an audible flam on a downbeat and exactly the precision the user
// rejected when this was designed.
//
// `sl_snapshot_test` says of the older quantized launch: "that the boundary
// lands sample-accurately is the core's own property, resolved inside render()
// where no test up here can observe the instant." True of a CYCLE-relative
// boundary, whose instant depends on another deck's live transport. It is NOT
// true here: the boundary is an absolute engine frame this test chooses, so the
// instant is knowable in advance and the first non-silent output frame can be
// compared against it directly.
//
// TWO ENGINES, because one proving its own arithmetic proves nothing about the
// property that matters — two instances agreeing. They share no state by
// construction (separate sl_engine*), which is the design's whole point.
#include "sl_engine.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <algorithm>
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
constexpr uint32_t kBlock = 512;

/** An engine with one deck published ACTIVE and audible on every step, but held
    — `launchArmed` with no boundary yet, which is the state a deck waits in. */
sl_engine* makeArmedEngine(std::vector<float>& tone) {
    sl_engine* e = sl_engine_create(kRate, kBlock, 96);
    if (e == nullptr || sl_engine_start(e) != 1) return nullptr;
    if (sl_engine_register_sample(e, "tone", tone.data(), nullptr,
                                  (uint32_t) tone.size(), kRate) != 1)
        return nullptr;
    const int32_t volumeId = sl_track_param_id("SL_T_VOLUME");
    if (sl_snapshot_begin(e, 0, 120.0, /*is_playing*/ 1, 0) != 1) return nullptr;
    const uint8_t steps[8] = {1, 1, 1, 1, 1, 1, 1, 1};
    if (sl_snapshot_track_begin(e, "tone", steps, 8) != 1) return nullptr;
    sl_snapshot_track_set(e, volumeId, 1.0);
    sl_snapshot_track_end(e);
    if (sl_snapshot_commit(e) == 0) return nullptr;
    return e;
}

/** Render `blocks` blocks and return the index of the first frame whose |sample|
    crosses `eps`, counted from the very first frame rendered — i.e. in the same
    absolute engine-frame space `sl_engine_time_samples` reports. -1 = silence. */
int64_t firstAudibleFrame(sl_engine* e, int blocks, double eps = 1e-4) {
    std::vector<float> l(kBlock), r(kBlock);
    float* buses[2] = {l.data(), r.data()};
    for (int b = 0; b < blocks; ++b) {
        std::fill(l.begin(), l.end(), 0.0f);
        std::fill(r.begin(), r.end(), 0.0f);
        sl_render(e, buses, 2, kBlock);
        for (uint32_t i = 0; i < kBlock; ++i)
            if (std::fabs((double) l[i]) > eps || std::fabs((double) r[i]) > eps)
                return (int64_t) b * kBlock + i;
    }
    return -1;
}

} // namespace

int main() {
    std::vector<float> tone(4800);
    for (size_t i = 0; i < tone.size(); ++i)
        tone[i] = 0.5f * std::sin(2.0 * 3.14159265358979 * 220.0 * (double) i / kRate);

    // ── 1. THE REFUSALS ─────────────────────────────────────────────────────
    {
        sl_engine* e = makeArmedEngine(tone);
        CHECK(e != nullptr);
        // None of these may arm anything, and none may crash.
        sl_deck_request_launch_at_frame(nullptr, 0, 1000);
        sl_deck_request_launch_at_frame(e, 99, 1000);
        sl_deck_request_launch_at_frame(e, 0, 0); // frame 0 is the sentinel
        sl_deck_cancel_launch_at_frame(nullptr, 0);
        sl_deck_cancel_launch_at_frame(e, 99);
        sl_engine_destroy(e);
    }

    // ── 2. IT LANDS ON THE FRAME, not on the block ──────────────────────────
    //
    // Deliberately NOT a block multiple: 5000 sits 904 frames into block 9, so a
    // "next block boundary" implementation would fire at 4608 or 5120 and this
    // would catch it. That is the whole difference between what shipped and what
    // was asked for.
    {
        constexpr uint64_t kTarget = 5000;
        sl_engine* e = makeArmedEngine(tone);
        CHECK(e != nullptr);
        sl_deck_request_launch_at_frame(e, 0, kTarget);
        const int64_t first = firstAudibleFrame(e, 40);
        std::printf("  armed %llu -> first audible frame %lld (delta %lld)\n",
                    (unsigned long long) kTarget, (long long) first,
                    (long long) (first - (int64_t) kTarget));
        CHECK(first >= 0);
        // One frame of tolerance for the lead-in's ratio round-trip; a block
        // would be 512, so this cannot pass a block-accurate implementation.
        CHECK(std::llabs(first - (int64_t) kTarget) <= 1);
        sl_engine_destroy(e);
    }

    // ── 3. TWO INSTANCES AGREE — the property the feature exists for ────────
    //
    // Separate engines sharing NOTHING, armed at the same absolute frame the way
    // two plugin instances would after each resolved the same host ppq. The
    // agreement has to come from the frame arithmetic — there is no channel
    // between them by construction, which is the design's whole claim.
    {
        constexpr uint64_t kTarget = 7777;
        sl_engine* a = makeArmedEngine(tone);
        sl_engine* b = makeArmedEngine(tone);
        CHECK(a != nullptr && b != nullptr);
        sl_deck_request_launch_at_frame(a, 0, kTarget);
        sl_deck_request_launch_at_frame(b, 0, kTarget);
        const int64_t fa = firstAudibleFrame(a, 40);
        const int64_t fb = firstAudibleFrame(b, 40);
        std::printf("  two instances: A %lld, B %lld (spread %lld frames)\n",
                    (long long) fa, (long long) fb, (long long) std::llabs(fa - fb));
        CHECK(fa >= 0 && fb >= 0);
        CHECK(std::llabs(fa - fb) <= 1);
        CHECK(std::llabs(fa - (int64_t) kTarget) <= 1);
        sl_engine_destroy(a);
        sl_engine_destroy(b);
    }

    // ── 4. A TARGET ALREADY PAST FIRES, rather than hanging the deck ────────
    //
    // A boundary missed by a hair must still launch. The alternative is a deck
    // that stays silent forever waiting for a frame that will never come round
    // again — the failure nobody can diagnose mid-set.
    {
        sl_engine* e = makeArmedEngine(tone);
        CHECK(e != nullptr);
        std::vector<float> l(kBlock), r(kBlock);
        float* buses[2] = {l.data(), r.data()};
        for (int i = 0; i < 4; ++i) sl_render(e, buses, 2, kBlock); // clock runs past
        CHECK(sl_engine_time_samples(e) > 1000);
        sl_deck_request_launch_at_frame(e, 0, 1000); // long gone
        const int64_t first = firstAudibleFrame(e, 8);
        CHECK(first >= 0);
        CHECK(first < (int64_t) kBlock); // fired on the very next block, not never
        sl_engine_destroy(e);
    }

    // ── 5. CANCEL RELEASES THE HOLD, rather than leaving it silent ──────────
    {
        sl_engine* e = makeArmedEngine(tone);
        CHECK(e != nullptr);
        sl_deck_request_launch_at_frame(e, 0, 100000); // far out
        std::vector<float> l(kBlock), r(kBlock);
        float* buses[2] = {l.data(), r.data()};
        for (int i = 0; i < 4; ++i) sl_render(e, buses, 2, kBlock);
        double held = 0.0;
        for (uint32_t i = 0; i < kBlock; ++i) held = std::fmax(held, std::fabs((double) l[i]));
        CHECK(held < 1e-4); // genuinely waiting

        sl_deck_cancel_launch_at_frame(e, 0);
        CHECK(firstAudibleFrame(e, 16) >= 0); // and it plays once un-armed
        sl_engine_destroy(e);
    }

    std::printf("sl_host_launch_test OK\n");
    return 0;
}
