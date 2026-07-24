#pragma once

// ============================================================================
//  NativeSincResampler — anti-aliased 16-tap windowed-sinc fractional reader.
//
//  Purpose: the quality ceiling for TP / varispeed mode (which is pure
//  resampling — no time-stretch). Replaces the 4-point cubic Hermite
//  `interpolate()` when SCOOPY_SINC_RESAMPLER == 1.
//
//  Two wins over cubic:
//    1. 16-tap windowed sinc → far less imaging on pitch-up and far less HF
//       loss on pitch-down than a 4-point polynomial.
//    2. ANTI-ALIASING on decimation: when the per-sample advance `rate` > 1.0
//       (deck pitched up / fast sync), the filter cutoff is lowered to the new
//       Nyquist (1/rate) so high frequencies are band-limited BEFORE they fold
//       back as aliasing. Cubic cannot do this.
//
//  RT-safety: a dense windowed-sinc *prototype* is built once in the
//  constructor (off the audio thread — the engine core is constructed by the
//  bridge during setup). `read()` is allocation-free and only does table
//  lookups + a 16-tap MAC. Variable cutoff is achieved by sampling the single
//  prototype at a scaled argument, so no per-rate tables are needed.
// ============================================================================

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace scoopyloops {

class NativeSincResampler {
public:
    NativeSincResampler() { buildPrototype(); }

    // Fractional read of `channel` at `position`, clamped to [startFrame, endFrame).
    // `rate` is the per-output-sample advance through the source (|effectiveRate|);
    // values > 1.0 trigger the anti-alias low-pass.
    float read(const std::vector<float>& channel,
               double position,
               std::size_t startFrame,
               std::size_t endFrame,
               double rate) const noexcept {
        if (channel.empty() || endFrame <= startFrame) {
            return 0.0f;
        }
        const std::int64_t index = static_cast<std::int64_t>(std::floor(position));
        const double frac = position - static_cast<double>(index);

        // Decimation (rate > 1) needs a lower cutoff to avoid aliasing; upsampling
        // / unity keeps full bandwidth.
        const double cutoff = rate > 1.0 ? 1.0 / rate : 1.0;

        const std::int64_t lo = static_cast<std::int64_t>(startFrame);
        const std::int64_t hi = static_cast<std::int64_t>(endFrame) - 1;
        const auto sampleAt = [&channel, lo, hi](std::int64_t i) noexcept -> double {
            const std::int64_t c = std::clamp<std::int64_t>(i, lo, hi);
            return static_cast<double>(channel[static_cast<std::size_t>(c)]);
        };

        double acc = 0.0;
        double norm = 0.0;
        // 16 taps centered on the read position: source indices index-7 .. index+8.
        for (int k = -(kHalf - 1); k <= kHalf; ++k) {
            const double t = static_cast<double>(k) - frac;  // distance to tap (in samples)
            const double w = protoLookup(t * cutoff);
            acc  += w * sampleAt(index + k);
            norm += w;
        }
        // Normalizing each read gives unity DC gain for any cutoff (the band-limit
        // scaling otherwise changes the tap-sum), so no separate gain term is needed.
        return norm != 0.0 ? static_cast<float>(acc / norm)
                           : static_cast<float>(sampleAt(index));
    }

private:
    // 16 taps (±8 around the read point); prototype sampled at 512 points per unit
    // of t, covering t in [-8, +8].
    static constexpr int kNumTaps    = 16;
    static constexpr int kHalf       = kNumTaps / 2;      // 8
    static constexpr int kProtoPerUnit = 512;
    static constexpr int kProtoSize  = 2 * kHalf * kProtoPerUnit + 1;  // 8193

    std::vector<float> proto_;  // windowed-sinc prototype over t in [-kHalf, kHalf]

    // Linear-interpolated lookup of the prototype at filter argument `arg`.
    float protoLookup(double arg) const noexcept {
        if (std::abs(arg) >= static_cast<double>(kHalf)) {
            return 0.0f;
        }
        const double fpos = (arg + static_cast<double>(kHalf))
                          * static_cast<double>(kProtoPerUnit);
        const std::int64_t i0 = static_cast<std::int64_t>(std::floor(fpos));
        const double g = fpos - static_cast<double>(i0);
        const std::size_t last = proto_.size() - 1;
        const std::size_t a = static_cast<std::size_t>(
            std::clamp<std::int64_t>(i0, 0, static_cast<std::int64_t>(last)));
        const std::size_t b = std::min(a + 1, last);
        return static_cast<float>(proto_[a] * (1.0 - g) + proto_[b] * g);
    }

    void buildPrototype() {
        proto_.resize(static_cast<std::size_t>(kProtoSize));
        constexpr double beta = 9.0;  // Kaiser β ≈ 9 → ~ -80 dB stopband
        const double invI0Beta = 1.0 / besselI0(beta);
        for (int m = 0; m < kProtoSize; ++m) {
            const double t = static_cast<double>(m) / static_cast<double>(kProtoPerUnit)
                           - static_cast<double>(kHalf);
            // sinc(t)
            double s;
            if (std::abs(t) < 1.0e-9) {
                s = 1.0;
            } else {
                const double x = M_PI * t;
                s = std::sin(x) / x;
            }
            // Kaiser window over r = t / kHalf in [-1, 1]
            const double r = t / static_cast<double>(kHalf);
            double win = 0.0;
            if (std::abs(r) <= 1.0) {
                win = besselI0(beta * std::sqrt(std::max(0.0, 1.0 - r * r))) * invI0Beta;
            }
            proto_[static_cast<std::size_t>(m)] = static_cast<float>(s * win);
        }
    }

    static double besselI0(double x) noexcept {
        double sum = 1.0;
        double term = 1.0;
        const double xx = (x * x) / 4.0;
        for (int k = 1; k < 32; ++k) {
            term *= xx / (static_cast<double>(k) * static_cast<double>(k));
            sum += term;
            if (term < 1.0e-12 * sum) break;
        }
        return sum;
    }
};

} // namespace scoopyloops
