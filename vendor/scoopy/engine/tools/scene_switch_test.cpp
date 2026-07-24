// ─────────────────────────────────────────────────────────────────────────────────────────────
// SCENE-SWITCH TIMING GATE. Proves three behaviours of the frame-exact pattern-scene switch:
//
//   (1) SAMPLE-EXACT BOUNDARY. A scheduled (early-armed, parked) switch installs so the new
//       pattern's step 0 triggers on the EXACT boundary frame — not rounded up to the next render
//       block — and the grid does NOT re-anchor (later steps stay on the pre-switch grid).
//   (2) SCENE GLIDE. patternSwitchGlideFrames ramps a track's volume base linearly from its
//       pre-switch value to the new scene's value over the glide window (audio-thread lanes),
//       instead of the 4 ms declick.
//   (3) CLEAN CUT. patternSwitchCut fades every voice still ringing at the boundary over the
//       choke fade (~512 frames), while the new scene's boundary voices attack untouched.
//
// WHY THIS TOOL. These behaviours live in the PARK/INSTALL machinery at the top of render(),
// which renderOffline() bypasses entirely — so the gate drives the realtime path: configure →
// registerSample → publishSequencerState → start → block-by-block render(), reading the main bus.
// Timing is asserted RELATIVELY (new-scene onset vs the old scene's last downbeat) so it does not
// depend on how the transport anchors its first frame.
//
//   ./scoopy_scene_switch_test
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
// 120 BPM → 60 / (120 × 4) s per step = 6000 frames — deliberately NOT a multiple of the block.
constexpr std::uint64_t kFramesPerStep = 6000;
constexpr std::size_t kSteps = 16;
constexpr std::uint64_t kCycleFrames = kFramesPerStep * kSteps;

// A short cosine burst starting at full amplitude — onset-sharp AND spectrally alive. (A pure DC
// click is structurally silenced by the voice path's filtering, so it cannot probe timing here.)
// Any fixed per-voice attack shaping shifts every detected onset by the SAME offset, and all the
// timing assertions below are relative, so exactness is preserved.
NativeSample makeClick(const std::string& id) {
    NativeSample s;
    s.id = id;
    s.sampleRate = kSampleRate;
    s.left.assign(2000, 0.0f);
    s.right.assign(2000, 0.0f);
    for (std::size_t i = 0; i < 1500; ++i) {
        const float v = static_cast<float>(
            0.9 * std::cos(2.0 * M_PI * 660.0 * static_cast<double>(i) / kSampleRate));
        s.left[i] = v;
        s.right[i] = v;
    }
    return s;
}

// A long sine drone (rings for `seconds` from one hit).
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

NativeTrackSnapshot makeTrack(const std::string& sampleId, float volume, float pan,
                              std::vector<int> hitSteps, std::size_t stepCount = kSteps) {
    NativeTrackSnapshot tk;
    tk.sampleId = sampleId;
    tk.steps.assign(stepCount, 0);
    for (int h : hitSteps) tk.steps[static_cast<std::size_t>(h)] = 1;
    tk.pitchOffsets.assign(stepCount, 0.0);
    tk.volume = volume;
    tk.pan = pan;
    tk.stereoMode = StereoMode::stereo;
    tk.polyphonic = true;
    return tk;
}

NativeSequencerSnapshot makeScene(std::vector<NativeTrackSnapshot> tracks) {
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
    snap.tracks = std::move(tracks);
    return snap;
}

// Block-by-block realtime harness accumulating the main bus.
struct Harness {
    // Heap, not stack: the core is 1.05 MB and Windows gives a thread 1 MB by default, so a
    // harness holding one by value dies with STATUS_STACK_OVERFLOW before main does anything
    // (0xC00000FD, engine-matrix run 29940659486). macOS/Linux give 8 MB, which is why this only
    // ever showed up on Windows — and showed up as a SILENT crash under Git Bash.
    std::unique_ptr<NativeAudioEngineCore> corePtr = std::make_unique<NativeAudioEngineCore>();
    NativeAudioEngineCore& core = *corePtr;
    std::vector<float> mainL, mainR;
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
            const auto& R = lanes[static_cast<std::size_t>(AudioLane::mainRight)];
            mainL.insert(mainL.end(), L.begin(), L.end());
            mainR.insert(mainR.end(), R.begin(), R.end());
        }
    }
};

