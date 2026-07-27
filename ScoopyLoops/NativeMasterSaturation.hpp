#pragma once

#include <cmath>

namespace scoopyloops {

/// Faithful C++ port of ScoopyLoopsSaturation.swift (Airwindows Density2-flavored).
struct NativeMasterSaturation {
    float drive = 0.0f;
    float highpass = 0.0f;
    float output = 1.0f;
    float mix = 1.0f;

    float last3L = 0.0f, last2L = 0.0f, last1L = 0.0f;
    float last3R = 0.0f, last2R = 0.0f, last1R = 0.0f;
    float iirAL = 0.0f, iirBL = 0.0f;
    float iirAR = 0.0f, iirBR = 0.0f;
    float lastDiffL = 0.0f, lastDiffR = 0.0f;

    void reset() noexcept;
    void setDriveFromVolume(float volume) noexcept;
    void processSample(float& left, float& right) noexcept;

private:
    float applySaturation(float sample) const noexcept;
    float calculateGainReduction() const noexcept;
};

} // namespace scoopyloops
