// Render chunk-invariance (P0-11a correctness foundation).
//
// AudioIO drives wz_engine_render_io in CHUNKS: a device block larger than the
// engine's max render block is split, and P0-11a will later make the engine
// block equal the device quantum. Both are only safe if rendering is a pure
// function of the engine CLOCK, not of block boundaries — the header promises
// exactly this ("advances the clock by exactly `frames` regardless of world
// state"), but nothing proved it.
//
// This renders the SAME deterministic world several ways — all in chunks no
// larger than the engine's max block, which is the engine's call contract (a
// bigger device block is the CALLER's job to split, and AudioIO does). The
// canonical run uses full max-block chunks; size-1, sub-block, non-divisor, and
// a ragged pattern are each asserted BIT-IDENTICAL to it. A per-block operation
// anywhere in the graph (a smoother whose coefficient depends on block size, an
// accumulator reset per call, a loop-wrap handled at block granularity) would
// diverge here. The patterns deliberately cross the deck's loop wrap so a chunk
// boundary landing mid-wrap is compared against a wrap landing mid-chunk.
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
constexpr uint32_t kLoopFrames = 1000; // short, so a 2500-frame run wraps twice
constexpr uint32_t kTotal = 2500;

// A fresh engine with one deck strip playing a fixed mono buffer, triggered to
// loop. Identical every call, so two runs differ only if rendering is not
// chunk-invariant.
wz_engine* makeWorld() {
    wz_engine* e = wz_engine_create(kRate, 256, 5);
    if (e == nullptr) return nullptr;

    // Deterministic content with real dynamics: a sine so values stay in range
    // (no watchdog limiting), plus a slow amplitude sweep so the strip's gain
    // smoother is genuinely moving where a per-block bug would show.
    std::vector<float> buf(kLoopFrames);
    for (uint32_t i = 0; i < kLoopFrames; ++i) {
        const double t = static_cast<double>(i) / kRate;
        const double env = 0.5 + 0.4 * std::sin(2.0 * 3.14159265358979 * 3.0 * t);
        buf[i] = static_cast<float>(env * std::sin(2.0 * 3.14159265358979 * 220.0 * t));
    }
    const float* planar[1] = {buf.data()};
    if (wz_deck_load(e, 0, 1, kLoopFrames, planar, kRate) != 1) {
        wz_engine_destroy(e);
        return nullptr;
    }

    wz_world_begin(e);
    wz_world_channel_begin(e, "deck-strip");
    wz_world_channel_set(e, wz_world_key_for_name("srcKind"), 2); // deck
    wz_world_channel_set(e, wz_world_key_for_name("deckIndex"), 0);
    wz_world_channel_set(e, wz_world_key_for_name("gain"), 0.75);
    wz_world_channel_set(e, wz_world_key_for_name("pan"), -0.3); // exercise both L and R
    wz_world_channel_end(e);
    wz_world_set_deck_count(e, 1);
    wz_world_commit(e);

    wz_deck_trigger(e, 0, 0); // loop
    return e;
}

// Render kTotal frames using the given chunk sizes (cycled), returning main-bus
// L/R interleaved. Bus 0 is main; we render 4 channels (main L/R + cue L/R) and
// keep the main pair.
std::vector<float> renderWith(const std::vector<int>& pattern) {
    wz_engine* e = makeWorld();
    if (e == nullptr) return {};

    std::vector<float> out;
    out.reserve(kTotal * 2);
    std::vector<float> l(kTotal), r(kTotal), cl(kTotal), cr(kTotal);

    uint32_t done = 0;
    size_t pi = 0;
    while (done < kTotal) {
        int chunk = pattern[pi % pattern.size()];
        pi++;
        if (chunk <= 0) chunk = 1;
        if (done + static_cast<uint32_t>(chunk) > kTotal)
            chunk = static_cast<int>(kTotal - done);
        // Fresh chunk-local pointers so each call writes at buffer origin, then
        // we append — mirrors how the device offsets channel pointers per chunk.
        float* outs[4] = {l.data(), r.data(), cl.data(), cr.data()};
        wz_engine_render(e, outs, 4, static_cast<uint32_t>(chunk));
        for (int i = 0; i < chunk; ++i) {
            out.push_back(l[static_cast<size_t>(i)]);
            out.push_back(r[static_cast<size_t>(i)]);
        }
        done += static_cast<uint32_t>(chunk);
    }
    wz_engine_destroy(e);
    return out;
}

} // namespace

int main() {
    // The engine CONTRACT is one call per <= max-block region; a device block
    // larger than that is the CALLER's job to split (AudioIO does exactly this).
    // So the invariant under test is that any VALID chunking — every chunk
    // <= max block — produces the same samples. The reference is therefore the
    // max-block run, not a single oversized call (which would be a misuse).
    {
        wz_engine* probe = wz_engine_create(kRate, 256, 5);
        CHECK(probe != nullptr);
        CHECK(wz_engine_max_block_frames(probe) == 256); // fixes the cases below
        wz_engine_destroy(probe);
    }
    const int kMax = 256;

    const auto reference = renderWith({kMax}); // canonical: full max-block chunks
    CHECK(reference.size() == kTotal * 2);
    // Sanity: it actually produced signal (a silent world would make every
    // comparison trivially pass).
    double peak = 0.0;
    for (float s : reference) peak = std::max(peak, std::abs(static_cast<double>(s)));
    CHECK(peak > 0.1);

    struct Case {
        const char* name;
        std::vector<int> pattern;
    };
    const std::vector<Case> cases = {
        {"all size-1", {1}},
        {"fixed 128 (sub-block)", {128}},
        {"fixed 250 (non-divisor of the loop length)", {250}},
        {"ragged pattern (all <= max block) crossing wraps", {1, 5, 17, 64, 200, 256, 3, 128}},
    };

    for (const auto& c : cases) {
        const auto got = renderWith(c.pattern);
        CHECK(got.size() == reference.size());
        for (size_t i = 0; i < got.size(); ++i) {
            if (got[i] != reference[i]) { // BIT-identical: any drift is a real bug
                std::fprintf(stderr,
                             "FAIL: '%s' diverged at sample %zu: %.9g vs reference %.9g\n",
                             c.name, i, static_cast<double>(got[i]),
                             static_cast<double>(reference[i]));
                return 1;
            }
        }
    }

    std::printf("render_chunk_invariance_test OK\n");
    return 0;
}
