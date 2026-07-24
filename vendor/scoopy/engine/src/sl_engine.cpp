// XP-5 / P8-2 — the C ABI's implementation. A thin wrapper; all the behaviour lives in the core.
//
// The only real work here is the LANE NARROWING in sl_render. The engine renders ~28 lanes (main,
// sends, cue, per-deck outs) because the desktop routes them to hardware. A browser has two output
// channels, and the companion explicitly does not offer routing (P8-9). So we hand the core a full
// lane array — the sends still feed the delay and reverb internally, so the SOUND is unchanged —
// and copy out only main L/R.
#include "sl_engine.h"

#include "NativeAudioEngineCore.hpp"
#include "NativeToneFilter.hpp"

#include <array>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

// ─────────────────────────────────────────────────────────────────────────────────────────────
// XP-0d — the denormal guard at the ABI boundary.
//
// On macOS the render callback is protected by juce::ScopedNoDenormals in the HOST layer
// (NativeJuceDeviceHost) — which means any future host that calls sl_render directly (Tauri/Rust,
// a bare test harness) would run UNPROTECTED and hit the x86 subnormal CPU cliff in feedback
// tails. Owning FTZ/DAZ here makes forgetting impossible.
//
// Deliberately NOT applied to the core itself: scoopy_denormal_test links the core directly and
// runs with no FTZ on purpose — it proves the engine does not EMIT subnormals. That gate is what
// makes this guard numerically inert (pure CPU insurance) on current content; WASM, which has no
// FTZ control at all, therefore stays sound-identical too.
// ─────────────────────────────────────────────────────────────────────────────────────────────
#if defined(__SSE2__) || defined(_M_X64) || (defined(_M_IX86_FP) && _M_IX86_FP >= 2)
    #include <pmmintrin.h>
    #define SL_DENORMAL_SSE 1
#elif defined(_M_ARM64) && defined(_MSC_VER) && !defined(__clang__)
    #include <intrin.h>
    #define SL_DENORMAL_MSVC_ARM64 1
#elif defined(__aarch64__) || defined(_M_ARM64)
    #define SL_DENORMAL_AARCH64 1
#endif

namespace {
struct ScopedFlushDenormals {
#if defined(SL_DENORMAL_SSE)
    unsigned int saved;
    ScopedFlushDenormals() : saved(_mm_getcsr()) { _mm_setcsr(saved | 0x8040u); }  // FTZ | DAZ
    ~ScopedFlushDenormals() { _mm_setcsr(saved); }
#elif defined(SL_DENORMAL_MSVC_ARM64)
    __int64 saved;
    ScopedFlushDenormals() : saved(_ReadStatusReg(ARM64_FPCR)) {
        _WriteStatusReg(ARM64_FPCR, saved | (1ll << 24));                          // FZ
    }
    ~ScopedFlushDenormals() { _WriteStatusReg(ARM64_FPCR, saved); }
#elif defined(SL_DENORMAL_AARCH64)
    std::uint64_t saved;
    ScopedFlushDenormals() {
        __asm__ __volatile__("mrs %0, fpcr" : "=r"(saved));
        __asm__ __volatile__("msr fpcr, %0" ::"r"(saved | (1ull << 24)));          // FZ
    }
    ~ScopedFlushDenormals() { __asm__ __volatile__("msr fpcr, %0" ::"r"(saved)); }
#else
    // WASM (and any other target with no denormal control): a deliberate no-op, not an error —
    // the denormal gate above is what protects these platforms.
    ScopedFlushDenormals() = default;
#endif
    ScopedFlushDenormals(const ScopedFlushDenormals&) = delete;
    ScopedFlushDenormals& operator=(const ScopedFlushDenormals&) = delete;
};
}  // namespace

using namespace scoopyloops;

struct sl_engine {
    NativeAudioEngineCore core;
    NativeSequencerSnapshot pending;

    // The track being built by sl_snapshot_track_* — one at a time, begin → set… → end.
    NativeTrackSnapshot track;
    bool trackOpen = false;

    // Scratch lane buffers, allocated ONCE at configure. The render callback must not allocate —
    // in an AudioWorklet an allocation is a glitch, and in WASM it may be a heap growth.
    std::array<std::vector<float>, NativeAudioEngineCore::laneCount> lanes;
    std::array<float*, NativeAudioEngineCore::laneCount> lanePtrs {};
    std::vector<float> silenceIn;
    std::uint32_t blockFrames = 0;
};

