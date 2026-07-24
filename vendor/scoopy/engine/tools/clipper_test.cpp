// ─────────────────────────────────────────────────────────────────────────────────────────────
// C0 — THE CLIPPER HARNESS. Measures how much garbage `NativeMasterDrive` folds back into the
// audible band, and what it costs. This is the BASELINE for C4 (ADAA inside the oversampler).
//
// WHY AN FFT AND NOT A NULL TEST. A clipper is SUPPOSED to change the signal — subtracting a
// before and an after tells you only that it did. The question is *what kind* of new energy it
// made: harmonics (musical, wanted, that IS the clipper) or aliases (inharmonic, unwanted, folded
// back down from above Nyquist). Only a spectrum separates those two, so only a spectrum can grade
// an anti-aliasing change.
//
// THE METHOD — and the trap that has to be avoided to get it right.
//
// ⚠️ THE OBVIOUS TEST IS BROKEN. The natural instinct is to put the sine on an exact FFT bin (k
// cycles in N samples) so there is no spectral leakage, then call bins (n·k mod N) "harmonic" and
// everything else "alias". That test reports ~ −170 dBc of aliasing for a naive hard clipper, which
// is nonsense, and the reason is worth stating: a bin-aligned sine produces an output that is
// EXACTLY PERIODIC in the window, so every one of its harmonics — INCLUDING the ones that folded
// back from above Nyquist — lands on a bin that is itself a multiple of k. Alias and harmonic are
// the same bins. They are not separable, even in principle, by that construction.
//
// THE FIX is to make the input frequency incommensurate with the sample rate. A harmonic h folds to
// |h·f0 − m·fs|, and that can only coincide with a true harmonic h' if (h − h')·f0 = m·fs — i.e.
// only if f0/fs is a rational with a small denominator. At f0 = 1660 Hz, fs = 48 kHz, f0/fs = 83/2400
// in lowest terms, so a coincidence needs h − h' ≥ 2400. We look at ~30 harmonics. No collision.
//
// The price of leaving the bin grid is spectral leakage, and it would bury the very floor we are
// trying to measure — so the window has to have sidelobes BELOW the aliasing we want to see. A
// Kaiser at β = 20 gives roughly −190 dB, comfortably under the float32 quantisation floor of the
// signal itself. A Hann (−31 dB sidelobes) or even a Blackman-Harris (−92 dB) would silently floor
// this whole measurement.
//
// So: Kaiser-windowed FFT of a non-bin-aligned sine, then partition:
//
//   • HARMONIC — bins within ±16 of h·f0 for each h whose harmonic is genuinely below Nyquist.
//     This is the wanted distortion.
//   • ALIAS    — everything else above DC. This is the defect.
//
// Two numbers come out, and they are NOT interchangeable:
//
//   SNR          = 10·log10(harmonic energy / alias energy). The headline, but it is dominated by
//                  alias energy sitting just below Nyquist, which is nearly inaudible.
//   sub-fund     = the loudest alias bin BELOW the fundamental, in dBc. THIS is the one that
//                  matters — inharmonic energy under the fundamental is the "digital fizz" you
//                  actually hear, and it is what ADAA attacks. A change that improves SNR by 1 dB
//                  and sub-fund by 38 dB is a large win, and only the second column shows it.
//
// The probe is run at 1660 Hz (a musical mid) and 4186 Hz (hat/stab region, where aliasing is
// worst). Bass is deliberately NOT probed: at 220 Hz a hard clipper's audible alias floor is
// already ~ −86 dBc with no mitigation at all, so it proves nothing.
//
//   ./scoopy_clipper_test
// ─────────────────────────────────────────────────────────────────────────────────────────────
#include "NativeMasterDrive.hpp"

#include <chrono>
#include <cmath>
#include <complex>
#include <cstdio>
#include <cstdint>
#include <numeric>
#include <vector>

using namespace scoopyloops;

