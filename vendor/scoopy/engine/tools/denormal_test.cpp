// ─────────────────────────────────────────────────────────────────────────────────────────────
// P8-3 — THE DENORMAL GATE. Does a decaying tail leave subnormal floats in the engine's state?
//
// WHY THIS EXISTS, AND WHY THE NULL TEST COULD NOT DO IT.
//
// P8-3b's null test (`render_null.cpp` + `null_test.py`) reported a −153 dBFS residual and the
// ledger read that as "the DSP is proven identical". It is not, for this defect, and it never could
// have been — for three independent reasons, each of which is fatal on its own:
//
//   1. A PEAK-RESIDUAL TEST IS BLIND TO DENORMALS BY CONSTRUCTION. A subnormal float is smaller
//      than 1.18e-38, i.e. below −760 dBFS. `null_test.py` gates on peak residual at −80 dB. The
//      quantity it measures cannot express the quantity we care about. A denormal is a **CPU**
//      defect, not an amplitude one — the numbers are right, they are just catastrophically slow to
//      compute on hardware that traps them.
//   2. BOTH SIDES OF THAT TEST WERE UNPROTECTED. `scoopy_render_null` links `scoopy_engine` and
//      nothing else — no JUCE, hence no `ScopedNoDenormals` on the native side either. It compared
//      unprotected-native against unprotected-WASM. They agreed *because they were both wrong*. The
//      shipping mac app (which does flush, via the host layer) was never in the comparison at all.
//   3. THE FEEDBACK PATH IT CLAIMED TO EXERCISE DOES NOT RUN. `render_null.cpp` advertised "a delay
//      send with feedback — the classic denormal trap". `renderOffline` passes `nullptr` for all
//      four send buses and the writer skips them, and `NativeDigitalDelay` is not instantiated
//      anywhere in the core. That leg was never executed. (Comment corrected in that file.)
//
// SO WHAT ACTUALLY BITES, in the code that really runs:
//
//   • THE DC BLOCKER — `NativeAudioEngineCore.cpp`, pole 0.9995f, state in FLOAT
//     (`.hpp:752`). Every time the mix decays to silence its state free-runs geometrically:
//     x[n] = 0.9995 · x[n-1], forever, with no input to re-normalise it. It passes clean through
//     the subnormal band on its way to zero and spends roughly 0.7 s *inside* it. This recurs on
//     EVERY silence, not once.
//   • THE TONE FILTER's DF2T biquad state, in DOUBLE. Same shape, far deeper subnormal range.
//
// HOW THIS TEST SEES WHAT THE NULL TEST CANNOT: the DC blocker's output is written straight to the
// output buffer (`left[frame] = clamp(blockedLeft, …)`), and `clamp` preserves a subnormal. So the
// subnormals are *literally in the rendered audio* — countable, from outside, with no accessor and
// no instrumentation. We render well past the last hit, into deep silence, and count them.
//
//   BEFORE the core-side flush: a large nonzero count. AFTER: exactly zero.
//
// ⚠️ THIS BINARY DELIBERATELY DOES **NOT** ENABLE FTZ. That is not an oversight — it is the point.
// No FTZ is precisely the numeric environment of WebAssembly (the spec mandates full IEEE-754
// subnormals; there is no `_MM_SET_FLUSH_ZERO_MODE` to reach for). So this native binary is a
// faithful proxy for the browser, and a fix that satisfies it is a fix in the shared C++ source
// that satisfies both platforms — which is the "one fix, two payoffs" the ledger promised.
//
//   ./scoopy_denormal_test
// ─────────────────────────────────────────────────────────────────────────────────────────────
#include "NativeAudioEngineCore.hpp"

#include <memory>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <vector>

using namespace scoopyloops;

