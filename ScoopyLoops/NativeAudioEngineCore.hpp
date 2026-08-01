#pragma once

#include "NativeToneFilter.hpp"
#include "NativeTrackClipper.hpp"
#include "NativeMasterSaturation.hpp"
#include "NativeMasterClipper.hpp"
#include "NativeMasterDrive.hpp"
// NativeReturnState (per-return snapshot: gain/volume/pan/gate/LFO + legacy delay fields)
// lives here. The internal-delay DSP class is retired but the state struct is still used.
#include "NativeDigitalDelay.hpp"
#include "NativeVoiceStretchPool.hpp"
#include "NativeBusStretcher.hpp"
#include "NativeResamplerConfig.hpp"
#include "NativeSincResampler.hpp"
#include "NativePluginHost.hpp"
#include "NativeTuning.hpp"

#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace scoopyloops {

enum class AudioLane : std::size_t {
    mainLeft = 0,
    mainRight,
    send1,
    send2,
    send3,
    send4,
    cueLeft,
    cueRight,
    deckLeft,
    deckRight,
    // Per-deck DJ output buses (A/B/C). These carry each deck's post-tempo-stretch
    // stereo signal so the device host can route a deck to its own physical output
    // pair (djDeckA/B/C_OutputChannels) independently of the summed main mix.
    deckA_L,
    deckA_R,
    deckB_L,
    deckB_R,
    deckC_L,
    deckC_R,
    // FX-return WET buses (post gain/pan/mute, pre main-sum). Carried so the device host can
    // capture the reverb/delay/host-plugin tails as independent recording stems. Not routed to
    // hardware — they are already summed into the main bus.
    returnWet1L,
    returnWet1R,
    returnWet2L,
    returnWet2R,
    returnWet3L,
    returnWet3R,
    returnWet4L,
    returnWet4R,
    // Mic-dry capture lanes: the gained mic input (post mic-gain, pre monitor/mute). Carried so the
    // device host can record a clean mic stem regardless of monitoring — i.e. capture the mic direct
    // without summing it into the speakers (avoids acoustic feedback). Not routed to hardware.
    micDryL,
    micDryR,
    count
};

// Maximum number of DJ decks the native core models (A/B/C). Composition mode uses
// a single deck (index 0); DJ mode publishes up to this many.
inline constexpr std::size_t kMaxDecks = 3;

// Number of aux send buses / FX-return slots. Sends 1–4 each feed a return slot that can
// run a host plugin or route raw to a dedicated hardware output. Must match the Swift side.
inline constexpr std::size_t kNumSends = 4;
// Per-track live-ramped control bases (fader immediacy): the four send levels plus volume, pan
// and tone ride the same per-block ramp toward the live target (epoch-gated override while a
// fader moves, else the snapshot value) — see the ramp setup in renderSequencerFrames. The two
// assign channels are the per-track output-routing placement weights (0…1 each: how much of the
// voice is hard-routed onto side 1 / side 2 of the deck pair); ramping them makes toggle flips
// and 1↔2 reassignments click-free.
inline constexpr std::size_t kTrackRampChannels = kNumSends + 9;
inline constexpr std::size_t kRampChanVolume  = kNumSends;
inline constexpr std::size_t kRampChanPan     = kNumSends + 1;
inline constexpr std::size_t kRampChanTone    = kNumSends + 2;
inline constexpr std::size_t kRampChanAssign1 = kNumSends + 3;
inline constexpr std::size_t kRampChanAssign2 = kNumSends + 4;
// Live pitch base (track.globalPitchOffset, UI half-semitone units): ringing voices bend by
// the ramped delta between this and their trigger-baked pitch, so scene-settings morphs and
// pitch edits glide already-playing audio instead of only affecting the next trigger.
// Snapshot-fed only (no LiveTrackControl lane) — the morph republishes per tick.
inline constexpr std::size_t kRampChanPitch   = kNumSends + 5;
// Filter resonance (track.toneQ, the ACTUAL quality factor 0.5…18). Before this lane existed, the
// per-sample filter update fed the voice's OWN cached Q straight back into itself, so Q could not be
// moved on a ringing voice by any means at all — not even a full world republish. Only the next
// trigger picked it up.
inline constexpr std::size_t kRampChanQ        = kNumSends + 6;
// Resonance drive (track.filterDrive, 0…100). Snapshot-fed only, like pitch — no LiveTrackControl
// lane (the UI is a preset menu, not a drag). The ramp matters anyway: a drive step at a ringing
// resonant peak changes the saturation ceiling instantly (25→50 halves it — an instant −6 dB on the
// peak), and 4 ms of ramp turns that click into a squeeze.
inline constexpr std::size_t kRampChanFilterDrive = kNumSends + 7;
// Mute gain (mixer-true mute): target is 0 while the track is user-muted or solo-muted, else 1,
// multiplied into the FINAL voice contribution and both send taps. Riding the 4 ms declick ramp
// makes mute an immediate click-free audio kill on RINGING voices — unlike `muted`, which only
// gates step triggers (that is stop/pause territory and stays quantized). Snapshot-fed only, and
// deliberately NOT in the scene-glide stretch list: mute must always cut in ~4 ms.
inline constexpr std::size_t kRampChanMuteGain = kNumSends + 8;

// Per-deck bus width: [mainL, mainR, send1..4]. (The former SP1/SP2 spectral-pool channels
// were removed with the pool — creative spectral now lives in the Scoopy Spectral FX plugin.)
inline constexpr std::size_t kDeckBusChannels = 2 + kNumSends;

// ── X-MIX carve NODES (Phase XN) ────────────────────────────────────────────────────────
// A carve node is any signal that can take a crossfader SIDE — i.e. any signal the X-MIX
// spectral interlock can eat, or be eaten by. It was decks-only; it is now decks + the four
// FX returns + the audio input. The core stays policy-free: it knows nothing about "sides",
// only about a per-node amount and a bitmask of the nodes whose spectra drive its carve
// (see setCarveAmount()). Swift resolves side → (amount, mask).
//
//   0 … kMaxDecks-1              decks A/B/C  (composition renders on deck 0)
//   kCarveNodeReturn0 + 0…3      FX returns 1–4 (host-mode wet, post gain/pan/mute)
//   kCarveNodeInput              the audio input / mic (post mic-gain)
//
// Decks carve a 6-channel bus (main + the 4 send feeds); returns and the input carve a plain
// stereo pair — hence the per-call channel count on applyCarve().
inline constexpr std::size_t kCarveNodeReturn0 = kMaxDecks;
inline constexpr std::size_t kCarveNodeInput   = kMaxDecks + kNumSends;
inline constexpr std::size_t kMaxCarveNodes    = kMaxDecks + kNumSends + 1;   // 3 + 4 + 1 = 8
static_assert(kMaxCarveNodes <= 32, "the carve source mask is an int — one bit per node");

// Maximum per-cell flam/ratchet hit count. Raised from the original 4 to widen audio-rate
// retrigger experimentation (Phase 0 of the pulsar/granular plan). Must match the Swift
// `kMaxFlam` in Track.swift.
inline constexpr int kMaxFlam = 16;

// Maximum extra chord notes per cell above the root (so kMaxChordExtraNotes + 1 voices per
// chord cell). Must match the Swift `kMaxChordNotes - 1` in ChordLibrary.swift; the per-step
// chordIntervals stream carries exactly this many Int8 slots per step (0 = unused).
inline constexpr int kMaxChordExtraNotes = 3;

// Maximum number of tracks the envelope-follower detector tracks per deck. Source-track
// indices above this fall back to a silent (zero) follower output.
inline constexpr std::size_t kMaxEnvelopeTracks = 64;

struct MixerState {
    float mainGain = 1.0f;
    float send1Gain = 0.0f;
    float send2Gain = 0.0f;
    // Sends 3 & 4 have no mixer-state submit path (the real per-send master is sendInputGain_);
    // default unity so external sends 3/4 pass through at full level.
    float send3Gain = 1.0f;
    float send4Gain = 1.0f;
    float cueGain = 0.0f;
    float deckGain = 1.0f;
    std::uint32_t declaredDSPLatencyFrames = 0;
    std::uint32_t activeVoices = 0;
};

struct Diagnostics {
    double callbackLoad = 0.0;
    std::uint64_t callbackCount = 0;
    std::uint64_t deadlineMissCount = 0;
    std::uint32_t activeVoices = 0;
    std::uint32_t declaredDSPLatencyFrames = 0;
    std::uint32_t hardwareLatencyFrames = 0;
    std::uint32_t bufferSizeFrames = 0;
    double sampleRate = 0.0;
    std::uint32_t droppedVoiceCount = 0;
    std::uint32_t stolenVoiceCount = 0;
    std::uint32_t triggerOverflowCount = 0;
    std::uint32_t peakVoiceCount = 0;
};

struct BenchmarkResult {
    Diagnostics diagnostics;
    std::array<std::int32_t, static_cast<std::size_t>(AudioLane::count)> peakFrames {};
};

enum class StereoMode : std::uint8_t {
    mono = 0,
    stereo,
    leftOnly,
    rightOnly
};

struct NativeSample {
    std::string id;
    std::vector<float> left;
    std::vector<float> right;
    double sampleRate = 0.0;
    // First/last frame whose magnitude reaches the onset threshold (≈ −60 dBFS), scanned once
    // at registerSample. Drives onset-aware choke deferral: a trigger's cross-track choke waits
    // until the voice reaches audible material, so baked-in head silence (or the tail, when
    // reversed) doesn't cut the ringing group early. An all-silent sample leaves both at 0,
    // which degrades to the immediate choke.
    std::size_t onsetFrames = 0;
    std::size_t lastSoundFrame = 0;
};

struct NativeTrackSnapshot {
    std::string sampleId;
    std::vector<std::uint8_t> steps;
    std::vector<double> pitchOffsets;
    float volume = 1.0f;
    float pan = 0.0f;
    // Hard output assignment for external mixing: 0 = off (normal pan), 1/2 = mono-sum the track
    // entirely onto that side of its deck's output pair while perTrackRoutingActive_ is set.
    int outputAssign = 0;
    StereoMode stereoMode = StereoMode::mono;
    bool muted = false;
    // Mixer-true mute: user mute OR solo-induced mute, decomposed from `muted` (which carries the
    // stop/pause/no-sample trigger gate). Drives the kRampChanMuteGain lane — kills ringing audio
    // in ~4 ms while triggers keep firing at zero gain, so unmute reveals the groove mid-sound.
    bool mixMuted = false;
    bool reversed = false;
    // Per-track frame-exact launch (Clip-launch). Dedicated to track play/stop/pause so it never
    // disturbs the overloaded `phaseResetStep` (which also carries DJ-sync and scene-switch values).
    // Both default -1 = inactive (the track plays at the global playhead phase, current behaviour).
    //   launchAnchorStep ≥ 0: the track is SILENT while masterStep < it, and its pattern is read
    //     phase-anchored to it (effective step = masterStep - anchor) so a launched/resumed track
    //     always begins at step 0 — and, when the anchor is a future boundary, exactly on that frame.
    //   launchStopStep ≥ 0: the track is SILENT once masterStep ≥ it (frame-exact stop; no trailing
    //     step fires past the boundary).
    std::int64_t launchAnchorStep = -1;
    std::int64_t launchStopStep   = -1;
    // Transient gate-open step for anticipatory launch (per-track pattern start point). -1 = inactive
    // (the gate falls back to launchAnchorStep — current behaviour). When ≥ 0 it is the masterStep the
    // track becomes audible, distinct from launchAnchorStep (which stays the step-0 phase anchor /
    // boundary). The window [launchGateStep, launchAnchorStep) lets the track read the pattern TAIL
    // (effective step = masterStep - anchor < 0, wrapped) so e.g. an end-of-pattern snare roll plays
    // in the lead-up and step 0 lands exactly on the boundary, grid-aligned with the other tracks.
    std::int64_t launchGateStep   = -1;
    int tuningIndex = 0;          // MusicalTuning.rawValue; 0 = 12-TET identity
    double globalPitchOffset = 0.0;
    double fineTuneCents = 0.0;
    double speedMultiplier = 1.0;
    // Pattern-speed multiplier (always the track's real multiplier, all speed modes). Drives
    // the per-track step ratchet/double-time; speedMultiplier above is the sample-rate effect
    // (gated by speed mode). Keeping them separate lets timeOnly tracks double-time the pattern
    // at normal pitch, matching the legacy engine.
    double patternSpeedMultiplier = 1.0;
    // Rate morph eligibility (T+P × REG), resolved by the facade — the core cannot derive the
    // T / T+P distinction from its own fields (speedMultiplier collapses to 1 in timeOnly, which
    // is ambiguous at a 1:1 detent). When set, a patternSpeedMultiplier change glides over
    // rateMorphFrames (see NativeSequencerSnapshot) instead of switching instantly.
    bool tpMorphEligible = false;
    std::uint8_t chokeGroup = 0;
    // Voice mode: true = polyphonic (retriggers stack), false = mono (self-cut previous voice on
    // retrigger). Independent of chokeGroup, which only governs cross-track exclusivity.
    bool polyphonic = false;
    std::size_t sampleStartFrame = 0;  // trim start; 0 = beginning of sample
    std::size_t sampleEndFrame = 0;    // trim end; 0 = full sample length
    float send1Level = 0.0f;
    float send2Level = 0.0f;
    float send3Level = 0.0f;
    float send4Level = 0.0f;
    float tone = 0.0f;                 // tone control -100 … +100
    float toneQ = 0.7071f;            // the ACTUAL quality factor, 0.5 … 18 (NOT a normalised 0…1)
    float filterDrive = 0.0f;         // resonance drive 0…100 — saturates the SVF band-pass state
    NativeToneFilter::Mode toneMode = NativeToneFilter::Mode::tone;
    std::vector<float> toneOffsets;   // per-step additive tone offsets (additive to tone)
    // Per-step send-level automation: additive offset on top of the track send level (result
    // clamped 0…1 at trigger). Empty = no automation on that send.
    std::vector<float> send1Offsets;
    std::vector<float> send2Offsets;
    std::vector<float> send3Offsets;
    std::vector<float> send4Offsets;

    // Per-track instrument hosting: MIDI-track note data for native note generation into a bound
    // instrument plugin (mirrors MIDIOutputEngine.processMIDITrackWithSpeedMultiplier). trackType
    // 0 = audio, 1 = midiOut. note = midiRootNote + round(pitchOffset/2); velocity per-step or default.
    std::uint8_t trackType = 0;
    std::uint8_t midiChannel = 0;
    std::uint8_t midiRootNote = 60;
    std::uint8_t midiVelocity = 100;
    std::vector<std::uint8_t> midiVelocities;
    std::vector<int> midiPitchBends;   // per-step 14-bit pitch bend (-8192…+8191); 0 = none
    // How much of a cell a generated note sustains before its note-off, as a percentage of the
    // cell's own length (cellLengths[step] × the track's step duration). 100 = legato into the
    // next cell, 50 = staccato. The note LENGTH itself comes from the cell — this only shortens
    // it. Audio tracks ignore this (their length is the sample + envelope).
    double midiGatePercent = 100.0;
    // THE THREE OUTPUTS. A track is one pattern driving up to three destinations, each an
    // independent flag — any combination, including all three:
    //   SMP  = (trackType == 0)      the sample voice
    //   INST = instrumentOutEnabled  the bound instrument plugin
    //   MIDI = midiOutEnabled        the external MIDI port
    // None of them excludes another: a sampled kick can layer a synth sub and drive hardware, all
    // from the same cells. trackType is no longer a "type" — it is just the sample lane's switch.
    bool instrumentOutEnabled = false;
    bool midiOutEnabled = false;

    // Phase 2: LFO
    float lfo1PitchDepth = 0.0f;    // lfoPitchDepth × pitchAmount (semitones scale)
    float lfo2PitchDepth = 0.0f;
    float lfo1VolDepth = 0.0f;      // lfoVolumeDepth (0‥1 modulates around 1.0)
    float lfo2VolDepth = 0.0f;
    float lfo1PanDepth = 0.0f;      // lfoPanDepth (−1‥1 added to pan)
    float lfo2PanDepth = 0.0f;
    float lfo1FilterDepth = 0.0f;   // lfoFilterDepth × filterAmount (tone units)
    float lfo2FilterDepth = 0.0f;
    float lfo1GainDepth = 0.0f;     // lfoGainDepth: modulates pre-clipper drive (−1‥1 around 1.0)
    float lfo2GainDepth = 0.0f;

    // Modulation overhaul: per-track resolved depths for mod channels 3 & 4 (indices 2 & 3).
    // Same units/scale as the lfo1/lfo2 depths above; applied identically in the voice loop.
    float lfo3PitchDepth = 0.0f;
    float lfo3VolDepth = 0.0f;
    float lfo3PanDepth = 0.0f;
    float lfo3FilterDepth = 0.0f;
    float lfo3GainDepth = 0.0f;
    float lfo4PitchDepth = 0.0f;
    float lfo4VolDepth = 0.0f;
    float lfo4PanDepth = 0.0f;
    float lfo4FilterDepth = 0.0f;
    float lfo4GainDepth = 0.0f;

    // Phase 3: Envelope
    double attackPercent = 0.0;     // 0–100; fraction of sample duration for fade-in
    double releasePercent = 0.0;    // 0–100; fraction of sample duration for fade-out
    double fadeCurve = 1.0;         // exponent: 1=linear, <1=log, >1=exp

    // Phase 4: Per-step automation
    std::vector<float> volumeOffsets;     // additive gain offset per step
    std::vector<float> panOffsets;        // additive pan offset per step (−1‥+1)
    std::vector<float> mixVolumeOffsets;  // post-clipper volume offset per step
    std::vector<double> sampleStartMsOffsets;
    std::vector<double> sampleEndMsOffsets;

    // Phase 5: Glide
    double glidePercentBetweenSteps = 0.0; // 0–100

    // Phase 6: Multi-step cells, locator, per-step reverse, timing
    std::vector<std::size_t> cellLengths;           // per-step cell length (default 1)
    std::vector<bool> reverseSteps;                 // per-step reverse override (XOR with reversed)
    std::vector<bool> glideSteps;                   // per-step glide flag (glide into this step)
    std::size_t locatorStartStep = 0;
    std::size_t locatorEndStep = 0;
    bool locatorRepeatActive = false;
    std::uint8_t rhythmicOffset = 0;                // 0=none, 1=quarter, 2=half (fraction of step)
    std::vector<std::uint8_t> rhythmicOffsetSteps;  // per-step override (0=use track default)
    std::vector<std::uint8_t> flamCounts;           // per-step flam/ratchet count (1=single hit, 2…4 repeats)
    bool hasFlamCells = false;                      // precomputed: any flamCounts entry > 1 (per-frame fast path)
    std::vector<std::int8_t> chordIntervals;        // per-step resolved chord: kMaxChordExtraNotes slots/step, semitones above root, 0 = unused
    bool hasChordCells = false;                     // precomputed: any chordIntervals entry != 0 (trigger fast path)