// First frame ≥ `from` where |x| exceeds `thr`. Returns SIZE_MAX when none.
std::size_t onsetAfter(const std::vector<float>& x, std::size_t from, float thr = 0.25f) {
    for (std::size_t i = from; i < x.size(); ++i)
        if (std::fabs(x[i]) > thr) return i;
    return SIZE_MAX;
}

// Mean |x| over [from, to).
double meanMag(const std::vector<float>& x, std::size_t from, std::size_t to) {
    to = std::min(to, x.size());
    if (from >= to) return 0.0;
    double acc = 0.0;
    for (std::size_t i = from; i < to; ++i) acc += std::fabs(static_cast<double>(x[i]));
    return acc / static_cast<double>(to - from);
}

int gBoundaryFrameOffset = -1;  // set by test 1: the boundary frame relative to render start

// ── (1) Sample-exact boundary ────────────────────────────────────────────────────────────────
// Track 0 (LEFT): click at step 0 in the OLD scene only → one left click per 16-step cycle.
// Track 1 (RIGHT): clicks at steps 0/4/8 in the NEW scene only. Boundary = a masterStep multiple
// of 16, so the new step 0 must land exactly one full cycle after the old scene's last downbeat.
int testBoundaryExactness(bool lateArm) {
    Harness h;
    h.core.registerSample(makeClick("clickL"));
    h.core.registerSample(makeClick("clickR"));

    auto sceneA = makeScene({ makeTrack("clickL", 1.0f, -1.0f, {0}),
                              makeTrack("clickR", 1.0f,  1.0f, {}) });
    h.core.publishSequencerState(sceneA);
    h.core.start();

    // Run into the cycle (past step 4), then arm the switch at boundary = step 16.
    h.renderFrames(5 * kFramesPerStep + 700);   // mid-step, not block- or step-aligned

    auto sceneB = makeScene({ makeTrack("clickL", 1.0f, -1.0f, {}),
                              makeTrack("clickR", 1.0f,  1.0f, {0, 4, 8}) });
    sceneB.patternSwitchEventID = 1;
    if (lateArm) {
        // Boundary already passed → the core must roll it forward one period and still land clean.
        sceneB.patternSwitchBoundaryStep = 0;
        sceneB.patternSwitchPeriod = static_cast<std::uint32_t>(kSteps);
    } else {
        sceneB.patternSwitchBoundaryStep = static_cast<std::int64_t>(kSteps);
        sceneB.patternSwitchPeriod = static_cast<std::uint32_t>(kSteps);
    }
    h.core.publishSequencerState(sceneB);

    // Render through the boundary plus most of the next cycle.
    h.renderFrames(2 * kCycleFrames);

    const std::size_t lastLeft = [&] {
        std::size_t last = SIZE_MAX, cur = onsetAfter(h.mainL, 0);
        while (cur != SIZE_MAX) { last = cur; cur = onsetAfter(h.mainL, cur + 4000); }
        return last;
    }();
    const std::size_t firstRight = onsetAfter(h.mainR, 0);

    int failures = 0;
    const char* label = lateArm ? "late-arm (rolled fwd)" : "early-arm";
    if (lastLeft == SIZE_MAX || firstRight == SIZE_MAX) {
        std::printf("  %s: FAIL — expected clicks missing (left=%zu right=%zu)\n",
                    label, lastLeft, firstRight);
        return 1;
    }
    const long long gap = static_cast<long long>(firstRight) - static_cast<long long>(lastLeft);
    std::printf("  %s: last old downbeat @%zu, new step0 @%zu (gap %lld, expected %llu)\n",
                label, lastLeft, firstRight, gap,
                static_cast<unsigned long long>(kCycleFrames));
    if (gap != static_cast<long long>(kCycleFrames)) {
        std::printf("    FAIL: new-scene downbeat is %lld frames off the exact boundary.\n",
                    gap - static_cast<long long>(kCycleFrames));
        ++failures;
    }
    // No grid re-anchor: the new pattern's steps 4 and 8 land exactly 4/8 steps later.
    for (std::uint64_t stepOff : {4ull, 8ull}) {
        const std::size_t expect = firstRight + static_cast<std::size_t>(stepOff * kFramesPerStep);
        const std::size_t got = onsetAfter(h.mainR, firstRight + 4000 * (stepOff / 4));
        (void)got;
        const std::size_t near = onsetAfter(h.mainR, expect - 64);
        if (near != expect) {
            std::printf("    FAIL: step %llu onset at %zu, expected %zu (grid re-anchored?).\n",
                        static_cast<unsigned long long>(stepOff), near, expect);
            ++failures;
        }
    }
    // The old scene must NOT fire its own downbeat at the boundary (no double hit).
    if (onsetAfter(h.mainL, lastLeft + 4000) != SIZE_MAX) {
        std::printf("    FAIL: the OLD scene fired past the boundary (double downbeat).\n");
        ++failures;
    }
    if (!lateArm && failures == 0)
        gBoundaryFrameOffset = static_cast<int>(firstRight % kBlock);
    return failures;
}

