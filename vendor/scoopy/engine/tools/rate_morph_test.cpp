// ─────────────────────────────────────────────────────────────────────────────────────────────
// RATE MORPH TIMING GATE. Proves four behaviours of the multiply glide (T+P detent morph):
//
//   (1) OFF = INSTANT. rateMorphFrames == 0 keeps today's stateless switch: the very first
//       onset after a 1→2 detent change already sits on the canonical m=2 grid.
//   (2) VELOCITY GLIDE + CANONICAL LANDING. With a ramp, inter-onset intervals shrink smoothly
//       from framesPerStep toward framesPerStep/2 (no instant jump), and post-landing onsets
//       sit EXACTLY on the canonical m=2 boundaries of the stateless math — the same frames an
//       instant switch would have produced (deterministic sync restored).
//   (3) PITCH CONTINUITY. A ringing T+P drone's pitch glides to 2× with no discontinuity —
//       neither during the ramp nor at the landing bake (which must freeze, not snap, ratios).
//   (4) RETARGET + m2 < 1. A mid-ramp second detent change continues the glide without a jump;
//       a slow-down (1→0.5) lands on the sparse canonical grid within the bounded hold.
//
// WHY THIS TOOL. The morph lives in the realtime trigger loop (value-diff detection, the forced
// free-path accumulator, the hold/landing probe) which renderOffline() bypasses — so, exactly
// like the scene-switch gate this is modeled on: configure → registerSample →
// publishSequencerState → start → block-by-block render(), asserting onsets on the main bus.
//
//   ./scoopy_rate_morph_test
// ─────────────────────────────────────────────────────────────────────────────────────────────
#include "NativeAudioEngineCore.hpp"

#include <memory>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

using namespace scoopyloops;

namespace {

constexpr double kSampleRate = 48'000.0;
constexpr std::uint32_t kBlock = 128;
// 120 BPM → 6000 frames per 16th — deliberately NOT a multiple of the block.
constexpr std::uint64_t kFramesPerStep = 6000;
constexpr std::size_t kSteps = 16;

NativeSample makeClick(const std::string& id) {
    NativeSample s;
    s.id = id;
    s.sampleRate = kSampleRate;
    s.left.assign(1200, 0.0f);
    s.right.assign(1200, 0.0f);
    for (std::size_t i = 0; i < 900; ++i) {
        const float v = static_cast<float>(
            0.9 * std::cos(2.0 * M_PI * 660.0 * static_cast<double>(i) / kSampleRate));
        s.left[i] = v;
        s.right[i] = v;
    }
    return s;
}

NativeSample makeDrone(const std::string& id, double freq, double seconds) {
    NativeSample s;
    s.id = id;
    s.sampleRate = kSampleRate;
    const std::size_t n = static_cast<std::size_t>(kSampleRate * seconds);
    s.left.assign(n, 0.0f);
    s.right.assign(n, 0.0f);
    for (std::size_t i = 0; i < n; ++i) {
        const float v = static_cast<float>(0.6 * std::sin(2.0 * M_PI * freq
                                                          * static_cast<double>(i) / kSampleRate));
        s.left[i] = v;
        s.right[i] = v;
    }
    return s;
}

// A T+P REG track — the morph-eligible shape. `mult` fills BOTH multiplier fields the way the
// facade does for .timeAndPitch (voice varispeed = pattern ratchet = the detent).
NativeTrackSnapshot makeTPTrack(const std::string& sampleId, std::vector<int> hitSteps,
                                double mult) {
    NativeTrackSnapshot tk;
    tk.sampleId = sampleId;
    tk.steps.assign(kSteps, 0);
    for (int h : hitSteps) tk.steps[static_cast<std::size_t>(h)] = 1;
    tk.pitchOffsets.assign(kSteps, 0.0);
    tk.volume = 1.0f;
    tk.stereoMode = StereoMode::stereo;
    tk.polyphonic = false;
    tk.speedMultiplier = mult;
    tk.patternSpeedMultiplier = mult;
    tk.tpMorphEligible = true;
    return tk;
}

NativeSequencerSnapshot makeScene(std::vector<NativeTrackSnapshot> tracks,
                                  std::uint32_t morphFrames) {
    NativeSequencerSnapshot snap;
    snap.bpm = 120.0;
    snap.isPlaying = true;
    snap.startStep = 0;
    snap.masterVolume = 1.0f;
    snap.masterClipperCurve = 2;
    snap.masterClipperDrive = 1.0f;
    snap.masterClipperCeiling = 1.0f;
    snap.masterClipperOversample = 2;
    snap.masterClipperDecoupled = true;
    snap.rateMorphFrames = morphFrames;
    snap.tracks = std::move(tracks);
    return snap;
}

struct Harness {
    // Heap, not stack: the core is 1.05 MB and Windows gives a thread 1 MB by default, so a
    // harness holding one by value dies with STATUS_STACK_OVERFLOW before main does anything
    // (0xC00000FD, engine-matrix run 29940659486). macOS/Linux give 8 MB, which is why this only
    // ever showed up on Windows — and showed up as a SILENT crash under Git Bash.
    std::unique_ptr<NativeAudioEngineCore> corePtr = std::make_unique<NativeAudioEngineCore>();
    NativeAudioEngineCore& core = *corePtr;
    std::vector<float> mainL;
    std::array<std::vector<float>, NativeAudioEngineCore::laneCount> lanes;