    // Free-rate multiplier (audio-rate resynthesis): a continuous, modulatable retrigger rate that
    // departs from the LCM/bar-locked patternSpeedMultiplier. When freeRateEnabled (and the track is
    // not in time-stretch mode), the retrigger runs on a per-track phase accumulator at freeRate× the
    // step rate (see the free-rate phasor branch in renderSequencerFrames). Sweepable to audio rate.
    bool   freeRateEnabled = false;
    double freeRate = 1.0;   // 1× = neutral (locked groove); off-neutral engages the tape phasor
    // LFO → free-rate modulation depths (one per LFO / mod-channel). Resolved in the facade from the
    // `.freeRate` modifier-matrix assignment + amount. Engine: rate × (1 + Σ lfoVal × depth) →
    // vibrato at low LFO rate, FM at audio-rate LFO. The standard LFO-modifier path (not bespoke FM).
    float lfo1FreeRateDepth = 0.0f;
    float lfo2FreeRateDepth = 0.0f;
    float lfo3FreeRateDepth = 0.0f;
    float lfo4FreeRateDepth = 0.0f;

    // Audio-rate grain (pulsar) mode. A flag-gated playback mode: the track's audio comes from a
    // phasor-driven grain train (windowed slices of THIS track's own sample) instead of step
    // voices. Cells gate it; per-cell pitch = fundamental (keytrack), per-cell start/end = scan.
    bool   grainModeEnabled = false;
    int    grainRateMode = 0;            // 0 = Hz, 1 = sync (stepRate × ratio)
    double grainRateHz = 110.0;          // fundamental in Hz (rate mode 0)
    double grainSyncRatio = 8.0;         // stepRate multiplier (rate mode 1)
    double grainLengthMs = 30.0;         // grain duration
    int    grainWindow = 0;              // 0 = hann, 1 = tukey, 2 = gauss
    double grainScanPosition = 0.0;      // 0..1 scan into the sample
    double grainScanSpeed = 0.0;         // scan drift (sample-fractions/frame × span)
    double grainPitchSemitones = 0.0;    // grain content transpose (formant)
    double grainRandomize = 0.0;         // 0..1 per-grain scan/amp jitter
    bool   grainKeyTrack = true;         // per-cell pitch → fundamental (true) or content (false)
    bool   grainEnabled = false;         // precomputed gate (grainModeEnabled && audio track) for the per-frame fast path
    double preSilenceMs = 0.0;
    std::vector<double> preSilenceMsOffsets;        // per-step additive pre-silence offset (ms)
    double swingAmount = 0.0;                        // smart swing 0..1: delays off-beat 16ths (tempo-relative)

    // Phase 7: Humanize, Accents, Randomize, Playback Direction
    float humanize = 0.0f;                          // 0–1 timing + volume jitter
    std::vector<float> accentLevels;                // per-step: 0=off, 1=soft(×1.25), 2=hard(×1.5)
    bool playbackDirectionBackward = false;         // true = reverse step traversal
    bool randomize = false;                         // true = pick random active step each trigger

    // Phase 8: Per-track gain + clipper
    float trackGain = 1.0f;                         // 1.0 = no distortion, >1.0 activates clipper

    // Phase 11: RubberBand time-stretching
    bool melodicPitchMode = false;   // true → pitch-shift via RubberBand, rate = 1.0
    bool preserveFormants = false;   // with melodicPitchMode: keep formants put under transpose
    bool useTimeStretch = false;     // true → time-stretch via RubberBand (speedMode == .timeStretch)

    // Sample-mode consolidation: per-track sub-mode behavior.
    int  playbackMode = 0;           // 0=regular, 1=stretch, 2=loop, 3=owner
    bool loopEnabled = false;        // OWN: continuous window wrap; REG: cell-bound legacy loop
    bool stretchEnabled = false;     // REG: stretch the sample to fill the extended cell
    bool stretchTimeOnly = false;    // stretch: true = pitch-preserving (Signalsmith), false = varispeed
    float ownerModeGate = 0.0f;      // 0 = off, else % of sample duration sustained before release
    float ownerModeAttack = 0.0f;    // 0 = instant, else fade-in % of sample duration
    int  defaultChopIndex = -1;      // -1 = off, 0..7 = active chop slice
    int  chopCount = 1;              // number of chop slices (1-8)
    std::vector<double> chopPoints;        // chop boundary start times (ms)
    std::vector<int>    cellChopIndices;   // per-step chop override (-1 = none)
    double loopStartMs = 0.0;        // loop window start (ms, relative to sample)
    double loopEndMs = 0.0;          // loop window end (ms; 0 = sample end)
    double loopCrossfadeMs = 10.0;   // loop wrap crossfade (ms)
};

enum class NativeLfoWaveform : std::uint8_t {
    sine = 0,
    triangle,
    square,
    saw,
    random,
    envelopeFollower  // follows a source track's level (see lfoNEnvelopeSourceTrack + trackEnvelopeLevel)
};

// === Modulation overhaul: generic mod channels =============================
// Mirrors Swift `ModChannelType`.
enum class NativeModChannelType : std::uint8_t {
    lfo = 0,
    envFollower = 1,
    envelope = 2
};

// Freeform breakpoint envelope (MSEG) for an envelope-type channel. Fixed capacity
// keeps it POD / realtime-safe. Segment i leads INTO node i (timeMs[i] = its length);
// node[0] is the start anchor (its timeMs is ignored). value is 0..1 (or -1..1 when
// bipolar). Nodes before `sustainNodeIndex` play on trigger; the value holds at the
// sustain node while the gate is open; nodes after it play on release.
struct NativeBreakpointEnvelope {
    static constexpr int kMaxNodes = 16;
    int   nodeCount = 0;
    float timeMs[kMaxNodes] = {};
    float value[kMaxNodes]  = {};
    float curve[kMaxNodes]  = {};
    int   sustainNodeIndex = 0;
    bool  bipolar = false;
    bool  tempoSync = false;
    /// MOD-10: one macro that curves EVERY segment at once — −1 snappy/hard, 0 linear, +1 soft.
    /// Composes with the per-node `curve` handles, which stay for per-segment control.
    double ease = 0.0;
};

// One modulation channel. `type` selects how its per-frame value is produced.
// `triggerSourceTrack` is the RESOLVED snapshot track index (-1 = none/idle) used by
// envelope channels to gate from that track's step pattern.
struct NativeModChannel {
    NativeModChannelType type = NativeModChannelType::lfo;
    int triggerSourceTrack = -1;
    NativeBreakpointEnvelope envelope;
    // LFO params (type == lfo)
    NativeLfoWaveform lfoWaveform = NativeLfoWaveform::sine;
    double lfoPhaseOffset = 0.0;
    double lfoSymmetry = 0.5;
    // LFO-DIV rework: resolved effective cycle length in grid steps (fractional allowed). Phase
    // is derived from the grid position over this span; there is no free/sync distinction.
    double lfoCycleSteps = 8.0;
    // MOD-10 macros — these REPLACE the waveform as the LFO's shape (see macroLfoValue). The
    // waveform field survives only because `envelopeFollower` still derives the M1/M2 channel TYPE.
    double lfoSlant  = 0.0;   // −1 falling ramp · 0 symmetric · +1 rising ramp
    double lfoEase   = 1.0;   // −1 hard/stepped · 0 linear · +1 soft (default = a pure sine)
    double lfoJitter = 0.0;   // 0…1 random deviation riding on the shape
    double lfoCyclic = 1.0;   // 1 = that deviation repeats identically · 0 = fresh every cycle
    // MOD-11 SHAPES — five macros + a per-step stage layer. Every default is the identity value, so
    // an untouched channel is bit-exact the MOD-10 wave (the engine guards each term; see macroLfoValue).
    static constexpr int kMaxStages = 16;
    double lfoWarp  = 0.0;    // −1…1 phase distortion
    double lfoCurve = 0.0;    // −1…1 lobe convexity
    double lfoFold  = 0.0;    // 0…1 wavefold drive
    double lfoQuant = 0.0;    // 0…1 amplitude staircase
    double lfoChaos = 0.0;    // 0…1 LCM-locked drift
    int    lfoStageCount = 1;             // 1…16 cells the cycle is divided into
    float  lfoStageLevels[kMaxStages] = { // per-cell VCA level 0…1 ([0]=1 → identity)
        1,1,1,1, 1,1,1,1, 1,1,1,1, 1,1,1,1 };
    double lfoStageGlide = 0.0;           // 0…1 slew between cells
    // Env-follower params (type == envFollower)
    int   followerSourceTrack = -1;
    float followerGain = 1.0f;
    float followerAttack = 0.0f;
    float followerRelease = 0.2f;
    // Per-channel master depth (0…1): scales this channel's output at the source.
    double depth = 1.0;
};

static constexpr int kModChannelCount = 4;

struct NativeSequencerSnapshot {
    double bpm = 120.0;
    std::uint32_t startStep = 0;
    // Frame-exact pattern-scene switching. When a scene switch is scheduled, Swift pushes the
    // target scene's snapshot EARLY (before the boundary) tagged with a monotonic event id and the
    // MUSICAL step (masterStep − patternAnchorStep, i.e. the same domain as the published playhead)
    // at which the new pattern's cycle must begin — a multiple of the OUTGOING scene's own LCM. The
    // core holds the world and installs it at the boundary crossing, moving the deck's pattern
    // anchor there so the new pattern is always read from ITS step 0 (no skipped steps / inaudible
    // downbeat) while the absolute clock keeps running. `patternSwitchPeriod` (the outgoing LCM)
    // lets the core roll the boundary forward one full cycle if a switch ever arrives late.
    // eventID 0 / boundary < 0 = no pending switch.
    std::uint64_t patternSwitchEventID = 0;
    std::int64_t  patternSwitchBoundaryStep = -1;
    std::uint32_t patternSwitchPeriod = 0;
    // MOD-11 CHAOS: the pattern's LCM length in steps (always present, ≥1). The chaos contour
    // repeats every L = round(patternLcmSteps ÷ effective LFO cycle) cycles, so it drifts yet
    // resolves at the pattern's LCM boundary. Sequencer-level (not carried to the companion).
    std::uint32_t patternLcmSteps = 1;
    // Scene glide/cut riders on the switch tag (consumed once at the switch install, eventID-deduped).
    // glideFrames: glide each track's volume/pan/tone/pitch base from its current value to this
    // snapshot's value over this many frames (0 = the normal 4 ms declick). cut: fade every voice
    // still ringing at the boundary over the choke fade so the old scene stops instead of ringing
    // out (FX/send tails deliberately keep ringing). Sequencer-level fields — deliberately not
    // carried to the browser companion (the C ABI gate covers NativeTrackSnapshot only; the
    // companion has no scene scheduling).
    std::uint32_t patternSwitchGlideFrames = 0;
    bool patternSwitchCut = false;
    // Rate morph (multiply glide): duration in frames of the turntable-style glide applied when
    // an eligible track's patternSpeedMultiplier changes (tpMorphEligible above). 0 = OFF —
    // detent changes switch instantly, bit-identical to the pre-morph engine. Stamped from the
    // RAMP box (djMode.masterTempoRampSeconds) on every push. Sequencer-level field —
    // deliberately not carried to the browser companion (like the scene-switch riders above).
    std::uint32_t rateMorphFrames = 0;
    bool isPlaying = true;
    // Global "session plays backwards" transport toggle (DJ Q/A; compose REV button). A non-
    // destructive whole-session reverse: it does NOT touch each track's own playbackDirection —
    // instead the render loop XORs this into every track's backward flag, so step traversal is
    // mirrored AND each sample plays reversed (true tape reverse), and a track already set backward
    // composes to forward (double negative). Sequencer-level field, deliberately not carried to the
    // browser companion (the C ABI gate covers NativeTrackSnapshot only).
    bool reverseTransport = false;
    // Beat repeat (global, per deck): loop [beatRepeatStartStep, +beatRepeatLength) steps. masterStep
    // keeps advancing underneath (acts as the legacy "virtual step"), so deactivation resumes cleanly.
    bool isBeatRepeatActive = false;
    std::size_t beatRepeatStartStep = 0;
    std::size_t beatRepeatLength = 1;
    // Micro-step subdivision: 1 = whole-step (loop beatRepeatLength steps); 2/4/8/16/32 = loop
    // 1/subdivision of a SINGLE step as a re-triggering stutter "roll" (re-fires the slice each
    // sub-tick). Only meaningful while beatRepeatLength == 1.
    std::size_t beatRepeatSubdivision = 1;
    // Sub-cell phase within the start step for sub-1 windows: 0 … subdivision-1. Only meaningful
    // when beatRepeatSubdivision > 1. A 1/N window is exactly the k-th of N equal sub-cells of the
    // start step, so it never straddles a whole-step boundary; the render loops the slice-frame span
    // [k/N, (k+1)/N) of that step's slice (its actual content there), not a re-attack from the onset.
    std::size_t beatRepeatStartSubcell = 0;
    double masterVolume = 1.0;  // Phase 9: master output gain (≤1 = clean, >1 = clipping)
    double masterSpeed = 1.0;   // Phase 9: tempo multiplier (affects framesPerStep)
    // Master clipper controls (mirror MasterClipper.swift). Only engage above 100% master vol.
    float  masterClipperDrive     = 2.0f;  // saturation-path input gain (UI "drive")
    float  masterClipperThreshold = 0.7f;  // knee amplitude
    float  masterClipperSoftness  = 0.4f;  // serial clip intensity at 200% master vol
    std::uint8_t masterClipperCurve = 0;   // MasterDriveCurve: 0 soft(legacy) 1 tanh 2 hard 3 fold
    // FL/Ozone-style decoupled clipper section (see NativeMasterDrive). When decoupled, drive is
    // always-on (independent of master volume) into a fixed ceiling, optionally oversampled.
    float  masterClipperCeiling    = 1.0f; // output clip point (linear, 1.0 = 0 dBFS)
    std::uint8_t masterClipperOversample = 0; // 0 off (ADAA) / 2 / 4
    bool   masterClipperDecoupled  = false;   // false = legacy volume-gated (parity), true = always-on
    // Phase 11: DJ time-stretch
    bool   djTimeStretchActive = false;  // varispeedMode == .timeStretchTempo
    double djTimeStretchRatio  = 1.0;   // = externalVarispeedMultiplier
    // Parity Gap A: classic DJ varispeed (.timeAndPitchTempo) — applies to voice rate
    double externalVarispeedRatio = 1.0;
    std::vector<NativeTrackSnapshot> tracks;
    std::vector<std::string> unsupportedFeatures;
    // Phase 10: Return tracks
    NativeReturnState return1;
    NativeReturnState return2;

    // Phase 2: Global LFOs
    NativeLfoWaveform lfo1Waveform = NativeLfoWaveform::sine;
    double lfo1Rate = 2.0;          // legacy Hz — retained but no longer drives timing
    double lfo1PhaseOffset = 0.0;   // 0–1
    double lfo1Symmetry = 0.5;      // 0–1
    // LFO-DIV rework: resolved effective cycle length in grid steps (fractional allowed). Phase
    // is derived from the grid position over this span (see the LFO block in the render loop).
    double lfo1CycleSteps = 8.0;

    NativeLfoWaveform lfo2Waveform = NativeLfoWaveform::triangle;
    double lfo2Rate = 2.0;
    double lfo2PhaseOffset = 0.0;
    double lfo2Symmetry = 0.5;
    double lfo2CycleSteps = 8.0;

    // Envelope-follower source routing (used when lfoNWaveform == envelopeFollower).
    // sourceTrack < 0 → no source (follower outputs 0). gain boosts weak signals (the boosted
    // value is clamped to 1). attack/release (0–1) smooth the follower output, matching the
    // AVFoundation lfoEnvelopeAttack/Release controls (alpha = pow(10, -x*4); 0 → instant).
    int   lfo1EnvelopeSourceTrack = -1;
    float lfo1EnvelopeGain        = 1.0f;
    float lfo1EnvelopeAttack      = 0.0f;
    float lfo1EnvelopeRelease     = 0.2f;
    int   lfo2EnvelopeSourceTrack = -1;
    float lfo2EnvelopeGain        = 1.0f;
    float lfo2EnvelopeAttack      = 0.0f;
    float lfo2EnvelopeRelease     = 0.2f;

    // Modulation overhaul: generic mod channels. Channels 0–1 mirror lfo1/lfo2; 2–3 are
    // new. Populated by the bridge from the Swift snapshot. Consumed in Phase 2b.
    NativeModChannel modChannels[kModChannelCount];
};

struct NativeTriggerEvent {
    std::uint64_t frame = 0;
    std::uint32_t trackIndex = 0;
    std::uint32_t stepIndex = 0;
};

// Live, imperative one-shot voice trigger (finger drumming, musical keyboard, sample/chop
// preview). Unlike the declarative sequencer snapshot, these are gesture-driven events injected
// from the control thread and drained at the top of the render callback. POD + trivially
// copyable so the SPSC ring buffer needs no allocation or locking. sampleId is a C-string UUID
// (36 chars) resolved against the published world's sample map.
struct LiveTriggerCommand {
    enum class Kind : std::uint8_t { trigger, stop };
    Kind kind = Kind::trigger;
    std::uint8_t deck = 0;            // 0 = composition / deck A
    std::uint32_t trackIndex = 0;
    std::int32_t pitchOffset = 0;     // Scoopy pitch units (÷2 → semitones), matches musicalKeyDown
    float velocity = 1.0f;            // 0‥1 loudness scaler (127 → 1.0 = default grid-cell level)
    std::uint64_t voiceId = 0;        // groups trigger↔stop (e.g. keyCode); 0 on stop = all on track
    double startMs = 0.0;             // chop/preview start; 0 = use track trim start
    double endMs = 0.0;               // chop/preview end; 0 = use track trim end
    char sampleId[40] = {0};          // UUID string (36 chars) + NUL
};

