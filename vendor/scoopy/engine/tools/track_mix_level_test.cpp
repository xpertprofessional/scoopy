// ─────────────────────────────────────────────────────────────────────────────────────────────
// TRACK-MIX-LEVEL (SIG-3) GATE. Proves the per-track activity meter behind the track-row LED:
//
//   (1) RISE. While a track's voice sounds, deckTrackMixLevel(0, t) reads a healthy level, and
//       a silent neighbour track stays at 0.
//   (2) MUTE READS DARK. A mixMuted track's level dies with the mute-gain ramp — the meter
//       reports what reaches the MIX, not what the voice renders ("who is making the sound I
//       hear", so a muted-but-ringing track goes dark).
//   (3) DECAY TO ZERO. After the audio ends the level decays to < 0.001 within ~400 ms (the
//       -200 dB/s release) and all the way to a hard 0 (subnormal flush) — never freezing at
//       its last value, which is what an idle deck's LED would otherwise do.
//
// Like the mute-immediacy gate this drives the REALTIME render() path block-by-block.
//
//   ./scoopy_track_mix_level_test
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
// 120 BPM → 6000 frames per step — deliberately NOT a multiple of the block.
constexpr std::uint64_t kFramesPerStep = 6000;
constexpr std::size_t kSteps = 16;

// A sine drone that rings for `seconds` from one hit at step 0.
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

