// ─────────────────────────────────────────────────────────────────────────────────────────────
// P8-10(a) — DOES THE BROWSER PLAY THE SESSION, OR AN APPROXIMATION OF IT?
//
// Phase 8's promise is one sentence: *"the composition works identical."* Two gates were read as
// having proved it, and NEITHER of them tests this:
//
//   • P8-3b's null test (−153 dBFS) renders a `NativeSequencerSnapshot` **directly, in C++**, on both
//     platforms. It proves the DSP is identical. It never touches the C ABI.
//   • P8-2's browser gate compares the AudioWorklet against node. **Both go through the C ABI**, so
//     they are equally reduced and agree with each other perfectly.
//
// Nothing has ever compared *what the desktop plays* with *what the browser plays*. This does.
//
// THE PROBLEM IS THE ABI'S WIDTH. `NativeTrackSnapshot` has **125 fields**. `sl_snapshot_add_track`
// carries **twelve**: sampleId · steps · pitchOffsets · volume · pan · tone · toneQ · send1 · send2 ·
// muted · reversed · polyphonic. Every other field takes its C++ default (`sl_engine.cpp:116`), and
// the defaults are not "off" — they are a *different track*:
//
//   toneMode          → defaults to Mode::tone. A track saved as lowPass/bandPass/notch renders as
//                       the legacy tone TILT. Not subtle: a different filter.
//   sampleStartFrame  → 0. A trimmed sample plays from the top, in full.
//   sampleEndFrame    → 0
//   cellLengths       → empty (every cell one step long; multi-step cells collapse)
//   globalPitchOffset → 0.0        speedMultiplier → 1.0        trackGain → 1.0
//   accentLevels      → empty      swingAmount     → 0.0        chokeGroup → 0
//   send3/4, stereoMode, outputAssign, tuningIndex, fineTuneCents, glideSteps, chops, grain, LFO
//   depths, stretch … → all default.
//
// So the browser does not play your session. It plays a crude reduction of it, silently, and every
// existing test passes because every existing test is on one side of the ABI or the other.
//
// THE EXPERIMENT: ONE scene, rendered TWICE on the same machine — once from the FULL
// `NativeSequencerSnapshot` (what the desktop plays) and once pushed **through the real C ABI** and
// rendered in 128-frame quanta (what the browser plays). Not a transcription of the ABI: the ABI
// itself, or the test would only prove that I can copy code twice. No cross-platform noise, no libm
// noise. Any residual is the boundary's field loss.
//
// UPDATE (ABI v2): `sl_snapshot_add_track` is GONE, replaced by keyed setters
// (`sl_snapshot_track_begin` / `_set` / `_set_array` / `_end`), so the fields above now cross. This
// test is what says so, and it is what will catch the next field that does not.
//
//   ./scoopy_abi_fidelity_test
// ─────────────────────────────────────────────────────────────────────────────────────────────
#include "NativeAudioEngineCore.hpp"
#include "NativeToneFilter.hpp"
#include "sl_engine.h"

#include <memory>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <vector>

using namespace scoopyloops;