// ── (2) Scene glide ──────────────────────────────────────────────────────────────────────────
// Same pattern in both scenes (drone hit at step 0); only the volume differs (1.0 → 0.25).
// With glideFrames = 48000 (1 s) the level must fall LINEARLY across the window; with 0 it must
// land within the ~4 ms declick.
int testGlide(std::uint32_t glideFrames) {
    Harness h;
    // 1.5 s < one 2 s cycle, so exactly ONE drone voice rings at any time (stacked voices from
    // successive step-0 hits would sum coherently and double every measured level).
    h.core.registerSample(makeDrone("drone", 220.0, 1.5));

    auto sceneA = makeScene({ makeTrack("drone", 1.0f, 0.0f, {0}) });
    h.core.publishSequencerState(sceneA);
    h.core.start();
    h.renderFrames(5 * kFramesPerStep + 700);

    auto sceneB = makeScene({ makeTrack("drone", 0.25f, 0.0f, {0}) });
    sceneB.patternSwitchEventID = 2;
    sceneB.patternSwitchBoundaryStep = static_cast<std::int64_t>(kSteps);
    sceneB.patternSwitchPeriod = static_cast<std::uint32_t>(kSteps);
    sceneB.patternSwitchGlideFrames = glideFrames;
    h.core.publishSequencerState(sceneB);

    const std::size_t renderedBefore = h.mainL.size();
    h.renderFrames(2 * kCycleFrames);

    // The boundary: the new drone hit at new step 0 = one cycle after the old hit at step 0.
    // Old hit was at ≈ render start; find it and add a cycle.
    (void)renderedBefore;
    const std::size_t firstHit = onsetAfter(h.mainL, 0, 0.05f);
    const std::size_t boundary = firstHit + kCycleFrames;

    // Pre-switch reference at volume 1.0: early in the previous cycle, while its drone rings.
    const double ref = meanMag(h.mainL, firstHit + 6000, firstHit + 24000);
    auto frac = [&](double tSec0, double tSec1) {
        return meanMag(h.mainL,
                       boundary + static_cast<std::size_t>(tSec0 * kSampleRate),
                       boundary + static_cast<std::size_t>(tSec1 * kSampleRate)) / ref;
    };

    int failures = 0;
    if (glideFrames == 0) {
        const double f = frac(0.010, 0.100);
        std::printf("  glide OFF: level ratio %.3f shortly after the boundary (expected 0.25)\n", f);
        if (std::fabs(f - 0.25) > 0.05) {
            std::printf("    FAIL: without glide the level must land at the new value in ~4 ms.\n");
            ++failures;
        }
    } else {
        const double q1 = frac(0.225, 0.275);   // t≈0.25 s → 1 − 0.75·0.25 = 0.8125
        const double q2 = frac(0.475, 0.525);   // t≈0.50 s → 0.625
        const double q3 = frac(0.725, 0.775);   // t≈0.75 s → 0.4375
        const double qE = frac(1.050, 1.200);   // landed → 0.25
        std::printf("  glide 1 s: ratios %.3f / %.3f / %.3f → %.3f "
                    "(expected 0.8125 / 0.625 / 0.4375 → 0.25)\n", q1, q2, q3, qE);
        if (std::fabs(q1 - 0.8125) > 0.08 || std::fabs(q2 - 0.625) > 0.08
            || std::fabs(q3 - 0.4375) > 0.08) {
            std::printf("    FAIL: glide trajectory is not the expected linear ramp.\n");
            ++failures;
        }
        if (!(q1 > q2 && q2 > q3 && q3 > qE)) {
            std::printf("    FAIL: glide is not monotonically falling.\n");
            ++failures;
        }
        if (std::fabs(qE - 0.25) > 0.05) {
            std::printf("    FAIL: glide did not land on the target value.\n");
            ++failures;
        }
    }
    return failures;
}