    Harness() {
        core.configure(kSampleRate, kBlock, 0);
        for (auto& l : lanes) l.assign(kBlock, 0.0f);
    }

    void renderFrames(std::uint64_t frames) {
        std::array<float*, NativeAudioEngineCore::laneCount> out {};
        for (std::size_t i = 0; i < lanes.size(); ++i) out[i] = lanes[i].data();
        for (std::uint64_t done = 0; done < frames; done += kBlock) {
            core.render(nullptr, nullptr, out, kBlock);
            const auto& L = lanes[static_cast<std::size_t>(AudioLane::mainLeft)];
            mainL.insert(mainL.end(), L.begin(), L.end());
        }
    }
};

std::size_t onsetAfter(const std::vector<float>& x, std::size_t from, float thr = 0.25f) {
    for (std::size_t i = from; i < x.size(); ++i)
        if (std::fabs(x[i]) > thr) return i;
    return SIZE_MAX;
}

// Every onset from `from`, using a refractory gap shorter than the densest expected interval.
std::vector<std::size_t> allOnsets(const std::vector<float>& x, std::size_t from,
                                   std::size_t refractory) {
    std::vector<std::size_t> onsets;
    std::size_t cur = onsetAfter(x, from);
    while (cur != SIZE_MAX) {
        onsets.push_back(cur);
        cur = onsetAfter(x, cur + refractory);
    }
    return onsets;
}

// Shared canonical-alignment check: every onset at/after `fromFrame` must sit on a multiple of
// `intervalFrames` from the epoch shift (|error| ≤ tol; llround/attack shaping gives ±2).
// tol: llround jitter plus the rate-dependent declick-attack shift (a slowed-down click crosses
// the onset threshold a few frames later) — ±6 covers both without admitting a real misalignment.
int assertCanonical(const std::vector<std::size_t>& onsets, std::size_t fromFrame,
                    long long shift, long long intervalFrames, const char* label,
                    long long tol = 6) {
    int failures = 0;
    int checked = 0;
    for (const std::size_t o : onsets) {
        if (o < fromFrame) continue;
        ++checked;
        const long long rel = static_cast<long long>(o) - shift;
        long long err = rel % intervalFrames;
        if (err > intervalFrames / 2) err -= intervalFrames;
        if (std::llabs(err) > tol) {
            std::printf("    FAIL (%s): onset @%zu is %+lld frames off the canonical grid.\n",
                        label, o, err);
            ++failures;
        }
    }
    if (checked == 0) {
        std::printf("    FAIL (%s): no onsets in the post-landing window.\n", label);
        ++failures;
    }
    return failures;
}

// ── (1) OFF = instant, canonical from the first post-change onset ────────────────────────────
int testOffIsInstant() {
    Harness h;
    h.core.registerSample(makeClick("click"));
    std::vector<int> all(kSteps);
    for (std::size_t i = 0; i < kSteps; ++i) all[i] = static_cast<int>(i);

    h.core.publishSequencerState(makeScene({ makeTPTrack("click", all, 1.0) }, /*morph*/ 0));
    h.core.start();
    h.renderFrames(4 * kFramesPerStep + 700);
    const std::size_t changeFrame = h.mainL.size();
    h.core.publishSequencerState(makeScene({ makeTPTrack("click", all, 2.0) }, /*morph*/ 0));
    h.renderFrames(6 * kFramesPerStep);

    const auto onsets = allOnsets(h.mainL, 0, 1200);
    const long long shift = static_cast<long long>(onsets.empty() ? 0 : onsets.front());
    // Every onset ≥ one step past the change must be canonical m=2 (interval 3000). The change
    // itself lands mid-step: the boundary math switches within that same step.
    int failures = assertCanonical(onsets, changeFrame + kFramesPerStep, shift, 3000, "off");
    std::printf("  OFF: %zu onsets, first @%lld — post-change grid canonical at 3000-frame "
                "spacing: %s\n", onsets.size(), shift, failures ? "NO" : "yes");
    return failures;
}

// ── (2) glide + canonical landing ────────────────────────────────────────────────────────────
int testMorphGlideAndLanding() {
    constexpr std::uint32_t kMorph = 24'000;   // 0.5 s
    Harness h;
    h.core.registerSample(makeClick("click"));
    std::vector<int> all(kSteps);
    for (std::size_t i = 0; i < kSteps; ++i) all[i] = static_cast<int>(i);

    h.core.publishSequencerState(makeScene({ makeTPTrack("click", all, 1.0) }, kMorph));
    h.core.start();
    h.renderFrames(4 * kFramesPerStep + 700);
    const std::size_t changeFrame = h.mainL.size();
    h.core.publishSequencerState(makeScene({ makeTPTrack("click", all, 2.0) }, kMorph));
    h.renderFrames(3 * kMorph);

    const auto onsets = allOnsets(h.mainL, 0, 1200);
    const long long shift = static_cast<long long>(onsets.empty() ? 0 : onsets.front());
    int failures = 0;

    // (a) During the ramp the intervals must GLIDE: within the morph window, no interval may
    // sit at the old spacing once the glide is underway, none may already be at (or beyond)
    // the target spacing, and they must be non-increasing (tolerance for llround jitter).
    std::vector<long long> rampIntervals;
    for (std::size_t i = 1; i < onsets.size(); ++i) {
        const std::size_t a = onsets[i - 1], b = onsets[i];
        if (a > changeFrame + kFramesPerStep && b < changeFrame + kMorph)
            rampIntervals.push_back(static_cast<long long>(b - a));
    }
    if (rampIntervals.size() < 3) {
        std::printf("    FAIL: too few intervals inside the ramp window (%zu).\n",
                    rampIntervals.size());
        ++failures;
    }
    for (std::size_t i = 0; i < rampIntervals.size(); ++i) {
        const long long iv = rampIntervals[i];
        if (iv >= 6000 - 8) {
            std::printf("    FAIL: interval %lld inside the ramp still at the OLD spacing "
                        "(no glide started).\n", iv);
            ++failures;
        }
        if (iv <= 3000 + 8) {
            std::printf("    FAIL: interval %lld inside the ramp already at the TARGET spacing "
                        "(jumped, not glided).\n", iv);
            ++failures;
        }
        if (i > 0 && iv > rampIntervals[i - 1] + 8) {
            std::printf("    FAIL: ramp intervals not monotonic (%lld after %lld).\n",
                        iv, rampIntervals[i - 1]);
            ++failures;
        }
    }

    // (b) Post-landing: canonical m=2 grid — the SAME frames the stateless math would produce,
    // i.e. multiples of 3000 from the epoch. Give the landing 2 hold periods of slack.
    failures += assertCanonical(onsets, changeFrame + kMorph + 3 * kFramesPerStep,
                                shift, 3000, "landing");
    std::printf("  MORPH 1→2 over 0.5 s: %zu ramp intervals %lld…%lld, landing canonical: %s\n",
                rampIntervals.size(),
                rampIntervals.empty() ? 0 : rampIntervals.front(),
                rampIntervals.empty() ? 0 : rampIntervals.back(),
                failures ? "NO" : "yes");
    return failures;
}

// ── (3) pitch continuity of a ringing drone ──────────────────────────────────────────────────
int testPitchContinuity() {
    constexpr std::uint32_t kMorph = 24'000;   // 0.5 s
    Harness h;
    h.core.registerSample(makeDrone("drone", 220.0, 6.0));

    // One extended cell spanning the whole pattern, so the voice rings across the morph.
    auto mkDroneTrack = [](double mult) {
        NativeTrackSnapshot tk;
        tk.sampleId = "drone";
        tk.steps.assign(kSteps, 0);
        tk.steps[0] = 1;
        tk.pitchOffsets.assign(kSteps, 0.0);
        tk.cellLengths.assign(kSteps, 1);
        tk.cellLengths[0] = static_cast<int>(kSteps);
        tk.volume = 1.0f;
        tk.stereoMode = StereoMode::stereo;
        tk.polyphonic = false;
        tk.speedMultiplier = mult;
        tk.patternSpeedMultiplier = mult;
        tk.tpMorphEligible = true;
        return tk;
    };

    h.core.publishSequencerState(makeScene({ mkDroneTrack(1.0) }, kMorph));
    h.core.start();
    h.renderFrames(2 * kFramesPerStep + 700);
    const std::size_t changeFrame = h.mainL.size();
    h.core.publishSequencerState(makeScene({ mkDroneTrack(2.0) }, kMorph));
    h.renderFrames(2 * kMorph);

    // Per-window frequency from positive-going zero crossings. The estimator quantizes to
    // sampleRate/window per crossing, so windows are sized per use: 4096 for the endpoint
    // ratio (±11.7 Hz), 2048 for the continuity sweep (±23.4 Hz; an exponential 0.5 s ramp
    // moves ≈ 6% per window, an instant switch 100%).
    auto windowFreq = [&](std::size_t start, std::size_t win) {
        int crossings = 0;
        for (std::size_t i = start + 1; i < start + win && i < h.mainL.size(); ++i)
            if (h.mainL[i - 1] <= 0.0f && h.mainL[i] > 0.0f) ++crossings;
        return static_cast<double>(crossings) * kSampleRate / static_cast<double>(win);
    };

    int failures = 0;
    const double before = windowFreq(changeFrame - 5000, 4096);
    const double after  = windowFreq(changeFrame + kMorph + 4096, 4096);
    std::printf("  PITCH: %.1f Hz before → %.1f Hz after the morph (ratio %.3f, expected ≈ 2)\n",
                before, after, before > 0.0 ? after / before : 0.0);
    if (std::fabs(before - 220.0) > 15.0) {
        std::printf("    FAIL: pre-morph drone is not at its base pitch.\n");
        ++failures;
    }
    if (before <= 0.0 || std::fabs(after / before - 2.0) > 0.12) {
        std::printf("    FAIL: post-morph drone did not land at 2× pitch.\n");
        ++failures;
    }
    // Sweep across the ramp AND the landing seam — a bake that snapped ratios would jump
    // there. Ends BEFORE the next owner boundary (~6 pattern steps after landing), whose
    // mono re-attack is normal musical behaviour, not a morph seam.
    constexpr std::size_t kSweepWin = 2048;
    double maxJump = 0.0;
    double prev = windowFreq(changeFrame - kSweepWin, kSweepWin);
    for (std::size_t w = changeFrame; w < changeFrame + kMorph + 6 * kSweepWin; w += kSweepWin) {
        const double f = windowFreq(w, kSweepWin);
        if (prev > 50.0 && f > 50.0)
            maxJump = std::max(maxJump, std::fabs(f - prev) / prev);
        prev = f;
    }
    std::printf("  PITCH: max adjacent-window jump %.1f%% (instant switch would be ~100%%)\n",
                maxJump * 100.0);
    if (maxJump > 0.25) {
        std::printf("    FAIL: pitch is not continuous through the morph/landing.\n");
        ++failures;
    }
    // The drone must RING through the landing — the silent-gap regression (a stale
    // prevResolvedStep made the landing look like a locator jump, cutting the voice into a
    // DOA mid-cell entry) showed up here as a whole-window dropout.
    for (std::size_t w = changeFrame; w < changeFrame + kMorph + 6 * kSweepWin; w += kSweepWin) {
        double peak = 0.0;
        for (std::size_t i = w; i < w + kSweepWin && i < h.mainL.size(); ++i)
            peak = std::max(peak, static_cast<double>(std::fabs(h.mainL[i])));
        if (peak < 0.05) {
            std::printf("    FAIL: dropout at %+lld vs change (peak %.3f) — the voice did not "
                        "survive the morph/landing.\n",
                        static_cast<long long>(w) - static_cast<long long>(changeFrame), peak);
            ++failures;
        }
    }
    return failures;
}

// ── (4) mid-ramp retarget + slow-down landing ────────────────────────────────────────────────
int testRetargetAndSlowdown() {
    constexpr std::uint32_t kMorph = 24'000;
    Harness h;
    h.core.registerSample(makeClick("click"));
    std::vector<int> all(kSteps);
    for (std::size_t i = 0; i < kSteps; ++i) all[i] = static_cast<int>(i);

    // Retarget: 1→2, then mid-ramp →4. No interval may ever exceed its predecessor (speeding
    // up throughout), none may jump straight to the final spacing inside the first ramp, and
    // the landing must be canonical for m=4 (1500-frame grid).
    h.core.publishSequencerState(makeScene({ makeTPTrack("click", all, 1.0) }, kMorph));
    h.core.start();
    h.renderFrames(4 * kFramesPerStep + 700);
    const std::size_t change1 = h.mainL.size();
    h.core.publishSequencerState(makeScene({ makeTPTrack("click", all, 2.0) }, kMorph));
    h.renderFrames(kMorph / 2);
    h.core.publishSequencerState(makeScene({ makeTPTrack("click", all, 4.0) }, kMorph));
    h.renderFrames(3 * kMorph);

    const auto onsets = allOnsets(h.mainL, 0, 700);
    const long long shift = static_cast<long long>(onsets.empty() ? 0 : onsets.front());
    int failures = 0;
    for (std::size_t i = 1; i < onsets.size(); ++i) {
        const std::size_t a = onsets[i - 1], b = onsets[i];
        if (a <= change1 + kFramesPerStep || b >= change1 + kMorph / 2 + kMorph) continue;
        const long long iv = static_cast<long long>(b - a);
        if (i > 1 && onsets[i - 2] > change1 + kFramesPerStep) {
            const long long prevIv = static_cast<long long>(a - onsets[i - 2]);
            if (iv > prevIv + 8) {
                std::printf("    FAIL: retarget produced a lengthening interval (%lld after "
                            "%lld) — the glide jumped.\n", iv, prevIv);
                ++failures;
            }
        }
    }
    failures += assertCanonical(onsets, change1 + kMorph / 2 + kMorph + 3 * kFramesPerStep,
                                shift, 1500, "retarget→4");
    std::printf("  RETARGET 1→2→4: %zu onsets, landing canonical at 1500-frame spacing: %s\n",
                onsets.size(), failures ? "NO" : "yes");

    // Slow-down: 1→0.5. Canonical m=0.5 boundaries are 12000 frames apart (2 master steps);
    // the bounded hold must land there without waiting forever.
    Harness h2;
    h2.core.registerSample(makeClick("click"));
    h2.core.publishSequencerState(makeScene({ makeTPTrack("click", all, 1.0) }, kMorph));
    h2.core.start();
    h2.renderFrames(4 * kFramesPerStep + 700);
    const std::size_t change2 = h2.mainL.size();
    h2.core.publishSequencerState(makeScene({ makeTPTrack("click", all, 0.5) }, kMorph));
    h2.renderFrames(kMorph + 10 * kFramesPerStep);

    // Refractory 3000: at half rate the click's audible ring is ~1800 output frames, so a
    // shorter gap re-detects the SAME click as a phantom onset. Canonical spacing is 12000.
    const auto onsets2 = allOnsets(h2.mainL, 0, 3000);
    const long long shift2 = static_cast<long long>(onsets2.empty() ? 0 : onsets2.front());
    const int slowFailures = assertCanonical(
        onsets2, change2 + kMorph + 5 * kFramesPerStep, shift2, 12'000, "slow-down");
    std::printf("  SLOW-DOWN 1→0.5: landing canonical at 12000-frame spacing: %s\n",
                slowFailures ? "NO" : "yes");
    return failures + slowFailures;
}

}  // namespace

int main() {
    std::printf("Rate-morph timing gate @ 48 kHz, 128-frame blocks, 120 BPM "
                "(6000 frames/step).\n\n");

    int failures = 0;
    std::printf("(1) rateMorphFrames = 0 keeps the instant stateless switch\n");
    failures += testOffIsInstant();

    std::printf("\n(2) velocity glide + canonical landing\n");
    failures += testMorphGlideAndLanding();

    std::printf("\n(3) ringing-voice pitch continuity\n");
    failures += testPitchContinuity();

    std::printf("\n(4) mid-ramp retarget + slow-down\n");
    failures += testRetargetAndSlowdown();

    if (failures) {
        std::printf("\nFAIL: %d rate-morph assertion(s) failed.\n", failures);
        return 1;
    }
    std::printf("\n  PASS: OFF is instant-canonical, the glide bends intervals and pitch "
                "smoothly, and every morph lands back on the stateless canonical grid.\n\n");
    return 0;
}
