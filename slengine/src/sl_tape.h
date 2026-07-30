// The TAPE unit — SL-ABI-V3 §5, transplanted from wizard's engine/src/deck.h.
//
// A tape is a CONTINUOUS audio buffer with a playhead: record / scrub /
// varispeed / loop-region / overdub, draining to crash-safe takes. It is the
// looper, the recorder and the file player — one object, different fills
// (docs/archive/STRIP-MODEL.md: "a file player is just a tape loaded from a file").
//
// NAMING (amends SL-ABI-V3 §5's `sl_deck_*` list). §6 already spends `sl_deck_*`
// on scoopy's GRID decks — sequenced sampler sessions, a different index space
// with a different engine behind it. Two objects called "deck" in one ABI is a
// permanent ambiguity, so wizard's deck arrives as `sl_tape_*`, which is also
// the word STRIP-MODEL uses for it.
//
// Tapes are STABLE engine objects (a fixed array): world/topology commits
// reference them by index and never rebuild them, so a loaded or recorded
// buffer survives topology edits.
//
// STORAGE is CHUNKED PLANAR: a growable list of fixed-size chunks, each holding
// `channels` planar arrays of kTapeChunkFrames. Chunk pointers never move, so
// the control thread can append a new chunk while the render thread reads
// existing ones with no lock and no reallocation. This is what makes Law C-3
// free: a recording grows into chunks during capture, and on stop the SAME
// chunks are the playback buffer — no copy, no file round-trip. Loaded files
// fill chunks the same way (render detached), so playback has ONE path.
//
// The committed length (`frames`) and loop spec are seqlock/atomic-published so
// the render thread never observes a torn or mid-growth value.
#pragma once

#include "sl_source_ring.h"

#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <mutex>
#include <vector>

namespace scoopyloops { class NativeBusStretcher; }

namespace sl {

inline constexpr uint32_t kMaxTapes = 8;
// ~1M frames/chunk → 8 MB per stereo chunk. The cap below is enforced in
// FRAMES by the recorder, independent of chunk size.
inline constexpr uint64_t kTapeChunkFrames = 1u << 20;

// D-WZ-DECK-01: 256 MB per tape, so total RAM stays bounded and predictable.
// ONE named constant — the donor computed this literal in two places
// (wz_engine.cpp:718 and :739) with nothing tying them together, which is a
// divergence waiting to happen.
inline constexpr uint64_t kTapeRecordCapBytes = 256ull * 1024ull * 1024ull;

/** The cap in frames for a given channel count (float32 samples).
    Stereo: 33,554,432 frames = 11 min 39 s at 48 kHz. Mono: twice that.
    (Noted because the prose in several specs quotes the MONO figure as if it
    were the stereo one.) */
inline constexpr uint64_t tapeCapFrames(uint32_t channels) {
    return kTapeRecordCapBytes / (static_cast<uint64_t>(channels > 0 ? channels : 1u) * 4ull);
}

// Matches schema DECK_BLOCK_FIELDS 'state' values — the UI reads these numbers.
enum class TapeState : uint32_t { idle = 0, looping = 1, oneShot = 2, recording = 3 };

/** Where a tape's recording comes from.

    This is the one place the transplant is NOT 1:1. Wizard's deck could only
    record DEVICE INPUT CHANNELS (`recSrcChan0/1` index the render's `in_bus`),
    but STRIP-MODEL's whole closing argument is that recording is always
    "capture this strip's channel bus" — identical for a grid's sequencer
    output, a live input or a file. That needs a source KIND, and it has to be
    designed in rather than retrofitted, because the capture point differs per
    kind and the Law C-3 handoff sits right next to it.

    `channelBus` is deliberately NOT declared until the channel exists (step 2
    of the P2 plan); ABI.md's rule is to declare only what is implemented. */
enum class RecordSourceKind : uint32_t {
    deviceInput = 0, // chan0 = L/mono, chan1 = R or -1. Wizard's behaviour.
    mainMix = 1,     // the engine's main L/R after everything — "what left the app"
    channelBus = 2,  // chan0 = a CHANNEL index: that strip's post-level output
};

struct TapeChunk {
    std::vector<std::vector<float>> plane; // channels × kTapeChunkFrames
    void alloc(uint32_t channels) {
        plane.assign(channels, std::vector<float>(static_cast<size_t>(kTapeChunkFrames), 0.0f));
    }
};

struct Tape {
    // --- chunked storage (pointers stable; control-thread grows) -------------
    std::vector<std::unique_ptr<TapeChunk>> chunks;
    /** ATOMIC because the control thread sets it (reset, at load/record-start)
        while the render is reading it to decide mono-vs-stereo. Read once per
        block per tape, so the cost is nil. */
    std::atomic<uint32_t> channels{0};
    std::atomic<uint64_t> frames{0};      // committed length (atomic: record grows it)
    std::atomic<uint32_t> chunkCount{0};  // chunks the render may read

