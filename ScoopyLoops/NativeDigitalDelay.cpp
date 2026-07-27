#include "NativeDigitalDelay.hpp"

#include <algorithm>
#include <cmath>

namespace scoopyloops {

void NativeDigitalDelay::configure(double sampleRate) {
    sampleRate_ = std::max(8000.0, sampleRate);
    const std::size_t bufSize = static_cast<std::size_t>(kMaxDelaySeconds * sampleRate_) + 1;
    bufL_.assign(bufSize, 0.0f);
    bufR_.assign(bufSize, 0.0f);
    writeIndex_ = 0;
    feedbackFilterL_ = 0.0f;
    feedbackFilterR_ = 0.0f;
    currentDelayMs_ = targetDelayMs_;
    currentFeedback_ = targetFeedback_;
    currentWet_ = targetWet_;
    currentDry_ = targetDry_;
    activeTailSamplesRemaining_ = 0;
    updateFilterCoeff();
}

void NativeDigitalDelay::reset() noexcept {
    std::fill(bufL_.begin(), bufL_.end(), 0.0f);
    std::fill(bufR_.begin(), bufR_.end(), 0.0f);
    writeIndex_ = 0;
    feedbackFilterL_ = 0.0f;
    feedbackFilterR_ = 0.0f;
    currentDelayMs_ = targetDelayMs_;
    currentFeedback_ = targetFeedback_;
    currentWet_ = targetWet_;
    currentDry_ = targetDry_;
    activeTailSamplesRemaining_ = 0;
}

void NativeDigitalDelay::setDelayTimeMs(float ms) noexcept {
    targetDelayMs_ = std::max(0.1f, std::min(3000.0f, ms));
}

void NativeDigitalDelay::setFeedback(float v) noexcept {
    targetFeedback_ = std::max(0.0f, std::min(0.999f, v));
}

void NativeDigitalDelay::setWetLevel(float v) noexcept {
    targetWet_ = std::max(0.0f, std::min(1.0f, v));
}

void NativeDigitalDelay::setDryLevel(float v) noexcept {
    targetDry_ = std::max(0.0f, std::min(1.0f, v));
}

void NativeDigitalDelay::setHighCut(float v) noexcept {
    highCut_ = std::max(0.0f, std::min(1.0f, v));
    updateFilterCoeff();
}

void NativeDigitalDelay::setLfoTimeDepth(float d) noexcept {
    lfoTimeDepth_ = std::max(-1.0f, std::min(1.0f, d));
}

void NativeDigitalDelay::setLfo2TimeDepth(float d) noexcept {
    lfo2TimeDepth_ = std::max(-1.0f, std::min(1.0f, d));
}

void NativeDigitalDelay::setTimeModRange(float rangeMs) noexcept {
    timeModRange_ = std::max(0.1f, std::min(100.0f, rangeMs));
}

void NativeDigitalDelay::setStereoWidth(float w) noexcept {
    stereoWidth_ = std::max(0.0f, std::min(1.0f, w));
}

void NativeDigitalDelay::processSample(float& left, float& right,
                                        float lfo1Value, float lfo2Value) noexcept {
    // Smooth parameters
    currentDelayMs_  += (targetDelayMs_  - currentDelayMs_)  * (1.0f - kDelaySmoothCoeff);
    currentFeedback_ += (targetFeedback_ - currentFeedback_) * (1.0f - kFeedbackSmoothCoeff);
    currentWet_      += (targetWet_      - currentWet_)      * (1.0f - kMixSmoothCoeff);
    currentDry_      += (targetDry_      - currentDry_)      * (1.0f - kMixSmoothCoeff);

    // LFO time modulation
    const float totalMod = lfo1Value * lfoTimeDepth_ * timeModRange_
                         + lfo2Value * lfo2TimeDepth_ * timeModRange_;
    const float timeModR = stereoWidth_ > 0.5f
        ? -totalMod
        : totalMod * (1.0f - stereoWidth_ * 2.0f);

    const float delL = std::max(0.1f, std::min(3000.0f, currentDelayMs_ + totalMod));
    const float delR = std::max(0.1f, std::min(3000.0f, currentDelayMs_ + timeModR));

    const double delSampL = static_cast<double>(delL) * 0.001 * sampleRate_;
    const double delSampR = static_cast<double>(delR) * 0.001 * sampleRate_;

    const float delayedL = readInterpolated(bufL_, delSampL);
    const float delayedR = readInterpolated(bufR_, delSampR);

    // HC lowpass in feedback path
    feedbackFilterL_ += filterCoeff_ * (delayedL - feedbackFilterL_);
    feedbackFilterR_ += filterCoeff_ * (delayedR - feedbackFilterR_);

    const float filtL = highCut_ < 1.0f ? feedbackFilterL_ : delayedL;
    const float filtR = highCut_ < 1.0f ? feedbackFilterR_ : delayedR;

    const float fbL = softLimit(filtL * currentFeedback_);
    const float fbR = softLimit(filtR * currentFeedback_);

    const std::size_t n = bufL_.size();
    bufL_[writeIndex_] = left  + fbL;
    bufR_[writeIndex_] = right + fbR;
    writeIndex_ = static_cast<int>((writeIndex_ + 1) % n);

    const float outL = left  * currentDry_ + delayedL * currentWet_;
    const float outR = right * currentDry_ + delayedR * currentWet_;

    const float activity = std::max({ std::abs(outL), std::abs(outR),
                                      std::abs(delayedL), std::abs(delayedR) });
    if (activity > 1e-5f) {
        activeTailSamplesRemaining_ = static_cast<int>(kMaxDelaySeconds * sampleRate_);
    } else if (activeTailSamplesRemaining_ > 0) {
        --activeTailSamplesRemaining_;
    }

    left  = outL;
    right = outR;
}

float NativeDigitalDelay::readInterpolated(const std::vector<float>& buf,
                                            double delaySamples) const noexcept {
    const int n = static_cast<int>(buf.size());
    double readPos = static_cast<double>(writeIndex_) - delaySamples;
    int readIdx = static_cast<int>(std::floor(readPos));
    while (readIdx < 0) readIdx += n;
    readIdx %= n;
    const int nextIdx = (readIdx + 1) % n;
    const float frac = static_cast<float>(readPos - std::floor(readPos));
    return buf[readIdx] * (1.0f - frac) + buf[nextIdx] * frac;
}

float NativeDigitalDelay::softLimit(float v) const noexcept {
    if (std::abs(v) < 0.9f) return v;
    return std::tanh(v * 0.8f) * 1.25f;
}

void NativeDigitalDelay::updateFilterCoeff() noexcept {
    filterCoeff_ = 0.1f + highCut_ * 0.9f;
}

} // namespace scoopyloops
