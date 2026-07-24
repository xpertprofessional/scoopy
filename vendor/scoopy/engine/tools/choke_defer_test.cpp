// ─────────────────────────────────────────────────────────────────────────────────────────────
// CHOKE DEFERRAL GATE. Proves the onset-aware cross-track choke: a trigger's choke of the ringing
// group is deferred until the incoming voice actually reaches audible material, so a sample with a
// silent head does not cut the group early.
//
// WHY A SEPARATE TOOL. The null / headroom / clipper gates never exercise choke at all — they
// render single hits or a hot sum. Choke is a voice-scheduling behaviour, invisible to a spectral
// or level measurement of one voice. This tool drives the real core's sequencer with TWO tracks in
// one choke group and reads the SUM, using the fact that during the incoming sample's leading
// silence only the OTHER track contributes — so the group's ring is directly observable.
//
// THE SCENE. Track 0 is a loud sustained drone (choke group 1, hit at step 0, rings for seconds).
// Track 1 is quiet and shares the group, hit at step 2; its sample optionally begins with N frames
// of silence. The window between track 1's trigger and its onset is a pure view of track 0:
//   • deferred choke  → track 0 still rings through that window (LOUD).
//   • immediate choke → track 0 was cut the instant track 1 triggered (SILENT after its fade).
//
//   ./scoopy_choke_defer_test
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

constexpr double kSampleRate = 48'000.0;

// A sine with `silenceFrames` of leading silence, then `bodyAmp` sine for the remainder.
NativeSample makeSample(const std::string& id, float bodyAmp, double freq,
                        std::size_t silenceFrames, double seconds) {
    NativeSample s;
    s.id = id;
    s.sampleRate = kSampleRate;
    const std::size_t n = static_cast<std::size_t>(kSampleRate * seconds);
    s.left.assign(n, 0.0f);
    s.right.assign(n, 0.0f);
    for (std::size_t i = silenceFrames; i < n; ++i) {
        const double t = static_cast<double>(i - silenceFrames) / kSampleRate;
        const float v = static_cast<float>(bodyAmp * std::sin(2.0 * M_PI * freq * t));
        s.left[i] = v;
        s.right[i] = v;
    }
    return s;
}

NativeTrackSnapshot makeTrack(const std::string& sampleId, float volume,
                              std::uint8_t chokeGroup, int hitStep) {
    NativeTrackSnapshot tk;
    tk.sampleId = sampleId;
    tk.steps.assign(16, 0);
    tk.steps[hitStep] = 1;
    tk.pitchOffsets.assign(16, 0.0);
    tk.volume = volume;
    tk.pan = 0.0f;
    tk.stereoMode = StereoMode::stereo;
    tk.chokeGroup = chokeGroup;
    tk.polyphonic = true;   // isolate cross-track choke from mono self-cut
    return tk;
}

NativeSequencerSnapshot makeScene(std::uint8_t group, std::size_t silenceFrames) {
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
    // Track 0: loud drone, whole test. Track 1: quiet, shares the group, silent head.
    snap.tracks.push_back(makeTrack("drone", 0.8f, group, /*hitStep=*/0));
    snap.tracks.push_back(makeTrack("chopSilent", 0.25f, group, /*hitStep=*/2));
    return snap;
}

// Mean |left| over [from, to).
double meanMag(const OfflineRenderResult& out, std::size_t from, std::size_t to) {
    to = std::min(to, out.left.size());
    if (from >= to) return 0.0;
    double acc = 0.0;
    for (std::size_t i = from; i < to; ++i) acc += std::fabs(static_cast<double>(out.left[i]));
    return acc / static_cast<double>(to - from);
}

std::uint64_t triggerFrame(const OfflineRenderResult& out, std::uint32_t trackIndex) {
    for (const auto& e : out.triggerEvents) {
        if (e.trackIndex == trackIndex) return e.frame;
    }
    return 0;
}

struct Windows { double preOnset; double postOnset; std::uint64_t tf; };

