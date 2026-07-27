#include "NativeToneFilter.hpp"

#include "NativeDenormal.hpp"

#include <algorithm>
#include <cmath>

namespace scoopyloops {

namespace {
constexpr double kQMin = 0.5;
constexpr double kQMax = 18.0;

/// Padé(3,2) tanh — the saturator for the resonance drive. `std::tanh` costs ~5 ns a call and this
/// runs twice per sample per driven voice, so a rational approximation is not a nicety.
///
/// x·(27+x²)/(27+9x²) tracks tanh to ~1e-3 over the musical range and — pleasingly — equals exactly
/// 1.0 at x = 3 (3·36/108), so clamping there is CONTINUOUS, not a corner. (tanh(3) = 0.995; the
/// approximation runs slightly hot near the clamp, which reads as a marginally harder knee. For a
/// drive circuit that is character, not error.)
inline double ratTanh(double x) noexcept {
    if (x >  3.0) return  1.0;
    if (x < -3.0) return -1.0;
    const double x2 = x * x;
    return x * (27.0 + x2) / (27.0 + 9.0 * x2);
}
}  // namespace

// ─── helpers ─────────────────────────────────────────────────────────────────

bool NativeToneFilter::isLowpassMode() const noexcept {
    // Only meaningful for Mode::tone, where the SIGN of the knob picks the direction. The four
    // explicit filter modes never consult this.
    return lastTone < 0.0f;
}

/// The tone value the filter actually runs on, after the one correction the old code was missing.
///
/// ⚠️ THE SIGN-FOLD BUG. `tone` is stored UNIPOLAR (0…100) in the four filter modes — only the
/// legacy `tone` tilt is bipolar. But modulation (LFO depths, per-step toneOffsets, glide) is summed
/// and clamped to [-100, +100] in the engine core, so it can push the value NEGATIVE in a filter
/// mode. The old code then took |tone| to derive the cutoff, which REFLECTED the sweep off the open
/// end instead of clamping at it: a full-depth LFO on a lowpass parked near tone≈0 produced a
/// frequency-DOUBLED bounce, and the small-|tone| bypass below meant the filter ALSO dropped out
/// entirely for a few samples on each zero crossing. Audible on any deep sweep.
///
/// "More open than fully open" has exactly one honest reading, and it is 0.
double NativeToneFilter::effectiveTone() const noexcept {
    double t = static_cast<double>(lastTone);
    if (lastMode != Mode::tone && t < 0.0) t = 0.0;
    return t;
}

double NativeToneFilter::calculateTargetFrequency() const noexcept {
    const double tone        = effectiveTone();
    const double absTone     = tone < 0.0 ? -tone : tone;
    const double normalized  = absTone / 100.0 < 1.0 ? absTone / 100.0 : 1.0;
    const double nyquist     = sampleRate * 0.45;

    double freq = 0.0;
    switch (lastMode) {
        case Mode::tone: {
            if (tone < 0.0) {
                // Lowpass: 8000 Hz → 20 Hz
                const double maxFreq  = 8000.0;
                const double minFreq  = 20.0;
                freq = maxFreq * std::exp(-normalized * std::log(maxFreq / minFreq));
            } else {
                // Highpass: 200 Hz → 8000 Hz
                const double minFreq  = 200.0;
                const double maxFreq  = 8000.0;
                freq = minFreq * std::exp(normalized * std::log(maxFreq / minFreq));
            }
            break;
        }
        case Mode::lowPass: {
            const double maxFreq = nyquist < 18000.0 ? nyquist : 18000.0;
            const double minFreq = 55.0;
            const double shaped  = std::pow(normalized, 1.35);
            freq = maxFreq * std::exp(-shaped * std::log(maxFreq / minFreq));
            break;
        }
        case Mode::highPass: {
            const double maxFreq = nyquist < 6500.0 ? nyquist : 6500.0;
            const double minFreq = 25.0;
            const double shaped  = std::pow(normalized, 1.25);
            freq = minFreq * std::exp(shaped * std::log(maxFreq / minFreq));
            break;
        }
        case Mode::bandPass:
        case Mode::notch: {
            // Unipolar full-range center sweep: 40 Hz → 18 kHz (log), mids reachable mid-travel.
            const double maxFreq = nyquist < 18000.0 ? nyquist : 18000.0;
            const double minFreq = 40.0;
            freq = minFreq * std::exp(normalized * std::log(maxFreq / minFreq));
            break;
        }
    }

    if (freq < 20.0)    freq = 20.0;
    if (freq > nyquist) freq = nyquist;
    return freq;
}

void NativeToneFilter::refreshTargetFrequency() noexcept {
    targetFreq       = calculateTargetFrequency();
    targetSampleRate = sampleRate;
}

void NativeToneFilter::updateCoefficients() noexcept {
    constexpr double chaseSpeed = 64.0;

    // sampleRate is a public field the engine assigns directly, so it can move without going through
    // setParameters. One compare per sample is cheap insurance against a stale mapping.
    if (sampleRate != targetSampleRate) refreshTargetFrequency();

    // lastQ is the ACTUAL quality factor (set from the per-track menu). The legacy `tone` tilt stays
    // Butterworth (no resonant peak) regardless of the stored Q.
    double qTarget = (lastMode == Mode::tone) ? 0.7071 : static_cast<double>(lastQ);
    qTarget = std::clamp(qTarget, kQMin, kQMax);

    // ⚠️ THE SETTLE SNAP — the single biggest cost saving in this file, and the reason the old filter
    // burned 0.29% of a core PER VOICE while sitting completely still (engine/tools/DSP-BASELINE.md).
    //
    // The chase is an asymptotic one-pole: it approaches its target geometrically and NEVER equals
    // it. The old code therefore re-ran exp + pow + sin + cos + 8 divides EVERY SAMPLE, for the
    // entire life of every voice, to recompute coefficients that differed in the 12th decimal place.
    // Here the chase only runs while it is actually moving; when it lands within an inaudible
    // distance of the target (a millihertz of cutoff; a millionth of a Q) it snaps exactly onto it,
    // and from the next sample on this whole function is two compares and a return.
    //
    // Thresholds are absolute rather than relative so a 40 Hz cutoff settles as readily as an 18 kHz
    // one.
    bool moved = false;
    if (frequencychase != targetFreq) {
        frequencychase = ((frequencychase * chaseSpeed) + targetFreq) / (chaseSpeed + 1.0);
        if (std::fabs(frequencychase - targetFreq) < 1.0e-3) frequencychase = targetFreq;
        moved = true;
    }
    if (resonancechase != qTarget) {
        resonancechase = ((resonancechase * chaseSpeed) + qTarget) / (chaseSpeed + 1.0);
        if (std::fabs(resonancechase - qTarget) < 1.0e-6) resonancechase = qTarget;
        moved = true;
    }

    // Settled, and the coefficients were already built from these exact values on the last sample
    // that moved. Nothing to do — this is the common case for almost every sample of every voice.
    // `mixMoving` must be part of the test, or a mode crossfade that outlives the freq/Q chase would
    // be abandoned half-way and the filter would park on a blend of two modes.
    if (!moved && coeffValid && lastMode == coeffMode && !mixMoving) return;

    if (moved || !coeffValid || lastMode != coeffMode) {
        coeffMode  = lastMode;
        coeffValid = true;

        const double Q  = std::clamp(resonancechase, kQMin, kQMax);
        const double fc = std::min(frequencychase, sampleRate * 0.45);

        // The EXACT prewarp. Unlike the BLT's cos/sin pair, this puts the cutoff precisely at fc for
        // any fc < Nyquist, with no squashing of the response near the top of the band.
        const double g = std::tan(M_PI * fc / sampleRate);
        const double k = 1.0 / Q;

        a1 = 1.0 / (1.0 + g * (g + k));
        a2 = g * a1;
        a3 = g * a2;
        gCoeff = g;

        // The output mix. v1 is the band-pass output and v2 the low-pass; every other response is a
        // linear combination of those two with the input:
        //     LP    = v2
        //     BP    = v1                (peak gain Q — scale by k for constant 0 dB peak gain)
        //     HP    = v0 - k·v1 - v2
        //     notch = LP + HP = v0 - k·v1
        switch (lastMode) {
            case Mode::lowPass:  tm0 = 0.0; tm1 =  0.0; tm2 =  1.0; break;
            case Mode::highPass: tm0 = 1.0; tm1 =   -k; tm2 = -1.0; break;
            // Constant 0 dB peak-gain band-pass — matches the RBJ section this replaced, so a saved
            // patch keeps its level.
            case Mode::bandPass: tm0 = 0.0; tm1 =    k; tm2 =  0.0; break;
            case Mode::notch:    tm0 = 1.0; tm1 =   -k; tm2 =  0.0; break;
            case Mode::tone:
                if (isLowpassMode()) { tm0 = 0.0; tm1 = 0.0; tm2 =  1.0; }
                else                 { tm0 = 1.0; tm1 =  -k; tm2 = -1.0; }
                break;
        }

        if (m0 != tm0 || m1 != tm1 || m2 != tm2) mixMoving = true;
    }

    // Crossfade the output mix toward its target (see the note in the header). On first activation —
    // and on every voice retrigger, since reset() clears the flag — snap instead, or the voice would
    // fade in from the struct's m0=1 passthrough default.
    if (!mixSeeded) {
        m0 = tm0; m1 = tm1; m2 = tm2;
        mixSeeded = true;
        mixMoving = false;
    } else if (mixMoving) {
        constexpr double kMixSnap = 1.0e-6;
        m0 = ((m0 * chaseSpeed) + tm0) / (chaseSpeed + 1.0);
        m1 = ((m1 * chaseSpeed) + tm1) / (chaseSpeed + 1.0);
        m2 = ((m2 * chaseSpeed) + tm2) / (chaseSpeed + 1.0);
        if (std::fabs(m0 - tm0) < kMixSnap) m0 = tm0;
        if (std::fabs(m1 - tm1) < kMixSnap) m1 = tm1;
        if (std::fabs(m2 - tm2) < kMixSnap) m2 = tm2;
        if (m0 == tm0 && m1 == tm1 && m2 == tm2) mixMoving = false;
    }
}

// ─── public API ──────────────────────────────────────────────────────────────

void NativeToneFilter::reset() noexcept {
    ic1L = ic2L = ic1R = ic2R = 0.0;
    // chase intentionally preserved so transitions stay smooth.
    // The output mix, however, must SNAP on the next sample rather than crossfade: a retriggered
    // voice starts from silence, and fading its mix in from wherever the previous voice left it
    // would leak the wrong response into the first few milliseconds of the hit.
    mixSeeded = false;
    mixMoving = false;
}

void NativeToneFilter::setParameters(float tone, float q, Mode mode, float drive) noexcept {
    if (tone == lastTone && q == lastQ && mode == lastMode && drive == lastDrive) return;

    const bool modeChanged = (mode != lastMode);
    lastTone  = tone;
    lastQ     = q;
    lastDrive = drive;
    lastMode  = mode;

    // The tone→Hz mapping is a pure function of (tone, mode, sampleRate). This is the only place any
    // of them can change, so this is the only place it needs recomputing — which is what keeps the
    // transcendentals out of the per-sample path.
    refreshTargetFrequency();

    // Mirrors processSample's engagement rule (including resonant-Q, which defeats the bypass) so
    // the chase snaps on first activation for every voice that will actually run.
    const bool engaged = (tone < -0.5f || tone > 0.5f
                          || mode == Mode::bandPass || mode == Mode::notch
                          || (mode != Mode::tone && q > 0.75f));
    if (!hasInitializedChaseState && engaged) {
        // Snap chase state on first activation to avoid a slow ramp from 8 kHz.
        frequencychase        = targetFreq;
        resonancechase        = (mode == Mode::tone) ? 0.7071 : static_cast<double>(q);
        hasInitializedChaseState = true;
        updateCoefficients();
    }
    // ⚠️ A MODE CHANGE NO LONGER RE-ARMS THE SNAP. The old code cleared hasInitializedChaseState
    // here, so the next call would slam the cutoff onto the new mode's mapping in a single sample.
    // That was harmless while mode could only change at voice TRIGGER (state was zero anyway) — but
    // C2 makes mode changeable on a RINGING voice, and each mode maps `tone` onto a different Hz
    // range, so the snap would be an audible cutoff jump underneath the output crossfade. Letting the
    // frequency chase glide to the new mapping means both halves of a live mode change are smooth:
    // the cutoff slides and the output mix crossfades. A retrigger still snaps, via reset().
    (void)modeChanged;
}

void NativeToneFilter::processSample(float& left, float& right) noexcept {
    const double tone    = effectiveTone();
    const double absTone = tone < 0.0 ? -tone : tone;
    // Band-pass colors everywhere (fully engaged even at tone=0 / freq≈40 Hz), so it never takes the
    // small-|tone| bypass. The other modes are wide-open / flat near tone=0 and may bypass —
    //
    // — but ONLY when the filter would actually be transparent there, and at resonant Q it is not.
    // A fully-open lowpass at Q=16 has a +24 dB peak parked at ~18 kHz; that peak IS the setting the
    // user dialled in, and the old code stepped between it and a flat bypass as the tone crossed 0.5
    // (an LFO sweeping through the open end toggled it every cycle). The bypass was a transparency
    // claim that stopped being true the moment Q left Butterworth. So: in the dedicated filter modes
    // a resonant Q keeps the filter engaged at any tone — the response is then continuous through
    // the open end because the filter simply never leaves the circuit. Butterworth (the 0.7 preset)
    // still bypasses, honestly, and `tone` mode pins Q so it is unaffected.
    const bool resonant = lastMode != Mode::tone && lastMode != Mode::bandPass && lastQ > 0.75f;
    if (absTone <= 0.5 && lastMode != Mode::bandPass && !resonant) return;

    updateCoefficients();

    double outL, outR;
    if (lastDrive > 0.5f) {
        // ── THE DRIVEN KERNEL ────────────────────────────────────────────────────────────────
        // One saturator, on v1 — the band-pass node — applied INSIDE the state update. Placement is
        // the entire design:
        //
        //   • v1 is where the resonant energy lives. Compressing it bounds the energy the filter can
        //     store, so resonance self-limits: at full drive the peak cannot exceed ~unity no matter
        //     the Q, and it SQUISHES as it approaches the ceiling instead of ringing linearly. This
        //     is what the deleted output-tanh pretended to do from outside the loop, and could not.
        //   • v1 is small for passband signal well below cutoff (it is the band-pass response), so
        //     the passband stays clean at moderate drive — the saturation concentrates exactly where
        //     the resonance is. Character lands on the peak, not on the mix.
        //   • v2 is then RE-integrated from the saturated v1 (v2 = ic2 + g·v1ˢ). Skipping that and
        //     keeping the linear v2 would let the lowpass path leak the unsaturated energy around
        //     the limiter.
        //
        // The saturated v1 is one sample late relative to a true implicit (zero-delay) nonlinear
        // solve — the classic cheap formulation. At this placement, inside a lowpass loop, that
        // approximation is benign and costs no iteration.
        //
        // dg maps drive linearly: 100 → the node caps at 1.0 (hard squish + harmonics), 25 → caps at
        // 4.0 (a safety net that only the wildest peaks touch). No oversampling: the nonlinearity
        // sits inside a band-limited loop and is drive-gated; the alias exposure is modest and the
        // per-voice budget will not carry resampling filters.
        const double dg = static_cast<double>(lastDrive) * 0.01;
        const double invDg = 1.0 / dg;

        const double v0L = static_cast<double>(left);
        const double v3L = v0L - ic2L;
        const double v1L = ratTanh((a1 * ic1L + a2 * v3L) * dg) * invDg;
        const double v2L = ic2L + gCoeff * v1L;
        ic1L = flushDenormal(2.0 * v1L - ic1L);
        ic2L = flushDenormal(2.0 * v2L - ic2L);
        outL = m0 * v0L + m1 * v1L + m2 * v2L;

        const double v0R = static_cast<double>(right);
        const double v3R = v0R - ic2R;
        const double v1R = ratTanh((a1 * ic1R + a2 * v3R) * dg) * invDg;
        const double v2R = ic2R + gCoeff * v1R;
        ic1R = flushDenormal(2.0 * v1R - ic1R);
        ic2R = flushDenormal(2.0 * v2R - ic2R);
        outR = m0 * v0R + m1 * v1R + m2 * v2R;
    } else {
        // The linear trapezoidal SVF kernel (Cytomic "SvfLinearTrapOptimised2") — bit-identical to
        // the pre-drive filter. ic1eq/ic2eq are the integrator states; the doubling in their update
        // is what makes the integration trapezoidal rather than Euler, and it is why there is no
        // unit delay anywhere in the feedback path.
        const double v0L = static_cast<double>(left);
        const double v3L = v0L - ic2L;
        const double v1L = a1 * ic1L + a2 * v3L;
        const double v2L = ic2L + a2 * ic1L + a3 * v3L;
        ic1L = flushDenormal(2.0 * v1L - ic1L);
        ic2L = flushDenormal(2.0 * v2L - ic2L);
        outL = m0 * v0L + m1 * v1L + m2 * v2L;

        const double v0R = static_cast<double>(right);
        const double v3R = v0R - ic2R;
        const double v1R = a1 * ic1R + a2 * v3R;
        const double v2R = ic2R + a2 * ic1R + a3 * v3R;
        ic1R = flushDenormal(2.0 * v1R - ic1R);
        ic2R = flushDenormal(2.0 * v2R - ic2R);
        outR = m0 * v0R + m1 * v1R + m2 * v2R;
    }

    // There is deliberately no OUTPUT saturation. The old biquad pushed its output through a tanh()
    // whenever Q > 1.5 — outside the filter, so the peak still ballooned to +22 dB internally and
    // the tanh squared the result off. Resonance character now lives where it belongs: `lastDrive`
    // saturates the band-pass STATE inside the loop (the driven kernel above). At drive 0 the filter
    // is exactly linear, and a high-Q patch rings freely by design.
    left  = std::isfinite(static_cast<float>(outL)) ? static_cast<float>(outL) : 0.0f;
    right = std::isfinite(static_cast<float>(outR)) ? static_cast<float>(outR) : 0.0f;
}

} // namespace scoopyloops
