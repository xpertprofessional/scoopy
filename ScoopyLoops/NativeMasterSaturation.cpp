#include "NativeMasterSaturation.hpp"

#include <algorithm>
#include <cmath>

namespace scoopyloops {

void NativeMasterSaturation::reset() noexcept {
    last3L = last2L = last1L = 0.0f;
    last3R = last2R = last1R = 0.0f;
    iirAL = iirBL = iirAR = iirBR = 0.0f;
    lastDiffL = lastDiffR = 0.0f;
}

void NativeMasterSaturation::setDriveFromVolume(float volume) noexcept {
    if (volume <= 1.0f) { drive = 0.0f; return; }
    const float excess = volume - 1.0f;
    if (excess <= 0.1f) {
        drive = std::pow(excess * 10.0f, 3.0f) * 0.01f;
    } else if (excess <= 0.5f) {
        drive = 0.01f + std::pow((excess - 0.1f) * 2.5f, 2.0f) * 0.09f;
    } else if (excess <= 1.0f) {
        drive = 0.1f + std::pow((excess - 0.5f) * 2.0f, 1.5f) * 0.4f;
    } else {
        drive = 0.5f + std::pow((excess - 1.0f) * 0.5f, 1.2f) * 0.5f;
    }
    drive = std::min(1.0f, drive);
}

float NativeMasterSaturation::calculateGainReduction() const noexcept {
    if (drive <= 0.0f) return 1.0f;
    const float density = drive * 5.0f - 1.0f;
    const float normalizedDensity = density * std::abs(density);
    const float saturationIntensity = std::min(1.0f, normalizedDensity / 16.0f);
    return std::max(0.05f, 1.0f - saturationIntensity * 0.95f);
}

float NativeMasterSaturation::applySaturation(float sample) const noexcept {
    if (drive <= 0.0f) return sample;
    const float density = drive * 5.0f - 1.0f;
    float out = std::abs(density);
    const float normalizedOut = std::fmod(out, 1.0f);
    const float normalizedDensity = density * std::abs(density);

    float result = sample;
    float count = normalizedDensity;
    while (count > 1.0f) {
        const float bridgerectifier = std::min(std::abs(result) * 1.5707963f, 1.5707963f);
        const float saturated = std::sin(bridgerectifier);
        result = (result > 0.0f) ? saturated : -saturated;
        count -= 1.0f;
    }
    const float bridgerectifier = std::min(std::abs(result) * 1.5707963f, 1.5707963f);
    float saturated;
    if (density > 0.0f) {
        saturated = std::sin(bridgerectifier);
    } else {
        saturated = 1.0f - std::cos(bridgerectifier);
    }
    if (result > 0.0f)
        result = result * (1.0f - normalizedOut) + saturated * normalizedOut;
    else
        result = result * (1.0f - normalizedOut) - saturated * normalizedOut;
    return result;
}

void NativeMasterSaturation::processSample(float& left, float& right) noexcept {
    if (drive <= 0.0f || mix <= 0.0f) return;

    const float dryL = left, dryR = right;
    constexpr float k = 0.0414213562373095048801688f;

    const float halfwayL = (left  + last1L + ((-last2L + last3L) * k)) * 0.5f;
    const float halfwayR = (right + last1R + ((-last2R + last3R) * k)) * 0.5f;

    last3L = last2L; last2L = last1L; last1L = left;
    last3R = last2R; last2R = last1R; last1R = right;

    const float iirAmount = std::pow(highpass, 3.0f);
    iirBL = iirBL * (1.0f - iirAmount) + halfwayL * iirAmount;
    const float filtHalfL = halfwayL - iirBL;
    iirBR = iirBR * (1.0f - iirAmount) + halfwayR * iirAmount;
    const float filtHalfR = halfwayR - iirBR;

    const float satHalfL = applySaturation(filtHalfL);
    const float satHalfR = applySaturation(filtHalfR);
    const float halfDiffL = satHalfL - halfwayL;
    const float halfDiffR = satHalfR - halfwayR;

    iirAL = iirAL * (1.0f - iirAmount) + left  * iirAmount;
    iirAR = iirAR * (1.0f - iirAmount) + right * iirAmount;
    const float filtL = left  - iirAL;
    const float filtR = right - iirAR;

    const float satL = applySaturation(filtL);
    const float satR = applySaturation(filtR);
    const float diffL = satL - dryL;
    const float diffR = satR - dryR;

    const float combinedDiffL = (diffL + halfDiffL + lastDiffL) / 1.187f;
    const float combinedDiffR = (diffR + halfDiffR + lastDiffR) / 1.187f;
    lastDiffL = diffL * 0.5f;
    lastDiffR = diffR * 0.5f;

    const float processedL = (dryL + combinedDiffL) * output;
    const float processedR = (dryR + combinedDiffR) * output;
    const float gainRed = calculateGainReduction();

    left  = dryL * (1.0f - mix) + processedL * gainRed * mix;
    right = dryR * (1.0f - mix) + processedR * gainRed * mix;
}

} // namespace scoopyloops