extern "C" {

uint32_t sl_engine_abi_version(void) { return SL_ENGINE_ABI_VERSION; }

sl_engine* sl_engine_create(void) { return new (std::nothrow) sl_engine(); }

void sl_engine_destroy(sl_engine* e) { delete e; }

int sl_engine_configure(sl_engine* e, double sample_rate, uint32_t block_frames) {
    if (e == nullptr || block_frames == 0) return 0;
    if (!e->core.configure(sample_rate, block_frames, 0)) return 0;

    e->blockFrames = block_frames;
    for (std::size_t i = 0; i < e->lanes.size(); ++i) {
        e->lanes[i].assign(block_frames, 0.0f);
        e->lanePtrs[i] = e->lanes[i].data();
    }
    e->silenceIn.assign(block_frames, 0.0f);   // no live input in the companion

    MixerState mixer;
    mixer.mainGain = 1.0f;
    mixer.send1Gain = 1.0f;
    mixer.send2Gain = 1.0f;
    mixer.cueGain = 1.0f;
    mixer.deckGain = 1.0f;
    e->core.submitMixerState(mixer);
    return 1;
}

int sl_engine_start(sl_engine* e) { return (e != nullptr && e->core.start()) ? 1 : 0; }
void sl_engine_stop(sl_engine* e) { if (e != nullptr) e->core.stop(); }

void sl_engine_set_main_gain(sl_engine* e, float gain) {
    if (e == nullptr) return;
    MixerState mixer;
    mixer.mainGain = gain;
    mixer.send1Gain = 1.0f;
    mixer.send2Gain = 1.0f;
    mixer.cueGain = 1.0f;
    mixer.deckGain = 1.0f;
    e->core.submitMixerState(mixer);
}

int sl_engine_register_sample(sl_engine* e,
                              const char* sample_id,
                              const float* left,
                              const float* right,
                              uint32_t frames,
                              double sample_rate) {
    if (e == nullptr || sample_id == nullptr || left == nullptr || frames == 0) return 0;

    NativeSample s;
    s.id = sample_id;
    s.sampleRate = sample_rate;
    // COPY — the caller (JS) owns its heap and must be free to release the buffer immediately.
    s.left.assign(left, left + frames);
    s.right.assign(right != nullptr ? right : left,
                   (right != nullptr ? right : left) + frames);   // mono → duplicated
    return e->core.registerSample(std::move(s)) ? 1 : 0;
}

void sl_snapshot_begin(sl_engine* e, double bpm, int is_playing, int32_t start_step) {
    if (e == nullptr) return;
    e->pending = NativeSequencerSnapshot {};
    e->pending.bpm = bpm;
    e->pending.isPlaying = is_playing != 0;
    e->pending.startStep = start_step;
}

// ── Track building, by KEY (ABI v2, P8-10a) ──────────────────────────────────────────────────
//
// The old `sl_snapshot_add_track` took twelve arguments and therefore carried twelve of
// NativeTrackSnapshot's 125 fields; the other 113 took their C++ defaults, which are not "off" but a
// DIFFERENT TRACK (see sl_engine.h). Every field is now addressed by key, so the mapping below is
// the ONE place the ABI and the engine's struct meet — and adding a field is one line here plus one
// enum value, never a re-layout.

void sl_snapshot_track_begin(sl_engine* e,
                             const char* sample_id,
                             const uint8_t* steps,
                             uint32_t step_count) {
    if (e == nullptr || sample_id == nullptr || steps == nullptr || step_count == 0) return;

    e->track = NativeTrackSnapshot{};
    e->track.sampleId = sample_id;
    e->track.steps.assign(steps, steps + step_count);
    // The engine indexes pitchOffsets per step unconditionally, so it must always be step_count
    // long even if the caller never sets it.
    e->track.pitchOffsets.assign(step_count, 0.0);
    e->trackOpen = true;
}

// 1…8 are the valid choke groups (0 = off). A value above 8 is a legacy auto-assign artifact no
// edit path can produce; treat it as off rather than let it choke against another stray group.
static std::uint8_t clampChokeGroup(int g) { return (g < 0 || g > 8) ? 0 : static_cast<std::uint8_t>(g); }

void sl_snapshot_track_set(sl_engine* e, int param, double v) {
    if (e == nullptr || !e->trackOpen) return;
    NativeTrackSnapshot& t = e->track;

    const auto f = [v] { return static_cast<float>(v); };
    const auto b = [v] { return v != 0.0; };
    const auto i = [v] { return static_cast<int>(v); };
    const auto z = [v] { return v > 0.0 ? static_cast<std::size_t>(v) : std::size_t{0}; };

    switch (param) {
        case SL_T_VOLUME:             t.volume = f(); break;
        case SL_T_PAN:                t.pan = f(); break;
        case SL_T_TRACK_GAIN:         t.trackGain = f(); break;
        case SL_T_MUTED:              t.muted = b(); break;
        case SL_T_MIX_MUTED:          t.mixMuted = b(); break;
        case SL_T_REVERSED:           t.reversed = b(); break;
        case SL_T_POLYPHONIC:         t.polyphonic = b(); break;
        case SL_T_STEREO_MODE:        t.stereoMode = static_cast<StereoMode>(i()); break;
        case SL_T_OUTPUT_ASSIGN:      t.outputAssign = i(); break;
        case SL_T_CHOKE_GROUP:        t.chokeGroup = clampChokeGroup(i()); break;

        case SL_T_TONE:               t.tone = f(); break;
        case SL_T_TONE_Q:             t.toneQ = f(); break;
        case SL_T_FILTER_DRIVE:       t.filterDrive = f(); break;
        case SL_T_TONE_MODE:          t.toneMode = static_cast<NativeToneFilter::Mode>(i()); break;

        case SL_T_SEND1:              t.send1Level = f(); break;
        case SL_T_SEND2:              t.send2Level = f(); break;
        case SL_T_SEND3:              t.send3Level = f(); break;
        case SL_T_SEND4:              t.send4Level = f(); break;

        case SL_T_GLOBAL_PITCH:       t.globalPitchOffset = v; break;
        case SL_T_FINE_TUNE_CENTS:    t.fineTuneCents = v; break;
        case SL_T_TUNING_INDEX:       t.tuningIndex = i(); break;
        case SL_T_SPEED_MULTIPLIER:   t.speedMultiplier = v; break;
        case SL_T_PATTERN_SPEED_MULTIPLIER: t.patternSpeedMultiplier = v; break;
        case SL_T_MELODIC_PITCH_MODE: t.melodicPitchMode = b(); break;
        case SL_T_PRESERVE_FORMANTS:  t.preserveFormants = b(); break;
        case SL_T_USE_TIME_STRETCH:   t.useTimeStretch = b(); break;
        case SL_T_STRETCH_ENABLED:    t.stretchEnabled = b(); break;
        case SL_T_STRETCH_TIME_ONLY:  t.stretchTimeOnly = b(); break;
        case SL_T_FREE_RATE_ENABLED:  t.freeRateEnabled = b(); break;
        case SL_T_FREE_RATE:          t.freeRate = v; break;

        case SL_T_SAMPLE_START_FRAME: t.sampleStartFrame = z(); break;
        case SL_T_SAMPLE_END_FRAME:   t.sampleEndFrame = z(); break;
        case SL_T_PLAYBACK_MODE:      t.playbackMode = static_cast<decltype(t.playbackMode)>(i()); break;
        case SL_T_LOOP_ENABLED:       t.loopEnabled = b(); break;
        case SL_T_LOOP_START_MS:      t.loopStartMs = v; break;
        case SL_T_LOOP_END_MS:        t.loopEndMs = v; break;
        case SL_T_LOOP_CROSSFADE_MS:  t.loopCrossfadeMs = v; break;
        case SL_T_DEFAULT_CHOP_INDEX: t.defaultChopIndex = i(); break;
        case SL_T_CHOP_COUNT:         t.chopCount = i(); break;

        case SL_T_ATTACK_PERCENT:     t.attackPercent = f(); break;
        case SL_T_RELEASE_PERCENT:    t.releasePercent = f(); break;
        case SL_T_FADE_CURVE:         t.fadeCurve = v; break;
        case SL_T_SWING_AMOUNT:       t.swingAmount = v; break;
        case SL_T_HUMANIZE:           t.humanize = v; break;
        case SL_T_PRE_SILENCE_MS:     t.preSilenceMs = v; break;
        case SL_T_GLIDE_PERCENT:      t.glidePercentBetweenSteps = v; break;
        case SL_T_OWNER_GATE:         t.ownerModeGate = f(); break;
        case SL_T_OWNER_ATTACK:       t.ownerModeAttack = f(); break;
        case SL_T_RANDOMIZE:          t.randomize = b(); break;
        case SL_T_PLAYBACK_DIR_BACK:  t.playbackDirectionBackward = b(); break;

        case SL_T_LFO1_PITCH_DEPTH: t.lfo1PitchDepth = f(); break;
        case SL_T_LFO1_VOL_DEPTH: t.lfo1VolDepth = f(); break;
        case SL_T_LFO1_PAN_DEPTH: t.lfo1PanDepth = f(); break;
        case SL_T_LFO1_FILTER_DEPTH: t.lfo1FilterDepth = f(); break;
        case SL_T_LFO1_GAIN_DEPTH: t.lfo1GainDepth = f(); break;
        case SL_T_LFO2_PITCH_DEPTH: t.lfo2PitchDepth = f(); break;
        case SL_T_LFO2_VOL_DEPTH: t.lfo2VolDepth = f(); break;
        case SL_T_LFO2_PAN_DEPTH: t.lfo2PanDepth = f(); break;
        case SL_T_LFO2_FILTER_DEPTH: t.lfo2FilterDepth = f(); break;
        case SL_T_LFO2_GAIN_DEPTH: t.lfo2GainDepth = f(); break;
        case SL_T_LFO3_PITCH_DEPTH: t.lfo3PitchDepth = f(); break;
        case SL_T_LFO3_VOL_DEPTH: t.lfo3VolDepth = f(); break;
        case SL_T_LFO3_PAN_DEPTH: t.lfo3PanDepth = f(); break;
        case SL_T_LFO3_FILTER_DEPTH: t.lfo3FilterDepth = f(); break;
        case SL_T_LFO3_GAIN_DEPTH: t.lfo3GainDepth = f(); break;
        case SL_T_LFO4_PITCH_DEPTH: t.lfo4PitchDepth = f(); break;
        case SL_T_LFO4_VOL_DEPTH: t.lfo4VolDepth = f(); break;
        case SL_T_LFO4_PAN_DEPTH: t.lfo4PanDepth = f(); break;
        case SL_T_LFO4_FILTER_DEPTH: t.lfo4FilterDepth = f(); break;
        case SL_T_LFO4_GAIN_DEPTH: t.lfo4GainDepth = f(); break;
        case SL_T_GRAIN_MODE_ENABLED: t.grainModeEnabled = b(); break;
        case SL_T_GRAIN_RATE_MODE: t.grainRateMode = i(); break;
        case SL_T_GRAIN_RATE_HZ: t.grainRateHz = v; break;
        case SL_T_GRAIN_SYNC_RATIO: t.grainSyncRatio = v; break;
        case SL_T_GRAIN_LENGTH_MS: t.grainLengthMs = v; break;
        case SL_T_GRAIN_WINDOW: t.grainWindow = i(); break;
        case SL_T_GRAIN_SCAN_POSITION: t.grainScanPosition = v; break;
        case SL_T_GRAIN_SCAN_SPEED: t.grainScanSpeed = v; break;
        case SL_T_GRAIN_PITCH_SEMITONES: t.grainPitchSemitones = v; break;
        case SL_T_GRAIN_RANDOMIZE: t.grainRandomize = v; break;
        case SL_T_GRAIN_KEY_TRACK: t.grainKeyTrack = b(); break;
        case SL_T_LOCATOR_START_STEP: t.locatorStartStep = z(); break;
        case SL_T_LOCATOR_END_STEP: t.locatorEndStep = z(); break;
        case SL_T_LOCATOR_REPEAT_ACTIVE: t.locatorRepeatActive = b(); break;
        case SL_T_RHYTHMIC_OFFSET: t.rhythmicOffset = i(); break;
        case SL_T_HAS_FLAM_CELLS: t.hasFlamCells = b(); break;

        case SL_T_HAS_CHORD_CELLS: t.hasChordCells = b(); break;
        case SL_T_LFO1_FREE_RATE_DEPTH: t.lfo1FreeRateDepth = f(); break;
        case SL_T_LFO2_FREE_RATE_DEPTH: t.lfo2FreeRateDepth = f(); break;
        case SL_T_LFO3_FREE_RATE_DEPTH: t.lfo3FreeRateDepth = f(); break;
        case SL_T_LFO4_FREE_RATE_DEPTH: t.lfo4FreeRateDepth = f(); break;

        // An unknown key is IGNORED rather than misread — which is the whole point of keying. A
        // newer host talking to an older engine loses a parameter; it does not corrupt one.
        default: break;
    }
}

void sl_snapshot_track_set_array(sl_engine* e, int param, const double* v, uint32_t n) {
    if (e == nullptr || !e->trackOpen || v == nullptr || n == 0) return;
    NativeTrackSnapshot& t = e->track;

    const auto asDouble = [v, n](std::vector<double>& dst) { dst.assign(v, v + n); };
    const auto asFloat = [v, n](std::vector<float>& dst) {
        dst.resize(n);
        for (uint32_t k = 0; k < n; ++k) dst[k] = static_cast<float>(v[k]);
    };
    const auto asSize = [v, n](std::vector<std::size_t>& dst) {
        dst.resize(n);
        for (uint32_t k = 0; k < n; ++k) dst[k] = v[k] > 0.0 ? static_cast<std::size_t>(v[k]) : std::size_t{0};
    };
    const auto asBool = [v, n](std::vector<bool>& dst) {
        dst.resize(n);
        for (uint32_t k = 0; k < n; ++k) dst[k] = v[k] != 0.0;
    };
    const auto asI8 = [v, n](std::vector<std::int8_t>& dst) {
        dst.resize(n);
        for (uint32_t k = 0; k < n; ++k) dst[k] = static_cast<std::int8_t>(v[k]);
    };
    const auto asU8 = [v, n](std::vector<std::uint8_t>& dst) {
        dst.resize(n);
        for (uint32_t k = 0; k < n; ++k) dst[k] = static_cast<std::uint8_t>(v[k] > 0.0 ? v[k] : 0.0);
    };
    const auto asInt = [v, n](std::vector<int>& dst) {
        dst.resize(n);
        for (uint32_t k = 0; k < n; ++k) dst[k] = static_cast<int>(v[k]);
    };

    switch (param) {
        case SL_TA_PITCH_OFFSETS:           asDouble(t.pitchOffsets); break;
        case SL_TA_ACCENT_LEVELS:           asFloat(t.accentLevels); break;
        case SL_TA_CELL_LENGTHS:            asSize(t.cellLengths); break;
        case SL_TA_REVERSE_STEPS:           asBool(t.reverseSteps); break;
        case SL_TA_GLIDE_STEPS:             asBool(t.glideSteps); break;
        case SL_TA_VOLUME_OFFSETS:          asFloat(t.volumeOffsets); break;
        case SL_TA_MIX_VOLUME_OFFSETS:      asFloat(t.mixVolumeOffsets); break;
        case SL_TA_PAN_OFFSETS:             asFloat(t.panOffsets); break;
        case SL_TA_TONE_OFFSETS:            asFloat(t.toneOffsets); break;
        case SL_TA_SAMPLE_START_MS_OFFSETS: asDouble(t.sampleStartMsOffsets); break;
        case SL_TA_SAMPLE_END_MS_OFFSETS:   asDouble(t.sampleEndMsOffsets); break;
        case SL_TA_PRE_SILENCE_MS_OFFSETS:  asDouble(t.preSilenceMsOffsets); break;
        case SL_TA_CELL_CHOP_INDICES:       asInt(t.cellChopIndices); break;
        case SL_TA_SEND1_OFFSETS: asFloat(t.send1Offsets); break;
        case SL_TA_SEND2_OFFSETS: asFloat(t.send2Offsets); break;
        case SL_TA_SEND3_OFFSETS: asFloat(t.send3Offsets); break;
        case SL_TA_SEND4_OFFSETS: asFloat(t.send4Offsets); break;
        case SL_TA_FLAM_COUNTS: asU8(t.flamCounts); break;
        case SL_TA_RHYTHMIC_OFFSET_STEPS: asU8(t.rhythmicOffsetSteps); break;
        case SL_TA_CHOP_POINTS: asDouble(t.chopPoints); break;
        case SL_TA_CHORD_INTERVALS: asI8(t.chordIntervals); break;
        default: break;
    }
}

// Name → key. The tables below are the ONLY place the ABI's names live; JavaScript asks for them
// rather than hardcoding the integers, so an enum reorder can never silently redirect a parameter.
namespace {
struct NamedParam { const char* name; int id; };

const NamedParam kScalarNames[] = {
    {"SL_T_VOLUME", SL_T_VOLUME}, {"SL_T_PAN", SL_T_PAN}, {"SL_T_TRACK_GAIN", SL_T_TRACK_GAIN},
    {"SL_T_MUTED", SL_T_MUTED}, {"SL_T_REVERSED", SL_T_REVERSED},
    {"SL_T_POLYPHONIC", SL_T_POLYPHONIC}, {"SL_T_STEREO_MODE", SL_T_STEREO_MODE},
    {"SL_T_OUTPUT_ASSIGN", SL_T_OUTPUT_ASSIGN}, {"SL_T_CHOKE_GROUP", SL_T_CHOKE_GROUP},
    {"SL_T_TONE", SL_T_TONE}, {"SL_T_TONE_Q", SL_T_TONE_Q}, {"SL_T_TONE_MODE", SL_T_TONE_MODE},
    {"SL_T_FILTER_DRIVE", SL_T_FILTER_DRIVE},
    {"SL_T_SEND1", SL_T_SEND1}, {"SL_T_SEND2", SL_T_SEND2},
    {"SL_T_SEND3", SL_T_SEND3}, {"SL_T_SEND4", SL_T_SEND4},
    {"SL_T_GLOBAL_PITCH", SL_T_GLOBAL_PITCH}, {"SL_T_FINE_TUNE_CENTS", SL_T_FINE_TUNE_CENTS},
    {"SL_T_TUNING_INDEX", SL_T_TUNING_INDEX}, {"SL_T_SPEED_MULTIPLIER", SL_T_SPEED_MULTIPLIER},
    {"SL_T_MELODIC_PITCH_MODE", SL_T_MELODIC_PITCH_MODE},
    {"SL_T_PRESERVE_FORMANTS", SL_T_PRESERVE_FORMANTS},
    {"SL_T_USE_TIME_STRETCH", SL_T_USE_TIME_STRETCH},
    {"SL_T_STRETCH_ENABLED", SL_T_STRETCH_ENABLED},
    {"SL_T_STRETCH_TIME_ONLY", SL_T_STRETCH_TIME_ONLY},
    {"SL_T_FREE_RATE_ENABLED", SL_T_FREE_RATE_ENABLED}, {"SL_T_FREE_RATE", SL_T_FREE_RATE},
    {"SL_T_SAMPLE_START_FRAME", SL_T_SAMPLE_START_FRAME},
    {"SL_T_SAMPLE_END_FRAME", SL_T_SAMPLE_END_FRAME},
    {"SL_T_PLAYBACK_MODE", SL_T_PLAYBACK_MODE}, {"SL_T_LOOP_ENABLED", SL_T_LOOP_ENABLED},
    {"SL_T_LOOP_START_MS", SL_T_LOOP_START_MS}, {"SL_T_LOOP_END_MS", SL_T_LOOP_END_MS},
    {"SL_T_LOOP_CROSSFADE_MS", SL_T_LOOP_CROSSFADE_MS},
    {"SL_T_DEFAULT_CHOP_INDEX", SL_T_DEFAULT_CHOP_INDEX}, {"SL_T_CHOP_COUNT", SL_T_CHOP_COUNT},
    {"SL_T_ATTACK_PERCENT", SL_T_ATTACK_PERCENT}, {"SL_T_RELEASE_PERCENT", SL_T_RELEASE_PERCENT},
    {"SL_T_FADE_CURVE", SL_T_FADE_CURVE}, {"SL_T_SWING_AMOUNT", SL_T_SWING_AMOUNT},
    {"SL_T_HUMANIZE", SL_T_HUMANIZE}, {"SL_T_PRE_SILENCE_MS", SL_T_PRE_SILENCE_MS},
    {"SL_T_GLIDE_PERCENT", SL_T_GLIDE_PERCENT}, {"SL_T_OWNER_GATE", SL_T_OWNER_GATE},
    {"SL_T_OWNER_ATTACK", SL_T_OWNER_ATTACK}, {"SL_T_RANDOMIZE", SL_T_RANDOMIZE},
    {"SL_T_PLAYBACK_DIR_BACK", SL_T_PLAYBACK_DIR_BACK},
    {"SL_T_LFO1_PITCH_DEPTH", SL_T_LFO1_PITCH_DEPTH},
    {"SL_T_LFO1_VOL_DEPTH", SL_T_LFO1_VOL_DEPTH},
    {"SL_T_LFO1_PAN_DEPTH", SL_T_LFO1_PAN_DEPTH},
    {"SL_T_LFO1_FILTER_DEPTH", SL_T_LFO1_FILTER_DEPTH},
    {"SL_T_LFO1_GAIN_DEPTH", SL_T_LFO1_GAIN_DEPTH},
    {"SL_T_LFO2_PITCH_DEPTH", SL_T_LFO2_PITCH_DEPTH},
    {"SL_T_LFO2_VOL_DEPTH", SL_T_LFO2_VOL_DEPTH},
    {"SL_T_LFO2_PAN_DEPTH", SL_T_LFO2_PAN_DEPTH},
    {"SL_T_LFO2_FILTER_DEPTH", SL_T_LFO2_FILTER_DEPTH},
    {"SL_T_LFO2_GAIN_DEPTH", SL_T_LFO2_GAIN_DEPTH},
    {"SL_T_LFO3_PITCH_DEPTH", SL_T_LFO3_PITCH_DEPTH},
    {"SL_T_LFO3_VOL_DEPTH", SL_T_LFO3_VOL_DEPTH},
    {"SL_T_LFO3_PAN_DEPTH", SL_T_LFO3_PAN_DEPTH},
    {"SL_T_LFO3_FILTER_DEPTH", SL_T_LFO3_FILTER_DEPTH},
    {"SL_T_LFO3_GAIN_DEPTH", SL_T_LFO3_GAIN_DEPTH},
    {"SL_T_LFO4_PITCH_DEPTH", SL_T_LFO4_PITCH_DEPTH},
    {"SL_T_LFO4_VOL_DEPTH", SL_T_LFO4_VOL_DEPTH},
    {"SL_T_LFO4_PAN_DEPTH", SL_T_LFO4_PAN_DEPTH},
    {"SL_T_LFO4_FILTER_DEPTH", SL_T_LFO4_FILTER_DEPTH},
    {"SL_T_LFO4_GAIN_DEPTH", SL_T_LFO4_GAIN_DEPTH},
    {"SL_T_GRAIN_MODE_ENABLED", SL_T_GRAIN_MODE_ENABLED},
    {"SL_T_GRAIN_RATE_MODE", SL_T_GRAIN_RATE_MODE},
    {"SL_T_GRAIN_RATE_HZ", SL_T_GRAIN_RATE_HZ},
    {"SL_T_GRAIN_SYNC_RATIO", SL_T_GRAIN_SYNC_RATIO},
    {"SL_T_GRAIN_LENGTH_MS", SL_T_GRAIN_LENGTH_MS},
    {"SL_T_GRAIN_WINDOW", SL_T_GRAIN_WINDOW},
    {"SL_T_GRAIN_SCAN_POSITION", SL_T_GRAIN_SCAN_POSITION},
    {"SL_T_GRAIN_SCAN_SPEED", SL_T_GRAIN_SCAN_SPEED},
    {"SL_T_GRAIN_PITCH_SEMITONES", SL_T_GRAIN_PITCH_SEMITONES},
    {"SL_T_GRAIN_RANDOMIZE", SL_T_GRAIN_RANDOMIZE},
    {"SL_T_GRAIN_KEY_TRACK", SL_T_GRAIN_KEY_TRACK},
    {"SL_T_LOCATOR_START_STEP", SL_T_LOCATOR_START_STEP},
    {"SL_T_LOCATOR_END_STEP", SL_T_LOCATOR_END_STEP},
    {"SL_T_LOCATOR_REPEAT_ACTIVE", SL_T_LOCATOR_REPEAT_ACTIVE},
    {"SL_T_RHYTHMIC_OFFSET", SL_T_RHYTHMIC_OFFSET},
    {"SL_T_HAS_FLAM_CELLS", SL_T_HAS_FLAM_CELLS},
    {"SL_T_HAS_CHORD_CELLS", SL_T_HAS_CHORD_CELLS},
    {"SL_T_LFO1_FREE_RATE_DEPTH", SL_T_LFO1_FREE_RATE_DEPTH},
    {"SL_T_LFO2_FREE_RATE_DEPTH", SL_T_LFO2_FREE_RATE_DEPTH},
    {"SL_T_LFO3_FREE_RATE_DEPTH", SL_T_LFO3_FREE_RATE_DEPTH},
    {"SL_T_LFO4_FREE_RATE_DEPTH", SL_T_LFO4_FREE_RATE_DEPTH},
    {"SL_T_MIX_MUTED", SL_T_MIX_MUTED},
    {"SL_T_PATTERN_SPEED_MULTIPLIER", SL_T_PATTERN_SPEED_MULTIPLIER},
};

const NamedParam kArrayNames[] = {
    {"SL_TA_PITCH_OFFSETS", SL_TA_PITCH_OFFSETS}, {"SL_TA_ACCENT_LEVELS", SL_TA_ACCENT_LEVELS},
    {"SL_TA_CELL_LENGTHS", SL_TA_CELL_LENGTHS}, {"SL_TA_REVERSE_STEPS", SL_TA_REVERSE_STEPS},
    {"SL_TA_GLIDE_STEPS", SL_TA_GLIDE_STEPS}, {"SL_TA_VOLUME_OFFSETS", SL_TA_VOLUME_OFFSETS},
    {"SL_TA_MIX_VOLUME_OFFSETS", SL_TA_MIX_VOLUME_OFFSETS},
    {"SL_TA_PAN_OFFSETS", SL_TA_PAN_OFFSETS}, {"SL_TA_TONE_OFFSETS", SL_TA_TONE_OFFSETS},
    {"SL_TA_SAMPLE_START_MS_OFFSETS", SL_TA_SAMPLE_START_MS_OFFSETS},
    {"SL_TA_SAMPLE_END_MS_OFFSETS", SL_TA_SAMPLE_END_MS_OFFSETS},
    {"SL_TA_PRE_SILENCE_MS_OFFSETS", SL_TA_PRE_SILENCE_MS_OFFSETS},
    {"SL_TA_CELL_CHOP_INDICES", SL_TA_CELL_CHOP_INDICES},
    {"SL_TA_SEND1_OFFSETS", SL_TA_SEND1_OFFSETS},
    {"SL_TA_SEND2_OFFSETS", SL_TA_SEND2_OFFSETS},
    {"SL_TA_SEND3_OFFSETS", SL_TA_SEND3_OFFSETS},
    {"SL_TA_SEND4_OFFSETS", SL_TA_SEND4_OFFSETS},
    {"SL_TA_FLAM_COUNTS", SL_TA_FLAM_COUNTS},
    {"SL_TA_RHYTHMIC_OFFSET_STEPS", SL_TA_RHYTHMIC_OFFSET_STEPS},
    {"SL_TA_CHOP_POINTS", SL_TA_CHOP_POINTS},
    {"SL_TA_CHORD_INTERVALS", SL_TA_CHORD_INTERVALS},
};

// A parameter with no NAME is a parameter JavaScript cannot reach — it would simply never be sent,
// and the track would render with a default, silently. That is the exact failure this whole ABI
// change exists to end, so it is a BUILD error, not a runtime surprise.
static_assert(sizeof(kScalarNames) / sizeof(kScalarNames[0]) == SL_T_SCALAR_COUNT,
              "every sl_track_param needs a name in kScalarNames");
static_assert(sizeof(kArrayNames) / sizeof(kArrayNames[0]) == SL_TA_COUNT,
              "every sl_track_array needs a name in kArrayNames");

int lookup(const NamedParam* table, std::size_t n, const char* name) {
    if (name == nullptr) return -1;
    for (std::size_t k = 0; k < n; ++k) {
        if (std::strcmp(table[k].name, name) == 0) return table[k].id;
    }
    return -1;
}
}  // namespace

int sl_param_id(const char* name) {
    return lookup(kScalarNames, sizeof(kScalarNames) / sizeof(kScalarNames[0]), name);
}

int sl_array_param_id(const char* name) {
    return lookup(kArrayNames, sizeof(kArrayNames) / sizeof(kArrayNames[0]), name);
}

void sl_snapshot_track_end(sl_engine* e) {
    if (e == nullptr || !e->trackOpen) return;
    e->pending.tracks.push_back(std::move(e->track));
    e->trackOpen = false;
}

uint64_t sl_snapshot_commit(sl_engine* e) {
    if (e == nullptr) return 0;
    return e->core.publishSequencerState(e->pending);
}

void sl_render(sl_engine* e, float* out_left, float* out_right, uint32_t frames) {
    if (e == nullptr || out_left == nullptr || out_right == nullptr) return;
    if (frames == 0 || frames > e->blockFrames) return;   // never render past the configured block

    const ScopedFlushDenormals noDenormals;               // XP-0d: see the header comment

    for (auto& lane : e->lanes) std::fill_n(lane.begin(), frames, 0.0f);

    e->core.render(e->silenceIn.data(), e->silenceIn.data(), e->lanePtrs, frames);

    const auto mainL = static_cast<std::size_t>(AudioLane::mainLeft);
    const auto mainR = static_cast<std::size_t>(AudioLane::mainRight);
    std::memcpy(out_left, e->lanes[mainL].data(), frames * sizeof(float));
    std::memcpy(out_right, e->lanes[mainR].data(), frames * sizeof(float));
}

}  // extern "C"