    // --- control → render ----------------------------------------------------
    std::atomic<uint32_t> state{0};        // TapeState
    std::atomic<uint32_t> pendingReset{0}; // retrigger/start: seek region start next block
    // Scrub mailbox (turntable-style dragging). -1 = nothing pending; otherwise
    // the frame the render thread should jump to at the top of the next block.
    // Same discipline as pendingReset: the control thread only ever STORES, the
    // render thread exchanges it away, so no lock and no torn read.
    std::atomic<int64_t> pendingSeek{-1};

    // OVERDUB (D-WZ-OVERDUB-01): the tape keeps PLAYING its loop while input is
    // summed into the same buffer at the playhead. Not a TapeState, deliberately
    // — the tape really is still `looping`, and playback must not stop.
    std::atomic<uint32_t> overdub{0};
    /** How a punch writes into existing material:
        0 = SUM   (sound-on-sound, D-WZ-OVERDUB-01)
        1 = REPLACE (erase and write — the material under the playhead is gone)
        INSERT is deliberately absent: splicing changes the buffer LENGTH, which
        means allocating and moving audio, and neither is allowed on the render
        thread. It has to be a control-thread splice at stop, not a live mode. */
    std::atomic<uint32_t> overdubMode{0};

    // --- TAPE SCRUB (turntable): position drives, RATE is derived -----------
    // The control thread posts only where the finger is; the render thread works
    // out how fast to travel to get there this block. That single mechanism
    // yields both behaviours at once — moving the hand faster opens a bigger gap,
    // which becomes a higher rate, which IS the pitch bend. Deriving rate from
    // pixels instead (the reference implementation's approach) makes rate and
    // position disagree as soon as the view is zoomed.
    std::atomic<uint32_t> scrubActive{0};
    std::atomic<double> scrubTarget{0.0};  // where the finger is, in frames
    double scrubRate = 0.0;                // render-side smoothed travel rate
    double scrubGain = 0.0;                // 0..1 ramp position (raised-cosine)
    std::atomic<double> pubScrubRate{0.0}; // published for the UI
    std::atomic<double> rate{1.0};         // signed varispeed; <0 = reverse

    // Seqlock loop spec (writer: control thread; reader: render, once per block).
    std::atomic<uint32_t> loopSeq{0};
    uint32_t loopEnabled = 0;
    uint64_t loopStart = 0;
    uint64_t loopEnd = 0;

    // --- recording -----------------------------------------------------------
    RecordSourceKind recSrcKind = RecordSourceKind::deviceInput;
    int32_t recSrcChan0 = -1; // engine input channel recorded (L / mono)
    int32_t recSrcChan1 = -1; // R (-1 = mono)
    /** LAW C-2's stamp: the engine sample capture began at.
        ATOMIC, and this one matters. The RENDER writes it (it alone knows the
        exact block capture started on) and the CONTROL thread reads it —
        `recordStop` returns it, and it becomes the take's `TimeReference` and
        sidecar. A torn or stale read here is not a crash; it is a take that
        claims the wrong position in the session, which is precisely the failure
        the whole stamp chain exists to prevent. */
    std::atomic<uint64_t> recStartSample{0};
    uint64_t recCapFrames = 0;   // 256 MB/tape in frames (D-WZ-DECK-01)
    std::atomic<uint32_t> recCapReached{0};

    // --- timeStretch (P3-2b-5, TAPE-STRETCH.md) ------------------------------
    /** 0 timePitch (varispeed — the default) · 1 timeStretch. The MODE decides
        what the one rate number drives, `applyDeckParams`' shape. */
    std::atomic<uint32_t> tempoMode{0};
    /** Installed by TapeBank::setTempoMode (control thread), read by render.
        NEVER deleted while the bank lives — a retire path for a 2-channel idle
        object is the chunk machinery again for no audible gain, so stretchers
        are allocated once per tape and freed with the bank (spec amendment,
        recorded in TAPE-STRETCH.md). */
    std::atomic<scoopyloops::NativeBusStretcher*> stretch{nullptr};
    // Render-owned stretch state.
    double stretchInFrac = 0.0; // fractional input-frame carry across blocks
    uint32_t stretchOn = 0;     // previous block's effective path (edge detect)