struct NativeRenderVoice {
    const NativeSample* sample = nullptr;
    double position = 0.0;
    double rate = 1.0;             // base playback rate (no LFO, no glide)
    std::size_t startFrame = 0;
    std::size_t endFrame = 0;
    float leftGain = 1.0f;         // kept for choke/send path; re-derived per-frame when LFO active
    float rightGain = 1.0f;
    float send1Level = 0.0f;
    float send2Level = 0.0f;
    float send3Level = 0.0f;
    float send4Level = 0.0f;
    // Per-step send automation offset, baked at trigger. The audible level is the per-track
    // ramped slider base (NativeRenderState::trackBaseCurrent) + this offset, clamped 0…1 — so a
    // send fader move is heard on ringing voices (and sticks after the republish), while the
    // per-step offset stays a hard per-hit jump. sendNLevel above keeps the trigger-baked total
    // as the fallback for tracks beyond kMaxEnvelopeTracks.
    float sendOffset[kNumSends] = {};
    // Trigger-baked per-step components for the live-ramped vol/pan/tone bases. The audible value
    // is (liveBase + add) — volume additionally × cellVolMult — recomputed per frame whenever the
    // live base differs from the base captured at trigger (bakedXxxBase below), so fader moves
    // reach ringing voices and stick after the republish. baseVolume/basePan/baseTone stay the
    // trigger-composed totals (bitwise fast path + per-cell glide-source capture).
    float volAdd = 0.0f;               // per-step volume + mix offsets (0 for live triggers)
    float panAdd = 0.0f;               // per-step pan offset
    float toneAdd = 0.0f;              // per-step tone offset
    float bakedVolBase = 1.0f;
    float bakedPanBase = 0.0f;
    float bakedToneBase = 0.0f;
    // Track globalPitchOffset (UI units) at trigger. When the live pitch base
    // (kRampChanPitch) moves away from this, the voice's playback rate / RB transpose
    // is bent by the delta — pitch edits and scene morphs reach ringing voices smoothly.
    float bakedPitchBase = 0.0f;
    StereoMode stereoMode = StereoMode::mono;
    std::uint32_t trackIndex = 0;
    // Monotonic trigger order, stamped at activation. A track can have several voices sounding
    // at once (poly, chord siblings, a flam ratchet, an OWN tail still ringing under the next
    // hit), and the UI playhead must follow the one you last HEARD START — not whichever the
    // round-robin allocator happened to leave earliest in the array. Read-only outside the audio
    // thread; see deckTrackSamplePos.
    std::uint64_t triggerSerial = 0;
    std::uint8_t chokeGroup = 0;
    std::uint32_t fadeFramesRemaining = 0;
    // Onset-aware deferred cut: a trigger's cross-track choke / mono self-cut doesn't fire until
    // this voice reaches audible material (scheduled pre-silence + the sample's scanned onset),
    // so a silent head doesn't cut the ringing group before the new note actually sounds. Armed
    // at activation when the delay is non-zero; counted down in the render voice loop. Cuts only
    // voices with triggerSerial < pendingCutBeforeSerial (chord siblings and later triggers
    // survive). If this voice is itself choked/stolen before the countdown ends, the cut never
    // fires — a note that never sounds chokes nothing.
    std::uint32_t pendingCutFrames = 0;        // output-frame countdown until the cut fires
    std::uint32_t pendingCutFade = 0;          // fade length captured at trigger (adaptive selfCutFade)
    std::uint64_t pendingCutBeforeSerial = 0;  // cut only voices triggered before this serial
    bool pendingGroupChoke = false;
    bool pendingSelfCut = false;
    bool reversed = false;
    bool stopping = false;
    bool choked = false;
    bool active = false;
    NativeToneFilter toneFilter;

    // Phase 2: LFO — per-voice depths baked from track at activation
    float baseVolume = 1.0f;       // volume before pan; used for per-frame LFO pan/vol recompute
    float basePan = 0.0f;
    double basePitchSemitones = 0.0;
    // Chord sibling: pre-tuning-remap semitone interval above the cell's root (0 = root or no
    // chord). Folded into the per-cell pitch streaming so ringing siblings keep their interval.
    double chordIntervalSemitones = 0.0;
    float lfo1PitchDepth = 0.0f;  // lfoPitchDepth * pitchModAmount (semitones)
    float lfo2PitchDepth = 0.0f;
    float lfo1VolDepth = 0.0f;
    float lfo2VolDepth = 0.0f;
    float lfo1PanDepth = 0.0f;
    float lfo2PanDepth = 0.0f;
    float lfo1FilterDepth = 0.0f; // lfoFilterDepth * filterModAmount (tone units)
    float lfo2FilterDepth = 0.0f;
    bool hasLfoModulation = false; // true when any depth != 0 (skip recompute otherwise)
    float baseTone = 0.0f;        // tone at trigger time (before LFO filter mod)

    // Phase 3: Custom envelope
    std::size_t attackEndFrame = 0;    // startFrame + attackFrames; 0 = no attack fade-in
    std::size_t releaseStartFrame = 0; // endFrame - releaseFrames; SIZE_MAX = use default fade
    float fadeCurveExp = 1.0f;         // applied to both attack and release t-values

    // Phase 5: Glide
    double glideSourceRate = 0.0;      // rate to glide from; 0 = instant (no glide)
    std::uint32_t glideFramesRemaining = 0;
    std::uint32_t glideTotalFrames = 0;

    // Per-cell parameter glide: ramp tone/pan/volume from the previous cell's values into this
    // voice's targets (baseTone/basePan/baseVolume) over the same window as the pitch glide.
    // Active when glideParamFramesRemaining > 0. Gated by the per-step glide flag at activation.
    float glideSourceTone   = 0.0f;
    float glideSourcePan    = 0.0f;
    float glideSourceVolume = 0.0f;
    std::uint32_t glideParamFramesRemaining = 0;
    std::uint32_t glideParamTotalFrames     = 0;

    // Reg-mode extension-step pitch streaming: when a multi-step (extended) regular cell plays
    // as a single varispeed voice, the per-sub-step pitch offsets (and glide between them) are
    // streamed live by ramping the playback rate as the cell progresses — reproducing legacy's
    // pre-rendered per-cell pitch walk without baking a buffer. cellLengthSteps == 1 disables it.
    std::uint32_t cellLengthSteps = 1;     // number of pattern steps this cell spans
    std::size_t   cellOriginStep  = 0;     // first pattern step of the cell
    std::uint64_t cellElapsedFrames = 0;   // output/pattern frames elapsed since cell trigger
    double        cellRateScale   = 1.0;   // non-pitch rate factor (speedMultiplier × varispeed)
    // Rate morph: the track's patternSpeedMultiplier baked at trigger. While a morph is active
    // the render loop bends this voice by morphM/bakedPatternMult (varispeed: rate; RB: the
    // feed stride); at landing the ratio is baked in and this is reset to the landed value, so
    // the per-frame factor is identically 1 outside a morph. 1.0 = neutral (never scaled unless
    // the owning track is mid-morph, which only eligible tracks can be).
    double        bakedPatternMult = 1.0;
    float         cellVolMult     = 1.0f;  // accent × humanize captured at trigger, reapplied while
                                           // streaming reg-mode extension-step volume (see cellStreamVolume)

    // Live trigger (finger drum / musical keyboard / preview): voices spawned imperatively rather
    // than by the sequencer step loop. liveVoiceId groups a key-down with its matching key-up so
    // note-off can target the exact held voice (see enqueueLiveStop). Live voices render regardless
    // of transport/mute state, mirroring the AVFoundation isMidiInput path.
    bool          isLiveTrigger   = false;
    std::uint64_t liveVoiceId     = 0;

    // Phase 6: Pre-silence delay
    std::uint32_t preSilenceFramesRemaining = 0;

    // Phase 8: Per-voice track clipper
    NativeTrackClipper trackClipper;

    // Phase 11: RubberBand
    int         rubberBandSlot          = -1;    // -1 = not using stretcher
    bool        useRubberBand           = false;
    bool        rbFinalized             = false;  // true once process(final=true) has been called
    std::size_t rbInputConsumed         = 0;      // how many sample frames have been fed
    std::size_t rbOutputAvailable       = 0;      // output frames ready to drain
    std::size_t rbLatencySkipRemaining  = 0;      // startup latency frames still to discard
    std::uint32_t rbAttackFadeRemaining = 0;      // short fade-in over the first audible frames
    double      rbTimeRatio             = 1.0;    // output/input duration (Signalsmith time path)
    // Phase A (DJ TP independence): deck varispeed (.timeAndPitchTempo) applied as a clean
    // resample of the source FEED into the stretcher, so the per-voice stretcher only ever does
    // melodic transpose / per-track time-stretch (TP/TS layer on top, independent). 1.0 outside
    // TP mode → the feed stays a 1:1 integer copy (byte-identical to the pre-Phase-A path).
    // rbSourcePos is the fractional source read cursor used when varispeedRate != 1.0.
    double      varispeedRate           = 1.0;    // deck TP resample stride for the feed
    double      rbSourcePos             = 0.0;    // fractional source cursor (varispeed feed)

    // RubberBand per-voice pitch modulation (LFO + glide).
    // Base pitch scale set at activation; LFO and glide modify it once per callback.
    double rbBasePitchScale         = 1.0;   // 2^(semitones/12) at activation
    // Pitch glide ramp — active when rbGlideTotalFrames > 0
    double rbGlideSourcePitchScale  = 0.0;   // pitch scale at start of glide; 0 = no glide
    double rbGlideTargetPitchScale  = 1.0;
    std::uint32_t rbGlideFramesRemaining = 0;
    std::uint32_t rbGlideTotalFrames     = 0;

    // Sample-mode consolidation: loop-window wrap + owner gate/attack envelope.
    bool        loopWrapEnabled = false;   // wrap position within [loopStartFrame, loopEndFrame]
    std::size_t loopStartFrame  = 0;
    std::size_t loopEndFrame    = 0;
    bool        ownerEnvelope   = false;   // apply elapsed-time owner gate/attack to this voice
    float       ownerGatePct    = 0.0f;    // 0 = off, else % of sample duration sustained
    float       ownerAttackPct  = 0.0f;    // 0 = instant, else fade-in % of sample duration
    std::uint64_t lifetimeFrames = 0;      // output frames since voice start (gate/attack + loop)

    // Micro beat-repeat windowed ("granular") grain: when the sub-step window is too short for a
    // hard re-trigger to clear the transient/attack, the voice instead loops a tiny source window
    // (via loopWrap) shaped by a Tukey envelope so each grain is silent→silent at the seam (no click,
    // no attack-ramp dropout). Set per trigger; 0 length = disabled.
    bool        grainWindowEnabled = false;
    std::size_t grainWindowStart   = 0;    // source frame the grain window begins at
    std::size_t grainWindowLen     = 0;    // grain length in source frames (== loop window length)
    // Leading-taper gate: false = the first pass through the window keeps its raw attack (the
    // window starts at the slice onset — a real transient); set true at every loop-window wrap
    // (and at spawn for mid-content windows, which need the taper as a declick from cycle one).
    bool        grainWrapped       = false;
    // Live-refresh anchors (sub-1 beat repeat): one timeline STEP in source frames at this
    // voice's consumption rate, and the source position the sub-cell offsets are measured from.
    // Let the per-block refresh re-derive the window for a NEW subdivision/sub-cell without
    // re-triggering (0 = not a refreshable grain voice).
    double      grainStepSrcLen    = 0.0;
    double      grainBasePos       = 0.0;
};

// === Audio-rate grain (pulsar) mode ========================================
// A lightweight grain pool, one scheduler per track, parallel to the voice system. Grains are
// windowed slices of the track's own sample, emitted by a fractional phasor fast enough to fuse
// into a pitched tone. Reuses NativeSample data + interpolate(); none of the voice lifecycle.
inline constexpr std::size_t kGrainRing = 16;          // max simultaneous overlapping grains/track
inline constexpr std::size_t kMaxGrainTracks = kMaxEnvelopeTracks;

struct NativeGrain {
    const NativeSample* sample = nullptr;
    double readPos = 0.0;        // fractional read cursor into the sample (frames)
    double readRate = 1.0;       // per-frame advance (grain content pitch / formant)
    std::uint32_t age = 0;       // frames since grain start (window position)
    std::uint32_t length = 0;    // grain length in frames
    float ampScale = 1.0f;       // per-grain randomized amplitude
    bool active = false;
};

struct NativeGrainScheduler {
    double phasorAccum = 0.0;                  // fractional-period accumulator (jitter-free spawn)
    std::uint64_t lastGateStep = ~0ull;        // masterStep the gate was last evaluated for
    bool   gateOpen = false;                   // pattern cell active at the current step
    double cellSemitones = 0.0;                // resolved fundamental pitch of the active cell
    double scanCursor01 = 0.0;                 // current scan position (advances with scanSpeed)
    NativeTrackClipper clipper {};             // per-track grain-sum clipper
    std::uint32_t rngState = 0x9e3779b9u;      // xorshift state for randomization
    std::array<NativeGrain, kGrainRing> grains {};
};

struct NativeRenderState {
    static constexpr std::size_t maxVoices = 128;
    static constexpr std::size_t maxTriggerEvents = 4'096;

    std::array<NativeRenderVoice, maxVoices> voices {};
    // Audio-rate grain (pulsar) mode: one scheduler per track (indexed by trackIndex).
    std::array<NativeGrainScheduler, kMaxGrainTracks> grainSchedulers {};
    // Free-rate multiplier: per-track retrigger phase accumulator (indexed by trackIndex). Advances
    // by freeRate/framesPerStep per frame; fires a hit on each integer crossing. NOT reset with
    // state — it persists across stop/seek/world swaps (only range-clamped in place), so any
    // consumer entering the free path from the locked path must seed it first (rate morph does).
    std::array<double, kMaxGrainTracks> ratchetPhase {};
    // Rate morph (multiply glide): per-track velocity glide of the pattern-read multiplier.
    // A T+P/REG track's detent change is detected by VALUE DIFF of consecutive consumed
    // snapshots (morphPrevMult latch — robust against the DJ coordinator dropping intermediate
    // publishes); while morphing the track is forced onto the ratchetPhase accumulator so the
    // change is a velocity ramp, not a position jump, and voices bend by morphM/bakedPatternMult.
    // Phase: 0 = off, 1 = ramp (morphM walks m1→m2 exponentially), 2 = hold (velocity m2 until
    // the locked math's next canonical trigger boundary, where the track lands and the stateless
    // locked path resumes in canonical alignment).
    std::array<double, kMaxGrainTracks> morphPrevMult {};
    std::array<std::uint8_t, kMaxGrainTracks> morphPhase {};
    std::array<double, kMaxGrainTracks> morphM {};        // instantaneous multiplier m(t)
    std::array<double, kMaxGrainTracks> morphM2 {};       // landing target
    std::array<double, kMaxGrainTracks> morphFactor {};   // per-frame growth (m2/m1)^(1/total)
    std::array<std::uint32_t, kMaxGrainTracks> morphFramesLeft {};
    std::array<std::uint32_t, kMaxGrainTracks> morphHoldFramesLeft {};
    std::array<std::uint8_t, kMaxGrainTracks> morphSeedPending {};
    bool morphPrevSeeded = false;   // first block after a reset latches without diffing
    void clearRateMorph() noexcept {
        morphPhase.fill(0);
        morphPrevSeeded = false;   // re-latch from the next snapshot (scene/pattern multiplier
                                   // diffs across a world swap must not spuriously morph)
    }
    std::array<NativeTriggerEvent, maxTriggerEvents> triggerEvents {};
    std::uint64_t framePosition = 0;
    std::uint64_t masterStep = 0;
    std::uint64_t stepFrame = 0;
    std::uint64_t currentFramesPerStep = 0;
    // Monotonic voice-trigger counter (see NativeRenderVoice::triggerSerial).
    std::uint64_t voiceTriggerSerial = 0;
    std::uint32_t triggerEventCount = 0;
    std::uint32_t triggerOverflowCount = 0;
    std::uint32_t droppedVoiceCount = 0;
    std::uint32_t stolenVoiceCount = 0;
    std::uint32_t peakVoiceCount = 0;
    std::uint32_t currentVoiceCount = 0;
    float dcInputLeft = 0.0f;
    float dcInputRight = 0.0f;
    float dcOutputLeft = 0.0f;
    float dcOutputRight = 0.0f;

    // Fader immediacy: per-track ramped slider bases (4 sends + volume/pan/tone). Read live once
    // per block (epoch-gated override while a fader moves, else the snapshot value) and glided
    // toward the target over kTrackBaseRampSeconds, so a 0→0.8 flick is click-free and ringing
    // voices keep tracking the fader after the coalesced republish (no snap-back to the
    // trigger-baked level). Seeded from the snapshot on the first block after a reset.
    std::array<std::array<float, kTrackRampChannels>, kMaxEnvelopeTracks> trackBaseCurrent {};
    bool trackBaseSeeded = false;

    // Phase 2: LFO state (advances every frame)
    double lfo1Phase = 0.0;
    double lfo2Phase = 0.0;
    double randVal1 = 0.0;
    double randVal2 = 0.0;

    // Modulation overhaul: per-channel envelope state machine (one entry per mod channel;
    // only envelope-type channels use it). Stage: 0 idle, 1 pre-sustain, 2 sustain-hold,
    // 3 release. Driven by the source track's cell gate (set in the trigger loop), advanced
    // per frame. modChannelValue is the current 0..1 (or −1..1 bipolar) output.
    float    modChannelValue[kModChannelCount] = {};
    std::uint8_t modEnvStage[kModChannelCount] = {};
    double   modEnvElapsedMs[kModChannelCount] = {};        // since trigger (pre-sustain walk)
    double   modEnvReleaseMs[kModChannelCount] = {};        // since release began
    float    modEnvReleaseStartValue[kModChannelCount] = {};// value captured when release started
    std::uint64_t modGateCloseFrame[kModChannelCount] = {}; // frame at which the gate closes (0 = none)
    bool     modGatePendingTrigger[kModChannelCount] = {};  // set by trigger loop, consumed per frame
    std::uint64_t modPendingCloseFrame[kModChannelCount] = {}; // close frame paired with the pending trigger
    // Per-channel LFO phase + follower output (for generic channels of type lfo / envFollower).
    double   modPhase[kModChannelCount] = {};
    double   modRand[kModChannelCount] = {};
    // MOD-10 jitter contours. `locked` is drawn ONCE (so cyclic=1 repeats bit-identically);
    // `fresh` is re-drawn at every cycle wrap (so cyclic=0 evolves). The macro crossfades them.
    // Legacy random contours — no longer used by the LFO path (MOD-12 Agitation is stateless, hashing
    // targets by segment index); kept only because refreshLfoRand/nextLfoRandom still compile against
    // them. Harmless dead state; a later cleanup can drop them.
    static constexpr int kLfoRandPoints = 8;
    float    lfoRandLocked[kModChannelCount][kLfoRandPoints] = {};
    float    lfoRandFresh[kModChannelCount][kLfoRandPoints] = {};
    bool     lfoRandSeeded[kModChannelCount] = {};
    float    modFollowerOutput[kModChannelCount] = {};
    // MOD-2: normalised PROGRESS through the channel's drawn shape, 0…1, published for the UI so
    // a playhead can ride the static curve the editor draws. LFO = raw phase (WITHOUT phaseOffset —
    // the offset is baked into the drawn shape, so a raw-phase dot lands on the right y). Envelope =
    // position along the cumulative node timeline. Follower = -1 (no static shape; it scrolls).
    float    modChannelPhase[kModChannelCount] = { -1.0f, -1.0f, -1.0f, -1.0f };

