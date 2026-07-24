#pragma once

#include <cstdint>

#include "NativeOversampler.hpp"

namespace scoopyloops {

/// Selectable master drive/clip curve. `soft` reproduces the legacy MasterClipper.swift
/// atan-knee exactly (drop-in compatibility); the others are native-only, anti-aliased
/// drive curves that sweep audibly across 100–200% master volume.
enum class MasterDriveCurve : std::uint8_t {
    soft = 0,   // legacy atan-knee soft clip (memoryless, no AA) — compatibility preset
    tanh = 1,   // smooth tube-ish saturation
    hard = 2,   // hard clip (anti-aliased)
    fold = 3,   // sine wavefolder (aggressive harmonics)
};

/// Master output drive stage with two behaviours selected by `decoupled`:
///
///   • Legacy (decoupled == false): below 100% master volume it is a clean pass-through;
///     above 100% it progressively drives/clips, driven by the master fader. The `soft`
///     curve matches the legacy MasterClipper bit-for-bit; `tanh`/`hard`/`fold` use 1st-order
///     antiderivative anti-aliasing (ADAA). This is the parity path for older sessions.
///
///   • Decoupled (decoupled == true): an FL/Ozone-style clipper section. `drive` is an
///     always-active input gain (independent of the master fader), `ceiling` is the output
///     clip point, and the nonlinearity can be 2x/4x oversampled (NativeOversampler) so hard
///     clipping stays clean at extreme drive. The master fader applies afterwards as a clean
///     output level.
///
/// Stateful (ADAA history + oversampler history per channel), so each independent output
/// (main bus + each dedicated deck lane) needs its own instance.
struct NativeMasterDrive {
    // Parameters, refreshed per buffer from master volume + the UI drive/threshold/softness.
    MasterDriveCurve curve = MasterDriveCurve::soft;
    float inputGain     = 2.0f;   // "drive" — pushes harder as it rises
    float knee          = 0.7f;   // "threshold"/"knee" — soft-curve knee
    float storedSoftness = 0.4f;  // "softness" — clip intensity / character amount
    float clipIntensity = 0.0f;   // soft path: softness * clipAmount(volume)
    float volExcess     = 0.0f;   // clipAmount(volume): 0 at 100%, 1 at 200%

    // Decoupled-clipper parameters (FL/Ozone-style section). Ignored in legacy mode.
    float ceiling       = 1.0f;          // output clip point (linear, 1.0 = 0 dBFS)
    std::uint8_t oversample = 0;         // 0 = off (ADAA), 2 = 2x, 4 = 4x
    bool decoupled      = false;         // false = legacy volume-gated, true = always-on drive

    // ADAA history (per channel) for the non-soft curves, at the BASE rate (oversample == 0 path).
    float x1L = 0.0f, F1L = 0.0f;
    float x1R = 0.0f, F1R = 0.0f;

    // ADAA history at the OVERSAMPLED rate. Separate from the pair above, and it has to be: the
    // shaper inside the oversampler sees L sub-samples per input sample, so its "previous sample" is
    // a different signal entirely. Sharing one pair would compute the antiderivative's slope across
    // a gap L times too wide and mis-shape every sub-sample.
    float osX1L = 0.0f, osF1L = 0.0f;
    float osX1R = 0.0f, osF1R = 0.0f;

    void reset() noexcept {
        x1L = F1L = x1R = F1R = 0.0f;
        osX1L = osF1L = osX1R = osF1R = 0.0f;
        osL_.reset();
        osR_.reset();
    }

    static float clipAmount(float volume) noexcept {
        const float v = volume - 1.0f;
        return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v);
    }
    static float cleanOutputGain(float volume) noexcept {
        return volume < 0.0f ? 0.0f : (volume > 1.0f ? 1.0f : volume);
    }

    void setParameters(MasterDriveCurve c, float volume,
                       float threshold, float softness, float drive,
                       float ceilingLinear, std::uint8_t oversampleFactor,
                       bool decoupledMode) noexcept;

    void processSample(float& left, float& right) noexcept;

private:
    static constexpr float curveHardness = 3.0f;
    static constexpr float atanNorm = 1.2490457724f; // atan(3.0f)

    NativeOversampler osL_ {};
    NativeOversampler osR_ {};

    float processSoft(float x) const noexcept;          // legacy atan-knee, memoryless
    // 1st-order antiderivative anti-aliasing of the active curve, evaluated at the already
    // pre-gained, ceiling-normalised input `u`. Carries its own (x1, F1) history so it can be run at
    // EITHER the base rate or inside the oversampler. The caller scales the result by the ceiling.
    float adaaShape(float u, float& x1, float& F1) const noexcept;
    // ADAA shaper at the base rate. `g` = pre-gain, `ceil` = output clip point, `wet` = dry/wet.
    float processADAA(float x, float& x1, float& F1,
                      float g, float ceil, float wet) const noexcept;
    float shape(float u) const noexcept;                // f(u) for the active non-soft curve
    float shapeAntideriv(float u) const noexcept;       // ∫f du for ADAA
    float shapeCurveDecoupled(float pre) const noexcept;// bounded curve for the decoupled path
    float effectiveDrive() const noexcept;              // legacy pre-gain into the shaper
    float wetAmount() const noexcept;                   // legacy dry/wet blend (0 at ≤100%)
};

} // namespace scoopyloops
