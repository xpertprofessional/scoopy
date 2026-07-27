#include "NativeMasterClipper.hpp"

#include <algorithm>
#include <cmath>

namespace scoopyloops {

void NativeMasterClipper::setParametersFromVolume(float volume, float threshold, float softness,
                                                   float driveMultiplier) noexcept {
    storedThreshold = std::max(0.1f, std::min(0.999f, threshold));
    storedSoftness  = std::max(0.0f, std::min(1.0f,   softness));
    knee            = storedThreshold;
    inputGain       = std::max(0.1f, driveMultiplier);
    clipIntensity   = storedSoftness * clipAmount(volume);
}

void NativeMasterClipper::processSample(float& left, float& right) noexcept {
    if (!std::isfinite(left))  left  = 0.0f;
    if (!std::isfinite(right)) right = 0.0f;

    if (clipIntensity > 0.0f && (std::abs(left) > 1e-6f || std::abs(right) > 1e-6f)) {
        const float serialDrive = 1.0f + (inputGain - 1.0f) * clipIntensity;
        const float dynamicKnee = knee + (0.98f - knee) * (1.0f - clipIntensity);
        left  = atanClip(left  * serialDrive, dynamicKnee);
        right = atanClip(right * serialDrive, dynamicKnee);
    }

    if (left  >  1.0f) left  =  1.0f; else if (left  < -1.0f) left  = -1.0f;
    if (right >  1.0f) right =  1.0f; else if (right < -1.0f) right = -1.0f;
}

float NativeMasterClipper::atanClip(float x, float k) const noexcept {
    const float absX = std::abs(x);
    if (absX <= k) return x;
    const float headroom        = 1.0f - k;
    const float normalizedExcess = (absX - k) / headroom;
    const float saturatedExcess  = std::min(1.0f, std::atan(normalizedExcess * curveHardness) / atanNorm);
    const float out = k + saturatedExcess * headroom;
    return x > 0.0f ? out : -out;
}

} // namespace scoopyloops