    // Envelope-follower detector state. trackEnvelopeLevel is the per-source-track smoothed
    // magnitude (fixed attack 0.5 ms / release 25 ms, matching SequencerNode's detector).
    // lfoNEnvOutput is the post-gain follower value with its own attack/release smoothing; it is
    // fed in as the LFO value when the waveform is envelopeFollower. Updated at the end of each
    // frame and read (1-sample latency) at the start of the next.
    std::array<float, kMaxEnvelopeTracks> trackEnvelopeLevel {};
    float lfo1EnvOutput = 0.0f;
    float lfo2EnvOutput = 0.0f;

    // SIG-3 per-track output meter (the DSP-row activity/clip meter). blockPeak is per-callback
    // scratch: the max TRUE per-channel peak max(|L|,|R|) at the END of the track chain this
    // block — post tone filter, post the Phase-8 track clipper, post volume/pan, post mute-gain
    // — fed by all three source paths (sampler voices, hosted instruments, grain). A muted track
    // reads 0; a hot track reads toward/over 1.0 (the meter's red zone). level is the published
    // decayed peak (deckTrackMixLevel) — folded once per callback for EVERY deck (idle decks
    // must decay to 0, not freeze), read plain from the UI thread.
    std::array<float, kMaxEnvelopeTracks> trackMixBlockPeak {};
    std::array<float, kMaxEnvelopeTracks> trackMixLevel {};

    // Per-track last resolved (played) pattern step, for mid-cell entry detection. When a
    // locator/beat-repeat loop or a skip-step jump lands inside a multi-step reg cell WITHOUT
    // playing the owner contiguously, we trigger the cell from the owner with a mid-cell sample
    // offset instead of skipping it. -1 = nothing played yet (reset on (re)start / stop).
    std::array<std::int32_t, kMaxEnvelopeTracks> prevResolvedStep {};

    // Per-track locator-repeat engagement latch. When locator repeat is toggled on we ARM the track
    // (engaged=false) and keep playing the pattern normally; we only ENGAGE the region loop once the
    // natural playhead first enters [locStart, locEnd], so the loop catches the playhead at the
    // locator point rather than snapping there immediately. `locatorWasActive` tracks the previous
    // frame's active flag so a fresh off→on toggle re-arms. Both reset on (re)start / stop.
    std::array<std::uint8_t, kMaxEnvelopeTracks> locatorEngaged {};
    std::array<std::uint8_t, kMaxEnvelopeTracks> locatorWasActive {};

    // Seamless "Run" pattern-scene switch one-shot (per track). Armed (=1) for every track at a
    // seamless-switch install; consumed on the FIRST step the trigger loop processes for that track
    // after the switch, then cleared. While armed, a track's current voice is resumed mid-sample at
    // the running position instead of waiting to re-trigger from its owner: REG multi-step cells via
    // the prevResolvedStep-reset mid-cell entry, OWN (playbackMode 3) multi-step cells via the same
    // entry path, and OWN SINGLE-step long samples (the common owner-mode case, cellLength==1, whole
    // sample plays from one step) via a backscan to the most-recent active owner. A strict per-track
    // one-shot so locator/skip-step jumps keep the normal owner-skip. Reset on (re)start / stop / seek.
    std::array<std::uint8_t, kMaxEnvelopeTracks> switchResumePending {};

    // ── Deck pattern anchor ──────────────────────────────────────────────────────────────────
    // The absolute masterStep at which the current musical cycle 0 began. Pattern position is
    // resolved from the MUSICAL step (masterStep − patternAnchorStep); masterStep itself stays a
    // monotonic absolute clock and never jumps on the sample-exact switch path. The anchor moves
    // ONLY at: a scheduled pattern-scene switch boundary (so the incoming scene starts at ITS
    // step 0 while the boundary is quantized to the OUTGOING scene's own LCM cycle), a seek
    // (anchor = masterStep − target), the late/fallback switch install (anchor = masterStep), and
    // the start/stop reset (0). Run-immediate/seamless switches deliberately keep it — both scenes
    // share the current cycle anchor, which is all "continue at the running position" needs.
    // Signed: every write keeps anchor ≤ masterStep, so the musical step is provably ≥ 0, but the
    // subtraction is done in int64 to make that a checkable property rather than an underflow.
    std::int64_t patternAnchorStep = 0;
    // Deferred anchor move for the sample-exact (early) switch install: holds the ABSOLUTE
    // masterStep of the boundary crossing (= patternAnchorStep + musical boundary). Applied at the
    // top of the frame iteration that reaches it — BEFORE the frame's musical-step locals are
    // taken — so the crossing frame already resolves in the new scene's space (step 0), and the
    // pending one-shot riders below (preBoundaryFreezeUntilStep, sceneCutAtStep) are REBASED by
    // the same delta at that moment. -1 = none. ⚠️ The member default is load-bearing: the
    // quantized-launch rising edge resets the whole struct via `rs = {}`. Audio-thread only.
    std::int64_t pendingAnchorStep = -1;

    // Sample-exact pattern-scene switch (early install): when the parked switch world is installed
    // in the block that CONTAINS the boundary crossing (instead of one block after it), triggers
    // must stay suppressed for the residue of the old pattern's final step — the new world is
    // already installed but its pattern must not fire before the boundary frame. Mirrors
    // switchFreezeGated from the other side; cleared per-frame once the musical step reaches the
    // boundary. -1 = inactive. MUSICAL step domain (rebased when the anchor moves). Audio-thread only.
    std::int64_t preBoundaryFreezeUntilStep = -1;

    // Scene glide: frames remaining of the pattern-switch settings glide (armed from the installed
    // world's patternSwitchGlideFrames at every switch-install shape, deck 0 only). While non-zero,
    // the per-block track-base ramp seeding stretches the volume/pan/tone/pitch lanes over the
    // REMAINING frames instead of the 4 ms declick — a linear audio-thread glide from each lane's
    // current value to the new scene's value, self-correcting per block. 0 = no glide in flight.
    std::uint32_t sceneGlideFramesRemaining = 0;

    // Scene clean-cut one-shot: at the first frame where the MUSICAL step reaches this step, every
    // still-ringing voice is faded over the choke fade (~10 ms) BEFORE that frame's triggers are
    // evaluated, so the old scene stops cleanly under the new scene's downbeat and boundary-frame
    // voices are never cut. FX/send tails deliberately keep ringing. -1 = none pending.
    // MUSICAL step domain (rebased when the anchor moves).
    std::int64_t sceneCutAtStep = -1;

    // Quantized launch gating (sample-accurate DJ deck launch). While `transportHeld` is true the
    // deck renders silence with its transport frozen at masterStep (its stretcher still runs, so it
    // stays warm). On release the core clears transportHeld and sets `launchLeadInFrames`: a count
    // of leading source frames to keep silent so the deck's step-0 downbeat lands on the exact
    // output frame where the reference deck crosses its quantize boundary (sub-block alignment).
    bool transportHeld = false;
    std::uint64_t launchLeadInFrames = 0;

    // Fractional carry for the bus source-frame rate. inFrames is floored each callback and the
    // remainder is carried forward so the long-run average equals framesToRender/busRatio exactly.
    // Without this, per-callback rounding biases each deck's tempo by a fixed sub-frame amount and
    // two stretch-synced decks (different busRatios) slide apart linearly with no re-lock.
    double srcFrameRemainder = 0.0;
};

// Per-deck parameters that vary between the three DJ decks.
// The sequencer snapshot carries timing/track data; this carries the crossfader
// gain and the bus-level tempo-stretch ratio that the device host will apply with
// a single R3 RubberBandStretcher after the deck's voices have been mixed down.
struct DeckWorld {
    NativeSequencerSnapshot snapshot;
    float crossfaderGain = 1.0f;   // 0–1 from the DJ crossfader position
    double tempoSyncRatio = 1.0;   // target_bpm / deck_bpm; 1.0 = no stretch
    bool active = false;           // false → render silence for this deck slot
    // Split/exclusive routing: when true the deck is routed to its own dedicated
    // hardware channels and is EXCLUDED from the crossfader main mix (and its deck
    // lane carries full-level output). When false the deck rides the main mix scaled
    // by crossfaderGain and its deck lane is silent.
    bool dedicatedOutput = false;
    // Quantized launch: when true the deck's audio config is loaded but its transport is held
    // (rendering silence, stretcher kept warm) until the core releases it at the quantize boundary
    // chosen by the matching requestQuantizedLaunch() command. Cleared by the launcher once the
    // fired-ack is observed. Ignored in single-deck (composition) mode.
    bool launchArmed = false;
};

struct RenderWorld {
    std::uint64_t generation = 0;
    // Monotonic live-control epoch captured when this world was published (see LiveTrackControl).
    // A per-track scalar override is honored on the audio thread only while its own epoch is newer
    // than this, i.e. until a republished world carries the same value and supersedes the override.
    std::uint64_t liveControlEpochAtPublish = 0;
    MixerState mixerState;
    // Single-deck path (composition mode and legacy DJ shadow).
    // decks is authoritative when djMode == true; sequencerState is used otherwise.
    NativeSequencerSnapshot sequencerState;
    bool djMode = false;
    std::array<DeckWorld, kMaxDecks> decks {};
    // Sample PCM is reference-counted, not copied: publishing a new world (e.g. on every
    // parameter drag) copies only the shared_ptrs, so dragging pitch/volume during playback
    // no longer deep-copies megabytes of audio per state push. Voices hold raw pointers into
    // the pointed-to NativeSample, which stays alive as long as any world referencing it does.
    std::unordered_map<std::string, std::shared_ptr<const NativeSample>> samples;
    std::vector<std::string> unsupportedFeatures;
    std::size_t sampleBytes = 0;
};

struct OfflineRenderResult {
    std::vector<float> left;
    std::vector<float> right;
    std::vector<NativeTriggerEvent> triggerEvents;
    std::vector<std::string> unsupportedFeatures;
    std::uint32_t droppedVoiceCount = 0;
    std::uint32_t stolenVoiceCount = 0;
    std::uint32_t peakVoiceCount = 0;
    std::uint32_t triggerOverflowCount = 0;
    std::uint64_t worldGeneration = 0;
    std::uint64_t renderDurationNanoseconds = 0;
    std::size_t worldSampleBytes = 0;
};

// Quantized DJ deck launch boundary parameters (RT-safe, small lock-free atomic). Set off the audio
// thread via requestQuantizedLaunch(); read in the DJ render branch only while the deck is held.
// The *held* state itself is driven by DeckWorld::launchArmed (which travels atomically with the
// world), so the command and the world publish can arrive in any order — this only supplies the
// reference deck and granularity used to pick the release frame. armed==0 means "no params yet"
// (the deck stays held, silent) until a command arrives.
struct QuantizedLaunchCommand {
    std::uint16_t quantizeSteps = 1;    // boundary granularity in steps; for "cycle" pass the LCM
    std::uint8_t  refDeck = 0;          // reference deck index whose boundary we align to (0..2)
    std::uint8_t  armed = 0;            // 1 = params valid (may release at boundary); 0 = none
};
static_assert(sizeof(QuantizedLaunchCommand) == 4,
              "QuantizedLaunchCommand must be 4 bytes for a lock-free atomic");

class NativeMidiClockOut;
class NativeMidiNoteOut;

// ── Expressive MIDI note generation ──────────────────────────────────────────────────────────
// A MIDI/instrument track reads the SAME per-cell data the sample path does — cell length,
// accent, chord, flam, pre-silence, glide — and turns it into real MIDI. That needs state the
// old monophonic "one note-on per boundary" generator never had: notes that end (a gate), notes
// that stack (a chord), notes that repeat (a flam), notes that arrive late (pre-silence), and
// notes that slide (glide). This is that state, one voice per (deck, track).
//
// Everything here is AUDIO-THREAD ONLY, and every duration is a frame countdown decremented once
// per rendered frame — never a wall-clock or absolute-frame deadline, because framesPerStep moves
// with the tempo and the generator is only called while the transport is actually running.

// Where generated MIDI goes: a hosted instrument plugin (in-process, sample-offset MIDI buffer)
// or the external hardware sender. One shape, so the note generator is written exactly once.
struct NativeMidiSink {
#if SCOOPY_PLUGIN_HOST
    NativeInstrumentSlot* slot = nullptr;   // non-null → hosted instrument
#endif
    NativeMidiNoteOut* out = nullptr;       // non-null → external hardware
    std::uint64_t blockHostTime = 0;        // mach host time at frame 0 of this block (external only)
    double sampleRate = 44100.0;
};

// Root + chord voices sounding together from ONE cell.
inline constexpr std::size_t kMaxMidiHeldNotes = 1 + static_cast<std::size_t>(kMaxChordExtraNotes);
// A flam fans up to kMaxFlam hits; one extra slot covers the pre-silence-delayed root.
inline constexpr std::size_t kMaxMidiPendingHits = static_cast<std::size_t>(kMaxFlam) + 1;
// Tracks per deck carrying expressive MIDI voice state. Above this a track still plays (the
// generator falls back to the plain note-on path) but gets no gate/chord/flam/glide.
inline constexpr std::size_t kMaxMidiVoiceTracks = 128;
// Assumed pitch-bend sensitivity of the receiving synth. 2 semitones is the MIDI-spec default;
// a glide wider than this cannot be reached by bend alone, so the generator rides the bend to the
// edge of the range and then RE-TRIGGERS the target note at the end of the ramp — you always land
// in tune, at the cost of an audible re-articulation on big leaps.
inline constexpr int kMidiBendRangeSemitones = 2;
// Bend-message spacing during a glide (~5 ms → ~200 Hz, smooth without flooding the port).
inline constexpr double kMidiBendIntervalSeconds = 0.005;

// One scheduled note-on (a flam repeat, or the root delayed by pre-silence), with the note-off
// gate it will carry once it fires.
struct NativeMidiPendingHit {
    std::int32_t framesLeft = -1;     // -1 = free slot; 0 fires this frame
    std::int32_t gateFrames = 0;      // note-off countdown armed when the hit fires (0 = hold)
    std::uint8_t velocity = 0;
    std::int8_t notes[kMaxMidiHeldNotes] { -1, -1, -1, -1 };   // -1 = unused voice
};

struct NativeMidiVoiceState {
    // Sounding notes and their remaining gate. -1 note = free slot; -1 frames = hold until the
    // next trigger releases it (the pre-gate behaviour, kept for velocity-0 / legacy patterns).
    std::array<std::int16_t, kMaxMidiHeldNotes> heldNote { -1, -1, -1, -1 };
    std::array<std::int32_t, kMaxMidiHeldNotes> heldFrames { -1, -1, -1, -1 };
    std::uint8_t heldChannel = 0;

    std::array<NativeMidiPendingHit, kMaxMidiPendingHits> pending {};

    // Glide = legato (no re-articulation) + a pitch-bend ramp across the junction.
    std::int32_t glideFramesLeft = 0;     // > 0 while the ramp runs
    std::int32_t glideTotalFrames = 0;
    std::int32_t bendTickFrames = 0;      // frames until the next bend message
    float bendFromSemis = 0.0f;
    float bendToSemis = 0.0f;
    bool  bendActive = false;             // a non-zero bend is applied → reset before the next hard note
    // Leap wider than the bend range: the note to re-trigger when the ramp lands.
    std::int16_t glideLandNote = -1;
    std::uint8_t glideLandVelocity = 0;
    std::int32_t glideLandGate = 0;

    // Track DSP dials mapped to CC on a MIDI-OUT-only track (no audio path to move). -1 = never sent.
    std::int16_t lastVolumeCC = -1;   // CC 7
    std::int16_t lastPanCC = -1;      // CC 10
    std::int16_t lastToneCC = -1;     // CC 74
    std::int32_t ccTickFrames = 0;    // min spacing between CC bursts, so a fader sweep can't flood the port
};

// A track can drive BOTH a hosted instrument and an external port at once (layer a soft synth over
// hardware), and each destination must keep its own held notes / gates / glide — one shared voice
// would have them stomping each other. So a voice is per (deck, track, destination).
enum class NativeMidiDest : std::size_t { external = 0, instrument = 1, count = 2 };
inline constexpr std::size_t kMidiDestCount = static_cast<std::size_t>(NativeMidiDest::count);

class NativeAudioEngineCore {
public:
    static constexpr std::size_t laneCount = static_cast<std::size_t>(AudioLane::count);

    NativeAudioEngineCore();

    /// Wire (or clear) the sample-accurate MIDI clock-out generator. When set + enabled, render()
    /// feeds it each block's transport + audible tempo so it can emit 24-PPQN clock phase-locked to
    /// the audio. Owned by the bridge; the core only borrows the pointer. RT-safe to read.
    void setMidiClockOut(NativeMidiClockOut* clockOut) noexcept { midiClockOut_ = clockOut; }

    /// Wire (or clear) the sample-accurate MIDI note-out generator. When set + enabled, the sequencer
    /// emits note-on/off/pitch-bend for external `.midiOut` tracks (no hosted instrument) from the
    /// render callback, phase-locked to audio. Owned by the bridge; the core only borrows the pointer.
    void setMidiNoteOut(NativeMidiNoteOut* noteOut) noexcept { midiNoteOut_ = noteOut; }

    bool configure(double sampleRate, std::uint32_t bufferSizeFrames, std::uint32_t hardwareLatencyFrames);

    // FX-return routing mode (1 = external out, 2 = host plugin). Mode 0 (legacy
    // internal delay) is retired — a return is either external or a hosted plugin.
    // Set imperatively from the bridge; read lock-free on the audio thread.
    void setReturnMode(int returnIndex, std::uint8_t mode) noexcept {
        if (returnIndex >= 1 && returnIndex <= static_cast<int>(kNumSends))
            returnMode_[returnIndex - 1].store(mode, std::memory_order_release);
    }

    // Per-return output destination for a HOST (plugin) return: false = sum the plugin wet into
    // the main mix (default), true = route the (mono-folded) plugin wet to this return's dedicated
    // send hardware channel and remove it from the main mix. Mirrors the external-return routing.
    // No effect on external returns. Set from the bridge; read lock-free on the audio thread.
    void setReturnHardwareOut(int returnIndex, bool toHardware) noexcept {
        if (returnIndex >= 1 && returnIndex <= static_cast<int>(kNumSends))
            returnHardwareOut_[returnIndex - 1].store(toHardware, std::memory_order_release);
    }

