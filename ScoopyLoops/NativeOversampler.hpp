#pragma once

// ============================================================================
//  NativeOversampler — per-channel 2x / 4x oversampler for the master clipper's
//  nonlinearity, built on a 2-path POLYPHASE IIR HALFBAND (Laurent de Soras'
//  hiir, WTFPL). The shaper is applied to every oversampled sub-sample via a
//  caller-supplied lambda, so ADAA history can ride at the oversampled rate.
//
//  WHY THIS REPLACED THE WINDOWED-SINC. The previous design was a linear-phase
//  Kaiser windowed-sinc whose cutoff sat AT Nyquist. Measured (engine/tools/
//  DSP-BASELINE.md), its audible alias floor was stuck near -60 dBc and MORE
//  TAPS DID NOT MOVE IT (16/32/64 taps → -60.3/-61.8/-68.6 dBc): a cutoff at
//  Nyquist spends its whole transition band straddling the region a clipper's
//  harmonics are densest in, and no tap count moves the cutoff. A polyphase IIR
//  halfband puts a sharp elliptic transition just below Nyquist for a fraction
//  of the MACs, with near-zero latency (a few samples, not the FIR's group
//  delay). The coefficients are the elliptic "minimal-Q" halfband set, computed
//  here from the transition bandwidth exactly as hiir's PolyphaseIir2Designer
//  does (theta-series nome expansion).
//
//  The allpass section is  y[n] = c·(x[n] - y[n-1]) + x[n-1]  =  (c + z⁻¹)/(1 +
//  c·z⁻¹): a first-order allpass at the path's own (decimated) rate, i.e. a z⁻²
//  allpass at the full rate — the polyphase halfband structure. spl_0 carries
//  the even coefficient indices, spl_1 the odd; their sum, halved, is the
//  halfband output.
//
//  RT-safety: coefficients computed once in the constructor (off the audio
//  thread). process() is allocation-free. One instance per channel (state).
//
//  4x is a cascade: a sharp stage A (1↔2x, the quality-determining filter,
//  always used) and a relaxed stage B (2↔4x), whose stopband only has to start
//  near 2x-Nyquist and so needs far fewer coefficients.
// ============================================================================

#include <array>
#include <cmath>
#include <cstddef>
#include <cstdint>

#include "NativeDenormal.hpp"

namespace scoopyloops {

// One 2-path polyphase IIR halfband stage: an up-sampler (1→2) and a matched
// down-sampler (2→1) sharing NC allpass coefficients but separate state.
template <int NC>
struct HalfbandStage {
    static constexpr double kPi = 3.14159265358979323846;

    double coef[NC] {};
    double xu[NC] {}, yu[NC] {};   // up-sampler state
    double xd[NC] {}, yd[NC] {};   // down-sampler state

    void reset() noexcept {
        for (int i = 0; i < NC; ++i) { xu[i] = yu[i] = xd[i] = yd[i] = 0.0; }
    }

    // 1 → 2. Both output phases come from the same input run through the two
    // interleaved allpass paths (hiir Upsampler2x).
    inline void upsample(double in, double& o0, double& o1) noexcept {
        double even = in, odd = in;
        processPair(even, odd, xu, yu);
        o0 = even; o1 = odd;
    }

    // 2 → 1. i0/i1 are the two high-rate sub-samples (hiir Downsampler2x uses
    // spl_0 = in[1], spl_1 = in[0]); returns the band-limited decimated sample.
    inline double downsample(double i0, double i1) noexcept {
        double s0 = i1, s1 = i0;
        processPair(s0, s1, xd, yd);
        return 0.5 * (s0 + s1);
    }

    void setCoefs(double transition) noexcept {
        double k = std::tan((1.0 - transition * 2.0) * kPi / 4.0);
        k *= k;
        const double kksqrt = std::pow(1.0 - k * k, 0.25);
        const double e  = 0.5 * (1.0 - kksqrt) / (1.0 + kksqrt);
        const double e2 = e * e;
        const double e4 = e2 * e2;
        const double q  = e * (1.0 + e4 * (2.0 + e4 * (15.0 + 150.0 * e4)));
        const int order = NC * 2 + 1;
        for (int index = 0; index < NC; ++index) {
            coef[index] = computeCoef(index, k, q, order);
        }
    }

private:
    // hiir StageProcFpu::process_sample_pos, unrolled: spl0 runs the even coef
    // indices, spl1 the odd; each is the first-order allpass with in-place memory.
    // A denormal flush on the y-state keeps the IIR from sticking in subnormals on
    // silence (the master clipper is always-on; WASM has no FTZ — see NativeDenormal).
    inline void processPair(double& spl0, double& spl1, double* x, double* y) noexcept {
        int i = 0;
        for (; i + 1 < NC; i += 2) {
            const double t0 = (spl0 - y[i])     * coef[i]     + x[i];
            const double t1 = (spl1 - y[i + 1]) * coef[i + 1] + x[i + 1];
            x[i] = spl0;  y[i] = flushDenormal(t0);  spl0 = t0;
            x[i + 1] = spl1;  y[i + 1] = flushDenormal(t1);  spl1 = t1;
        }
        if (i < NC) {                                   // NC odd → last stage is spl0 only
            const double t = (spl0 - y[i]) * coef[i] + x[i];
            x[i] = spl0;  y[i] = flushDenormal(t);  spl0 = t;
        }
    }