namespace {

constexpr double kSampleRate = 48'000.0;
constexpr int    kN          = 1 << 16;   // 65536 — bin = 0.73 Hz
constexpr int    kGuard      = 16;        // bins to claim around each true harmonic (Kaiser β=20
                                          // has a ~14-bin main lobe; 16 covers it with margin)

double besselI0(double x) noexcept {
    double s = 1.0, term = 1.0;
    const double xx = (x * x) / 4.0;
    for (int k = 1; k < 64; ++k) {
        term *= xx / (static_cast<double>(k) * static_cast<double>(k));
        s += term;
        if (term < 1e-18 * s) break;
    }
    return s;
}

/// Iterative radix-2 FFT. Longhand rather than a dependency: the engine links nothing, and this
/// binary must build in WASM too.
void fft(std::vector<std::complex<double>>& a) {
    const std::size_t n = a.size();
    for (std::size_t i = 1, j = 0; i < n; ++i) {
        std::size_t bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) std::swap(a[i], a[j]);
    }
    for (std::size_t len = 2; len <= n; len <<= 1) {
        const double ang = -2.0 * M_PI / static_cast<double>(len);
        const std::complex<double> wl(std::cos(ang), std::sin(ang));
        for (std::size_t i = 0; i < n; i += len) {
            std::complex<double> w(1.0, 0.0);
            for (std::size_t k = 0; k < len / 2; ++k) {
                const std::complex<double> u = a[i + k];
                const std::complex<double> v = a[i + k + len / 2] * w;
                a[i + k] = u + v;
                a[i + k + len / 2] = u - v;
                w *= wl;
            }
        }
    }
}

struct Spectrum {
    double snrDb        = 0.0;   // harmonic energy / alias energy
    double subFundDbc   = 0.0;   // loudest alias bin below the fundamental, rel. fundamental
    double peakOut      = 0.0;
};

/// Render a full-scale sine at `probeHz` through one configured NativeMasterDrive and grade the
/// spectrum. `probeHz` is deliberately NOT bin-aligned — see the header.
Spectrum measure(MasterDriveCurve curve, float drive, float ceiling,
                 std::uint8_t oversample, bool decoupled, double probeHz, double amplitude = 1.0) {
    NativeMasterDrive d;
    d.reset();
    // volume=1.0 → volExcess=0 → the legacy path is a pass-through; in decoupled mode volume is
    // ignored entirely. threshold/softness are the shipping defaults.
    d.setParameters(curve, /*volume*/ 1.0f, /*threshold*/ 0.7f, /*softness*/ 0.4f,
                    drive, ceiling, oversample, decoupled);

    const double w = 2.0 * M_PI * probeHz / kSampleRate;

    // Settle the oversampler's FIR history and the ADAA state before the measured window.
    for (int n = 0; n < 4096; ++n) {
        float l = static_cast<float>(amplitude * std::sin(w * n));
        float r = l;
        d.processSample(l, r);
    }

    // Kaiser β=20 — sidelobes ≈ −190 dB, below the float32 quantisation floor of the signal. A
    // weaker window would put a leakage skirt exactly where the aliasing we are measuring lives.
    constexpr double kBeta = 20.0;
    const double invI0Beta = 1.0 / besselI0(kBeta);

    std::vector<std::complex<double>> spec(kN);
    Spectrum out;
    double winSum = 0.0;
    for (int n = 0; n < kN; ++n) {
        float l = static_cast<float>(amplitude * std::sin(w * (4096 + n)));
        float r = l;
        d.processSample(l, r);
        out.peakOut = std::max(out.peakOut, std::fabs(static_cast<double>(l)));

        const double r01 = (2.0 * n) / (kN - 1) - 1.0;   // [-1, 1]
        const double win = besselI0(kBeta * std::sqrt(std::max(0.0, 1.0 - r01 * r01))) * invI0Beta;
        winSum += win;
        spec[static_cast<std::size_t>(n)] = std::complex<double>(win * l, 0.0);
    }
    (void)winSum;

    fft(spec);

    const int half = kN / 2;
    const double binHz = kSampleRate / kN;

    // Claim ±kGuard bins around every harmonic that is GENUINELY below Nyquist. Those are the
    // wanted distortion. A folded harmonic lands somewhere else entirely (see the header), so it
    // is never inside one of these windows and is therefore counted as alias — which is the point.
    std::vector<bool> isHarmonic(static_cast<std::size_t>(half) + 1, false);
    const int maxH = static_cast<int>((kSampleRate * 0.5) / probeHz);
    for (int h = 1; h <= maxH; ++h) {
        const int centre = static_cast<int>(std::lround(h * probeHz / binHz));
        for (int b = centre - kGuard; b <= centre + kGuard; ++b)
            if (b >= 0 && b <= half) isHarmonic[static_cast<std::size_t>(b)] = true;
    }
    // The window's own skirt around DC is not alias.
    for (int b = 0; b <= kGuard; ++b) isHarmonic[static_cast<std::size_t>(b)] = true;

    const auto mag = [&](int b) { return std::abs(spec[static_cast<std::size_t>(b)]); };

    const int fundBin = static_cast<int>(std::lround(probeHz / binHz));
    double fundMag = 0.0;
    for (int b = fundBin - kGuard; b <= fundBin + kGuard; ++b)
        if (b >= 0 && b <= half) fundMag = std::max(fundMag, mag(b));

    double harmonicE = 0.0, aliasE = 0.0, loudestSubFund = 0.0;
    for (int b = 1; b <= half; ++b) {
        const double m2 = mag(b) * mag(b);
        if (isHarmonic[static_cast<std::size_t>(b)]) {
            harmonicE += m2;
        } else {
            aliasE += m2;
            if (b < fundBin - kGuard) loudestSubFund = std::max(loudestSubFund, mag(b));
        }
    }

    out.snrDb = (aliasE > 0.0) ? 10.0 * std::log10(harmonicE / aliasE) : 999.0;
    out.subFundDbc = (loudestSubFund > 0.0 && fundMag > 0.0)
                   ? 20.0 * std::log10(loudestSubFund / fundMag)
                   : -240.0;
    return out;
}