    // AUDIO-THREAD probe (P6-3): is return 1…4 a LIVE host return this block —
    // host mode, wet summed to main (not hardware), plugin actually loaded?
    // Every read is an atomic; never the slot mutex (the message thread holds
    // that across a load swap). The host's strip-send feed keys off this, so a
    // hostless/stub build — where it is constant false — feeds nothing and
    // stays sample-identical to the flag-OFF world.
    bool returnHostActive(int returnIndex) noexcept {
#if SCOOPY_PLUGIN_HOST
        if (returnIndex < 1 || returnIndex > static_cast<int>(kNumSends)) return false;
        const auto i = static_cast<std::size_t>(returnIndex - 1);
        if (returnMode_[i].load(std::memory_order_acquire) != 2) return false;
        if (returnHardwareOut_[i].load(std::memory_order_acquire)) return false;
        return returnPluginSlot(returnIndex).isLoadedLockFree();
#else
        (void) returnIndex;
        return false;
#endif
    }

    // AUDIO THREAD (P6-3): the HOST's own feed into a return plugin, ADDED to
    // the send lane's content at the moment the plugin consumes it. Exists
    // because a host mixing sources AFTER render() (the plane's tape strips)
    // cannot reach the send lanes any other way: render() rebuilds those lanes
    // from the world every block, so anything pre-seeded is overwritten. The
    // caller fills sendIndex 0…3 for `frameCount` frames before render() (same
    // thread, same block); the feed is consumed only by a live host return.
    // Null when the host is compiled out — callers must check.
    float* hostSendFeed(int sendIndex, std::uint32_t frameCount) noexcept {
#if SCOOPY_PLUGIN_HOST
        if (sendIndex < 0 || sendIndex >= static_cast<int>(kNumSends)) return nullptr;
        auto& f = hostSendFeed_[static_cast<std::size_t>(sendIndex)];
        return f.size() >= frameCount ? f.data() : nullptr;
#else
        (void) sendIndex; (void) frameCount;
        return nullptr;
#endif
    }

    // AUDIO THREAD (P3.5-E3): this deck's DRY stereo output for the block just
    // rendered — the tap a host needs to route a deck into its own mixer
    // (record the deck, chain it into a looper strip). `channel` 0 = L, 1 = R.
    //
    // WHAT IT IS, precisely: post-voice, post-bus-stretch, post-carve, and
    // PRE-crossfader-gain / PRE-deck-drive — the deck's SIGNAL, not its
    // contribution to the mix. That is the tap point the strip model asks for
    // (an element is what a strip carries; level comes after), and it is why
    // this is not simply the deck's output LANE: those carry a deck only when
    // it is split to a dedicated output, and a host mapping lanes to hardware
    // would then find the deck on physical outs as well as in main.
    //
    // An output-MUTED deck still reports its signal, matching the mute rule
    // everywhere else here (mute is an output stage — a muted deck's FX-send
    // wet still returns). An inactive deck reports silence, not stale audio.
    //
    // Null for an out-of-range deck/channel or before configure(). Valid until
    // the next render() on the same thread.
    const float* deckDryOut(int deck, int channel, std::uint32_t frameCount) const noexcept {
        if (deck < 0 || deck >= static_cast<int>(kMaxDecks) || channel < 0 || channel > 1)
            return nullptr;
        const auto& b = (channel == 0 ? deckStretchOutL_ : deckStretchOutR_)
                            [static_cast<std::size_t>(deck)];
        return b.size() >= frameCount ? b.data() : nullptr;
    }

    // Is `deck`'s bus stretcher warmed up and able to stretch? While false the
    // core keeps that bus on its DRY path, so a deck asked to stretch during
    // warm-up plays at the WRONG TEMPO rather than merely late.
    //
    // Exposed for the plugin host (D-SL-DECKPLUGIN-01), which unlike the app
    // cannot shrug this off: a DAW may start the transport the instant the
    // plugin loads. Mirrors the tape side's sl_tape_stretch_ready.
    bool deckStretchReady(int deck) const noexcept {
        if (deck < 0 || deck >= static_cast<int>(kMaxDecks)) return false;
        return busStretcher_[static_cast<std::size_t>(deck)].isWarm();
    }

    // Warm the bus stretchers ON THE CALLING THREAD during configure() instead
    // of on background threads. MUST be set before configure() to have effect.
    //
    // Default false — the APP's behaviour is unchanged, and deliberately so:
    // async warm-up exists because a blocking configure() cost the app a
    // ~660 ms launch hang (see the note at the configure() call site).
    //
    // A PLUGIN wants the opposite trade, and NativeBusStretcher says as much:
    // hosts expect prepareToPlay to block, and auval renders immediately after
    // it returns. Paying ~200 ms/deck once at load beats a first bar that
    // silently plays un-stretched.
    void setStretchWarmupSynchronous(bool sync) noexcept { syncStretchWarmup_ = sync; }

    // Group delay (frames) of a deck's bus stretcher at its CURRENT texture —
    // what a plugin host must report for delay compensation.
    //
    // Added for the ScoopyDeck plugin (D-SL-DECKPLUGIN-01): a DAW needs a
    // number for setLatencySamples, and the stretcher's own
    // startupLatencyFrames() was unreachable from outside the core. Read-only,
    // adds no state and changes no behaviour.
    //
    // ⚠️ IT VARIES WITH TEXTURE (the node bank's window sizes differ), so a
    // host must NOT re-report it every time the texture control moves — PDC
    // churn mid-performance is worse than a slightly wrong constant. Sample it
    // when the tempo MODE changes and hold it.
    //
    // 0 before configure(), and 0 is also the honest answer for a deck whose
    // bus is on its dry path — but a host wanting a stable figure should ask
    // once while configured rather than track engagement.
    int deckStretchLatencyFrames(int deck) const noexcept {
        if (deck < 0 || deck >= static_cast<int>(kMaxDecks)) return 0;
        return busStretcher_[static_cast<std::size_t>(deck)].startupLatencyFrames();
    }

    // Per-return WET output level for the extended host returns (sends 3 & 4). Returns 1 & 2 take
    // their volume from the ReturnTrack snapshot (full gate/pan/LFO path); sends 3 & 4 use this
    // lightweight imperative level (the "Return level" fader) applied to the host-plugin wet. Set
    // from the bridge; read lock-free on the audio thread. Default unity.
    void setReturnVolume(int returnIndex, float volume) noexcept {
        if (returnIndex >= 1 && returnIndex <= static_cast<int>(kNumSends))
            returnVolume_[returnIndex - 1].store(volume, std::memory_order_release);
    }

    // Per-send INPUT "send master": scales the summed send bus before it feeds the
    // plugin (host) or the external hardware out. Symmetric across both modes. Set
    // imperatively from the bridge; read lock-free on the audio thread.
    void setSendInputGain(int returnIndex, float gain) noexcept {
        if (returnIndex >= 1 && returnIndex <= static_cast<int>(kNumSends))
            sendInputGain_[returnIndex - 1].store(gain, std::memory_order_release);
    }

    // Per-send fader tap point: true = post-fader (the send scales with the source track's
    // volume fader + its LFO vol modulation — the legacy behavior), false = pre-fader (the
    // send ignores the volume fader, keeping pan + envelope shaping). Global per send bus.
    // Set imperatively from the bridge; read lock-free on the audio thread.
    void setSendPostFader(int returnIndex, bool postFader) noexcept {
        if (returnIndex >= 1 && returnIndex <= static_cast<int>(kNumSends))
            sendPostFader_[returnIndex - 1].store(postFader, std::memory_order_release);
    }

    // Per-track output routing master switch: see perTrackRoutingActive_. Set imperatively from
    // the bridge (per-device Audio Settings toggle); read lock-free on the audio thread.
    void setPerTrackRoutingActive(bool active) noexcept {
        perTrackRoutingActive_.store(active, std::memory_order_release);
    }

    // Mixer-console deck output mute (deck 0 = A / composition, 1 = B, 2 = C). Silences only the
    // deck's dry main contribution (post send-tap), so its FX-send wet still returns. Set
    // imperatively from the bridge; read lock-free on the audio thread.
    void setDeckOutputMuted(int deck, bool muted) noexcept {
        if (deck >= 0 && deck < static_cast<int>(kMaxDecks))
            deckOutputMuted_[deck].store(muted, std::memory_order_release);
    }

    // Solo-induced mute for an FX return/send (returnIndex 1 or 2). OR'd with the panic mute on
    // the audio thread. Set imperatively from the bridge; read lock-free on the audio thread.
    void setSendSoloMuted(int returnIndex, bool muted) noexcept {
        if (returnIndex >= 1 && returnIndex <= static_cast<int>(kNumSends))
            sendSoloMuted_[returnIndex - 1].store(muted, std::memory_order_release);
    }

    // Mic input channel controls. Lock-free; read on the audio thread.
    void setMicGain(float gain) noexcept { micGain_.store(gain, std::memory_order_release); }
    void setMicMonitorOn(bool on) noexcept { micMonitorOn_.store(on, std::memory_order_release); }
    void setMicMuted(bool muted) noexcept { micMuted_.store(muted, std::memory_order_release); }
    // Mic → FX send level (returnIndex 1‥kNumSends): how much gained mic feeds
    // that send bus. Widened from 2 buses to 4 (MIX-NATIVE-3) — the missing two
    // were the only reason the INPUT strip had to show inert send cells.
    void setMicSendLevel(int returnIndex, float level) noexcept {
        if (returnIndex >= 1 && returnIndex <= static_cast<int>(kNumSends))
            micSendLevel_[returnIndex - 1].store(level, std::memory_order_release);
    }
    // Deck-master → FX send level (deck 0‥kMaxDecks-1, returnIndex 1‥kNumSends): taps the deck's
    // full summed output into that send bus. Pre-fader/pre-mute master-send semantics, matching
    // the per-track sends: independent of crossfader/deck volume, and a console/dry mute keeps
    // the wet returning. Set imperatively from the bridge; read lock-free on the audio thread.
    void setDeckMasterSend(int deck, int returnIndex, float level) noexcept {
        if (deck < 0 || deck >= static_cast<int>(kMaxDecks)) return;
        if (returnIndex < 1 || returnIndex > static_cast<int>(kNumSends)) return;
        const float clamped = level < 0.0f ? 0.0f : (level > 1.0f ? 1.0f : level);
        deckMasterSend_[static_cast<std::size_t>(deck)][static_cast<std::size_t>(returnIndex - 1)]
            .store(clamped, std::memory_order_release);
    }

    // Peak |sample| of the gained mic input since the last call, then reset. For a UI level meter.
    float consumeInputPeak() noexcept { return inputPeak_.exchange(0.0f, std::memory_order_acq_rel); }

    // ── Live per-track control overrides (analog-desk immediacy) ─────────────────────────────────
    // A fader move (volume/pan/tone/send) on a track writes the value here immediately, so the render
    // loop hears it on ALREADY-RINGING voices too — the published snapshot bakes the base values into
    // a voice at trigger time, so without this a fader only affects the NEXT trigger. Cheap (one atomic
    // store + epoch bump) so the UI need not republish the whole world snapshot per drag tick. The value
    // is honored until the next (coalesced) world republish carries the same value, at which point
    // control hands back to the snapshot seamlessly (epoch gate). deck 0‥kMaxDecks-1,
    // track 0‥kMaxEnvelopeTracks-1, sendIndex 1‥kNumSends; out-of-range is a silent no-op. Lock-free:
    // written on the control thread, read on the audio thread.
    void setTrackVolumeOverride(int deck, int track, float value) noexcept {
        if (auto* c = liveControlSlot(deck, track)) {
            c->volume.store(value, std::memory_order_release);
            c->volumeEpoch.store(nextLiveControlEpoch(), std::memory_order_release);
        }
    }
    void setTrackPanOverride(int deck, int track, float value) noexcept {
        if (auto* c = liveControlSlot(deck, track)) {
            c->pan.store(value, std::memory_order_release);
            c->panEpoch.store(nextLiveControlEpoch(), std::memory_order_release);
        }
    }
    void setTrackToneOverride(int deck, int track, float value) noexcept {
        if (auto* c = liveControlSlot(deck, track)) {
            c->tone.store(value, std::memory_order_release);
            c->toneEpoch.store(nextLiveControlEpoch(), std::memory_order_release);
        }
    }
    void setTrackToneQOverride(int deck, int track, float value) noexcept {
        if (auto* c = liveControlSlot(deck, track)) {
            c->q.store(value, std::memory_order_release);
            c->qEpoch.store(nextLiveControlEpoch(), std::memory_order_release);
        }
    }
    void setTrackSendOverride(int deck, int track, int sendIndex, float level) noexcept {
        if (sendIndex < 1 || sendIndex > static_cast<int>(kNumSends)) return;
        if (auto* c = liveControlSlot(deck, track)) {
            c->send[sendIndex - 1].store(level, std::memory_order_release);
            c->sendEpoch[sendIndex - 1].store(nextLiveControlEpoch(), std::memory_order_release);
        }
    }

    // ── Live deck / return-level overrides (mixer-row immediacy) ─────────────────────────────────
    // Same epoch model as the per-track overrides, at bus granularity: the toolbar deck fader and
    // the FX-return output fader write here imperatively so the audio thread hears the move THIS
    // block instead of waiting for the coalesced world republish. The value replaces the world's
    // deck crossfaderGain / return-snapshot volume until a republished world (stamped with a newer
    // epoch, carrying the same value) supersedes it. deck 0‥kMaxDecks-1; returnIndex 1‥2 (returns
    // 3 & 4 are already imperative via setReturnVolume). Out-of-range is a silent no-op.
    void setDeckGainOverride(int deck, float value) noexcept {
        if (deck < 0 || deck >= static_cast<int>(kMaxDecks)) return;
        auto& o = deckGainOverride_[static_cast<std::size_t>(deck)];
        o.value.store(value, std::memory_order_release);
        o.epoch.store(nextLiveControlEpoch(), std::memory_order_release);
    }
    void setReturnVolumeOverride(int returnIndex, float value) noexcept {
        if (returnIndex < 1 || returnIndex > 2) return;
        auto& o = returnVolumeOverride_[static_cast<std::size_t>(returnIndex - 1)];
        o.value.store(value, std::memory_order_release);
        o.epoch.store(nextLiveControlEpoch(), std::memory_order_release);
    }
#if SCOOPY_PLUGIN_HOST
    // Plugin slot for a return (returnIndex 1…kNumSends). Driven by the bridge, which
    // owns the scanner. Returns slot 1 for any out-of-range index.
    NativePluginSlot& returnPluginSlot(int returnIndex) noexcept {
        switch (returnIndex) {
            case 2:  return returnPluginSlot2_;
            case 3:  return returnPluginSlot3_;
            case 4:  return returnPluginSlot4_;
            default: return returnPluginSlot1_;
        }
    }
    // Synchronous, main-thread-only. Destroys every hosted plugin instance before
    // returning. Call during applicationWillTerminate (before shutdownJuce_GUI) so
    // plugins are torn down deterministically rather than leaking past exit().
    void teardownPluginsNow() noexcept {
        returnPluginSlot1_.destroyNow();
        returnPluginSlot2_.destroyNow();
        returnPluginSlot3_.destroyNow();
        returnPluginSlot4_.destroyNow();
        for (auto& s : instrumentSlots_) s.destroyNow();
    }

    // ── Per-track instrument hosting ───────────────────────────────────────────────
    // Bounded pool of instrument plugin slots, each bound to one (deck, track). Decks A/B/C all
    // render through this one core, so the slot key packs the deck so the same track index on
    // different decks never collides. MIDI in → audio summed into that deck's main + send buses.
    static constexpr std::size_t kMaxInstrumentSlots = 12;
    // Pack/unpack a (deck, trackIndex) slot key. −1 = free. deck 0‥3, track 0‥65535.
    static constexpr int packInstrumentKey(int deck, int track) noexcept {
        return (deck << 16) | (track & 0xFFFF);
    }

    // Runtime feature flag. When false the render path skips all instrument processing (zero added
    // cost) so the feature stays opt-in until profiled. Lock-free; set from the bridge.
    void setInstrumentHostingEnabled(bool enabled) noexcept {
        instrumentHostingEnabled_.store(enabled, std::memory_order_release);
    }
    bool instrumentHostingEnabled() const noexcept {
        return instrumentHostingEnabled_.load(std::memory_order_acquire);
    }

    // CONTROL THREAD (serialized by the bridge). Return the slot bound to (deck, trackIndex),
    // allocating + binding a free slot if none yet. Returns nullptr if all slots are in use.
    NativeInstrumentSlot* acquireInstrumentSlotForTrack(int deck, int trackIndex) noexcept;
    // CONTROL THREAD. Return the slot already bound to (deck, trackIndex), or nullptr (no allocation).
    NativeInstrumentSlot* instrumentSlotForTrack(int deck, int trackIndex) noexcept;
    // CONTROL THREAD. Unload + unbind the slot bound to (deck, trackIndex) (no-op if none).
    void releaseInstrumentSlotForTrack(int deck, int trackIndex) noexcept;
    // CONTROL THREAD. Unload + unbind every instrument slot (clean slate, e.g. before a session load).
    void releaseAllInstrumentSlots() noexcept {
        for (std::size_t i = 0; i < kMaxInstrumentSlots; ++i) {
            if (instrumentSlotKey_[i].load(std::memory_order_acquire) >= 0) {
                instrumentSlotKey_[i].store(-1, std::memory_order_release);
                instrumentSlots_[i].unload();
            }
        }
    }
    // CONTROL or AUDIO THREAD. Queue all-notes-off/all-sound-off on every bound instrument (panic;
    // also used on transport stop/seek to avoid hung notes).
    void allInstrumentsNotesOff() noexcept {
        for (std::size_t i = 0; i < kMaxInstrumentSlots; ++i)
            if (instrumentSlotKey_[i].load(std::memory_order_acquire) >= 0)
                instrumentSlots_[i].allNotesOff();
    }
#endif
    bool start() noexcept;
    void stop() noexcept;
    bool submitMixerState(const MixerState& state);
    // Composition mode / single-deck path (unchanged from original API).
    std::uint64_t publishSequencerState(const NativeSequencerSnapshot& snapshot);
    // DJ mode: publish up to kMaxDecks decks in one atomic world swap.
    // Each active deck carries its own snapshot, crossfader gain, and tempo-sync ratio.
    // The returned generation can be used with acknowledgedWorldGeneration() for parity.
    std::uint64_t publishDJWorld(const std::array<DeckWorld, kMaxDecks>& decks,
                                 const MixerState& mixer);
    std::uint64_t publishedWorldGeneration() const noexcept;
    std::uint64_t acknowledgedWorldGeneration() const noexcept;
    std::size_t retainedWorldCount() const noexcept;