// Render the two-track group scene and read track 0's ring before and after track 1's onset.
Windows probe(std::uint8_t group, std::size_t silenceFrames) {
    // Heap, not stack: the core is 1.05 MB and Windows gives a thread 1 MB by default, so a
    // harness holding one by value dies with STATUS_STACK_OVERFLOW before main does anything
    // (0xC00000FD, engine-matrix run 29940659486). macOS/Linux give 8 MB, which is why this only
    // ever showed up on Windows — and showed up as a SILENT crash under Git Bash.
    std::unique_ptr<NativeAudioEngineCore> corePtr = std::make_unique<NativeAudioEngineCore>();
    NativeAudioEngineCore& core = *corePtr;
    core.configure(kSampleRate, 128, 0);
    core.registerSample(makeSample("drone", 0.6f, 220.0, /*silence=*/0, /*sec=*/3.0));
    core.registerSample(makeSample("chopSilent", 0.6f, 330.0, silenceFrames, /*sec=*/3.0));

    const auto out = core.renderOffline(makeScene(group, silenceFrames),
                                        static_cast<std::uint64_t>(kSampleRate * 1.0), 128);
    const std::uint64_t tf = triggerFrame(out, 1);
    // Leave a margin past the ~512-frame choke fade at each edge.
    const std::size_t preFrom = tf + 700;
    const std::size_t preTo   = tf + (silenceFrames > 1400 ? silenceFrames - 700 : silenceFrames);
    const std::size_t postFrom = tf + silenceFrames + 1200;
    const std::size_t postTo   = tf + silenceFrames + 5000;
    return { meanMag(out, preFrom, preTo), meanMag(out, postFrom, postTo), tf };
}

}  // namespace

int main() {
    std::printf("Onset-aware choke @ 48 kHz — track 0 drone + track 1 (silent-head) share group 1.\n");
    std::printf("Reading track 0's ring in the window between track 1's trigger and its onset.\n\n");

    int failures = 0;

    // (1) DEFERRED: track 1 has ~125 ms of leading silence. Track 0 must still ring through it.
    {
        const std::size_t silence = static_cast<std::size_t>(kSampleRate * 0.125);
        const Windows w = probe(/*group=*/1, silence);
        std::printf("  deferred (125ms silent head): tf=%llu  pre-onset=%.4f  post-onset=%.4f\n",
                    static_cast<unsigned long long>(w.tf), w.preOnset, w.postOnset);
        if (w.preOnset < 0.05) {
            std::printf("    FAIL: track 0 was cut during track 1's silence — choke did not defer.\n");
            ++failures;
        }
        if (w.postOnset < 0.01) {
            std::printf("    FAIL: nothing sounds after the onset — track 1 never took over.\n");
            ++failures;
        }
    }

    // (2) REGRESSION — onset at frame 0: choke must fire immediately, exactly as before. With no
    // silence, sample the same relative window; track 0 must already be gone (only quiet track 1).
    {
        const Windows w = probe(/*group=*/1, /*silence=*/0);
        // Reuse the post-onset window as "shortly after the trigger"; track 0 (0.8) choked leaves
        // only track 1 (0.25) — much quieter than a surviving drone would be.
        std::printf("  immediate (onset at 0):        tf=%llu  post-trigger=%.4f\n",
                    static_cast<unsigned long long>(w.tf), w.postOnset);
        if (w.postOnset > 0.14) {
            std::printf("    FAIL: level too high just after the trigger — the loud drone was not "
                        "choked immediately.\n");
            ++failures;
        }
        if (w.postOnset < 0.01) {
            std::printf("    FAIL: silence after the trigger — track 1 should be sounding.\n");
            ++failures;
        }
    }

    // (3) GROUP 0 = OFF: both tracks ring together; nothing is ever choked. With a silent head on
    // track 1, track 0's ring in the pre-onset window must match the deferred case (unaffected),
    // and after onset BOTH sound (louder than either alone).
    {
        const std::size_t silence = static_cast<std::size_t>(kSampleRate * 0.125);
        const Windows w = probe(/*group=*/0, silence);
        std::printf("  group 0 (choke off):           tf=%llu  pre-onset=%.4f  post-onset=%.4f\n",
                    static_cast<unsigned long long>(w.tf), w.preOnset, w.postOnset);
        if (w.preOnset < 0.05) {
            std::printf("    FAIL: track 0 fell silent with choke OFF — it must ring untouched.\n");
            ++failures;
        }
    }

    if (failures) {
        std::printf("\nFAIL: %d choke-deferral assertion(s) failed.\n", failures);
        return 1;
    }
    std::printf("\n  PASS: choke defers through a silent head, still fires immediately on an "
                "audible onset, and stays off for group 0.\n\n");
    return 0;
}