double benchNsPerSample(MasterDriveCurve curve, float drive, float ceiling,
                        std::uint8_t oversample, bool decoupled) {
    NativeMasterDrive d;
    d.reset();
    d.setParameters(curve, 1.0f, 0.7f, 0.4f, drive, ceiling, oversample, decoupled);

    constexpr int kRuns = 1 << 20;
    const double w = 2.0 * M_PI * 1000.0 / kSampleRate;

    std::vector<float> in(static_cast<std::size_t>(kRuns));
    for (int n = 0; n < kRuns; ++n)
        in[static_cast<std::size_t>(n)] = static_cast<float>(std::sin(w * n));

    for (int n = 0; n < 8192; ++n) { float l = in[static_cast<std::size_t>(n)], r = l; d.processSample(l, r); }

    float sink = 0.0f;
    const auto t0 = std::chrono::steady_clock::now();
    for (int n = 0; n < kRuns; ++n) {
        float l = in[static_cast<std::size_t>(n)];
        float r = l;
        d.processSample(l, r);
        sink += l + r;
    }
    const auto t1 = std::chrono::steady_clock::now();
    if (!std::isfinite(sink)) std::fprintf(stderr, "(sink non-finite)\n");

    return std::chrono::duration<double, std::nano>(t1 - t0).count() / kRuns;
}

/// PASSBAND — the measurement that decides whether a config is USABLE at all.
///
/// Alias figures are only half the story, and on their own they are actively misleading. ADAA does
/// not just suppress aliasing, it LOW-PASSES THE SIGNAL. For a hard clipper in its linear region
/// (|u| < 1, i.e. anything below the clip point — which is most of the music, most of the time) the
/// 1st-order ADAA formula collapses algebraically:
///
///     F(u) = u²/2   ⇒   (F(u) − F(u₋₁)) / (u − u₋₁) = (u + u₋₁) / 2
///
/// A two-tap moving average. That is a real, audible tone change on every hi-hat and every cymbal in
/// the session — it is NOT confined to the clipping. It is precisely why the literature (Vicanek;
/// Werner & Azelborn, DAFx-23) insists ADAA be run at 2x or higher: the oversampling is what pushes
/// this droop out of the audible band, not a bonus on top.
///
/// A config that wins on alias and loses here is not a win. Measured at drive 1.0 / ceiling 1.0 with
/// a small-amplitude sine, so the shaper is nominally transparent and anything we see is damage.
double passbandDb(MasterDriveCurve curve, std::uint8_t oversample, bool decoupled, double probeHz) {
    NativeMasterDrive d;
    d.reset();
    d.setParameters(curve, 1.0f, 0.7f, 0.4f, /*drive*/ 1.0f, /*ceiling*/ 1.0f, oversample, decoupled);

    constexpr double kAmp = 0.05;   // deep in the linear region — nothing should be clipping
    const double w = 2.0 * M_PI * probeHz / kSampleRate;

    for (int n = 0; n < 8192; ++n) {
        float l = static_cast<float>(kAmp * std::sin(w * n));
        float r = l;
        d.processSample(l, r);
    }

    constexpr int kM = 1 << 15;
    double re = 0.0, im = 0.0, winSum = 0.0;
    for (int n = 0; n < kM; ++n) {
        const double ph = w * (8192 + n);
        float l = static_cast<float>(kAmp * std::sin(ph));
        float r = l;
        d.processSample(l, r);
        const double win = 0.5 * (1.0 - std::cos(2.0 * M_PI * n / (kM - 1)));
        re += win * l * std::sin(ph);
        im += win * l * std::cos(ph);
        winSum += win;
    }
    const double mag = 2.0 * std::sqrt(re * re + im * im) / winSum;
    if (mag <= 1e-12) return -240.0;
    return 20.0 * std::log10(mag / kAmp);
}

