// ─────────────────────────────────────────────────────────────────────────────────────────────
// MUTE-IMMEDIACY GATE. Proves the mixer-true mute split (mixMuted vs muted):
//
//   (1) IMMEDIATE KILL. Republishing mixMuted=true mid-ring drops a RINGING voice by ≥40 dB
//       within a few blocks (install + the ~4 ms mute-gain ramp) — not at the sample's natural
//       end. (A slow DC-blocker settling tail is why the residual is a ratio, not exact zero.)
//   (2) INSTANT UNMUTE. The voice keeps rendering at zero gain while muted, so clearing
//       mixMuted mid-cell brings the audio back immediately — no wait for the next trigger.
//   (3) PRE-FADER SEND DIES. The mute gain rides `fade`, which the pre-fader send tap does NOT
//       divide back out — so a muted track stops feeding even a pre-fader send bus. Observed on
//       the send-3 lane (return 3 routed external, so the raw pre-fader feed reaches the lane).
//   (4) TRIGGER GATE UNTOUCHED. `muted` (the stop/pause lane) still only suppresses future
//       triggers: a ringing tail survives it (quantized-stop regression guard) and the next
//       cycle's hit stays silent.
//
// Like the scene-switch gate this drives the REALTIME render() path block-by-block (configure →
// registerSample → publishSequencerState → start → render), reading the main and send buses.
//
//   ./scoopy_mute_immediacy_test
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

// A long sine drone (rings for `seconds` from one hit at step 0).
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

NativeTrackSnapshot makeTrack(const std::string& sampleId) {
    NativeTrackSnapshot tk;
    tk.sampleId = sampleId;
    tk.steps.assign(kSteps, 0);
    tk.steps[0] = 1;
    tk.pitchOffsets.assign(kSteps, 0.0);
    tk.volume = 1.0f;
    tk.pan = 0.0f;
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

// Block-by-block realtime harness accumulating the main bus and send bus 3.
struct Harness {
    // Heap, not stack: the core is 1.05 MB and Windows gives a thread 1 MB by default, so a
    // harness holding one by value dies with STATUS_STACK_OVERFLOW before main does anything
    // (0xC00000FD, engine-matrix run 29940659486). macOS/Linux give 8 MB, which is why this only
    // ever showed up on Windows — and showed up as a SILENT crash under Git Bash.
    std::unique_ptr<NativeAudioEngineCore> corePtr = std::make_unique<NativeAudioEngineCore>();
    NativeAudioEngineCore& core = *corePtr;
    std::vector<float> mainL, send3;
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
            const auto& S = lanes[static_cast<std::size_t>(AudioLane::send3)];
            mainL.insert(mainL.end(), L.begin(), L.end());
            send3.insert(send3.end(), S.begin(), S.end());
        }
    }
};

// Mean |x| over [from, to).
double meanMag(const std::vector<float>& x, std::size_t from, std::size_t to) {
    to = std::min(to, x.size());
    if (from >= to) return 0.0;
    double acc = 0.0;
    for (std::size_t i = from; i < to; ++i) acc += std::fabs(static_cast<double>(x[i]));
    return acc / static_cast<double>(to - from);
}

// Install (1 block) + the 4 ms mute-gain ramp (192 frames @48k) — 6 blocks is comfortably past
// both while still far below a step (6000 frames), so a drop here can only be the GAIN moving,
// never the trigger gate.
constexpr std::size_t kSettleFrames = 6 * kBlock;
constexpr std::size_t kWindow = 4 * kBlock;
constexpr double kLoud = 0.05;      // a center-panned 0.6 sine reads ~0.27 mean |x|
constexpr double kKillRatio = 0.01; // ≥ 40 dB down = a decisive kill (DC-blocker tail forbids 0)

// ── (1)+(2) Immediate kill, instant unmute ───────────────────────────────────────────────────
int testMuteKillAndInstantUnmute() {
    Harness h;
    h.core.registerSample(makeDrone("drone", 220.0, 3.0));
    h.core.publishSequencerState(makeScene({ makeTrack("drone") }));
    h.core.start();

    // Ring into step 2 (mid-cell, not block-aligned), well inside the 3 s drone.
    h.renderFrames(2 * kFramesPerStep + 700);
    const std::size_t muteAt = h.mainL.size();
    const double preMute = meanMag(h.mainL, muteAt - kBlock, muteAt);

    auto muted = makeScene({ makeTrack("drone") });
    muted.tracks[0].mixMuted = true;
    h.core.publishSequencerState(muted);
    h.renderFrames(4 * kFramesPerStep);         // stay inside the drone's ring
    const double postMute = meanMag(h.mainL, muteAt + kSettleFrames, muteAt + kSettleFrames + kWindow);

    const std::size_t unmuteAt = h.mainL.size();
    h.core.publishSequencerState(makeScene({ makeTrack("drone") }));
    h.renderFrames(2 * kFramesPerStep);
    // Next trigger is a full cycle away (step 16) — sound here can only be the SAME voice,
    // revealed mid-cell by the gain ramp: the mixer-true contract.
    const double postUnmute = meanMag(h.mainL, unmuteAt + kSettleFrames, unmuteAt + kSettleFrames + kWindow);

    int failures = 0;
    std::printf("  ring %.4f → muted %.6f (%.1f dB) → unmuted %.4f\n",
                preMute, postMute, 20.0 * std::log10(std::max(postMute, 1e-9) / preMute), postUnmute);
    if (preMute < kLoud)                 { std::printf("    FAIL: drone not ringing before the mute.\n"); ++failures; }
    if (postMute > preMute * kKillRatio) { std::printf("    FAIL: mute did not kill the ringing voice (%.6f).\n", postMute); ++failures; }
    if (postUnmute < kLoud)              { std::printf("    FAIL: unmute did not restore mid-cell (%.6f).\n", postUnmute); ++failures; }
    return failures;
}

