// ─────────────────────────────────────────────────────────────────────────────────────────────
// C0 — THE FILTER HARNESS. Characterises `NativeToneFilter` from outside: magnitude response,
// modulation transient, and cost. It is the BASELINE the SVF swap (C1) is graded against, and it
// exists BEFORE the swap so the comparison is honest rather than retrospective.
//
// It measures three things, and the second is the whole reason the swap is happening.
//
//   1. MAGNITUDE RESPONSE. Fed a small-amplitude sine (0.05 — small enough that the biquad's
//      output `tanh` at Q > 1.5 is transparent to ~1e-3 dB, so this measures the LINEAR response
//      and nothing else). Swept over a log grid, per mode, per Q.
//
//      ⚠️ EXPECT THIS TO NULL ACROSS C1. An RBJ cookbook LPF and a TPT/ZDF SVF lowpass are the
//      SAME bilinear transform of the same 2-pole prototype — same transfer function, same poles.
//      They are not supposed to sound different when static, and if this table moves by more than
//      ~0.05 dB after the swap, the SVF is WRONG. The SVF's advantages are all in the other two
//      measurements. Anyone reading a nulled table as "the swap did nothing" has misread it.
//
//   2. MODULATION TRANSIENT — the defect. A direct-form biquad's state variables are not physical:
//      they are convolutions of past input/output weighted by the CURRENT coefficients. Change the
//      coefficients and you have silently redefined the stored energy, so the filter emits a
//      transient that corresponds to no input. DF2T is the worst common form for this, and we
//      recompute coefficients EVERY SAMPLE.
//
//      Measured as: hold a steady sine until the filter is in steady state at tone A, jump to
//      tone B, and report the peak of the 512 samples after the jump against the steady-state peak
//      at B. A TPT filter's integrator states ARE physical (they are the capacitor voltages), so
//      they mean the same thing at any coefficient — its overshoot should collapse toward 0 dB.
//
//   3. COST, in ns/sample. Today every engaged voice recomputes exp + pow + sin + cos + 8 divides
//      per sample, even when nothing is moving, because the chase is asymptotic and never settles.
//
//   ./scoopy_filter_test
// ─────────────────────────────────────────────────────────────────────────────────────────────
#include "NativeToneFilter.hpp"

#include <chrono>
#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

using namespace scoopyloops;

