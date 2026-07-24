#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace scoopyloops {

// Faithful C++ port of DigitalDelay.swift.
// One-pole HC lowpass in feedback, linear interpolation, tanh feedback limiter.
// All state is audio-thread-only; the struct is owned by NativeAudioEngineCore.
struct NativeDigitalDelay {
    static constexpr double kMaxDelaySeconds = 3.5;

    void configure(double sampleRate);
    void reset() noexcept;

    // Parameter setters (may be called from audio thread; no locking needed).
    void setDelayTimeMs(float ms) noexcept;
    void setFeedback(float v) noexcept;
    void setWetLevel(float v) noexcept;
    void setDryLevel(float v) noexcept;
    void setHighCut(float v) noexcept;
    void setLfoTimeDepth(float d) noexcept;
    void setLfo2TimeDepth(float d) noexcept;
    void setTimeModRange(float rangeMs) noexcept;
    void setStereoWidth(float w) noexcept;

    // Process a single stereo sample in-place.
    void processSample(float& left, float& right,
                       float lfo1Value, float lfo2Value) noexcept;

    bool isEffectivelySilent() const noexcept {
        return activeTailSamplesRemaining_ == 0;
    }

private:
    float readInterpolated(const std::vector<float>& buf, double delaySamples) const noexcept;
    float softLimit(float v) const noexcept;

    double sampleRate_ = 44100.0;

    std::vector<float> bufL_;
    std::vector<float> bufR_;
    int writeIndex_ = 0;

    // Smoothed targets
    float targetDelayMs_  = 250.0f;
    float currentDelayMs_ = 250.0f;
    float targetFeedback_  = 0.4f;
    float currentFeedback_ = 0.4f;
    float targetWet_  = 1.0f;
    float currentWet_ = 1.0f;
    float targetDry_  = 0.0f;
    float currentDry_ = 0.0f;

    float highCut_        = 1.0f;
    float filterCoeff_    = 1.0f;
    float feedbackFilterL_ = 0.0f;
    float feedbackFilterR_ = 0.0f;

    float lfoTimeDepth_  = 0.0f;
    float lfo2TimeDepth_ = 0.0f;
    float timeModRange_  = 10.0f;
    float stereoWidth_   = 0.5f;

    static constexpr float kDelaySmoothCoeff    = 0.9995f;
    static constexpr float kFeedbackSmoothCoeff = 0.999f;
    static constexpr float kMixSmoothCoeff      = 0.999f;

    int activeTailSamplesRemaining_ = 0;

    void updateFilterCoeff() noexcept;
};

// Per-return-track parameters carried in RenderWorld (immutable snapshot).
struct NativeReturnState {
    float volume          = 1.0f;
    float gain            = 1.0f;
    float pan             = 0.0f;
    bool  muted           = false;
    bool  bypassed        = false;

    float delayTimeMs     = 250.0f;
    float delayFeedback   = 0.4f;
    float delayWetLevel   = 1.0f;
    float delayDryLevel   = 0.0f;
    float delayHighCut    = 1.0f;
    float lfoTimeDepth    = 0.0f;
    float lfo2TimeDepth   = 0.0f;
    float timeModRange    = 10.0f;
    float stereoWidth     = 0.5f;

    float lfoVolumeDepth  = 0.0f;
    float lfo2VolumeDepth = 0.0f;
    float lfoPanDepth     = 0.0f;
    float lfo2PanDepth    = 0.0f;
    // 0 = volume target; 1 = gain target (mirrors Track.LfoVolumeTarget)
    std::uint8_t lfo1VolumeTarget = 0;
    std::uint8_t lfo2VolumeTarget = 0;

    bool  gateEnabled     = false;
    std::uint32_t gateStepCount = 16;
    std::vector<bool> gateSteps;  // size = gateStepCount
    std::uint8_t gateMode = 1;    // 0 = sendInput, 1 = output

    bool externalEnabled  = false;
};

} // namespace scoopyloops