// ── (3) Clean cut ────────────────────────────────────────────────────────────────────────────
// Old scene: LEFT drone ringing across the boundary. New scene: RIGHT click at step 0, drone
// track has no steps (the drone's sample stays registered in the new world, so only the cut —
// not the missing-sample hard-stop — can silence it).
int testCut(bool cut) {
    Harness h;
    h.core.registerSample(makeDrone("drone", 220.0, 8.0));
    h.core.registerSample(makeClick("clickR"));

    auto sceneA = makeScene({ makeTrack("drone", 0.8f, -1.0f, {0}),
                              makeTrack("clickR", 1.0f, 1.0f, {}) });
    h.core.publishSequencerState(sceneA);
    h.core.start();
    h.renderFrames(5 * kFramesPerStep + 700);

    auto sceneB = makeScene({ makeTrack("drone", 0.8f, -1.0f, {}),
                              makeTrack("clickR", 1.0f, 1.0f, {0}) });
    sceneB.patternSwitchEventID = 3;
    sceneB.patternSwitchBoundaryStep = static_cast<std::int64_t>(kSteps);
    sceneB.patternSwitchPeriod = static_cast<std::uint32_t>(kSteps);
    sceneB.patternSwitchCut = cut;
    h.core.publishSequencerState(sceneB);
    h.renderFrames(2 * kCycleFrames);

    const std::size_t boundary = onsetAfter(h.mainR, 0);
    int failures = 0;
    if (boundary == SIZE_MAX) {
        std::printf("  cut %s: FAIL — new scene's boundary click missing.\n", cut ? "ON " : "OFF");
        return 1;
    }
    // 512-frame choke fade + a block of margin, then a long observation window.
    const double after = meanMag(h.mainL, boundary + 512 + 2 * kBlock, boundary + 24000);
    const double before = meanMag(h.mainL, boundary - 12000, boundary - 512);
    std::printf("  cut %s: drone level %.4f before → %.4f after the boundary\n",
                cut ? "ON " : "OFF", before, after);
    if (before < 0.05) {
        std::printf("    FAIL: the drone was not ringing before the boundary — scene invalid.\n");
        ++failures;
    }
    if (cut && after > 0.002) {
        std::printf("    FAIL: clean cut left the old scene ringing (%.4f > 0.002).\n", after);
        ++failures;
    }
    if (!cut && after < 0.05) {
        std::printf("    FAIL: without cut the old scene must ring out (%.4f).\n", after);
        ++failures;
    }
    return failures;
}

