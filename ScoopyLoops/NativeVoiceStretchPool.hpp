#pragma once


  #include "Signalsmith/signalsmith-stretch.h"
  #include <vector>

#include <array>
#include <cstddef>

namespace scoopyloops {

// Per-voice pitch/stretch pool, checked out on trigger for voices that need melodic
// pitch or time-stretch and returned on voice end. Backend selected at compile time
// (see NativeStretchBackend.hpp).
//
//   * RubberBand backend: streaming push/pull — get() returns the stretcher and the
//     engine drives process()/available()/retrieve() directly (verbatim Phase-11 path).
//   * Signalsmith backend: fixed-output. Each slot owns a small output ring buffer; the
//     engine fills it (process source -> ring) until >= frameCount is ready, then drains
//     one frame per tick. This mirrors the RubberBand available()/retrieve() lifecycle so
//     the per-voice glide / latency-skip / end-detection logic is shared.
//
// CPU note: cost scales with the number of voices ACTIVELY checked out (gated to those
// that need pitch/stretch), not the pool size — idle slots are not processed. Size kept at
// 64 to match the original RubberBand pool exactly (idle Signalsmith slots cost only memory).
static constexpr int kVoiceStretchPoolSize = 64;

// Two banks inside the pool:
//   * slots [0, kVoiceStretchStdSlots)  — STANDARD ~20 ms window / 5 ms hop: percussive
//     per-track time-stretch and stretch-to-cell, where the short window keeps transients
//     tight (a large window would smear drum hits).
//   * slots [kVoiceStretchStdSlots, 64) — HQ ~80 ms window / 20 ms hop: melodic pitch,
//     where 4× the frequency resolution removes the warble/roughness a 20 ms phase
//     vocoder produces on tonal material. The larger startup latency is burst-discarded
//     in the engine's pre-render pass, so note timing is unaffected.
// Routing is deterministic from the track's explicit mode (melodic → HQ, time-stretch →
// standard); HQ exhaustion falls back to standard, never the other way around.
static constexpr int kVoiceStretchStdSlots = 48;
static constexpr int kVoiceStretchHQSlots  = kVoiceStretchPoolSize - kVoiceStretchStdSlots;

// Default tonality limit (Hz) for Signalsmith pitch transpose — the classic key-lock
// compromise: harmonics below this shift normally, textures above keep their natural
// character. Passed as a fraction of sample-rate (8000.0 / sr). Shared by the per-voice
// melodic transpose here and the DJ deck bus transpose default in NativeAudioEngineCore.
inline constexpr double kStretchDefaultTonalityHz = 8000.0;

using VoiceStretcher = signalsmith::stretch::SignalsmithStretch<float>;

class NativeVoiceStretchPool {
public:
    // Allocates all stretchers — call from configure(), never from the audio thread.
    void configure(double sampleRate, int maxBlockSize);

    // Resets all stretchers and frees all slots — call from stop().
    void reset();

    // Finds a free slot in the requested bank (wantHQ → HQ bank, falling back to standard
    // when HQ is exhausted), configures timeRatio/pitchScale, marks it in-use.
    // preserveFormants keeps the sample's formants put under the transpose (Signalsmith
    // formant compensation, auto-detected base) — vocal/instrument timbre stays natural.
    // Returns the slot index, or -1 if the pool is exhausted (caller → varispeed).
    int checkout(double timeRatio, double pitchScale, bool wantHQ, bool preserveFormants);

    // Frees the slot and resets its stretcher for reuse.
    void checkin(int slot);

    // Raw stretcher pointer (no ownership). Backend type is VoiceStretcher.
    VoiceStretcher* get(int slot);

    // Startup output latency (frames) to discard so the first audible frame aligns with
    // the trigger. Stable for the slot's lifetime; call right after checkout().
    std::size_t latencyFrames(int slot) const noexcept;

    // ── Signalsmith fixed-output helpers (per-slot output ring) ─────────────────
    void  setTranspose(int slot, double pitchScale);     // pitch factor (1.0 = none)
    int   ringCount(int slot) const noexcept;            // frames currently buffered
    int   ringCapacity(int slot) const noexcept;
    // Process `inFrames` source -> `outFrames` output and push the result into the ring.
    // For melodic pitch (pitch-only) pass inFrames == outFrames. Returns frames pushed.
    int   produceIntoRing(int slot, const float* const* in, int inFrames, int outFrames);
    // Pop one frame from the ring into l/r. Returns false if the ring is empty.
    bool  popFrame(int slot, float& l, float& r);

    // ── Startup pre-roll priming (Signalsmith seek) ────────────────────────────
    // Feeds the slot's stretcher one window+interval of "previous input" so the first
    // process() output is full-quality, eliminating the cold-start phase-vocoder transient
    // (the "buffer noise" on a freshly triggered melodic / stretch voice). RT-safe: seek()
    // only writes into pre-sized buffers. Usage: fill primeBufferL/R(slot) with up to
    // primeCapacity() source frames (in time order, ending at the trigger point), then call
    // primeFromSource(slot, frames, playbackRate). Capacity is per-slot (HQ windows are
    // larger than standard ones).
    int    primeCapacity(int slot) const noexcept;
    float* primeBufferL(int slot) noexcept;
    float* primeBufferR(int slot) noexcept;
    void   primeFromSource(int slot, int inFrames, double playbackRate);

private:
    struct Slot {
        VoiceStretcher stretcher;
        std::vector<float> ringL, ringR;  // FIFO of produced output
        std::vector<float> procL, procR;  // scratch for one process() call
        std::vector<float> primeL, primeR;  // scratch for the startup seek() pre-roll
        int ringHead = 0;
        int ringCount = 0;
        int primeFrames = 0;        // window+interval pre-roll length for primeFromSource()
        std::size_t latency = 0;
        bool hq = false;
        bool inUse = false;
    };

    int claimSlot(int index, double pitchScale, bool preserveFormants);

    std::array<Slot, kVoiceStretchPoolSize> slots_;
    double sampleRate_   = 44100.0;
    double tonality_     = 0.0;     // tonality limit as fraction of sample-rate (key-lock)
    int    maxBlockSize_ = 512;
    bool   configured_   = false;
};

} // namespace scoopyloops
