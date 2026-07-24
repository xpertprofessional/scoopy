// ─────────────────────────────────────────────────────────────────────────────────────────────
// C6 — THE HEADROOM GATE. Renders a deliberately HOT scene (several full-level tracks summing well
// past unity) through the real core and reports what comes out.
//
// WHY A SEPARATE TOOL. The null test's scene is quiet (it peaks at 0.084), so it never touched the
// deck-sum clamp and could not have seen it. The clipper harness instantiates NativeMasterDrive
// directly and never runs the core's summing bus at all. The one thing neither could measure is the
// thing C6 is about: what happens to a mix that is genuinely too loud.
//
// WHAT IT PROVES. Before C6 the deck's voice sum was hard-clamped to ±1.0 *before* the X-MIX carve,
// the crossfader, the deck gain, the master stage and the master fader — so a hot mix was already
// destroyed four stages upstream of every control that could have saved it. Measured, on this scene:
//
//   tracks   with the clamp            with it deleted        the true sum
//   2        peak 1.0123  rms 0.8001   1.2740  0.9001         1.274
//   4        peak 1.0211  rms 0.9115   2.5480  1.8002         2.548
//
// TWO full-level tracks were enough to hard-clip the deck bus, and at four it was pinned into a
// square wave — rms 0.91 against a true 1.80. No fader, anywhere, could undo that.
//
// The gate: the deck bus must be free to exceed 1.0. It is an intermediate SUM, not an output, and
// the stages that follow it (deck gain, master drive with its ceiling, master fader) are what decide
// the actual output level. Clipping it here is not headroom management, it is damage.
//
// ⚠️ `renderOffline` returns the DECK bus, not the main bus — masterVolume and the master clipper are
// not in this path (visible below: the fader column changes nothing, and the peak sails past the
// ceiling). So this tool cannot test the master stage, and must not pretend to. It tests the sum.
//
//   ./scoopy_headroom_test
// ─────────────────────────────────────────────────────────────────────────────────────────────
#include "NativeAudioEngineCore.hpp"

#include <memory>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

using namespace scoopyloops;

namespace {

/// A loud, sustained sine — no decay, so the sum is unambiguous and steady.
NativeSample makeTone(double sampleRate) {
    NativeSample s;
    s.id = "tone";
    s.sampleRate = sampleRate;
    const std::size_t n = static_cast<std::size_t>(sampleRate * 2.0);
    s.left.resize(n);
    s.right.resize(n);
    for (std::size_t i = 0; i < n; ++i) {
        const double t = static_cast<double>(i) / sampleRate;
        const float v = static_cast<float>(0.9 * std::sin(2.0 * M_PI * 220.0 * t));
        s.left[i] = v;
        s.right[i] = v;
    }
    return s;
}

/// `tracks` copies of that tone, all hitting step 0 together, all at full volume. Four of them sum
/// to ~3.6 — far past unity, which is the entire point.
NativeSequencerSnapshot makeHotScene(int tracks, float masterVolume) {
    NativeSequencerSnapshot snap;
    snap.bpm = 120.0;
    snap.isPlaying = true;
    snap.startStep = 0;
    snap.masterVolume = masterVolume;
    // The decoupled clipper, at unity drive into a 0 dBFS ceiling — the shipping default.
    snap.masterClipperCurve = 2;        // hard
    snap.masterClipperDrive = 1.0f;
    snap.masterClipperCeiling = 1.0f;
    snap.masterClipperOversample = 2;
    snap.masterClipperDecoupled = true;

    for (int t = 0; t < tracks; ++t) {
        NativeTrackSnapshot tk;
        tk.sampleId = "tone";
        tk.steps.assign(16, 0);
        tk.steps[0] = 1;
        tk.pitchOffsets.assign(16, 0.0);
        tk.volume = 1.0f;
        tk.pan = 0.0f;
        tk.stereoMode = StereoMode::stereo;
        snap.tracks.push_back(std::move(tk));
    }
    return snap;
}

struct Result { double peak; double rms; };

Result render(int tracks, float masterVolume) {
    // Heap, not stack: the core is 1.05 MB and Windows gives a thread 1 MB by default, so a
    // harness holding one by value dies with STATUS_STACK_OVERFLOW before main does anything
    // (0xC00000FD, engine-matrix run 29940659486). macOS/Linux give 8 MB, which is why this only
    // ever showed up on Windows — and showed up as a SILENT crash under Git Bash.
    std::unique_ptr<NativeAudioEngineCore> corePtr = std::make_unique<NativeAudioEngineCore>();
    NativeAudioEngineCore& core = *corePtr;
    const double sr = 48'000.0;
    core.configure(sr, 128, 0);
    core.registerSample(makeTone(sr));

    const auto out = core.renderOffline(makeHotScene(tracks, masterVolume),
                                        static_cast<std::uint64_t>(sr * 0.5), 128);
    Result r { 0.0, 0.0 };
    // Skip the attack ramp; measure the sustained body.
    const std::size_t start = out.left.size() / 4;
    std::size_t n = 0;
    for (std::size_t i = start; i < out.left.size(); ++i) {
        const double v = std::fabs(static_cast<double>(out.left[i]));
        r.peak = std::max(r.peak, v);
        r.rms += v * v;
        ++n;
    }
    r.rms = n ? std::sqrt(r.rms / static_cast<double>(n)) : 0.0;
    return r;
}

}  // namespace

int main() {
    std::printf("Hot-mix headroom @ 48 kHz — N tracks of a 0.9 sine, all on step 0, all at unity.\n");
    std::printf("Master clipper at its shipping default (hard, drive 1.0, ceiling 1.0, OS 2x).\n\n");

    std::printf("  %-8s %-14s %10s %10s\n", "tracks", "masterVolume", "peak", "rms");
    std::printf("  %-8s %-14s %10s %10s\n", "------", "------------", "----------", "----------");

    for (int tracks : {1, 2, 4}) {
        for (float vol : {1.0f, 0.5f}) {
            const Result r = render(tracks, vol);
            std::printf("  %-8d %-14.2f %10.4f %10.4f\n", tracks, vol, r.peak, r.rms);
        }
    }

    // THE GATE. Four tracks of a 0.9 sine, centre-panned (equal-power, ×0.707), sum to
    // 4 × 0.9 × 0.707 = 2.546. If the deck bus is clean, that is what we must see. If it comes back
    // pinned near 1.0, the sum is being hard-clipped before anything downstream can act on it, and
    // the mix is a square wave no fader can rescue.
    const Result hot = render(4, 1.0f);
    const double expected = 4.0 * 0.9 * 0.70710678;

    std::printf("\n  4 tracks, expected peak %.4f, measured %.4f\n", expected, hot.peak);
    if (hot.peak < expected * 0.95) {
        std::printf("\nFAIL: the deck sum is being clipped upstream of the master stage (peak %.4f,\n"
                    "      expected %.4f). That is the C6 clamp, back from the dead.\n",
                    hot.peak, expected);
        return 1;
    }
    std::printf("  PASS: the deck bus carries the full sum; the master stage decides the output.\n\n");
    return 0;
}