    // --- render-owned ---------------------------------------------------------
    double playhead = 0.0;
    double smRate = 0.0; // D-WZ-RAMP-01-smoothed rate; 0 = seed from target
    // CUE POINT (D-WZ-SCRUBCUE-01). Where you last scrubbed or seeked to, armed
    // for exactly ONE trigger: ⟳ fires from here, and the loop wrap after it
    // returns to the region entry. That is what makes "scrub to the drop, hit
    // play" work without a second permanent start point to keep track of.
    // -1 = nothing armed. Render-owned, like the playhead it shadows.
    double cueFrame = -1.0;

    // --- render → UI (HotFrame tape block) ------------------------------------
    std::atomic<double> pubPlayhead{0.0};

    /** Read one sample. RT-safe: chunk pointers are stable up to chunkCount.

        THE NULL CHECK IS LOAD-BEARING, not defensive noise. reset() publishes
        `chunkCount = 0` before it touches the storage, but a render that read
        the count a moment earlier is still walking the vector — and reset()
        MOVES each unique_ptr out to the retire list, which leaves NULLS behind.
        The retire fixed reading freed memory; it did not stop reading a
        nulled slot. One block of silence is the right answer for a tape whose
        material is being replaced anyway.

        ⚠️ This makes the window survivable, not absent: the vector itself is
        still being structurally modified while the render indexes it. Closing
        that properly means the render ADOPTING new storage via an atomic
        pointer rather than the control thread mutating shared storage — a
        design change, noted in P2-KICKOFF rather than smuggled in here. */
    float sample(uint32_t ch, uint64_t frame) const {
        const uint64_t ci = frame / kTapeChunkFrames;
        if (ci >= chunkCount.load(std::memory_order_acquire)) return 0.0f;
        // data(), NOT operator[]/size(): the published bound is chunkCount, and
        // reading the vector's own size member here would race the control
        // thread's push_back (whose growth never moves data() — reserve in
        // reset + the never-reallocate guard in ensureCapacity). TSan-verified
        // on the deck twin (recorder_drain_test).
        const TapeChunk* c = chunks.data()[ci].get();
        if (c == nullptr) return 0.0f;
        const uint64_t off = frame % kTapeChunkFrames;
        const auto& p = c->plane;
        return ch < p.size() ? p[ch][off] : p[0][off];
    }

    // Linear interpolation between two frames. Only reached when the rate is NOT
    // exactly ±1 — the identity path never calls this, so a tape at unity is
    // bit-exact by construction.
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
        const uint64_t ci = frame / kTapeChunkFrames;
        if (ci >= chunkCount.load(std::memory_order_acquire)) return false;
        TapeChunk* chunk = chunks.data()[ci].get(); // see sample()
        if (chunk == nullptr) return false;
        const uint64_t off = frame % kTapeChunkFrames;
        auto& p = chunk->plane;
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
        const uint64_t ci = frame / kTapeChunkFrames;
        if (ci >= chunkCount.load(std::memory_order_acquire)) return false;
        TapeChunk* chunk = chunks.data()[ci].get(); // see sample()
        if (chunk == nullptr) return false;
        const uint64_t off = frame % kTapeChunkFrames;
        auto& p = chunk->plane;
        for (uint32_t c = 0; c < channels; ++c) {
            const float v = c < nVals ? chanVals[c] : (nVals > 0 ? chanVals[0] : 0.0f);
            p[c][off] += v;
        }
        return true;
    }

    // Control thread: ensure at least `neededFrames` of chunk capacity exists
    // (allocates whole chunks). Call ahead of where the render is writing.
    /** Grow the chunk list to hold `neededFrames`. Control/service thread, and
        it runs WHILE the render is reading earlier chunks — that is the whole
        design (the service thread allocates ahead of the write head so the RT
        append never allocates).

        WHICH IS WHY IT MUST NEVER REALLOCATE THE VECTOR. The header above says
        "chunk pointers never move", and that is true of the TapeChunk objects —
        they are heap-allocated and stable. It is NOT automatically true of the
        std::vector holding the unique_ptrs: a push_back past capacity moves that
        array and frees the old one, while the render is dereferencing
        `chunks[ci]` through exactly that array. Reserving up front (see reset)
        is what makes the claim actually hold.

        If the reservation is somehow exhausted this REFUSES to grow rather than
        reallocating. Recording then stops at the allocated bound, which is the
        same graceful stop the 256 MB cap produces — a bounded take instead of a
        crash on the audio thread. */
    void ensureCapacity(uint64_t neededFrames) {
        uint64_t haveFrames = static_cast<uint64_t>(chunks.size()) * kTapeChunkFrames;
        while (haveFrames < neededFrames) {
            if (chunks.size() >= chunks.capacity()) break; // never reallocate
            auto c = std::make_unique<TapeChunk>();
            c->alloc(channels);
            chunks.push_back(std::move(c));
            haveFrames += kTapeChunkFrames;
            chunkCount.store(static_cast<uint32_t>(chunks.size()), std::memory_order_release);
        }
    }

