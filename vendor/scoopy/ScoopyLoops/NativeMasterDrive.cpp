#include "NativeMasterDrive.hpp"

#include <algorithm>
#include <cmath>

namespace scoopyloops {

namespace {
constexpr float kFoldK = 1.5707963267948966f;       // π/2
constexpr float kInvFoldK = 0.6366197723675814f;    // 2/π
constexpr float kLn2 = 0.6931471805599453f;

// Numerically stable ln(cosh(u)) = |u| + ln(1 + e^{-2|u|}) − ln 2.
inline float stableLnCosh(float u) noexcept {
    const float a = std::fabs(u);
    return a + std::log1p(std::exp(-2.0f * a)) - kLn2;
}
} // namespace

void NativeMasterDrive::setParameters(MasterDriveCurve c, float volume,
                                      float threshold, float softness, float drive,
                                      float ceilingLinear, std::uint8_t oversampleFactor,
                                      bool decoupledMode) noexcept {
    const std::uint8_t newOversample =
        (oversampleFactor >= 4) ? 4 : (oversampleFactor >= 2 ? 2 : 0);
    const bool curveChanged      = (c != curve);
    const bool oversampleChanged = (newOversample != oversample);
    // A decoupled flip changes what x1 MEANS, not just which curve reads it: the stored value is the
    // normalised u = x·g/ceil, and the two modes normalise with different g (effectiveDrive() vs the
    // raw inputGain) and different ceil (1.0 vs `ceiling`). The F1-recompute below fixes a mismatched
    // antiderivative but cannot fix a mismatched x1 scale, so this one gets the full reset. Nearly
    // unreachable in practice (decoupled has no UI and new sessions pin it true — only loading an old
    // session that stored `false` flips it), which is exactly the kind of path that stays broken for
    // years when it is not handled at the site that knows.
    const bool decoupledChanged  = (decoupledMode != decoupled);

    curve = c;
    knee = std::clamp(threshold, 0.1f, 0.999f);
    storedSoftness = std::clamp(softness, 0.0f, 1.0f);

    // ⚠️ THE MISSING INPUT TRIM. In the decoupled (FL/Ozone-style) topology the master fader sits
    // AFTER the clipper as a clean output level — which is correct, and is what the migration moved
    // it to. But that topology only works if `drive` can also ATTENUATE: it is the only gain between
    // the summing bus and the clip point, so it is the *only* control that can decide how hard the
    // mix hits the ceiling. It was floored at 1.0, so there was no way to back a hot mix off the
    // clipper at all. That, not the fader's position, was the real headroom bug.
    //
    // Opened down to -24 dB (0.0631), giving a true bipolar trim of -24…+30 dB with unity at 0 dB.
    //
    // The legacy branch keeps its old floor deliberately: there `inputGain` feeds
    // effectiveDrive() = 1 + inputGain·volExcess and processSoft()'s
    // serialDrive = 1 + (inputGain-1)·clipIntensity, where a sub-unity value would silently start
    // ATTENUATING above 100% master rather than driving. That path is nearly unreachable (decoupled
    // defaults true and old files migrate to true), and it is meant to be bit-frozen.
    inputGain = decoupledMode ? std::clamp(drive, 0.0631f, 32.0f) : std::max(0.1f, drive);

    clipIntensity = storedSoftness * clipAmount(volume);
    volExcess = clipAmount(volume);

    ceiling = std::clamp(ceilingLinear, 0.05f, 1.0f);
    oversample = newOversample;
    decoupled = decoupledMode;

    // ⚠️ STALE ADAA STATE IS A SPIKE, NOT A GLITCH. F1 caches the ANTIDERIVATIVE of the previous
    // sample — under the OLD curve. Switch curve and the next sample computes
    //
    //     (F_new(u) - F_old(x1)) / (u - x1)
    //
    // i.e. the slope of a chord drawn between two DIFFERENT functions. With a small denominator that
    // is an arbitrarily large number, and it lands straight on the master bus. Nothing used to write
    // these fields except processADAA itself, so every curve change and every oversampling toggle
    // fired one.
    //
    // Recomputing F1 from the CURRENT x1 under the NEW curve is continuous by construction: the very
    // next sample draws its chord between two points of the same function, so the switch is silent.
    if (curveChanged) {
        F1L   = shapeAntideriv(x1L);
        F1R   = shapeAntideriv(x1R);
        osF1L = shapeAntideriv(osX1L);
        osF1R = shapeAntideriv(osX1R);
    }
    // The oversampler's rings were filled at the old stride, so at a new factor they are read back as
    // a different signal entirely. (masterDrive_.reset() was never called on an OS change, so this
    // was a one-buffer transient on every 2x<->4x toggle.)
    if (oversampleChanged || decoupledChanged) {
        osL_.reset();
        osR_.reset();
        osX1L = osF1L = osX1R = osF1R = 0.0f;
    }
    if (decoupledChanged) {
        x1L = F1L = x1R = F1R = 0.0f;
    }
}

// Pre-gain into the shaper: 1× at 100% master, rising to (1 + drive)× at 200%.
float NativeMasterDrive::effectiveDrive() const noexcept {
    return 1.0f + inputGain * volExcess;
}

// Dry/wet blend: clean at ≤100%, sweeping to full character by 200%. Softness biases how
// quickly the character comes in (default 0.4 → unity ceiling, i.e. fully wet at 200%).
float NativeMasterDrive::wetAmount() const noexcept {
    return volExcess * std::clamp(0.6f + storedSoftness, 0.0f, 1.0f);
}

float NativeMasterDrive::shape(float u) const noexcept {
    switch (curve) {
    case MasterDriveCurve::tanh: return std::tanh(u);
    case MasterDriveCurve::hard: return u < -1.0f ? -1.0f : (u > 1.0f ? 1.0f : u);
    case MasterDriveCurve::fold: return std::sin(kFoldK * u);
    case MasterDriveCurve::soft:
    default:                     return std::tanh(u); // unused; soft uses processSoft
    }
}

float NativeMasterDrive::shapeAntideriv(float u) const noexcept {
    switch (curve) {
    case MasterDriveCurve::tanh:
        return stableLnCosh(u);
    case MasterDriveCurve::hard: {
        const float a = std::fabs(u);
        return a <= 1.0f ? 0.5f * u * u : (a - 0.5f);
    }
    case MasterDriveCurve::fold:
        return -kInvFoldK * std::cos(kFoldK * u);
    case MasterDriveCurve::soft:
    default:
        return stableLnCosh(u);
    }
}

// 1st-order antiderivative anti-aliasing (Parker/Esqueda/Välimäki). Replaces f(u) by the
// average slope of its antiderivative across the last two samples, which strongly suppresses
// the aliased harmonics a naive waveshaper would fold back below Nyquist. `g` is the pre-gain
// (legacy uses effectiveDrive(); decoupled uses the always-on drive), `ceil` the output clip
// point (1.0 in legacy), and `wet` the dry/wet blend.
float NativeMasterDrive::adaaShape(float u, float& x1, float& F1) const noexcept {
    const float Fc = shapeAntideriv(u);
    const float du = u - x1;
    float y;
    if (std::fabs(du) > 1.0e-5f) {
        y = (Fc - F1) / du;
    } else {
        y = shape(0.5f * (u + x1)); // ill-conditioned divisor → fall back to midpoint sample
    }
    x1 = u;
    F1 = Fc;
    return y;
}

float NativeMasterDrive::processADAA(float x, float& x1, float& F1,
                                     float g, float ceil, float wet) const noexcept {
    const float u = x * g / ceil;
    const float y = adaaShape(u, x1, F1) * ceil;
    return x * (1.0f - wet) + y * wet;
}

// Bounded shaping curve for the decoupled clipper path. `pre` is the already-driven,
// ceiling-normalized input (clips at |pre| = 1). Result is in [-1, 1]; the caller scales
// it back up by the ceiling. `soft` is a rounded atan knee controlled by `knee`.
float NativeMasterDrive::shapeCurveDecoupled(float pre) const noexcept {
    switch (curve) {
    case MasterDriveCurve::hard:
        return pre < -1.0f ? -1.0f : (pre > 1.0f ? 1.0f : pre);
    case MasterDriveCurve::tanh:
        return std::tanh(pre);
    case MasterDriveCurve::fold:
        return std::sin(1.5707963267948966f * pre); // π/2 — matches shape()'s folder
    case MasterDriveCurve::soft:
    default: {
        const float a = std::fabs(pre);
        if (a <= knee) return pre;
        const float headroom = 1.0f - knee;
        const float normalizedExcess = (a - knee) / headroom;
        const float saturatedExcess =
            std::min(1.0f, std::atan(normalizedExcess * curveHardness) / atanNorm);
        const float out = knee + saturatedExcess * headroom;
        return pre > 0.0f ? out : -out;
    }
    }
}

// Legacy MasterClipper.swift atan-knee, reproduced exactly (memoryless; only engages >100%).
float NativeMasterDrive::processSoft(float x) const noexcept {
    if (clipIntensity > 0.0f && std::fabs(x) > 1.0e-6f) {
        const float serialDrive = 1.0f + (inputGain - 1.0f) * clipIntensity;
        const float dynamicKnee = knee + (0.98f - knee) * (1.0f - clipIntensity);
        const float driven = x * serialDrive;
        const float absX = std::fabs(driven);
        if (absX > dynamicKnee) {
            const float headroom = 1.0f - dynamicKnee;
            const float normalizedExcess = (absX - dynamicKnee) / headroom;
            const float saturatedExcess =
                std::min(1.0f, std::atan(normalizedExcess * curveHardness) / atanNorm);
            const float out = dynamicKnee + saturatedExcess * headroom;
            return driven > 0.0f ? out : -out;
        }
        return driven;
    }
    return x;
}

void NativeMasterDrive::processSample(float& left, float& right) noexcept {
    if (!std::isfinite(left))  left  = 0.0f;
    if (!std::isfinite(right)) right = 0.0f;

    if (decoupled) {
        // FL/Ozone-style section: always-on drive into a fixed ceiling, optionally oversampled.
        const float g = inputGain;
        const float c = ceiling;
        if (oversample >= 2) {
            // The naive curve, over a polyphase IIR halfband (NativeOversampler). ADAA is
            // deliberately NOT run inside this loop, and the measurement is why — isolating the two
            // over the NEW filter (engine/tools/DSP-BASELINE.md), hard/tanh @ drive 4, 1660 Hz:
            //
            //                                   hard        tanh      15 kHz passband
            //   old windowed-sinc + naive      -59.2       -45.7       ~0 dB
            //   new halfband + naive           -58.6      **-75.5**    ~0 dB   ← the win is the FILTER
            //   new halfband + ADAA-in-loop    -58.4       -65.1      -1.09 dB
            //
            // The halfband alone buys +30 dB on tanh (and on any real program material, whose harmonics
            // fall off far faster than a pure hard-clipped sine's 1/f). ADAA on top adds at most +1.6 dB
            // while permanently dulling 15 kHz by 1.09 dB — a bad trade, and the reverse of the plan's
            // "they only pay off together". So the loop stays naive; ADAA still runs at the base rate
            // (oversample == 0) where its droop is the point of that mode, not a cost.
            const auto shaper = [this, g, c](float s) noexcept {
                return c * shapeCurveDecoupled(s * g / c);
            };
            left  = osL_.process(left,  oversample, shaper);
            right = osR_.process(right, oversample, shaper);
        } else if (curve == MasterDriveCurve::soft) {
            left  = c * shapeCurveDecoupled(left  * g / c); // atan knee is gentle → no ADAA needed
            right = c * shapeCurveDecoupled(right * g / c);
        } else {
            left  = processADAA(left,  x1L, F1L, g, c, 1.0f);
            right = processADAA(right, x1R, F1R, g, c, 1.0f);
        }
    } else if (curve == MasterDriveCurve::soft) {
        left  = processSoft(left);
        right = processSoft(right);
    } else {
        left  = processADAA(left,  x1L, F1L, effectiveDrive(), 1.0f, wetAmount());
        right = processADAA(right, x1R, F1R, effectiveDrive(), 1.0f, wetAmount());
    }

    if (left  >  1.0f) left  =  1.0f; else if (left  < -1.0f) left  = -1.0f;
    if (right >  1.0f) right =  1.0f; else if (right < -1.0f) right = -1.0f;
}

} // namespace scoopyloops
