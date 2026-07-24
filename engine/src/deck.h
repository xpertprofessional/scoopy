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
#include <cmath>
#include <cstdint>
#include <memory>
#include <vector>

namespace wz {

inline constexpr uint32_t kMaxDecks = 8;
// 8 user output buses (CONCEPT §4 / playback-composer.md §4). Bus 0 is main.
inline constexpr uint32_t kMaxOutBuses = 8;
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
    // Scrub mailbox (turntable-style dragging). -1 = nothing pending; otherwise
    // the frame the render thread should jump to at the top of the next block.
    // Same discipline as pendingReset: the control thread only ever STORES, the
    // render thread exchanges it away, so no lock and no torn read.
    std::atomic<int64_t> pendingSeek{-1};

    // --- TAPE SCRUB (turntable): position drives, RATE is derived -----------
    // The control thread posts only where the finger is; the render thread works
    // out how fast to travel to get there this block. That single mechanism
    // yields both behaviours at once — moving the hand faster opens a bigger gap,
    // which becomes a higher rate, which IS the pitch bend. Deriving rate from
    // pixels instead (the reference implementation's approach) makes rate and
    // position disagree as soon as the view is zoomed.
    // OVERDUB (D-WZ-OVERDUB-01): the deck keeps PLAYING its loop while input is
    // summed into the same buffer at the playhead. Not a DeckState, deliberately
    // — the deck really is still `looping`, and playback must not stop.
    std::atomic<uint32_t> overdub{0};
    /** How a punch writes into existing material:
        0 = SUM   (sound-on-sound, D-WZ-OVERDUB-01)
        1 = REPLACE (erase and write — the material under the playhead is gone)
        INSERT is deliberately absent: splicing changes the buffer LENGTH, which
        means allocating and moving audio, and neither is allowed on the render
        thread. It has to be a control-thread splice at stop, not a live mode. */
    std::atomic<uint32_t> overdubMode{0};

    std::atomic<uint32_t> scrubActive{0};
    std::atomic<double> scrubTarget{0.0};  // where the finger is, in frames
    double scrubRate = 0.0;                // render-side smoothed travel rate
    double scrubGain = 0.0;                // 0..1 ramp position (raised-cosine)
    std::atomic<double> pubScrubRate{0.0}; // published for the UI
    std::atomic<double> rate{1.0};         // signed varispeed; <0 = reverse (P4-02)

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
    double smRate = 0.0; // D-WZ-RAMP-01-smoothed rate; 0 = seed from target


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

    // Linear interpolation between two frames (P4-02). Only reached when the
    // rate is NOT exactly ±1 — the identity path never calls this, so a deck at
    // unity is bit-exact by construction.
    float sampleLerp(uint32_t ch, double pos) const {
        const double floorPos = std::floor(pos);
        const auto i0 = static_cast<uint64_t>(floorPos);
        const double frac = pos - floorPos;
        const float a = sample(ch, i0);
        if (frac == 0.0) return a; // landed exactly on a frame: no filtering
        return static_cast<float>(a + (sample(ch, i0 + 1) - a) * frac);
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

    /** OVERDUB: SUM a frame into audio that is already there (D-WZ-OVERDUB-01,
        destructive sound-on-sound). Distinct from appendFrame, which writes at
        the growing END of the buffer: this writes INSIDE it, at the playhead, so
        the buffer never grows — which is why overdub costs no allocation and
        leaves the 256 MB cap untouched. Returns false past the allocated end. */
    bool mixFrame(uint64_t frame, const float* chanVals, uint32_t nVals) {
        const uint64_t ci = frame / kDeckChunkFrames;
        if (ci >= chunkCount.load(std::memory_order_acquire)) return false;
        const uint64_t off = frame % kDeckChunkFrames;
        auto& p = chunks[ci]->plane;
        for (uint32_t c = 0; c < channels; ++c) {
            const float v = c < nVals ? chanVals[c] : (nVals > 0 ? chanVals[0] : 0.0f);
            p[c][off] += v;
        }
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
        smRate = 0.0;
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