    /** Drop this tape's material. Control thread.

        TWO THINGS HERE ARE LOAD-BEARING, and the obvious implementation gets
        both wrong (the donor did, and so did the first cut of this port).

        1. PUBLISH "no chunks" BEFORE the storage goes anywhere. The render's
           sample() bounds-checks against `chunkCount` and then dereferences
           `chunks[ci]`. Clearing first and publishing after leaves a window
           where the render passes the check with a stale non-zero count and
           then reads freed memory.

        2. RETIRE, do not free. Even with the publish first, a render that is
           already PAST the bounds check still holds a pointer. Handing the
           storage to `retireSink` keeps it valid — that render reads one block
           of stale audio, which is harmless, instead of reading a dangling
           pointer, which is not. The caller frees the sink later, once a block
           boundary has provably passed.

        This is reachable in ordinary use: recordStart() resets, and recording
        over a loop that is currently playing is a normal gesture.

        `reserveFrames` is the most this tape could hold before the next reset —
        the file's length for a load, the record cap for a capture. The chunk
        list is reserved for it HERE, while the list is empty and `chunkCount`
        is already 0 so no render can be walking it. That reservation is what
        lets ensureCapacity() append later, concurrently with the render,
        without ever reallocating the array the render is reading through. */
    void reset(uint32_t ch, std::vector<std::unique_ptr<TapeChunk>>& retireSink,
               uint64_t reserveFrames) {
        chunkCount.store(0, std::memory_order_release); // (1)
        frames.store(0, std::memory_order_relaxed);
        for (auto& c : chunks)                          // (2)
            if (c != nullptr) retireSink.push_back(std::move(c));
        chunks.clear();
        // +1 for the partial chunk at the end, +1 of slack so a rounding
        // disagreement anywhere can never turn into a reallocation.
        chunks.reserve(static_cast<size_t>(reserveFrames / kTapeChunkFrames) + 2u);
        channels.store(ch, std::memory_order_release);
        recCapReached.store(0, std::memory_order_relaxed);
        // NOTE what is NOT touched here: playhead, smRate and cueFrame are
        // RENDER-OWNED. Clearing them from the control thread races a render
        // that is still advancing the playhead of the loop being recorded over.
        // The render clears them itself when it picks the arm up (beginBlock),
        // which is also the moment they actually need to be zero.
    }

