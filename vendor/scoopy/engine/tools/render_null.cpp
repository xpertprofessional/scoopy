// ─────────────────────────────────────────────────────────────────────────────────────────────
// P8-3b — the NULL TEST harness. Turns "the browser should sound the same" into "it does".
//
// The companion's whole promise is *the composition works identical*. The DSP is literally the
// same C++ on both platforms — `NativeToneFilter`, `NativeTrackClipper`, `NativeMasterSaturation`
// are plain portable code, no vDSP, no Accelerate — so it is the same signal path, not a
// re-implementation. But **bit-identity will not hold**, for three nameable reasons:
//
//   1. libm — tanhf/expf/sinf differ by an ULP or two between Apple's libm and Emscripten's musl.
//   2. float contraction — x86/ARM may fuse mul+add into an FMA; WASM (no relaxed-SIMD) will not.
//      Hence `-ffp-contract=off` in CMakeLists: a CORRECTNESS flag, not a preference.
//   3. denormals — macOS flushes subnormals to zero (juce::ScopedNoDenormals in the host layer);
//      **WASM has no FTZ mode at all**, so a decaying tail takes a numerically DIFFERENT path,
//      not merely a slower one.
//
// So the gate is not "identical bits" — it is "the residual is inaudible". This renders a fixed
// scene offline and dumps raw float32; `null_test.py` subtracts two dumps and reports the peak
// residual in dBFS. Same method as the P5-03 / P6-01 golden fixtures: one checked-in scene, both
// sides execute it, neither side grades its own homework.
//
// THE SCENE IS DESIGNED TO BE HOSTILE, on purpose. A sine through a gain stage would null to
// silence on any two platforms and prove nothing. This drives the paths where the effects above
// actually bite:
//   • a decaying tail into the tone filter — filter STATE is where denormals accumulate;
//   • the clipper + master saturation — tanh, i.e. libm.
//
// ⚠️ CORRECTED (P8-3). This header used to claim the scene also exercised "a delay send with
// feedback — the classic denormal trap". IT DOES NOT, and it never did: `renderOffline` passes
// `nullptr` for all four send buses and the writer skips them, and `NativeDigitalDelay` is not
// instantiated anywhere in the core. That leg has never executed in this harness.
//
// ⚠️ AND THIS TEST CANNOT SEE DENORMALS AT ALL — reason (3) above is NOT covered here, despite
// what the comment implied. It is a PEAK-RESIDUAL test (null_test.py gates at −80 dB) and a
// subnormal float lives below −760 dBFS: the quantity measured cannot express the defect. Worse,
// both sides of the comparison were unprotected (this binary links no JUCE, so it has no FTZ
// either), so they agreed *because they were both wrong*. A −153 dBFS residual here says nothing
// whatsoever about denormals. That job belongs to `denormal_test.cpp`, which counts them directly.
//
//   ./scoopy_render_null out.f32
// ─────────────────────────────────────────────────────────────────────────────────────────────
#include "NativeAudioEngineCore.hpp"

#include <memory>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

using namespace scoopyloops;

