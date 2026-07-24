#include "NativeTrackClipper.hpp"

#include <cmath>
#include <algorithm>

namespace scoopyloops {

void NativeTrackClipper::reset() noexcept {
    bassEnhanceL.fill(0.0f);
    bassEnhanceR.fill(0.0f);
    bassEnhanceIndex = 0;
}

void NativeTrackClipper::setParametersFromDrive(float drive) noexcept {
    const float clampedDrive = std::max(1.0f, drive);
    if (clampedDrive <= 1.0f) { active = false; return; }
    if (clampedDrive == inputGain && active) return;
    active = true;
    inputGain = clampedDrive;

    if (inputGain < 1.3f) stages = 1;
    else if (inputGain < 1.7f) stages = 2;
    else stages = 3;

    if (inputGain < 1.4f) {
        const float t = (inputGain - 1.0f) / 0.4f;
        distortionKnee  = 0.65f - t * 0.57f;
        distortionBlend = 0.0f;
        useSineFold     = false;
    } else if (inputGain < 1.75f) {
        distortionKnee  = 0.08f;
        distortionBlend = (inputGain - 1.4f) / 0.35f;
        useSineFold     = true;
    } else {
        distortionKnee  = 0.08f;
        distortionBlend = 1.0f;
        useSineFold     = true;
    }

    interStageBoost = inputGain >= 1.75f ? 1.18f : 1.05f;

    if (inputGain >= 1.5f) {
        const float t    = std::min(1.0f, (inputGain - 1.5f) / 0.5f);
        const float bits = 12.0f - t * 8.0f;
        bitCrushScale = std::pow(2.0f, bits - 1.0f);
    } else {
        bitCrushScale = 0.0f;
    }
}

void NativeTrackClipper::processSample(float& left, float& right) noexcept {
    if (!active) return;
    if (std::abs(left) < 0.0001f && std::abs(right) < 0.0001f) {
        reset(); left = 0.0f; right = 0.0f; return;
    }

    float l = left, r = right;
    for (int stage = 0; stage < stages; ++stage) {
        const float boost = stage == 0 ? 1.0f : interStageBoost;
        l = distortionCurve(l * boost);
        r = distortionCurve(r * boost);
        if (stage > 0) {
            if (std::abs(l) > 0.0001f) l = bassReinforce(l, 0);
            else bassEnhanceL[bassEnhanceIndex] = 0.0f;
            if (std::abs(r) > 0.0001f) r = bassReinforce(r, 1);
            else bassEnhanceR[bassEnhanceIndex] = 0.0f;
            bassEnhanceIndex = (bassEnhanceIndex + 1) % 4;
        }
    }

    if (bitCrushScale > 0.0f) {
        l = std::roundf(l * bitCrushScale) / bitCrushScale;
        r = std::roundf(r * bitCrushScale) / bitCrushScale;
    }

    if (!std::isfinite(l)) l = 0.0f;
    if (!std::isfinite(r)) r = 0.0f;
    left = l; right = r;
}

float NativeTrackClipper::distortionCurve(float sample) const noexcept {
    if (!useSineFold) return polynomialWaveshaper(sample, distortionKnee);
    if (distortionBlend >= 1.0f) return sineFold(sample);
    const float poly   = polynomialWaveshaper(sample, distortionKnee);
    const float folded = sineFold(sample);
    return poly + (folded - poly) * distortionBlend;
}

float NativeTrackClipper::polynomialWaveshaper(float sample, float knee) const noexcept {
    const float x    = std::abs(sample);
    const float sign = sample >= 0.0f ? 1.0f : -1.0f;
    if (x <= knee) return sample;
    if (x < 1.0f) {
        const float t  = (x - knee) / (1.0f - knee);
        const float t3 = t * t * t;
        return sign * (knee + (1.0f - knee) * (1.5f * t - 0.5f * t3));
    }
    return sign;
}

float NativeTrackClipper::sineFold(float sample) const noexcept {
    return std::sin(sample * 1.5707963f);  // sample * π/2
}

float NativeTrackClipper::bassReinforce(float sample, int channel) noexcept {
    if (std::abs(sample) < 0.0001f) {
        if (channel == 0) bassEnhanceL.fill(0.0f);
        else              bassEnhanceR.fill(0.0f);
        return 0.0f;
    }
    if (channel == 0) bassEnhanceL[bassEnhanceIndex] = sample;
    else              bassEnhanceR[bassEnhanceIndex] = sample;
    float sum = 0.0f;
    if (channel == 0) for (float v : bassEnhanceL) sum += v;
    else              for (float v : bassEnhanceR) sum += v;
    const float avg = sum * 0.25f;
    if (std::abs(avg) <= 0.0001f) return sample;
    return sample + avg * 0.1f;
}

} // namespace scoopyloops