/// TRUE PEAK (dBTP) — the metric ClipOnly2 actually claims to win on, so it is the one that decides
/// whether it earns its place.
///
/// A DAC does not output samples, it reconstructs a continuous waveform THROUGH them, and that
/// waveform can overshoot the highest sample. A signal can read 0.0 dBFS on a sample meter and still
/// clip the converter. ITU-R BS.1770 defines the measurement as: oversample by at least 4x, then take
/// the peak. Every streaming platform specifies -1 dBTP for exactly this reason.
///
/// Airwindows' claim for ClipOnly2 is that it resists inter-sample peaking "not through filtration,
/// but mechanically" — by inserting transition samples. If that is true it should show up HERE even
/// though it loses on the alias metric.
double truePeakDb(MasterDriveCurve curve, float drive, float ceiling,
                  std::uint8_t oversample, double probeHz) {
    NativeMasterDrive d;
    d.reset();
    d.setParameters(curve, 1.0f, 0.7f, 0.4f, drive, ceiling, oversample, true);

    const double w = 2.0 * M_PI * probeHz / kSampleRate;
    constexpr int kN2 = 1 << 14;
    std::vector<double> y(kN2);
    for (int n = 0; n < 4096; ++n) {        // settle
        float l = static_cast<float>(std::sin(w * n)), r = l;
        d.processSample(l, r);
    }
    for (int n = 0; n < kN2; ++n) {
        float l = static_cast<float>(std::sin(w * (4096 + n))), r = l;
        d.processSample(l, r);
        y[static_cast<std::size_t>(n)] = l;
    }

    // 4x windowed-sinc reconstruction, per BS.1770's "oversample then peak".
    constexpr int kTaps = 32;              // half-width, in input samples
    constexpr int kUp   = 4;
    double peak = 0.0;
    for (int n = kTaps; n < kN2 - kTaps; ++n) {
        for (int s = 0; s < kUp; ++s) {
            const double frac = static_cast<double>(s) / kUp;
            double acc = 0.0;
            for (int j = -kTaps + 1; j <= kTaps; ++j) {
                const double t = frac - j;
                double sinc;
                if (std::fabs(t) < 1e-9) sinc = 1.0;
                else                     sinc = std::sin(M_PI * t) / (M_PI * t);
                // Blackman window over the sinc's support.
                const double r01 = (t + kTaps) / (2.0 * kTaps);
                const double win = 0.42 - 0.5 * std::cos(2.0 * M_PI * r01)
                                        + 0.08 * std::cos(4.0 * M_PI * r01);
                acc += y[static_cast<std::size_t>(n + j)] * sinc * win;
            }
            peak = std::max(peak, std::fabs(acc));
        }
    }
    return 20.0 * std::log10(std::max(1e-9, peak));
}

const char* curveName(MasterDriveCurve c) {
    switch (c) {
        case MasterDriveCurve::soft: return "soft";
        case MasterDriveCurve::tanh: return "tanh";
        case MasterDriveCurve::hard: return "hard";
        case MasterDriveCurve::fold: return "fold";
    }
    return "?";
}

struct Probe { double hz; const char* label; };

void runRow(const char* label, MasterDriveCurve curve, float drive, float ceiling,
            std::uint8_t os, bool decoupled, const Probe& p) {
    const Spectrum s = measure(curve, drive, ceiling, os, decoupled, p.hz);
    std::printf("  %-35s %-7s %8.1f %12.1f %10.3f\n",
                label, p.label, s.snrDb, s.subFundDbc, s.peakOut);
}

}  // namespace