    // ── elliptic coefficient helpers (hiir PolyphaseIir2Designer) ─────────────
    static double ipow(double base, int e) noexcept {
        double r = 1.0;
        while (e > 0) { if (e & 1) r *= base; base *= base; e >>= 1; }
        return r;
    }
    static double accNum(double q, int order, int c) noexcept {
        int i = 0, j = 1; double acc = 0.0, term;
        do {
            term = ipow(q, i * (i + 1));
            term *= std::sin((i * 2 + 1) * c * kPi / order) * j;
            acc += term; j = -j; ++i;
        } while (std::fabs(term) > 1e-100);
        return acc;
    }
    static double accDen(double q, int order, int c) noexcept {
        int i = 1, j = -1; double acc = 0.0, term;
        do {
            term = ipow(q, i * i);
            term *= std::cos(i * 2 * c * kPi / order) * j;
            acc += term; j = -j; ++i;
        } while (std::fabs(term) > 1e-100);
        return acc;
    }
    static double computeCoef(int index, double k, double q, int order) noexcept {
        const int c = index + 1;
        const double num  = accNum(q, order, c) * std::pow(q, 0.25);
        const double den  = accDen(q, order, c) + 0.5;
        const double ww   = num / den;
        const double wwsq = ww * ww;
        const double x    = std::sqrt((1.0 - wwsq * k) * (1.0 - wwsq / k)) / (1.0 + wwsq);
        return (1.0 - x) / (1.0 + x);
    }
};

struct NativeOversampler {
    // Stage A (1↔2x): the quality-determining halfband. transition 0.05 →
    // passband to ~0.225·Fs_os (≈21.6 kHz at 96k), stopband from ~0.275. 10
    // coefficients measured (scoopy_clipper_test): passband flat to 20 kHz, tanh
    // @ drive 4 −75.5 dBc (old windowed-sinc −45.7 = +30 dB), ~98 ns/sample 2x.
    static constexpr int kNcA = 10;
    static constexpr double kTransA = 0.05;
    // Stage B (2↔4x): only rejects images near 2x-Nyquist, far above audio, so a
    // wide transition and few coefficients give deep rejection cheaply.
    static constexpr int kNcB = 4;
    static constexpr double kTransB = 0.255;

    NativeOversampler() {
        stageA_.setCoefs(kTransA);
        stageB_.setCoefs(kTransB);
        reset();
    }

    void reset() noexcept { stageA_.reset(); stageB_.reset(); }

    // Oversample `x` by `factor` (2 or 4), apply `shape` to each oversampled
    // sub-sample, band-limit and decimate back to one output sample. `shape` is
    // called once per sub-sample IN ORDER, so a stateful (ADAA) shaper advances
    // its history at the oversampled rate.
    template <typename Shaper>
    float process(float x, int factor, Shaper&& shape) noexcept {
        if (factor >= 4) {
            double a0, a1;
            stageA_.upsample(static_cast<double>(x), a0, a1);
            double b0, b1, b2, b3;
            stageB_.upsample(a0, b0, b1);
            stageB_.upsample(a1, b2, b3);
            const double s0 = static_cast<double>(shape(static_cast<float>(b0)));
            const double s1 = static_cast<double>(shape(static_cast<float>(b1)));
            const double s2 = static_cast<double>(shape(static_cast<float>(b2)));
            const double s3 = static_cast<double>(shape(static_cast<float>(b3)));
            const double d0 = stageB_.downsample(s0, s1);
            const double d1 = stageB_.downsample(s2, s3);
            return static_cast<float>(stageA_.downsample(d0, d1));
        }
        double u0, u1;
        stageA_.upsample(static_cast<double>(x), u0, u1);
        const double s0 = static_cast<double>(shape(static_cast<float>(u0)));
        const double s1 = static_cast<double>(shape(static_cast<float>(u1)));
        return static_cast<float>(stageA_.downsample(s0, s1));
    }

private:
    HalfbandStage<kNcA> stageA_ {};
    HalfbandStage<kNcB> stageB_ {};
};

} // namespace scoopyloops
