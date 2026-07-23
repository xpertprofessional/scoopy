// Engine-internal deck unit (P1-07 playback; P3 recording).
//
// Decks are STABLE engine objects (fixed array of 8) — world commits reference
// them by index and never rebuild them, so a loaded/recorded buffer survives
// topology edits.
//
// STORAGE is CHUNKED PLANAR: a growable list of fixed-size chunks, each holding
// `channels` planar arrays of kChunkFrames. Chunk pointers never move, so the
// control thread can append a new chunk while the render thread reads existing
// ones with no lock and no reallocation. This is what makes Law C-3 free: a
// recording grows into chunks during capture, and on stop the SAME chunks are
// the playback buffer — no copy, no file round-trip. Loaded files fill chunks
// the same way (render detached), so playback has ONE path.
//
// The committed length (`frames`) and loop spec are seqlock/atomic-published so
// the render thread never observes a torn or mid-growth value.
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <vector>

namespace wz {

inline constexpr uint32_t kMaxDecks = 8;
// ~1M frames/chunk → 8 MB per stereo chunk. Cap (D-WZ-DECK-01: 256 MB/deck) is
// enforced in frames by the recorder, independent of chunk size.
inline constexpr uint64_t kDeckChunkFrames = 1u << 20;

// Matches schema DECK_BLOCK_FIELDS 'state' values.
enum class DeckState : uint32_t { idle = 0, looping = 1, oneShot = 2, recording = 3 };

struct DeckChunk {
    std::vector<std::vector<float>> plane; // channels × kDeckChunkFrames
    void alloc(uint32_t channels) {
        plane.assign(channels, std::vector<float>(static_cast<size_t>(kDeckChunkFrames), 0.0f));
    }
};

struct Deck {
    // --- chunked storage (pointers stable; control-thread grows) -------------
    std::vector<std::unique_ptr<DeckChunk>> chunks;
    uint32_t channels = 0;
    std::atomic<uint64_t> frames{0};      // committed length (atomic: record grows it)
    std::atomic<uint32_t> chunkCount{0};  // chunks the render may read

    // --- control → render ----------------------------------------------------
    std::atomic<uint32_t> state{0};        // DeckState
    std::atomic<uint32_t> pendingReset{0}; // retrigger/start: seek region start next block
    std::atomic<double> rate{1.0};         // signed varispeed — engine PLAYS 1.0 until P4

    // Seqlock loop spec (writer: control thread; reader: render, once per block).
    std::atomic<uint32_t> loopSeq{0};
    uint32_t loopEnabled = 0;
    uint64_t loopStart = 0;
    uint64_t loopEnd = 0;

    // --- recording (P3) ------------------------------------------------------
    int32_t recSrcChan0 = -1; // engine input channel recorded (L / mono)
    int32_t recSrcChan1 = -1; // R (-1 = mono)
    uint64_t recStartSample = 0; // engine-sample stamp at record start (Law C-2)
    uint64_t recCapFrames = 0;   // 256 MB/deck in frames (D-WZ-DECK-01)
    std::atomic<uint32_t> recCapReached{0};

    // --- render-owned ---------------------------------------------------------
    double playhead = 0.0;

    // --- render → UI (HotFrame deck block) ------------------------------------
    std::atomic<double> pubPlayhead{0.0};

    // Read one sample (RT-safe: chunk pointers are stable up to chunkCount).
    float sample(uint32_t ch, uint64_t frame) const {
        const uint64_t ci = frame / kDeckChunkFrames;
        if (ci >= chunkCount.load(std::memory_order_acquire)) return 0.0f;
        const uint64_t off = frame % kDeckChunkFrames;
        const auto& p = chunks[ci]->plane;
        return ch < p.size() ? p[ch][off] : p[0][off];
    }

    // Append one frame's worth of samples (RT-safe: writes into an already-
    // allocated chunk; the control thread guarantees the chunk exists — see
    // ensureCapacity). Returns false if no room (cap reached / chunk missing).
    bool appendFrame(uint64_t frame, const float* chanVals, uint32_t nVals) {
        const uint64_t ci = frame / kDeckChunkFrames;
        if (ci >= chunkCount.load(std::memory_order_acquire)) return false;
        const uint64_t off = frame % kDeckChunkFrames;
        auto& p = chunks[ci]->plane;
        for (uint32_t c = 0; c < channels; ++c)
            p[c][off] = c < nVals ? chanVals[c] : (nVals > 0 ? chanVals[0] : 0.0f);
        return true;
    }

    // Control thread: ensure at least `neededFrames` of chunk capacity exists
    // (allocates whole chunks). Call ahead of where the render is writing.
    void ensureCapacity(uint64_t neededFrames) {
        uint64_t haveFrames = static_cast<uint64_t>(chunks.size()) * kDeckChunkFrames;
        while (haveFrames < neededFrames) {
            auto c = std::make_unique<DeckChunk>();
            c->alloc(channels);
            chunks.push_back(std::move(c));
            haveFrames += kDeckChunkFrames;
            chunkCount.store(static_cast<uint32_t>(chunks.size()), std::memory_order_release);
        }
    }

    void reset(uint32_t ch) {
        chunks.clear();
        channels = ch;
        frames.store(0, std::memory_order_relaxed);
        chunkCount.store(0, std::memory_order_release);
        playhead = 0.0;
        recCapReached.store(0, std::memory_order_relaxed);
    }

    void publishLoop(uint32_t enabled, uint64_t start, uint64_t end) {
        loopSeq.fetch_add(1, std::memory_order_release); // odd = write in progress
        loopEnabled = enabled;
        loopStart = start;
        loopEnd = end;
        loopSeq.fetch_add(1, std::memory_order_release); // even = stable
    }

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