int main() {
    // NOT bin-aligned — that is the whole point. f0/fs = 83/2400 and 2093/24000 in lowest terms,
    // so no folded harmonic can land on a true one within the ~30 harmonics we look at.
    const Probe kMid { 1660.0, "1660Hz" };
    const Probe kHi  { 4186.0, "4186Hz" };

    std::printf("NativeMasterDrive — baseline @ %.0f Hz, full-scale sine in\n\n", kSampleRate);
    std::printf("SNR = harmonic/alias energy.  sub-fund = loudest alias BELOW the fundamental (the audible one).\n");
    std::printf("Higher SNR is better; MORE NEGATIVE sub-fund is better.\n\n");

    std::printf("  %-35s %-7s %8s %12s %10s\n", "config", "probe", "SNR dB", "sub-fund dBc", "peak out");
    std::printf("  %-35s %-7s %8s %12s %10s\n", "-----------------------------------", "-------", "--------", "------------", "----------");

    // ── THE SHIPPING DEFAULT ─────────────────────────────────────────────────────────────────
    // BeatSequencer.swift: curve=hard(2), decoupled=true, oversample=2, drive=1.0, ceiling=1.0.
    //
    // ⚠️ Two things about this row. First, it takes the LAMBDA branch (NativeMasterDrive.cpp:148),
    // which hands the oversampler the NAIVE curve — so `processADAA` never executes and the ADAA in
    // that file is dead code in the shipping product. Second, at drive=1.0 into ceiling=1.0 a
    // full-scale sine only GRAZES the clip point, so this row is nearly transparent by construction
    // and is NOT where the damage is. The driven rows below are the ones C4 has to beat.
    for (const Probe& p : { kMid, kHi })
        runRow("DEFAULT: hard, OS 2x, drive 1.0", MasterDriveCurve::hard, 1.0f, 1.0f, 2, true, p);

    // Driven — where the clipper is actually doing work and the aliasing shows.
    for (const Probe& p : { kMid, kHi })
        runRow("hard, OS 2x, drive 2.0", MasterDriveCurve::hard, 2.0f, 1.0f, 2, true, p);
    for (const Probe& p : { kMid, kHi })
        runRow("hard, OS 2x, drive 4.0", MasterDriveCurve::hard, 4.0f, 1.0f, 2, true, p);

    // ── THE COMPARISON LADDER ────────────────────────────────────────────────────────────────
    // "OS off" is the ONLY config in which the existing ADAA actually runs. If it beats the
    // oversampled rows on sub-fund, that is the C4 thesis proven on our own code.
    for (const Probe& p : { kMid, kHi })
        runRow("hard, OS off (ADAA LIVE), drive 4.0", MasterDriveCurve::hard, 4.0f, 1.0f, 0, true, p);
    for (const Probe& p : { kMid, kHi })
        runRow("hard, OS 4x, drive 4.0", MasterDriveCurve::hard, 4.0f, 1.0f, 4, true, p);
    for (const Probe& p : { kMid, kHi })
        runRow("tanh, OS 2x, drive 4.0", MasterDriveCurve::tanh, 4.0f, 1.0f, 2, true, p);
    for (const Probe& p : { kMid, kHi })
        runRow("soft, OS 2x, drive 4.0", MasterDriveCurve::soft, 4.0f, 1.0f, 2, true, p);

    // ── PASSBAND ─────────────────────────────────────────────────────────────────────────────
    // At drive 1.0 / ceiling 1.0 the shaper is doing nothing. Every dB here is damage to the dry
    // signal, on every sample of the session, whether or not anything is clipping.
    std::printf("\nPASSBAND at drive 1.0 (dB; the shaper is transparent, so all of this is damage)\n");
    std::printf("  %-30s", "config");
    for (const char* h : {"1k", "5k", "10k", "15k", "18k", "20k"}) std::printf("%9s", h);
    std::printf("\n");

    // ⚠️ Read the first row carefully — it is a SHIPPING DEFECT, not a hypothetical. `OS off` is the
    // only configuration in which our ADAA actually runs, and ADAA's linear-region transfer for a
    // hard clip is exactly (1 + z⁻¹)/2. So selecting "oversampling: off" in the UI does not merely
    // trade aliasing for CPU: it drops 15 kHz by 5 dB and 20 kHz by nearly 12 dB, on the master bus,
    // permanently, whether or not a single sample is being clipped.
    struct PB { const char* label; MasterDriveCurve c; std::uint8_t os; };
    static const PB kPBs[] = {
        { "hard, OS off (ADAA runs)",   MasterDriveCurve::hard, 0 },
        { "hard, OS 2x (naive)",        MasterDriveCurve::hard, 2 },
        { "hard, OS 4x (naive)",        MasterDriveCurve::hard, 4 },
        { "soft, OS off (no ADAA)",     MasterDriveCurve::soft, 0 },
    };
    for (const PB& p : kPBs) {
        std::printf("  %-30s", p.label);
        for (double hz : {1000.0, 5000.0, 10000.0, 15000.0, 18000.0, 20000.0})
            std::printf("%9.2f", passbandDb(p.c, p.os, true, hz));
        std::printf("\n");
    }

    // ── THE SAFETY STAGE AND ITS HEADROOM ────────────────────────────────────────────────────
    // ClipOnly2 sits at 0 dBFS, NOT at the user's ceiling. Two things to prove:
    //
    //   1. The ceiling still lands where it was asked for (the shaper enforces it; the safety stage
    //      must not shave it).
    //   2. The alias figure must not DEGRADE as the ceiling approaches full scale. It is the ceiling
    //      that gives the safety stage its headroom — at ceiling = 1.0 the shaper's output is welded
    //      to the same value the safety clipper is watching, and a safety clipper with no headroom
    //      fires on ripple and makes things worse. That is why C6 moves the default to -1 dBFS.
    std::printf("\nSAFETY STAGE (ClipOnly2 @ 0 dBFS) vs CEILING — drive 8.0, hard, OS 2x\n");
    std::printf("  %-10s %-12s %-12s %-9s %s\n",
                "ceiling", "requested", "measured", "error", "alias @1660");
    for (float ceil : {1.0f, 0.891f, 0.708f, 0.501f}) {
        const Spectrum s = measure(MasterDriveCurve::hard, 8.0f, ceil, 2, true, 1660.0);
        const double reqDb  = 20.0 * std::log10(ceil);
        const double measDb = 20.0 * std::log10(std::max(1e-9, s.peakOut));
        std::printf("  %-10.3f %-12.2f %-12.2f %+-9.2f %.1f dBc\n",
                    ceil, reqDb, measDb, measDb - reqDb, s.subFundDbc);
    }

    // ── TRUE PEAK ────────────────────────────────────────────────────────────────────────────
    // The sample peak says 0.0 dBFS and the converter still clips: dBTP is what the DAC actually
    // reconstructs. This is the metric ClipOnly2 is FOR, so it is the one that decides its fate.
    std::printf("\nTRUE PEAK (dBTP, 4x reconstruction per BS.1770) — hard, OS 2x\n");
    std::printf("  %-10s %-10s %-14s %s\n", "ceiling", "drive", "sample peak", "TRUE peak");
    for (float ceil : {1.0f, 0.891f}) {
        for (float drv : {1.0f, 4.0f, 8.0f}) {
            const Spectrum s = measure(MasterDriveCurve::hard, drv, ceil, 2, true, 1660.0);
            const double sampleDb = 20.0 * std::log10(std::max(1e-9, s.peakOut));
            const double tpDb = truePeakDb(MasterDriveCurve::hard, drv, ceil, 2, 1660.0);
            std::printf("  %-10.3f %-10.1f %-14.2f %+.2f dBTP\n", ceil, drv, sampleDb, tpDb);
        }
    }

    std::printf("\nCOST (ns/sample, stereo)\n");
    struct Bench { const char* label; MasterDriveCurve c; float drive; std::uint8_t os; };
    static const Bench kBenches[] = {
        { "hard, OS off (ADAA)",  MasterDriveCurve::hard, 4.0f, 0 },
        { "hard, OS 2x (naive)",  MasterDriveCurve::hard, 4.0f, 2 },
        { "hard, OS 4x (naive)",  MasterDriveCurve::hard, 4.0f, 4 },
        { "tanh, OS 2x (naive)",  MasterDriveCurve::tanh, 4.0f, 2 },
        { "soft, OS off",         MasterDriveCurve::soft, 4.0f, 0 },
    };
    for (const Bench& b : kBenches)
        std::printf("  %-24s (%s)  %7.2f ns\n", b.label, curveName(b.c),
                    benchNsPerSample(b.c, b.drive, 1.0f, b.os, true));

    // At 48 kHz, one core = 62500 cycles/sample. A ns/sample figure n → n * 48000 * 100 / 1e9 % of
    // a core. Printed so the perf gate in the plan can be checked without arithmetic.
    std::printf("\n  (%% of one core at 48 kHz = ns/sample x 0.0048)\n\n");
    return 0;
}