// ── (3) Pre-fader send feed dies on mute ─────────────────────────────────────────────────────
// Return 3 routed EXTERNAL surfaces the raw pre-fader send feed on the send-3 lane (unity lane
// gain by default), where host-mode returns would have zeroed it.
int testPreFaderSendDies() {
    Harness h;
    h.core.registerSample(makeDrone("drone", 220.0, 3.0));
    h.core.setReturnMode(3, 1);                 // external → the send-3 lane carries the raw feed
    h.core.setSendPostFader(3, false);          // the hard case: the tap that divides the fader out
    auto scene = makeScene({ makeTrack("drone") });
    scene.tracks[0].send3Level = 1.0f;
    h.core.publishSequencerState(scene);
    h.core.start();

    h.renderFrames(2 * kFramesPerStep + 700);
    const std::size_t muteAt = h.send3.size();
    const double preMute = meanMag(h.send3, muteAt - kBlock, muteAt);

    auto muted = scene;
    muted.tracks[0].mixMuted = true;
    h.core.publishSequencerState(muted);
    h.renderFrames(4 * kFramesPerStep);
    const double postMute = meanMag(h.send3, muteAt + kSettleFrames, muteAt + kSettleFrames + kWindow);

    int failures = 0;
    std::printf("  pre-fader send %.4f → muted %.6f\n", preMute, postMute);
    if (preMute < kLoud)                 { std::printf("    FAIL: send bus not fed before the mute.\n"); ++failures; }
    if (postMute > preMute * kKillRatio) { std::printf("    FAIL: muted track still feeds the pre-fader send (%.6f).\n", postMute); ++failures; }
    return failures;
}

// ── (4) Trigger gate untouched: `muted` lets the tail ring, suppresses the next hit ──────────
int testTriggerGateStaysQuantized() {
    Harness h;
    h.core.registerSample(makeDrone("drone", 220.0, 2.5));
    h.core.publishSequencerState(makeScene({ makeTrack("drone") }));
    h.core.start();

    h.renderFrames(2 * kFramesPerStep + 700);
    const std::size_t muteAt = h.mainL.size();

    auto gated = makeScene({ makeTrack("drone") });
    gated.tracks[0].muted = true;               // the stop/pause lane — NOT mixMuted
    h.core.publishSequencerState(gated);

    // Through the rest of the cycle (suppressed step-16 hit) and past the drone's natural end.
    h.renderFrames(20 * kFramesPerStep);
    const double tail = meanMag(h.mainL, muteAt + kSettleFrames, muteAt + kSettleFrames + kWindow);
    // Drone rings 2.5 s = 120000 frames from its step-0 trigger; the suppressed step-16 hit
    // would land at 96000 and ring long past 126000 — silence there proves it never fired.
    const std::size_t droneEnd = 126'000;
    const double afterEnd = meanMag(h.mainL, droneEnd, droneEnd + 8 * kBlock);

    int failures = 0;
    std::printf("  tail after trigger-gate mute %.4f, after natural end %.6f\n", tail, afterEnd);
    if (tail < kLoud)      { std::printf("    FAIL: trigger-gate mute killed a ringing tail — stop is no longer quantized.\n"); ++failures; }
    if (afterEnd > 1.0e-3) { std::printf("    FAIL: gated track re-triggered (%.6f after the drone's end).\n", afterEnd); ++failures; }
    return failures;
}

} // namespace

int main() {
    int failures = 0;
    std::printf("mute-kill + instant unmute:\n");
    failures += testMuteKillAndInstantUnmute();
    std::printf("pre-fader send:\n");
    failures += testPreFaderSendDies();
    std::printf("trigger gate (quantized stop):\n");
    failures += testTriggerGateStaysQuantized();
    if (failures == 0) {
        std::printf("PASS — mute kills the audio, play kills the playback.\n");
        return 0;
    }
    std::printf("FAIL — %d assertion(s).\n", failures);
    return 1;
}
