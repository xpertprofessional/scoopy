#include "NativeVoiceStretchPool.hpp"

#include <algorithm>
#include <cstdint>

namespace scoopyloops {


void NativeVoiceStretchPool::configure(double sampleRate, int maxBlockSize) {
    sampleRate_   = sampleRate;
    tonality_     = kStretchDefaultTonalityHz / sampleRate;
    maxBlockSize_ = maxBlockSize;

    // Standard bank: ~20 ms analysis window — keeps percussive transients tight; startup
    // latency is burst-discarded by the engine. HQ bank: ~80 ms window / 4:1 hop — 4× the
    // frequency resolution for melodic (tonal) material, removing the small-window warble.
    const int stdBlock    = std::max(64, static_cast<int>(sampleRate * 0.02));
    const int stdInterval = std::max(16, stdBlock / 4);
    const int hqBlock     = std::max(64, static_cast<int>(sampleRate * 0.08));
    const int hqInterval  = std::max(16, hqBlock / 4);

    for (int i = 0; i < kVoiceStretchPoolSize; ++i) {
        Slot& slot = slots_[static_cast<std::size_t>(i)];
        slot.hq = (i >= kVoiceStretchStdSlots);
        const int block    = slot.hq ? hqBlock : stdBlock;
        const int interval = slot.hq ? hqInterval : stdInterval;
        // Ring must hold frameCount + the burst-discarded startup latency + one flush
        // overshoot; maxBlock*4 + block*2 covers all of that with headroom.
        const int ringCap  = maxBlockSize * 4 + block * 2 + 1024;
        // seek() ideally wants one window + one interval of pre-roll (see signalsmith-stretch.h).
        slot.primeFrames = block + interval;

        slot.stretcher.configure(2, block, interval);
        slot.ringL.assign(static_cast<std::size_t>(ringCap), 0.0f);
        slot.ringR.assign(static_cast<std::size_t>(ringCap), 0.0f);
        slot.procL.assign(static_cast<std::size_t>(maxBlockSize), 0.0f);
        slot.procR.assign(static_cast<std::size_t>(maxBlockSize), 0.0f);
        slot.primeL.assign(static_cast<std::size_t>(slot.primeFrames), 0.0f);
        slot.primeR.assign(static_cast<std::size_t>(slot.primeFrames), 0.0f);
        slot.ringHead = 0;
        slot.ringCount = 0;
        slot.latency = static_cast<std::size_t>(slot.stretcher.outputLatency());

        // Warm up internal buffers off the audio thread so process() never allocates there.
        std::vector<float> zero(static_cast<std::size_t>(maxBlockSize), 0.0f);
        const float* in[2] = { zero.data(), zero.data() };
        float* out[2] = { slot.procL.data(), slot.procR.data() };
        slot.stretcher.process(in, maxBlockSize, out, maxBlockSize);
        slot.stretcher.reset();

        slot.inUse = false;
    }
    configured_ = true;
}

void NativeVoiceStretchPool::reset() {
    // Before configure(), each slot's SignalsmithStretch is default-constructed and its
    // DynamicSTFT size members are indeterminate — reset() would index empty window
    // vectors out of bounds (abort under hardened libc++, heap scribble in Release).
    if (!configured_) return;
    for (auto& slot : slots_) {
        slot.stretcher.reset();
        slot.ringHead = 0;
        slot.ringCount = 0;
        slot.inUse = false;
    }
}

int NativeVoiceStretchPool::claimSlot(int index, double pitchScale, bool preserveFormants) {
    Slot& s = slots_[static_cast<std::size_t>(index)];
    s.stretcher.reset();
    s.stretcher.setTransposeFactor(static_cast<float>(std::max(0.01, pitchScale)),
                                   static_cast<float>(tonality_));
    if (preserveFormants) {
        // Formant shift 0 + compensatePitch: the spectral envelope stays put while the
        // pitch map moves. Base frequency 0 = auto-detect.
        s.stretcher.setFormantSemitones(0.0f, /*compensatePitch=*/true);
        s.stretcher.setFormantBase(0.0f);
    } else {
        s.stretcher.setFormantFactor(1.0f, /*compensatePitch=*/false);
    }
    s.ringHead = 0;
    s.ringCount = 0;
    s.inUse = true;
    return index;
}

int NativeVoiceStretchPool::checkout(double /*timeRatio*/, double pitchScale, bool wantHQ,
                                     bool preserveFormants) {
    if (!configured_) return -1;
    if (wantHQ) {
        for (int i = kVoiceStretchStdSlots; i < kVoiceStretchPoolSize; ++i)
            if (!slots_[static_cast<std::size_t>(i)].inUse)
                return claimSlot(i, pitchScale, preserveFormants);
        // HQ exhausted → a standard slot still beats falling all the way to varispeed.
        for (int i = 0; i < kVoiceStretchStdSlots; ++i)
            if (!slots_[static_cast<std::size_t>(i)].inUse)
                return claimSlot(i, pitchScale, preserveFormants);
        return -1;
    }
    // Percussive/time-stretch voices never take an HQ slot (protects the melodic budget
    // and keeps their transients on the short window).
    for (int i = 0; i < kVoiceStretchStdSlots; ++i)
        if (!slots_[static_cast<std::size_t>(i)].inUse)
            return claimSlot(i, pitchScale, preserveFormants);
    return -1;
}

void NativeVoiceStretchPool::checkin(int slot) {
    if (slot < 0 || slot >= kVoiceStretchPoolSize) return;
    slots_[slot].stretcher.reset();
    slots_[slot].stretcher.setTransposeFactor(1.0f);
    slots_[slot].stretcher.setFormantFactor(1.0f, /*compensatePitch=*/false);
    slots_[slot].ringHead = 0;
    slots_[slot].ringCount = 0;
    slots_[slot].inUse = false;
}

VoiceStretcher* NativeVoiceStretchPool::get(int slot) {
    if (slot < 0 || slot >= kVoiceStretchPoolSize) return nullptr;
    return &slots_[slot].stretcher;
}

std::size_t NativeVoiceStretchPool::latencyFrames(int slot) const noexcept {
    if (slot < 0 || slot >= kVoiceStretchPoolSize) return 0;
    return slots_[slot].latency;
}

void NativeVoiceStretchPool::setTranspose(int slot, double pitchScale) {
    if (slot < 0 || slot >= kVoiceStretchPoolSize) return;
    slots_[slot].stretcher.setTransposeFactor(static_cast<float>(std::max(0.01, pitchScale)),
                                              static_cast<float>(tonality_));
}

int NativeVoiceStretchPool::ringCount(int slot) const noexcept {
    if (slot < 0 || slot >= kVoiceStretchPoolSize) return 0;
    return slots_[slot].ringCount;
}

int NativeVoiceStretchPool::ringCapacity(int slot) const noexcept {
    if (slot < 0 || slot >= kVoiceStretchPoolSize) return 0;
    return static_cast<int>(slots_[slot].ringL.size());
}

int NativeVoiceStretchPool::produceIntoRing(int slot, const float* const* in, int inFrames, int outFrames) {
    if (slot < 0 || slot >= kVoiceStretchPoolSize) return 0;
    Slot& s = slots_[slot];
    outFrames = std::min(outFrames, maxBlockSize_);
    if (outFrames <= 0) return 0;
    float* out[2] = { s.procL.data(), s.procR.data() };
    s.stretcher.process(in, inFrames, out, outFrames);

    const int cap = static_cast<int>(s.ringL.size());
    int pushed = 0;
    for (int i = 0; i < outFrames && s.ringCount < cap; ++i) {
        const int w = (s.ringHead + s.ringCount) % cap;
        s.ringL[static_cast<std::size_t>(w)] = s.procL[static_cast<std::size_t>(i)];
        s.ringR[static_cast<std::size_t>(w)] = s.procR[static_cast<std::size_t>(i)];
        ++s.ringCount;
        ++pushed;
    }
    return pushed;
}

float* NativeVoiceStretchPool::primeBufferL(int slot) noexcept {
    if (slot < 0 || slot >= kVoiceStretchPoolSize) return nullptr;
    return slots_[slot].primeL.data();
}

float* NativeVoiceStretchPool::primeBufferR(int slot) noexcept {
    if (slot < 0 || slot >= kVoiceStretchPoolSize) return nullptr;
    return slots_[slot].primeR.data();
}

int NativeVoiceStretchPool::primeCapacity(int slot) const noexcept {
    if (slot < 0 || slot >= kVoiceStretchPoolSize) return 0;
    return slots_[static_cast<std::size_t>(slot)].primeFrames;
}

void NativeVoiceStretchPool::primeFromSource(int slot, int inFrames, double playbackRate) {
    if (slot < 0 || slot >= kVoiceStretchPoolSize) return;
    inFrames = std::min(inFrames, slots_[static_cast<std::size_t>(slot)].primeFrames);
    if (inFrames <= 0) return;
    Slot& s = slots_[slot];
    const float* in[2] = { s.primeL.data(), s.primeR.data() };
    s.stretcher.seek(in, inFrames, playbackRate);
}

bool NativeVoiceStretchPool::popFrame(int slot, float& l, float& r) {
    if (slot < 0 || slot >= kVoiceStretchPoolSize) return false;
    Slot& s = slots_[slot];
    if (s.ringCount <= 0) return false;
    l = s.ringL[static_cast<std::size_t>(s.ringHead)];
    r = s.ringR[static_cast<std::size_t>(s.ringHead)];
    s.ringHead = (s.ringHead + 1) % static_cast<int>(s.ringL.size());
    --s.ringCount;
    return true;
}


} // namespace scoopyloops
