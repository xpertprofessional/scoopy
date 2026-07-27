#pragma once

#include <cmath>
#include <cstddef>
#include <array>

namespace scoopyloops {

/// Faithful C++ port of TrackClipper.swift
/// Per-track distortion pipeline activated by trackGain > 1.0 (drive 1.0–2.0).
struct NativeTrackClipper {
    bool active = false;         // false when drive <= 1.0 (bypass)
    float inputGain = 1.0f;
    int stages = 1;

    float distortionKnee = 0.65f;
    float distortionBlend = 0.0f;
    bool useSineFold = false;
    float bitCrushScale = 0.0f;
    float interStageBoost = 1.05f;

    // Bass reinforcement delay line
    std::array<float, 4> bassEnhanceL {};
    std::array<float, 4> bassEnhanceR {};
    int bassEnhanceIndex = 0;

    void reset() noexcept;
    void setParametersFromDrive(float drive) noexcept;
    void processSample(float& left, float& right) noexcept;

private:
    float distortionCurve(float sample) const noexcept;
    float polynomialWaveshaper(float sample, float knee) const noexcept;
    float sineFold(float sample) const noexcept;
    float bassReinforce(float sample, int channel) noexcept;
};

} // namespace scoopyloops