// ── (4) Pattern anchor: mixed-length scheduled switches ──────────────────────────────────────
// The boundary is the OUTGOING scene's own LCM cycle (musical space); the anchor move at the
// crossing starts the incoming scene at ITS step 0 whatever its length. 16→24: the switch lands
// after exactly one 16-step cycle, the 24-pattern reads its own indices (a step-20 hit — a %16
// alias would fire it at step 4), and the published playhead WRAPS to 0 at the crossing.
// Then 24→16 back: the next boundary is a multiple of 24 in the NEW musical space, computed from
// deckPlayheadStep exactly as Swift does.
int testMixedLengthAnchor() {
    Harness h;
    h.core.registerSample(makeClick("clickL"));
    h.core.registerSample(makeClick("clickR"));

    auto sceneA = makeScene({ makeTrack("clickL", 1.0f, -1.0f, {0}, 16),
                              makeTrack("clickR", 1.0f,  1.0f, {},  16) });
    h.core.publishSequencerState(sceneA);
    h.core.start();
    h.renderFrames(5 * kFramesPerStep + 700);

    // Scene B: 24-step right track with hits at 0, 4 and 20. Boundary = end of A's OWN cycle.
    auto sceneB = makeScene({ makeTrack("clickL", 1.0f, -1.0f, {},          16),
                              makeTrack("clickR", 1.0f,  1.0f, {0, 4, 20},  24) });
    sceneB.patternSwitchEventID = 4;
    sceneB.patternSwitchBoundaryStep = 16;   // musical: one full 16-cycle of the OUTGOING scene
    sceneB.patternSwitchPeriod = 16;
    h.core.publishSequencerState(sceneB);

    // Render through the boundary + one full 24-cycle AND its next downbeat (the +24 assertion
    // below needs boundary+24 steps = publish offset + 40 steps), watching for the playhead wrap.
    bool sawWrap = false;
    std::uint64_t prevPlayhead = h.core.deckPlayheadStep(0);
    for (std::uint64_t rendered = 0; rendered < 40 * kFramesPerStep; rendered += kBlock) {
        h.renderFrames(kBlock);
        const std::uint64_t p = h.core.deckPlayheadStep(0);
        if (p < prevPlayhead) sawWrap = true;
        prevPlayhead = p;
    }

    int failures = 0;
    const std::size_t lastLeft = [&] {
        std::size_t last = SIZE_MAX, cur = onsetAfter(h.mainL, 0);
        while (cur != SIZE_MAX) { last = cur; cur = onsetAfter(h.mainL, cur + 4000); }
        return last;
    }();
    const std::size_t firstRight = onsetAfter(h.mainR, 0);
    if (lastLeft == SIZE_MAX || firstRight == SIZE_MAX) {
        std::printf("  16->24: FAIL - clicks missing (left=%zu right=%zu)\n", lastLeft, firstRight);
        return 1;
    }
    const long long gap = static_cast<long long>(firstRight) - static_cast<long long>(lastLeft);
    std::printf("  16->24: boundary gap %lld (expected %llu); playhead wrap %s\n",
                gap, static_cast<unsigned long long>(kCycleFrames), sawWrap ? "seen" : "MISSING");
    if (gap != static_cast<long long>(kCycleFrames)) {
        std::printf("    FAIL: the switch did not land after exactly one 16-cycle of the OLD scene.\n");
        ++failures;
    }
    if (!sawWrap) {
        std::printf("    FAIL: published playhead never wrapped to 0 (anchor did not move).\n");
        ++failures;
    }
    // The 24-pattern reads its OWN indices: hits at +4 and +20 steps, NOTHING at +16 (a %16
    // alias would repeat step 0 there), and its own next downbeat at +24.
    struct Expect { std::uint64_t stepOff; bool present; };
    for (const Expect e : { Expect{4, true}, Expect{16, false}, Expect{20, true}, Expect{24, true} }) {
        const std::size_t expect = firstRight + static_cast<std::size_t>(e.stepOff * kFramesPerStep);
        const std::size_t got = onsetAfter(h.mainR, expect - 64);
        const bool hitThere = (got == expect);
        if (e.present && !hitThere) {
            std::printf("    FAIL: expected a hit at +%llu steps (frame %zu), first onset from there: %zu\n",
                        static_cast<unsigned long long>(e.stepOff), expect, got);
            ++failures;
        }
        if (!e.present && hitThere) {
            std::printf("    FAIL: unexpected hit at +%llu steps — the 24-pattern aliased %%16.\n",
                        static_cast<unsigned long long>(e.stepOff));
            ++failures;
        }
    }

    // ── back 24→16: boundary = next multiple of 24 in the NEW musical space, from the
    // published playhead exactly as Swift computes it.
    const std::uint64_t nowStep = h.core.deckPlayheadStep(0);
    const std::int64_t backBoundary = static_cast<std::int64_t>(((nowStep / 24) + 1) * 24);
    auto sceneC = makeScene({ makeTrack("clickL", 1.0f, -1.0f, {0}, 16),
                              makeTrack("clickR", 1.0f,  1.0f, {},  24) });
    sceneC.patternSwitchEventID = 5;
    sceneC.patternSwitchBoundaryStep = backBoundary;
    sceneC.patternSwitchPeriod = 24;
    const std::size_t framesBeforeBack = h.mainL.size();
    h.core.publishSequencerState(sceneC);
    h.renderFrames(30 * kFramesPerStep);

    // Scene C's first left downbeat = the 24-boundary: an exact multiple of 24 steps after the
    // FIRST switch's crossing (which was firstRight, B's step 0).
    const std::size_t firstLeftBack = onsetAfter(h.mainL, framesBeforeBack);
    if (firstLeftBack == SIZE_MAX) {
        std::printf("    FAIL: scene C's downbeat never arrived after the 24->16 switch.\n");
        return failures + 1;
    }
    const long long backGap = static_cast<long long>(firstLeftBack) - static_cast<long long>(firstRight);
    std::printf("  24->16: crossing-to-crossing gap %lld (must be a multiple of %llu)\n",
                backGap, static_cast<unsigned long long>(24 * kFramesPerStep));
    if (backGap <= 0 || backGap % static_cast<long long>(24 * kFramesPerStep) != 0) {
        std::printf("    FAIL: the return switch did not land on a 24-cycle boundary of scene B.\n");
        ++failures;
    }
    return failures;
}