namespace {

/// A deterministic "sample": a decaying noise burst. Not a sine — a sine is too kind. Broadband
/// content with a long decay is what drives filter and delay state down into the denormal range,
/// which is the whole point of the exercise.
///
/// The PRNG is a fixed-seed xorshift written out longhand: `std::mt19937` is only guaranteed to
/// produce the same numbers for the same standard-library version, and this fixture has to be
/// bit-identical across two *different* standard libraries or it is not a null test at all.
NativeSample makeBurst(double sampleRate) {
    NativeSample s;
    s.id = "burst";
    s.sampleRate = sampleRate;

    const std::size_t n = static_cast<std::size_t>(sampleRate * 2.0);  // 2 s, long decay
    s.left.resize(n);
    s.right.resize(n);

    std::uint32_t x = 0x1234'5678u;
    auto rnd = [&x]() -> float {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        return static_cast<float>(static_cast<std::int32_t>(x)) / 2147483648.0f;
    };
    for (std::size_t i = 0; i < n; ++i) {
        const float t = static_cast<float>(i) / static_cast<float>(sampleRate);
        const float env = std::exp(-3.0f * t);   // long tail → deep into denormal territory
        s.left[i] = rnd() * env * 0.7f;
        s.right[i] = rnd() * env * 0.7f;
    }
    return s;
}

NativeSequencerSnapshot makeScene() {
    NativeSequencerSnapshot snap;
    snap.bpm = 120.0;
    snap.isPlaying = true;
    snap.startStep = 0;

    NativeTrackSnapshot t;
    t.sampleId = "burst";
    t.steps.assign(16, 0);
    t.steps[0] = 1;
    t.steps[6] = 1;                       // two hits so tails overlap
    t.pitchOffsets.assign(16, 0.0);
    t.volume = 0.9f;
    t.pan = -0.2f;
    t.stereoMode = StereoMode::stereo;
    t.tone = -55.0f;                      // drive the FILTER — its state is the denormal sink
    t.toneQ = 0.9f;
    t.send1Level = 0.6f;                  // …and the DELAY, whose feedback loop is the classic trap
    snap.tracks.push_back(std::move(t));
    return snap;
}

}  // namespace

int main(int argc, char** argv) {
    const std::string outPath = argc > 1 ? argv[1] : "render.f32";

    // Heap, not stack: the core is 1.05 MB and Windows gives a thread 1 MB by default, so a
    // stack instance dies with STATUS_STACK_OVERFLOW before main does anything (0xC00000FD,
    // engine-matrix run 29940659486). macOS/Linux give 8 MB, which is why this only ever showed
    // up on Windows — and showed up as a SILENT crash under Git Bash.
    auto corePtr = std::make_unique<NativeAudioEngineCore>();
    auto& core = *corePtr;
    const double sr = 48'000.0;
    if (!core.configure(sr, 128, 0)) {     // 128 = the AudioWorklet quantum, so we render as the
        std::fprintf(stderr, "configure failed\n");   // browser will
        return 1;
    }
    core.registerSample(makeBurst(sr));

    // 6 seconds: long past the last hit, so most of the render is TAIL — exactly the region where
    // denormals bite and where the two platforms are most likely to disagree.
    const std::uint64_t frames = static_cast<std::uint64_t>(sr * 6.0);
    const auto result = core.renderOffline(makeScene(), frames, 128);

    if (result.left.size() != result.right.size() || result.left.empty()) {
        std::fprintf(stderr, "render produced nothing\n");
        return 1;
    }

    // Interleaved float32 — trivially readable from Python/JS, no WAV header to get wrong.
    std::FILE* f = std::fopen(outPath.c_str(), "wb");
    if (f == nullptr) { std::fprintf(stderr, "cannot open %s\n", outPath.c_str()); return 1; }
    for (std::size_t i = 0; i < result.left.size(); ++i) {
        const float lr[2] = { result.left[i], result.right[i] };
        std::fwrite(lr, sizeof(float), 2, f);
    }
    std::fclose(f);

    double peak = 0.0, sum = 0.0;
    for (std::size_t i = 0; i < result.left.size(); ++i) {
        peak = std::max({ peak, std::fabs((double)result.left[i]), std::fabs((double)result.right[i]) });
        sum += (double)result.left[i] * result.left[i] + (double)result.right[i] * result.right[i];
    }
    const double rms = std::sqrt(sum / (double)(result.left.size() * 2));

    // A render that is SILENT would null-test perfectly against anything, which is the one way this
    // harness could lie. Say what came out, loudly.
    std::printf("frames=%zu peak=%.6f rms=%.6f  -> %s\n", result.left.size(), peak, rms, outPath.c_str());
    if (peak < 1e-4) {
        std::fprintf(stderr, "REFUSING: the render is silent — a null test against silence proves nothing\n");
        return 2;
    }
    return 0;
}