namespace {

constexpr double kSampleRate = 48'000.0;

const char* modeName(NativeToneFilter::Mode m) {
    switch (m) {
        case NativeToneFilter::Mode::tone:     return "tone";
        case NativeToneFilter::Mode::lowPass:  return "lowPass";
        case NativeToneFilter::Mode::highPass: return "highPass";
        case NativeToneFilter::Mode::bandPass: return "bandPass";
        case NativeToneFilter::Mode::notch:    return "notch";
    }
    return "?";
}

/// Magnitude at `probeHz`, via Hann-windowed quadrature correlation.
///
/// The filter is driven to steady state first. `setParameters` snaps the chase on first activation
/// (NativeToneFilter.cpp:149-154), so the settle only has to cover the filter's own ringing, not a
/// parameter ramp — but at Q=16 that ring is long, so we are generous.
double magnitudeDb(NativeToneFilter::Mode mode, float tone, float q,
                   double probeHz, double amplitude = 0.05) {
    NativeToneFilter f;
    f.sampleRate = kSampleRate;
    f.reset();
    f.setParameters(tone, q, mode);

    const double w = 2.0 * M_PI * probeHz / kSampleRate;

    constexpr int kSettle  = 1 << 15;   // 32768 — ~0.68 s; covers a Q=16 ring at 40 Hz
    constexpr int kMeasure = 1 << 15;

    for (int n = 0; n < kSettle; ++n) {
        float l = static_cast<float>(amplitude * std::sin(w * n));
        float r = l;
        f.processSample(l, r);
    }

    double re = 0.0, im = 0.0, winSum = 0.0;
    for (int n = 0; n < kMeasure; ++n) {
        const double phase = w * (kSettle + n);
        float l = static_cast<float>(amplitude * std::sin(phase));
        float r = l;
        f.processSample(l, r);

        // Hann — the probe is not necessarily an integer number of cycles in the window.
        const double win = 0.5 * (1.0 - std::cos(2.0 * M_PI * n / (kMeasure - 1)));
        re += win * l * std::sin(phase);
        im += win * l * std::cos(phase);
        winSum += win;
    }

    const double measured = 2.0 * std::sqrt(re * re + im * im) / winSum;
    if (measured <= 1e-12) return -240.0;
    return 20.0 * std::log10(measured / amplitude);
}

void printResponse(NativeToneFilter::Mode mode, float tone, float q) {
    static const double kProbes[] = {
        20, 40, 80, 160, 320, 640, 1000, 2000, 4000, 8000, 12000, 16000, 20000
    };
    std::printf("  %-9s tone=%-7.1f Q=%-5.2f  ", modeName(mode), tone, q);
    for (double hz : kProbes) std::printf("%8.2f", magnitudeDb(mode, tone, q, hz));
    std::printf("\n");
}

/// THE COEFFICIENT-CHANGE DISCONTINUITY — the artifact that actually distinguishes the two
/// topologies, measured in a way that isolates it from the physics.
///
/// ⚠️ AN EARLIER VERSION OF THIS TEST MEASURED THE WRONG THING, and the trap is worth recording.
/// It reported the peak OVERSHOOT after a cutoff change, which sounds like the right idea and is
/// not: sweeping a resonant filter off the probe frequency makes the output swell and ring down,
/// and that swell is REAL, WANTED, PHYSICAL behaviour that any correct filter — analog, biquad or
/// TPT — must produce. It reported ~+31 dB for both topologies, because both were right.
///
/// The artifact is not an overshoot, it is a DISCONTINUITY. A filter whose state is physical (a
/// capacitor voltage) produces a continuous output when its coefficients move, because the stored
/// energy still means the same thing. A direct form's state is a convolution of past samples
/// weighted by the CURRENT coefficients, so changing them silently reinterprets the stored energy
/// and the output can STEP — a jump that corresponds to no input.
///
/// So: measure the sample-to-sample jump at the instant of the change, against the signal's own
/// natural slew rate. 0 dB = the change was as smooth as the signal already was, i.e. nothing was
/// injected.
///
/// NOTE ON WHY THE NUMBERS ARE SMALLER THAN THE THEORY: `setParameters` only snaps the chase on
/// FIRST activation. On an ordinary tone change the 64-tap chase ramps the coefficients over
/// ~1.35 ms, so neither topology ever sees a one-sample jump, and the DF2T objection is largely
/// mitigated by smoothing that was already there. The case where it is NOT mitigated is a MODE
/// change on a ringing voice — that resets `hasInitializedChaseState` and snaps the coefficients in
/// one sample. Which is exactly what C2 is about to make reachable from the UI.
double discontinuityDb(NativeToneFilter::Mode modeA, NativeToneFilter::Mode modeB,
                       float toneA, float toneB, float q,
                       double probeHz, double amplitude = 0.3) {
    const double w = 2.0 * M_PI * probeHz / kSampleRate;
    constexpr int kSettle = 1 << 15;

    // The natural per-sample slew of each configuration's steady-state output.
    //
    // ⚠️ NORMALISE BY THE LOUDER OF THE TWO, not by the "before". A BP parked at 851 Hz barely
    // passes a 220 Hz probe, so its output — and its slew — is tiny; fading from that into a lowpass
    // that passes 220 Hz fully is a 30 dB level change, and measured against the quiet side ANY
    // transition into it looks enormous even when each individual step is a 65th of the way. That is
    // a defect in the ruler, not in the filter. The question worth asking is whether the transition
    // injects a step bigger than the natural motion of EITHER signal.
    const auto settledSlew = [&](NativeToneFilter::Mode m, float t) {
        NativeToneFilter f;
        f.sampleRate = kSampleRate;
        f.reset();
        f.setParameters(t, q, m);
        double prev = 0.0, slew = 0.0;
        for (int n = 0; n < kSettle; ++n) {
            float l = static_cast<float>(amplitude * std::sin(w * n));
            float r = l;
            f.processSample(l, r);
            const double y = l;
            if (n > kSettle / 2) slew = std::max(slew, std::fabs(y - prev));
            prev = y;
        }
        return slew;
    };
    const double naturalSlew = std::max(settledSlew(modeA, toneA), settledSlew(modeB, toneB));
    if (naturalSlew <= 1e-12) return -240.0;

    // ⚠️ SWEEP THE SWITCH PHASE AND TAKE THE WORST CASE. Sampling one instant is worthless here:
    // whether a hard switch shows a big step depends entirely on where in the probe's cycle it lands,
    // and a lucky phase can make an outright click measure CLEANER than a proper crossfade. (It did:
    // an earlier single-phase version scored an un-crossfaded BP→LP at −36 dB purely because the two
    // responses happened to cross near the same value at that sample.) 16 phases, worst wins.
    //
    // We also take the worst step over the whole transition WINDOW rather than just the first sample,
    // so a crossfade cannot hide a step merely by deferring it.
    double worst = 0.0;
    for (int phase = 0; phase < 16; ++phase) {
        const int start = kSettle + phase * static_cast<int>(kSampleRate / probeHz / 16.0);

        NativeToneFilter f;
        f.sampleRate = kSampleRate;
        f.reset();
        f.setParameters(toneA, q, modeA);

        double prev = 0.0;
        for (int n = 0; n < start; ++n) {
            float l = static_cast<float>(amplitude * std::sin(w * n));
            float r = l;
            f.processSample(l, r);
            prev = l;
        }

        f.setParameters(toneB, q, modeB);
        for (int n = 0; n < 512; ++n) {
            float l = static_cast<float>(amplitude * std::sin(w * (start + n)));
            float r = l;
            f.processSample(l, r);
            worst = std::max(worst, std::fabs(static_cast<double>(l) - prev));
            prev = l;
        }
    }

    // The signal's own motion is the floor: a transition that injects nothing still moves by one
    // natural slew per sample. ~0 dB is therefore a clean transition; anything well above it is a step
    // the input never contained.
    return 20.0 * std::log10(worst / naturalSlew);
}

/// ns per sample, stereo, filter engaged. `sink` defeats dead-store elimination.
double benchNsPerSample(NativeToneFilter::Mode mode, float tone, float q, float drive = 0.0f) {
    NativeToneFilter f;
    f.sampleRate = kSampleRate;
    f.reset();
    f.setParameters(tone, q, mode, drive);

    constexpr int kWarm = 1 << 14;
    constexpr int kRuns = 1 << 21;   // ~2.1 M samples — ~44 s of audio, so timing noise is small

    const double w = 2.0 * M_PI * 220.0 / kSampleRate;
    float sink = 0.0f;

    for (int n = 0; n < kWarm; ++n) {
        float l = static_cast<float>(0.3 * std::sin(w * n));
        float r = l;
        f.processSample(l, r);
        sink += l;
    }

    // Pre-generate the input so the sine cost is not in the measured window.
    std::vector<float> in(static_cast<std::size_t>(kRuns));
    for (int n = 0; n < kRuns; ++n) in[static_cast<std::size_t>(n)] = static_cast<float>(0.3 * std::sin(w * n));

    const auto t0 = std::chrono::steady_clock::now();
    for (int n = 0; n < kRuns; ++n) {
        float l = in[static_cast<std::size_t>(n)];
        float r = l;
        f.processSample(l, r);
        sink += l;
    }
    const auto t1 = std::chrono::steady_clock::now();

    if (!std::isfinite(sink)) std::fprintf(stderr, "(sink went non-finite: %g)\n", (double)sink);
    const double ns = std::chrono::duration<double, std::nano>(t1 - t0).count();
    return ns / kRuns;
}

/// RESONANCE DRIVE — the self-limiting proof.
///
/// The drive saturates the band-pass node inside the state update, so the resonant peak must
/// COMPRESS as drive rises while the passband stays put. Two numbers per drive setting:
///
///   `at peak`  — steady-state output peak for a 0.35 sine parked ON the resonance (LP tone=60
///                Q=16 → ~1 kHz, +23 dB linear gain, so the linear output is ~4.9 and would be a
///                hard-clipped square by the time the deck bus saw it).
///   `passband` — output peak for the same amplitude at 110 Hz, deep in the LP passband, where the
///                band-pass node is small. If the drive colours THIS, the saturator is leaking onto
///                the mix instead of concentrating on the peak, and the design has failed.
double drivePeak(float drive, double probeHz, double amplitude = 0.35) {
    NativeToneFilter f;
    f.sampleRate = kSampleRate;
    f.reset();
    f.setParameters(60.0f, 16.0f, NativeToneFilter::Mode::lowPass, drive);

    const double w = 2.0 * M_PI * probeHz / kSampleRate;
    for (int n = 0; n < (1 << 15); ++n) {           // ring up fully — Q=16 is slow
        float l = static_cast<float>(amplitude * std::sin(w * n));
        float r = l;
        f.processSample(l, r);
    }
    double peak = 0.0;
    for (int n = 0; n < (1 << 13); ++n) {
        float l = static_cast<float>(amplitude * std::sin(w * ((1 << 15) + n)));
        float r = l;
        f.processSample(l, r);
        peak = std::max(peak, std::fabs(static_cast<double>(l)));
    }
    return peak;
}

/// ns per sample with the tone MODULATED every sample — the case the static bench cannot see.
///
/// ⚠️ The headline "11.6 ns/voice" is the cost of a filter SITTING STILL. Under a filter LFO the
/// engine calls setParameters with a new tone every sample, which re-runs the tone→Hz mapping
/// (exp + pow) and keeps the chase + tan() alive — the exact transcendentals the settle-snap
/// removes at rest. A benchmark suite without this row proves the common case and silently
/// implies the worst case; this row makes the worst case a number.
double benchModulatedNsPerSample(NativeToneFilter::Mode mode, float toneCentre, float depth, float q) {
    NativeToneFilter f;
    f.sampleRate = kSampleRate;
    f.reset();
    f.setParameters(toneCentre, q, mode);

    constexpr int kRuns = 1 << 20;
    const double w    = 2.0 * M_PI * 220.0 / kSampleRate;
    const double wLfo = 2.0 * M_PI * 2.0 / kSampleRate;   // 2 Hz sweep, full depth

    std::vector<float> in(static_cast<std::size_t>(kRuns));
    std::vector<float> tone(static_cast<std::size_t>(kRuns));
    for (int n = 0; n < kRuns; ++n) {
        in[static_cast<std::size_t>(n)]   = static_cast<float>(0.3 * std::sin(w * n));
        tone[static_cast<std::size_t>(n)] = toneCentre
            + depth * static_cast<float>(std::sin(wLfo * n));
    }

    float sink = 0.0f;
    const auto t0 = std::chrono::steady_clock::now();
    for (int n = 0; n < kRuns; ++n) {
        f.setParameters(tone[static_cast<std::size_t>(n)], q, mode);
        float l = in[static_cast<std::size_t>(n)];
        float r = l;
        f.processSample(l, r);
        sink += l;
    }
    const auto t1 = std::chrono::steady_clock::now();
    if (!std::isfinite(sink)) std::fprintf(stderr, "(sink non-finite)\n");
    return std::chrono::duration<double, std::nano>(t1 - t0).count() / kRuns;
}

}  // namespace