    // Live one-shot voice triggers (finger drum / musical keyboard / sample+chop preview).
    // RT-safe: pushes onto a lock-free SPSC ring drained at the top of render(). Safe to call
    // off the audio thread (the bridge serializes producers on its control queue). Drops the
    // command (bumping liveTriggerOverflowCount diagnostics) if the ring is full; never blocks.
    void enqueueLiveTrigger(const LiveTriggerCommand& command) noexcept;
    void enqueueLiveStop(std::uint8_t deck, std::uint32_t trackIndex, std::uint64_t voiceId) noexcept;

    void render(const float* inputLeft,
                const float* inputRight,
                const std::array<float*, laneCount>& outputs,
                std::uint32_t frameCount) noexcept;

    Diagnostics diagnostics() const noexcept;
    BenchmarkResult runImpulseBenchmark(std::uint32_t callbackCount);
    bool registerSample(NativeSample sample);
    void retainSamples(const std::vector<std::string>& sampleIds);
    std::size_t registeredSampleCount() const noexcept;
    std::size_t registeredSampleBytes() const noexcept;

    // Per-deck sequencer playhead (absolute step the native engine is currently rendering).
    // In TS sync this advances at the synced/audible tempo — the bus stretch ratio is folded
    // into the per-callback source-frame count — so the UI playhead can follow the real audio
    // instead of a separate native-tempo clock. Lock-free; safe to read off the audio thread.
    std::uint64_t deckPlayheadStep(std::size_t deck) const noexcept;

    // Lag-free reset of the published UI playhead step (default 0). Called from the main thread at
    // transport start so a UI poll arriving before the first render callback reads the fresh start
    // step rather than the stale last-played step. Safe cross-thread store; the audio thread
    // re-publishes the real step each callback.
    void resetDeckPlayheadStep(std::size_t deck, std::uint64_t step = 0) noexcept;

    // True once the render thread has actually published this deck's playhead since the last
    // transport start — i.e. the value in deckPlayheadStep() is the CURRENT audible step, not a
    // frozen leftover. False after resetDeckPlayheadStep() and while the transport is stopped, so
    // callers can distinguish "clock live at step N" from "atomic parked at step N" during the
    // device warmup window (the arbiter flips ownership before the device actually renders).
    // Lock-free; safe to read off the audio thread.
    bool deckClockLive(std::size_t deck) const noexcept;

    // Skip-step / seek: request the deck's playhead jump to an absolute step at the next step
    // boundary (and keep playing). RT-safe (single atomic); applied in render(). A negative value
    // is ignored. Combined with mid-cell entry, landing inside an extended reg cell plays its slice.
    void requestSeek(std::size_t deck, std::int64_t step) noexcept;

    // Quantized launch (DJ mode): arm `deck` to start the instant `refDeck` crosses its next
    // masterStep that is a multiple of `quantizeSteps`. The deck must already be published into the
    // world as active + launchArmed with snapshot.startStep set to the desired start step (so its
    // samples/tracks are loaded and its start position known). RT-safe (single atomic); the boundary
    // is resolved inside render() against the reference deck's live transport, so there is no
    // UI-thread polling jitter. cancelQuantizedLaunch() disarms a pending launch.
    void requestQuantizedLaunch(std::size_t deck, std::size_t refDeck,
                                std::uint16_t quantizeSteps) noexcept;
    void cancelQuantizedLaunch(std::size_t deck) noexcept;
    // Monotonic counter bumped each time a quantized launch fires for `deck`. The launcher tracks
    // the last-seen value to detect "audio actually started" and clear its pending UI state.
    std::uint32_t launchFiredSequence(std::size_t deck) const noexcept;

    // The patternSwitchEventID of the most recently INSTALLED switch-tagged world (any shape:
    // scheduled boundary install or seamless-run). Swift's scheduled-switch commit poll compares
    // this to its armed eventID — the anchored (musical) playhead wraps to 0 at the boundary, so
    // "playhead reached the boundary" can no longer signal the commit. Lock-free; off-thread safe.
    std::uint64_t installedSwitchEventID() const noexcept {
        return installedSwitchEventID_.load(std::memory_order_acquire);
    }

    // Output meter: atomically read-and-reset the peak |sample| of the final main bus
    // observed since the last call. Lock-free; safe to call off the audio thread.
    float consumeOutputPeak() noexcept;

    // Background bass shake (UI ornament, not DSP): read-and-reset the peak of the
    // ~120 Hz-low-passed final mix since the last call. Same contract as
    // consumeOutputPeak; the only consumer is the window background layer's
    // shake driver (~30 Hz poll).
    float consumeLowBandPeak() noexcept;

    // UI: current smoothed envelope-follower level for a deck's source track (the value the
    // native env-follower detector feeds its LFOs). Best-effort plain read of persistent
    // per-deck render state for the LFO envelope-source monitor; safe to call off the audio
    // thread. Returns 0 for out-of-range indices or a track with no active follower.
    float deckEnvelopeLevel(std::size_t deck, std::size_t trackIndex) const noexcept;

    /// SIG-2 — how much X-MIX is currently EATING out of a carve node, per band.
    ///
    /// `carveStage_[node].gain[band]` is the duck actually applied to the audio this callback,
    /// so 1 - gain is "how much of this band has been taken away right now". Six bands per node
    /// (crossovers 60 / 200 / 600 / 1800 / 5000 Hz — kCarveCrossoverHz), 8 nodes (decks A/B/C,
    /// the four FX returns, and the input).
    ///
    /// The carve is the app's signature move and it has never had a picture. The mixer shows a
    /// fader that isn't moving while the sound hollows out underneath it, which makes the most
    /// characteristic thing the engine does look like nothing is happening.
    ///
    /// Returns 0 (nothing carved) for out-of-range indices. Plain read of persistent render
    /// state — same discipline as deckEnvelopeLevel; may be one callback stale, invisible at
    /// 30 Hz against a ~23 ms callback.
    float carveDepth(std::size_t node, std::size_t band) const noexcept;

    /// SIG-1 — where inside its SAMPLE a track's newest voice actually is, as a fraction of the
    /// source buffer (0…1). -1 when nothing is sounding on that track.
    ///
    /// This is the one number the grid could never know. The step index says which CELL is
    /// playing; this says where inside the audio, and those two disagree constantly — a REG cell
    /// spanning eight steps, a pitched or varispeed voice consuming its buffer faster than the
    /// clock, a reversed cell running backwards, an OWN tail still ringing three cells later.
    /// The UI draws the waveform from the same source frames, so a fraction is all it needs to
    /// put the playhead exactly where the sound is.
    ///
    /// Best-effort plain read of persistent per-deck render state (same discipline as
    /// deckEnvelopeLevel): safe off the audio thread, may be one callback stale — which is
    /// invisible at 30 Hz against a ~23 ms callback.
    float deckTrackSamplePos(std::size_t deck, std::size_t trackIndex) const noexcept;

    /// SIG-3 — is this track making SOUND right now? Decayed peak of the track's actual mix
    /// contribution (sampler voices, hosted instruments, grain pass — all post mute-gain, so a
    /// muted track reads 0), linear. Decays in the engine (~-60 dB in 300 ms), so reads are
    /// idempotent — any number of pumps may poll it. This is the one activity signal that
    /// survives transport stop: the playhead reads go to -1 the moment the sequencer stops,
    /// but a ringing plugin (arp, long release) keeps rendering, and this keeps reporting it.
    ///
    /// Best-effort plain read of persistent per-deck render state (same discipline as
    /// deckEnvelopeLevel). Returns 0 for out-of-range indices.
    float deckTrackMixLevel(std::size_t deck, std::size_t trackIndex) const noexcept;

    // Current per-deck modulation-channel output (channels 0…3), for the modulation monitor.
    // Already depth-scaled; bipolar (−1…1). Returns 0 for out-of-range indices.
    float deckModChannelValue(std::size_t deck, std::size_t channel) const noexcept;
    /// MOD-2: normalised progress (0…1) through this channel's shape, for the UI playhead that
    /// rides the drawn curve. -1 = no static shape (env-follower) or idle envelope.
    float deckModChannelPhase(std::size_t deck, std::size_t channel) const noexcept;

    // DEBUG/tuning: request a live reconfigure of the per-deck Signalsmith bus stretch window
    // (analysis block + hop interval, in frames). Applied at the top of the next render callback.
    // Safe to call off the audio thread. No-op on the RubberBand backend.
    // Continuous window-texture control (0…1 across the bus stretcher node bank, see
    // kBusTextureBlockMs): grainy/robotic small windows ↔ smeared spectral wash. Click-free
    // (primed node crossfade); replaces the old reallocating setBusStretchTuning.
    void setBusTexture(double texture01) noexcept;

    // Per-deck window texture (0…1 across the node bank) — same control as setBusTexture
    // but per deck, so each deck/session keeps its own grain character. All 6 nodes per
    // deck are pre-allocated at configure() regardless, and runtime cost tracks only the
    // ENGAGED nodes (already per-deck) — a per-deck target value costs nothing extra.
    void setDeckBusTexture(int deck, double texture01) noexcept;

    // Granular browse/scrub + pitch controls for the bus stretch (all decks). RT-safe.
    //   * browseEnabled    – when true, browseSpeed multiplies the BPM-sync playback speed;
    //                        when false the deck plays at the tempo-sync ratio (normal).
    //   * browseSpeed      – playback-speed multiplier: 1.0 = sync speed, 2.0 = 2× scrub,
    //                        0.0 ≈ freeze (a single source frame stretched across the output).
    //   * transposeSemis   – bus pitch shift, decoupled from time. 0 = none.
    //   * tonalityLimit    – formant-preservation limit (fraction of sample-rate); 0 = off.
    // Applied at the top of the next render callback. No window reconfigure → no glitch.
    void setBusGranularParams(bool browseEnabled, double browseSpeed,
                              double transposeSemis, double tonalityLimit) noexcept;

    // Per-deck bus transpose (semitones), realtime — bypasses the world publish so changes take
    // effect during running playback (applied on top of the global setBusGranularParams transpose).
    // RT-safe (stores an atomic; the render callback applies it via NativeBusStretcher::setTranspose).
    void setDeckBusTranspose(int deck, double semitones) noexcept;

    // Per-deck spectral color (realtime): chaos = −1…+1 freeze/extreme-stretch phase
    // character (+1 airy, 0 metallic, −1 rolling drone); airDb = post-stretch HF shelf
    // 0…12 dB.
    void setDeckBusSpectral(int deck, double chaos, double airDb) noexcept;

    // X-MIX carve (crossfader-driven complementary spectral mixing, realtime): this NODE's
    // output is band-ducked where the SOURCE nodes' spectra currently have energy, so the
    // two crossfader sides interlock. A node is a deck, an FX return or the audio input —
    // see kMaxCarveNodes. amount = 0…1 (Swift derives it from fader position × strength);
    // sourceMask = bitmask of node indices whose analysis feeds the carve (the opposite
    // crossfader side — per-band max across them); shimmer = 0…1 character blend: the ducked
    // bands are re-injected through resonant, slowly-moving, stereo-detuned bandpasses — the
    // other side's power makes this node RING instead of just dip (0 = pure duck).
    // sendSkipMask applies to DECK nodes only (XN-03): bit k = do not carve this deck's feed
    // to send k+1, because that return carves itself. Core stays policy-free.
    void setCarveAmount(int node, double amount, int sourceMask,
                        double shimmer, int sendSkipMask = 0) noexcept;

    // Tape reverse hold (DJ U/J): engage/release the looped backwards replay for a deck.
    // Lock-free; safe to call off the audio thread. Engaging captures the recent post-stretch
    // output and replays it backwards over one pattern cycle until released, then crossfades
    // back to the live forward signal. No-op in composition (single-deck) mode.
    void setTapeReverseHold(std::size_t deck, bool active) noexcept;
    OfflineRenderResult renderOffline(const NativeSequencerSnapshot& snapshot,
                                      std::uint64_t frameCount,
                                      std::uint32_t chunkSizeFrames) const;
    OfflineRenderResult renderPublishedWorld(std::uint64_t frameCount,
                                             std::uint32_t chunkSizeFrames);

private:
    std::unique_ptr<RenderWorld> buildWorld() const;
    std::uint64_t publishWorld(std::unique_ptr<RenderWorld> world);
    void consumePublishedWorld() noexcept;
    // Swap `pending` in as the live render world: re-point held voices onto its samples, reset
    // stopped decks, and publish latency/generation. Audio thread only.
    void installWorld(RenderWorld* pending) noexcept;
    void retireAcknowledgedWorlds();
    // snapshotOverride: when non-null, render this snapshot instead of world.sequencerState
    // (used by DJ mode to render each deck's snapshot against the SAME stable world.samples
    // map — copying samples into a per-callback local world would dangle persisted voices).
    void renderSequencerFrames(const RenderWorld& world,
                               NativeRenderState& state,
                               float* left,
                               float* right,
                               float* send1,
                               float* send2,
                               float* send3,
                               float* send4,
                               std::uint32_t frameCount,
                               const NativeSequencerSnapshot* snapshotOverride = nullptr,
                               int instrumentDeck = -1,
                               bool allowLiveOverrides = false) const noexcept;
    void updateTiming(std::uint64_t elapsedNanoseconds, std::uint32_t frameCount) noexcept;

    // Drain the live-trigger ring into the active render state(s). Called at the top of render()
    // after the world swap. Dispatches each command to the deck it targets (composition mode uses
    // deck 0 against world.sequencerState; DJ mode uses each deck's own snapshot).
    void drainLiveTriggers() noexcept;
    // Spawn one live voice into `state` using `track`/`snapshot` context (no per-step offsets,
    // cells, rhythmic offset, or humanize — those are sequencer-only). const because it only
    // mutates `state` and checks out a stretch-pool slot, exactly like renderSequencerFrames.
    void activateLiveVoice(const RenderWorld& world,
                           NativeRenderState& state,
                           const NativeSequencerSnapshot& snapshot,
                           const LiveTriggerCommand& command) const noexcept;

    MixerState controlMixerState_;
    NativeSequencerSnapshot controlSequencerState_;
    std::unordered_map<std::string, std::shared_ptr<const NativeSample>> controlSamples_;
    std::vector<std::unique_ptr<RenderWorld>> ownedWorlds_;
    std::atomic<RenderWorld*> pendingWorld_ { nullptr };
    RenderWorld* renderWorld_ = nullptr;
    std::atomic<std::uint64_t> nextWorldGeneration_ { 1 };
    std::atomic<std::uint64_t> publishedWorldGeneration_ { 0 };
    std::atomic<std::uint64_t> acknowledgedWorldGeneration_ { 0 };

