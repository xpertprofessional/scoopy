// The TAPE unit — SL-ABI-V3 §5. Transplanted from wizard's wz_engine.cpp deck
// passes (record 852–917, playback 954–1190) and deck control surface (463–770),
// which is a donor, not a survivor: the semantics arrive with their
// comments-of-record intact and the wz_ names do not.
#include "sl_tape.h"

#include "sl_channel.h"
#include "NativeBusStretcher.hpp" // timeStretch (P3-2b-5) — reused as-is, 2ch

#include <algorithm>
#include <cmath>
#include <memory>
#include <vector>

namespace sl {
namespace {

constexpr double kPi = 3.14159265358979323846;
constexpr double kRampSeconds = 0.010; // D-WZ-RAMP-01: one 10 ms constant

// Raised-cosine shape over ramp position r ∈ [0,1] (D-WZ-RAMP-01): 0 = closed,
// 1 = open, smooth at both ends.
inline double rampShape(double r) { return 0.5 * (1.0 - std::cos(kPi * r)); }

// Advance a ramp position toward `target` (0 or 1) by one sample step.
inline double rampStep(double r, double target, double step) {
    if (r < target) return std::min(target, r + step);
    if (r > target) return std::max(target, r - step);
    return r;
}

inline double sanitize(float s) {
    return std::isfinite(s) ? static_cast<double>(s) : 0.0; // NaN/Inf squelched at the tape input
}

} // namespace

void TapeBank::configure(double sampleRate, uint32_t maxBlockFrames) {
    sampleRate_ = sampleRate; // the stretchers need the real rate (P3-2b-5)
    maxBlockFrames_ = maxBlockFrames;
    // Crossfade scratch for the stretch engage/disengage transitions. Shared:
    // the render walks tapes serially.
    stretchDryL_.assign(maxBlockFrames, 0.0f);
    stretchDryR_.assign(maxBlockFrames, 0.0f);
    stretchWetL_.assign(maxBlockFrames, 0.0f);
    stretchWetR_.assign(maxBlockFrames, 0.0f);
    for (uint32_t t = 0; t < kMaxTapes; ++t) {
        outL_[t].assign(maxBlockFrames, 0.0f);
        outR_[t].assign(maxBlockFrames, 0.0f);
        recArm_[t].store(0u, std::memory_order_relaxed);
    }
    // NOTE the drain rings are NOT sized here. A ring's channel count must
    // equal the tape's, and configure() does not know it — so the rings are
    // init'd at load() and recordStart(), the two places material (and with it
    // a channel count) comes into existence. Guessing a width here is how an
    // earlier cut of this port ended up writing stereo-width frames out of a
    // mono tape and overflowing the caller's drain buffer.
    // Interleaved capture staging, wide enough for the stereo case.
    recScratch_.assign(static_cast<size_t>(maxBlockFrames) * 2u, 0.0f);
}

/* --- control surface (message thread) ------------------------------------- */

int32_t TapeBank::load(uint32_t tape, uint32_t channels, uint64_t frameCount,
                       const float* const* data, double rate) {
    if (tape >= kMaxTapes || channels == 0 || frameCount == 0 || data == nullptr || rate <= 0.0)
        return 0;
    for (uint32_t c = 0; c < channels; ++c)
        if (data[c] == nullptr) return 0;
    std::lock_guard<std::mutex> lock(chunkMutex_);
    Tape& d = tapes_[tape];
    // NOT RT-safe: the host detaches the render callback around this call. Fill
    // the same chunked storage a recording uses, so playback has one path and
    // the Law C-3 handoff is a no-op on representation.
    d.state.store(static_cast<uint32_t>(TapeState::idle), std::memory_order_relaxed);
    d.reset(channels, retireSink(), frameCount); // reserve for exactly this file
    d.ensureCapacity(frameCount);
    for (uint64_t f = 0; f < frameCount; ++f) {
        const uint64_t ci = f / kTapeChunkFrames, off = f % kTapeChunkFrames;
        for (uint32_t c = 0; c < channels; ++c)
            d.chunks[ci]->plane[c][off] = data[c][f];
    }
    d.frames.store(frameCount, std::memory_order_release);
    d.pubPlayhead.store(0.0, std::memory_order_relaxed);
    d.publishLoop(0, 0, 0); // whole-buffer region until the document says otherwise
    // Size the drain to THIS material's width. Loaded material can be overdubbed
    // (a tape is a tape), and every overdub pass drains to its own take — so a
    // tape that has never recorded still needs a correctly-shaped ring. The
    // donor only ever sized it in record_start, which left exactly this path
    // writing into a zero-capacity ring.
    drain_[tape].init("tapedrain", channels, 1u << 18);
    return 1;
}

uint64_t TapeBank::frames(uint32_t tape) const {
    if (tape >= kMaxTapes) return 0;
    return tapes_[tape].frames.load(std::memory_order_acquire);
}

uint32_t TapeBank::channels(uint32_t tape) const {
    if (tape >= kMaxTapes) return 0;
    return tapes_[tape].channels.load(std::memory_order_acquire);
}

void TapeBank::seek(uint32_t tape, uint64_t frame) {
    if (tape >= kMaxTapes) return;
    // Control thread: post the target and return. The render thread applies it
    // at the top of its next block, so a scrub drag never races the reader.
    tapes_[tape].pendingSeek.store(static_cast<int64_t>(frame), std::memory_order_release);
}

double TapeBank::playhead(uint32_t tape) const {
    if (tape >= kMaxTapes) return 0.0;
    return tapes_[tape].pubPlayhead.load(std::memory_order_relaxed);
}

uint32_t TapeBank::state(uint32_t tape) const {
    if (tape >= kMaxTapes) return 0;
    return tapes_[tape].state.load(std::memory_order_acquire);
}

uint32_t TapeBank::capReached(uint32_t tape) const {
    if (tape >= kMaxTapes) return 0;
    return tapes_[tape].recCapReached.load(std::memory_order_relaxed);
}

int32_t TapeBank::insert(uint32_t tape, uint64_t at, uint32_t channels,
                         uint64_t frameCount, const float* const* planar, double sampleRate) {
    if (tape >= kMaxTapes || planar == nullptr || frameCount == 0) return 0;
    Tape& d = tapes_[tape];
    const uint64_t oldLen = d.frames.load(std::memory_order_acquire);
    if (oldLen == 0) return 0;              // nothing to insert INTO — that is a load
    const uint32_t ch = d.channels.load(std::memory_order_acquire); // the tape's own count wins
    const uint64_t newLen = oldLen + frameCount;
    // The ONE operation that lengthens a tape, so the cap is checked HERE rather
    // than assumed (D-WZ-DECK-01).
    if (d.recCapFrames != 0 && newLen > d.recCapFrames) return 0;
    const uint64_t clampedAt = at < oldLen ? at : oldLen;

    // Read the tape out, splice, and rebuild. Allocation is legal here: this is
    // the control thread, and the caller has detached the render (as for load)
    // — the chunk storage is being replaced underneath.
    std::vector<std::vector<float>> merged(ch, std::vector<float>(static_cast<size_t>(newLen), 0.0f));
    for (uint32_t c = 0; c < ch; ++c) {
        for (uint64_t i = 0; i < clampedAt; ++i)
            merged[c][static_cast<size_t>(i)] = d.sample(c, i);
        for (uint64_t i = 0; i < frameCount; ++i) {
            // A mono source fans out; extra source channels are ignored.
            const float* src = planar[c < channels ? c : 0];
            merged[c][static_cast<size_t>(clampedAt + i)] = src != nullptr ? src[i] : 0.0f;
        }
        for (uint64_t i = clampedAt; i < oldLen; ++i)
            merged[c][static_cast<size_t>(frameCount + i)] = d.sample(c, i);
    }

    // load REBUILDS the tape, which resets its transport — so a splice would
    // silently stop the loop you were listening to. Carry the playing state, the
    // playhead and the loop region across it instead.
    const uint32_t keepState = d.state.load(std::memory_order_acquire);
    const double keepPlayhead = d.playhead;
    uint32_t le = 0; uint64_t ls = 0, lend = 0;
    d.readLoop(le, ls, lend);

    std::vector<const float*> ptrs(ch);
    for (uint32_t c = 0; c < ch; ++c) ptrs[c] = merged[c].data();
    if (load(tape, ch, newLen, ptrs.data(), sampleRate) != 1) return 0;

    // Audio AFTER the splice point moved later by exactly `frameCount`, so
    // anything pointing into it must move with it or it now points at different
    // sound.
    const auto shift = [&](uint64_t v) { return v >= clampedAt ? v + frameCount : v; };
    if (le != 0)
        setLoop(tape, 1u, shift(ls),
                // A region that CONTAINED the splice point grows to include the
                // new material — the loop you were playing now has the inserted
                // part in it, which is the point of inserting into a loop.
                lend >= clampedAt ? lend + frameCount : lend);
    d.playhead = keepPlayhead >= static_cast<double>(clampedAt)
                     ? keepPlayhead + static_cast<double>(frameCount)
                     : keepPlayhead;
    d.state.store(keepState, std::memory_order_release);
    return 1;
}

void TapeBank::overdubStart(uint32_t tape, uint32_t mode) {
    if (tape >= kMaxTapes) return;
    Tape& d = tapes_[tape];
    // Overdub layers INTO existing material; with nothing there it would just be
    // a recording, which is what the record verb is for.
    if (d.frames.load(std::memory_order_acquire) == 0) return;
    // Never while capturing a fresh take: that path appends and grows.
    if (d.state.load(std::memory_order_acquire) == static_cast<uint32_t>(TapeState::recording))
        return;
    // Overdub reads its input during the PLAYBACK pass, which runs before the
    // mix exists — so a mainMix-sourced overdub could only ever layer the
    // PREVIOUS block, silently ~10 ms early against a take that is sample-exact.
    // Refuse rather than fake it; live-input layering is what D-WZ-OVERDUB-01
    // describes, and bus-sourced overdub can arrive honestly once the channel
    // model gives it a current-block source.
    if (d.recSrcKind != RecordSourceKind::deviceInput) return;
    d.overdubMode.store(mode, std::memory_order_relaxed);
    d.overdub.store(1, std::memory_order_release);
}

void TapeBank::overdubStop(uint32_t tape) {
    if (tape >= kMaxTapes) return;
    tapes_[tape].overdub.store(0, std::memory_order_release);
}

void TapeBank::scrubBegin(uint32_t tape) {
    if (tape >= kMaxTapes) return;
    Tape& d = tapes_[tape];
    // Recording owns the playhead; a scrub must not move the write head.
    if (d.state.load(std::memory_order_acquire) == static_cast<uint32_t>(TapeState::recording))
        return;
    d.scrubTarget.store(d.pubPlayhead.load(std::memory_order_relaxed), std::memory_order_relaxed);
    d.scrubActive.store(1, std::memory_order_release);
}

void TapeBank::scrubTo(uint32_t tape, double frame) {
    if (tape >= kMaxTapes) return;
    tapes_[tape].scrubTarget.store(frame < 0.0 ? 0.0 : frame, std::memory_order_relaxed);
}

void TapeBank::scrubEnd(uint32_t tape) {
    if (tape >= kMaxTapes) return;
    tapes_[tape].scrubActive.store(0, std::memory_order_release);
}

void TapeBank::trigger(uint32_t tape, uint32_t mode) {
    if (tape >= kMaxTapes) return;
    Tape& d = tapes_[tape];
    switch (mode) {
        case 0: // loop
            d.pendingReset.store(1, std::memory_order_relaxed);
            d.state.store(static_cast<uint32_t>(TapeState::looping), std::memory_order_release);
            break;
        case 1: // oneShot
            d.pendingReset.store(1, std::memory_order_relaxed);
            d.state.store(static_cast<uint32_t>(TapeState::oneShot), std::memory_order_release);
            break;
        case 2: // stop
            d.state.store(static_cast<uint32_t>(TapeState::idle), std::memory_order_release);
            break;
        case 3: { // retrigger: seek region start; from idle it starts a oneShot
            d.pendingReset.store(1, std::memory_order_relaxed);
            const auto st = d.state.load(std::memory_order_relaxed);
            if (st == static_cast<uint32_t>(TapeState::idle))
                d.state.store(static_cast<uint32_t>(TapeState::oneShot), std::memory_order_release);
            break;
        }
        default: break; // unknown mode ignored
    }
}

void TapeBank::setLoop(uint32_t tape, uint32_t enabled, uint64_t start, uint64_t end) {
    if (tape >= kMaxTapes) return;
    tapes_[tape].publishLoop(enabled, start, end);
}

uint32_t TapeBank::waveform(uint32_t tape, uint32_t channel, uint64_t startFrame,
                            uint64_t endFrame, uint32_t columns,
                            float* outMin, float* outMax) const {
    if (tape >= kMaxTapes || columns == 0 || outMin == nullptr || outMax == nullptr) return 0;
    const Tape& d = tapes_[tape];
    const uint64_t len = d.frames.load(std::memory_order_acquire);
    const uint32_t dch = d.channels.load(std::memory_order_acquire);
    if (len == 0 || dch == 0) return 0;
    uint64_t s0 = startFrame < len ? startFrame : len;
    uint64_t s1 = endFrame < len ? endFrame : len;
    if (s1 <= s0) { s0 = 0; s1 = len; } // degenerate range → the whole buffer
    const uint32_t ch = channel < dch ? channel : 0u;

    const double span = static_cast<double>(s1 - s0);
    for (uint32_t c = 0; c < columns; ++c) {
        const uint64_t a = s0 + static_cast<uint64_t>(span * c / columns);
        uint64_t b = s0 + static_cast<uint64_t>(span * (c + 1) / columns);
        if (b <= a) b = a + 1;
        if (b > s1) b = s1;
        float lo = 0.0f, hi = 0.0f;
        bool first = true;
        for (uint64_t f = a; f < b; ++f) {
            const float v = d.sample(ch, f);
            if (first) { lo = hi = v; first = false; }
            else { if (v < lo) lo = v; if (v > hi) hi = v; }
        }
        outMin[c] = lo;
        outMax[c] = hi;
    }
    return columns;
}

void TapeBank::setRate(uint32_t tape, double r) {
    if (tape >= kMaxTapes) return;
    tapes_[tape].rate.store(r, std::memory_order_relaxed);
}

double TapeBank::rate(uint32_t tape) const {
    if (tape >= kMaxTapes) return 0.0;
    return tapes_[tape].rate.load(std::memory_order_relaxed);
}

/* --- timeStretch (P3-2b-5, TAPE-STRETCH.md) -------------------------------- */

void TapeBank::setTempoMode(uint32_t tape, uint32_t mode) {
    if (tape >= kMaxTapes || mode > 1u) return;
    Tape& d = tapes_[tape];
    if (mode == 1u && stretchers_[tape] == nullptr) {
        // LAZY, and configured with an ASYNC warm-up: the ~600 ms node warm-up
        // must not stall the message thread, and the render stays DRY until
        // isWarm() — which the latency policy absorbs (stretch engages on a
        // tempo intent, not a deadline).
        auto st = std::make_unique<scoopyloops::NativeBusStretcher>();
        st->configure(sampleRate_ > 0.0 ? sampleRate_ : 48000.0, 2,
                      static_cast<int>(maxBlockFrames_ > 0 ? maxBlockFrames_ : 512u),
                      /*asyncWarmup=*/true);
        // Input staging for the unity-read stream, sized for the |rate| ≤ 16
        // clamp plus carry slack.
        const size_t cap =
            static_cast<size_t>(maxBlockFrames_ > 0 ? maxBlockFrames_ : 512u) * 16u + 4u;
        stretchInL_[tape].assign(cap, 0.0f);
        stretchInR_[tape].assign(cap, 0.0f);
        // Publish LAST: a render that sees the pointer sees a configured object.
        d.stretch.store(st.get(), std::memory_order_release);
        stretchers_[tape] = std::move(st);
    }
    d.tempoMode.store(mode, std::memory_order_release);
}

uint32_t TapeBank::tempoMode(uint32_t tape) const {
    return tape >= kMaxTapes ? 0u : tapes_[tape].tempoMode.load(std::memory_order_relaxed);
}

uint32_t TapeBank::stretchReady(uint32_t tape) const {
    if (tape >= kMaxTapes) return 0u;
    auto* st = tapes_[tape].stretch.load(std::memory_order_acquire);
    return st != nullptr && st->isWarm() ? 1u : 0u;
}

/* --- recording ------------------------------------------------------------ */

int32_t TapeBank::setRecordSource(uint32_t tape, uint32_t kind, int32_t chan0, int32_t chan1) {
    if (tape >= kMaxTapes) return 0;
    if (kind > static_cast<uint32_t>(RecordSourceKind::channelBus))
        return 0; // unknown kind REFUSED, never silently treated as input 0
    if (kind == static_cast<uint32_t>(RecordSourceKind::channelBus) &&
        (chan0 < 0 || static_cast<uint32_t>(chan0) >= ChannelBank::count()))
        return 0; // a channel tap must name a channel that exists
    Tape& d = tapes_[tape];
    d.recSrcKind = static_cast<RecordSourceKind>(kind);
    d.recSrcChan0 = chan0;
    d.recSrcChan1 = chan1;
    return 1;
}

void TapeBank::recordStart(uint32_t tape) {
    if (tape >= kMaxTapes) return;
    std::lock_guard<std::mutex> lock(chunkMutex_);
    Tape& d = tapes_[tape];
    // The main mix is always stereo; a device-input source is stereo only when
    // a second channel was named.
    // A bus is always stereo; a device-input source is stereo only when a second
    // channel was named.
    const uint32_t ch = d.recSrcKind == RecordSourceKind::deviceInput
                            ? (d.recSrcChan1 >= 0 ? 2u : 1u)
                            : 2u;
    // Reset + initial capacity are control-thread work (allocation). The host
    // calls recordService() around this; here we also seed enough so the first
    // blocks never touch an unallocated chunk.
    // The cap is computed BEFORE the reset so the chunk list can be reserved
    // for the whole take up front — growth during recording happens on the
    // service thread while the render reads, so it must never reallocate.
    const uint64_t capFrames = tapeCapFrames(ch); // D-WZ-DECK-01
    d.reset(ch, retireSink(), capFrames);
    d.recCapFrames = capFrames;
    d.ensureCapacity(4u * (maxBlockFrames_ > 0 ? maxBlockFrames_ : 512u));
    // Drain ring sized for a comfortable host lag (interleaved), at THIS take's
    // width — see load() for why the width has to be set wherever material is.
    drain_[tape].init("tapedrain", ch, 1u << 18);
    // The render picks up the arm at its next block and stamps the start there,
    // so the stamp is the exact engine sample recording began.
    recArm_[tape].store(1u, std::memory_order_release);
}

uint64_t TapeBank::recordStop(uint32_t tape) {
    if (tape >= kMaxTapes) return 0;
    recArm_[tape].store(2u, std::memory_order_release); // render finalizes at its next block
    return tapes_[tape].recStartSample.load(std::memory_order_acquire);
}

void TapeBank::setRecordCapFrames(uint32_t tape, uint64_t capFrames) {
    if (tape >= kMaxTapes) return;
    Tape& d = tapes_[tape];
    if (capFrames == 0) { // restore the signed default for this tape's channels
        const uint32_t c = d.channels.load(std::memory_order_acquire);
        d.recCapFrames = tapeCapFrames(c > 0 ? c : 1u);
    } else {
        d.recCapFrames = capFrames;
    }
}

void TapeBank::recordService() {
    std::lock_guard<std::mutex> lock(chunkMutex_);
    for (uint32_t ti = 0; ti < kMaxTapes; ++ti) {
        Tape& d = tapes_[ti];
        if (d.state.load(std::memory_order_acquire) != static_cast<uint32_t>(TapeState::recording))
            continue;
        // Keep allocation AHEAD of the render write position by a few chunks, up
        // to the cap — so the RT append never hits an unallocated chunk.
        const uint64_t pos = d.frames.load(std::memory_order_acquire);
        uint64_t want = pos + 2u * kTapeChunkFrames;
        if (want > d.recCapFrames) want = d.recCapFrames;
        d.ensureCapacity(want);
    }
}

uint32_t TapeBank::drain(uint32_t tape, float* out, uint32_t capacityFrames,
                         uint64_t* outStartSample) {
    if (tape >= kMaxTapes || out == nullptr) return 0;
    if (outStartSample != nullptr) *outStartSample = tapes_[tape].recStartSample.load(std::memory_order_acquire);
    // Read only what's present — draining a partially-full ring is normal, not
    // an underrun.
    const uint64_t fill = drain_[tape].fillFrames();
    uint32_t n = capacityFrames;
    if (fill < n) n = static_cast<uint32_t>(fill);
    return n == 0 ? 0u : drain_[tape].read(out, n);
}

/* --- render phases (audio thread) ----------------------------------------- */

std::vector<std::unique_ptr<TapeChunk>>& TapeBank::retireSink() {
    // Safe to free only once the audio thread has started a LATER block than
    // the one the previous batch was retired in: any render that was mid-read
    // when it was retired has finished by then. If the engine is not rendering
    // the counter does not move and the batch simply waits — correct, and
    // bounded, because nothing can be recorded while nothing is rendering.
    if (!retired_.empty() && renderBlock_.load(std::memory_order_acquire) > retiredAtBlock_)
        retired_.clear();
    retiredAtBlock_ = renderBlock_.load(std::memory_order_acquire);
    return retired_;
}

void TapeBank::beginBlock(uint64_t blockStartSample) {
    renderBlock_.fetch_add(1, std::memory_order_release);
    uint32_t handoffs = 0;
    for (uint32_t ti = 0; ti < kMaxTapes; ++ti) {
        Tape& d = tapes_[ti];
        const uint32_t arm = recArm_[ti].exchange(0, std::memory_order_acq_rel);
        if (arm == 1u) { // start: stamp the exact engine sample capture begins
            d.recStartSample.store(blockStartSample, std::memory_order_release);
            d.resetPlayState(); // render-owned scalars, cleared on the render thread
            d.state.store(static_cast<uint32_t>(TapeState::recording), std::memory_order_release);
        } else if (arm == 2u) { // stop — THE LAW C-3 HANDOFF
            if (d.state.load(std::memory_order_relaxed) ==
                static_cast<uint32_t>(TapeState::recording)) {
                // The record buffer IS the playback buffer (same chunks, no copy,
                // no realloc, no file touch). With loop enabled the tape becomes
                // looping playback of what it just captured IN THIS BLOCK — the
                // instant turnaround. Otherwise → idle, buffer retained.
                uint32_t le = 0; uint64_t ls = 0, lend = 0;
                d.readLoop(le, ls, lend);
                const uint64_t len = d.frames.load(std::memory_order_acquire);
                if (le != 0 && len > 0) {
                    // A loop region set before/while recording is honored if it
                    // fits the captured length; otherwise the take IS the loop.
                    if (!(ls < lend && lend <= len)) d.publishLoop(1u, 0, len);
                    d.playhead = static_cast<double>(ls < lend && lend <= len ? ls : 0);
                    d.pendingReset.store(0, std::memory_order_relaxed);
                    d.state.store(static_cast<uint32_t>(TapeState::looping),
                                  std::memory_order_release);
                    // D-WZ-MON-02: the loop has replaced the live input, so the
                    // strip carrying this tape should stop monitoring — in THIS
                    // block, before anything is mixed. The tape cannot reach a
                    // channel; the engine does it one phase later, off this bit.
                    handoffs |= (1u << ti);
                } else {
                    d.state.store(static_cast<uint32_t>(TapeState::idle),
                                  std::memory_order_release);
                }
            }
        }
    }
    loopHandoffs_.store(handoffs, std::memory_order_release);
}

uint32_t TapeBank::consumeLoopHandoffs() {
    return loopHandoffs_.exchange(0u, std::memory_order_acq_rel);
}

uint32_t TapeBank::recordSourceKind(uint32_t tape) const {
    if (tape >= kMaxTapes) return 0u;
    return static_cast<uint32_t>(tapes_[tape].recSrcKind);
}

void TapeBank::captureFrom(uint32_t tapeIndex, const float* srcL, const float* srcR,
                           uint32_t frames, double sampleRate, uint64_t blockStartSample) {
    Tape& d = tapes_[tapeIndex];
    const uint32_t rch = d.channels.load(std::memory_order_acquire);
    if (rch == 0) return;
    uint64_t pos = d.frames.load(std::memory_order_relaxed);
    const uint64_t allocFrames =
        static_cast<uint64_t>(d.chunkCount.load(std::memory_order_acquire)) * kTapeChunkFrames;
    float* drs = recScratch_.data();
    uint32_t captured = 0;
    for (uint32_t i = 0; i < frames; ++i) {
        if (pos >= d.recCapFrames) { // D-WZ-DECK-01 cap → stop appending
            d.recCapReached.store(1u, std::memory_order_relaxed);
            d.state.store(static_cast<uint32_t>(TapeState::idle), std::memory_order_release);
            break;
        }
        if (pos >= allocFrames) break; // service hasn't allocated ahead (never in practice)
        float vals[2];
        vals[0] = srcL != nullptr ? static_cast<float>(sanitize(srcL[i])) : 0.0f;
        if (rch > 1) vals[1] = srcR != nullptr ? static_cast<float>(sanitize(srcR[i])) : vals[0];
        d.appendFrame(pos, vals, rch);
        for (uint32_t c = 0; c < rch; ++c)
            drs[static_cast<size_t>(captured) * rch + c] = vals[c];
        ++pos;
        ++captured;
    }
    d.frames.store(pos, std::memory_order_release); // committed length
    if (captured > 0) drain_[tapeIndex].write(drs, captured, sampleRate, blockStartSample);
}

void TapeBank::captureInputs(const float* const* inBus, uint32_t inCount, uint32_t frames,
                             double sampleRate, uint64_t blockStartSample) {
    for (uint32_t ti = 0; ti < kMaxTapes; ++ti) {
        Tape& d = tapes_[ti];
        if (d.state.load(std::memory_order_acquire) != static_cast<uint32_t>(TapeState::recording))
            continue;
        if (d.recSrcKind != RecordSourceKind::deviceInput) continue;
        const float* r0 = (inBus != nullptr && d.recSrcChan0 >= 0 &&
                           static_cast<uint32_t>(d.recSrcChan0) < inCount)
                              ? inBus[d.recSrcChan0] : nullptr;
        const float* r1 = (inBus != nullptr && d.recSrcChan1 >= 0 &&
                           static_cast<uint32_t>(d.recSrcChan1) < inCount)
                              ? inBus[d.recSrcChan1] : nullptr;
        captureFrom(ti, r0, r1, frames, sampleRate, blockStartSample);
    }
}

void TapeBank::captureMix(const float* mainL, const float* mainR, uint32_t frames,
                          double sampleRate, uint64_t blockStartSample) {
    for (uint32_t ti = 0; ti < kMaxTapes; ++ti) {
        Tape& d = tapes_[ti];
        if (d.state.load(std::memory_order_acquire) != static_cast<uint32_t>(TapeState::recording))
            continue;
        if (d.recSrcKind != RecordSourceKind::mainMix) continue;
        // THIS block's mix under THIS block's stamp. The capture runs after the
        // lanes are summed precisely so the take is sample-exact against the
        // stamp beginBlock() wrote — no borrowed previous block, no ~10 ms lie.
        //
        // The tap is post-everything, so it hears the tapes' own playback too:
        // a tape recording the main mix while looping into it is a regenerating
        // path. That is the resample-the-mix instrument, and gain staging is the
        // performer's (ROUTING-MATRIX's standing posture), not a guard here.
        captureFrom(ti, mainL, mainR, frames, sampleRate, blockStartSample);
    }
}

void TapeBank::renderPlayback(const float* const* inBus, uint32_t inCount, uint32_t frames,
                              double sampleRate, uint64_t blockStartSample) {
    const double fs = sampleRate > 0.0 ? sampleRate : 48000.0;
    // One-pole coefficient for ~10 ms settling; ramp step for the 10 ms
    // raised-cosine (both from the single D-WZ-RAMP-01 constant).
    const double alpha = 1.0 - std::exp(-1.0 / (kRampSeconds * fs));
    const double step = 1.0 / (kRampSeconds * fs);

    for (uint32_t di = 0; di < kMaxTapes; ++di) {
        Tape& d = tapes_[di];
        float* dl = outL_[di].data();
        float* dr = outR_[di].data();
        const auto st = d.state.load(std::memory_order_acquire);
        const uint64_t dFrames = d.frames.load(std::memory_order_acquire);
        const uint32_t dchan = d.channels.load(std::memory_order_acquire);
        // A recording tape's playback pass is silent (it is capturing);
        // playback resumes on the Law C-3 stop→loop.
        // A SCRUBBING tape sounds even when idle — that is what makes it a
        // turntable rather than a seek bar. Recording still refuses: the write
        // head is not the user's to drag.
        const bool scrubHeld = d.scrubActive.load(std::memory_order_acquire) != 0;
        // Keep rendering the scrub path while its gain is still ramping DOWN.
        // Without this, releasing a scrub dropped straight into the idle
        // early-out and wrote zeros on the very next sample — the fade existed in
        // the code but never actually rendered, so release CLICKED. The fixture
        // caught it; a listener would have too.
        const bool scrubbing = (scrubHeld || d.scrubGain > 0.0) && dFrames > 0 &&
                               st != static_cast<uint32_t>(TapeState::recording);

        if (!scrubbing &&
            (st == static_cast<uint32_t>(TapeState::idle) ||
             st == static_cast<uint32_t>(TapeState::recording) || dFrames == 0)) {
            // DRAIN THE SCRUB MAILBOX EVEN WHEN NOT PLAYING. Two reasons, both
            // bugs before this: a scrub on a STOPPED tape must still move the
            // visible head (otherwise dragging a stopped player does nothing at
            // all), and a request left pending here would be applied on some
            // LATER block — overriding the next trigger's reset, so ⟳ would
            // silently start from wherever you last scrubbed instead of the
            // region entry.
            const int64_t idleSeek = d.pendingSeek.exchange(-1, std::memory_order_acq_rel);
            // While RECORDING the playhead is the write head and is not the
            // user's to move: drain and discard, never apply.
            if (idleSeek >= 0 && dFrames > 0 &&
                st != static_cast<uint32_t>(TapeState::recording)) {
                const double t = static_cast<double>(idleSeek);
                d.playhead = t < static_cast<double>(dFrames) ? t
                                                              : static_cast<double>(dFrames - 1);
                // Arm the cue here too (D-WZ-SCRUBCUE-01). Scrubbing a STOPPED
                // tape is the most common way to set one — you park the head
                // where you want the next ⟳ to fire — so the stopped path must
                // arm it exactly like the playing path does.
                d.cueFrame = d.playhead;
            }
            for (uint32_t i = 0; i < frames; ++i) { dl[i] = 0.0f; dr[i] = 0.0f; }
            d.pubPlayhead.store(d.playhead, std::memory_order_relaxed);
            continue;
        }
        if (scrubbing) {
            // RATE IS DERIVED FROM THE GAP. Travelling the distance to the
            // finger over this block is exactly what makes pitch follow hand
            // speed: move faster, open a bigger gap, get a higher rate. One
            // mechanism, both behaviours, and no dependence on pixels or zoom.
            const double target = d.scrubTarget.load(std::memory_order_relaxed);
            // On the way out, stop chasing: coast to a halt instead of lunging
            // at a target the finger has already left.
            const double gap = scrubHeld ? target - d.playhead : 0.0;
            const double want = std::clamp(gap / static_cast<double>(frames), -4.0, 4.0);
            for (uint32_t i = 0; i < frames; ++i) {
                // Smoothed on the ONE D-WZ-RAMP-01 constant, so a flick glides
                // like tape instead of stepping, and reverse is just a negative
                // rate through the same reader.
                d.scrubRate += alpha * (want - d.scrubRate);
                d.scrubGain = rampStep(d.scrubGain, scrubHeld ? 1.0 : 0.0, step);
                d.playhead += d.scrubRate;
                if (d.playhead < 0.0) d.playhead = 0.0;
                const double lastFrame = static_cast<double>(dFrames) - 1.0;
                if (d.playhead > lastFrame) d.playhead = lastFrame;
                const double sg = rampShape(d.scrubGain);
                const float scrubL = d.sampleLerp(0, d.playhead);
                const float scrubR = dchan > 1 ? d.sampleLerp(1, d.playhead) : scrubL;
                dl[i] = static_cast<float>(scrubL * sg);
                dr[i] = static_cast<float>(scrubR * sg);
            }
            d.cueFrame = d.playhead; // arm: a trigger starts where you let go
            d.pubPlayhead.store(d.playhead, std::memory_order_relaxed);
            d.pubScrubRate.store(d.scrubRate, std::memory_order_relaxed);
            continue;
        }
        d.pubScrubRate.store(0.0, std::memory_order_relaxed);

        // Loop region, read torn-free once per block; degenerate → whole buffer.
        uint32_t le = 0; uint64_t ls = 0, lend = 0;
        d.readLoop(le, ls, lend);
        uint64_t rs = 0, re = dFrames;
        if (le != 0 && ls < lend && ls < dFrames) { rs = ls; re = lend < dFrames ? lend : dFrames; }
        // A (re)trigger seeks the region's ENTRY edge, which depends on
        // direction: forward starts at `rs`, reverse starts just inside `re`.
        const bool reversing = d.rate.load(std::memory_order_relaxed) < 0.0;
        const double entry = reversing ? static_cast<double>(re) - 1.0 : static_cast<double>(rs);
        if (d.pendingReset.exchange(0, std::memory_order_acq_rel) != 0) {
            // D-WZ-SCRUBCUE-01: a trigger fires from where you last scrubbed, if
            // you scrubbed. Consumed here, so the NEXT wrap goes back to the
            // region entry — the cue is a one-shot, not a moved loop start.
            d.playhead = d.cueFrame >= 0.0 ? d.cueFrame : entry;
            d.cueFrame = -1.0;
        }
        // A SCRUB wins over the region clamp below: land exactly where the user
        // dragged, bounded only by the buffer. Note the loop WRAP further down
        // still applies, so scrubbing outside an active loop region folds back
        // into it — a loop is a loop.
        const int64_t seek = d.pendingSeek.exchange(-1, std::memory_order_acq_rel);
        if (seek >= 0) {
            const double target = static_cast<double>(seek);
            d.playhead = target < static_cast<double>(dFrames)
                             ? target
                             : static_cast<double>(dFrames > 0 ? dFrames - 1 : 0);
            d.cueFrame = d.playhead; // arm: a trigger now starts here
        } else if (d.playhead < static_cast<double>(rs) || d.playhead >= static_cast<double>(re))
            d.playhead = entry;

        // --- signed varispeed ------------------------------------------------
        // The rate is smoothed with the ONE D-WZ-RAMP-01 constant so a knob
        // sweep glides like tape instead of zippering. Reverse is NOT a special
        // case: a negative rate advances the playhead backwards through the very
        // same reader.
        double tgtRate = d.rate.load(std::memory_order_relaxed);
        if (!std::isfinite(tgtRate)) tgtRate = 1.0;
        // Clamp |rate| into [1/16, 16]; 0 would stall the playhead.
        const double mag = std::abs(tgtRate);
        if (mag < 1.0 / 16.0) tgtRate = tgtRate < 0.0 ? -1.0 / 16.0 : 1.0 / 16.0;
        else if (mag > 16.0) tgtRate = tgtRate < 0.0 ? -16.0 : 16.0;
        if (d.smRate == 0.0) d.smRate = tgtRate; // seed: no glide on first block

        // --- OVERDUB (D-WZ-OVERDUB-01) --------------------------------------
        // Sound-on-sound: keep playing, and SUM the input into the same buffer
        // at the playhead. Works on ANY material — a loaded file overdubs
        // exactly like a recorded take, because a tape is a tape.
        const bool overdubbing = d.overdub.load(std::memory_order_acquire) != 0;
        const uint32_t odMode = d.overdubMode.load(std::memory_order_relaxed);
        const float* od0 = (overdubbing && inBus != nullptr && d.recSrcChan0 >= 0 &&
                            static_cast<uint32_t>(d.recSrcChan0) < inCount)
                               ? inBus[d.recSrcChan0] : nullptr;
        const float* od1 = (overdubbing && inBus != nullptr && d.recSrcChan1 >= 0 &&
                            static_cast<uint32_t>(d.recSrcChan1) < inCount)
                               ? inBus[d.recSrcChan1] : nullptr;
        float* odScratch = recScratch_.data();
        uint32_t odCaptured = 0;

        const double regionLen = static_cast<double>(re) - static_cast<double>(rs);
        bool finished = false;

        // The dry (varispeed) body, callable: the stretch transitions render it
        // into scratch for the one-block crossfade (P3-2b-5, TAPE-STRETCH.md).
        auto renderVarispeed = [&](float* L, float* R) {
        for (uint32_t i = 0; i < frames; ++i) {
            if (finished) { L[i] = 0.0f; R[i] = 0.0f; continue; }
            d.smRate += alpha * (tgtRate - d.smRate);
            // SNAP once the glide is inaudibly close. A one-pole only approaches
            // its target asymptotically, so without this the smoothed rate would
            // never EQUAL ±1 and the bit-exact identity path below would be
            // unreachable — the tape would interpolate forever at "unity".
            // 1e-6 = 1 ppm of rate: inaudible as a pitch/speed error, and it
            // lets a settled tape reach EXACT identity in ~0.1 s rather than
            // creeping toward it forever.
            if (std::abs(tgtRate - d.smRate) < 1e-6) d.smRate = tgtRate;
            // IDENTITY PATH: at exactly ±1 the reader does a direct integer read
            // — no interpolation, no filter, bit-exact.
            const bool identity = d.smRate == 1.0 || d.smRate == -1.0;
            if (identity) {
                const auto idx = static_cast<uint64_t>(d.playhead);
                L[i] = d.sample(0, idx);
                R[i] = dchan > 1 ? d.sample(1, idx) : L[i];
            } else {
                L[i] = d.sampleLerp(0, d.playhead);
                R[i] = dchan > 1 ? d.sampleLerp(1, d.playhead) : L[i];
            }
            // Sum the input in at the position we just READ, so this pass and
            // the next hear it at the same point in the loop.
            if (overdubbing) {
                float vals[2];
                vals[0] = od0 != nullptr ? static_cast<float>(sanitize(od0[i])) : 0.0f;
                if (dchan > 1)
                    vals[1] = od1 != nullptr ? static_cast<float>(sanitize(od1[i])) : vals[0];
                const auto wpos = static_cast<uint64_t>(d.playhead);
                if (wpos < dFrames) {
                    // SUM layers on top; REPLACE erases what was there. Both write
                    // in place, so neither grows the buffer or allocates.
                    if (odMode == 1u) d.appendFrame(wpos, vals, dchan);
                    else d.mixFrame(wpos, vals, dchan);
                }
                // HEAR YOURSELF. The tape's own output carries the live input on
                // top of the material — D-WZ-MON-02 asks for "the input AGAINST
                // the loop", and this is the only place both can exist at once.
                L[i] += vals[0];
                R[i] += dchan > 1 ? vals[1] : vals[0];
                // The RAM mix is destructive, so the drain is what preserves
                // this pass: every overdub lands as its own stamped take file,
                // even though the pre-mix buffer does not.
                for (uint32_t c = 0; c < dchan; ++c)
                    odScratch[static_cast<size_t>(odCaptured) * dchan + c] = vals[c];
                ++odCaptured;
            }
            d.playhead += d.smRate;

            if (d.smRate >= 0.0) {
                if (d.playhead >= static_cast<double>(re)) {
                    if (st == static_cast<uint32_t>(TapeState::looping)) {
                        // Gapless forward wrap: carry the fractional overshoot so
                        // the loop stays phase-continuous at non-unity rates.
                        d.playhead = regionLen > 0.0
                            ? static_cast<double>(rs) +
                                  std::fmod(d.playhead - static_cast<double>(rs), regionLen)
                            : static_cast<double>(rs);
                    } else {
                        finished = true; // oneShot: region done → idle
                        d.state.store(static_cast<uint32_t>(TapeState::idle),
                                      std::memory_order_release);
                        d.playhead = static_cast<double>(rs);
                    }
                }
            } else {
                // REVERSE: the region's other edge is the wrap point.
                if (d.playhead < static_cast<double>(rs)) {
                    if (st == static_cast<uint32_t>(TapeState::looping)) {
                        d.playhead = regionLen > 0.0
                            ? static_cast<double>(re) -
                                  std::fmod(static_cast<double>(rs) - d.playhead, regionLen)
                            : static_cast<double>(rs);
                    } else {
                        finished = true; // reverse oneShot ends at the region start
                        d.state.store(static_cast<uint32_t>(TapeState::idle),
                                      std::memory_order_release);
                        d.playhead = static_cast<double>(re) - 1.0;
                    }
                }
            }
        }
        };

        // --- timeStretch path (P3-2b-5, TAPE-STRETCH.md) --------------------
        // The stage-1 read is the SAME timeline at unity magnitude — the
        // staged stream is exactly what varispeed would play, loop seam
        // included — and the stretcher restores pitch (fixed-output model:
        // inN in, `frames` out). One reader, two modes.
        auto* stretcher = d.stretch.load(std::memory_order_acquire);
        const bool wantStretch =
            d.tempoMode.load(std::memory_order_acquire) == 1u && stretcher != nullptr &&
            stretcher->isWarm() && !overdubbing &&
            st == static_cast<uint32_t>(TapeState::looping) && regionLen > 0.0;
        const bool wasStretch = d.stretchOn != 0;
        if (wantStretch || wasStretch) {
            const bool transition = wantStretch != wasStretch;
            float* wetL = stretchWetL_.data();
            float* wetR = stretchWetR_.data();
            float* dryL = stretchDryL_.data();
            float* dryR = stretchDryR_.data();

            if (transition) {
                // The DRY leg — committed only when dry is where we end up.
                const double ph = d.playhead;
                const double sm = d.smRate;
                renderVarispeed(dryL, dryR);
                if (wantStretch) { d.playhead = ph; d.smRate = sm; }
            }

            {
                const double ph = d.playhead;
                const double sm = d.smRate;
                if (wantStretch && !wasStretch) {
                    // ENGAGE: integer playhead (unity reads become identity
                    // reads), then prime from the material just PLAYED so the
                    // vocoder window opens on continuity, not on silence.
                    d.playhead = std::floor(d.playhead);
                    const double rateMag = std::abs(d.smRate == 0.0 ? 1.0 : d.smRate);
                    int primeN = stretcher->engageInputLength(rateMag);
                    const int primeCap = static_cast<int>(stretchInL_[di].size());
                    if (primeN > primeCap) primeN = primeCap;
                    if (primeN > 0) {
                        float* pl = stretchInL_[di].data();
                        float* pr = stretchInR_[di].data();
                        for (int k = 0; k < primeN; ++k) {
                            double pos = d.playhead - static_cast<double>(primeN - k);
                            while (pos < static_cast<double>(rs)) pos += regionLen;
                            const auto idx = static_cast<uint64_t>(pos);
                            pl[k] = d.sample(0, idx);
                            pr[k] = dchan > 1 ? d.sample(1, idx) : pl[k];
                        }
                        const float* prime[2] = {pl, pr};
                        stretcher->engagePrimed(prime, primeN);
                    }
                    d.stretchInFrac = 0.0;
                }
                // INPUT COUNT: the timeline advances |smRate| source frames per
                // output frame, smoothed exactly like the dry path so a tempo
                // move glides identically in both modes; the fraction carries.
                double acc = d.stretchInFrac;
                for (uint32_t i = 0; i < frames; ++i) {
                    d.smRate += alpha * (tgtRate - d.smRate);
                    if (std::abs(tgtRate - d.smRate) < 1e-6) d.smRate = tgtRate;
                    acc += std::abs(d.smRate);
                }
                auto inN = static_cast<uint32_t>(acc);
                d.stretchInFrac = acc - static_cast<double>(inN);
                const auto inCap = static_cast<uint32_t>(stretchInL_[di].size());
                if (inN > inCap) inN = inCap;
                if (inN == 0) inN = 1; // the model needs at least one source frame
                float* inL = stretchInL_[di].data();
                float* inR = stretchInR_[di].data();
                const double dir = d.smRate < 0.0 ? -1.0 : 1.0;
                for (uint32_t k = 0; k < inN; ++k) {
                    const auto idx = static_cast<uint64_t>(d.playhead);
                    inL[k] = d.sample(0, idx);
                    inR[k] = dchan > 1 ? d.sample(1, idx) : inL[k];
                    d.playhead += dir;
                    if (dir >= 0.0) {
                        if (d.playhead >= static_cast<double>(re))
                            d.playhead = static_cast<double>(rs) +
                                std::fmod(d.playhead - static_cast<double>(rs), regionLen);
                    } else if (d.playhead < static_cast<double>(rs)) {
                        d.playhead = static_cast<double>(re) -
                            std::fmod(static_cast<double>(rs) - d.playhead, regionLen);
                    }
                }
                const float* ins[2] = {inL, inR};
                float* outs[2] = {wetL, wetR};
                stretcher->process(ins, static_cast<int>(inN), outs,
                                   static_cast<int>(frames), 1.0);
                if (!wantStretch) { d.playhead = ph; d.smRate = sm; }
            }

            if (!transition) {
                for (uint32_t i = 0; i < frames; ++i) { dl[i] = wetL[i]; dr[i] = wetR[i]; }
            } else {
                // Equal-power over the block: toward WET on engage, DRY on exit.
                for (uint32_t i = 0; i < frames; ++i) {
                    const double r =
                        (static_cast<double>(i) + 1.0) / static_cast<double>(frames);
                    const double w = rampShape(r);
                    const double toWet = wantStretch ? w : 1.0 - w;
                    dl[i] = static_cast<float>(dryL[i] * (1.0 - toWet) + wetL[i] * toWet);
                    dr[i] = static_cast<float>(dryR[i] * (1.0 - toWet) + wetR[i] * toWet);
                }
            }
            d.stretchOn = wantStretch ? 1u : 0u;
            if (odCaptured > 0) drain_[di].write(odScratch, odCaptured, fs, blockStartSample);
            d.pubPlayhead.store(d.playhead, std::memory_order_relaxed);
            continue;
        }

        renderVarispeed(dl, dr);
        // Each overdub PASS drains to its own crash-safe stamped take file: the
        // RAM mix is destructive, so the file is what preserves the material of
        // every pass.
        if (odCaptured > 0) drain_[di].write(odScratch, odCaptured, fs, blockStartSample);
        d.pubPlayhead.store(d.playhead, std::memory_order_relaxed);
    }
}

const float* TapeBank::outL(uint32_t tape) const {
    return tape >= kMaxTapes ? nullptr : outL_[tape].data();
}

const float* TapeBank::outR(uint32_t tape) const {
    return tape >= kMaxTapes ? nullptr : outR_[tape].data();
}

void TapeBank::captureChannels(uint32_t frames, double sampleRate, uint64_t blockStartSample,
                               const ChannelBank& channels) {
    for (uint32_t ti = 0; ti < kMaxTapes; ++ti) {
        Tape& d = tapes_[ti];
        if (d.state.load(std::memory_order_acquire) != static_cast<uint32_t>(TapeState::recording))
            continue;
        if (d.recSrcKind != RecordSourceKind::channelBus) continue;
        // THE STRIP MODEL'S CLOSING ARGUMENT, in one call: capture this strip's
        // channel bus. Identical whether that channel carries a tape, a grid
        // deck's sequencer output or a live input — one tap, one code path.
        const uint32_t src = static_cast<uint32_t>(d.recSrcChan0 >= 0 ? d.recSrcChan0 : 0);
        captureFrom(ti, channels.outL(src), channels.outR(src), frames, sampleRate,
                    blockStartSample);
    }
}

} // namespace sl