// ── (5) Run-immediate (seamless) across mixed lengths preserves the musical position ─────────
// A 16-step scene runs to musical step 10 (+700 frames); a seamless tag installs a 24-step
// scene with a hit at step 11. The anchor is untouched, so that hit must fire at EXACTLY
// musical step 11 = absolute frame 11·6000 (+ the deterministic onset shift, measured from the
// scene's own step-0 click).
int testRunImmediateMixed() {
    Harness h;
    h.core.registerSample(makeClick("clickL"));
    h.core.registerSample(makeClick("clickR"));

    auto sceneA = makeScene({ makeTrack("clickL", 1.0f, -1.0f, {0}, 16),
                              makeTrack("clickR", 1.0f,  1.0f, {},  16) });
    h.core.publishSequencerState(sceneA);
    h.core.start();
    h.renderFrames(10 * kFramesPerStep + 700);   // musical ≈ 10 + 700 frames

    auto sceneB = makeScene({ makeTrack("clickL", 1.0f, -1.0f, {},   16),
                              makeTrack("clickR", 1.0f,  1.0f, {11}, 24) });
    sceneB.patternSwitchEventID = 6;
    sceneB.patternSwitchBoundaryStep = -1;   // seamless-run: install now, keep the phase
    h.core.publishSequencerState(sceneB);
    h.renderFrames(4 * kFramesPerStep);

    const std::size_t onsetShift = onsetAfter(h.mainL, 0);          // step-0 click @ frame 0 + shift
    const std::size_t firstRight = onsetAfter(h.mainR, 0);
    int failures = 0;
    if (onsetShift == SIZE_MAX || firstRight == SIZE_MAX) {
        std::printf("  run-immediate: FAIL - clicks missing\n");
        return 1;
    }
    const std::size_t expect = 11 * kFramesPerStep + onsetShift;
    std::printf("  run-immediate 16->24: step-11 hit @%zu (expected %zu)\n", firstRight, expect);
    if (firstRight != expect) {
        std::printf("    FAIL: seamless switch did not preserve the musical position.\n");
        ++failures;
    }
    return failures;
}

// ── (6) Seek + restart are anchor moves ──────────────────────────────────────────────────────
int testSeekAndRestart() {
    Harness h;
    h.core.registerSample(makeClick("clickL"));
    auto scene = makeScene({ makeTrack("clickL", 1.0f, -1.0f, {0, 3}, 16) });
    h.core.publishSequencerState(scene);
    h.core.start();
    h.renderFrames(2 * kFramesPerStep + 50);

    int failures = 0;
    // Seek to musical step 3: the step-3 hit fires at the next block top and the playhead reads 3.
    const std::size_t beforeSeek = h.mainL.size();
    h.core.requestSeek(0, 3);
    h.renderFrames(2 * kBlock);
    const std::size_t seekOnset = onsetAfter(h.mainL, beforeSeek);
    const std::uint64_t seekStep = h.core.deckPlayheadStep(0);
    std::printf("  seek(3): onset %+lld frames after the request; playhead %llu\n",
                seekOnset == SIZE_MAX ? -1LL
                                      : static_cast<long long>(seekOnset - beforeSeek),
                static_cast<unsigned long long>(seekStep));
    if (seekOnset == SIZE_MAX || seekOnset - beforeSeek > 2 * kBlock) {
        std::printf("    FAIL: the step-3 hit did not fire right after the seek.\n");
        ++failures;
    }
    if (seekStep != 3) {
        std::printf("    FAIL: playhead should read 3 right after the seek.\n");
        ++failures;
    }

    // Restart (boundary-0 park + seek(0), the restart-immediate wire shape): step 0 refires,
    // playhead reads ~0.
    h.renderFrames(4 * kFramesPerStep);
    auto restart = scene;
    restart.patternSwitchEventID = 7;
    restart.patternSwitchBoundaryStep = 0;
    restart.patternSwitchPeriod = 0;
    const std::size_t beforeRestart = h.mainL.size();
    h.core.publishSequencerState(restart);
    h.core.requestSeek(0, 0);
    h.renderFrames(2 * kBlock);
    const std::size_t restartOnset = onsetAfter(h.mainL, beforeRestart);
    const std::uint64_t restartStep = h.core.deckPlayheadStep(0);
    std::printf("  restart: onset %+lld frames after the request; playhead %llu\n",
                restartOnset == SIZE_MAX ? -1LL
                                         : static_cast<long long>(restartOnset - beforeRestart),
                static_cast<unsigned long long>(restartStep));
    if (restartOnset == SIZE_MAX || restartOnset - beforeRestart > 2 * kBlock) {
        std::printf("    FAIL: the downbeat did not refire right after the restart.\n");
        ++failures;
    }
    if (restartStep > 1) {
        std::printf("    FAIL: playhead should be back at ~0 right after the restart.\n");
        ++failures;
    }
    return failures;
}