    /** The render-owned half of a reset. Called ON the render thread, either at
        arm pickup or by a caller that has detached the render (load). */
    void resetPlayState() {
        playhead = 0.0;
        smRate = 0.0;
        cueFrame = -1.0; // new material, no cue
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

/** The bank of tapes plus everything the render needs to run them.

    Owns the per-tape output scratch, the per-tape crash-safe drain rings and
    the interleaved capture staging buffer, all sized once at configure() so no
    render phase ever allocates.

    RENDER IS FIVE PHASES, not one call, because the tape's sources and sinks
    live at different points in the block and pretending otherwise is what
    creates hidden one-block delays:

      1. beginBlock()      — arm transitions + the Law C-3 handoff. MUST run
                             before playback so a tape that stopped-with-loop
                             plays what it just captured in this same block.
      2. captureInputs()   — capture tapes whose source is a device input; that
                             signal is available before anything renders.
      3. renderPlayback()  — every playing/scrubbing tape advances once, into
                             its own scratch.
      4. mixInto()         — sum the tape scratch into the output lanes.
      5. captureMix()      — capture tapes whose source is the main mix, which
                             only exists after (4).

    Splitting 2 from 5 is what makes a mix-sourced take stamp HONESTLY: it
    captures this block's mix under this block's stamp, where a single top-of-
    block pass would have had to read the previous block and be ~10 ms early
    (the error flagged in docs/archive/pd-global-record-as-strip.md §1). */
class TapeBank {
public:
    /** Size all scratch for (rate, block). Safe to call again on reconfigure;
        tape MATERIAL is untouched, because a rate change must not silently
        discard a take. */
    void configure(double sampleRate, uint32_t maxBlockFrames);

    Tape& at(uint32_t tape) { return tapes_[tape]; }
    const Tape& at(uint32_t tape) const { return tapes_[tape]; }
    static constexpr uint32_t count() { return kMaxTapes; }

    // --- control surface (message thread) ------------------------------------
    // Each entry point range-checks and returns harmlessly, so the C ABI above
    // it stays a thin forwarder.

    int32_t load(uint32_t tape, uint32_t channels, uint64_t frames,
                 const float* const* data, double rate);
    uint64_t frames(uint32_t tape) const;
    uint32_t channels(uint32_t tape) const;
    void trigger(uint32_t tape, uint32_t mode);
    void seek(uint32_t tape, uint64_t frame);
    double playhead(uint32_t tape) const;
    int32_t insert(uint32_t tape, uint64_t at, uint32_t channels,
                   uint64_t frames, const float* const* planar, double sampleRate);
    void overdubStart(uint32_t tape, uint32_t mode);
    void overdubStop(uint32_t tape);
    void scrubBegin(uint32_t tape);
    void scrubTo(uint32_t tape, double frame);
    void scrubEnd(uint32_t tape);
    void setLoop(uint32_t tape, uint32_t enabled, uint64_t start, uint64_t end);
    uint32_t waveform(uint32_t tape, uint32_t channel, uint64_t startFrame,
                      uint64_t endFrame, uint32_t columns,
                      float* outMin, float* outMax) const;
    void setRate(uint32_t tape, double rate);
    double rate(uint32_t tape) const;
    /** timeStretch (P3-2b-5, TAPE-STRETCH.md): 0 timePitch · 1 timeStretch.
        Entering 1 lazily allocates + configures this tape's stretcher with an
        ASYNC warm-up — the render stays dry until `isWarm()`, which the
        latency policy absorbs (stretch engages on a tempo intent, not a
        deadline). Control thread. */
    void setTempoMode(uint32_t tape, uint32_t mode);
    uint32_t tempoMode(uint32_t tape) const;
    /** Introspection for the fixture (and one day a UI lamp): allocated AND
        warm — the block after this reads 1, the wet path is reachable. */
    uint32_t stretchReady(uint32_t tape) const;
    uint32_t state(uint32_t tape) const;
    uint32_t capReached(uint32_t tape) const;

    int32_t setRecordSource(uint32_t tape, uint32_t kind, int32_t chan0, int32_t chan1);
    void recordStart(uint32_t tape);
    uint64_t recordStop(uint32_t tape);
    void setRecordCapFrames(uint32_t tape, uint64_t capFrames);
    /** Service thread: keep chunk allocation AHEAD of the render write head, so
        the RT append never touches an unallocated chunk and never allocates. */
    void recordService();
    uint32_t drain(uint32_t tape, float* out, uint32_t capacityFrames,
                   uint64_t* outStartSample);

    // --- render phases (audio thread) ----------------------------------------
    void beginBlock(uint64_t blockStartSample);

    /** Which tapes completed the Law C-3 record→loop handoff in the block
        beginBlock() just opened, as a bitmask, CONSUMED by the read.

        Exists so D-WZ-MON-02 can be honoured exactly: at the handoff the deck's
        own monitor switch closes, because input + loop together the instant a
        loop closes is doubling rather than information. The tape cannot do that
        itself — it knows nothing about channels — so the ENGINE reads this
        between phase 1 and phase 5 and closes the monitor of whichever channel
        carries the tape, which lands the close in the SAME BLOCK the loop starts.

        Only the record-stop→looping transition sets a bit. Overdub never does,
        and that is not an oversight: overdub layers onto an already-looping tape
        without passing through this handoff, so "overdub keeps the switch open"
        falls out of the structure instead of needing a flag to remember. */
    uint32_t consumeLoopHandoffs();

    /** What this tape would capture. The engine needs it to decide whether a
        record-start should open the monitor — you monitor an INPUT you are
        capturing, not the main mix (which is already audible by definition, and
        monitoring it would be a loop). */
    uint32_t recordSourceKind(uint32_t tape) const;
    void captureInputs(const float* const* inBus, uint32_t inCount, uint32_t frames,
                       double sampleRate, uint64_t blockStartSample);
    void renderPlayback(const float* const* inBus, uint32_t inCount, uint32_t frames,
                        double sampleRate, uint64_t blockStartSample);
    /** A tape's rendered output for this block. The CHANNEL reads these and
        does the mixing (sl_channel.h) — a tape has no level of its own, exactly
        as a tape machine has no fader of its own. nullptr if out of range. */
    const float* outL(uint32_t tape) const;
    const float* outR(uint32_t tape) const;

    void captureMix(const float* mainL, const float* mainR, uint32_t frames,
                    double sampleRate, uint64_t blockStartSample);
    /** Capture tapes whose source is a CHANNEL BUS, from that channel's
        post-level output. Runs after the channels have mixed, so the take is
        this block's channel output under this block's stamp — the same
        same-block honesty the mainMix capture has. `channelOut` resolves a
        channel index to its interleaved-free L/R pair; a channel that does not
        exist captures silence rather than a neighbour's audio. */
    void captureChannels(uint32_t frames, double sampleRate, uint64_t blockStartSample,
                         const class ChannelBank& channels);

private:
    /** The ONE capture path, shared by every source kind (STRIP-MODEL: "one
        tap, one code path, every source"). Appends `frames` of {srcL, srcR}
        into the tape, enforces the cap, and mirrors the same samples into the
        crash-safe drain. */
    void captureFrom(uint32_t tapeIndex, const float* srcL, const float* srcR,
                     uint32_t frames, double sampleRate, uint64_t blockStartSample);

    /** Free any retired chunk storage whose block has provably passed, then
        return the sink for a fresh retirement. Control thread only, which is
        what keeps `retired_` free of its own synchronisation — load() and
        recordStart() are both message-thread entry points. */
    std::vector<std::unique_ptr<TapeChunk>>& retireSink();

    Tape tapes_[kMaxTapes];
    // Chunk storage handed over by Tape::reset, kept alive until a render block
    // boundary has passed (see reset's comment). Freed on the NEXT reset, which
    // in practice is many blocks later — you cannot press record faster than
    // the audio thread runs.
    std::vector<std::unique_ptr<TapeChunk>> retired_;
    uint64_t retiredAtBlock_ = 0;
    /** Serialises the two NON-AUDIO threads that both mutate chunk storage:
        the message thread (load / insert / recordStart) and the service thread
        (recordService growing the buffer ahead of the write head). Nothing
        synchronised them before, so a record-start could clear and re-reserve
        the very vector the service thread was pushing into.

        THE RENDER NEVER TAKES THIS. It reads through `chunkCount` and the
        reservation guarantee instead, so there is no lock on the audio thread
        and no priority inversion — the mutex exists purely to make two
        background threads agree. */
    mutable std::mutex chunkMutex_;
    // Counts render blocks, so the control thread can tell that the audio
    // thread has moved on since a retirement.
    std::atomic<uint64_t> renderBlock_{0};

    /** Tapes that handed off to looping in the current block (see
        consumeLoopHandoffs). Written by the render, read and cleared by the
        render one phase later — atomic only because it crosses the phase
        boundary through a public getter. */
    std::atomic<uint32_t> loopHandoffs_{0};
    std::vector<float> outL_[kMaxTapes];
    std::vector<float> outR_[kMaxTapes];
    SourceRing drain_[kMaxTapes];
    std::vector<float> recScratch_;  // interleaved capture staging (maxBlock × 2)
    std::atomic<uint32_t> recArm_[kMaxTapes]; // control→render: 1 = start, 2 = stop
    uint32_t maxBlockFrames_ = 0;

    // --- timeStretch (P3-2b-5) ----------------------------------------------
    // Owned here, PUBLISHED to the render via Tape::stretch (atomic pointer),
    // and never freed while the bank lives — see the field's comment.
    std::unique_ptr<scoopyloops::NativeBusStretcher> stretchers_[kMaxTapes];
    // Per-tape input staging: the unity-read source stream. Sized for the
    // |rate| ≤ 16 clamp (maxBlock × 16 + slack) when the stretcher is made.
    std::vector<float> stretchInL_[kMaxTapes], stretchInR_[kMaxTapes];
    // Shared per-block scratch for the engage/disengage crossfade (the render
    // walks tapes serially, so one pair each suffices).
    std::vector<float> stretchDryL_, stretchDryR_, stretchWetL_, stretchWetR_;
    double sampleRate_ = 0.0;
};

} // namespace sl