namespace {

constexpr double kSampleRate = 48'000.0;

NativeSample makeBurst() {
    NativeSample s;
    s.id = "burst";
    s.sampleRate = kSampleRate;

    const std::size_t n = static_cast<std::size_t>(kSampleRate * 1.5);
    s.left.resize(n);
    s.right.resize(n);

    std::uint32_t x = 0x1234'5678u;
    auto rnd = [&x]() -> float {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        return static_cast<float>(static_cast<std::int32_t>(x)) / 2147483648.0f;
    };
    for (std::size_t i = 0; i < n; ++i) {
        const float t = static_cast<float>(i) / static_cast<float>(kSampleRate);
        s.left[i] = rnd() * std::exp(-4.0f * t) * 0.7f;
        s.right[i] = rnd() * std::exp(-4.0f * t) * 0.7f;
    }
    return s;
}

/**
 * A track a person would actually make: a band-pass filter, a trimmed sample, a transpose, a
 * multi-step cell, accents, swing and some drive. Nothing exotic — every one of these is a control
 * on the front panel, and every one of them is invisible to the C ABI.
 */
NativeTrackSnapshot fullTrack() {
    NativeTrackSnapshot t;
    t.sampleId = "burst";
    t.steps.assign(16, 0);
    t.steps[0] = 1; t.steps[4] = 1; t.steps[8] = 1; t.steps[12] = 1;
    t.pitchOffsets.assign(16, 0.0);

    // ── the twelve the ABI carries ───────────────────────────────────────────────────────────
    t.volume = 0.9f;
    t.pan = -0.2f;
    t.tone = 62.0f;
    t.toneQ = 4.0f;
    t.send1Level = 0.25f;
    t.send2Level = 0.0f;
    t.muted = false;
    t.reversed = false;
    t.polyphonic = false;

    // ── and the ones it does not ─────────────────────────────────────────────────────────────
    t.toneMode = NativeToneFilter::Mode::bandPass;   // → renders as Mode::tone in the browser
    t.sampleStartFrame = static_cast<std::size_t>(kSampleRate * 0.05);  // → 0 (plays from the top)
    t.sampleEndFrame = static_cast<std::size_t>(kSampleRate * 0.60);    // → 0 (plays in full)
    t.globalPitchOffset = 5.0;                       // → 0.0 (a fifth of a scale, gone)
    t.trackGain = 1.6f;                              // → 1.0 (the clipper never engages)
    t.swingAmount = 0.35;                            // → 0.0 (the groove is gone)
    t.accentLevels.assign(16, 0.0f);
    t.accentLevels[0] = 2.0f;                        // → empty (no accent)
    t.accentLevels[8] = 1.0f;
    t.cellLengths.assign(16, 1);
    t.cellLengths[0] = 3;                            // → empty (the long cell collapses to one step)

    // ── the modulation + feel fields carried in the coverage pass ────────────────────────────
    // If any of these stopped crossing, this test would say so. That is the whole point of putting
    // them in the SCENE rather than trusting that a field list stayed in step with itself.
    t.lfo1PitchDepth = 0.4f;
    t.lfo1FilterDepth = 0.3f;
    t.lfo2VolDepth = 0.25f;
    t.lfo3PanDepth = 0.2f;
    t.lfo4GainDepth = 0.15f;

    // The step RATCHET (SL_T_PATTERN_SPEED_MULTIPLIER — the key added for the browser's ×N
    // density). 2.0 doubles the pattern rate; if the key stopped crossing, the ABI render plays
    // half the onsets and the residual screams.
    t.patternSpeedMultiplier = 2.0;

    t.rhythmicOffset = 3;
    t.rhythmicOffsetSteps.assign(16, 0);
    t.rhythmicOffsetSteps[4] = 5;

    t.flamCounts.assign(16, 0);
    t.flamCounts[8] = 2;
    t.hasFlamCells = true;

    t.send1Offsets.assign(16, 0.0f);
    t.send1Offsets[4] = 0.5f;

    t.locatorStartStep = 0;
    t.locatorEndStep = 8;
    t.locatorRepeatActive = false;   // true would loop the render and swamp everything else

    // A CHORD CELL. The engine wants intervals; the document stores a library index, and until the
    // browser learned to expand one into the other a chord cell played as a single note.
    // 3 slots/step (kMaxChordNotes - 1), zero-padded. Step 4 = Minor 7 [3, 7, 10].
    t.chordIntervals.assign(16 * 3, 0);
    t.chordIntervals[4 * 3 + 0] = 3;
    t.chordIntervals[4 * 3 + 1] = 7;
    t.chordIntervals[4 * 3 + 2] = 10;
    t.hasChordCells = true;

    // The free-rate LFO depth — derived in Swift from the modifier slots, and therefore absent from
    // the browser entirely until it was mirrored.
    t.freeRateEnabled = true;
    t.freeRate = 1.5;
    t.lfo1FreeRateDepth = 0.35f;
    return t;
}

/** A GRANULAR track — the grain engine is a whole second voice path, and it must cross too. */
NativeTrackSnapshot grainTrack() {
    NativeTrackSnapshot t;
    t.sampleId = "burst";
    t.steps.assign(16, 0);
    t.steps[2] = 1;
    t.steps[10] = 1;
    t.pitchOffsets.assign(16, 0.0);
    t.volume = 0.7f;
    t.pan = 0.3f;

    t.grainModeEnabled = true;
    t.grainRateHz = 90.0;
    t.grainRateMode = 0;
    t.grainSyncRatio = 8.0;
    t.grainLengthMs = 40.0;
    t.grainWindow = 1;
    t.grainScanPosition = 0.2;
    t.grainScanSpeed = 0.1;
    t.grainPitchSemitones = -3.0;
    t.grainRandomize = 0.0;   // 0: the two renders must be deterministic to be comparable
    t.grainKeyTrack = true;
    return t;
}

struct Rendered {
    std::vector<float> left, right;
};

/**
 * The SAME track, pushed through the REAL C ABI — every `sl_snapshot_track_set` the browser would
 * make. Not a transcription of the ABI: the ABI itself. A test that re-implemented the boundary it
 * is checking would only prove that I can copy code twice.
 */
void pushTrackThroughAbi(sl_engine* e, const NativeTrackSnapshot& t) {
    sl_snapshot_track_begin(e, t.sampleId.c_str(), t.steps.data(),
                            static_cast<uint32_t>(t.steps.size()));

    sl_snapshot_track_set(e, SL_T_VOLUME, t.volume);
    sl_snapshot_track_set(e, SL_T_PAN, t.pan);
    sl_snapshot_track_set(e, SL_T_TRACK_GAIN, t.trackGain);
    sl_snapshot_track_set(e, SL_T_MUTED, t.muted);
    sl_snapshot_track_set(e, SL_T_REVERSED, t.reversed);
    sl_snapshot_track_set(e, SL_T_POLYPHONIC, t.polyphonic);
    sl_snapshot_track_set(e, SL_T_STEREO_MODE, static_cast<int>(t.stereoMode));

    sl_snapshot_track_set(e, SL_T_TONE, t.tone);
    sl_snapshot_track_set(e, SL_T_TONE_Q, t.toneQ);
    sl_snapshot_track_set(e, SL_T_TONE_MODE, static_cast<int>(t.toneMode));

    sl_snapshot_track_set(e, SL_T_SEND1, t.send1Level);
    sl_snapshot_track_set(e, SL_T_SEND2, t.send2Level);

    sl_snapshot_track_set(e, SL_T_GLOBAL_PITCH, t.globalPitchOffset);
    sl_snapshot_track_set(e, SL_T_SAMPLE_START_FRAME, static_cast<double>(t.sampleStartFrame));
    sl_snapshot_track_set(e, SL_T_SAMPLE_END_FRAME, static_cast<double>(t.sampleEndFrame));
    sl_snapshot_track_set(e, SL_T_SWING_AMOUNT, t.swingAmount);

    sl_snapshot_track_set(e, SL_T_LFO1_PITCH_DEPTH, t.lfo1PitchDepth);
    sl_snapshot_track_set(e, SL_T_LFO1_FILTER_DEPTH, t.lfo1FilterDepth);
    sl_snapshot_track_set(e, SL_T_LFO2_VOL_DEPTH, t.lfo2VolDepth);
    sl_snapshot_track_set(e, SL_T_LFO3_PAN_DEPTH, t.lfo3PanDepth);
    sl_snapshot_track_set(e, SL_T_LFO4_GAIN_DEPTH, t.lfo4GainDepth);

    sl_snapshot_track_set(e, SL_T_RHYTHMIC_OFFSET, t.rhythmicOffset);
    sl_snapshot_track_set(e, SL_T_HAS_FLAM_CELLS, t.hasFlamCells);
    sl_snapshot_track_set(e, SL_T_HAS_CHORD_CELLS, t.hasChordCells);
    sl_snapshot_track_set(e, SL_T_FREE_RATE_ENABLED, t.freeRateEnabled);
    sl_snapshot_track_set(e, SL_T_FREE_RATE, t.freeRate);
    sl_snapshot_track_set(e, SL_T_LFO1_FREE_RATE_DEPTH, t.lfo1FreeRateDepth);
    sl_snapshot_track_set(e, SL_T_PATTERN_SPEED_MULTIPLIER, t.patternSpeedMultiplier);

    if (!t.chordIntervals.empty()) {
        std::vector<double> tmp(t.chordIntervals.begin(), t.chordIntervals.end());
        sl_snapshot_track_set_array(e, SL_TA_CHORD_INTERVALS, tmp.data(),
                                    static_cast<uint32_t>(tmp.size()));
    }
    sl_snapshot_track_set(e, SL_T_LOCATOR_START_STEP, static_cast<double>(t.locatorStartStep));
    sl_snapshot_track_set(e, SL_T_LOCATOR_END_STEP, static_cast<double>(t.locatorEndStep));
    sl_snapshot_track_set(e, SL_T_LOCATOR_REPEAT_ACTIVE, t.locatorRepeatActive);

    sl_snapshot_track_set(e, SL_T_GRAIN_MODE_ENABLED, t.grainModeEnabled);
    sl_snapshot_track_set(e, SL_T_GRAIN_RATE_MODE, t.grainRateMode);
    sl_snapshot_track_set(e, SL_T_GRAIN_RATE_HZ, t.grainRateHz);
    sl_snapshot_track_set(e, SL_T_GRAIN_SYNC_RATIO, t.grainSyncRatio);
    sl_snapshot_track_set(e, SL_T_GRAIN_LENGTH_MS, t.grainLengthMs);
    sl_snapshot_track_set(e, SL_T_GRAIN_WINDOW, t.grainWindow);
    sl_snapshot_track_set(e, SL_T_GRAIN_SCAN_POSITION, t.grainScanPosition);
    sl_snapshot_track_set(e, SL_T_GRAIN_SCAN_SPEED, t.grainScanSpeed);
    sl_snapshot_track_set(e, SL_T_GRAIN_PITCH_SEMITONES, t.grainPitchSemitones);
    sl_snapshot_track_set(e, SL_T_GRAIN_RANDOMIZE, t.grainRandomize);
    sl_snapshot_track_set(e, SL_T_GRAIN_KEY_TRACK, t.grainKeyTrack);

    const auto sendArr = [&](int key, const std::vector<float>& src) {
        if (src.empty()) return;
        std::vector<double> tmp(src.begin(), src.end());
        sl_snapshot_track_set_array(e, key, tmp.data(), static_cast<uint32_t>(tmp.size()));
    };
    sendArr(SL_TA_SEND1_OFFSETS, t.send1Offsets);

    if (!t.flamCounts.empty()) {
        std::vector<double> tmp(t.flamCounts.begin(), t.flamCounts.end());
        sl_snapshot_track_set_array(e, SL_TA_FLAM_COUNTS, tmp.data(), static_cast<uint32_t>(tmp.size()));
    }
    if (!t.rhythmicOffsetSteps.empty()) {
        std::vector<double> tmp(t.rhythmicOffsetSteps.begin(), t.rhythmicOffsetSteps.end());
        sl_snapshot_track_set_array(e, SL_TA_RHYTHMIC_OFFSET_STEPS, tmp.data(),
                                    static_cast<uint32_t>(tmp.size()));
    }

    std::vector<double> accents(t.accentLevels.begin(), t.accentLevels.end());
    sl_snapshot_track_set_array(e, SL_TA_ACCENT_LEVELS, accents.data(),
                                static_cast<uint32_t>(accents.size()));

    std::vector<double> cells(t.cellLengths.begin(), t.cellLengths.end());
    sl_snapshot_track_set_array(e, SL_TA_CELL_LENGTHS, cells.data(),
                                static_cast<uint32_t>(cells.size()));

    sl_snapshot_track_set_array(e, SL_TA_PITCH_OFFSETS, t.pitchOffsets.data(),
                                static_cast<uint32_t>(t.pitchOffsets.size()));
    sl_snapshot_track_end(e);
}

/** Render the scene through the C ABI, in 128-frame quanta — exactly as the AudioWorklet does. */
Rendered renderThroughAbi(const std::vector<NativeTrackSnapshot>& tracks, std::uint64_t frames) {
    sl_engine* e = sl_engine_create();
    sl_engine_configure(e, kSampleRate, 128);
    sl_engine_start(e);

    const NativeSample burst = makeBurst();
    sl_engine_register_sample(e, burst.id.c_str(), burst.left.data(), burst.right.data(),
                              static_cast<uint32_t>(burst.left.size()), burst.sampleRate);

    sl_snapshot_begin(e, 120.0, 1, 0);
    for (const auto& t : tracks) pushTrackThroughAbi(e, t);
    sl_snapshot_commit(e);

    Rendered out;
    out.left.resize(frames);
    out.right.resize(frames);
    for (std::uint64_t i = 0; i + 128 <= frames; i += 128) {
        sl_render(e, out.left.data() + i, out.right.data() + i, 128);
    }
    sl_engine_destroy(e);
    return out;
}

NativeSequencerSnapshot sceneWith(const std::vector<NativeTrackSnapshot>& tracks) {
    NativeSequencerSnapshot snap;
    snap.bpm = 120.0;
    snap.isPlaying = true;
    snap.startStep = 0;
    snap.tracks = tracks;
    return snap;
}

Rendered render(const NativeSequencerSnapshot& snap) {
    // Heap, not stack: the core is 1.05 MB and Windows gives a thread 1 MB by default, so a
    // harness holding one by value dies with STATUS_STACK_OVERFLOW before main does anything
    // (0xC00000FD, engine-matrix run 29940659486). macOS/Linux give 8 MB, which is why this only
    // ever showed up on Windows — and showed up as a SILENT crash under Git Bash.
    std::unique_ptr<NativeAudioEngineCore> corePtr = std::make_unique<NativeAudioEngineCore>();
    NativeAudioEngineCore& core = *corePtr;
    if (!core.configure(kSampleRate, 128, 0)) {
        std::fprintf(stderr, "configure failed\n");
        std::exit(1);
    }
    core.registerSample(makeBurst());
    const auto out = core.renderOffline(snap, static_cast<std::uint64_t>(kSampleRate * 4.0), 128);
    return { out.left, out.right };
}

}  // namespace