// ── (7) Clean cut across a MIXED-LENGTH boundary (guards the rider rebase at the anchor move:
// without it the cut, armed in the OLD musical space, would silently never fire) ─────────────
int testCutMixedLength() {
    Harness h;
    h.core.registerSample(makeDrone("drone", 220.0, 8.0));
    h.core.registerSample(makeClick("clickR"));

    auto sceneA = makeScene({ makeTrack("drone", 0.8f, -1.0f, {0}, 16),
                              makeTrack("clickR", 1.0f, 1.0f, {},  16) });
    h.core.publishSequencerState(sceneA);
    h.core.start();
    h.renderFrames(5 * kFramesPerStep + 700);

    auto sceneB = makeScene({ makeTrack("drone", 0.8f, -1.0f, {},  16),
                              makeTrack("clickR", 1.0f, 1.0f, {0}, 24) });
    sceneB.patternSwitchEventID = 8;
    sceneB.patternSwitchBoundaryStep = 16;
    sceneB.patternSwitchPeriod = 16;
    sceneB.patternSwitchCut = true;
    h.core.publishSequencerState(sceneB);
    h.renderFrames(2 * kCycleFrames);

    const std::size_t boundary = onsetAfter(h.mainR, 0);
    int failures = 0;
    if (boundary == SIZE_MAX) {
        std::printf("  cut 16->24: FAIL - boundary click missing.\n");
        return 1;
    }
    const double before = meanMag(h.mainL, boundary - 12000, boundary - 512);
    const double after = meanMag(h.mainL, boundary + 512 + 2 * kBlock, boundary + 24000);
    std::printf("  cut 16->24: drone %.4f before -> %.4f after the boundary\n", before, after);
    if (before < 0.05) {
        std::printf("    FAIL: the drone was not ringing before the boundary.\n");
        ++failures;
    }
    if (after > 0.002) {
        std::printf("    FAIL: the cut did not fire across the mixed-length anchor move.\n");
        ++failures;
    }
    return failures;
}

}  // namespace

int main() {
    std::printf("Scene-switch timing gate @ 48 kHz, 128-frame blocks, 120 BPM "
                "(6000 frames/step — never block-aligned).\n\n");

    int failures = 0;
    std::printf("(1) sample-exact boundary install\n");
    failures += testBoundaryExactness(/*lateArm=*/false);
    failures += testBoundaryExactness(/*lateArm=*/true);
    if (gBoundaryFrameOffset >= 0)
        std::printf("  (new downbeat landed %d frames into its render block — a block-quantized "
                    "install could only produce 0)\n", gBoundaryFrameOffset);

    std::printf("\n(2) scene glide\n");
    failures += testGlide(/*glideFrames=*/48'000);
    failures += testGlide(/*glideFrames=*/0);

    std::printf("\n(3) clean cut\n");
    failures += testCut(/*cut=*/true);
    failures += testCut(/*cut=*/false);

    std::printf("\n(4) pattern anchor: mixed-length scheduled switches\n");
    failures += testMixedLengthAnchor();

    std::printf("\n(5) run-immediate across mixed lengths\n");
    failures += testRunImmediateMixed();

    std::printf("\n(6) seek + restart as anchor moves\n");
    failures += testSeekAndRestart();

    std::printf("\n(7) clean cut across a mixed-length boundary\n");
    failures += testCutMixedLength();

    if (failures) {
        std::printf("\nFAIL: %d scene-switch assertion(s) failed.\n", failures);
        return 1;
    }
    std::printf("\n  PASS: boundary is sample-exact (no re-anchor, no double downbeat), the glide "
                "ramps linearly and lands, and the cut fades the old scene under the new "
                "downbeat.\n\n");
    return 0;
}