    // Live per-track control override storage (see the public setTrack*Override setters). One slot per
    // (deck, track); each scalar carries its own epoch so e.g. a volume move never resurrects a stale
    // pan override. The render loop uses a field only while its epoch is newer than the rendered
    // world's liveControlEpochAtPublish.
    struct LiveTrackControl {
        std::atomic<float> volume { 1.0f };
        std::atomic<float> pan { 0.0f };
        std::atomic<float> tone { 0.0f };
        std::atomic<float> q { 0.7071f };
        std::atomic<float> send[kNumSends] {};
        std::atomic<std::uint64_t> volumeEpoch { 0 };
        std::atomic<std::uint64_t> panEpoch { 0 };
        std::atomic<std::uint64_t> toneEpoch { 0 };
        std::atomic<std::uint64_t> qEpoch { 0 };
        std::atomic<std::uint64_t> sendEpoch[kNumSends] {};
    };
    std::array<std::array<LiveTrackControl, kMaxEnvelopeTracks>, kMaxDecks> liveTrackControl_;
    // Bus-level live overrides (see setDeckGainOverride / setReturnVolumeOverride): the deck's
    // audible main-mix gain (deck fader × crossfader side weighting) and the FX-return wet level
    // for returns 1 & 2. Epoch-gated exactly like LiveTrackControl.
    struct LiveScalarOverride {
        std::atomic<float> value { 1.0f };
        std::atomic<std::uint64_t> epoch { 0 };
    };
    std::array<LiveScalarOverride, kMaxDecks> deckGainOverride_ {};
    std::array<LiveScalarOverride, 2> returnVolumeOverride_ {};
    // Audio-thread-only glide state: last applied deck mix gain / return wet level, ramped across
    // each block toward the (override-aware) target so fader sweeps and republish steps land
    // click-free (the world value previously stepped unramped).
    std::array<float, kMaxDecks> deckMixGainCurrent_ {};
    std::array<float, 2> returnVolGlideCurrent_ { 1.0f, 1.0f };
    std::atomic<std::uint64_t> liveControlEpoch_ { 0 };
    LiveTrackControl* liveControlSlot(int deck, int track) noexcept {
        if (deck < 0 || deck >= static_cast<int>(kMaxDecks)) return nullptr;
        if (track < 0 || track >= static_cast<int>(kMaxEnvelopeTracks)) return nullptr;
        return &liveTrackControl_[static_cast<std::size_t>(deck)][static_cast<std::size_t>(track)];
    }
    std::uint64_t nextLiveControlEpoch() noexcept {
        return liveControlEpoch_.fetch_add(1, std::memory_order_acq_rel) + 1;
    }
    // ── Frame-exact pattern-scene switch (early-arm boundary hold) ──────────────────────────────
    // A switch-tagged world (deck-0 snapshot carries patternSwitchEventID != 0 && boundaryStep >= 0)
    // is NOT installed immediately by consumePublishedWorld: it is PARKED here while the currently
    // installed (old-pattern) world keeps rendering, and installed when deck A's MUSICAL step
    // (masterStep − patternAnchorStep) reaches the boundary. The boundary is a multiple of the
    // OUTGOING scene's own LCM; at the crossing the deck's pattern anchor moves to it (via
    // NativeRenderState::pendingAnchorStep on the sample-exact path) so the incoming scene reads
    // from ITS step 0 with the absolute clock untouched. All audio-thread owned; the parked world
    // lives in ownedWorlds_ and its generation is excluded from retire (parkedSwitchGeneration_) so a
    // newer non-switch publish can't free it under the audio thread (the v1 UAF). lastInstalled keeps
    // an already-installed eventID from being re-parked while Swift is still publishing the same tag.
    RenderWorld* parkedSwitchWorld_ = nullptr;
    std::int64_t parkedBoundaryStep_ = -1;
    std::uint64_t parkedSwitchEventID_ = 0;
    std::uint64_t lastInstalledSwitchEventID_ = 0;
    // Atomic mirror of lastInstalledSwitchEventID_, stored at every switch-install shape (parked
    // early/fallback + seamless-run; never on dropPark). Swift's scheduled-switch COMMIT poll
    // compares it to its armed eventID — the published playhead wraps to 0 when the pattern
    // anchor moves at the boundary, so a step comparison can no longer detect the commit.
    std::atomic<std::uint64_t> installedSwitchEventID_ { 0 };
    std::atomic<std::uint64_t> parkedSwitchGeneration_ { 0 };
    // Seamless "Run" pattern-scene switch (eventID != 0 && boundaryStep < 0): the new world installs
    // immediately (phase preserved), but the new scene's cells that SPAN the current playhead must
    // resume mid-sample instead of waiting to re-trigger from their owner step. On such an install
    // consumePublishedWorld resets prevResolvedStep (so the existing REG mid-cell entry math fires)
    // and arms NativeRenderState::switchResumePending (a strict per-track one-shot, see there) which
    // additionally resumes OWN single-step long samples. The per-track flag self-clears in the trigger
    // loop; locator/skip-step jumps clear it so they keep the normal owner-skip.
    // Composition mode uses only callbackRenderState_[0]; DJ mode uses all three.
    std::array<NativeRenderState, kMaxDecks> callbackRenderState_ {};
    // Per-deck playhead step published each callback for the UI (see deckPlayheadStep()).
    std::array<std::atomic<std::uint64_t>, kMaxDecks> deckPlayheadStep_ {};
    // Companion validity flags: set by the render-body playhead writes, cleared by
    // resetDeckPlayheadStep() and the running_==false early return (see deckClockLive()).
    std::array<std::atomic<bool>, kMaxDecks> deckClockLive_ {};
    // Borrowed (bridge-owned) sample-accurate MIDI clock-out generator; null when unused.
    NativeMidiClockOut* midiClockOut_ = nullptr;
    // Borrowed (bridge-owned) sample-accurate MIDI note-out generator; null when unused. Drives
    // external hardware note output for `.midiOut` tracks (no hosted instrument).
    NativeMidiNoteOut* midiNoteOut_ = nullptr;
    // mach_absolute_time() captured at the top of each render() block; the const renderSequencerFrames
    // reads it to time note events at their in-block frame offset (same host-time domain as the clock).
    std::uint64_t renderBlockHostTime_ = 0;
    // Expressive MIDI voice state (gate / chord / flam / pre-silence / glide), keyed by
    // (deck, trackIndex, destination). A hosted instrument and external hardware read the same
    // per-cell data, so they run the same state machine through a NativeMidiSink — but each keeps
    // its own voice, because a track may feed both at once.
    // REPLACES the old heldExternalNote_/heldExternalChannel_ mono pair (one note, no gate).
    mutable std::array<std::array<std::array<NativeMidiVoiceState, kMidiDestCount>,
                                  kMaxMidiVoiceTracks>, kMaxDecks> midiVoices_ {};
    // Transport-edge tracking so a stop flushes any held external notes (no hung notes).
    bool externalMidiWasPlaying_ = false;
    // Per-deck pending seek (skip-step). -1 = none; applied at the next step boundary in render().
    std::array<std::atomic<std::int64_t>, kMaxDecks> pendingSeekStep_ {};
    // Per-deck quantized-launch boundary params (see requestQuantizedLaunch()). Read in render only
    // while the deck is held; the held state itself is edge-driven from DeckWorld::launchArmed.
    std::array<std::atomic<QuantizedLaunchCommand>, kMaxDecks> pendingLaunch_ {};
    // Per-deck previous (active && launchArmed) value, so the render loop detects arm/disarm edges.
    std::array<bool, kMaxDecks> deckLaunchArmedPrev_ {};
    // Per-deck previous bus-stretch bypass state. When the bus is neutral (ratio ≈ 1.0, no
    // transpose, no browse) the Signalsmith stretcher is bypassed (direct copy) to avoid its
    // inherent input+output latency — otherwise composition-mode playback incurs a fixed,
    // buffer-independent startup delay. Tracked so a bypass→stretch transition can reset the
    // stretcher to a clean state before it re-engages. Initialised true (start bypassed/neutral).
    std::array<bool, kMaxDecks> busBypassPrev_ { { true, true, true } };
    // Declick for the bypass↔stretch transitions: a rolling ring of PRE-stretch 6-ch input
    // history per deck. On bypass→stretch the newest frames are linearized into
    // busHistoryLin_ and fed to NativeBusStretcher::engagePrimed() (outputSeek), so the
    // stretcher starts already aligned to "now" — no cold start, no group-delay jump —
    // followed by a short equal-power dry→wet crossfade. On stretch→bypass one extra warm
    // process() into busDisengageWet_ lets the wet tail fade into the dry copy.
    // All sized in configure(); no allocation in the callback.
    std::array<std::array<std::vector<float>, kDeckBusChannels>, kMaxDecks> busHistory_;
    std::array<int, kMaxDecks> busHistoryPos_ {};    // ring write cursor
    std::array<int, kMaxDecks> busHistoryCount_ {};  // valid frames (≤ busHistoryCap_)
    int busHistoryCap_ = 0;
    std::array<std::vector<float>, kDeckBusChannels> busHistoryLin_;    // engage scratch (time-ordered)
    std::array<std::vector<float>, kDeckBusChannels> busDisengageWet_;  // disengage fade scratch
    std::uint32_t busXfadeTotal_ = 0;                // transition fade length (~10 ms)
    // Append `frames` of this callback's pre-stretch input to the deck's history ring.
    void appendBusHistory(std::size_t deck, const float* const* in, int frames) noexcept;
    // Linearize the newest `frames` history frames (time-ordered) into busHistoryLin_.
    // Returns the count actually copied (≤ available).
    int linearizeBusHistory(std::size_t deck, int frames) noexcept;
    // Push the spectral tuner state (texture, transpose/tonality, warp, warp-mod, chaos, air)
    // into one deck's bus stretcher. Called every callback from BOTH render branches so the
    // stretcher is always current when it engages. Returns the deck's effective transpose
    // semitones (global + per-deck) for the caller's neutral-bypass decision.
    double pushSpectralParams(std::size_t deck, double sampleRateHz) noexcept;
    // The shared per-deck bus-stretch body: neutral-bypass copy, declicked engage (primed from
    // the history ring) / disengage (warm tail fade), or a plain stretched process(). Updates
    // busBypassPrev_ and appends this callback's pre-stretch input to the history ring.
    // inBus/outBus are 2 + kNumSends channel pointer arrays; busNeutral is the caller's
    // all-or-nothing (DJ) or toggle-driven (composition) bypass decision.
    void processDeckBusStretch(std::size_t deck, const float* const* inBus, float* const* outBus,
                               int inFrames, int outFrames, double busRatio,
                               bool busNeutral) noexcept;
    // Per-deck monotonic fired-counter, bumped on release (see launchFiredSequence()).
    std::array<std::atomic<std::uint32_t>, kMaxDecks> launchFiredSeq_ {};
    // Continuous window texture for the bus stretchers, per deck (see setDeckBusTexture();
    // setBusTexture writes all decks for the global tuner surface).
    std::array<std::atomic<double>, kMaxDecks> deckBusTexture_ {
        { kBusTextureDefault, kBusTextureDefault, kBusTextureDefault } };
    // Granular browse/scrub + pitch (see setBusGranularParams()). browseSpeed/browseEnabled
    // are read every callback; transpose is applied via a dirty flag (RT-safe float set).
    std::atomic<bool>   busBrowseEnabled_    { false };
    std::atomic<double> busBrowseSpeed_      { 1.0 };
    std::atomic<double> busTransposeSemis_   { 0.0 };
    std::atomic<double> busTonalityLimit_    { 0.0 };
    std::atomic<bool>   busTransposeDirty_   { false };
    // Per-deck bus transpose (semitones), pushed directly via setDeckBusTranspose() — realtime,
    // bypasses the world publish (applied every callback ON TOP of the global busTransposeSemis_).
    // Lets each deck sit at its own key while staying tempo-synced (TS sync mode pitch).
    std::array<std::atomic<double>, kMaxDecks> deckBusTransposeSemis_ {};
    // X-MOD onset detector (per deck, audio-thread only): crest-factor onset detection on
    // the LOW BAND (~150 Hz one-pole) of the deck's DRY pre-stretch scratch. The fast/slow
    // follower RATIO self-normalizes, so heavily mastered material still yields full-range
    // onsets (a broadband follower on a compressed stereo sum would be nearly flat).
    struct XModDetector {
        double lp      = 0.0;     // low-band one-pole state (mono)
        double envFast = 0.0;     // ~3 ms attack / 80 ms release follower
        double envSlow = 1.0e-4;  // ~1 s running average (crest normalizer)
        double refractorySecs = 0.0;  // time until the next onset may fire
        bool   above   = false;   // crest above threshold (edge/hysteresis state)
    };
    // Per carve NODE — the pump is driven by whatever is on the opposite side, and after
    // Phase XN that can be a return or the input, not only a deck.
    std::array<XModDetector, kMaxCarveNodes> xmodDetector_ {};
    // Last callback's onset strength per node (0 = none). Cross-injection reads the
    // PREVIOUS block for both directions so A→B and B→A see a symmetric one-block delay
    // regardless of node processing order.
    std::array<double, kMaxCarveNodes> xmodOnsetPrev_ {};
    // Run one block of onset detection on a node's dry signal; returns the onset strength
    // fired in this block (0 = none). Render thread only.
    double detectXModOnset(std::size_t node, const float* left, const float* right,
                           int frames, double sampleRate) noexcept;

    // ── X-MIX carve (see setDeckCarveAmount()) ─────────────────────────────────────────
    // Complementary spectral mixing: 6 log-spaced bands via FIRST-ORDER complementary
    // splits (bands sum back EXACTLY flat at unity gains → amount 0 is bit-transparent).
    // Analysis is self-normalizing (band energy / total = WHERE the energy is, not how
    // loud — mastering-proof, same rule as the X-MOD detector) and reads the source
    // decks' PRE-carve dry renders, so mutual carving cannot feed back.
    static constexpr int kCarveBands = 6;
    // Tunable voicing block: crossovers, max cut (0.9 ≈ −20 dB), analysis smoothing,
    // gain attack/release, weight scale (band holding ≥1/3 of energy carves fully).
    static constexpr double kCarveCrossoverHz[kCarveBands - 1] = { 60.0, 200.0, 600.0,
                                                                   1800.0, 5000.0 };
    static constexpr double kCarveMaxCut      = 0.9;    // deeper vacate so dominated bands clear
    static constexpr double kCarveEnvSecs     = 0.08;
    static constexpr double kCarveAttackSecs  = 0.015;
    static constexpr double kCarveReleaseSecs = 0.2;
    static constexpr double kCarveWeightScale = 3.0;
    static constexpr double kCarveSilenceFloor = 1.0e-4;
    // Carve driver = a strong ABSOLUTE base (opposite side's per-band presence — always
    // audible, the depth the old design had) PLUS a DOMINANCE bonus (extra cut where the
    // opposite out-occupies this deck), so similar full-palette material still ducks hard
    // while the momentary per-band winner keeps its bands and the loser is carved deeper —
    // an interlocked mosaic instead of a symmetric dip. Splits are SECOND-ORDER (two cascaded
    // poles per crossover) for sharper pockets — reconstruction stays exact because each band
    // is subtracted from the running remainder (band + rest ≡ input, any filter shape).
    static constexpr double kCarveBaseFrac    = 0.7;   // absolute base carve at spectral parity
    static constexpr double kCarveDomBonus    = 0.6;   // extra carve where the opposite dominates
    struct CarveAnalyzer {                 // per node, mono dry-scratch analysis
        std::array<std::array<double, 2>, kCarveBands - 1> lp {};  // 2-pole cascade states
        std::array<double, kCarveBands> env {};      // smoothed band energy
    };
    // Per node. Sized for the widest bus (a deck's 6 channels); a return / the input carves
    // only channels 0–1 and leaves the rest of the filter state cold.
    struct CarveGainStage {
        std::array<std::array<std::array<double, 2>, kCarveBands - 1>, kDeckBusChannels> lp {};
        std::array<double, kCarveBands> gain { { 1.0, 1.0, 1.0, 1.0, 1.0, 1.0 } };
    };
    // Onset-driven pump: each transient from the INCOMING (source) side momentarily deepens
    // the carve on the outgoing side, so the interlock pulses with the incoming track's hits.
    // Reuses xmodOnsetPrev_ (already detected every callback for all decks). Per-deck env.
    static constexpr double kPumpDepth        = 0.35;   // added to carve amount at a full hit
    static constexpr double kPumpAttackSecs   = 0.004;
    static constexpr double kPumpReleaseSecs  = 0.15;
    std::array<double, kMaxCarveNodes> carvePumpEnv_ {};
    // Shimmer character: what the duck removes is re-injected through resonant bandpasses
    // whose centers MOVE with the source side's energy distribution (slide toward the
    // louder neighbour band) and are slightly detuned L/R — the carved bands ring and
    // drift instead of just dipping. Band 0 (lows) is excluded (resonant lows = mud).
    static constexpr double kShimmerQ         = 6.0;    // resonator Q
    static constexpr double kShimmerWet       = 1.2;    // wet level at full carve depth (hotter)
    static constexpr double kShimmerMoveOct   = 0.4;    // ± octaves of neighbour-driven slide
    static constexpr double kShimmerMoveSecs  = 0.25;   // slide smoothing
    static constexpr double kShimmerDetuneOct = 0.03;   // ± L/R detune (stereo shimmer)
    // Octave-up sparkle: the top two bands additionally ring an octave above their centre so
    // the re-injection reads as air/shimmer rather than just midrange resonance.
    static constexpr double kShimmerSparkle   = 0.35;   // sparkle tap level (× wet gain)
    static constexpr int    kShimmerSparkleLo = kCarveBands - 2;  // first band that gets sparkle
    struct CarveShimmer {                  // per node
        struct Svf { double ic1 = 0.0, ic2 = 0.0; };    // TPT SVF state
        std::array<std::array<Svf, kDeckBusChannels>, kCarveBands> svf {};
        std::array<std::array<Svf, kDeckBusChannels>, kCarveBands> sparkleSvf {};  // octave-up tap
        std::array<double, kCarveBands> gain {};        // smoothed wet gains
        std::array<double, kCarveBands> moveOct {};     // smoothed centre slide (octaves)
    };
    std::array<CarveAnalyzer, kMaxCarveNodes>  carveAnalyzer_ {};
    std::array<CarveGainStage, kMaxCarveNodes> carveStage_ {};
    std::array<CarveShimmer, kMaxCarveNodes>   carveShimmer_ {};
    // Published analysis per node: normalized band weights 0…1 (all-zero when silent).
    std::array<std::array<double, kCarveBands>, kMaxCarveNodes> carveWeights_ {};
    std::array<std::atomic<double>, kMaxCarveNodes> carveAmount_ {};
    std::array<std::atomic<int>,    kMaxCarveNodes> carveSourceMask_ {};
    std::array<std::atomic<double>, kMaxCarveNodes> carveShimmerAmount_ {};
    // XN-03 (the single-carve rule): per DECK, a bitmask of send channels to LEAVE ALONE when
    // carving that deck's 6-channel bus — bit k set = send k+1 feeds a return that carries its
    // OWN crossfader side, so that return is carved once, on its own terms, from a dry feed.
    // Without this the send feed is carved by the deck AND the return is carved again by its
    // own side, in opposing directions. 0 = today's behaviour (every send feed carved).
    std::array<std::atomic<int>, kMaxDecks> deckCarveSendSkipMask_ {};
    // Bit k = FX return k+1's wet actually reaches the main sum this block, so it IS carving
    // itself and the decks may skip its send feed. A return routed to hardware or running
    // external never enters main → it carves nothing → the decks must keep carving its feed.
    // Written by the render thread in the return pass; consumed by the deck loop on the NEXT
    // callback, and read by the UI (which greys the X picker for a return that cannot be carved).
    std::atomic<int> carveableReturnsMask_ { 0 };
    // Analyze one block of a node's dry signal into carveWeights_[node]. Render thread.
    void analyzeCarve(std::size_t node, const float* left, const float* right,
                      int frames, double sampleRate) noexcept;
    // Apply the carve gain stage to a node's bus. `channels` = kDeckBusChannels for a deck
    // (main + the 4 send feeds), 2 for a return / the input. `sendSkipMask` is honoured only
    // for a deck bus (see deckCarveSendSkipMask_); pass 0 for stereo nodes.
    void applyCarve(std::size_t node, float* const* bus, int channels, int frames,
                    double sampleRate, int sendSkipMask = 0) noexcept;
    // Per-deck spectral color (see setDeckBusSpectral()): chaos −1…+1 (freeze character),
    // air 0…12 dB (post-stretch HF shelf).
    std::array<std::atomic<double>, kMaxDecks> deckBusChaos_ { { 1.0, 1.0, 1.0 } };
    std::array<std::atomic<double>, kMaxDecks> deckBusAirDb_ {};
    // Per-deck stereo scratch buffers — allocated in configure(), written each callback.
    // Deck voice output is summed here before bus-level tempo stretch and crossfader mix.
    std::array<std::vector<float>, kMaxDecks> deckScratchLeft_;
    std::array<std::vector<float>, kMaxDecks> deckScratchRight_;
    std::vector<float> inputLeft_;
    std::vector<float> inputRight_;
    // XN-02 — carve scratch for the STEREO carve nodes. The four FX returns and the mic are
    // built per-frame inside the master sum loop, but the carve is a per-block stage; these hold
    // one block of each so it can run between the two halves of that loop. Allocated in
    // configure(), never resized on the render thread.
    std::array<std::vector<float>, kNumSends> returnCarveL_;
    std::array<std::vector<float>, kNumSends> returnCarveR_;
    std::vector<float> micCarveL_;
    std::vector<float> micCarveR_;
    std::array<std::vector<float>, laneCount> outputStorage_;
    std::atomic<bool> running_ { false };
    std::atomic<double> callbackLoad_ { 0.0 };
    std::atomic<std::uint64_t> callbackCount_ { 0 };
    std::atomic<std::uint64_t> deadlineMissCount_ { 0 };
    std::atomic<std::uint32_t> activeVoices_ { 0 };
    std::atomic<std::uint32_t> declaredDSPLatencyFrames_ { 0 };
    std::atomic<std::uint32_t> hardwareLatencyFrames_ { 0 };
    std::atomic<std::uint32_t> bufferSizeFrames_ { 0 };
    std::atomic<double> sampleRate_ { 0.0 };
    std::atomic<std::uint32_t> droppedVoiceCount_ { 0 };
    std::atomic<std::uint32_t> triggerOverflowCount_ { 0 };
    std::atomic<std::uint32_t> peakVoiceCount_ { 0 };