int main() {
    const std::vector<NativeTrackSnapshot> scene { fullTrack(), grainTrack() };
    const Rendered desktop = render(sceneWith(scene));
    const Rendered browser = renderThroughAbi(scene, static_cast<std::uint64_t>(kSampleRate * 4.0));

    if (desktop.left.size() != browser.left.size() || desktop.left.empty()) {
        std::fprintf(stderr, "renders differ in LENGTH — cannot compare\n");
        return 1;
    }

    double refPeak = 0.0, resPeak = 0.0, resSum = 0.0;
    for (std::size_t i = 0; i < desktop.left.size(); ++i) {
        refPeak = std::max({ refPeak, std::fabs((double)desktop.left[i]), std::fabs((double)desktop.right[i]) });
        const double dl = (double)desktop.left[i] - browser.left[i];
        const double dr = (double)desktop.right[i] - browser.right[i];
        resPeak = std::max({ resPeak, std::fabs(dl), std::fabs(dr) });
        resSum += dl * dl + dr * dr;
    }
    const double resRms = std::sqrt(resSum / (double)(desktop.left.size() * 2));
    const auto dB = [](double v) { return v > 0.0 ? 20.0 * std::log10(v) : -999.0; };

    std::printf("reference peak : %.6f  (%.1f dBFS)\n", refPeak, dB(refPeak));
    std::printf("residual  peak : %.6f  (%.1f dBFS)\n", resPeak, dB(resPeak));
    std::printf("residual  rms  : %.6f  (%.1f dBFS)\n", resRms, dB(resRms));

    if (refPeak < 1e-4) {
        std::fprintf(stderr, "REFUSING: the reference render is silent\n");
        return 2;
    }

    // The same −80 dBFS bar P8-3b's null test uses. Two renders of the SAME session, by the SAME
    // renderer, on the SAME machine: if the ABI carried the track, this would be bit-identical.
    constexpr double kThreshold = -80.0;
    if (dB(resPeak) > kThreshold) {
        std::fprintf(stderr,
            "\nFAIL: the browser does not play this session — it plays a REDUCTION of it.\n"
            "      The residual is %.1f dBFS against a %.1f dBFS bar, and it is not DSP drift:\n"
            "      both sides ran the identical renderer. It is the %d fields the C ABI cannot\n"
            "      carry (band-pass mode, sample trim, transpose, drive, swing, accents, cell\n"
            "      length). sl_snapshot_add_track takes 12 of 125.\n",
            dB(resPeak), kThreshold, 125 - 12);
        return 1;
    }

    std::printf("\nPASS: the C ABI carries the session faithfully (residual %.1f dBFS)\n", dB(resPeak));
    return 0;
}