int main() {
    using Mode = NativeToneFilter::Mode;

    std::printf("NativeToneFilter — baseline @ %.0f Hz\n\n", kSampleRate);

    std::printf("MAGNITUDE RESPONSE (dB, input 0.05 so the Q>1.5 output tanh stays transparent)\n");
    std::printf("  %-9s %-12s %-10s", "mode", "", "");
    for (const char* h : {"20", "40", "80", "160", "320", "640", "1k", "2k", "4k", "8k", "12k", "16k", "20k"})
        std::printf("%8s", h);
    std::printf("\n");

    printResponse(Mode::lowPass,  60.0f, 0.707f);
    printResponse(Mode::lowPass,  60.0f, 4.0f);
    printResponse(Mode::lowPass,  60.0f, 16.0f);
    printResponse(Mode::highPass, 60.0f, 0.707f);
    printResponse(Mode::highPass, 60.0f, 4.0f);
    printResponse(Mode::bandPass, 50.0f, 4.0f);
    printResponse(Mode::notch,    50.0f, 4.0f);
    printResponse(Mode::tone,    -55.0f, 0.707f);
    printResponse(Mode::tone,     55.0f, 0.707f);

    // THE OLD BYPASS BOUNDARY. |tone| <= 0.5 used to hard-bypass every mode but band-pass — a
    // transparency claim that is false at resonant Q, where a fully-open lowpass carries a +24 dB
    // peak at ~18 kHz. These two rows straddle the boundary at Q=16: before the fix the 0.49 row was
    // FLAT (bypassed) and the 0.51 row was peaked — a response an LFO toggled across every cycle.
    // After it, both rows must show the same peak: the filter never leaves the circuit, so the
    // response is continuous through the open end. (Q=0.7 still bypasses, honestly — it IS flat.)
    std::printf("\n  boundary continuity (was: flat above, peaked below — a step an LFO crossed):\n");
    printResponse(Mode::lowPass,  0.49f, 16.0f);
    printResponse(Mode::lowPass,  0.51f, 16.0f);

    std::printf("\nCOEFFICIENT-CHANGE DISCONTINUITY (dB of output step vs the signal's own slew)\n");
    std::printf("  220 Hz sine at 0.3, filter in steady state, parameters changed. 0 dB = nothing injected.\n");
    std::printf("  The chased tone rows should be near-silent for BOTH topologies (the 64-tap chase\n");
    std::printf("  already ramps them). The MODE-CHANGE rows are the ones that snap coefficients in a\n");
    std::printf("  single sample — and they are what C2 is about to make reachable on a ringing voice.\n\n");

    struct Jump { Mode ma, mb; float a, b; float q; const char* label; };
    static const Jump kJumps[] = {
        { Mode::lowPass,  Mode::lowPass,  20.0f, 80.0f, 0.707f, "tone: LP open->closed Q=0.7" },
        { Mode::lowPass,  Mode::lowPass,  20.0f, 80.0f, 16.0f,  "tone: LP open->closed Q=16"  },
        { Mode::bandPass, Mode::bandPass, 30.0f, 70.0f, 8.0f,   "tone: BP sweep up Q=8"       },
        { Mode::lowPass,  Mode::highPass, 60.0f, 60.0f, 4.0f,   "MODE: LP -> HP  Q=4"         },
        { Mode::lowPass,  Mode::bandPass, 60.0f, 50.0f, 8.0f,   "MODE: LP -> BP  Q=8"         },
        { Mode::lowPass,  Mode::notch,    60.0f, 50.0f, 16.0f,  "MODE: LP -> notch Q=16"      },
        { Mode::bandPass, Mode::lowPass,  50.0f, 60.0f, 16.0f,  "MODE: BP -> LP  Q=16"        },
    };
    for (const Jump& j : kJumps) {
        std::printf("  %-30s  %+8.2f dB\n", j.label,
                    discontinuityDb(j.ma, j.mb, j.a, j.b, j.q, 220.0));
    }

    std::printf("\nCOST (ns/sample, stereo, engaged)\n");
    std::printf("  %-28s  %6.2f ns\n", "lowPass  Q=0.707",
                benchNsPerSample(Mode::lowPass, 60.0f, 0.707f));
    std::printf("  %-28s  %6.2f ns\n", "lowPass  Q=16 (tanh active)",
                benchNsPerSample(Mode::lowPass, 60.0f, 16.0f));
    std::printf("  %-28s  %6.2f ns\n", "bandPass Q=4",
                benchNsPerSample(Mode::bandPass, 50.0f, 4.0f));
    std::printf("  %-28s  %6.2f ns\n", "bypassed (|tone| <= 0.5)",
                benchNsPerSample(Mode::lowPass, 0.0f, 0.707f));
    std::printf("  %-28s  %6.2f ns\n", "LP Q=16, drive 100",
                benchNsPerSample(Mode::lowPass, 60.0f, 16.0f, 100.0f));
    std::printf("  %-28s  %6.2f ns\n", "LP Q=4, LFO full-depth",
                benchModulatedNsPerSample(Mode::lowPass, 50.0f, 45.0f, 4.0f));
    std::printf("  %-28s  %6.2f ns\n", "BP Q=8, LFO full-depth",
                benchModulatedNsPerSample(Mode::bandPass, 50.0f, 45.0f, 8.0f));

    std::printf("\nRESONANCE DRIVE (LP tone=60 Q=16; 0.35 sine ON the ~1 kHz peak vs at 110 Hz)\n");
    std::printf("  Self-limiting: `at peak` must FALL as drive rises. Transparency: `passband`\n");
    std::printf("  must NOT move — the saturator lives on the band-pass node, which is small for\n");
    std::printf("  signal below cutoff, so the character lands on the peak and not on the mix.\n\n");
    std::printf("  %-8s %10s %12s\n", "drive", "at peak", "passband");
    for (float d : {0.0f, 25.0f, 50.0f, 100.0f}) {
        std::printf("  %-8.0f %10.3f %12.4f\n", d, drivePeak(d, 1000.0), drivePeak(d, 110.0));
    }

    std::printf("\n");
    return 0;
}