    // Live-trigger SPSC ring (see enqueueLiveTrigger / drainLiveTriggers). Single producer is the
    // control thread (serialized by the bridge's control queue); single consumer is the audio
    // thread. liveTriggerOverflowCount_ counts commands dropped because the ring was full.
    static constexpr std::size_t kLiveTriggerRingSize = 256;  // power of two for cheap masking
    std::array<LiveTriggerCommand, kLiveTriggerRingSize> liveTriggerRing_ {};
    std::atomic<std::uint32_t> liveTriggerHead_ { 0 };  // producer writes, advances on enqueue
    std::atomic<std::uint32_t> liveTriggerTail_ { 0 };  // consumer reads, advances on drain
    std::atomic<std::uint32_t> liveTriggerOverflowCount_ { 0 };
    // Output meter: peak |sample| of the final main bus, held until consumed by the UI.
    std::atomic<float> outputPeak_ { 0.0f };
    // Low band (~120 Hz one-pole) peak of the same mix, for the background shake.
    // The filter state is audio-thread-only; flushed to 0 near silence so it can
    // never park in the subnormals (the DC-blocker lesson, P8-3).
    std::atomic<float> lowBandPeak_ { 0.0f };
    float lowBandLpf_ { 0.0f };
    // Phase 9: master DSP (audio-thread only, not atomic)
    NativeMasterSaturation masterSaturation_;
    NativeMasterClipper masterClipper_;
    // Master drive/clip stage (selectable, anti-aliased curves; soft = legacy parity).
    // One instance per independent audible output: the main bus plus each dedicated deck lane
    // (ADAA keeps per-channel history, so they must not share state).
    NativeMasterDrive masterDrive_;
    std::array<NativeMasterDrive, kMaxDecks> deckMasterDrive_;
    // Was deckMasterDrive_[di] processing the deck's signal on the previous callback? Both the
    // dedicated-lane stage and the in-main pre-sum drive stage share the instance (a deck is
    // dedicated XOR in-main), so on any bypass→process transition we reset() to drop stale
    // ADAA/oversampler history. false when the stage was bypassed, muted, or the deck inactive.
    std::array<bool, kMaxDecks> deckMasterDriveActive_ {};

    // FX-return routing mode per slot (1 external, 2 host). Lock-free. Default host.
    std::atomic<std::uint8_t> returnMode_[kNumSends] { {2}, {2}, {2}, {2} };
    // Per-return host output destination: false = wet into main mix (default), true = wet to the
    // dedicated send hardware channel (exclusive — removed from main). Lock-free.
    std::atomic<bool> returnHardwareOut_[kNumSends] { {false}, {false}, {false}, {false} };
    // Per-return WET level for the extended host returns (sends 3 & 4 read this; 1 & 2 use the
    // ReturnTrack snapshot volume). Lock-free. Default unity.
    std::atomic<float> returnVolume_[kNumSends] { {1.0f}, {1.0f}, {1.0f}, {1.0f} };
    // Per-send INPUT "send master" gain (scales the summed send bus into the slot,
    // applies to both external and host modes). Lock-free. Default unity.
    std::atomic<float> sendInputGain_[kNumSends] { {1.0f}, {1.0f}, {1.0f}, {1.0f} };
    // AUDIO THREAD. De-click state: the gain as last applied, glided across each block toward the
    // atomic above (which steps unramped when the knob moves).
    float sendInputGainCurrent_[kNumSends] = { 1.0f, 1.0f, 1.0f, 1.0f };
    // AUDIO THREAD. Same de-click state for the external send lane gain (MixerState.sendNGain,
    // which steps once per republish).
    float sendLaneGainCurrent_[kNumSends] = { 1.0f, 1.0f, 1.0f, 1.0f };
    // Per-send fader tap: true = post-fader (legacy), false = pre-fader. Lock-free. Default post.
    std::atomic<bool> sendPostFader_[kNumSends] { {true}, {true}, {true}, {true} };
    // Per-track output routing master switch (the per-device "Per-track output routing" toggle):
    // while set, tracks with outputAssign 1/2 are mono-summed hard onto that side of their deck
    // pair, ignoring pan. Off = assignments stored but dormant (normal pan). Lock-free.
    std::atomic<bool> perTrackRoutingActive_ { false };
    // Mixer-console output mute per deck (A/B/C). Mutes ONLY the deck's dry main contribution,
    // applied AFTER the per-deck send tap — so a muted deck's FX-send wet still returns. Carries
    // both the explicit channel mute and any solo-induced mute (resolved in Swift). Lock-free.
    std::atomic<bool> deckOutputMuted_[kMaxDecks] { {false}, {false}, {false} };
    // Solo-induced mute for an FX return/send channel. OR'd with the snapshot panic mute at the
    // return-sum so soloing another channel silences this return's wet without touching the
    // user's persisted panic-mute state. Lock-free. Default unmuted.
    std::atomic<bool> sendSoloMuted_[kNumSends] { {false}, {false}, {false}, {false} };
    // Mic input channel (device input fed into render()'s inputLeft/inputRight). micGain scales
    // the input; the dry mic reaches the main bus only when monitoring is on AND not muted. The
    // input peak meter tracks the gained input regardless of monitoring (so a level shows while
    // armed but not monitored). Lock-free. Defaults: unity gain, monitoring off, unmuted.
    std::atomic<float> micGain_ { 1.0f };
    std::atomic<bool>  micMonitorOn_ { false };
    std::atomic<bool>  micMuted_ { false };
    std::atomic<float> inputPeak_ { 0.0f };
    // Mic → FX send levels (0..1+): how much of the gained mic feeds each send bus, so the mic can
    // be reverbed/delayed/host-processed independently of monitoring. Lock-free. Default 0 (no send).
    std::atomic<float> micSendLevel_[kNumSends] {};
    // Deck-master → FX send levels (0..1): how much of each deck's full summed output feeds each
    // send bus (console routing, pre-fader/pre-mute). Targets written by the control thread;
    // deckMasterSendCurrent_ is the AUDIO-THREAD-only glide state that de-clicks fader moves
    // across the block (same idiom as deckMixGainCurrent_/instrumentSendCurrent_). Default 0.
    std::array<std::array<std::atomic<float>, kNumSends>, kMaxDecks> deckMasterSend_ {};
    float deckMasterSendCurrent_[kMaxDecks][kNumSends] {};
#if SCOOPY_PLUGIN_HOST
    NativePluginSlot returnPluginSlot1_;
    NativePluginSlot returnPluginSlot2_;
    NativePluginSlot returnPluginSlot3_;
    NativePluginSlot returnPluginSlot4_;
    // Per-block wet scratch for host-mode returns (stereo). Sized in configure().
    std::vector<float> hostWet1L_, hostWet1R_, hostWet2L_, hostWet2R_;
    std::vector<float> hostWet3L_, hostWet3R_, hostWet4L_, hostWet4R_;
    // The host's own per-send feed into the return plugins (P6-3, mono per send
    // — matching the send lanes). Written by the embedding host before render(),
    // added to the lane content where hostWet is gathered. Sized in configure().
    std::array<std::vector<float>, kNumSends> hostSendFeed_ {};

    // Per-track instrument host pool. instrumentSlotKey_[i] packs the (deck, track) bound to slot i
    // (−1 = free); written on the control thread, read lock-free on the audio thread to skip unbound
    // slots. instWetL_/R_ is a single stereo scratch reused across slots each callback. mutable so
    // the const renderSequencerFrames can drive note generation / MIDI feed (like voiceStretchPool_).
    mutable std::array<NativeInstrumentSlot, kMaxInstrumentSlots> instrumentSlots_ {};
    std::array<std::atomic<int>, kMaxInstrumentSlots> instrumentSlotKey_ {};
    std::atomic<bool> instrumentHostingEnabled_ { false };
    std::vector<float> instWetL_, instWetR_;
    // Per-slot stereo tone filter applied to instrument audio (mirrors the per-voice tone path).
    std::array<NativeToneFilter, kMaxInstrumentSlots> instrumentTone_ {};
    // Per-slot send levels as last applied, glided across each block toward the (override-aware)
    // target so a send fader flick on sustained instrument audio lands click-free.
    std::array<std::array<float, kNumSends>, kMaxInstrumentSlots> instrumentSendCurrent_ {};
    // Per-slot output-routing placement weights (side 1 / side 2) as last applied, glided across
    // each block so toggle flips / reassignments on sustained instrument audio land click-free.
    std::array<std::array<float, 2>, kMaxInstrumentSlots> instrumentAssignCurrent_ {};
    // AUDIO THREAD. Render every instrument slot bound to `deck` and sum its output into the given
    // (deck) main + send buffers, applying the bound track's per-track DSP (volume/pan/tone + LFO +
    // sends). No-op when the feature flag is off. `lfoState` carries the deck's end-of-buffer LFO
    // phase for the one-per-buffer modulation approximation.
    void renderInstrumentsForDeck(int deck,
                                  const NativeSequencerSnapshot& snapshot,
                                  const NativeRenderState& lfoState,
                                  float* mainL, float* mainR,
                                  float* send1, float* send2,
                                  float* send3, float* send4,
                                  std::uint32_t frames) noexcept;
    // AUDIO THREAD (called from the const renderSequencerFrames per frame). For a MIDI track on `deck`
    // bound to an instrument, detect a step boundary at (masterStep, stepFrame) and emit a monophonic
    // note to the bound slot at in-block offset `outputFrame`. Mirrors MIDIOutputEngine note logic.
    // const because it only drives the mutable instrument slots (like voiceStretchPool_).
    // Returns true if a bound instrument slot handled the track (so the caller skips external MIDI).
    bool generateInstrumentMidiForTrack(const NativeTrackSnapshot& track, int deck, int trackIndex,
                                        std::uint64_t masterStep, std::uint64_t stepFrame,
                                        const NativeRenderState& state,
                                        std::uint32_t outputFrame) const noexcept;
#endif
    // AUDIO THREAD. SIG-3 fold, once per callback: publish each deck's per-track block peak into
    // the decayed trackMixLevel the UI reads, then clear the scratch. Runs over EVERY deck —
    // including ones that rendered nothing this callback — so idle tracks decay to 0 instead of
    // freezing at their last level. Sits OUTSIDE SCOOPY_PLUGIN_HOST: sampler/grain taps feed it
    // either way.
    void foldTrackMixLevels(std::uint32_t frames) noexcept;
    // AUDIO THREAD (called from the const renderSequencerFrames per frame). For a `.midiOut` track on
    // `deck` with NO hosted instrument, detect a step boundary and emit a monophonic external MIDI
    // note (note-off previous → optional pitch-bend → note-on) to midiNoteOut_ at in-block offset
    // `outputFrame`. No-op unless midiNoteOut_ is set and deck >= 0. Not gated by SCOOPY_PLUGIN_HOST.
    // `sendDialCCs` = this track has no audio path of its own (a pure MIDI-out track), so its
    // volume/pan/tone dials speak CC 7/10/74 instead of moving audio.
    void generateExternalMidiForTrack(const NativeTrackSnapshot& track, int deck, int trackIndex,
                                      std::uint64_t masterStep, std::uint64_t stepFrame,
                                      const NativeRenderState& state,
                                      std::uint32_t outputFrame, bool sendDialCCs) const noexcept;
    // AUDIO THREAD. Note-off every sounding generated note (external AND hosted-instrument) and drop
    // every scheduled hit. Called on a transport-stop edge so nothing hangs. Each voice remembers its
    // own destination (`toInstrument`), so one pass reaches both. `outputFrame` times it in the block.
    void flushGeneratedMidiNotes(double sampleRate, std::uint32_t outputFrame) const noexcept;

    // ── Expressive MIDI note generation (shared by the instrument + external paths) ──
    // Post one MIDI message to whichever destination the sink names.
    void midiSend(const NativeMidiSink& sink, std::uint8_t status, std::uint8_t d1, std::uint8_t d2,
                  std::uint32_t frame) const noexcept;
    // Which pattern step (if any) triggers on THIS frame. Factored out of the two generators so the
    // step-resolution rules (speed multiplier ratchet, randomize, reverse traversal) exist once.
    // Returns false when no step boundary lands on this frame, or the resolved step is inactive.
    bool resolveMidiTriggerStep(const NativeTrackSnapshot& track, int trackIndex,
                                std::uint64_t masterStep, std::uint64_t stepFrame,
                                const NativeRenderState& state,
                                std::size_t& outStep) const noexcept;
    // Advance one frame of a voice: expire note-offs, run the glide bend ramp (and its landing
    // re-trigger), and fire any scheduled flam / pre-silence hits that come due.
    void serviceMidiVoice(NativeMidiVoiceState& voice, const NativeMidiSink& sink,
                          std::uint32_t outputFrame) const noexcept;
    // Sound one cell: resolve its notes (root + chord) and velocity (per-step + accent), then either
    // glide into it (legato + bend) or re-articulate, fanning flam repeats and delaying by pre-silence.
    void triggerMidiCell(const NativeTrackSnapshot& track, NativeMidiVoiceState& voice,
                         const NativeMidiSink& sink, std::size_t step,
                         const NativeRenderState& state, std::uint32_t outputFrame) const noexcept;
    // Note-on every voice of a hit and arm its gate.
    void fireMidiHit(NativeMidiVoiceState& voice, const NativeMidiSink& sink,
                     const NativeMidiPendingHit& hit, std::uint8_t channel,
                     std::uint32_t outputFrame) const noexcept;
    // Note-off every sounding voice and drop any scheduled hits (a hard re-articulation or a stop).
    void releaseMidiVoice(NativeMidiVoiceState& voice, const NativeMidiSink& sink,
                          std::uint32_t outputFrame, bool dropPending) const noexcept;
    // Track volume/pan/tone → CC 7/10/74 on a MIDI-OUT-only track, sent only when the value moves.
    void sendMidiDialCCs(const NativeTrackSnapshot& track, NativeMidiVoiceState& voice,
                         const NativeMidiSink& sink, std::uint32_t outputFrame) const noexcept;
    // Phase 11: per-voice pitch/stretch pool (audio-thread only after configure).
    // Backend (RubberBand / Signalsmith) chosen at compile time inside the pool.
    // mutable because renderSequencerFrames is const but must checkout/checkin slots.
    mutable NativeVoiceStretchPool voiceStretchPool_;
    // Short fade-in (frames) applied over the first audible output of a freshly triggered
    // stretch voice, masking any residual phase-vocoder cold-start transient that survives
    // the seek() pre-roll. Set in configure() from the sample rate (~3 ms).
    std::uint32_t rbAttackFadeTotal_ = 0;

    // Builds one window+interval of source pre-roll (in playback order, ending at the trigger
    // point) and seeds the slot's stretcher via seek(), so the first process() output is
    // full-quality. Audio-thread safe (no allocation). slot < 0 is a no-op.
    void primeStretchVoice(int slot, const NativeSample& sample,
                           std::size_t startFrame, std::size_t endFrame,
                           bool reversed, double playbackRate) const noexcept;

    // Anti-aliased windowed-sinc reader for the per-voice varispeed / TP path.
    // Prototype table is built once in its constructor (off the audio thread).
    // Only used when SCOOPY_SINC_RESAMPLER == 1; otherwise the cubic Hermite
    // interpolate() free function is used and this stays idle.
    NativeSincResampler sincResampler_;

    // Phase 2 (DJ bus stretch): one 6-channel stretch bus per deck carrying
    // [mainL, mainR, send1, send2, send3, send4].  Separate from rubberBandPool_ which is 2-ch
    // EngineFaster for per-voice melodic stretch.  All arrays indexed by deck [0..kMaxDecks).
    // The backend (RubberBand / Signalsmith) is selected at compile time inside
    // NativeBusStretcher; ratio cache + reset-on-reactivate state live in the wrapper.
    std::array<NativeBusStretcher, kMaxDecks> busStretcher_;
    // See setStretchWarmupSynchronous(). Read by configure(); false = the
    // app's original background warm-up.
    bool syncStretchWarmup_ = false;
    std::array<std::vector<float>,  kMaxDecks> deckSend1Scratch_;        // pre-stretch send1
    std::array<std::vector<float>,  kMaxDecks> deckSend2Scratch_;        // pre-stretch send2
    std::array<std::vector<float>,  kMaxDecks> deckSend3Scratch_;        // pre-stretch send3
    std::array<std::vector<float>,  kMaxDecks> deckSend4Scratch_;        // pre-stretch send4
    std::array<std::vector<float>,  kMaxDecks> deckStretchOutL_;         // post-stretch mainL
    std::array<std::vector<float>,  kMaxDecks> deckStretchOutR_;         // post-stretch mainR
    std::array<std::vector<float>,  kMaxDecks> deckStretchOutS1_;        // post-stretch send1
    std::array<std::vector<float>,  kMaxDecks> deckStretchOutS2_;        // post-stretch send2
    std::array<std::vector<float>,  kMaxDecks> deckStretchOutS3_;        // post-stretch send3
    std::array<std::vector<float>,  kMaxDecks> deckStretchOutS4_;        // post-stretch send4

    // ── Tape reverse (DJ U/J hold) ──────────────────────────────────────────────
    // Per-deck ring buffer that captures each deck's post-bus-stretch stereo output and,
    // while held, replays it backwards in a looped region with a short crossfade — the
    // native equivalent of SequencerNode's tape-reverse ring buffer. Capture/playback run
    // on the deck's audible signal (after tempo-stretch, before the crossfader mix) so the
    // reversed audio is beat-matched like the forward signal. Requests arrive lock-free via
    // tapeReverseRequest_ (+1 = engage, -1 = release); all other state is audio-thread only.
    struct TapeReverseState {
        std::vector<float> ringL;
        std::vector<float> ringR;
        std::size_t capacity = 0;
        std::size_t writeHead = 0;
        std::size_t readHead = 0;
        std::size_t loopLength = 0;     // frames per reverse pass (one pattern cycle)
        std::size_t readCounter = 0;    // frames consumed in the current pass
        float fraction = 0.0f;          // crossfade 0 (live) … 1 (reversed)
        bool active = false;
    };
    std::array<TapeReverseState, kMaxDecks> tapeReverse_;
    std::array<std::atomic<int>, kMaxDecks> tapeReverseRequest_ {};
    // Per-deck post-stretch stereo tape reverse: capture into the ring and, when held,
    // overwrite [left,right] with the looped backwards read. frameCount-resolution,
    // matched to the device buffer. loopFrames is the pattern-cycle length used when a
    // fresh hold engages (clamped to the ring). RT-safe; called from render().
    void processTapeReverse(std::size_t deck, float* left, float* right,
                            std::uint32_t frameCount, std::size_t loopFrames) noexcept;
};

} // namespace scoopyloops