namespace {

/// The same decaying broadband burst the null-test scene uses — a sine would be too kind, and the
/// PRNG is longhand xorshift so it is bit-identical across two different standard libraries.
NativeSample makeBurst(double sampleRate) {
    NativeSample s;
    s.id = "burst";
    s.sampleRate = sampleRate;

    const std::size_t n = static_cast<std::size_t>(sampleRate * 2.0);
    s.left.resize(n);
    s.right.resize(n);

    std::uint32_t x = 0x1234'5678u;
    auto rnd = [&x]() -> float {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        return static_cast<float>(static_cast<std::int32_t>(x)) / 2147483648.0f;
    };
    for (std::size_t i = 0; i < n; ++i) {
        const float t = static_cast<float>(i) / static_cast<float>(sampleRate);
        const float env = std::exp(-3.0f * t);
        s.left[i] = rnd() * env * 0.7f;
        s.right[i] = rnd() * env * 0.7f;
    }
    return s;
}

/// ONE hit, then the longest run of pure SILENCE we can arrange — because the silence is the thing
/// under test, and getting it is harder than it looks.
///
/// ⚠️ THE PATTERN LENGTH IS THE TEST. The first draft of this file used the null-test scene's
/// 16 steps at 120 BPM — which is a 2-SECOND LOOP. The sequencer dutifully re-triggered the burst
/// every 2 s forever, so a "20-second decay" contained no decay at all and the test passed while
/// proving nothing. (You could see it in the probe: the peak alternated 0.084 / 0.0045, once per
/// second, for the whole render.) A denormal test with no silence in it is not a denormal test.
///
/// 64 steps at 120 BPM = an 8-SECOND loop: ~2 s of burst, then ~6 s of true silence. The DC
/// blocker needs ~3.4 s of that to free-run down to FLT_MIN and ~0.7 s more to cross the subnormal
/// band, so 6 s clears it with room to spare.
NativeSequencerSnapshot makeScene() {
    NativeSequencerSnapshot snap;
    snap.bpm = 120.0;
    snap.isPlaying = true;
    snap.startStep = 0;

    NativeTrackSnapshot t;
    t.sampleId = "burst";
    t.steps.assign(64, 0);   // 8 s at 120 BPM — see above; 16 steps would loop every 2 s
    t.steps[0] = 1;
    t.pitchOffsets.assign(64, 0.0);
    t.volume = 0.9f;
    t.pan = -0.2f;
    t.stereoMode = StereoMode::stereo;
    t.tone = -55.0f;   // drive the filter — its DF2T state is the double-domain sink
    t.toneQ = 0.9f;
    snap.tracks.push_back(std::move(t));
    return snap;
}

bool isSubnormal(float v) noexcept {
    return std::fpclassify(v) == FP_SUBNORMAL;
}

}  // namespace

int main() {
    // Heap, not stack: the core is 1.05 MB and Windows gives a thread 1 MB by default, so a
    // stack instance dies with STATUS_STACK_OVERFLOW before main does anything (0xC00000FD,
    // engine-matrix run 29940659486). macOS/Linux give 8 MB, which is why this only ever showed
    // up on Windows — and showed up as a SILENT crash under Git Bash.
    auto corePtr = std::make_unique<NativeAudioEngineCore>();
    auto& core = *corePtr;
    const double sr = 48'000.0;
    if (!core.configure(sr, 128, 0)) {
        std::fprintf(stderr, "configure failed\n");
        return 1;
    }
    core.registerSample(makeBurst(sr));

    // ⚠️ 20 SECONDS, and the length is load-bearing. The burst is done by ~2.5 s; everything after
    // is the DC blocker free-running toward zero at 0.9995/sample. Reaching the subnormal band from
    // a small starting value takes on the order of 3-4 s of silence, and CROSSING it takes ~0.7 s
    // more. The existing null-test scene renders only ~3.2 s of silence — it stops right at the
    // edge, which is one more reason it never saw this.
    const std::uint64_t frames = static_cast<std::uint64_t>(sr * 20.0);

    const auto t0 = std::chrono::steady_clock::now();
    const auto result = core.renderOffline(makeScene(), frames, 128);
    const auto t1 = std::chrono::steady_clock::now();
    const double renderMs = std::chrono::duration<double, std::milli>(t1 - t0).count();

    if (result.left.size() != result.right.size() || result.left.empty()) {
        std::fprintf(stderr, "render produced nothing\n");
        return 1;
    }

    std::size_t subnormals = 0;
    std::size_t firstAt = 0;
    std::size_t lastAt = 0;
    double peak = 0.0;
    for (std::size_t i = 0; i < result.left.size(); ++i) {
        peak = std::max({ peak, std::fabs((double)result.left[i]), std::fabs((double)result.right[i]) });
        const bool sub = isSubnormal(result.left[i]) || isSubnormal(result.right[i]);
        if (sub) {
            if (subnormals == 0) firstAt = i;
            lastAt = i;
            ++subnormals;
        }
    }

    // A silent render would pass this test trivially, which is the one way it could lie. Say what
    // came out — same guard the null-test harness carries, and for the same reason.
    std::printf("frames=%zu peak=%.6f  render=%.1f ms\n", result.left.size(), peak, renderMs);
    if (peak < 1e-4) {
        std::fprintf(stderr, "REFUSING: the render is silent — this test proves nothing against silence\n");
        return 2;
    }

    if (subnormals > 0) {
        std::printf(
            "SUBNORMALS: %zu output samples, frames %zu..%zu (%.2f s .. %.2f s)\n",
            subnormals, firstAt, lastAt,
            (double)firstAt / sr, (double)lastAt / sr);
        std::fprintf(stderr,
            "FAIL: the engine emits subnormal floats on a decaying tail.\n"
            "      In WASM (no FTZ) every one of these is computed the slow way, on the audio\n"
            "      thread, on every silence. This is the P8-3 cliff.\n");
        return 1;
    }

    std::printf("no subnormals — the tail decays to true zero\n");
    return 0;
}
