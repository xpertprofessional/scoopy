#pragma once

#include <cmath>

namespace scoopyloops {

/// Faithful C++ port of MasterClipper.swift.
struct NativeMasterClipper {
    static constexpr float curveHardness = 3.0f;
    static constexpr float atanNorm = 1.2490457724f; // atan(3.0f)

    float inputGain = 1.0f;
    float knee = 0.7f;
    float clipIntensity = 0.0f;

    void reset() noexcept {}
    void setParametersFromVolume(float volume, float threshold, float softness,
                                 float driveMultiplier = 1.0f) noexcept;
    void processSample(float& left, float& right) noexcept;

    static float cleanOutputGain(float volume) noexcept {
        return volume < 0.0f ? 0.0f : (volume > 1.0f ? 1.0f : volume);
    }
    static float clipAmount(float volume) noexcept {
        const float v = volume - 1.0f;
        return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v);
    }

private:
    float storedThreshold = 0.7f;
    float storedSoftness  = 0.4f;
    float atanClip(float x, float k) const noexcept;
};

} // namespace scoopyloops