NativeTrackSnapshot makeTrack(const std::string& sampleId, bool hit, float pan = 0.0f) {
    NativeTrackSnapshot tk;
    tk.sampleId = sampleId;
    tk.steps.assign(kSteps, 0);
    if (hit) tk.steps[0] = 1;
    tk.pitchOffsets.assign(kSteps, 0.0);
    tk.volume = 1.0f;
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

// Block-by-block realtime harness.
struct Harness {
    // Heap, not stack: the core is 1.05 MB and Windows gives a thread 1 MB by default, so a
    // harness holding one by value dies with STATUS_STACK_OVERFLOW before main does anything
    // (0xC00000FD, engine-matrix run 29940659486). macOS/Linux give 8 MB, which is why this only
    // ever showed up on Windows — and showed up as a SILENT crash under Git Bash.
    std::unique_ptr<NativeAudioEngineCore> corePtr = std::make_unique<NativeAudioEngineCore>();
    NativeAudioEngineCore& core = *corePtr;
    std::array<std::vector<float>, NativeAudioEngineCore::laneCount> lanes;
    std::uint64_t rendered = 0;

    Harness() {
        core.configure(kSampleRate, kBlock, 0);
        for (auto& l : lanes) l.assign(kBlock, 0.0f);
    }

    void renderFrames(std::uint64_t frames) {
        std::array<float*, NativeAudioEngineCore::laneCount> out {};
        for (std::size_t i = 0; i < lanes.size(); ++i) out[i] = lanes[i].data();
        for (std::uint64_t done = 0; done < frames; done += kBlock) {
            core.render(nullptr, nullptr, out, kBlock);
            rendered += kBlock;
        }
    }
};

// Install (1 block) + the ~4 ms mute-gain ramp + the -200 dB/s meter release: 400 ms of render
// is -80 dB — comfortably below the LED's visibility floor (kDark). The hard-0 subnormal flush
// sits at 1e-9, which from a ~0.42 peak takes ~0.87 s at -200 dB/s; 1.2 s covers it with margin.
constexpr std::uint64_t kDecayFrames = static_cast<std::uint64_t>(kSampleRate * 0.4);
constexpr std::uint64_t kFlushFrames = static_cast<std::uint64_t>(kSampleRate * 1.2);
constexpr float kLoud = 0.05f;
constexpr float kDark = 0.001f;

// ── (1) Rise while sounding; silent neighbour stays 0 ────────────────────────────────────────
int testRiseAndSilentNeighbour() {
    Harness h;
    h.core.registerSample(makeDrone("drone", 220.0, 3.0));
    h.core.publishSequencerState(makeScene({ makeTrack("drone", true), makeTrack("drone", false) }));
    h.core.start();

    h.renderFrames(2 * kFramesPerStep + 700);   // ring into step 2, mid-cell
    const float sounding = h.core.deckTrackMixLevel(0, 0);
    const float silent = h.core.deckTrackMixLevel(0, 1);

    int failures = 0;
    std::printf("  sounding %.4f, silent neighbour %.6f\n", sounding, silent);
    if (sounding < kLoud) { std::printf("    FAIL: sounding track's level did not rise (%.6f).\n", sounding); ++failures; }
    if (silent != 0.0f)   { std::printf("    FAIL: silent track reads a level (%.6f).\n", silent); ++failures; }
    return failures;
}

// ── (2) mixMuted reads dark while the voice keeps rendering ──────────────────────────────────
int testMuteReadsDark() {
    Harness h;
    h.core.registerSample(makeDrone("drone", 220.0, 3.0));
    h.core.publishSequencerState(makeScene({ makeTrack("drone", true) }));
    h.core.start();

    h.renderFrames(2 * kFramesPerStep + 700);
    const float preMute = h.core.deckTrackMixLevel(0, 0);

    auto muted = makeScene({ makeTrack("drone", true) });
    muted.tracks[0].mixMuted = true;
    h.core.publishSequencerState(muted);
    h.renderFrames(kDecayFrames);               // still far inside the 3 s drone's ring
    const float postMute = h.core.deckTrackMixLevel(0, 0);

    int failures = 0;
    std::printf("  ring %.4f → muted %.6f\n", preMute, postMute);
    if (preMute < kLoud)    { std::printf("    FAIL: drone not metering before the mute.\n"); ++failures; }
    if (postMute >= kDark)  { std::printf("    FAIL: muted track still meters (%.6f) — the LED must read the MIX.\n", postMute); ++failures; }
    return failures;
}

// ── (3) Decay to a hard zero after the audio ends ────────────────────────────────────────────
int testDecayToZero() {
    Harness h;
    h.core.registerSample(makeDrone("drone", 220.0, 0.25));    // ends inside step 2
    h.core.publishSequencerState(makeScene({ makeTrack("drone", true) }));
    h.core.start();

    h.renderFrames(kFramesPerStep);             // mid-ring
    const float ringing = h.core.deckTrackMixLevel(0, 0);

    h.renderFrames(kFramesPerStep + kFlushFrames);  // past the sample's end + a full flush
    const float afterEnd = h.core.deckTrackMixLevel(0, 0);

    int failures = 0;
    std::printf("  ringing %.4f → after end %.9f\n", ringing, afterEnd);
    if (ringing < kLoud)   { std::printf("    FAIL: drone not metering while ringing.\n"); ++failures; }
    if (afterEnd != 0.0f)  { std::printf("    FAIL: level never flushed to 0 (%.9f) — a stale LED glow.\n", afterEnd); ++failures; }
    return failures;
}

// ── (4) Hard-panned track reads its TRUE channel peak, not the halved mono fold ──────────────
// A hard-left 0.6 sine puts full energy on L and ~0 on R. max(|L|,|R|) must report the L peak
// (~0.6), NOT the (L+R)/2 mono fold (~0.3) an earlier build used — which would under-flag the
// clip by ~6 dB exactly when a panned track is the hot one.
int testPannedReadsTruePeak() {
    Harness h;
    h.core.registerSample(makeDrone("drone", 220.0, 3.0));
    h.core.publishSequencerState(makeScene({ makeTrack("drone", true, -1.0f) }));  // hard left
    h.core.start();

    h.renderFrames(2 * kFramesPerStep + 700);
    const float level = h.core.deckTrackMixLevel(0, 0);

    int failures = 0;
    std::printf("  hard-panned peak %.4f (mono fold would read ~%.4f)\n", level, level * 0.5f);
    // Well above the ~0.3 a mono fold would give; a full-energy L channel of a 0.6 sine.
    if (level < 0.5f) { std::printf("    FAIL: panned track under-read — meter still mono-folds (%.4f).\n", level); ++failures; }
    return failures;
}

} // namespace

int main() {
    int failures = 0;
    std::printf("rise + silent neighbour:\n");
    failures += testRiseAndSilentNeighbour();
    std::printf("mute reads dark:\n");
    failures += testMuteReadsDark();
    std::printf("decay to zero:\n");
    failures += testDecayToZero();
    std::printf("panned reads true peak:\n");
    failures += testPannedReadsTruePeak();
    if (failures == 0) {
        std::printf("PASS — the LED lights for sound, and only for sound.\n");
        return 0;
    }
    std::printf("FAIL — %d assertion(s).\n", failures);
    return 1;
}
