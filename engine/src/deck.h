// Engine-internal deck unit (P1-07: playback only; record states land P3).
//
// Decks are STABLE engine objects (fixed array of 8) — world commits reference
// them by index and never rebuild them, so a loaded buffer survives topology
// edits. The buffer is loaded from the control thread with the render callback
// detached (host whileSuspended); per D-WZ-DECKSRC-01 it is already at the
// engine rate, so playback is a straight read. The loop spec is seqlock-
// published (parlante transport_set_loop pattern): the render thread never
// observes a torn start/end pair.
#pragma once

#include <atomic>
#include <cstdint>
#include <vector>

namespace wz {

inline constexpr uint32_t kMaxDecks = 8;

// Matches schema DECK_BLOCK_FIELDS 'state' values.
enum class DeckState : uint32_t { idle = 0, looping = 1, oneShot = 2 /* recording = 3 (P3) */ };

struct Deck {
    // --- buffer (control-thread mutated ONLY while render is detached) ------
    std::vector<std::vector<float>> data; // planar, channels × frames, engine rate
    uint64_t frames = 0;

    // --- control → render ----------------------------------------------------
    std::atomic<uint32_t> state{0};        // DeckState
    std::atomic<uint32_t> pendingReset{0}; // retrigger/start: seek to region start next block
    std::atomic<double> rate{1.0};         // signed varispeed — engine PLAYS 1.0 until P4

    // Seqlock loop spec (writer: control thread; reader: render, once per block).
    std::atomic<uint32_t> loopSeq{0};
    uint32_t loopEnabled = 0;
    uint64_t loopStart = 0;
    uint64_t loopEnd = 0;

    // --- render-owned ---------------------------------------------------------
    double playhead = 0.0;

    // --- render → UI (HotFrame deck block) ------------------------------------
    std::atomic<double> pubPlayhead{0.0};

    void publishLoop(uint32_t enabled, uint64_t start, uint64_t end) {
        loopSeq.fetch_add(1, std::memory_order_release); // odd = write in progress
        loopEnabled = enabled;
        loopStart = start;
        loopEnd = end;
        loopSeq.fetch_add(1, std::memory_order_release); // even = stable
    }

    // Render-side consistent read; spins only across a concurrent write (rare,
    // control-thread writes are tiny).
    void readLoop(uint32_t& enabled, uint64_t& start, uint64_t& end) const {
        for (;;) {
            const uint32_t s0 = loopSeq.load(std::memory_order_acquire);
            if (s0 & 1u) continue;
            enabled = loopEnabled;
            start = loopStart;
            end = loopEnd;
            const uint32_t s1 = loopSeq.load(std::memory_order_acquire);
            if (s0 == s1) return;
        }
    }
};

} // namespace wz
