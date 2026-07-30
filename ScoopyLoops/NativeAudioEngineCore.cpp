#include "NativeAudioEngineCore.hpp"
#include "NativeDenormal.hpp"
#include "NativeToneFilter.hpp"
#include "NativeTrackClipper.hpp"
#include "NativeMasterSaturation.hpp"
#include "NativeMasterClipper.hpp"
#include "NativeMidiClockOut.hpp"
#include "NativeMidiNoteOut.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <limits>
#include <unordered_set>

// P8-1 — THE CORE IS PORTABLE. Two platform ties used to live here and both are now gone:
//
//   1. `#include <juce_dsp/juce_dsp.h>`, for a **Phase 0 smoke test**: an unused
//      `StateVariableTPTFilter` instance whose only job was to prove juce_dsp linked. The DSP
//      never touched JUCE. Deleting it removes the engine's ENTIRE JUCE dependency and cannot
//      change a single sample — which is why the core turned out to be one line away from
//      compiling for the browser.
//
//   2. `mach_absolute_time()` — kept verbatim on Apple (see hostTimeNow below), so the shipping
//      app's MIDI timing is bit-for-bit what it was, with a portable fallback elsewhere.
//
// Everything else in this engine was already plain C++: no vDSP, no Accelerate, no threads, no
// file I/O, no SIMD intrinsics.
#if defined(__APPLE__)
    #include <mach/mach_time.h>
#else
    #include <chrono>
#endif

namespace scoopyloops {

namespace {
/// A monotonic per-block host-time reference for MIDI clock + external note timing.
///
/// On Apple this is EXACTLY the previous call — mach ticks, same units, same consumers — so the
/// desktop's timing is unchanged. Off Apple (WASM, and any future target) it is a steady-clock
/// nanosecond count. The consumers only ever take DIFFERENCES against a per-block reference, so a
/// different tick unit is consistent within a platform, which is all they require.
inline std::uint64_t hostTimeNow() noexcept {
#if defined(__APPLE__)
    return mach_absolute_time();
#else
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count());
#endif
}
}  // namespace

namespace {

constexpr std::size_t laneIndex(AudioLane lane) noexcept {
    return static_cast<std::size_t>(lane);
}

constexpr std::uint32_t chokeFadeFrames = 512;
constexpr float kOnsetThresholdLinear = 0.001f; // ≈ −60 dBFS; below = "not yet audible" for choke deferral
constexpr std::uint32_t sampleEndFadeFrames = 256;
constexpr std::uint32_t shortSampleEndFadeFrames = 64;
constexpr float dcBlockR = 0.9995f;

// Find a voice slot for a new trigger. Prefer a free slot; when the pool is full, steal — first a
// voice already fading out (the one closest to silence), otherwise the oldest voice by elapsed
// lifetime. Replaces the old silent drop-on-overflow so dense patterns lose the staleset hit, not
// the new one. The caller is responsible for releasing any stretch slot the stolen voice held and
// for bumping the stolen-voice counter.
auto acquireVoiceSlot(NativeRenderState& state) -> decltype(state.voices.begin()) {
    auto free = std::find_if(state.voices.begin(), state.voices.end(),
                             [](const NativeRenderVoice& v) { return !v.active; });
    if (free != state.voices.end()) {
        return free;
    }
    // Pool full: prefer stealing a voice that is already stopping (least fade left).
    auto best = state.voices.end();
    std::uint32_t leastFade = std::numeric_limits<std::uint32_t>::max();
    for (auto it = state.voices.begin(); it != state.voices.end(); ++it) {
        if (it->stopping && it->fadeFramesRemaining <= leastFade) {
            leastFade = it->fadeFramesRemaining;
            best = it;
        }
    }
    if (best != state.voices.end()) {
        return best;
    }
    // Otherwise steal the oldest sounding voice by elapsed lifetime.
    std::uint64_t oldest = 0;
    for (auto it = state.voices.begin(); it != state.voices.end(); ++it) {
        if (it->lifetimeFrames >= oldest) {
            oldest = it->lifetimeFrames;
            best = it;
        }
    }
    return best;
}

// ─── Onset-aware deferred cut (choke / mono self-cut) ────────────────────────

// Output frames until a just-initialized voice reaches audible material: its scheduled
// pre-silence plus the distance from its start position to the sample's scanned onset (last
// audible frame when reversed), converted source→output by the voice's playback rate
// (RubberBand voices stretch source time by rbTimeRatio instead). Glide measures from the
// target rate by design (approximate). An all-silent scan (onsetFrames == lastSoundFrame == 0)
// contributes nothing → the legacy immediate cut.
std::uint32_t deferredCutDelayFrames(const NativeRenderVoice& voice) noexcept {
    const std::uint32_t scheduled = voice.preSilenceFramesRemaining;
    if (voice.sample == nullptr) {
        return scheduled;
    }
    double sourceFrames = 0.0;
    if (voice.reversed) {
        const auto lastSound = static_cast<double>(voice.sample->lastSoundFrame);
        if (voice.position > lastSound) sourceFrames = voice.position - lastSound;
    } else {
        const auto onset = static_cast<double>(voice.sample->onsetFrames);
        if (onset > voice.position) sourceFrames = onset - voice.position;
    }
    if (sourceFrames <= 0.0) {
        return scheduled;
    }
    const double outputFrames = voice.useRubberBand
        ? sourceFrames * (voice.rbTimeRatio > 0.0 ? voice.rbTimeRatio : 1.0)
        : sourceFrames / std::max(0.0001, std::fabs(voice.rate));
    // Cap only to keep the double→uint32 conversion safe; a long silent head defers as long
    // as it really is.
    constexpr double kMaxDeferFrames = 48000.0 * 60.0;
    return scheduled + static_cast<std::uint32_t>(std::min(outputFrames, kMaxDeferFrames));
}

// Execute a trigger's cross-track choke / mono self-cut. Runs at trigger time when the voice
// starts on audible material (delay 0) or from the render loop when its onset deferral expires.
// Cuts only voices triggered BEFORE the cutter (triggerSerial < pendingCutBeforeSerial): the
// cutter itself, its chord siblings and any later trigger survive — preserving the
// chord-sibling rule and last-trigger-wins for same-frame triggers.
void executeDeferredCut(NativeRenderState& state, NativeRenderVoice& cutter) noexcept {
    for (auto& other : state.voices) {
        if (!other.active || &other == &cutter) continue;
        if (other.triggerSerial >= cutter.pendingCutBeforeSerial) continue;
        if (cutter.pendingGroupChoke && other.chokeGroup == cutter.chokeGroup
            && other.trackIndex != cutter.trackIndex) {
            other.stopping = true;
            other.choked = true;
            other.fadeFramesRemaining = cutter.pendingCutFade;
        } else if (cutter.pendingSelfCut && other.trackIndex == cutter.trackIndex) {
            other.stopping = true;
            other.choked = false;
            other.fadeFramesRemaining = cutter.pendingCutFade;
        }
    }
    cutter.pendingGroupChoke = false;
    cutter.pendingSelfCut = false;
    cutter.pendingCutFrames = 0;
}

// Arm (or immediately execute) a fresh trigger's cross-track choke / mono self-cut, deferred by
// the voice's onset delay so a silent head doesn't cut the ringing group before the new note
// actually sounds. Call once per trigger on the fully-initialized ROOT voice (chord siblings
// share the root's cut). If the cutter is itself choked/stolen before the countdown ends, the
// cut never fires — a note that never sounds chokes nothing.
void armDeferredCut(NativeRenderState& state, NativeRenderVoice& cutter,
                    bool wantGroupChoke, bool wantSelfCut, std::uint32_t cutFade) noexcept {
    if (!wantGroupChoke && !wantSelfCut) {
        return;
    }
    cutter.pendingGroupChoke = wantGroupChoke && cutter.chokeGroup != 0;
    cutter.pendingSelfCut = wantSelfCut;
    if (!cutter.pendingGroupChoke && !cutter.pendingSelfCut) {
        return;
    }
    cutter.pendingCutFade = cutFade;
    cutter.pendingCutBeforeSerial = cutter.triggerSerial;
    cutter.pendingCutFrames = deferredCutDelayFrames(cutter);
    if (cutter.pendingCutFrames == 0) {
        executeDeferredCut(state, cutter);
    }
}

// ─── LFO helpers ─────────────────────────────────────────────────────────────

double lfoWaveValue(double phase, NativeLfoWaveform wf, double symmetry, double randVal) noexcept {
    const double p = phase - std::floor(phase);  // 0–1
    switch (wf) {
    case NativeLfoWaveform::sine:
        return std::sin(2.0 * M_PI * p);
    case NativeLfoWaveform::triangle: {
        const double s = std::max(0.001, std::min(0.999, symmetry));
        return p < s ? (p / s) * 2.0 - 1.0 : ((1.0 - p) / (1.0 - s)) * 2.0 - 1.0;
    }
    case NativeLfoWaveform::square:
        return p < symmetry ? 1.0 : -1.0;
    case NativeLfoWaveform::saw:
        return 2.0 * (p - 0.5);
    case NativeLfoWaveform::random:
        return randVal;
    case NativeLfoWaveform::envelopeFollower:
        return 0.0;  // envelope follower not supported in native engine
    }
    return 0.0;
}

double nextLfoRandom(double& seed) noexcept;   // defined below (deterministic XorShift64)

/// Draw a channel's jitter contours. `locked` is drawn once per channel (deterministic from the
/// channel index, so cyclic=1 repeats identically and survives a republish); `fresh` is re-drawn at
/// every cycle wrap.
inline void refreshLfoRand(NativeRenderState& st, int ch, bool seedLocked, bool refresh) noexcept {
    if (seedLocked) {
        double seed = 0.31415 + 0.017 * static_cast<double>(ch + 1);
        for (int i = 0; i < NativeRenderState::kLfoRandPoints; ++i)
            st.lfoRandLocked[ch][i] = static_cast<float>(nextLfoRandom(seed));
        st.lfoRandSeeded[ch] = true;
    }
    if (refresh) {
        for (int i = 0; i < NativeRenderState::kLfoRandPoints; ++i)
            st.lfoRandFresh[ch][i] = static_cast<float>(nextLfoRandom(st.modRand[ch]));
    }
}

// `applyEase` — the ENVELOPE-segment curve macro (evalBreakpointPreSustain uses it). The LFO no
// longer calls it (the LFO is the Agitation engine below); it survives for the breakpoint envelope.
// ease ≥ 0 rounds a ramp toward a cosine; ease < 0 hardens it toward a step.
inline double applyEase(double u, double ease, double slant) noexcept {
    u = std::clamp(u, 0.0, 1.0);
    if (ease >= 0.0) {
        const double smooth = (1.0 - std::cos(M_PI * u)) * 0.5;
        return u + (smooth - u) * std::clamp(ease, 0.0, 1.0);
    }
    const double hard = std::clamp(-ease, 0.0, 1.0);
    const double c    = 1.0 / std::max(0.02, 1.0 - hard);        // 1 → 50
    const double thr  = 0.5 - std::clamp(slant, -1.0, 1.0) * 0.4 * hard;
    return std::clamp(0.5 + (u - thr) * c, 0.0, 1.0);
}

// ─── MOD-12 "AGITATION" — the LFO is a grid-locked per-step value sequence ───────────────────────
//
// GRM-Atelier-inspired, but shaped for a step sequencer: the modulation is a sequence of `n` per-step
// values (Length = n, 1…64 or the pattern LCM), shown as exactly n grid cells. `cyclic` crossfades
// between ONE smooth wave across those n cells and n INDEPENDENT random values, so a large n gives
// either a slow wave (cyclic 1) or a rich randomizable pattern (cyclic 0) — not just one waveform.
//   ease   −1…1  transition curve — 0 smooth · +1 hard step (S&H) · −1 late step
//   slant  −1…1  up/down asymmetry (saw ↔ reverse-saw)
//   cyclic  0…1  0 = n random per-step values · 1 = one smooth wave over the n cells
//   jitter  0…1  loosens the per-step timing of the random path
// Repeats every n steps (its own period) → the UI draws exactly n cells; no stored state.

/// splitmix64 — a deterministic integer hash (the target/timing randomness is drawn from it, so the
/// whole engine is stateless and reproducible; the TS port mirrors this bit-for-bit via BigInt).
inline std::uint64_t splitmix64(std::uint64_t x) noexcept {
    x += 0x9E3779B97F4A7C15ULL;
    x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9ULL;
    x = (x ^ (x >> 27)) * 0x94D049BB133111EBULL;
    return x ^ (x >> 31);
}

/// Deterministic value in −1…1 from (channel, index, salt). `salt` separates the value stream from
/// the timing stream so jitter and target randomness are independent.
inline double agitationRand(int channel, long long index, std::uint64_t salt) noexcept {
    const std::uint64_t h = splitmix64(
        static_cast<std::uint64_t>(index) * 0x9E3779B97F4A7C15ULL
      ^ (static_cast<std::uint64_t>(channel + 1) * 0xD1B54A32D192ED03ULL)
      ^ salt);
    return static_cast<double>(h >> 11) / static_cast<double>(1ULL << 53) * 2.0 - 1.0;
}

/// The ramp curve [EASE]. A raised-cosine over a window [a,b] ⊂ [0,1] that shrinks with |ease| and
/// slides — hitting GRM's three endpoints exactly: ease 0 → smooth S across the whole segment (full
/// raised cosine); +1 → window at the start → jumps to the target at once (sample & hold); −1 →
/// window at the end → holds the old value, then jumps at the last moment. Reaches the FULL target at
/// both extremes (unlike a centred window).
inline double easeShape(double u, double ease) noexcept {
    u = std::clamp(u, 0.0, 1.0);
    const double e = std::clamp(ease, -1.0, 1.0);
    const double w = std::max(1e-4, 1.0 - std::abs(e));   // window width (never 0)
    const double a = (e >= 0.0) ? 0.0 : (1.0 - w);        // window start slides to the end as e→−1
    const double b = a + w;
    if (u <= a) return 0.0;
    if (u >= b) return 1.0;
    return (1.0 - std::cos(M_PI * (u - a) / w)) * 0.5;
}

/// Warp the local ramp phase asymmetrically by direction [SLANT] — rising vs falling ramps get
/// reciprocal exponents, so the wave leans into a saw / reverse-saw. slant 0 = identity.
inline double slantWarp(double u, double slant, double dir) noexcept {
    const double s = std::clamp(slant, -1.0, 1.0);
    if (s == 0.0) return u;
    return std::pow(std::clamp(u, 0.0, 1.0), std::exp2(s * dir));
}

/// The CYCLIC path — one shaped wave over the period `n`. `phase` is the position in the cycle,
/// 0…1. slant sets the peak position (saw ↔ reverse-saw); ease morphs the corners (smooth sine ↔
/// hard square, via the same window curve as the ramps). Bipolar, −1…1, trough at phase 0.
inline double cyclicWaveShape(double phase, double ease, double slant) noexcept {
    phase -= std::floor(phase);
    const double r = std::clamp(0.5 + std::clamp(slant, -1.0, 1.0) * 0.49, 0.02, 0.98);
    if (phase < r) return -1.0 + 2.0 * easeShape(phase / r, ease);                // rising half
    return 1.0 - 2.0 * easeShape((phase - r) / (1.0 - r), ease);                  // falling half
}

/// The RANDOM path — a per-step sample&hold sequence of period `n` (one random target per grid
/// step, ramped into the next by ease/slant). Jitter perturbs the step boundaries.
inline double randomPathValue(double gridPos, int n, double ease, double slant,
                              double jitter, int channel) noexcept {
    const double jit = std::clamp(jitter, 0.0, 1.0);
    auto tgt  = [&](long long i) { return agitationRand(channel, ((i % n) + n) % n, 0ULL); };
    auto bnd  = [&](long long i) {
        return static_cast<double>(i)
             + jit * 0.49 * agitationRand(channel, ((i % n) + n) % n, 0x51EDULL);
    };
    long long s = static_cast<long long>(std::floor(gridPos));
    while (bnd(s) > gridPos) --s;
    while (bnd(s + 1) <= gridPos) ++s;
    const double u = std::clamp((gridPos - bnd(s)) / std::max(1e-6, bnd(s + 1) - bnd(s)), 0.0, 1.0);
    const double tA = tgt(s), tB = tgt(s + 1);
    const double dir = (tB >= tA) ? 1.0 : -1.0;
    return tA + (tB - tA) * easeShape(slantWarp(u, slant, dir), ease);
}

/// One Agitation sample in −1…1. MOD-12 (GRM-inspired, grid-locked): the modulation is a per-step
/// value sequence of period `n` steps (the "Length" control, 1…64 or the pattern LCM). `cyclic`
/// crossfades between one smooth wave across the n cells (cyclic 1) and n independent random values
/// (cyclic 0). Both are shaped by ease (smooth ↔ hard step) and slant (asymmetry); jitter loosens the
/// per-step timing of the random path. It repeats every `n` steps — its OWN period, so the UI can
/// draw exactly n grid cells.
inline double agitationValue(double gridPos, double periodSteps, double ease, double slant,
                             double cyclic, double jitter, int channel) noexcept {
    const int n = std::max(1, static_cast<int>(std::llround(periodSteps)));
    const double cyc = std::clamp(cyclic, 0.0, 1.0);
    double phaseC = gridPos / static_cast<double>(n);
    phaseC -= std::floor(phaseC);
    const double cyclicV = cyclicWaveShape(phaseC, ease, slant);
    if (cyc >= 1.0) return cyclicV;
    const double randomV = randomPathValue(gridPos, n, ease, slant, jitter, channel);
    return randomV + (cyclicV - randomV) * cyc;
}

/// The mod's period in grid steps — the ModCanvas draws exactly this many cells, and the eval site
/// publishes phase as the position within it.
inline double agitationLoopSteps(double periodSteps) noexcept {
    return std::max(1.0, std::llround(periodSteps) * 1.0);
}

// Modulation overhaul: evaluate the PRE-SUSTAIN portion of a breakpoint envelope at
// `elapsedMs` since trigger. Walks segments node[0]→node[sustainIndex] and holds at the
// sustain node's value once elapsed passes it. Segment i's length is timeMs[i]; curve[i] is
// the shape exponent into node i. Returns the raw node value (signed if the envelope is bipolar).
// MOD-2: total length of the envelope's DRAWN timeline (sum of every segment). Segment i's
// length is timeMs[i] (the time INTO node i), so node 0 contributes nothing.
double breakpointTotalMs(const NativeBreakpointEnvelope& env) noexcept {
    double t = 0.0;
    for (int i = 1; i < env.nodeCount; ++i) t += std::max(0.0, static_cast<double>(env.timeMs[i]));
    return t;
}

// Cumulative time up to the sustain node — where the pre-sustain walk ends and the hold begins.
double breakpointSustainMs(const NativeBreakpointEnvelope& env) noexcept {
    const int sus = std::clamp(env.sustainNodeIndex, 0, std::max(0, env.nodeCount - 1));
    double t = 0.0;
    for (int i = 1; i <= sus; ++i) t += std::max(0.0, static_cast<double>(env.timeMs[i]));
    return t;
}

float evalBreakpointPreSustain(const NativeBreakpointEnvelope& env, double elapsedMs) noexcept {
    const int n = env.nodeCount;
    if (n <= 0) return 0.0f;
    const int sus = std::clamp(env.sustainNodeIndex, 0, n - 1);
    double t = 0.0;
    for (int i = 1; i <= sus; ++i) {
        const double seg = std::max(0.0, static_cast<double>(env.timeMs[i]));
        if (seg > 0.0 && elapsedMs < t + seg) {
            const double frac   = std::clamp((elapsedMs - t) / seg, 0.0, 1.0);
            // MOD-10: the per-node `curve` handle first, then the envelope-wide `ease` macro on
            // top — so one slider can make the WHOLE envelope snappy or soft without touching the
            // handles, and the handles still win for per-segment control.
            const double curved = std::pow(frac, std::max(0.01, static_cast<double>(env.curve[i])));
            const double shaped = applyEase(curved, env.ease, 0.0);
            return static_cast<float>(env.value[i - 1] + (env.value[i] - env.value[i - 1]) * shaped);
        }
        t += seg;
    }
    return env.value[sus];   // reached / holding the sustain node
}

// Evaluate the RELEASE portion: walks node[sustainIndex]→node[n-1] over `releaseMs`, starting
// from `startValue` (the value captured when the gate closed, which handles an early close).
// Sets `finished` when the release has run past the final node.
float evalBreakpointRelease(const NativeBreakpointEnvelope& env, double releaseMs,
                            float startValue, bool& finished) noexcept {
    finished = false;
    const int n = env.nodeCount;
    if (n <= 0) { finished = true; return 0.0f; }
    const int sus = std::clamp(env.sustainNodeIndex, 0, n - 1);
    if (sus >= n - 1) { finished = true; return env.value[n - 1]; }  // no release segments
    double t = 0.0;
    for (int i = sus + 1; i < n; ++i) {
        const double seg = std::max(0.0, static_cast<double>(env.timeMs[i]));
        if (seg > 0.0 && releaseMs < t + seg) {
            const double frac   = std::clamp((releaseMs - t) / seg, 0.0, 1.0);
            const double curved = std::pow(frac, std::max(0.01, static_cast<double>(env.curve[i])));
            const double shaped = applyEase(curved, env.ease, 0.0);
            const float  from   = (i == sus + 1) ? startValue : env.value[i - 1];
            return static_cast<float>(from + (env.value[i] - from) * shaped);
        }
        t += seg;
    }
    finished = true;
    return env.value[n - 1];
}

// Simple deterministic random in [-1,1] from a running seed stored as double bits
double nextLfoRandom(double& seed) noexcept {
    // XorShift64 on the bit pattern of seed reinterpreted as uint64
    std::uint64_t bits;
    std::memcpy(&bits, &seed, sizeof(bits));
    bits ^= bits << 13; bits ^= bits >> 7; bits ^= bits << 17;
    std::memcpy(&seed, &bits, sizeof(seed));
    // Map to [-1,1]
    return (static_cast<double>(bits & 0x7FFFFFFFFFFFFFFFull) / static_cast<double>(0x7FFFFFFFFFFFFFFFull)) * 2.0 - 1.0;
}

std::size_t findNearestZeroCrossing(const NativeSample& sample,
                                    std::size_t index,
                                    std::size_t window = 50) noexcept {
    if (sample.left.size() < 2) {
        return index;
    }
    const std::size_t start = std::max<std::size_t>(1, index > window ? index - window : 1);
    const std::size_t end = std::min(sample.left.size() - 1, index + window);
    std::size_t bestIndex = index;
    std::size_t minimumDistance = window + 1;
    for (std::size_t candidate = start; candidate <= end; ++candidate) {
        const float before = sample.left[candidate - 1];
        const float after = sample.left[candidate];
        if ((before <= 0.0f && after >= 0.0f) || (before >= 0.0f && after <= 0.0f)) {
            const std::size_t distance = candidate > index ? candidate - index : index - candidate;
            if (distance < minimumDistance) {
                minimumDistance = distance;
                bestIndex = candidate;
                if (distance == 0) {
                    break;
                }
            }
        }
    }
    return bestIndex;
}

std::size_t findDirectionalZeroCrossing(const NativeSample& sample,
                                        std::size_t startFrame,
                                        bool reversed,
                                        std::size_t maximumFrames = 256) noexcept {
    if (sample.left.empty() || startFrame >= sample.left.size()) {
        return startFrame;
    }
    const auto readMono = [&sample](std::size_t frame) noexcept {
        return sample.right.empty()
            ? sample.left[frame]
            : (sample.left[frame] + sample.right[frame]) * 0.5f;
    };
    float previous = readMono(startFrame);
    if (reversed) {
        const std::size_t searchEnd = startFrame > maximumFrames ? startFrame - maximumFrames : 0;
        for (std::size_t frame = startFrame; frame-- > searchEnd;) {
            const float current = readMono(frame);
            if ((previous < 0.0f && current >= 0.0f)
                || (previous >= 0.0f && current < 0.0f)) {
                const float difference = current - previous;
                const float fraction = difference != 0.0f ? -previous / difference : 0.0f;
                return static_cast<std::size_t>(std::llround(
                    static_cast<double>(frame + 1) - fraction));
            }
            previous = current;
        }
        return startFrame;
    }

    const std::size_t searchEnd = std::min(sample.left.size(), startFrame + maximumFrames);
    for (std::size_t frame = startFrame + 1; frame < searchEnd; ++frame) {
        const float current = readMono(frame);
        if ((previous < 0.0f && current >= 0.0f)
            || (previous >= 0.0f && current < 0.0f)) {
            const float difference = current - previous;
            const float fraction = difference != 0.0f ? -previous / difference : 0.0f;
            return static_cast<std::size_t>(std::llround(
                static_cast<double>(frame - 1) + fraction));
        }
        previous = current;
    }
    return startFrame;
}

// Cubic Hermite (Catmull-Rom) fractional read. Used when SCOOPY_SINC_RESAMPLER == 0;
// the windowed-sinc reader replaces it when the flag is on, leaving this unused.
[[maybe_unused]]
float interpolate(const std::vector<float>& channel,
                  double position,
                  std::size_t startFrame,
                  std::size_t endFrame) noexcept {
    if (channel.empty() || endFrame <= startFrame) {
        return 0.0f;
    }
    const auto index = static_cast<std::size_t>(std::max(0.0, std::floor(position)));
    const float fraction = static_cast<float>(position - static_cast<double>(index));
    if (fraction <= 1.0e-6f) {
        return channel[index];
    }
    const auto read = [&channel, startFrame, endFrame](std::int64_t requested) noexcept {
        const auto clamped = std::clamp<std::int64_t>(
            requested,
            static_cast<std::int64_t>(startFrame),
            static_cast<std::int64_t>(endFrame - 1));
        return channel[static_cast<std::size_t>(clamped)];
    };
    const float y0 = read(static_cast<std::int64_t>(index) - 1);
    const float y1 = read(static_cast<std::int64_t>(index));
    const float y2 = read(static_cast<std::int64_t>(index) + 1);
    const float y3 = read(static_cast<std::int64_t>(index) + 2);
    const float a0 = -0.5f * y0 + 1.5f * y1 - 1.5f * y2 + 0.5f * y3;
    const float a1 = y0 - 2.5f * y1 + 2.0f * y2 - 0.5f * y3;
    const float a2 = -0.5f * y0 + 0.5f * y2;
    return ((a0 * fraction + a1) * fraction + a2) * fraction + y1;
}

bool triggerOffsetAtFrame(std::uint64_t masterStep,
                          std::uint64_t stepFrame,
                          std::uint64_t framesPerStep,
                          double speedMultiplier,
                          std::uint64_t rhythmicOffsetFrames,
                          std::uint64_t& triggerOffset) noexcept {
    // 16.0 cap matches the 16:1 detent + tape slider max (RATE-NATIVE-1;
    // Swift mirror: SpeedRatioTiming.sanitizedMultiplier).
    const double safeMultiplier = std::clamp(speedMultiplier, 0.001, 16.0);
    const double stepStartPosition = static_cast<double>(masterStep) * safeMultiplier;
    const double stepEndPosition = static_cast<double>(masterStep + 1) * safeMultiplier;
    const auto baseLocalStep = static_cast<std::uint64_t>(std::floor(stepStartPosition + 0.000001));
    const auto firstBoundary = static_cast<std::uint64_t>(std::ceil(stepStartPosition - 0.000001));
    const auto boundaryAfterLast = static_cast<std::uint64_t>(std::ceil(stepEndPosition - 0.000001));
    if (firstBoundary >= boundaryAfterLast) {
        return false;
    }
    for (std::uint64_t boundary = firstBoundary; boundary < boundaryAfterLast; ++boundary) {
        const double triggerPosition = static_cast<double>(boundary) / safeMultiplier;
        const double frameInStep = (triggerPosition - static_cast<double>(masterStep))
            * static_cast<double>(framesPerStep);
        const auto baseTriggerFrame = static_cast<std::uint64_t>(std::clamp(
            std::llround(frameInStep),
            0LL,
            static_cast<long long>(framesPerStep - 1)));
        const auto triggerFrame = std::min(baseTriggerFrame + rhythmicOffsetFrames, framesPerStep - 1);
        if (stepFrame == triggerFrame) {
            triggerOffset = boundary - baseLocalStep;
            return true;
        }
    }
    return false;
}

// Flam support: find the multiplier boundary whose window [triggerFrame, nextTriggerFrame) contains
// `stepFrame` — i.e. which cell is "sounding" at an arbitrary frame, not just on the boundary itself.
// Returns the boundary's triggerOffset plus the window start frame and length so the caller can place
// evenly-spaced flam sub-hits inside it. Returns false for frames before the first boundary's trigger
// frame (nothing is sounding yet → no flam). Mirrors triggerOffsetAtFrame's boundary math.
bool owningBoundaryAtFrame(std::uint64_t masterStep,
                           std::uint64_t stepFrame,
                           std::uint64_t framesPerStep,
                           double speedMultiplier,
                           std::uint64_t rhythmicOffsetFrames,
                           std::uint64_t& triggerOffset,
                           std::uint64_t& windowStartFrame,
                           std::uint64_t& windowLengthFrames) noexcept {
    if (framesPerStep == 0) return false;
    // 16.0 cap matches the 16:1 detent + tape slider max (RATE-NATIVE-1;
    // Swift mirror: SpeedRatioTiming.sanitizedMultiplier).
    const double safeMultiplier = std::clamp(speedMultiplier, 0.001, 16.0);
    const double stepStartPosition = static_cast<double>(masterStep) * safeMultiplier;
    const double stepEndPosition = static_cast<double>(masterStep + 1) * safeMultiplier;
    const auto baseLocalStep = static_cast<std::uint64_t>(std::floor(stepStartPosition + 0.000001));
    const auto firstBoundary = static_cast<std::uint64_t>(std::ceil(stepStartPosition - 0.000001));
    const auto boundaryAfterLast = static_cast<std::uint64_t>(std::ceil(stepEndPosition - 0.000001));
    if (firstBoundary >= boundaryAfterLast) {
        return false;
    }
    const auto triggerFrameFor = [&](std::uint64_t boundary) noexcept -> std::uint64_t {
        const double triggerPosition = static_cast<double>(boundary) / safeMultiplier;
        const double frameInStep = (triggerPosition - static_cast<double>(masterStep))
            * static_cast<double>(framesPerStep);
        const auto baseTriggerFrame = static_cast<std::uint64_t>(std::clamp(
            std::llround(frameInStep), 0LL, static_cast<long long>(framesPerStep - 1)));
        return std::min(baseTriggerFrame + rhythmicOffsetFrames, framesPerStep - 1);
    };
    for (std::uint64_t boundary = firstBoundary; boundary < boundaryAfterLast; ++boundary) {
        const std::uint64_t tf = triggerFrameFor(boundary);
        const std::uint64_t nextTf = (boundary + 1 < boundaryAfterLast)
            ? triggerFrameFor(boundary + 1) : framesPerStep;
        if (stepFrame >= tf && stepFrame < nextTf) {
            triggerOffset = boundary - baseLocalStep;
            windowStartFrame = tf;
            windowLengthFrames = (nextTf > tf) ? (nextTf - tf) : 0;
            return true;
        }
    }
    return false;
}

// Reg-mode extension-step pitch: for a multi-step (extended) cell played as ONE voice, resolve the
// melodic semitone of the CURRENT sub-step (origin + elapsed/framesPerStep, clamped) and glide into
// the next sub-step's pitch over the last glide% of the step. Same (global+offset)/2 + fine/100
// formula as the trigger. Shared by the varispeed (rate) and melodic (transpose) streaming paths.
double cellStreamSemitone(const NativeTrackSnapshot& track,
                          std::size_t originStep,
                          std::uint32_t cellLengthSteps,
                          std::uint64_t elapsedFrames,
                          std::uint64_t framesPerStep,
                          double chordIntervalSemitones = 0.0) noexcept {
    const std::size_t nSteps = track.pitchOffsets.size();
    if (nSteps == 0 || framesPerStep == 0 || cellLengthSteps < 2) return 0.0;
    const std::uint32_t maxSub = cellLengthSteps - 1;
    const std::uint32_t sub = std::min(
        static_cast<std::uint32_t>(elapsedFrames / framesPerStep), maxSub);
    const std::uint64_t frameInSub = elapsedFrames % framesPerStep;
    // Chord sibling: keep the interval through the cell's pitch walk, added in pre-remap
    // space per sub-step so every degree retunes (matches the trigger-time pitch path).
    const auto semiAt = [&](std::uint32_t s) noexcept {
        const std::size_t idx = (originStep + s) % nSteps;
        return scoopy::tunedSemitones((track.globalPitchOffset + track.pitchOffsets[idx]) / 2.0
                                          + chordIntervalSemitones, track.tuningIndex)
             + track.fineTuneCents / 100.0;
    };
    double semi = semiAt(sub);
    const double glidePct = std::clamp(track.glidePercentBetweenSteps / 100.0, 0.0, 1.0);
    if (glidePct > 0.0 && sub < maxSub) {
        const double glideFrames = static_cast<double>(framesPerStep) * glidePct;
        const double framesUntilNext = static_cast<double>(framesPerStep - frameInSub);
        if (glideFrames > 0.0 && framesUntilNext <= glideFrames) {
            const double t = 1.0 - framesUntilNext / glideFrames;
            semi += (semiAt(sub + 1) - semi) * t;
        }
    }
    return semi;
}

// Reg-mode extension-step volume: for a multi-step (extended) cell played as ONE voice, resolve the
// additive volume of the CURRENT sub-step (track volume + per-cell gain + per-cell mix offsets) and
// glide into the next sub-step's volume over the last glide% of the step — mirroring cellStreamSemitone
// so per-cell volume edits on extension cells are honored, not just the owner step. The result is the
// pre-accent/humanize additive volume; the caller reapplies the trigger-time accent×humanize multiplier.
float cellStreamVolume(const NativeTrackSnapshot& track,
                       std::size_t originStep,
                       std::uint32_t cellLengthSteps,
                       std::uint64_t elapsedFrames,
                       std::uint64_t framesPerStep) noexcept {
    const std::size_t nSteps = track.steps.size();
    if (nSteps == 0 || framesPerStep == 0 || cellLengthSteps < 2) return track.volume;
    const std::uint32_t maxSub = cellLengthSteps - 1;
    const std::uint32_t sub = std::min(
        static_cast<std::uint32_t>(elapsedFrames / framesPerStep), maxSub);
    const std::uint64_t frameInSub = elapsedFrames % framesPerStep;
    const auto volAt = [&](std::uint32_t s) noexcept {
        const std::size_t idx = (originStep + s) % nSteps;
        const float volOff = idx < track.volumeOffsets.size()    ? track.volumeOffsets[idx]    : 0.0f;
        const float mixOff = idx < track.mixVolumeOffsets.size() ? track.mixVolumeOffsets[idx] : 0.0f;
        return track.volume + volOff + mixOff;
    };
    float vol = volAt(sub);
    const float glidePct = std::clamp(static_cast<float>(track.glidePercentBetweenSteps) / 100.0f, 0.0f, 1.0f);
    if (glidePct > 0.0f && sub < maxSub) {
        const float glideFrames = static_cast<float>(framesPerStep) * glidePct;
        const float framesUntilNext = static_cast<float>(framesPerStep - frameInSub);
        if (glideFrames > 0.0f && framesUntilNext <= glideFrames) {
            const float t = 1.0f - framesUntilNext / glideFrames;
            vol += (volAt(sub + 1) - vol) * t;
        }
    }
    return vol;
}

} // namespace

NativeAudioEngineCore::NativeAudioEngineCore() {
    for (auto& s : pendingSeekStep_) s.store(-1, std::memory_order_relaxed);
#if SCOOPY_PLUGIN_HOST
    for (auto& k : instrumentSlotKey_) k.store(-1, std::memory_order_relaxed);
#endif
    // midiVoices_ needs no priming: NativeMidiVoiceState's member initialisers already spell the
    // empty voice (note -1, gate -1, no pending hit) — 0 is a valid note number, so a plain
    // zero-init would sound a hung C-2 on the first flush.
}

void NativeAudioEngineCore::primeStretchVoice(int slot, const NativeSample& sample,
                                              std::size_t startFrame, std::size_t endFrame,
                                              bool reversed, double playbackRate) const noexcept {
    if (slot < 0) return;
    const int cap = voiceStretchPool_.primeCapacity(slot);
    if (cap <= 0) return;
    float* preL = voiceStretchPool_.primeBufferL(slot);
    float* preR = voiceStretchPool_.primeBufferR(slot);
    if (!preL || !preR) return;

    const auto& L = sample.left;
    const auto& R = sample.right;
    const bool haveR = R.size() == L.size();

    if (reversed) {
        // Reversed playback descends from endFrame-1, so the audio that "would have played
        // just before the trigger" in stream time is the source ABOVE the window, read
        // backwards: stream pre-roll frame k (ending at the trigger) ↔ source index
        // endFrame-1 + (cap-k). Frames past the end of the sample pad with silence.
        for (int k = 0; k < cap; ++k) {
            const std::size_t idx = endFrame + static_cast<std::size_t>(cap - k) - 1;
            if (endFrame > 0 && idx < L.size()) {
                preL[k] = L[idx];
                preR[k] = haveR ? R[idx] : preL[k];
            } else {
                preL[k] = 0.0f;
                preR[k] = 0.0f;
            }
        }
    } else {
        // Forward: pre-roll = the `cap` source frames immediately preceding startFrame, in time
        // order. Out-of-range frames (slice starts within the first window) pad with silence.
        const std::ptrdiff_t base = static_cast<std::ptrdiff_t>(startFrame) - cap;
        for (int k = 0; k < cap; ++k) {
            const std::ptrdiff_t idx = base + k;
            if (idx >= 0 && static_cast<std::size_t>(idx) < L.size()) {
                preL[k] = L[static_cast<std::size_t>(idx)];
                preR[k] = haveR ? R[static_cast<std::size_t>(idx)] : preL[k];
            } else {
                preL[k] = 0.0f;
                preR[k] = 0.0f;
            }
        }
    }
    voiceStretchPool_.primeFromSource(slot, cap, playbackRate);
}

bool NativeAudioEngineCore::configure(double sampleRate,
                                      std::uint32_t bufferSizeFrames,
                                      std::uint32_t hardwareLatencyFrames) {
    if (running_.load(std::memory_order_acquire) || sampleRate <= 0.0 || bufferSizeFrames == 0) {
        return false;
    }

    sampleRate_.store(sampleRate, std::memory_order_release);
    bufferSizeFrames_.store(bufferSizeFrames, std::memory_order_release);
    hardwareLatencyFrames_.store(hardwareLatencyFrames, std::memory_order_release);
    inputLeft_.assign(bufferSizeFrames, 0.0f);
    inputRight_.assign(bufferSizeFrames, 0.0f);
    // XN-02: per-node carve scratch for the stereo carve nodes (the 4 FX returns + the input).
    // The returns and the mic are computed per-frame inside the master sum, but the carve is a
    // block stage — so they land here first, get carved, and the sum reads them back.
    for (auto& b : returnCarveL_) b.assign(bufferSizeFrames, 0.0f);
    for (auto& b : returnCarveR_) b.assign(bufferSizeFrames, 0.0f);
    micCarveL_.assign(bufferSizeFrames, 0.0f);
    micCarveR_.assign(bufferSizeFrames, 0.0f);
    for (auto& lane : outputStorage_) {
        lane.assign(bufferSizeFrames, 0.0f);
    }
#if SCOOPY_PLUGIN_HOST
    returnPluginSlot1_.prepare(sampleRate, static_cast<int>(bufferSizeFrames));
    returnPluginSlot2_.prepare(sampleRate, static_cast<int>(bufferSizeFrames));
    returnPluginSlot3_.prepare(sampleRate, static_cast<int>(bufferSizeFrames));
    returnPluginSlot4_.prepare(sampleRate, static_cast<int>(bufferSizeFrames));
    hostWet1L_.assign(bufferSizeFrames, 0.0f);
    hostWet1R_.assign(bufferSizeFrames, 0.0f);
    hostWet2L_.assign(bufferSizeFrames, 0.0f);
    hostWet2R_.assign(bufferSizeFrames, 0.0f);
    hostWet3L_.assign(bufferSizeFrames, 0.0f);
    hostWet3R_.assign(bufferSizeFrames, 0.0f);
    hostWet4L_.assign(bufferSizeFrames, 0.0f);
    hostWet4R_.assign(bufferSizeFrames, 0.0f);
    for (auto& slot : instrumentSlots_)
        slot.prepare(sampleRate, static_cast<int>(bufferSizeFrames));
    instWetL_.assign(bufferSizeFrames, 0.0f);
    instWetR_.assign(bufferSizeFrames, 0.0f);
    for (auto& f : hostSendFeed_) f.assign(bufferSizeFrames, 0.0f);
#endif
    voiceStretchPool_.configure(sampleRate, static_cast<int>(bufferSizeFrames));
    rbAttackFadeTotal_ = static_cast<std::uint32_t>(std::max(1.0, sampleRate * 0.003));  // ~3 ms

    // Key-lock default: deck bus transpose runs with an ~8 kHz tonality limit (fraction of
    // sample-rate) so pitched material shifts while hats/sibilance keep their character.
    // The debug stretch tuner may still override this at runtime.
    busTonalityLimit_.store(kStretchDefaultTonalityHz / sampleRate, std::memory_order_relaxed);

    // Per-deck PRE-stretch input scratch. The Signalsmith fixed-output path renders a
    // variable input count up to ceil(bufferSizeFrames / kBusStretchMinRatio) per callback,
    // so the input scratch is sized for that worst case. (RubberBand only ever uses
    // bufferSizeFrames; the extra capacity is harmless.)
    const std::size_t busInputScratchFrames =
        static_cast<std::size_t>(std::ceil(static_cast<double>(bufferSizeFrames) / kBusStretchMinRatio)) + 8;
    for (auto& buf : deckScratchLeft_)  { buf.assign(busInputScratchFrames, 0.0f); }
    for (auto& buf : deckScratchRight_) { buf.assign(busInputScratchFrames, 0.0f); }

    // Phase 2: one 6-channel bus stretcher per deck: [mainL, mainR, send1, send2, send3, send4].
    // Backend (RubberBand / Signalsmith) chosen at compile time inside NativeBusStretcher.
    for (std::size_t di = 0; di < kMaxDecks; ++di) {
        // asyncWarmup: the ~200 ms/deck node warm-up runs on background threads instead of
        // blocking configure() — which runs on the MAIN thread via the JUCE device open
        // (NativeJuceDeviceHost::openOnMainThread) and showed up as a ~660 ms launch hang
        // in the Time Profiler. Until a deck's warm-up finishes, isWarm() is false and
        // processDeckBusStretch keeps that bus on its dry path (busBypassPrev_ stays true),
        // so the first post-warm engage still runs the normal primed declick.
        busStretcher_[di].configure(sampleRate, static_cast<int>(kDeckBusChannels),
                                    static_cast<int>(bufferSizeFrames),
                                    /*asyncWarmup=*/true);
        deckSend1Scratch_[di].assign(busInputScratchFrames, 0.0f);
        deckSend2Scratch_[di].assign(busInputScratchFrames, 0.0f);
        deckSend3Scratch_[di].assign(busInputScratchFrames, 0.0f);
        deckSend4Scratch_[di].assign(busInputScratchFrames, 0.0f);
        deckStretchOutL_[di].assign(bufferSizeFrames, 0.0f);
        deckStretchOutR_[di].assign(bufferSizeFrames, 0.0f);
        deckStretchOutS1_[di].assign(bufferSizeFrames, 0.0f);
        deckStretchOutS2_[di].assign(bufferSizeFrames, 0.0f);
        deckStretchOutS3_[di].assign(bufferSizeFrames, 0.0f);
        deckStretchOutS4_[di].assign(bufferSizeFrames, 0.0f);
    }

    // Declick engage/disengage: history rings + scratch. Capacity covers a full
    // engagePrimed() at up to 1/kBusStretchMinRatio (4×) speed-up; engages with less
    // available history are clamped (shorter pre-roll, still seamless at the seam).
    busHistoryCap_ = busStretcher_[0].engageInputLength(1.0 / kBusStretchMinRatio) + 8;
    busXfadeTotal_ = static_cast<std::uint32_t>(std::lround(sampleRate * 0.010));  // ~10 ms
    for (std::size_t di = 0; di < kMaxDecks; ++di) {
        for (auto& ch : busHistory_[di]) ch.assign(static_cast<std::size_t>(busHistoryCap_), 0.0f);
        busHistoryPos_[di] = 0;
        busHistoryCount_[di] = 0;
    }
    for (auto& ch : busHistoryLin_)   ch.assign(static_cast<std::size_t>(busHistoryCap_), 0.0f);
    for (auto& ch : busDisengageWet_) ch.assign(bufferSizeFrames, 0.0f);

    // Tape reverse: per-deck ring buffer holding ~20 s of post-stretch stereo output
    // (matches SequencerNode's tapeRingCapacity). A reverse pass loops over at most
    // capacity/2 frames, comfortably covering long/slow pattern cycles.
    const std::size_t tapeRingFrames = static_cast<std::size_t>(std::lround(sampleRate * 20.0));
    for (std::size_t di = 0; di < kMaxDecks; ++di) {
        tapeReverse_[di].ringL.assign(tapeRingFrames, 0.0f);
        tapeReverse_[di].ringR.assign(tapeRingFrames, 0.0f);
        tapeReverse_[di].capacity   = tapeRingFrames;
        tapeReverse_[di].writeHead  = 0;
        tapeReverse_[di].readHead   = 0;
        tapeReverse_[di].loopLength = 0;
        tapeReverse_[di].readCounter = 0;
        tapeReverse_[di].fraction   = 0.0f;
        tapeReverse_[di].active     = false;
        tapeReverseRequest_[di].store(0, std::memory_order_relaxed);
    }
    return true;
}

void NativeAudioEngineCore::appendBusHistory(std::size_t deck, const float* const* in,
                                             int frames) noexcept {
    if (busHistoryCap_ <= 0 || frames <= 0) return;
    // If a single callback ever exceeds the ring (it can't at current sizes), keep the newest.
    int srcOffset = 0;
    if (frames > busHistoryCap_) { srcOffset = frames - busHistoryCap_; frames = busHistoryCap_; }
    const int pos   = busHistoryPos_[deck];
    const int first = std::min(frames, busHistoryCap_ - pos);
    for (std::size_t ch = 0; ch < kDeckBusChannels; ++ch) {
        float* ring = busHistory_[deck][ch].data();
        std::copy_n(in[ch] + srcOffset, first, ring + pos);
        if (frames > first)
            std::copy_n(in[ch] + srcOffset + first, frames - first, ring);
    }
    busHistoryPos_[deck]   = (pos + frames) % busHistoryCap_;
    busHistoryCount_[deck] = std::min(busHistoryCap_, busHistoryCount_[deck] + frames);
}

int NativeAudioEngineCore::linearizeBusHistory(std::size_t deck, int frames) noexcept {
    if (busHistoryCap_ <= 0) return 0;
    frames = std::min(frames, busHistoryCount_[deck]);
    if (frames <= 0) return 0;
    // Newest `frames` frames end at busHistoryPos_ (exclusive), wrapping backwards.
    int start = busHistoryPos_[deck] - frames;
    if (start < 0) start += busHistoryCap_;
    const int first = std::min(frames, busHistoryCap_ - start);
    for (std::size_t ch = 0; ch < kDeckBusChannels; ++ch) {
        const float* ring = busHistory_[deck][ch].data();
        float* lin = busHistoryLin_[ch].data();
        std::copy_n(ring + start, first, lin);
        if (frames > first)
            std::copy_n(ring, frames - first, lin + first);
    }
    return frames;
}

double NativeAudioEngineCore::pushSpectralParams(std::size_t deck, double sampleRateHz) noexcept {
    // All RT-safe member writes on the stretcher (no reallocation/glitch); Hz → normalized
    // (fraction of sample-rate) happens here so the stretcher only ever sees normalized values.
    //
    // Creative spectral WARPING moved to the standalone Scoopy Spectral FX plugin. The per-deck
    // bus stretcher now carries ONLY the TIME-STRETCH pipeline (window/texture, transpose +
    // key-lock tonality, chaos, air) — the tuning that shapes how TS sync / freeze / scrub
    // sounds. The old creative layer (warp shift/alpha, blur, MOD gesture, X-MOD) is hardwired
    // neutral here so the bus is a pure time/pitch stretcher.
    NativeBusStretcher& bus = busStretcher_[deck];
    bus.setTexture(deckBusTexture_[deck].load(std::memory_order_relaxed));
    const double tSemis = busTransposeSemis_.load(std::memory_order_relaxed)
                        + deckBusTransposeSemis_[deck].load(std::memory_order_relaxed);
    bus.setTranspose(tSemis, busTonalityLimit_.load(std::memory_order_relaxed));
    bus.setWarp(0.0, 1.0, 200.0 / sampleRateHz);
    bus.setGestureTarget(0.0);
    bus.setCrossMod(0.0);
    bus.setSpectralBlur(0.0);
    bus.setPhaseChaos(deckBusChaos_[deck].load(std::memory_order_relaxed));
    bus.setAir(deckBusAirDb_[deck].load(std::memory_order_relaxed));
    return tSemis;
}

void NativeAudioEngineCore::processDeckBusStretch(std::size_t deck, const float* const* inBus,
                                                  float* const* outBus, int inFrames,
                                                  int outFrames, double busRatio,
                                                  bool busNeutral) noexcept {
    // Bypass↔stretch transitions are declicked: engage is primed from the pre-stretch history
    // ring (no cold start / group-delay jump) and both directions crossfade over ~10 ms.
    constexpr float kHalfPi = 1.5707963f;
    const int outN = outFrames;
    if (!busStretcher_[deck].isWarm()) {
        // configure()'s background node warm-up hasn't finished (first ~600 ms after a
        // device open): the warm-up thread owns the stretcher nodes, so stay on the dry
        // path regardless of busNeutral. Keeping busBypassPrev_ true means the first
        // post-warm stretched block enters through the normal primed-engage declick, as
        // if the bus had been neutral all along. History stays current for that prime.
        const int copyN = std::min(inFrames, outN);
        for (int ch = 0; ch < static_cast<int>(kDeckBusChannels); ++ch) {
            std::copy_n(inBus[ch], copyN, outBus[ch]);
            if (copyN < outN)
                std::fill_n(outBus[ch] + copyN, outN - copyN, 0.0f);
        }
        busBypassPrev_[deck] = true;
        appendBusHistory(deck, inBus, inFrames);
        return;
    }
    if (busNeutral) {
        const int copyN = std::min(inFrames, outN);
        if (!busBypassPrev_[deck]) {
            // Stretch → bypass: one last warm process() so the stretcher tail can
            // fade into the dry copy instead of hard-switching output domains.
            float* wet[kDeckBusChannels];
            for (std::size_t ch = 0; ch < kDeckBusChannels; ++ch)
                wet[ch] = busDisengageWet_[ch].data();
            busStretcher_[deck].process(inBus, inFrames, wet, outN, 1.0);
            const int fadeN = std::min<int>(static_cast<int>(busXfadeTotal_), outN);
            for (int ch = 0; ch < static_cast<int>(kDeckBusChannels); ++ch) {
                for (int i = 0; i < fadeN; ++i) {
                    const float t = static_cast<float>(i + 1) / static_cast<float>(fadeN);
                    const float dry = (i < copyN) ? inBus[ch][i] : 0.0f;
                    outBus[ch][i] = dry * std::sin(t * kHalfPi)
                                  + wet[ch][i] * std::cos(t * kHalfPi);
                }
                for (int i = fadeN; i < outN; ++i)
                    outBus[ch][i] = (i < copyN) ? inBus[ch][i] : 0.0f;
            }
        } else {
            for (int ch = 0; ch < static_cast<int>(kDeckBusChannels); ++ch) {
                std::copy_n(inBus[ch], copyN, outBus[ch]);
                if (copyN < outN)
                    std::fill_n(outBus[ch] + copyN, outN - copyN, 0.0f);
            }
        }
    } else {
        const bool engaging = busBypassPrev_[deck];
        if (engaging) {
            // Bypass → stretch: prime from pre-stretch history (outputSeek) so the
            // first stretched block continues seamlessly from the dry timeline —
            // no cold start and no ~120 ms group-delay jump. Falls back to a plain
            // reset when there isn't at least a window of history (e.g. transport
            // start or a freshly activated deck).
            const int need = busStretcher_[deck].engageInputLength(1.0 / busRatio);
            const int have = linearizeBusHistory(deck, need);
            if (have >= busStretcher_[deck].blockFrames()) {
                const float* hist[kDeckBusChannels];
                for (std::size_t ch = 0; ch < kDeckBusChannels; ++ch)
                    hist[ch] = busHistoryLin_[ch].data();
                busStretcher_[deck].engagePrimed(hist, have);
            } else {
                busStretcher_[deck].resetNeutral();
            }
        }
        busStretcher_[deck].process(inBus, inFrames, outBus, outN, busRatio);
        if (engaging) {
            // Short equal-power dry→wet fade masks any residual phase mismatch
            // at the engage seam (dry = this callback's unstretched input; the
            // frame-index mismatch across the fade is inaudible at ratio ≈ 1).
            const int fadeN = std::min<int>(
                { static_cast<int>(busXfadeTotal_), outN, inFrames });
            for (int ch = 0; ch < static_cast<int>(kDeckBusChannels); ++ch) {
                for (int i = 0; i < fadeN; ++i) {
                    const float t = static_cast<float>(i + 1) / static_cast<float>(fadeN);
                    outBus[ch][i] = inBus[ch][i] * std::cos(t * kHalfPi)
                                  + outBus[ch][i] * std::sin(t * kHalfPi);
                }
            }
        }
    }
    busBypassPrev_[deck] = busNeutral;
    // Keep the declick history current (every pre-stretch frame rendered this
    // callback, appended AFTER any engage prime so history ends at block start).
    appendBusHistory(deck, inBus, inFrames);
}

bool NativeAudioEngineCore::start() noexcept {
    if (sampleRate_.load(std::memory_order_acquire) <= 0.0 ||
        bufferSizeFrames_.load(std::memory_order_acquire) == 0) {
        return false;
    }
    running_.store(true, std::memory_order_release);
    return true;
}

void NativeAudioEngineCore::stop() noexcept {
    running_.store(false, std::memory_order_release);
    voiceStretchPool_.reset();
    masterDrive_.reset();
    for (std::size_t di = 0; di < kMaxDecks; ++di) {
        busStretcher_[di].reset();
        deckMasterDrive_[di].reset();
        deckMasterDriveActive_[di] = false;
        tapeReverse_[di].active      = false;
        tapeReverse_[di].fraction    = 0.0f;
        tapeReverse_[di].readCounter = 0;
        tapeReverseRequest_[di].store(0, std::memory_order_relaxed);
    }
}

bool NativeAudioEngineCore::submitMixerState(const MixerState& state) {
    controlMixerState_ = state;
    publishWorld(buildWorld());
    return true;
}

std::uint64_t NativeAudioEngineCore::publishSequencerState(const NativeSequencerSnapshot& snapshot) {
    controlSequencerState_ = snapshot;
    return publishWorld(buildWorld());
}

void NativeAudioEngineCore::enqueueLiveTrigger(const LiveTriggerCommand& command) noexcept {
    const std::uint32_t head = liveTriggerHead_.load(std::memory_order_relaxed);
    const std::uint32_t tail = liveTriggerTail_.load(std::memory_order_acquire);
    // Full when advancing head would collide with the consumer's tail.
    if (((head + 1) & (kLiveTriggerRingSize - 1)) == (tail & (kLiveTriggerRingSize - 1))) {
        liveTriggerOverflowCount_.fetch_add(1, std::memory_order_relaxed);
        return;
    }
    liveTriggerRing_[head & (kLiveTriggerRingSize - 1)] = command;
    liveTriggerHead_.store(head + 1, std::memory_order_release);
}

void NativeAudioEngineCore::enqueueLiveStop(std::uint8_t deck,
                                            std::uint32_t trackIndex,
                                            std::uint64_t voiceId) noexcept {
    LiveTriggerCommand command;
    command.kind = LiveTriggerCommand::Kind::stop;
    command.deck = deck;
    command.trackIndex = trackIndex;
    command.voiceId = voiceId;
    enqueueLiveTrigger(command);
}

void NativeAudioEngineCore::drainLiveTriggers() noexcept {
    if (renderWorld_ == nullptr) {
        // No world yet — discard anything queued so a stale command can't fire later out of context.
        liveTriggerTail_.store(liveTriggerHead_.load(std::memory_order_acquire),
                               std::memory_order_release);
        return;
    }
    const std::uint32_t head = liveTriggerHead_.load(std::memory_order_acquire);
    std::uint32_t tail = liveTriggerTail_.load(std::memory_order_relaxed);
    while (tail != head) {
        const LiveTriggerCommand& cmd = liveTriggerRing_[tail & (kLiveTriggerRingSize - 1)];

        // Resolve which render state + snapshot this command targets. Composition mode uses deck 0
        // against world.sequencerState; DJ mode uses the matching active deck's own snapshot.
        const std::size_t deck = std::min<std::size_t>(cmd.deck, kMaxDecks - 1);
        NativeRenderState* state = nullptr;
        const NativeSequencerSnapshot* snapshot = nullptr;
        if (renderWorld_->djMode) {
            if (renderWorld_->decks[deck].active) {
                state = &callbackRenderState_[deck];
                snapshot = &renderWorld_->decks[deck].snapshot;
            }
        } else if (deck == 0) {
            state = &callbackRenderState_[0];
            snapshot = &renderWorld_->sequencerState;
        }

        if (state != nullptr && snapshot != nullptr) {
            if (cmd.kind == LiveTriggerCommand::Kind::stop) {
                for (auto& voice : state->voices) {
                    if (voice.active && voice.isLiveTrigger
                        && voice.trackIndex == cmd.trackIndex
                        && (cmd.voiceId == 0 || voice.liveVoiceId == cmd.voiceId)
                        && !voice.stopping) {
                        voice.stopping = true;
                        voice.choked = false;  // sqrt fade-out, not the abrupt choke curve
                        voice.fadeFramesRemaining = chokeFadeFrames;
                    }
                }
            } else {
                activateLiveVoice(*renderWorld_, *state, *snapshot, cmd);
            }
        }
        ++tail;
    }
    liveTriggerTail_.store(tail, std::memory_order_release);
}

void NativeAudioEngineCore::activateLiveVoice(const RenderWorld& world,
                                              NativeRenderState& state,
                                              const NativeSequencerSnapshot& snapshot,
                                              const LiveTriggerCommand& cmd) const noexcept {
    if (cmd.trackIndex >= snapshot.tracks.size()) {
        return;
    }
    const NativeTrackSnapshot& track = snapshot.tracks[cmd.trackIndex];

    const std::string sampleId(cmd.sampleId);
    const auto sampleIterator = world.samples.find(sampleId);
    if (sampleIterator == world.samples.end() || !sampleIterator->second) {
        return;
    }
    const NativeSample& sample = *sampleIterator->second;
    if (sample.left.empty()) {
        return;
    }

    const double sampleRate = sampleRate_.load(std::memory_order_relaxed);

    // Cross-track choke: a live retrigger in a non-zero choke group cuts voices of OTHER tracks
    // in the same group (open/closed-hat style). Same-track behaviour is governed by voiceMode.
    // Both cuts are onset-DEFERRED: armDeferredCut at the end of this init (once the voice's
    // position/rate/pre-silence are final) waits until the new note actually sounds.
    const bool wantGroupChoke = track.chokeGroup != 0;
    // Mono voice mode self-cuts the previous voice on this track (last note wins). Poly lets a
    // musical-keyboard chord on one track sustain instead of cutting itself off.
    const bool wantSelfCut = !track.polyphonic;

    auto voiceIterator = acquireVoiceSlot(state);
    if (voiceIterator == state.voices.end()) {
        ++state.droppedVoiceCount;
        return;
    }
    // When stealing an active voice, release its stretch slot and count the steal before reuse.
    if (voiceIterator->active) {
        ++state.stolenVoiceCount;
        if (voiceIterator->rubberBandSlot >= 0) {
            voiceStretchPool_.checkin(voiceIterator->rubberBandSlot);
            voiceIterator->rubberBandSlot = -1;
        }
    }

    // Trim/chop boundaries: explicit start/end (ms) for chop preview, else the track's trim frames.
    const std::size_t trackEndFrame = (track.sampleEndFrame > 0 && track.sampleEndFrame <= sample.left.size())
        ? track.sampleEndFrame : sample.left.size();
    std::size_t sampleEnd = trackEndFrame;
    std::size_t sampleStart = std::min(track.sampleStartFrame, trackEndFrame > 0 ? trackEndFrame - 1 : 0);
    if (cmd.endMs > 0.0) {
        const auto endF = static_cast<std::size_t>(cmd.endMs / 1000.0 * sample.sampleRate);
        sampleEnd = std::min(endF, sample.left.size());
    }
    if (cmd.startMs > 0.0) {
        const auto startF = static_cast<std::size_t>(cmd.startMs / 1000.0 * sample.sampleRate);
        sampleStart = startF < sampleEnd ? startF : 0;
    }
    if (sampleStart >= sampleEnd) {
        sampleStart = 0;
        sampleEnd = sample.left.size();
    }

    const bool effectiveReversed = track.reversed;

    *voiceIterator = {};
    voiceIterator->sample = &sample;
    if (effectiveReversed) {
        voiceIterator->endFrame   = sampleEnd;
        voiceIterator->startFrame = findNearestZeroCrossing(sample, sampleStart);
    } else {
        voiceIterator->startFrame = findNearestZeroCrossing(sample, sampleStart);
        voiceIterator->endFrame   = sampleEnd;
    }

    const std::size_t initialPosition = effectiveReversed
        ? voiceIterator->endFrame - 1
        : voiceIterator->startFrame;
    voiceIterator->position = static_cast<double>(
        findDirectionalZeroCrossing(sample, initialPosition, effectiveReversed));

    // Pitch: Scoopy pitch units → semitones (÷2), plus track global offset and fine tune — matching
    // the sequencer trigger path and musicalKeyDown.
    const double semitones = scoopy::tunedSemitones(
            (track.globalPitchOffset + static_cast<double>(cmd.pitchOffset)) / 2.0, track.tuningIndex)
        + track.fineTuneCents / 100.0;
    const double pitchRate = std::pow(2.0, semitones / 12.0);

    // Phase 11: per-voice stretcher for melodic pitch / per-track time-stretch (no glide for a
    // live one-shot — there is no previous step to ramp from).
    {
        bool needsRB = false;
        double rbTimeRatio  = 1.0;
        double rbPitchScale = 1.0;
        if (track.useTimeStretch && track.speedMultiplier != 1.0) {
            needsRB = true;
            rbTimeRatio = 1.0 / track.speedMultiplier;
        }
        if (track.melodicPitchMode && semitones != 0.0) {
            needsRB = true;
            rbPitchScale = std::pow(2.0, semitones / 12.0);
            if (!track.useTimeStretch) rbTimeRatio = 1.0;
        }
        needsRB = (track.melodicPitchMode && semitones != 0.0)
               || (track.useTimeStretch && track.speedMultiplier != 1.0);
        rbTimeRatio  = (track.useTimeStretch && track.speedMultiplier != 1.0)
                     ? 1.0 / track.speedMultiplier : 1.0;
        rbPitchScale = (track.melodicPitchMode && semitones != 0.0)
                     ? std::pow(2.0, semitones / 12.0) : 1.0;
        // Rate morph: bake the pattern multiplier this voice triggers under (mid-morph voices
        // bake the snapshot's landed target — the per-frame morphM/bakedPatternMult ratio bends
        // them back to the instantaneous glide value, converging to exactly 1 at landing).
        voiceIterator->bakedPatternMult = std::clamp(track.patternSpeedMultiplier, 0.001, 16.0);
        voiceIterator->useRubberBand = needsRB;
        if (needsRB) {
            // Melodic pitch → HQ bank (big window, warble-free tonal shift); per-track
            // time-stretch → standard bank (short window keeps transients tight).
            const bool wantHQ = track.melodicPitchMode && semitones != 0.0;
            const int slot = voiceStretchPool_.checkout(rbTimeRatio, rbPitchScale, wantHQ,
                                                        track.preserveFormants);
            voiceIterator->rubberBandSlot    = slot;
            voiceIterator->rbInputConsumed   = voiceIterator->startFrame;
            voiceIterator->rbOutputAvailable = 0;
            voiceIterator->rbFinalized       = false;
            voiceIterator->rbTimeRatio       = rbTimeRatio;
            if (slot < 0) {
                voiceIterator->useRubberBand          = false;
                voiceIterator->rbLatencySkipRemaining = 0;
                voiceIterator->rate = std::max(0.0001, pitchRate * track.speedMultiplier);
            } else {
                voiceIterator->rbLatencySkipRemaining = voiceStretchPool_.latencyFrames(slot);
                voiceIterator->rate             = 1.0;
                voiceIterator->rbBasePitchScale = rbPitchScale;
                // Prime the stretcher with source pre-roll so the first audible frame is
                // full-quality (no cold-start transient), then fade in over a few ms.
                const bool primeRev = effectiveReversed ^ track.playbackDirectionBackward;
                primeStretchVoice(slot, sample, voiceIterator->startFrame,
                                  voiceIterator->endFrame, primeRev,
                                  rbTimeRatio > 0.0 ? 1.0 / rbTimeRatio : 1.0);
                voiceIterator->rbAttackFadeRemaining = rbAttackFadeTotal_;
            }
        } else {
            voiceIterator->rubberBandSlot = -1;
            voiceIterator->rate = std::max(0.0001, pitchRate * track.speedMultiplier);
        }
    }

    // Velocity scales loudness around the track fader (1.0 = default grid-cell level).
    const float velAccent = std::clamp(cmd.velocity, 0.0f, 4.0f);
    const float effVolume = std::clamp(track.volume * velAccent, 0.0f, 2.0f);
    const float effPan    = std::clamp(track.pan, -1.0f, 1.0f);
    voiceIterator->baseVolume         = effVolume;
    voiceIterator->basePan            = effPan;
    // Live-ramped base decomposition: velocity is the multiplicative component here (no per-step
    // offsets on live triggers), so a fader move recomposes as (liveBase + 0) × velAccent.
    voiceIterator->cellVolMult        = velAccent;
    voiceIterator->bakedVolBase       = track.volume;
    voiceIterator->bakedPanBase       = track.pan;
    voiceIterator->bakedToneBase      = track.tone;
    voiceIterator->bakedPitchBase     = static_cast<float>(track.globalPitchOffset);
    voiceIterator->basePitchSemitones = semitones;
    voiceIterator->leftGain           = effVolume * std::sqrt(0.5f * (1.0f - effPan));
    voiceIterator->rightGain          = effVolume * std::sqrt(0.5f * (1.0f + effPan));
    voiceIterator->send1Level         = track.send1Level;
    voiceIterator->send2Level         = track.send2Level;
    voiceIterator->send3Level         = track.send3Level;
    voiceIterator->send4Level         = track.send4Level;
    // Live triggers carry no per-step automation; clear any offsets left by a pooled voice's
    // previous life (recomposition adds these to the ramped per-track bases).
    voiceIterator->sendOffset[0] = 0.0f;
    voiceIterator->sendOffset[1] = 0.0f;
    voiceIterator->sendOffset[2] = 0.0f;
    voiceIterator->sendOffset[3] = 0.0f;
    voiceIterator->volAdd  = 0.0f;
    voiceIterator->panAdd  = 0.0f;
    voiceIterator->toneAdd = 0.0f;
    voiceIterator->stereoMode         = track.stereoMode;
    voiceIterator->trackIndex         = cmd.trackIndex;
    voiceIterator->chokeGroup         = track.chokeGroup;
    voiceIterator->reversed           = effectiveReversed ^ track.playbackDirectionBackward;

    // Phase 2: LFO depths (read live per-frame from the snapshot during render; these are the
    // trigger-time fallbacks).
    voiceIterator->lfo1PitchDepth   = track.lfo1PitchDepth;
    voiceIterator->lfo2PitchDepth   = track.lfo2PitchDepth;
    voiceIterator->lfo1VolDepth     = track.lfo1VolDepth;
    voiceIterator->lfo2VolDepth     = track.lfo2VolDepth;
    voiceIterator->lfo1PanDepth     = track.lfo1PanDepth;
    voiceIterator->lfo2PanDepth     = track.lfo2PanDepth;
    voiceIterator->lfo1FilterDepth  = track.lfo1FilterDepth;
    voiceIterator->lfo2FilterDepth  = track.lfo2FilterDepth;
    voiceIterator->hasLfoModulation = (track.lfo1PitchDepth != 0.0f || track.lfo2PitchDepth != 0.0f
        || track.lfo1VolDepth != 0.0f || track.lfo2VolDepth != 0.0f
        || track.lfo1PanDepth != 0.0f || track.lfo2PanDepth != 0.0f
        || track.lfo1FilterDepth != 0.0f || track.lfo2FilterDepth != 0.0f);

    // Phase 3: envelope
    {
        const std::size_t totalFrames = voiceIterator->endFrame - voiceIterator->startFrame;
        if (track.attackPercent > 0.0 && totalFrames > 0) {
            const auto attackFrames = static_cast<std::size_t>(
                totalFrames * std::clamp(track.attackPercent / 100.0, 0.0, 1.0));
            voiceIterator->attackEndFrame = voiceIterator->startFrame + attackFrames;
        }
        if (track.releasePercent > 0.0 && totalFrames > 0) {
            const auto releaseFrames = static_cast<std::size_t>(
                totalFrames * std::clamp(track.releasePercent / 100.0, 0.0, 1.0));
            voiceIterator->releaseStartFrame = voiceIterator->endFrame > releaseFrames
                ? voiceIterator->endFrame - releaseFrames : voiceIterator->startFrame;
        }
        voiceIterator->fadeCurveExp = static_cast<float>(std::max(0.1, track.fadeCurve));
    }

    // Phase 6: pre-silence delay
    if (track.preSilenceMs > 0.0) {
        voiceIterator->preSilenceFramesRemaining = static_cast<std::uint32_t>(
            std::max(0.0, track.preSilenceMs / 1000.0 * sampleRate));
    }

    voiceIterator->isLiveTrigger = true;
    voiceIterator->liveVoiceId   = cmd.voiceId;
    voiceIterator->active        = true;
    // Stamp trigger order (mirroring the sequencer trigger path) — the deferred cut relies on
    // it to spare later triggers, and the UI playhead follows the newest serial.
    voiceIterator->triggerSerial = ++state.voiceTriggerSerial;
    // Arm the onset-deferred choke / self-cut now that position, rate, RB mapping and
    // pre-silence are final (a zero delay fires immediately, matching the old trigger-time cut).
    armDeferredCut(state, *voiceIterator, wantGroupChoke, wantSelfCut, chokeFadeFrames);

    // Phase 8: track clipper
    voiceIterator->trackClipper.setParametersFromDrive(track.trackGain);

    // Phase 1: tone filter
    {
        const float effectiveTone = std::clamp(track.tone, -100.0f, 100.0f);
        voiceIterator->baseTone = effectiveTone;
        voiceIterator->toneFilter.sampleRate = sampleRate;
        voiceIterator->toneFilter.reset();
        voiceIterator->toneFilter.setParameters(effectiveTone, track.toneQ, track.toneMode,
                                                track.filterDrive);
    }
}

std::uint64_t NativeAudioEngineCore::publishDJWorld(const std::array<DeckWorld, kMaxDecks>& decks,
                                                    const MixerState& mixer) {
    auto world = std::make_unique<RenderWorld>();
    world->mixerState = mixer;
    world->djMode = true;
    world->decks = decks;

    // Collect all sample IDs referenced across all active decks.
    std::unordered_set<std::string> referencedSampleIds;
    for (std::size_t di = 0; di < kMaxDecks; ++di) {
        if (!decks[di].active) continue;
        for (const auto& track : decks[di].snapshot.tracks) {
            if (!track.sampleId.empty()) {
                referencedSampleIds.insert(track.sampleId);
            }
        }
    }
    for (const auto& sampleId : referencedSampleIds) {
        const auto it = controlSamples_.find(sampleId);
        if (it == controlSamples_.end() || !it->second) {
            world->unsupportedFeatures.push_back("missingSample:" + sampleId);
            continue;
        }
        world->sampleBytes += (it->second->left.size() + it->second->right.size()) * sizeof(float);
        world->samples.emplace(sampleId, it->second);   // shared_ptr copy (no PCM duplication)
    }
    std::sort(world->unsupportedFeatures.begin(), world->unsupportedFeatures.end());
    world->unsupportedFeatures.erase(
        std::unique(world->unsupportedFeatures.begin(), world->unsupportedFeatures.end()),
        world->unsupportedFeatures.end());
    return publishWorld(std::move(world));
}

std::uint64_t NativeAudioEngineCore::publishedWorldGeneration() const noexcept {
    return publishedWorldGeneration_.load(std::memory_order_acquire);
}

std::uint64_t NativeAudioEngineCore::acknowledgedWorldGeneration() const noexcept {
    return acknowledgedWorldGeneration_.load(std::memory_order_acquire);
}

std::size_t NativeAudioEngineCore::retainedWorldCount() const noexcept {
    return ownedWorlds_.size();
}

#if SCOOPY_PLUGIN_HOST
NativeInstrumentSlot* NativeAudioEngineCore::acquireInstrumentSlotForTrack(int deck, int trackIndex) noexcept {
    if (deck < 0 || trackIndex < 0) return nullptr;
    const int key = packInstrumentKey(deck, trackIndex);
    // Already bound to this (deck, track)?
    for (std::size_t i = 0; i < kMaxInstrumentSlots; ++i)
        if (instrumentSlotKey_[i].load(std::memory_order_acquire) == key)
            return &instrumentSlots_[i];
    // Bind the first free slot. compare_exchange guards against the (serialized) producer racing
    // itself; the audio thread only ever reads instrumentSlotKey_.
    for (std::size_t i = 0; i < kMaxInstrumentSlots; ++i) {
        int expected = -1;
        if (instrumentSlotKey_[i].compare_exchange_strong(expected, key,
                                                          std::memory_order_acq_rel))
            return &instrumentSlots_[i];
    }
    return nullptr; // pool exhausted
}

NativeInstrumentSlot* NativeAudioEngineCore::instrumentSlotForTrack(int deck, int trackIndex) noexcept {
    if (deck < 0 || trackIndex < 0) return nullptr;
    const int key = packInstrumentKey(deck, trackIndex);
    for (std::size_t i = 0; i < kMaxInstrumentSlots; ++i)
        if (instrumentSlotKey_[i].load(std::memory_order_acquire) == key)
            return &instrumentSlots_[i];
    return nullptr;
}

void NativeAudioEngineCore::releaseInstrumentSlotForTrack(int deck, int trackIndex) noexcept {
    if (deck < 0 || trackIndex < 0) return;
    const int key = packInstrumentKey(deck, trackIndex);
    for (std::size_t i = 0; i < kMaxInstrumentSlots; ++i) {
        if (instrumentSlotKey_[i].load(std::memory_order_acquire) == key) {
            // Unbind first so the audio thread stops rendering this slot, then unload.
            instrumentSlotKey_[i].store(-1, std::memory_order_release);
            instrumentSlots_[i].unload();
            return;
        }
    }
}

void NativeAudioEngineCore::renderInstrumentsForDeck(int deck,
                                                     const NativeSequencerSnapshot& snapshot,
                                                     const NativeRenderState& lfoState,
                                                     float* mainL, float* mainR,
                                                     float* send1, float* send2,
                                                     float* send3, float* send4,
                                                     std::uint32_t frames) noexcept {
    if (!instrumentHostingEnabled_.load(std::memory_order_acquire)) return;
    if (deck < 0 || frames == 0 || instWetL_.size() < frames || instWetR_.size() < frames) return;
    const double bpm = snapshot.bpm;
    const bool isPlaying = snapshot.isPlaying;
    const double sampleRate = sampleRate_.load(std::memory_order_relaxed);

    // One-per-buffer LFO sample (end-of-buffer phase), matching the return-track approximation.
    // Scaled by each channel's master depth so depth=0 silences modulation here too. When channel
    // 0/1 is an Envelope, use the per-frame envelope output the sequencer render already wrote into
    // lfoState.modChannelValue[] (pre-depth for ch0/1) instead of the analytic LFO waveform.
    const float lfo1Val = static_cast<float>(
        (snapshot.modChannels[0].type == NativeModChannelType::envelope
            ? static_cast<double>(lfoState.modChannelValue[0])
            : lfoWaveValue(lfoState.lfo1Phase, snapshot.lfo1Waveform, snapshot.lfo1Symmetry, lfoState.randVal1))
        * snapshot.modChannels[0].depth);
    const float lfo2Val = static_cast<float>(
        (snapshot.modChannels[1].type == NativeModChannelType::envelope
            ? static_cast<double>(lfoState.modChannelValue[1])
            : lfoWaveValue(lfoState.lfo2Phase, snapshot.lfo2Waveform, snapshot.lfo2Symmetry, lfoState.randVal2))
        * snapshot.modChannels[1].depth);
    constexpr float kPi = 3.14159265f;

    // Live fader overrides (same epoch gate as the per-voice path in renderSequencerFrames): the
    // snapshot params below are republish-coalesced (~25 ms behind a drag), so a moved fader's
    // atomic value wins until the republish carries it — an instrument track's volume/pan/tone/send
    // move is heard on the next block, matching sampler tracks. All callsites are the realtime
    // callback, so renderWorld_ is the world these snapshots came from.
    const std::uint64_t liveOverrideWorldEpoch = renderWorld_ != nullptr
        ? renderWorld_->liveControlEpochAtPublish : 0;
    const bool liveOverridesActive =
        liveControlEpoch_.load(std::memory_order_acquire) > liveOverrideWorldEpoch;

    for (std::size_t i = 0; i < kMaxInstrumentSlots; ++i) {
        const int key = instrumentSlotKey_[i].load(std::memory_order_acquire);
        if (key < 0 || (key >> 16) != deck) continue;   // only slots bound to THIS deck
        const int trackIndex = key & 0xFFFF;
        // Transport stopped: release any held sequencer note so the instrument doesn't hang.
        if (!isPlaying) instrumentSlots_[i].releaseSequencerNoteNow(0);
        // renderInstrument() try-locks and returns false on no-plugin / swap-in-progress (no block).
        if (!instrumentSlots_[i].renderInstrument(instWetL_.data(), instWetR_.data(),
                                                  static_cast<int>(frames), bpm, isPlaying))
            continue;

        // The bound track supplies the per-track DSP params (same fields a sample voice uses), so the
        // instrument modulates identically to a sample track. Missing track → unity passthrough.
        const NativeTrackSnapshot* tk = (static_cast<std::size_t>(trackIndex) < snapshot.tracks.size())
            ? &snapshot.tracks[static_cast<std::size_t>(trackIndex)] : nullptr;

        // Volume (+ LFO vol depth), pan (+ LFO pan depth, equal-power), tone (+ LFO filter depth).
        float effVolume = 1.0f, panAngle = 0.0f;
        float send1Level = 0.0f, send2Level = 0.0f;
        float send3Level = 0.0f, send4Level = 0.0f;
        bool muted = false;
        NativeToneFilter& tone = instrumentTone_[i];
        if (tk != nullptr) {
            float baseVolume = tk->volume;
            float basePan = tk->pan;
            float baseTone = tk->tone;
            float baseQ = tk->toneQ;
            send1Level = tk->send1Level;
            send2Level = tk->send2Level;
            send3Level = tk->send3Level;
            send4Level = tk->send4Level;
            if (liveOverridesActive) {
                if (const LiveTrackControl* ctl = liveControlSlot(deck, trackIndex)) {
                    if (ctl->volumeEpoch.load(std::memory_order_acquire) > liveOverrideWorldEpoch)
                        baseVolume = ctl->volume.load(std::memory_order_acquire);
                    if (ctl->panEpoch.load(std::memory_order_acquire) > liveOverrideWorldEpoch)
                        basePan = ctl->pan.load(std::memory_order_acquire);
                    if (ctl->toneEpoch.load(std::memory_order_acquire) > liveOverrideWorldEpoch)
                        baseTone = ctl->tone.load(std::memory_order_acquire);
                    // Instrument slots already tracked Q via the snapshot (tk->toneQ), so unlike the
                    // sampler voices they were never STUCK — but without this they lag a Q drag by a
                    // republish while every other control on the same row is immediate.
                    if (ctl->qEpoch.load(std::memory_order_acquire) > liveOverrideWorldEpoch)
                        baseQ = ctl->q.load(std::memory_order_acquire);
                    if (ctl->sendEpoch[0].load(std::memory_order_acquire) > liveOverrideWorldEpoch)
                        send1Level = ctl->send[0].load(std::memory_order_acquire);
                    if (ctl->sendEpoch[1].load(std::memory_order_acquire) > liveOverrideWorldEpoch)
                        send2Level = ctl->send[1].load(std::memory_order_acquire);
                    if (ctl->sendEpoch[2].load(std::memory_order_acquire) > liveOverrideWorldEpoch)
                        send3Level = ctl->send[2].load(std::memory_order_acquire);
                    if (ctl->sendEpoch[3].load(std::memory_order_acquire) > liveOverrideWorldEpoch)
                        send4Level = ctl->send[3].load(std::memory_order_acquire);
                }
            }
            const float volMod = lfo1Val * tk->lfo1VolDepth + lfo2Val * tk->lfo2VolDepth;
            effVolume = std::clamp(baseVolume + volMod, 0.0f, 3.0f);
            const float panMod = lfo1Val * tk->lfo1PanDepth + lfo2Val * tk->lfo2PanDepth;
            const float pan = std::clamp(basePan + panMod, -1.0f, 1.0f);
            panAngle = pan * kPi * 0.25f;
            // User mute / solo now travels on mixMuted (decomposed from the trigger-gate `muted`,
            // which carries only stop/pause). Instruments keep the hard per-block skip — that was
            // already immediate.
            muted = tk->muted || tk->mixMuted;
            const float toneMod = lfo1Val * tk->lfo1FilterDepth + lfo2Val * tk->lfo2FilterDepth;
            const float effTone = std::clamp(baseTone + toneMod, -100.0f, 100.0f);
            tone.sampleRate = sampleRate > 0.0 ? sampleRate : tone.sampleRate;
            tone.setParameters(effTone, baseQ, tk->toneMode, tk->filterDrive);
        } else {
            tone.setParameters(0.0f, 0.7071f, NativeToneFilter::Mode::tone);
        }
        if (muted) continue;
        const float gainL = std::cos(panAngle + kPi * 0.25f) * effVolume;
        const float gainR = std::sin(panAngle + kPi * 0.25f) * effVolume;

        // Per-track output routing: placement-weight targets (this path is realtime-only, so the
        // atomic alone gates it). Glided across the block like the sends so flips are click-free.
        const bool instRoutingOn = perTrackRoutingActive_.load(std::memory_order_relaxed);
        const float at1 = (instRoutingOn && tk != nullptr && tk->outputAssign == 1) ? 1.0f : 0.0f;
        const float at2 = (instRoutingOn && tk != nullptr && tk->outputAssign == 2) ? 1.0f : 0.0f;
        auto& aCur = instrumentAssignCurrent_[i];
        const bool doAssign = at1 != 0.0f || at2 != 0.0f || aCur[0] != 0.0f || aCur[1] != 0.0f;
        const float aInc1 = (at1 - aCur[0]) / static_cast<float>(frames);
        const float aInc2 = (at2 - aCur[1]) / static_cast<float>(frames);
        float aw1 = aCur[0], aw2 = aCur[1];

        // De-click: glide this slot's send levels across the block toward the (override-aware)
        // target — sustained instrument audio would otherwise step hard on a send fader flick.
        auto& sCur = instrumentSendCurrent_[i];
        const float sInc1 = (send1Level - sCur[0]) / static_cast<float>(frames);
        const float sInc2 = (send2Level - sCur[1]) / static_cast<float>(frames);
        const float sInc3 = (send3Level - sCur[2]) / static_cast<float>(frames);
        const float sInc4 = (send4Level - sCur[3]) / static_cast<float>(frames);
        const bool doS1 = send1 != nullptr && (send1Level != 0.0f || sCur[0] != 0.0f);
        const bool doS2 = send2 != nullptr && (send2Level != 0.0f || sCur[1] != 0.0f);
        const bool doS3 = send3 != nullptr && (send3Level != 0.0f || sCur[2] != 0.0f);
        const bool doS4 = send4 != nullptr && (send4Level != 0.0f || sCur[3] != 0.0f);
        float s1 = sCur[0], s2 = sCur[1], s3 = sCur[2], s4 = sCur[3];

        // SIG-3 activity tap: the LED's headline case is exactly this path — a plugin that keeps
        // sounding after transport stop is invisible to every sequencer-side signal. Muted slots
        // `continue` above, so they correctly read 0.
        float slotPeak = 0.0f;

        for (std::uint32_t f = 0; f < frames; ++f) {
            float l = instWetL_[f];
            float r = instWetR_[f];
            tone.processSample(l, r);          // stereo tone filter (in place, no-op when |tone|<=0.5)
            if (doAssign) {
                // Per-track output routing: pan-free mono (cos²+sin² = 1, so effVolume is the
                // exact pan-free gain) blended against the normal panned placement.
                const float mono = (l + r) * 0.70710678f * effVolume; // L+R, −3 dB
                l *= gainL;
                r *= gainR;
                aw1 += aInc1; aw2 += aInc2;
                const float nW = std::max(0.0f, 1.0f - aw1 - aw2);
                if (mainL) mainL[f] += l * nW + mono * aw1;
                if (mainR) mainR[f] += r * nW + mono * aw2;
            } else {
                l *= gainL;
                r *= gainR;
                if (mainL) mainL[f] += l;
                if (mainR) mainR[f] += r;
            }
            // Sends are mono-accumulated (matches the per-voice send path). Pre-fader-ish: scale the
            // post-pan signal by the per-track send level into the global send bus.
            s1 += sInc1; s2 += sInc2; s3 += sInc3; s4 += sInc4;
            if (doS1) send1[f] += (l + r) * 0.5f * s1;
            if (doS2) send2[f] += (l + r) * 0.5f * s2;
            if (doS3) send3[f] += (l + r) * 0.5f * s3;
            if (doS4) send4[f] += (l + r) * 0.5f * s4;
            // SIG-3: true per-channel peak (l/r are post-tone, post-gain here) — see the
            // voice-loop twin. max(|L|,|R|) so the meter reads a hard-panned hot instrument.
            slotPeak = std::max(slotPeak, std::max(std::fabs(l), std::fabs(r)));
        }
        sCur[0] = send1Level; sCur[1] = send2Level; sCur[2] = send3Level; sCur[3] = send4Level;
        aCur[0] = at1; aCur[1] = at2;
        if (deck >= 0 && static_cast<std::size_t>(deck) < kMaxDecks
            && static_cast<std::size_t>(trackIndex) < kMaxEnvelopeTracks) {
            float& blockPeak = callbackRenderState_[static_cast<std::size_t>(deck)]
                                   .trackMixBlockPeak[static_cast<std::size_t>(trackIndex)];
            blockPeak = std::max(blockPeak, slotPeak);
        }
    }
}

bool NativeAudioEngineCore::generateInstrumentMidiForTrack(const NativeTrackSnapshot& track,
                                                           int deck,
                                                           int trackIndex,
                                                           std::uint64_t masterStep,
                                                           std::uint64_t stepFrame,
                                                           const NativeRenderState& state,
                                                           std::uint32_t outputFrame) const noexcept {
    const int key = packInstrumentKey(deck, trackIndex);
    NativeInstrumentSlot* slot = nullptr;
    for (std::size_t i = 0; i < kMaxInstrumentSlots; ++i)
        if (instrumentSlotKey_[i].load(std::memory_order_acquire) == key) { slot = &instrumentSlots_[i]; break; }
    if (slot == nullptr) return false;   // no bound instrument → caller falls through to external MIDI

    // From here the slot owns this track; every exit returns true so external MIDI is skipped.
    if (deck < 0 || deck >= static_cast<int>(kMaxDecks)) return true;
    if (trackIndex < 0 || trackIndex >= static_cast<int>(kMaxMidiVoiceTracks)) return true;
    if (track.steps.empty() || state.currentFramesPerStep == 0) return true;

    NativeMidiSink sink;
    sink.slot = slot;
    sink.sampleRate = sampleRate_.load(std::memory_order_relaxed);

    NativeMidiVoiceState& voice =
        midiVoices_[static_cast<std::size_t>(deck)][static_cast<std::size_t>(trackIndex)]
                   [static_cast<std::size_t>(NativeMidiDest::instrument)];

    // Service BEFORE trigger: a gate expiring exactly on this boundary must note-off before the
    // next note-on, or the synth hears an overlap it never got in the pattern.
    serviceMidiVoice(voice, sink, outputFrame);

    std::size_t step = 0;
    if (resolveMidiTriggerStep(track, trackIndex, masterStep, stepFrame, state, step))
        triggerMidiCell(track, voice, sink, step, state, outputFrame);
    return true;
}
#endif

// ─── Expressive MIDI note generation ─────────────────────────────────────────────────────────
// One state machine, two destinations. A hosted instrument and an external port read the SAME
// per-cell data (length, accent, chord, flam, pre-silence, glide), so the musical logic lives
// here once and the NativeMidiSink decides where the bytes land.

void NativeAudioEngineCore::midiSend(const NativeMidiSink& sink, std::uint8_t status,
                                     std::uint8_t d1, std::uint8_t d2,
                                     std::uint32_t frame) const noexcept {
#if SCOOPY_PLUGIN_HOST
    if (sink.slot != nullptr) { sink.slot->addMidiNow(status, d1, d2, frame); return; }
#endif
#if SCOOPY_MIDI_HARDWARE
    if (sink.out != nullptr)
        sink.out->pushMessage(renderBlockHostTime_, sink.sampleRate, frame, status, d1, d2, 3);
#else
    // No MIDI hardware in this build (browser): the external note-out is compiled out, so there is
    // nothing to push to and no symbol to link. Same shape as the SCOOPY_PLUGIN_HOST guard above.
    (void)sink; (void)status; (void)d1; (void)d2; (void)frame;
#endif
}

// 14-bit pitch bend for a signed semitone offset, against the assumed bend range.
static inline int midiBendValue(float semitones) noexcept {
    const float norm = std::clamp(semitones / static_cast<float>(kMidiBendRangeSemitones), -1.0f, 1.0f);
    return std::clamp(8192 + static_cast<int>(std::lround(norm * 8191.0f)), 0, 16383);
}

// Park a hit in the voice's schedule. Full ring (>16 hits pending on one track) → drop it; the
// audio thread never allocates and a dropped ratchet tail beats a glitch.
static inline void scheduleMidiHit(NativeMidiVoiceState& voice,
                                   const NativeMidiPendingHit& hit) noexcept {
    for (auto& slot : voice.pending)
        if (slot.framesLeft < 0) { slot = hit; return; }
}

bool NativeAudioEngineCore::resolveMidiTriggerStep(const NativeTrackSnapshot& track,
                                                   int trackIndex,
                                                   std::uint64_t masterStep,
                                                   std::uint64_t stepFrame,
                                                   const NativeRenderState& state,
                                                   std::size_t& outStep) const noexcept {
    const std::size_t nSteps = track.steps.size();
    if (nSteps == 0 || state.currentFramesPerStep == 0) return false;

    // Step-boundary detection: identical to the sample-voice path (patternSpeedMultiplier ratchet),
    // minus rhythmic offset / humanize — MIDI notes land on the grid.
    std::uint64_t triggerOffset = 0;
    if (!triggerOffsetAtFrame(masterStep, stepFrame, state.currentFramesPerStep,
                              track.patternSpeedMultiplier, /*rhythmicOffsetFrames*/ 0,
                              triggerOffset))
        return false;

    const auto localStep = static_cast<std::uint64_t>(
        std::floor(static_cast<double>(masterStep) * track.patternSpeedMultiplier + 0.000001))
        + triggerOffset;

    std::size_t stepInRange = static_cast<std::size_t>(localStep % nSteps);
    if (track.randomize) {
        // Deterministic pick of an active step (no rand() on the audio thread): hash the boundary.
        std::uint64_t activeCount = 0;
        for (std::size_t s = 0; s < nSteps; ++s) if (track.steps[s]) ++activeCount;
        if (activeCount == 0) return false;
        std::uint64_t h = (localStep * 2654435761ULL) ^ (static_cast<std::uint64_t>(trackIndex) * 0x9e3779b9ULL);
        h ^= h >> 33; h *= 0xff51afd7ed558ccdULL; h ^= h >> 33;
        std::uint64_t pick = h % activeCount;
        std::size_t chosen = 0;
        for (std::size_t s = 0; s < nSteps; ++s) if (track.steps[s]) { if (pick == 0) { chosen = s; break; } --pick; }
        stepInRange = chosen;
    }
    const std::size_t actualStep = track.playbackDirectionBackward
        ? (nSteps - 1 - (stepInRange % nSteps)) : (stepInRange % nSteps);
    if (actualStep >= nSteps || !track.steps[actualStep]) return false;

    outStep = actualStep;
    return true;
}

void NativeAudioEngineCore::fireMidiHit(NativeMidiVoiceState& voice, const NativeMidiSink& sink,
                                        const NativeMidiPendingHit& hit, std::uint8_t channel,
                                        std::uint32_t outputFrame) const noexcept {
    for (std::size_t i = 0; i < kMaxMidiHeldNotes; ++i) {
        if (hit.notes[i] < 0) continue;

        std::size_t slot = kMaxMidiHeldNotes;
        for (std::size_t j = 0; j < kMaxMidiHeldNotes; ++j)
            if (voice.heldNote[j] < 0) { slot = j; break; }
        if (slot == kMaxMidiHeldNotes) {
            // All voices sounding (a chord over a still-ringing chord): steal the oldest.
            midiSend(sink, static_cast<std::uint8_t>(0x80 | (voice.heldChannel & 0x0F)),
                     static_cast<std::uint8_t>(voice.heldNote[0]), 0, outputFrame);
            voice.heldNote[0] = -1;
            voice.heldFrames[0] = -1;
            slot = 0;
        }

        midiSend(sink, static_cast<std::uint8_t>(0x90 | (channel & 0x0F)),
                 static_cast<std::uint8_t>(hit.notes[i]), hit.velocity, outputFrame);
        voice.heldNote[slot] = static_cast<std::int16_t>(hit.notes[i]);
        // gate 0 = hold until the next trigger releases it (the pre-gate behaviour).
        voice.heldFrames[slot] = hit.gateFrames > 0 ? hit.gateFrames : -1;
    }
    voice.heldChannel = channel;
}

void NativeAudioEngineCore::releaseMidiVoice(NativeMidiVoiceState& voice, const NativeMidiSink& sink,
                                             std::uint32_t outputFrame, bool dropPending) const noexcept {
    for (std::size_t i = 0; i < kMaxMidiHeldNotes; ++i) {
        if (voice.heldNote[i] < 0) continue;
        midiSend(sink, static_cast<std::uint8_t>(0x80 | (voice.heldChannel & 0x0F)),
                 static_cast<std::uint8_t>(voice.heldNote[i]), 0, outputFrame);
        voice.heldNote[i] = -1;
        voice.heldFrames[i] = -1;
    }
    if (!dropPending) return;

    for (auto& p : voice.pending) p.framesLeft = -1;
    voice.glideFramesLeft = 0;
    voice.glideTotalFrames = 0;
    voice.glideLandNote = -1;
    if (voice.bendActive) {
        // Never leave the channel bent — the next note would sound off-pitch.
        const int centre = midiBendValue(0.0f);
        midiSend(sink, static_cast<std::uint8_t>(0xE0 | (voice.heldChannel & 0x0F)),
                 static_cast<std::uint8_t>(centre & 0x7F),
                 static_cast<std::uint8_t>((centre >> 7) & 0x7F), outputFrame);
        voice.bendActive = false;
    }
    voice.bendFromSemis = 0.0f;
    voice.bendToSemis = 0.0f;
}

void NativeAudioEngineCore::serviceMidiVoice(NativeMidiVoiceState& voice, const NativeMidiSink& sink,
                                             std::uint32_t outputFrame) const noexcept {
    // 1. Gates that expire on this frame. Before everything else, so a note-off always precedes the
    //    note-on that replaces it.
    for (std::size_t i = 0; i < kMaxMidiHeldNotes; ++i) {
        if (voice.heldNote[i] < 0 || voice.heldFrames[i] < 0) continue;
        if (voice.heldFrames[i] > 0) --voice.heldFrames[i];
        if (voice.heldFrames[i] != 0) continue;
        midiSend(sink, static_cast<std::uint8_t>(0x80 | (voice.heldChannel & 0x0F)),
                 static_cast<std::uint8_t>(voice.heldNote[i]), 0, outputFrame);
        voice.heldNote[i] = -1;
        voice.heldFrames[i] = -1;
    }

    // 2. Glide: ride the pitch bend from the note we're leaving toward the one we're heading for.
    if (voice.glideFramesLeft > 0) {
        --voice.glideFramesLeft;
        const bool landed = (voice.glideFramesLeft == 0);
        if (voice.bendTickFrames > 0) --voice.bendTickFrames;

        if (voice.bendTickFrames == 0 || landed) {
            const double t = voice.glideTotalFrames > 0
                ? 1.0 - static_cast<double>(voice.glideFramesLeft) / static_cast<double>(voice.glideTotalFrames)
                : 1.0;
            const float semis = voice.bendFromSemis
                + static_cast<float>(t) * (voice.bendToSemis - voice.bendFromSemis);
            const int bend = midiBendValue(semis);
            midiSend(sink, static_cast<std::uint8_t>(0xE0 | (voice.heldChannel & 0x0F)),
                     static_cast<std::uint8_t>(bend & 0x7F),
                     static_cast<std::uint8_t>((bend >> 7) & 0x7F), outputFrame);
            const double sr = sink.sampleRate > 0.0 ? sink.sampleRate : 44100.0;
            voice.bendTickFrames = std::max(1, static_cast<int>(std::lround(sr * kMidiBendIntervalSeconds)));
        }

        if (landed && voice.glideLandNote >= 0) {
            // The leap was wider than the bend range: we rode the bend to its edge, now reset it and
            // re-articulate the real note so the phrase LANDS IN TUNE.
            NativeMidiPendingHit land;
            land.velocity = voice.glideLandVelocity;
            land.gateFrames = voice.glideLandGate;
            land.notes[0] = static_cast<std::int8_t>(voice.glideLandNote);
            const std::uint8_t channel = voice.heldChannel;
            voice.glideLandNote = -1;
            releaseMidiVoice(voice, sink, outputFrame, /*dropPending*/ true);   // also centres the bend
            fireMidiHit(voice, sink, land, channel, outputFrame);
        }
    }

    // 3. Scheduled hits (flam repeats / a pre-silence-delayed root) coming due.
    for (auto& p : voice.pending) {
        if (p.framesLeft < 0) continue;
        if (p.framesLeft > 0) --p.framesLeft;
        if (p.framesLeft != 0) continue;
        const NativeMidiPendingHit fired = p;
        p.framesLeft = -1;
        fireMidiHit(voice, sink, fired, voice.heldChannel, outputFrame);
    }
}

void NativeAudioEngineCore::triggerMidiCell(const NativeTrackSnapshot& track,
                                            NativeMidiVoiceState& voice,
                                            const NativeMidiSink& sink,
                                            std::size_t step,
                                            const NativeRenderState& state,
                                            std::uint32_t outputFrame) const noexcept {
    const std::uint8_t channel = static_cast<std::uint8_t>(track.midiChannel & 0x0F);
    const double sr = sink.sampleRate > 0.0 ? sink.sampleRate : 44100.0;

    // ── Velocity: the per-step lane, then ACCENT on top (the same ×1.25 / ×1.5 the sample path
    //    applies to gain — an accent is loudness, and in MIDI loudness is velocity).
    int velocity = static_cast<int>(track.midiVelocity);
    if (step < track.midiVelocities.size()) velocity = static_cast<int>(track.midiVelocities[step]);
    if (velocity <= 0) {   // velocity 0 = a gate step: silence what's ringing, sound nothing new.
        releaseMidiVoice(voice, sink, outputFrame, /*dropPending*/ true);
        return;
    }
    if (step < track.accentLevels.size()) {
        const float a = track.accentLevels[step];
        const double mul = (a >= 1.5f) ? 1.5 : (a >= 0.5f ? 1.25 : 1.0);
        velocity = static_cast<int>(std::lround(static_cast<double>(velocity) * mul));
    }
    velocity = std::clamp(velocity, 1, 127);

    // ── Notes: the root is the track's ROOT NOTE transposed by this cell's pitch (quarter-tones →
    //    semitones — the same pitchOffsets lane the sampler pitches with), plus the chord's voices.
    const double pitch = step < track.pitchOffsets.size() ? track.pitchOffsets[step] : 0.0;
    const int root = std::clamp(static_cast<int>(track.midiRootNote)
                                + static_cast<int>(std::lround(pitch / 2.0)), 0, 127);

    NativeMidiPendingHit hit;
    hit.velocity = static_cast<std::uint8_t>(velocity);
    hit.notes[0] = static_cast<std::int8_t>(root);
    std::size_t voiceCount = 1;
    if (track.hasChordCells) {
        const std::size_t base = step * static_cast<std::size_t>(kMaxChordExtraNotes);
        for (int k = 0; k < kMaxChordExtraNotes && voiceCount < kMaxMidiHeldNotes; ++k) {
            const std::size_t idx = base + static_cast<std::size_t>(k);
            if (idx >= track.chordIntervals.size()) break;
            const int interval = static_cast<int>(track.chordIntervals[idx]);
            if (interval == 0) continue;                       // 0 = unused slot
            const int n = root + interval;
            if (n < 0 || n > 127) continue;
            hit.notes[voiceCount++] = static_cast<std::int8_t>(n);
        }
    }

    // ── Timing. The cell's LENGTH is the note's length; the gate only shortens it.
    const double mult = track.patternSpeedMultiplier > 0.0 ? track.patternSpeedMultiplier : 1.0;
    const double stepFrames = static_cast<double>(state.currentFramesPerStep) / mult;
    std::size_t lenSteps = 1;
    if (step < track.cellLengths.size() && track.cellLengths[step] > 0)
        lenSteps = track.cellLengths[step];
    const double cellFrames = stepFrames * static_cast<double>(lenSteps);
    const double gate = std::clamp(track.midiGatePercent, 1.0, 100.0) * 0.01;

    // Pre-silence delays the note INSIDE its cell — the gap you see in the grid is the gap you hear.
    double preMs = track.preSilenceMs;
    if (step < track.preSilenceMsOffsets.size()) preMs += track.preSilenceMsOffsets[step];
    std::int32_t delayFrames = preMs > 0.0
        ? static_cast<std::int32_t>(std::lround(preMs * 0.001 * sr)) : 0;
    delayFrames = std::clamp(delayFrames, 0,
                             static_cast<std::int32_t>(std::max(0.0, cellFrames - 1.0)));

    int hits = 1;
    if (track.hasFlamCells && step < track.flamCounts.size())
        hits = std::clamp(static_cast<int>(track.flamCounts[step]), 1, kMaxFlam);

    // ── GLIDE: slide into this cell instead of re-articulating it. Only a single un-chorded note
    //    landing on top of something already ringing can slide — a chord or a flam has nothing to
    //    slide FROM, and a pre-silenced note has already broken the legato.
    const bool glideFlag = step < track.glideSteps.size() && track.glideSteps[step];
    if (glideFlag && hits == 1 && voiceCount == 1 && delayFrames == 0 && voice.heldNote[0] >= 0) {
        const int delta = root - static_cast<int>(voice.heldNote[0]);
        const double glidePct = std::clamp(track.glidePercentBetweenSteps, 0.0, 100.0);
        const auto glideFrames = static_cast<std::int32_t>(
            std::lround(glidePct * 0.01 * stepFrames));

        const int reach = std::clamp(delta, -kMidiBendRangeSemitones, kMidiBendRangeSemitones);
        voice.bendFromSemis = voice.bendActive ? voice.bendToSemis : 0.0f;   // resume from where we are
        voice.bendToSemis = static_cast<float>(reach);
        voice.glideTotalFrames = std::max(1, std::clamp(glideFrames, 0,
                                          static_cast<std::int32_t>(cellFrames)));
        voice.glideFramesLeft = voice.glideTotalFrames;
        voice.bendTickFrames = 1;                                            // first bend next frame
        voice.bendActive = (voice.bendFromSemis != 0.0f) || (reach != 0);
        // A leap the bend can't cover lands with a re-trigger when the ramp finishes.
        voice.glideLandNote = (delta != reach) ? static_cast<std::int16_t>(root) : std::int16_t{-1};
        voice.glideLandVelocity = static_cast<std::uint8_t>(velocity);
        voice.glideLandGate = std::max(1, static_cast<std::int32_t>(std::lround(cellFrames * gate)));

        // The held note keeps sounding — extend its gate over the cell we just slid into.
        voice.heldFrames[0] = voice.glideLandGate;
        voice.heldChannel = channel;
        return;
    }

    // ── Hard articulation: everything ringing stops, the bend re-centres, the cell sounds.
    releaseMidiVoice(voice, sink, outputFrame, /*dropPending*/ true);
    voice.heldChannel = channel;

    // The per-step pitch-bend lane (independent of glide) still rides ahead of the note.
    if (step < track.midiPitchBends.size() && track.midiPitchBends[step] != 0) {
        const int bend = std::clamp(track.midiPitchBends[step] + 8192, 0, 16383);
        midiSend(sink, static_cast<std::uint8_t>(0xE0 | channel),
                 static_cast<std::uint8_t>(bend & 0x7F),
                 static_cast<std::uint8_t>((bend >> 7) & 0x7F), outputFrame);
        voice.bendActive = true;
    }

    if (hits <= 1) {
        hit.gateFrames = std::max(1, static_cast<std::int32_t>(std::lround(cellFrames * gate)));
        if (delayFrames > 0) {
            hit.framesLeft = delayFrames;
            scheduleMidiHit(voice, hit);
        } else {
            fireMidiHit(voice, sink, hit, channel, outputFrame);
        }
        return;
    }

    // ── FLAM: the repeats fan inside the OWNER STEP — the same place the grid draws them, so what
    //    you see is what you hear. The LAST hit runs on to the end of the cell, so a flam on a long
    //    cell reads as grace notes into a held note rather than a burst followed by silence.
    const double interval = stepFrames / static_cast<double>(hits);
    for (int h = 0; h < hits; ++h) {
        NativeMidiPendingHit repeat = hit;
        const double onset = static_cast<double>(delayFrames) + interval * static_cast<double>(h);
        const double span = (h == hits - 1)
            ? std::max(interval, cellFrames - interval * static_cast<double>(h))
            : interval;
        repeat.gateFrames = std::max(1, static_cast<std::int32_t>(std::lround(span * gate)));

        const auto onsetFrames = static_cast<std::int32_t>(std::lround(onset));
        if (onsetFrames <= 0) {
            repeat.framesLeft = -1;
            fireMidiHit(voice, sink, repeat, channel, outputFrame);
        } else {
            repeat.framesLeft = onsetFrames;
            scheduleMidiHit(voice, repeat);
        }
    }
}

void NativeAudioEngineCore::sendMidiDialCCs(const NativeTrackSnapshot& track,
                                            NativeMidiVoiceState& voice,
                                            const NativeMidiSink& sink,
                                            std::uint32_t outputFrame) const noexcept {
    // A MIDI-OUT-only track has no audio path, so its DSP dials would move nothing. Instead they
    // speak MIDI: volume → CC 7, pan → CC 10, tone → CC 74. Sent only on a real change, and never
    // faster than one burst per bend interval, so a fader sweep can't flood a 31250-baud port.
    if (voice.ccTickFrames > 0) { --voice.ccTickFrames; return; }

    const std::uint8_t channel = static_cast<std::uint8_t>(track.midiChannel & 0x0F);
    const int vol = std::clamp(static_cast<int>(std::lround(
        std::clamp(static_cast<double>(track.volume), 0.0, 1.0) * 127.0)), 0, 127);
    const int pan = std::clamp(static_cast<int>(std::lround(
        (std::clamp(static_cast<double>(track.pan), -1.0, 1.0) + 1.0) * 63.5)), 0, 127);
    const int tone = std::clamp(static_cast<int>(std::lround(
        (std::clamp(static_cast<double>(track.tone), -100.0, 100.0) + 100.0) * 0.635)), 0, 127);

    bool sent = false;
    if (vol != voice.lastVolumeCC) {
        midiSend(sink, static_cast<std::uint8_t>(0xB0 | channel), 7, static_cast<std::uint8_t>(vol), outputFrame);
        voice.lastVolumeCC = static_cast<std::int16_t>(vol);
        sent = true;
    }
    if (pan != voice.lastPanCC) {
        midiSend(sink, static_cast<std::uint8_t>(0xB0 | channel), 10, static_cast<std::uint8_t>(pan), outputFrame);
        voice.lastPanCC = static_cast<std::int16_t>(pan);
        sent = true;
    }
    if (tone != voice.lastToneCC) {
        midiSend(sink, static_cast<std::uint8_t>(0xB0 | channel), 74, static_cast<std::uint8_t>(tone), outputFrame);
        voice.lastToneCC = static_cast<std::int16_t>(tone);
        sent = true;
    }
    if (sent) {
        const double sr = sink.sampleRate > 0.0 ? sink.sampleRate : 44100.0;
        voice.ccTickFrames = std::max(1, static_cast<int>(std::lround(sr * kMidiBendIntervalSeconds)));
    }
}

void NativeAudioEngineCore::generateExternalMidiForTrack(const NativeTrackSnapshot& track,
                                                         int deck,
                                                         int trackIndex,
                                                         std::uint64_t masterStep,
                                                         std::uint64_t stepFrame,
                                                         const NativeRenderState& state,
                                                         std::uint32_t outputFrame,
                                                         bool sendDialCCs) const noexcept {
#if !SCOOPY_MIDI_HARDWARE
    // No MIDI hardware in this build (browser): external note-out is compiled out entirely, so
    // there is nothing to feed and no symbol to link. The pointer is always null here.
    (void)deck; (void)trackIndex; (void)track; (void)stepFrame; (void)state; (void)outputFrame;
    (void)sendDialCCs;
    return;
#else
    if (midiNoteOut_ == nullptr || !midiNoteOut_->isEnabled()) return; // no bookkeeping when off
    if (deck < 0 || deck >= static_cast<int>(kMaxDecks)) return;       // offline render passes -1
    if (trackIndex < 0 || trackIndex >= static_cast<int>(kMaxMidiVoiceTracks)) return;
    if (track.steps.empty() || state.currentFramesPerStep == 0) return;

    NativeMidiSink sink;
    sink.out = midiNoteOut_;
    sink.blockHostTime = renderBlockHostTime_;
    sink.sampleRate = sampleRate_.load(std::memory_order_relaxed);

    NativeMidiVoiceState& voice =
        midiVoices_[static_cast<std::size_t>(deck)][static_cast<std::size_t>(trackIndex)]
                   [static_cast<std::size_t>(NativeMidiDest::external)];

    // Only a track with NO audio path of its own lets its DSP dials speak CC — on a sampler or an
    // instrument those dials move real audio, and doubling them onto CC would be a second, invisible
    // owner of the same gesture.
    if (sendDialCCs) sendMidiDialCCs(track, voice, sink, outputFrame);
    serviceMidiVoice(voice, sink, outputFrame);

    std::size_t step = 0;
    if (resolveMidiTriggerStep(track, trackIndex, masterStep, stepFrame, state, step))
        triggerMidiCell(track, voice, sink, step, state, outputFrame);
#endif // SCOOPY_MIDI_HARDWARE
}

void NativeAudioEngineCore::flushGeneratedMidiNotes(double sampleRate,
                                                    std::uint32_t outputFrame) const noexcept {
    for (std::size_t d = 0; d < kMaxDecks; ++d) {
        for (std::size_t t = 0; t < kMaxMidiVoiceTracks; ++t) {
            for (std::size_t dest = 0; dest < kMidiDestCount; ++dest) {
                NativeMidiVoiceState& voice = midiVoices_[d][t][dest];

                bool idle = (voice.glideFramesLeft == 0);
                for (std::size_t i = 0; idle && i < kMaxMidiHeldNotes; ++i)
                    if (voice.heldNote[i] >= 0) idle = false;
                for (std::size_t i = 0; idle && i < kMaxMidiPendingHits; ++i)
                    if (voice.pending[i].framesLeft >= 0) idle = false;
                if (idle) continue;

                // The destination is the slot's own index, so one pass reaches both.
                NativeMidiSink sink;
                sink.sampleRate = sampleRate;
                sink.blockHostTime = renderBlockHostTime_;
                if (dest == static_cast<std::size_t>(NativeMidiDest::instrument)) {
#if SCOOPY_PLUGIN_HOST
                    const int key = packInstrumentKey(static_cast<int>(d), static_cast<int>(t));
                    for (std::size_t i = 0; i < kMaxInstrumentSlots; ++i)
                        if (instrumentSlotKey_[i].load(std::memory_order_acquire) == key) {
                            sink.slot = &instrumentSlots_[i];
                            break;
                        }
                    if (sink.slot == nullptr) continue;   // instrument unloaded under us — nothing to flush
#else
                    continue;
#endif
                } else {
                    if (midiNoteOut_ == nullptr) continue;
                    sink.out = midiNoteOut_;
                }
                releaseMidiVoice(voice, sink, outputFrame, /*dropPending*/ true);
            }
        }
    }
}

void NativeAudioEngineCore::render(const float* inputLeft,
                                   const float* inputRight,
                                   const std::array<float*, laneCount>& outputs,
                                   std::uint32_t frameCount) noexcept {
    const auto startTime = std::chrono::steady_clock::now();
    consumePublishedWorld();
    // Frame-exact pattern-scene switch: install a parked switch world so the new pattern reads
    // from ITS step 0 at the boundary. The boundary is a MUSICAL step (masterStep −
    // patternAnchorStep), a multiple of the OUTGOING scene's own LCM; the anchor move at the
    // boundary is what starts the incoming scene at its own step 0 regardless of its length.
    // Two shapes:
    //  · EARLY (sample-exact): when the boundary crossing lands inside THIS block, install now,
    //    arm pendingAnchorStep (the ABSOLUTE crossing step) and let the transport cross naturally —
    //    the anchor applies at the exact crossing frame (top of that frame's iteration in
    //    renderSequencerFrames) and the new pattern's step 0 fires there, with the absolute clock
    //    untouched. Triggers stay suppressed until the crossing (preBoundaryFreezeUntilStep) so
    //    the new pattern cannot fire during the residue of the old pattern's final step.
    //  · LATE (fallback): the crossing already happened (late arm beyond the roll-forward,
    //    pending seek, held transport, restart-immediate's boundary 0, or a >1-step-per-block
    //    corner) — install at the block top and move the anchor to NOW (musical 0, stepFrame 0):
    //    the new downbeat lands up to one buffer late, and unlike the old masterStep snap the
    //    absolute clock never rewinds.
    // Runs in both the composition and DJ-coordinator paths since the owner core always advances
    // deck A = index 0.
    if (parkedSwitchWorld_ != nullptr) {
        auto& rs0 = callbackRenderState_[0];
        const std::int64_t boundary = parkedBoundaryStep_;   // musical
        const std::int64_t musicalNow =
            static_cast<std::int64_t>(rs0.masterStep) - rs0.patternAnchorStep;

        // Consume the park + install, arming the scene glide / clean cut riders carried by the
        // installed world's deck-0 snapshot, and acknowledge the install for Swift's commit poll.
        // Shared by both shapes.
        const auto installParked = [&]() {
            RenderWorld* toInstall = parkedSwitchWorld_;
            lastInstalledSwitchEventID_ = parkedSwitchEventID_;
            installedSwitchEventID_.store(lastInstalledSwitchEventID_, std::memory_order_release);
            parkedSwitchWorld_ = nullptr;
            parkedBoundaryStep_ = -1;
            parkedSwitchGeneration_.store(0, std::memory_order_release);
            installWorld(toInstall);
            rs0.prevResolvedStep.fill(-1);
            rs0.locatorEngaged.fill(0);
            rs0.locatorWasActive.fill(0);
            rs0.switchResumePending.fill(0);  // scheduled/boundary switch restarts from step 0
            rs0.clearRateMorph();             // world swap cancels any in-flight multiply glide
            const NativeSequencerSnapshot& snap = toInstall->djMode
                ? toInstall->decks[0].snapshot : toInstall->sequencerState;
            rs0.sceneGlideFramesRemaining = snap.patternSwitchGlideFrames;
            // Armed in the OLD musical space; the anchor move rebases it (early path: the
            // pending-anchor apply; late path: explicitly below) so it fires at the crossing.
            if (snap.patternSwitchCut) rs0.sceneCutAtStep = boundary;
        };

        if (musicalNow >= boundary) {
            // LATE/fallback: anchor to NOW — the new pattern starts its step 0 at this block top,
            // ≤ one buffer after the true boundary.
            installParked();
            rs0.patternAnchorStep = static_cast<std::int64_t>(rs0.masterStep);
            rs0.stepFrame = 0;
            rs0.pendingAnchorStep = -1;
            if (rs0.sceneCutAtStep >= 0) rs0.sceneCutAtStep = 0;   // rebase: fire this block
        } else if (musicalNow + 1 == boundary
                   && rs0.currentFramesPerStep > 0 && !rs0.transportHeld
                   && rs0.launchLeadInFrames == 0
                   && pendingSeekStep_[0].load(std::memory_order_acquire) < 0) {
            // The boundary is the next step crossing — predict whether it lands in this block.
            // Over-predicting is safe (installs one block early; the pre-boundary freeze holds
            // triggers until the exact crossing frame); under-predicting falls back to the snap
            // path next block. Prediction uses the PARKED world's deck-0 tempo — once installed,
            // that world's ratio governs this block's source-frame advance.
            const std::uint32_t outFrames =
                std::min(frameCount, bufferSizeFrames_.load(std::memory_order_relaxed));
            std::uint64_t predictedAdvance = outFrames;
            if (parkedSwitchWorld_->djMode) {
                // Deck 0 advances SOURCE frames ≈ output / busRatio under DJ time-stretch;
                // replicate the ratio derivation (clamped tempoSyncRatio ÷ browse speed),
                // rounded up (+1) so any error lands on the safe (early) side.
                double r = parkedSwitchWorld_->decks[0].tempoSyncRatio;
                if (busBrowseEnabled_.load(std::memory_order_relaxed))
                    r /= std::max(busBrowseSpeed_.load(std::memory_order_relaxed), 1.0e-6);
                r = std::clamp(r, kBusStretchMinRatio, kBusBrowseMaxRatio);
                predictedAdvance = static_cast<std::uint64_t>(
                    std::ceil(static_cast<double>(outFrames) / r)) + 1;
            }
            if (outFrames > 0 && rs0.stepFrame + predictedAdvance >= rs0.currentFramesPerStep) {
                // EARLY/sample-exact: transport untouched; freeze triggers until the crossing,
                // where the pending anchor applies and rebases the freeze/cut riders to 0.
                installParked();
                rs0.preBoundaryFreezeUntilStep = boundary;
                rs0.pendingAnchorStep = rs0.patternAnchorStep + boundary;
            }
        }
    }
    // Inject any pending live (finger-drum / keyboard / preview) voices before rendering so they
    // sound this callback. Must run after the world swap so the resolved track/sample exist.
    drainLiveTriggers();

    if (!running_.load(std::memory_order_acquire)) {
        // Stopped transport: the published playhead atomics are no longer the audible clock.
        for (auto& live : deckClockLive_) live.store(false, std::memory_order_relaxed);
        for (float* output : outputs) {
            if (output != nullptr) {
                std::fill_n(output, frameCount, 0.0f);
            }
        }
        const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - startTime);
        updateTiming(static_cast<std::uint64_t>(elapsed.count()), frameCount);
        return;
    }

    const std::uint32_t configuredFrames = bufferSizeFrames_.load(std::memory_order_relaxed);
    const std::uint32_t framesToRender = std::min(frameCount, configuredFrames);
    // Captured once at the top of the block so MIDI clock ticks are timestamped off a stable
    // per-block reference (not the variable render-compute time). See the feedBlock call below.
    const std::uint64_t midiClockBlockHostTime = hostTimeNow();
    // Same per-block host-time reference drives external MIDI note timing (read in the const
    // renderSequencerFrames). Audio-thread-only; written here before any sequencer render below.
    renderBlockHostTime_ = midiClockBlockHostTime;
    const MixerState state = renderWorld_ != nullptr ? renderWorld_->mixerState : MixerState {};
    float* mainLeft = outputs[laneIndex(AudioLane::mainLeft)];
    float* mainRight = outputs[laneIndex(AudioLane::mainRight)];
    if (mainLeft != nullptr && mainRight != nullptr) {
        if (renderWorld_ != nullptr) {
            float* send1Buf = outputs[laneIndex(AudioLane::send1)];
            float* send2Buf = outputs[laneIndex(AudioLane::send2)];
            float* send3Buf = outputs[laneIndex(AudioLane::send3)];
            float* send4Buf = outputs[laneIndex(AudioLane::send4)];

            if (!renderWorld_->djMode) {
                // ── Composition mode: single-deck path ───────────────────────────────────
                // Skip-step: apply a pending playhead seek at the buffer boundary (keep playing).
                // The seek target is a MUSICAL step: move the pattern anchor instead of the clock
                // (masterStep stays monotonic), and cancel any pending switch anchor/freeze — a
                // seek defines the new position in the already-installed world deterministically.
                if (const std::int64_t seek = pendingSeekStep_[0].exchange(-1, std::memory_order_acq_rel); seek >= 0) {
                    callbackRenderState_[0].patternAnchorStep =
                        static_cast<std::int64_t>(callbackRenderState_[0].masterStep) - seek;
                    callbackRenderState_[0].pendingAnchorStep = -1;
                    callbackRenderState_[0].preBoundaryFreezeUntilStep = -1;
                    callbackRenderState_[0].stepFrame  = 0;
                    callbackRenderState_[0].prevResolvedStep.fill(-1);
                    callbackRenderState_[0].locatorEngaged.fill(0);
                    callbackRenderState_[0].locatorWasActive.fill(0);
                    callbackRenderState_[0].switchResumePending.fill(0);  // skip-step keeps the OWN owner-skip
                    callbackRenderState_[0].clearRateMorph();  // seek cancels any multiply glide
                }
                // Spectral tuner params are pushed every callback (helper shared with the DJ
                // branch) so the deck-0 bus stretcher is always current the moment it engages.
                pushSpectralParams(0, std::max(1.0, sampleRate_.load(std::memory_order_relaxed)));
                busStretcher_[0].setActive(true);
                {
                    // Composition renders on the zero-latency direct path (the deck bus only
                    // stretches in DJ mode).
                    renderSequencerFrames(*renderWorld_,
                                          callbackRenderState_[0],
                                          mainLeft,
                                          mainRight,
                                          send1Buf,
                                          send2Buf,
                                          send3Buf,
                                          send4Buf,
                                          framesToRender,
                                          /*snapshotOverride*/ nullptr,
                                          /*instrumentDeck*/ 0,
                                          /*allowLiveOverrides*/ true);
#if SCOOPY_PLUGIN_HOST
                    // Per-track instrument plugins (composition = deck 0): MIDI in → audio summed into
                    // the main (+ send) buses, upstream of master drive/clip. No-op if disabled.
                    renderInstrumentsForDeck(0, renderWorld_->sequencerState, callbackRenderState_[0],
                                             mainLeft, mainRight, send1Buf, send2Buf, send3Buf, send4Buf,
                                             framesToRender);
#endif
                    // Keep the engage-declick history current even while fully bypassed, so
                    // a DJ-mode engage can always prime from the dry timeline.
                    const float* dry[kDeckBusChannels] = { mainLeft, mainRight,
                                                           send1Buf, send2Buf, send3Buf, send4Buf };
                    appendBusHistory(0, dry, static_cast<int>(framesToRender));
                }
                // Deck-master send tap (composition deck = index 0): feed the deck's full summed
                // output into the send buses at the console's deck→FX level. Pre-mute, like the
                // per-track sends — the wet still returns while the dry deck is muted below.
                // Glided across the block so fader moves land click-free; a bus whose target and
                // glide state are both 0 costs one load + compare.
                {
                    float* sendBufs[kNumSends] = { send1Buf, send2Buf, send3Buf, send4Buf };
                    for (std::size_t n = 0; n < kNumSends; ++n) {
                        const float target = deckMasterSend_[0][n].load(std::memory_order_acquire);
                        float g = deckMasterSendCurrent_[0][n];
                        float* dst = sendBufs[n];
                        if (dst != nullptr && (target != 0.0f || g != 0.0f)) {
                            const float ginc = (target - g) / static_cast<float>(framesToRender);
                            for (std::uint32_t f = 0; f < framesToRender; ++f) {
                                g += ginc;
                                dst[f] += (mainLeft[f] + mainRight[f]) * 0.5f * g;
                            }
                        }
                        deckMasterSendCurrent_[0][n] = target;
                    }
                }
                // XN-04 — X-MIX carve in COMPOSITION. There is no deck bus here (composition
                // renders straight into main for zero latency), but mainL/R + the four send
                // buses ARE deck 0's 6-channel bus at this point, so the carve node applies
                // verbatim. Placed AFTER the deck-master send tap (so the tap's contribution
                // carves too) and BEFORE the mic→send injection and the return sum further
                // down — those are carve nodes in their own right and must not be pre-carved
                // by the deck. Analysis reads the pre-carve main, exactly as the DJ path reads
                // the pre-carve dry scratch. Costs one call; the converged fast path inside
                // applyCarve returns immediately while deck 0 sits on `own`.
                {
                    const double srHz = std::max(1.0, sampleRate_.load(std::memory_order_relaxed));
                    const int carveFrames = static_cast<int>(framesToRender);
                    xmodOnsetPrev_[0] = detectXModOnset(0, mainLeft, mainRight, carveFrames, srHz);
                    analyzeCarve(0, mainLeft, mainRight, carveFrames, srHz);
                    float* bus[kDeckBusChannels] = { mainLeft, mainRight,
                                                     send1Buf, send2Buf, send3Buf, send4Buf };
                    applyCarve(0, bus, static_cast<int>(kDeckBusChannels), carveFrames, srHz,
                               deckCarveSendSkipMask_[0].load(std::memory_order_relaxed)
                                   & carveableReturnsMask_.load(std::memory_order_relaxed));
                }
                // Mixer-console output mute (composition deck = index 0): silence the dry main
                // but keep the sends, so the FX-send wet still returns while the dry deck is
                // muted. Applied post-bus.
                if (deckOutputMuted_[0].load(std::memory_order_acquire)) {
                    std::fill_n(mainLeft, framesToRender, 0.0f);
                    std::fill_n(mainRight, framesToRender, 0.0f);
                }
                // Published playhead is the MUSICAL step (0 = the current cycle's start): every
                // Swift consumer already treats it that way (% lcm math, boundary scheduling).
                deckPlayheadStep_[0].store(static_cast<std::uint64_t>(std::max<std::int64_t>(
                                               0, static_cast<std::int64_t>(callbackRenderState_[0].masterStep)
                                                      - callbackRenderState_[0].patternAnchorStep)),
                                           std::memory_order_release);
                deckClockLive_[0].store(true, std::memory_order_relaxed);
                activeVoices_.store(
                    std::max(callbackRenderState_[0].currentVoiceCount, state.activeVoices),
                    std::memory_order_release);
                droppedVoiceCount_.store(callbackRenderState_[0].droppedVoiceCount, std::memory_order_release);
                triggerOverflowCount_.store(callbackRenderState_[0].triggerOverflowCount, std::memory_order_release);
                peakVoiceCount_.store(callbackRenderState_[0].peakVoiceCount, std::memory_order_release);
            } else {
                // ── DJ mode: render + bus-stretch each active deck, sample-locked sends ──
                // Phase 2: each active deck renders voices into per-deck scratch, then its
                // 4-channel R3 bus stretcher processes [mainL, mainR, send1, send2] together.
                // Single process()/retrieve() call guarantees identical start delay for main
                // and sends → sample-lock by construction.  All decks run their stretcher
                // (even at ratio 1.0) so constant group delay is uniform across decks.
                std::fill_n(mainLeft, framesToRender, 0.0f);
                std::fill_n(mainRight, framesToRender, 0.0f);
                if (send1Buf) std::fill_n(send1Buf, framesToRender, 0.0f);
                if (send2Buf) std::fill_n(send2Buf, framesToRender, 0.0f);
                if (send3Buf) std::fill_n(send3Buf, framesToRender, 0.0f);
                if (send4Buf) std::fill_n(send4Buf, framesToRender, 0.0f);

                std::uint32_t totalVoices = 0, totalDropped = 0, totalOverflow = 0, peakVoices = 0;

                // Each deck renders its own snapshot against the SAME stable world.samples
                // (renderWorld_ is retained until acknowledged), via renderSequencerFrames'
                // snapshotOverride. A per-callback local copy of the samples map would be
                // freed at callback end and dangle persisted (held/looping) voices.

                static constexpr AudioLane kDeckLanes[kMaxDecks][2] = {
                    { AudioLane::deckA_L, AudioLane::deckA_R },
                    { AudioLane::deckB_L, AudioLane::deckB_R },
                    { AudioLane::deckC_L, AudioLane::deckC_R },
                };

                // Spectral tuner push (texture, transpose, warp, warp-mod, chaos, air) for every
                // deck — shared with the composition branch via pushSpectralParams(). Each deck's
                // effective pitch is the global debug-tuner transpose plus its own per-deck
                // transpose, landing in the stretcher's permanently-installed custom frequency
                // map (NativeBusStretcher::mapWarp); applied every callback (trivial, survives
                // resets).
                busTransposeDirty_.store(false, std::memory_order_relaxed);
                const double sampleRateHz = std::max(1.0, sampleRate_.load(std::memory_order_relaxed));
                std::array<double, kMaxDecks> deckTransposeSemis {};
                for (std::size_t di = 0; di < kMaxDecks; ++di)
                    deckTransposeSemis[di] = pushSpectralParams(di, sampleRateHz);

                // Granular browse/scrub: a playback-speed multiplier folded into the bus ratio.
                const bool   busBrowse      = busBrowseEnabled_.load(std::memory_order_relaxed);
                const double busBrowseSpeed = busBrowseSpeed_.load(std::memory_order_relaxed);

                // Effective per-deck bus-stretch ratio (output/input). Computed once here and reused
                // in the render loop below, and by the quantized-launch boundary math next.
                std::array<double, kMaxDecks> busRatios {};
                for (std::size_t di = 0; di < kMaxDecks; ++di) {
                    double r = renderWorld_->decks[di].tempoSyncRatio;
                    // Slow-down ceiling = the browse/freeze ceiling for the sync path too: a
                    // master tempo of 0 BPM sends a huge ratio which must reach inFrames→1
                    // (spectral freeze), not stall at 16× slow-motion. Costless — slowing down
                    // SHRINKS the input frame count; scratch sizing is set by the MIN ratio only.
                    double ratioCeil = kBusBrowseMaxRatio;
                    if (busBrowse) {
                        r = renderWorld_->decks[di].tempoSyncRatio / std::max(busBrowseSpeed, 1.0e-6);
                    }
                    busRatios[di] = std::clamp(r, kBusStretchMinRatio, ratioCeil);
                }

                // Bus-stretch bypass decision (all-or-nothing across active decks). The Signalsmith
                // bus stretcher adds ~5120 frames (~116 ms @ 44.1k) of startup latency even at unity
                // ratio, which surfaces as a long delay before the first audible audio on transport
                // start. We bypass it (direct copy) ONLY when EVERY active deck is neutral (ratio ≈ 1,
                // no transpose, no browse) so all decks keep an identical group delay (0) and stay
                // beat-aligned. If any active deck is actually stretching, all decks keep stretching
                // (uniform latency) — preserving DJ alignment exactly as before.
                bool allActiveBusNeutral = !busBrowse;
                if (allActiveBusNeutral) {
                    for (std::size_t di = 0; di < kMaxDecks; ++di) {
                        // Engagement is driven by tempo need (ratio/transpose/browse) ONLY —
                        // spectral values themselves never engage the path, so unity is
                        // guaranteed silent/dry.
                        if (renderWorld_->decks[di].active
                            && (std::abs(busRatios[di] - 1.0) >= 1.0e-4
                                || deckTransposeSemis[di] != 0.0)) {
                            allActiveBusNeutral = false;
                            break;
                        }
                    }
                }


                // ── Quantized launch arm/release ───────────────────────────────────────────────
                // Resolve each pending launch against the reference deck's transport as it stands at
                // the TOP of this block (before any deck advances), so the decision is independent of
                // deck iteration order. All decks share this one callback, so no host-time math is
                // needed — alignment is computed directly in the reference deck's source-step domain.
                struct PreTransport {
                    std::uint64_t masterStep; std::uint64_t stepFrame; std::uint64_t fps; bool playing;
                };
                std::array<PreTransport, kMaxDecks> preTransport {};
                for (std::size_t di = 0; di < kMaxDecks; ++di) {
                    const auto& rs = callbackRenderState_[di];
                    // MUSICAL step: quantize boundaries are multiples of N on the reference
                    // deck's cycle grid (0 = cycle start), which is anchor-relative.
                    preTransport[di] = { static_cast<std::uint64_t>(std::max<std::int64_t>(
                                             0, static_cast<std::int64_t>(rs.masterStep)
                                                    - rs.patternAnchorStep)),
                                         rs.stepFrame, rs.currentFramesPerStep,
                                         renderWorld_->decks[di].active
                                             && renderWorld_->decks[di].snapshot.isPlaying
                                             && !rs.transportHeld };
                }
                for (std::size_t di = 0; di < kMaxDecks; ++di) {
                    const DeckWorld& deck = renderWorld_->decks[di];
                    auto& rs = callbackRenderState_[di];
                    // The held state is edge-driven from (active && launchArmed), which travels
                    // atomically with the world — robust to the params command arriving before or
                    // after the world publish. Rising edge: clean-reset and hold (silent, stretcher
                    // kept warm). Falling edge: drop any lingering hold (released or cancelled).
                    const bool armedNow = deck.active && deck.launchArmed;
                    if (armedNow && !deckLaunchArmedPrev_[di]) {
                        rs = {};
                        rs.transportHeld = true;
                    } else if (!armedNow && deckLaunchArmedPrev_[di]) {
                        rs.transportHeld = false;
                    }
                    deckLaunchArmedPrev_[di] = armedNow;
                    if (!armedNow || !rs.transportHeld) continue;  // not held → nothing to release

                    // Params (reference deck + granularity). Until they arrive the deck stays held.
                    const QuantizedLaunchCommand cmd = pendingLaunch_[di].load(std::memory_order_acquire);
                    if (!cmd.armed) continue;

                    const std::size_t refDeck = std::min<std::size_t>(cmd.refDeck, kMaxDecks - 1);
                    const std::uint64_t N = std::max<std::uint16_t>(1, cmd.quantizeSteps);
                    const PreTransport& r = preTransport[refDeck];

                    // A pattern-scene switch is in flight on the reference deck (parked world on
                    // the owner, or an unapplied pending anchor): its quantize grid is about to
                    // move, so a release computed NOW could align to the outgoing grid when N
                    // doesn't divide the outgoing LCM. Hold one more block — the launch fires
                    // against the settled new grid, fully predictable.
                    if ((refDeck == 0 && parkedSwitchWorld_ != nullptr)
                        || callbackRenderState_[refDeck].pendingAnchorStep >= 0) {
                        continue;
                    }

                    bool releaseNow = false;
                    std::uint64_t leadInSrc = 0;
                    if (refDeck == di || !r.playing || r.fps == 0) {
                        releaseNow = true;  // no usable reference → fire immediately
                    } else {
                        // Reference-domain source frames from block start until masterStep reaches the
                        // next multiple of N (the boundary fires as that step begins, stepFrame == 0).
                        std::uint64_t B;
                        if (r.masterStep % N == 0 && r.stepFrame == 0) {
                            B = r.masterStep;                  // exactly on the boundary now
                        } else {
                            B = ((r.masterStep / N) + 1) * N;  // next boundary strictly ahead
                        }
                        const long double srcUntilRef = std::max<long double>(
                            0.0L,
                            static_cast<long double>(B - r.masterStep) * static_cast<long double>(r.fps)
                                - static_cast<long double>(r.stepFrame));
                        const long double outUntil =
                            srcUntilRef * static_cast<long double>(busRatios[refDeck]);
                        if (outUntil < static_cast<long double>(framesToRender)) {
                            releaseNow = true;
                            // Map the reference boundary's output offset into THIS deck's source-frame
                            // lead-in, so its step-0 downbeat lands on the same output frame.
                            const double armedRatio = busRatios[di] > 1.0e-9 ? busRatios[di] : 1.0;
                            const long double leadLD = outUntil / static_cast<long double>(armedRatio);
                            leadInSrc = static_cast<std::uint64_t>(
                                std::max<long double>(0.0L, std::llroundl(leadLD)));
                        }
                    }

                    if (releaseNow) {
                        rs.transportHeld = false;
                        rs.stepFrame = 0;
                        rs.prevResolvedStep.fill(-1);
                        rs.locatorEngaged.fill(0);
                        rs.locatorWasActive.fill(0);
                        rs.clearRateMorph();   // fresh quantized launch re-latches the multiply
                        rs.launchLeadInFrames = leadInSrc;
                        launchFiredSeq_[di].fetch_add(1, std::memory_order_release);
                    }
                }

                for (std::size_t di = 0; di < kMaxDecks; ++di) {
                    const DeckWorld& deck = renderWorld_->decks[di];
                    float* dL = outputs[laneIndex(kDeckLanes[di][0])];
                    float* dR = outputs[laneIndex(kDeckLanes[di][1])];

                    // Reset the bus stretcher on active<->inactive transitions so a
                    // re-activated deck starts from a clean tail (handled in the wrapper).
                    busStretcher_[di].setActive(deck.active);
                    if (!deck.active) {
                        // Drop stale declick history so a re-activated deck never primes
                        // from audio recorded before it went inactive.
                        busHistoryPos_[di] = 0;
                        busHistoryCount_[di] = 0;
                        // Inactive decks emit no onsets and restart detection cleanly.
                        xmodDetector_[di] = XModDetector {};
                        xmodOnsetPrev_[di] = 0.0;
                        // …and neither analyze nor carry carve state (weights zero = this
                        // deck carves nobody; gain stage resets to unity for a clean return).
                        carveAnalyzer_[di] = CarveAnalyzer {};
                        carveWeights_[di].fill(0.0);
                        carveStage_[di] = CarveGainStage {};
                        carveShimmer_[di] = CarveShimmer {};
                        carvePumpEnv_[di] = 0.0;
                        if (dL) std::fill_n(dL, framesToRender, 0.0f);
                        if (dR) std::fill_n(dR, framesToRender, 0.0f);
                        // …and the DRY OUT tap goes silent with it (P3.5-E3). These
                        // buffers are only WRITTEN by the stretch below, so an
                        // inactive deck would otherwise keep whatever it last
                        // rendered — and a host reading deckDryOut() would hear a
                        // stale fragment loop under a deck that is gone. Silence is
                        // the truth about a deck that is not playing.
                        std::fill_n(deckStretchOutL_[di].data(), framesToRender, 0.0f);
                        std::fill_n(deckStretchOutR_[di].data(), framesToRender, 0.0f);
                        continue;
                    }

                    // Render voices into per-deck main scratch and per-deck send scratch.
                    // Each deck gets its own send buffers so per-deck sends don't accumulate
                    // across decks before stretching (Phase 1 bug where global send1Buf was shared).
                    float* scrL  = deckScratchLeft_[di].data();
                    float* scrR  = deckScratchRight_[di].data();
                    float* scrS1 = deckSend1Scratch_[di].data();
                    float* scrS2 = deckSend2Scratch_[di].data();
                    float* scrS3 = deckSend3Scratch_[di].data();
                    float* scrS4 = deckSend4Scratch_[di].data();
                    const float* inBus[kDeckBusChannels] =
                        { scrL, scrR, scrS1, scrS2, scrS3, scrS4 };
                    float* outBus[kDeckBusChannels] = {
                        deckStretchOutL_[di].data(),
                        deckStretchOutR_[di].data(),
                        deckStretchOutS1_[di].data(),
                        deckStretchOutS2_[di].data(),
                        deckStretchOutS3_[di].data(),
                        deckStretchOutS4_[di].data()
                    };

                    // ── Bus stretch: 6-ch through the per-deck stretch bus ──
                    // One multi-channel process() keeps main + sends sample-locked.
                    // Fixed-output model: the device always consumes framesToRender; the deck's
                    // source timeline advances by inFrames = round(framesToRender / ratio). We
                    // render exactly inFrames source frames and stretch them to framesToRender.
                    // tempoSyncRatio is output/input duration → playback speed = input/output = 1/ratio.
                    // Browse mode multiplies the sync playback speed by busBrowseSpeed: speed 1.0 =
                    // normal sync, 2.0 = 2× scrub, ~0 = freeze. ratio = syncRatio / speed, with the
                    // ceiling lifted to kBusBrowseMaxRatio so a near-zero speed drives inFrames → 1.
                    // Precomputed above (also used by the quantized-launch boundary math).
                    const double busRatio = busRatios[di];
                    // Carry the fractional source-frame count across callbacks so the long-run
                    // average input equals framesToRender/busRatio exactly. Flooring + remainder
                    // (instead of lround discarding the fraction) removes the per-deck tempo bias
                    // that drifts stretch-synced decks apart. Subtract the value actually used so
                    // the accumulator stays honest even when the clamp overrides it (e.g. freeze).
                    double& srcAcc = callbackRenderState_[di].srcFrameRemainder;
                    srcAcc += static_cast<double>(framesToRender) / busRatio;
                    int inFramesI = static_cast<int>(std::floor(srcAcc));
                    inFramesI = std::clamp(inFramesI, 1,
                                           static_cast<int>(deckScratchLeft_[di].size()));
                    srcAcc -= inFramesI;
                    const std::uint32_t inFrames = static_cast<std::uint32_t>(inFramesI);
                    std::fill_n(scrL,  inFrames, 0.0f);
                    std::fill_n(scrR,  inFrames, 0.0f);
                    std::fill_n(scrS1, inFrames, 0.0f);
                    std::fill_n(scrS2, inFrames, 0.0f);
                    std::fill_n(scrS3, inFrames, 0.0f);
                    std::fill_n(scrS4, inFrames, 0.0f);
                    // Skip-step: apply a pending playhead seek at the buffer boundary (keep playing).
                    // Musical target → anchor move; clock untouched (see the composition branch).
                    if (const std::int64_t seek = pendingSeekStep_[di].exchange(-1, std::memory_order_acq_rel); seek >= 0) {
                        callbackRenderState_[di].patternAnchorStep =
                            static_cast<std::int64_t>(callbackRenderState_[di].masterStep) - seek;
                        callbackRenderState_[di].pendingAnchorStep = -1;
                        callbackRenderState_[di].preBoundaryFreezeUntilStep = -1;
                        callbackRenderState_[di].stepFrame  = 0;
                        callbackRenderState_[di].prevResolvedStep.fill(-1);
                        callbackRenderState_[di].locatorEngaged.fill(0);
                        callbackRenderState_[di].locatorWasActive.fill(0);
                        callbackRenderState_[di].srcFrameRemainder = 0.0;  // clean phase after a jump
                        callbackRenderState_[di].switchResumePending.fill(0);  // skip-step keeps OWN owner-skip
                        callbackRenderState_[di].clearRateMorph();  // seek cancels any multiply glide
                    }
                    renderSequencerFrames(*renderWorld_, callbackRenderState_[di],
                                          scrL, scrR, scrS1, scrS2, scrS3, scrS4,
                                          inFrames, &deck.snapshot,
                                          /*instrumentDeck*/ static_cast<int>(di),
                                          /*allowLiveOverrides*/ true);
                    // Low-band onset detection on THIS deck's dry render — consumed by the
                    // X-MIX carve's onset pump (each transient from the incoming crossfader
                    // side momentarily deepens the outgoing side's carve).
                    xmodOnsetPrev_[di] = detectXModOnset(di, scrL, scrR, inFramesI,
                                                         sampleRateHz);
                    // X-MIX carve analysis: publish WHERE this deck's energy sits (per-band
                    // weights) for the opposite crossfader side's gain stage. Followers make
                    // the deck-ordering staleness (≤ one block) invisible.
                    analyzeCarve(di, scrL, scrR, inFramesI, sampleRateHz);
                    // Bypass the Signalsmith bus stretcher when ALL active decks are neutral (decided
                    // once above as allActiveBusNeutral). The stretcher adds ~116 ms startup latency
                    // even at unity, which surfaces as a long delay before the first audible audio.
                    // Bypassing all-or-nothing keeps every deck's group delay identical so beat-matched
                    // decks stay aligned; if any deck actually stretches, all keep stretching (uniform
                    // latency, prior behaviour). Declick/engage/history handled by the shared helper
                    // (processDeckBusStretch — also used by the composition SPECTRAL path).
                    processDeckBusStretch(di, inBus, outBus, inFramesI,
                                          static_cast<int>(framesToRender), busRatio,
                                          allActiveBusNeutral);
                    // X-MIX carve: duck this deck's output in the bands the opposite
                    // crossfader side occupies (amount/source mask pushed from Swift with
                    // the crossfader gains). Time-domain, zero latency — identical on the
                    // stretched and bypassed paths; all 6 channels so FX sends duck too —
                    // EXCEPT a send whose return carves itself (XN-03's skip mask).
                    applyCarve(di, outBus, static_cast<int>(kDeckBusChannels),
                               static_cast<int>(framesToRender), sampleRateHz,
                               deckCarveSendSkipMask_[di].load(std::memory_order_relaxed)
                                   & carveableReturnsMask_.load(std::memory_order_relaxed));
                    // output-domain frames per source step (source step × output/input ratio)
                    const double effectiveBusRatio = busRatio;
                    // ── Tape reverse (U/J hold): capture + looped backwards replay of this
                    // deck's post-stretch stereo output, before the crossfader mix so the
                    // reversed audio stays beat-matched. Loop one pattern cycle in OUTPUT
                    // frames = patternSteps × sourceFramesPerStep × (output/input ratio).
                    {
                        std::size_t patternSteps = 0;
                        for (const auto& tr : deck.snapshot.tracks)
                            patternSteps = std::max(patternSteps, tr.steps.size());
                        const double outFramesPerStep =
                            static_cast<double>(callbackRenderState_[di].currentFramesPerStep)
                            * std::max(0.0001, effectiveBusRatio);
                        const std::size_t loopFrames = patternSteps > 0
                            ? static_cast<std::size_t>(std::lround(outFramesPerStep
                                                                   * static_cast<double>(patternSteps)))
                            : framesToRender;
                        processTapeReverse(di, deckStretchOutL_[di].data(),
                                           deckStretchOutR_[di].data(),
                                           framesToRender, loopFrames);
                    }
                    // Publish this deck's playhead. masterStep advances with the source frames
                    // actually rendered this callback — at the synced/audible tempo under the
                    // Signalsmith path — so the UI playhead follows the real audio. Published in
                    // MUSICAL space (masterStep − patternAnchorStep; 0 = cycle start).
                    deckPlayheadStep_[di].store(static_cast<std::uint64_t>(std::max<std::int64_t>(
                                                    0, static_cast<std::int64_t>(callbackRenderState_[di].masterStep)
                                                           - callbackRenderState_[di].patternAnchorStep)),
                                                std::memory_order_release);
                    deckClockLive_[di].store(true, std::memory_order_relaxed);

                    // Split/exclusive routing (Phase 3):
                    //  - dedicatedOutput deck: excluded from the crossfader main mix; its
                    //    deck lane carries full-level output.
                    //  - in-main deck: rides the main mix scaled by crossfaderGain; its deck
                    //    lane is silent.
                    // FX sends are PRE-FADER (master sends): every active deck feeds the global
                    // send bus at full level, independent of the crossfader / deck volume. This
                    // is why a return plugin keeps receiving all sources when you crossfade,
                    // switch the composed deck, or move between compose and DJ views. Per-track
                    // send levels (send1Level/send2Level) still set how much each source sends.
#if SCOOPY_PLUGIN_HOST
                    // Per-track instruments bound to THIS deck: render each plugin once and sum into
                    // the deck's post-stretch output + sends, so the instrument rides this deck's
                    // crossfader and feeds the global send buses. Plays real-time (not bus-stretched).
                    renderInstrumentsForDeck(static_cast<int>(di), deck.snapshot,
                                             callbackRenderState_[di],
                                             deckStretchOutL_[di].data(), deckStretchOutR_[di].data(),
                                             deckStretchOutS1_[di].data(), deckStretchOutS2_[di].data(),
                                             deckStretchOutS3_[di].data(), deckStretchOutS4_[di].data(),
                                             framesToRender);
#endif
                    const float* outL  = deckStretchOutL_[di].data();
                    const float* outR  = deckStretchOutR_[di].data();
                    const float* outS1 = deckStretchOutS1_[di].data();
                    const float* outS2 = deckStretchOutS2_[di].data();
                    const float* outS3 = deckStretchOutS3_[di].data();
                    const float* outS4 = deckStretchOutS4_[di].data();
                    const bool dedicated = deck.dedicatedOutput;
                    // Mixer-console output mute: silence only the dry main/lane contribution.
                    // The send accumulation is untouched, so a muted deck's FX-send wet still
                    // returns (solo-a-send).
                    const bool deckMuted = deckOutputMuted_[di].load(std::memory_order_acquire);

                    // Deck mix gain: the world's crossfaderGain, unless a newer live override
                    // (the toolbar deck fader writes imperatively for analog-desk immediacy)
                    // supersedes it. Glided across the block so both fast fader sweeps and the
                    // coalesced republish steps land click-free.
                    float deckGainTarget = deck.crossfaderGain;
                    {
                        const auto& o = deckGainOverride_[di];
                        if (o.epoch.load(std::memory_order_acquire)
                                > renderWorld_->liveControlEpochAtPublish)
                            deckGainTarget = o.value.load(std::memory_order_acquire);
                    }
                    if (!dedicated && !deckMuted) {
                        // Per-deck DRIVE, PRE-sum and PRE-crossfader (character stays constant
                        // while fading). Applied to the deck's own dry signal only: we drive
                        // COPIES (l, r), never write back to outL/outR, so the pre-fader send tap
                        // below still reads the undriven signal and FX returns stay clean. Volume
                        // is NOT applied here — it already rides `g` (in-main decks fold master
                        // volume into crossfaderGain, DJModeView.audibleDeckGain), so we pass
                        // volume 1.0 and shape drive only. Bypassed at DRV == 1.0 (the parameter's
                        // floor = "off") for a bit-identical pass-through; reset on engage so the
                        // ADAA/oversampler history starts clean.
                        const NativeSequencerSnapshot& deckSnap = deck.snapshot;
                        const float deckDrive = deckSnap.masterClipperDrive;
                        const bool driveEngaged = deckDrive > 1.0f;
                        if (driveEngaged) {
                            if (!deckMasterDriveActive_[di]) {
                                deckMasterDrive_[di].reset();
                            }
                            deckMasterDrive_[di].setParameters(
                                static_cast<MasterDriveCurve>(deckSnap.masterClipperCurve),
                                1.0f,
                                deckSnap.masterClipperThreshold,
                                deckSnap.masterClipperSoftness,
                                deckDrive,
                                deckSnap.masterClipperCeiling,
                                deckSnap.masterClipperOversample,
                                deckSnap.masterClipperDecoupled);
                        }
                        deckMasterDriveActive_[di] = driveEngaged;

                        float g = deckMixGainCurrent_[di];
                        const float ginc = (deckGainTarget - g)
                            / static_cast<float>(framesToRender);
                        for (std::uint32_t f = 0; f < framesToRender; ++f) {
                            float l = outL[f];
                            float r = outR[f];
                            if (driveEngaged) {
                                deckMasterDrive_[di].processSample(l, r);
                            }
                            g += ginc;
                            mainLeft[f]  += l * g;
                            mainRight[f] += r * g;
                        }
                    } else {
                        // Not processing via the in-main path this callback (dedicated deck runs
                        // the stage below; a muted deck runs nothing). Force a reset on the next
                        // in-main engage so stale history can't resume.
                        deckMasterDriveActive_[di] = false;
                    }
                    deckMixGainCurrent_[di] = deckGainTarget;
                    // Per-track send accumulation, plus the deck-master send tap: the deck's
                    // full post-stretch output (outL/outR, pre-crossfader-gain) feeds each send
                    // bus at the console's deck→FX level. Pre-fader/pre-mute like the per-track
                    // sends above — independent of the crossfader, and a muted deck's wet still
                    // returns. Glided across the block; the master term costs nothing while the
                    // level and its glide state are 0.
                    {
                        const float* outSN[kNumSends] = { outS1, outS2, outS3, outS4 };
                        float* sendBufs[kNumSends] = { send1Buf, send2Buf, send3Buf, send4Buf };
                        for (std::size_t n = 0; n < kNumSends; ++n) {
                            const float target = deckMasterSend_[di][n].load(std::memory_order_acquire);
                            float g = deckMasterSendCurrent_[di][n];
                            float* dst = sendBufs[n];
                            if (dst != nullptr) {
                                if (target == 0.0f && g == 0.0f) {
                                    for (std::uint32_t f = 0; f < framesToRender; ++f)
                                        dst[f] += outSN[n][f];
                                } else {
                                    const float ginc = (target - g)
                                        / static_cast<float>(framesToRender);
                                    for (std::uint32_t f = 0; f < framesToRender; ++f) {
                                        g += ginc;
                                        dst[f] += outSN[n][f]
                                                + (outL[f] + outR[f]) * 0.5f * g;
                                    }
                                }
                            }
                            deckMasterSendCurrent_[di][n] = target;
                        }
                                            }
                    // Deck lane carries full-level output only when routed to a dedicated
                    // output; otherwise it is silent (the deck is in the main mix). A console
                    // mute silences the dedicated lane too (its sends already passed through).
                    if (dedicated && !deckMuted) {
                        if (dL) std::copy_n(outL, framesToRender, dL);
                        if (dR) std::copy_n(outR, framesToRender, dR);
                    } else {
                        if (dL) std::fill_n(dL, framesToRender, 0.0f);
                        if (dR) std::fill_n(dR, framesToRender, 0.0f);
                    }

                    totalVoices   += callbackRenderState_[di].currentVoiceCount;
                    totalDropped  += callbackRenderState_[di].droppedVoiceCount;
                    totalOverflow += callbackRenderState_[di].triggerOverflowCount;
                    peakVoices     = std::max(peakVoices, callbackRenderState_[di].peakVoiceCount);
                }
                activeVoices_.store(std::max(totalVoices, state.activeVoices), std::memory_order_release);
                droppedVoiceCount_.store(totalDropped, std::memory_order_release);
                triggerOverflowCount_.store(totalOverflow, std::memory_order_release);
                peakVoiceCount_.store(peakVoices, std::memory_order_release);
            }
        } else {
            std::fill_n(mainLeft, framesToRender, 0.0f);
            std::fill_n(mainRight, framesToRender, 0.0f);
        }
    }

    // Phase 9: configure master DSP from the current render world
    // Phase 10: configure return delay parameters
    // In DJ mode, master volume and returns come from deck[0] (Deck A).
    // masterSeqPtr is valid for the entire frame-loop scope below.
    static const NativeSequencerSnapshot kEmptySnapshot {};
    const NativeSequencerSnapshot* masterSeqPtr = &kEmptySnapshot;
    const NativeReturnState* ret1 = nullptr;
    const NativeReturnState* ret2 = nullptr;
    if (renderWorld_ != nullptr) {
        masterSeqPtr = renderWorld_->djMode
            ? &renderWorld_->decks[0].snapshot
            : &renderWorld_->sequencerState;
        const NativeSequencerSnapshot& masterSeq = *masterSeqPtr;
        const double masterVol = masterSeq.masterVolume;
        // Master drive/clip on the main bus. Curve selectable; `soft` reproduces the legacy
        // atan-knee clipper, the others are anti-aliased drive curves (see NativeMasterDrive).
        // In DJ mode the summed mix runs a pure SAFETY clipper: each deck's DRIVE is applied
        // per-deck pre-sum (see the deck loop above), so reading deck A's drive here too would
        // double-apply it. Force drive to unity in DJ; ceiling/curve/softness/volume still ride
        // deck A's snapshot (that borrow is deferred, tracked with returns/LFO below).
        const float mainBusDrive = renderWorld_->djMode
            ? 1.0f
            : masterSeq.masterClipperDrive;
        masterDrive_.setParameters(static_cast<MasterDriveCurve>(masterSeq.masterClipperCurve),
                                   static_cast<float>(masterVol),
                                   masterSeq.masterClipperThreshold,
                                   masterSeq.masterClipperSoftness,
                                   mainBusDrive,
                                   masterSeq.masterClipperCeiling,
                                   masterSeq.masterClipperOversample,
                                   masterSeq.masterClipperDecoupled);
        ret1 = &masterSeq.return1;
        ret2 = &masterSeq.return2;
    }
    const float masterCleanGain = renderWorld_ != nullptr
        ? NativeMasterClipper::cleanOutputGain(
            static_cast<float>(renderWorld_->djMode
                ? renderWorld_->decks[0].snapshot.masterVolume
                : renderWorld_->sequencerState.masterVolume))
        : 1.0f;

    // Use end-of-buffer LFO phases as a scalar modulation sample for return volume/pan.
    // This is one-per-buffer approximation; inaudible vs per-frame at typical buffer sizes.
    // For the master/return LFO clock we always use deck[0]'s phase.
    // In composition mode deck[0] is the only deck; in DJ mode deck[0] (Deck A) drives returns.
    const auto& masterRenderState = callbackRenderState_[0];
    // masterSeqPtr resolved above: deck[0] snapshot in DJ mode, sequencerState otherwise.
    // Scaled by each channel's master depth so depth=0 silences return-track modulation too. When
    // channel 0/1 is an Envelope, use the per-frame envelope output the sequencer render wrote into
    // masterRenderState.modChannelValue[] (pre-depth for ch0/1) instead of the analytic LFO waveform.
    const float lfo1Val = renderWorld_ != nullptr
        ? static_cast<float>(
            (masterSeqPtr->modChannels[0].type == NativeModChannelType::envelope
                ? static_cast<double>(masterRenderState.modChannelValue[0])
                : lfoWaveValue(masterRenderState.lfo1Phase,
                    masterSeqPtr->lfo1Waveform,
                    masterSeqPtr->lfo1Symmetry,
                    masterRenderState.randVal1))
            * masterSeqPtr->modChannels[0].depth)
        : 0.0f;
    const float lfo2Val = renderWorld_ != nullptr
        ? static_cast<float>(
            (masterSeqPtr->modChannels[1].type == NativeModChannelType::envelope
                ? static_cast<double>(masterRenderState.modChannelValue[1])
                : lfoWaveValue(masterRenderState.lfo2Phase,
                    masterSeqPtr->lfo2Waveform,
                    masterSeqPtr->lfo2Symmetry,
                    masterRenderState.randVal2))
            * masterSeqPtr->modChannels[1].depth)
        : 0.0f;

    // FX-return routing mode (1 external out, 2 host plugin). Honour the legacy snapshot
    // externalEnabled flag too so existing sessions keep routing externally even before
    // the imperative mode is set.
    const std::uint8_t rmode1 = returnMode_[0].load(std::memory_order_acquire);
    const std::uint8_t rmode2 = returnMode_[1].load(std::memory_order_acquire);
    const bool ret1External = (rmode1 == 1) || (ret1 != nullptr && ret1->externalEnabled);
    const bool ret2External = (rmode2 == 1) || (ret2 != nullptr && ret2->externalEnabled);
    // Extended sends 3 & 4 have no ReturnTrack snapshot — their mode comes purely from the
    // imperative returnMode_ atomic (1 = external out, 2 = host plugin).
    const std::uint8_t rmode3 = returnMode_[2].load(std::memory_order_acquire);
    const std::uint8_t rmode4 = returnMode_[3].load(std::memory_order_acquire);
    const bool ret3External = (rmode3 == 1);
    const bool ret4External = (rmode4 == 1);

    // Mic → FX sends: add the (gained) mic as a mono source into each send bus before the
    // send-master scaling / plugin / external routing below, so the mic can be reverbed, delayed
    // or host-processed independently of monitoring. Mic gain is reused here; per-send level scales
    // how much reaches each bus.
    // All 4 buses since MIX-NATIVE-3 (was send1/send2 only). Cost stays ~zero
    // when unused: buses at level 0 are skipped, and the whole block is skipped
    // when every level is 0.
    {
        constexpr AudioLane kMicSendLanes[kNumSends] =
            { AudioLane::send1, AudioLane::send2, AudioLane::send3, AudioLane::send4 };
        const float micG = micGain_.load(std::memory_order_acquire);
        float micSend[kNumSends];
        bool anyMicSend = false;
        for (std::size_t n = 0; n < kNumSends; ++n) {
            micSend[n] = micSendLevel_[n].load(std::memory_order_acquire);
            if (micSend[n] != 0.0f) anyMicSend = true;
        }
        if (anyMicSend && (inputLeft != nullptr || inputRight != nullptr)) {
            float* sb[kNumSends];
            for (std::size_t n = 0; n < kNumSends; ++n)
                sb[n] = outputs[laneIndex(kMicSendLanes[n])];
            for (std::uint32_t f = 0; f < framesToRender; ++f) {
                const float l = inputLeft != nullptr ? inputLeft[f] : 0.0f;
                const float r = inputRight != nullptr ? inputRight[f] : 0.0f;
                const float micMono = 0.5f * (l + r) * micG;
                for (std::size_t n = 0; n < kNumSends; ++n)
                    if (sb[n] != nullptr && micSend[n] != 0.0f) sb[n][f] += micMono * micSend[n];
            }
        }
    }

    // Per-send INPUT "send master": scale the summed send bus once before it feeds the
    // plugin (host) or the external hardware out — symmetric across both modes. The gain glides
    // across the block toward the atomic target (the knob's imperative setter steps unramped),
    // so a knob flick lands click-free; settled unity buses skip the pass entirely.
    {
        constexpr AudioLane kSendLanes[kNumSends] =
            { AudioLane::send1, AudioLane::send2, AudioLane::send3, AudioLane::send4 };
        for (std::size_t n = 0; n < kNumSends; ++n) {
            const float target = sendInputGain_[n].load(std::memory_order_acquire);
            const float cur = sendInputGainCurrent_[n];
            float* sb = outputs[laneIndex(kSendLanes[n])];
            if (sb != nullptr && (target != 1.0f || cur != 1.0f)) {
                const float inc = (target - cur) / static_cast<float>(framesToRender);
                float g = cur;
                for (std::uint32_t f = 0; f < framesToRender; ++f) { g += inc; sb[f] *= g; }
            }
            sendInputGainCurrent_[n] = target;
        }
    }
    // Host return → dedicated send hardware channel (exclusive: wet leaves the main mix and rides
    // the send lane instead). Only the Swift layer enables this when a send pair is configured, so
    // the core trusts the flag; with no plugin host the flags stay false (wet → main as before).
    bool ret1ToHw = false, ret2ToHw = false, ret3ToHw = false, ret4ToHw = false;
#if SCOOPY_PLUGIN_HOST
    const bool ret1HostMode = (rmode1 == 2) && !ret1External;
    const bool ret2HostMode = (rmode2 == 2) && !ret2External;
    const bool ret3HostMode = (rmode3 == 2) && !ret3External;
    const bool ret4HostMode = (rmode4 == 2) && !ret4External;
    ret1ToHw = ret1HostMode && returnHardwareOut_[0].load(std::memory_order_acquire);
    ret2ToHw = ret2HostMode && returnHardwareOut_[1].load(std::memory_order_acquire);
    ret3ToHw = ret3HostMode && returnHardwareOut_[2].load(std::memory_order_acquire);
    ret4ToHw = ret4HostMode && returnHardwareOut_[3].load(std::memory_order_acquire);
    // Host tempo/transport handed to plugins via their AudioPlayHead so synced
    // plugins (delays, LFOs, arps) lock to the project BPM.
    const double hostBpm = masterSeqPtr->bpm;
    const bool hostPlaying = masterSeqPtr->isPlaying;
    // Host returns process block-based: run the plugin once over the whole block,
    // dual-mono in (the send bus is mono-accumulated), writing wet stereo into
    // hostWetN scratch which the per-frame loop reads. Passthrough -> silence wet.
    // Host returns gather their input as send lane + the embedding host's own
    // feed (hostSendFeed_ — the plane's tape-strip sends, which mix in after
    // this render and so can never ride the lane itself; see hostSendFeed()).
    if (ret1HostMode) {
        const float* s1 = outputs[laneIndex(AudioLane::send1)];
        const float* f1 = hostSendFeed_[0].data();
        for (std::uint32_t f = 0; f < framesToRender; ++f) {
            hostWet1L_[f] = (s1 != nullptr ? s1[f] : 0.0f) + f1[f];
            hostWet1R_[f] = hostWet1L_[f];
        }
        if (!returnPluginSlot1_.processStereoBlock(hostWet1L_.data(), hostWet1R_.data(),
                                                   static_cast<int>(framesToRender), hostBpm, hostPlaying)) {
            std::fill_n(hostWet1L_.data(), framesToRender, 0.0f);
            std::fill_n(hostWet1R_.data(), framesToRender, 0.0f);
        }
    }
    if (ret2HostMode) {
        const float* s2 = outputs[laneIndex(AudioLane::send2)];
        for (std::uint32_t f = 0; f < framesToRender; ++f) {
            hostWet2L_[f] = (s2 != nullptr ? s2[f] : 0.0f) + hostSendFeed_[1][f];
            hostWet2R_[f] = hostWet2L_[f];
        }
        if (!returnPluginSlot2_.processStereoBlock(hostWet2L_.data(), hostWet2R_.data(),
                                                   static_cast<int>(framesToRender), hostBpm, hostPlaying)) {
            std::fill_n(hostWet2L_.data(), framesToRender, 0.0f);
            std::fill_n(hostWet2R_.data(), framesToRender, 0.0f);
        }
    }
    if (ret3HostMode) {
        const float* s3 = outputs[laneIndex(AudioLane::send3)];
        for (std::uint32_t f = 0; f < framesToRender; ++f) {
            hostWet3L_[f] = (s3 != nullptr ? s3[f] : 0.0f) + hostSendFeed_[2][f];
            hostWet3R_[f] = hostWet3L_[f];
        }
        if (!returnPluginSlot3_.processStereoBlock(hostWet3L_.data(), hostWet3R_.data(),
                                                   static_cast<int>(framesToRender), hostBpm, hostPlaying)) {
            std::fill_n(hostWet3L_.data(), framesToRender, 0.0f);
            std::fill_n(hostWet3R_.data(), framesToRender, 0.0f);
        }
    }
    if (ret4HostMode) {
        const float* s4 = outputs[laneIndex(AudioLane::send4)];
        for (std::uint32_t f = 0; f < framesToRender; ++f) {
            hostWet4L_[f] = (s4 != nullptr ? s4[f] : 0.0f) + hostSendFeed_[3][f];
            hostWet4R_[f] = hostWet4L_[f];
        }
        if (!returnPluginSlot4_.processStereoBlock(hostWet4L_.data(), hostWet4R_.data(),
                                                   static_cast<int>(framesToRender), hostBpm, hostPlaying)) {
            std::fill_n(hostWet4L_.data(), framesToRender, 0.0f);
            std::fill_n(hostWet4R_.data(), framesToRender, 0.0f);
        }
    }
#endif

    // Mixer-console solo: when another channel is soloed, this return's wet is muted without
    // disturbing the user's persisted panic mute. Loaded once per block (cheap, lock-free).
    const bool ret1SoloMute = sendSoloMuted_[0].load(std::memory_order_acquire);
    const bool ret2SoloMute = sendSoloMuted_[1].load(std::memory_order_acquire);
    const bool ret3SoloMute = sendSoloMuted_[2].load(std::memory_order_acquire);
    const bool ret4SoloMute = sendSoloMuted_[3].load(std::memory_order_acquire);
    // Extended host returns 3 & 4 read their wet level from the imperative atomic (no snapshot).
    const float ret3Volume = returnVolume_[2].load(std::memory_order_acquire);
    const float ret4Volume = returnVolume_[3].load(std::memory_order_acquire);
    // Returns 1 & 2 wet level: snapshot volume, unless a newer live override (the FX-slot fader
    // writes imperatively for mixer immediacy) supersedes it. Glided across the block — the
    // snapshot value previously stepped unramped on every republish.
    const std::uint64_t retWorldEpoch = renderWorld_ != nullptr
        ? renderWorld_->liveControlEpochAtPublish : 0;
    float ret1VolTarget = ret1 != nullptr ? ret1->volume : returnVolGlideCurrent_[0];
    if (returnVolumeOverride_[0].epoch.load(std::memory_order_acquire) > retWorldEpoch)
        ret1VolTarget = returnVolumeOverride_[0].value.load(std::memory_order_acquire);
    float ret2VolTarget = ret2 != nullptr ? ret2->volume : returnVolGlideCurrent_[1];
    if (returnVolumeOverride_[1].epoch.load(std::memory_order_acquire) > retWorldEpoch)
        ret2VolTarget = returnVolumeOverride_[1].value.load(std::memory_order_acquire);
    float ret1Vol = returnVolGlideCurrent_[0];
    float ret2Vol = returnVolGlideCurrent_[1];
    const float ret1VolInc = (ret1VolTarget - ret1Vol) / static_cast<float>(framesToRender);
    const float ret2VolInc = (ret2VolTarget - ret2Vol) / static_cast<float>(framesToRender);
    returnVolGlideCurrent_[0] = ret1VolTarget;
    returnVolGlideCurrent_[1] = ret2VolTarget;

    // Mic input channel: scale by micGain, monitor (sum dry into main) only when monitoring is on
    // and not muted. The peak meter tracks the gained input regardless of monitoring.
    const float micGain = micGain_.load(std::memory_order_acquire);
    const bool  micMonitor = micMonitorOn_.load(std::memory_order_acquire)
                          && !micMuted_.load(std::memory_order_acquire);
    float inPeak = 0.0f;

    // External send lane gain de-click: the snapshot value steps once per republish, so glide
    // from the last applied gain across this block (kills the zipper on the hardware out).
    const float laneGainTarget[kNumSends] =
        { state.send1Gain, state.send2Gain, state.send3Gain, state.send4Gain };
    float laneGain[kNumSends];
    float laneGainInc[kNumSends];
    for (std::size_t n = 0; n < kNumSends; ++n) {
        laneGain[n] = sendLaneGainCurrent_[n];
        laneGainInc[n] = (laneGainTarget[n] - laneGain[n]) / static_cast<float>(framesToRender);
        sendLaneGainCurrent_[n] = laneGainTarget[n];
    }

    // ── PASS A (XN-02) — build the RETURN and MIC nodes into carve scratch ──────────────────
    // The four returns and the mic used to be summed straight into main inside ONE loop. They are
    // carve NODES now (each can take a crossfader side, so each can be spectrally eaten by the
    // opposite side), and the carve is a per-BLOCK stage — analysis needs a whole block before the
    // gain stage can run. So the loop splits in three: A builds the nodes, the carve runs on them,
    // B does the sum and everything downstream. None of the DSP below changed — it only moved.
    float* const retCarveL[kNumSends] = { returnCarveL_[0].data(), returnCarveL_[1].data(),
                                          returnCarveL_[2].data(), returnCarveL_[3].data() };
    float* const retCarveR[kNumSends] = { returnCarveR_[0].data(), returnCarveR_[1].data(),
                                          returnCarveR_[2].data(), returnCarveR_[3].data() };
    float* const micCarveL = micCarveL_.data();
    float* const micCarveR = micCarveR_.data();
    for (std::uint32_t frame = 0; frame < framesToRender; ++frame) {
        ret1Vol += ret1VolInc;
        ret2Vol += ret2VolInc;

        // Phase 10: return track 1 processing
        float ret1AddL = 0.0f, ret1AddR = 0.0f;
        if (ret1 != nullptr && !ret1External) {
            // Gate
            // Gate patterns run on the MUSICAL step so they re-align to the new scene's downbeat
            // at a scheduled switch (like every other step-sequenced surface).
            const std::uint64_t retMusicalStep = static_cast<std::uint64_t>(std::max<std::int64_t>(
                0, static_cast<std::int64_t>(masterRenderState.masterStep)
                       - masterRenderState.patternAnchorStep));
            const std::uint64_t gateStep1 = ret1->gateStepCount > 0
                ? (retMusicalStep % ret1->gateStepCount) : 0;
            const bool gate1Open = !ret1->gateEnabled
                || (gateStep1 < ret1->gateSteps.size() && ret1->gateSteps[gateStep1]);
            float r1L, r1R;
#if SCOOPY_PLUGIN_HOST
            if (ret1HostMode) {
                // Host wet was computed block-based above.
                r1L = hostWet1L_[frame];
                r1R = hostWet1R_[frame];
            } else
#endif
            {
                // Internal-delay return retired: a return that is neither host nor
                // external contributes nothing to the main mix.
                r1L = 0.0f; r1R = 0.0f;
            }
            if (ret1->gateEnabled && ret1->gateMode == 1 && !gate1Open) {
                r1L = 0.0f; r1R = 0.0f;
            }
            // Gain (tanh saturation if > 1)
            const float lfoVolMod1 = lfo1Val * ret1->lfoVolumeDepth + lfo2Val * ret1->lfo2VolumeDepth;
            const float effGain1 = std::max(0.0f, std::min(2.0f, ret1->gain + lfoVolMod1));
            if (effGain1 > 1.0f) {
                const float dg = effGain1;
                const float td = std::tanh(dg);
                r1L = td > 1e-6f ? std::tanh(r1L * dg) / td : 0.0f;
                r1R = td > 1e-6f ? std::tanh(r1R * dg) / td : 0.0f;
            } else {
                r1L *= effGain1;
                r1R *= effGain1;
            }
            r1L *= ret1Vol;
            r1R *= ret1Vol;
            // Pan
            const float panMod1 = lfo1Val * ret1->lfoPanDepth + lfo2Val * ret1->lfo2PanDepth;
            const float pan1 = std::max(-1.0f, std::min(1.0f, ret1->pan + panMod1));
            const float panAngle1 = pan1 * 3.14159265f * 0.25f;
            r1L *= std::cos(panAngle1 + 3.14159265f * 0.25f);
            r1R *= std::sin(panAngle1 + 3.14159265f * 0.25f);
            if (ret1->muted || ret1SoloMute) { r1L = 0.0f; r1R = 0.0f; }
            ret1AddL = r1L;
            ret1AddR = r1R;
        }
#if SCOOPY_PLUGIN_HOST
        // P6-3: NO SNAPSHOT, STILL WET. A host without a published world (a
        // tape-only plane) has ret1 == nullptr, and the full path above —
        // gate/pan/LFO, all snapshot-owned — has nothing to run on. The plugin
        // wet still belongs in the mix, so it takes the same lightweight
        // imperative path returns 3 & 4 always use: wet × return level, with
        // solo-mute. The moment a world arrives, the snapshot path above owns
        // this return again.
        else if (ret1HostMode && !ret1SoloMute) {
            ret1AddL = hostWet1L_[frame] * ret1Vol;
            ret1AddR = hostWet1R_[frame] * ret1Vol;
        }
#endif

        // Phase 10: return track 2 processing
        float ret2AddL = 0.0f, ret2AddR = 0.0f;
        if (ret2 != nullptr && !ret2External) {
            // Musical step for the same reason as gate 1 above.
            const std::uint64_t ret2MusicalStep = static_cast<std::uint64_t>(std::max<std::int64_t>(
                0, static_cast<std::int64_t>(masterRenderState.masterStep)
                       - masterRenderState.patternAnchorStep));
            const std::uint64_t gateStep2 = ret2->gateStepCount > 0
                ? (ret2MusicalStep % ret2->gateStepCount) : 0;
            const bool gate2Open = !ret2->gateEnabled
                || (gateStep2 < ret2->gateSteps.size() && ret2->gateSteps[gateStep2]);
            float r2L, r2R;
#if SCOOPY_PLUGIN_HOST
            if (ret2HostMode) {
                r2L = hostWet2L_[frame];
                r2R = hostWet2R_[frame];
            } else
#endif
            {
                // Internal-delay return retired: a return that is neither host nor
                // external contributes nothing to the main mix.
                r2L = 0.0f; r2R = 0.0f;
            }
            if (ret2->gateEnabled && ret2->gateMode == 1 && !gate2Open) {
                r2L = 0.0f; r2R = 0.0f;
            }
            const float lfoVolMod2 = lfo1Val * ret2->lfoVolumeDepth + lfo2Val * ret2->lfo2VolumeDepth;
            const float effGain2 = std::max(0.0f, std::min(2.0f, ret2->gain + lfoVolMod2));
            if (effGain2 > 1.0f) {
                const float dg = effGain2;
                const float td = std::tanh(dg);
                r2L = td > 1e-6f ? std::tanh(r2L * dg) / td : 0.0f;
                r2R = td > 1e-6f ? std::tanh(r2R * dg) / td : 0.0f;
            } else {
                r2L *= effGain2;
                r2R *= effGain2;
            }
            r2L *= ret2Vol;
            r2R *= ret2Vol;
            const float panMod2 = lfo1Val * ret2->lfoPanDepth + lfo2Val * ret2->lfo2PanDepth;
            const float pan2 = std::max(-1.0f, std::min(1.0f, ret2->pan + panMod2));
            const float panAngle2 = pan2 * 3.14159265f * 0.25f;
            r2L *= std::cos(panAngle2 + 3.14159265f * 0.25f);
            r2R *= std::sin(panAngle2 + 3.14159265f * 0.25f);
            if (ret2->muted || ret2SoloMute) { r2L = 0.0f; r2R = 0.0f; }
            ret2AddL = r2L;
            ret2AddR = r2R;
        }
#if SCOOPY_PLUGIN_HOST
        // Same no-snapshot wet fallback as return 1 above (P6-3).
        else if (ret2HostMode && !ret2SoloMute) {
            ret2AddL = hostWet2L_[frame] * ret2Vol;
            ret2AddR = hostWet2R_[frame] * ret2Vol;
        }
#endif

        // Extended host returns 3 & 4: wet = host-plugin output × imperative return level, with
        // solo-mute. No gate/pan/LFO path (those live only on returns 1 & 2). External-mode 3/4
        // contribute nothing here (their raw send rides the send lane to the hardware out below).
        float ret3AddL = 0.0f, ret3AddR = 0.0f;
        float ret4AddL = 0.0f, ret4AddR = 0.0f;
#if SCOOPY_PLUGIN_HOST
        if (ret3HostMode && !ret3SoloMute) {
            ret3AddL = hostWet3L_[frame] * ret3Volume;
            ret3AddR = hostWet3R_[frame] * ret3Volume;
        }
        if (ret4HostMode && !ret4SoloMute) {
            ret4AddL = hostWet4L_[frame] * ret4Volume;
            ret4AddR = hostWet4R_[frame] * ret4Volume;
        }
#endif

        // Park each return's wet (post gain/pan/mute) in its carve scratch. The carve stage runs
        // on these between the passes; pass B sums them and publishes the returnWet capture lanes
        // from the CARVED signal, so a recorded return stem reassembles into the mix you heard.
        retCarveL[0][frame] = ret1AddL;  retCarveR[0][frame] = ret1AddR;
        retCarveL[1][frame] = ret2AddL;  retCarveR[1][frame] = ret2AddR;
        retCarveL[2][frame] = ret3AddL;  retCarveR[2][frame] = ret3AddR;
        retCarveL[3][frame] = ret4AddL;  retCarveR[3][frame] = ret4AddR;

        const float micL = (inputLeft != nullptr ? inputLeft[frame] : 0.0f) * micGain;
        const float micR = (inputRight != nullptr ? inputRight[frame] : 0.0f) * micGain;
        inPeak = std::max(inPeak, std::max(std::fabs(micL), std::fabs(micR)));
        micCarveL[frame] = micL;
        micCarveR[frame] = micR;

        // Mic-dry capture lanes: clean gained mic, independent of monitor/mute, so the device host
        // can record a direct mic stem without summing it into the speakers (no acoustic feedback).
        // Deliberately written here — PRE-carve. This lane's whole contract is "clean direct mic";
        // an X-MIX carve is a mix decision and has no business in a direct capture. (The return
        // stems are the opposite case: they ARE mix components, so they are published post-carve.)
        if (float* md = outputs[laneIndex(AudioLane::micDryL)]) md[frame] = micL;
        if (float* md = outputs[laneIndex(AudioLane::micDryR)]) md[frame] = micR;
    }

    // ── The stereo carve nodes (XN-02) ──────────────────────────────────────────────────────
    // Analyze + carve each return and the input, exactly as a deck is analyzed and carved. Two
    // channels each (a deck carves six — its main pair plus its four send feeds).
    // A return routed to its own hardware output is NOT carveable: its wet never enters the main
    // sum (it leaves on the send lane), so there is nothing here for the crossfader to eat. Its
    // side picker is inert in the UI for the same reason; skipping it here makes that a fact of
    // the engine and not just a UI convention.
    {
        const double srHz = std::max(1.0, sampleRate_.load(std::memory_order_relaxed));
        const int carveFrames = static_cast<int>(framesToRender);
        const bool retExternal[kNumSends] = { ret1External, ret2External,
                                              ret3External, ret4External };
        const bool retToHw[kNumSends] = { ret1ToHw, ret2ToHw, ret3ToHw, ret4ToHw };
        // Which returns are genuinely carve nodes: a return only participates if its wet lands in
        // the MAIN sum. Routed-to-hardware and external returns don't, so there is nothing for the
        // crossfader to eat. The deck loop ANDs its send-skip mask with this (see XN-03) — a deck
        // must keep carving a send feed whose return isn't carving itself, or that path escapes
        // the X-MIX entirely. Render-thread only; the deck loop runs BEFORE the return mode flags
        // exist in this callback, so it reads the previous block's value — one block (~5 ms) of
        // staleness after a routing-mode flip, which is a mouse click, not an audio-rate event.
        int carveable = 0;
        for (std::size_t n = 0; n < kNumSends; ++n)
            if (!retToHw[n] && !retExternal[n]) carveable |= (1 << n);
        carveableReturnsMask_.store(carveable, std::memory_order_relaxed);
        for (std::size_t n = 0; n < kNumSends; ++n) {
            if ((carveable & (1 << n)) == 0) continue;
            const std::size_t node = kCarveNodeReturn0 + n;
            xmodOnsetPrev_[node] = detectXModOnset(node, retCarveL[n], retCarveR[n],
                                                   carveFrames, srHz);
            analyzeCarve(node, retCarveL[n], retCarveR[n], carveFrames, srHz);
            float* bus[2] = { retCarveL[n], retCarveR[n] };
            applyCarve(node, bus, 2, carveFrames, srHz);
        }
        xmodOnsetPrev_[kCarveNodeInput] = detectXModOnset(kCarveNodeInput, micCarveL, micCarveR,
                                                          carveFrames, srHz);
        analyzeCarve(kCarveNodeInput, micCarveL, micCarveR, carveFrames, srHz);
        float* micBus[2] = { micCarveL, micCarveR };
        applyCarve(kCarveNodeInput, micBus, 2, carveFrames, srHz);
    }

    // ── PASS B (XN-02) — the master sum and everything downstream of it ──────────────────────
    for (std::uint32_t frame = 0; frame < framesToRender; ++frame) {
        laneGain[0] += laneGainInc[0];
        laneGain[1] += laneGainInc[1];
        laneGain[2] += laneGainInc[2];
        laneGain[3] += laneGainInc[3];
        float* s1Ptr = outputs[laneIndex(AudioLane::send1)];
        float* s2Ptr = outputs[laneIndex(AudioLane::send2)];
        float* s3Ptr = outputs[laneIndex(AudioLane::send3)];
        float* s4Ptr = outputs[laneIndex(AudioLane::send4)];

        // Post-carve values (identical to the pre-carve ones for any node sitting on `own`).
        const float ret1AddL = retCarveL[0][frame], ret1AddR = retCarveR[0][frame];
        const float ret2AddL = retCarveL[1][frame], ret2AddR = retCarveR[1][frame];
        const float ret3AddL = retCarveL[2][frame], ret3AddR = retCarveR[2][frame];
        const float ret4AddL = retCarveL[3][frame], ret4AddR = retCarveR[3][frame];
        const float micL = micCarveL[frame], micR = micCarveR[frame];

        // Expose the FX-return wet on its own lanes so the device host can capture reverb/delay/
        // host tails as independent recording stems. Pure tap — these lanes are not routed to
        // hardware; the wet is still summed into main below.
        if (float* w = outputs[laneIndex(AudioLane::returnWet1L)]) w[frame] = ret1AddL;
        if (float* w = outputs[laneIndex(AudioLane::returnWet1R)]) w[frame] = ret1AddR;
        if (float* w = outputs[laneIndex(AudioLane::returnWet2L)]) w[frame] = ret2AddL;
        if (float* w = outputs[laneIndex(AudioLane::returnWet2R)]) w[frame] = ret2AddR;
        if (float* w = outputs[laneIndex(AudioLane::returnWet3L)]) w[frame] = ret3AddL;
        if (float* w = outputs[laneIndex(AudioLane::returnWet3R)]) w[frame] = ret3AddR;
        if (float* w = outputs[laneIndex(AudioLane::returnWet4L)]) w[frame] = ret4AddL;
        if (float* w = outputs[laneIndex(AudioLane::returnWet4R)]) w[frame] = ret4AddR;

        // A host return routed to its dedicated output is exclusive: keep its wet OUT of the main
        // sum (it goes to the send lane below instead).
        float left = (micMonitor ? micL : 0.0f)
            + (mainLeft != nullptr ? mainLeft[frame] : 0.0f)
            + (ret1ToHw ? 0.0f : ret1AddL) + (ret2ToHw ? 0.0f : ret2AddL)
            + (ret3ToHw ? 0.0f : ret3AddL) + (ret4ToHw ? 0.0f : ret4AddL);
        float right = (micMonitor ? micR : 0.0f)
            + (mainRight != nullptr ? mainRight[frame] : 0.0f)
            + (ret1ToHw ? 0.0f : ret1AddR) + (ret2ToHw ? 0.0f : ret2AddR)
            + (ret3ToHw ? 0.0f : ret3AddR) + (ret4ToHw ? 0.0f : ret4AddR);

        // Master drive/clip on the main bus (selectable curve; soft = legacy parity).
        masterDrive_.processSample(left, right);

        if (mainLeft != nullptr) {
            mainLeft[frame] = left * masterCleanGain * state.mainGain;
        }
        if (mainRight != nullptr) {
            mainRight[frame] = right * masterCleanGain * state.mainGain;
        }
        // Send lanes: external mode passes the (send-master scaled) send bus to hardware; a host
        // return routed to its dedicated output writes its mono-folded wet onto the lane; otherwise
        // host mode consumed the send bus above (wet returns to main), so zero the lane.
        if (s1Ptr != nullptr) {
            if (ret1External)   s1Ptr[frame] = s1Ptr[frame] * laneGain[0];
            else if (ret1ToHw)  s1Ptr[frame] = (ret1AddL + ret1AddR) * 0.5f;
            else                s1Ptr[frame] = 0.0f;
        }
        if (s2Ptr != nullptr) {
            if (ret2External)   s2Ptr[frame] = s2Ptr[frame] * laneGain[1];
            else if (ret2ToHw)  s2Ptr[frame] = (ret2AddL + ret2AddR) * 0.5f;
            else                s2Ptr[frame] = 0.0f;
        }
        if (s3Ptr != nullptr) {
            if (ret3External)   s3Ptr[frame] = s3Ptr[frame] * laneGain[2];
            else if (ret3ToHw)  s3Ptr[frame] = (ret3AddL + ret3AddR) * 0.5f;
            else                s3Ptr[frame] = 0.0f;
        }
        if (s4Ptr != nullptr) {
            if (ret4External)   s4Ptr[frame] = s4Ptr[frame] * laneGain[3];
            else if (ret4ToHw)  s4Ptr[frame] = (ret4AddL + ret4AddR) * 0.5f;
            else                s4Ptr[frame] = 0.0f;
        }
        if (outputs[laneIndex(AudioLane::cueLeft)] != nullptr) {
            outputs[laneIndex(AudioLane::cueLeft)][frame] = left * state.cueGain;
        }
        if (outputs[laneIndex(AudioLane::cueRight)] != nullptr) {
            outputs[laneIndex(AudioLane::cueRight)][frame] = right * state.cueGain;
        }
        if (outputs[laneIndex(AudioLane::deckLeft)] != nullptr) {
            outputs[laneIndex(AudioLane::deckLeft)][frame] = left * state.deckGain;
        }
        if (outputs[laneIndex(AudioLane::deckRight)] != nullptr) {
            outputs[laneIndex(AudioLane::deckRight)][frame] = right * state.deckGain;
        }
    }
    // Publish the mic input peak for the UI level meter (max over this block, monotonic until read).
    if (inPeak > 0.0f) {
        float prev = inputPeak_.load(std::memory_order_relaxed);
        while (inPeak > prev
               && !inputPeak_.compare_exchange_weak(prev, inPeak, std::memory_order_release,
                                                    std::memory_order_relaxed)) {}
    }

    // Master stage on dedicated deck lanes. A dedicated-output deck is split out of the main
    // bus (above), so the main-bus master drive + clean gain never touch it — without this the
    // master volume/clipper has NO effect on a deck routed to its own output (compose mode with
    // assigned deck channels, or DJ split). Master settings are PER-SESSION, so each dedicated
    // deck uses ITS OWN snapshot's master settings (not decks[0]'s) and its OWN drive instance
    // (deckMasterDrive_[di]) so the ADAA history per lane stays independent.
    if (renderWorld_ != nullptr && renderWorld_->djMode) {
        static constexpr AudioLane kMasterDeckLanes[kMaxDecks][2] = {
            { AudioLane::deckA_L, AudioLane::deckA_R },
            { AudioLane::deckB_L, AudioLane::deckB_R },
            { AudioLane::deckC_L, AudioLane::deckC_R },
        };
        for (std::size_t di = 0; di < kMaxDecks; ++di) {
            if (!renderWorld_->decks[di].active || !renderWorld_->decks[di].dedicatedOutput) {
                continue;
            }
            float* dL = outputs[laneIndex(kMasterDeckLanes[di][0])];
            float* dR = outputs[laneIndex(kMasterDeckLanes[di][1])];
            if (dL == nullptr && dR == nullptr) {
                continue;
            }
            const NativeSequencerSnapshot& deckSnap = renderWorld_->decks[di].snapshot;
            const float deckMasterVol = static_cast<float>(deckSnap.masterVolume);
            const float deckCleanGain = NativeMasterDrive::cleanOutputGain(deckMasterVol);
            NativeMasterDrive& drive = deckMasterDrive_[di];
            drive.setParameters(static_cast<MasterDriveCurve>(deckSnap.masterClipperCurve),
                                deckMasterVol,
                                deckSnap.masterClipperThreshold,
                                deckSnap.masterClipperSoftness,
                                deckSnap.masterClipperDrive,
                                deckSnap.masterClipperCeiling,
                                deckSnap.masterClipperOversample,
                                deckSnap.masterClipperDecoupled);
            for (std::uint32_t frame = 0; frame < framesToRender; ++frame) {
                float l = dL != nullptr ? dL[frame] : 0.0f;
                float r = dR != nullptr ? dR[frame] : 0.0f;
                drive.processSample(l, r);
                if (dL != nullptr) dL[frame] = l * deckCleanGain;
                if (dR != nullptr) dR[frame] = r * deckCleanGain;
            }
        }
    }

    for (std::uint32_t frame = framesToRender; frame < frameCount; ++frame) {
        for (float* output : outputs) {
            if (output != nullptr) {
                output[frame] = 0.0f;
            }
        }
    }

    // Output meter: peak |sample| of the FULL audible mix for this callback. The audible
    // signal is the main bus PLUS every per-deck output lane: a deck rides EITHER the
    // crossfader main mix (audio in main, its deck lane silent) OR a dedicated split output
    // (audio in its deck lane, kept out of main) — never both — so summing matches exactly
    // what reaches the hardware (mirrors NativeJuceDeviceHost::pushOutputCapture). Scanning
    // mainLeft/Right alone reads ~0 whenever decks are split out or mainGain is 0.
    {
        const float* mL = mainLeft;
        const float* mR = mainRight;
        const float* aL = outputs[laneIndex(AudioLane::deckA_L)];
        const float* aR = outputs[laneIndex(AudioLane::deckA_R)];
        const float* bL = outputs[laneIndex(AudioLane::deckB_L)];
        const float* bR = outputs[laneIndex(AudioLane::deckB_R)];
        const float* cL = outputs[laneIndex(AudioLane::deckC_L)];
        const float* cR = outputs[laneIndex(AudioLane::deckC_R)];
        const auto s = [](const float* p, std::uint32_t i) { return p != nullptr ? p[i] : 0.0f; };
        // Low-band tap for the background shake: a one-pole LPF (~120 Hz) on the
        // mono sum, peak-held like the meter. A couple of ops per frame on top of
        // a loop that already reads every sample — the whole feature's DSP cost.
        const float sr = static_cast<float>(sampleRate_.load(std::memory_order_relaxed));
        const float lowK = (sr > 0.0f)
            ? 1.0f - std::exp(-2.0f * 3.14159265f * 120.0f / sr)
            : 0.0f;
        float lowLpf = lowBandLpf_;
        float lowPeak = 0.0f;
        float peak = 0.0f;
        for (std::uint32_t frame = 0; frame < framesToRender; ++frame) {
            const float l = s(mL, frame) + s(aL, frame) + s(bL, frame) + s(cL, frame);
            const float r = s(mR, frame) + s(aR, frame) + s(bR, frame) + s(cR, frame);
            peak = std::max(peak, std::max(std::fabs(l), std::fabs(r)));
            lowLpf += lowK * (0.5f * (l + r) - lowLpf);
            lowPeak = std::max(lowPeak, std::fabs(lowLpf));
        }
        // Flush near silence: a decaying one-pole otherwise parks in the
        // subnormals for ever (the DC-blocker lesson, P8-3).
        lowBandLpf_ = (std::fabs(lowLpf) < 1.0e-12f) ? 0.0f : lowLpf;
        // Keep the running max until the UI consumes it (consumeOutputPeak resets to 0).
        float prev = outputPeak_.load(std::memory_order_relaxed);
        while (peak > prev &&
               !outputPeak_.compare_exchange_weak(prev, peak, std::memory_order_relaxed)) {
            // prev is reloaded by compare_exchange_weak on failure.
        }
        float lowPrev = lowBandPeak_.load(std::memory_order_relaxed);
        while (lowPeak > lowPrev &&
               !lowBandPeak_.compare_exchange_weak(lowPrev, lowPeak, std::memory_order_relaxed)) {
        }
    }

    // SIG-3: publish this callback's per-track activity peaks into the decayed levels the
    // track-row LEDs read (deckTrackMixLevel).
    foldTrackMixLevels(framesToRender);

    // Sample-accurate MIDI clock out: feed this block's transport + audible tempo to the clock
    // generator (no-op unless a clock-out is wired and enabled). Derives 24-PPQN tick host times
    // from the sample position, so the clock is phase-locked to the audio and cannot drift.
    if (midiClockOut_ != nullptr) {
        const double clockSampleRate = sampleRate_.load(std::memory_order_relaxed);
        bool clockPlaying = false;
        double clockBpm = 0.0;
        if (renderWorld_ != nullptr) {
            if (!renderWorld_->djMode) {
                clockPlaying = renderWorld_->sequencerState.isPlaying;
                clockBpm = renderWorld_->sequencerState.bpm
                    * std::max(0.1, renderWorld_->sequencerState.masterSpeed);
            } else {
                // The clock free-runs at the DJ master tempo (see NativeMidiClockOut::feedBlock).
                // When a deck is audibly playing, follow its synced tempo and mark the transport
                // playing (START on the edge). When nothing plays, still supply a resting tempo so
                // the clock keeps ticking: the first ACTIVE deck's synced tempo — all synced decks
                // share the master tempo, and deck A (the anchor) carries it — falling back to
                // deck A's snapshot so a selected clock always ticks even with no active deck.
                const DeckWorld* playing = nullptr;
                const DeckWorld* firstActive = nullptr;
                for (const auto& deck : renderWorld_->decks) {
                    if (!deck.active) { continue; }
                    if (firstActive == nullptr) { firstActive = &deck; }
                    if (deck.snapshot.isPlaying) { playing = &deck; break; }
                }
                const DeckWorld* src = playing != nullptr
                    ? playing
                    : (firstActive != nullptr ? firstActive : &renderWorld_->decks[0]);
                clockPlaying = (playing != nullptr);
                clockBpm = src->snapshot.bpm * std::max(0.1, src->snapshot.masterSpeed);
            }
        }
#if SCOOPY_MIDI_HARDWARE
        midiClockOut_->feedBlock(midiClockBlockHostTime, clockSampleRate, framesToRender,
                                 clockPlaying, clockBpm);
#else
        // No MIDI hardware in this build (browser): the clock generator is compiled out.
        (void)midiClockBlockHostTime; (void)clockSampleRate; (void)clockPlaying; (void)clockBpm;
#endif
    }

    // Generated MIDI: on a transport-stop edge, flush every sounding note so nothing hangs. Notes now
    // carry a real GATE, so this is the backstop for the cases a gate can't cover (stop mid-note, a
    // scheduled flam tail, a glide still ramping). Covers BOTH destinations — external gear and any
    // hosted instrument — because a voice remembers where it sent its notes.
    // Mirrors the clock's playing detection (composition: sequencer; DJ: any active deck).
    {
        bool notesPlaying = false;
        if (renderWorld_ != nullptr) {
            if (!renderWorld_->djMode) {
                notesPlaying = renderWorld_->sequencerState.isPlaying;
            } else {
                for (const auto& deck : renderWorld_->decks)
                    if (deck.active && deck.snapshot.isPlaying) { notesPlaying = true; break; }
            }
        }
        if (externalMidiWasPlaying_ && !notesPlaying)
            flushGeneratedMidiNotes(sampleRate_.load(std::memory_order_relaxed), 0);
        externalMidiWasPlaying_ = notesPlaying;
    }

    // (The seamless-switch resume one-shot is per-track and self-clears in the trigger loop on the
    // first step each track processes after the switch — see NativeRenderState::switchResumePending.)

    const auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - startTime);
    updateTiming(static_cast<std::uint64_t>(elapsed.count()), frameCount);
}

float NativeAudioEngineCore::consumeOutputPeak() noexcept {
    return outputPeak_.exchange(0.0f, std::memory_order_relaxed);
}

float NativeAudioEngineCore::consumeLowBandPeak() noexcept {
    return lowBandPeak_.exchange(0.0f, std::memory_order_relaxed);
}

std::uint64_t NativeAudioEngineCore::deckPlayheadStep(std::size_t deck) const noexcept {
    if (deck >= kMaxDecks) return 0;
    return deckPlayheadStep_[deck].load(std::memory_order_acquire);
}

void NativeAudioEngineCore::resetDeckPlayheadStep(std::size_t deck, std::uint64_t step) noexcept {
    if (deck >= kMaxDecks) return;
    // Lag-free reset of the published UI step. Called from the main thread at transport start so a
    // UI poll landing before the first render callback reads the fresh start step instead of the
    // stale last-played step (which would otherwise flash before the engine resets it). The audio
    // thread overwrites this each callback, so a benign cross-thread store is safe.
    deckPlayheadStep_[deck].store(step, std::memory_order_release);
    // The parked value is not the audible clock until the render thread republishes it — mark the
    // clock not-live so captures (beat repeat arm) wait for the first real render write.
    deckClockLive_[deck].store(false, std::memory_order_release);
}

bool NativeAudioEngineCore::deckClockLive(std::size_t deck) const noexcept {
    if (deck >= kMaxDecks) return false;
    return deckClockLive_[deck].load(std::memory_order_acquire);
}

float NativeAudioEngineCore::deckEnvelopeLevel(std::size_t deck, std::size_t trackIndex) const noexcept {
    if (deck >= kMaxDecks || trackIndex >= kMaxEnvelopeTracks) return 0.0f;
    // Plain read of the persistent per-deck detector state. The audio thread updates this float
    // each frame (see updateEnvFollower); a single-float read is fine for a UI monitor value.
    const float level = callbackRenderState_[deck].trackEnvelopeLevel[trackIndex];
    return std::isfinite(level) && level > 0.0f ? level : 0.0f;
}

void NativeAudioEngineCore::foldTrackMixLevels(std::uint32_t frames) noexcept {
    const float sr = static_cast<float>(sampleRate_.load(std::memory_order_relaxed));
    // −200 dB/s release → −60 dB in 300 ms: fast enough that a stopped track's LED reads as
    // "off now", slow enough that a 30 Hz poll can't miss a hit between frames. Per-block
    // coefficient, so the rate is buffer-size independent.
    const float releaseCoeff = sr > 0.0f
        ? std::pow(10.0f, -10.0f * static_cast<float>(frames) / sr)
        : 0.0f;
    for (std::size_t deck = 0; deck < kMaxDecks; ++deck) {
        auto& state = callbackRenderState_[deck];
        for (std::size_t t = 0; t < kMaxEnvelopeTracks; ++t) {
            const float blockPeak = state.trackMixBlockPeak[t];
            state.trackMixBlockPeak[t] = 0.0f;
            float next = std::max(blockPeak, state.trackMixLevel[t] * releaseCoeff);
            // Flush near-silence to a hard 0 — a decaying one-pole otherwise parks in the
            // subnormals for ever (the DC-blocker lesson, P8-3).
            if (!std::isfinite(next) || next < 1.0e-9f) next = 0.0f;
            state.trackMixLevel[t] = next;
        }
    }
}

float NativeAudioEngineCore::deckTrackMixLevel(std::size_t deck, std::size_t trackIndex) const noexcept {
    if (deck >= kMaxDecks || trackIndex >= kMaxEnvelopeTracks) return 0.0f;
    // Plain read of persistent per-deck render state, same discipline as deckEnvelopeLevel.
    const float level = callbackRenderState_[deck].trackMixLevel[trackIndex];
    return std::isfinite(level) && level > 0.0f ? level : 0.0f;
}

float NativeAudioEngineCore::carveDepth(std::size_t node, std::size_t band) const noexcept {
    if (node >= kMaxCarveNodes || band >= static_cast<std::size_t>(kCarveBands)) return 0.0f;
    // The stage's `gain` IS the duck applied to the audio this callback. Report what was TAKEN,
    // not what survived: the UI is drawing the bite, and "how much is missing" is the thing a
    // performer is actually reading off it.
    const double gain = carveStage_[node].gain[band];
    if (!std::isfinite(gain)) return 0.0f;
    return static_cast<float>(std::clamp(1.0 - gain, 0.0, 1.0));
}

float NativeAudioEngineCore::deckTrackSamplePos(std::size_t deck, std::size_t trackIndex) const noexcept {
    if (deck >= kMaxDecks) return -1.0f;
    const auto& state = callbackRenderState_[deck];

    // The NEWEST voice on this track — the one you last heard start. A track can have several
    // sounding at once (poly, chord siblings, a flam ratchet, an OWN tail ringing under the next
    // hit); a playhead that showed the tail instead of the hit would be lying about the same
    // audio it is drawn over.
    const NativeRenderVoice* newest = nullptr;
    for (const auto& voice : state.voices) {
        if (!voice.active || voice.sample == nullptr) continue;
        if (voice.trackIndex != trackIndex) continue;
        if (newest == nullptr || voice.triggerSerial > newest->triggerSerial) newest = &voice;
    }
    if (newest == nullptr) return -1.0f;

    // Fraction of the SOURCE buffer, not of the cell: the UI draws its waveform from these same
    // frames, so this maps straight onto a drawn column with no shared knowledge of trim, chop,
    // pitch, varispeed, stretch or reverse. Whatever the engine did to get here, the answer is
    // still "this frame".
    const std::size_t frames = newest->sample->left.size();
    if (frames < 2) return -1.0f;
    const double pos = newest->position;
    if (!std::isfinite(pos)) return -1.0f;
    return static_cast<float>(std::clamp(pos / static_cast<double>(frames - 1), 0.0, 1.0));
}

float NativeAudioEngineCore::deckModChannelValue(std::size_t deck, std::size_t channel) const noexcept {
    if (deck >= kMaxDecks || channel >= static_cast<std::size_t>(kModChannelCount)) return 0.0f;
    // Current per-deck modulation output (already depth-scaled in the render loop). Bipolar
    // (−1…1) for LFO/bipolar envelopes, so do NOT clamp to >0. Single-float UI-monitor read.
    const float v = callbackRenderState_[deck].modChannelValue[channel];
    return std::isfinite(v) ? v : 0.0f;
}

float NativeAudioEngineCore::deckModChannelPhase(std::size_t deck, std::size_t channel) const noexcept {
    if (deck >= kMaxDecks || channel >= static_cast<std::size_t>(kModChannelCount)) return -1.0f;
    // Published by the render loop (which is where the channel's TYPE is known). -1 means
    // "no static shape to ride" — env-follower, or an envelope sitting idle between gates.
    const float p = callbackRenderState_[deck].modChannelPhase[channel];
    return std::isfinite(p) ? p : -1.0f;
}

void NativeAudioEngineCore::requestSeek(std::size_t deck, std::int64_t step) noexcept {
    if (deck >= kMaxDecks || step < 0) return;
    pendingSeekStep_[deck].store(step, std::memory_order_release);
}

void NativeAudioEngineCore::requestQuantizedLaunch(std::size_t deck, std::size_t refDeck,
                                                   std::uint16_t quantizeSteps) noexcept {
    if (deck >= kMaxDecks || refDeck >= kMaxDecks) return;
    QuantizedLaunchCommand cmd;
    cmd.armed = 1;
    cmd.refDeck = static_cast<std::uint8_t>(refDeck);
    cmd.quantizeSteps = quantizeSteps == 0 ? 1 : quantizeSteps;
    pendingLaunch_[deck].store(cmd, std::memory_order_release);
}

void NativeAudioEngineCore::cancelQuantizedLaunch(std::size_t deck) noexcept {
    if (deck >= kMaxDecks) return;
    pendingLaunch_[deck].store(QuantizedLaunchCommand {}, std::memory_order_release);
}

std::uint32_t NativeAudioEngineCore::launchFiredSequence(std::size_t deck) const noexcept {
    if (deck >= kMaxDecks) return 0;
    return launchFiredSeq_[deck].load(std::memory_order_acquire);
}

void NativeAudioEngineCore::setBusTexture(double texture01) noexcept {
    const double t = std::clamp(texture01, 0.0, 1.0);
    for (auto& deckTexture : deckBusTexture_)
        deckTexture.store(t, std::memory_order_relaxed);
}

void NativeAudioEngineCore::setDeckBusTexture(int deck, double texture01) noexcept {
    if (deck < 0 || static_cast<std::size_t>(deck) >= kMaxDecks) return;
    deckBusTexture_[static_cast<std::size_t>(deck)].store(std::clamp(texture01, 0.0, 1.0),
                                                          std::memory_order_relaxed);
}

void NativeAudioEngineCore::setBusGranularParams(bool browseEnabled, double browseSpeed,
                                                 double transposeSemis, double tonalityLimit) noexcept {
    busBrowseEnabled_.store(browseEnabled, std::memory_order_relaxed);
    busBrowseSpeed_.store(browseSpeed, std::memory_order_relaxed);
    busTransposeSemis_.store(transposeSemis, std::memory_order_relaxed);
    busTonalityLimit_.store(tonalityLimit, std::memory_order_relaxed);
    busTransposeDirty_.store(true, std::memory_order_release);
}

void NativeAudioEngineCore::setDeckBusTranspose(int deck, double semitones) noexcept {
    if (deck < 0 || static_cast<std::size_t>(deck) >= kMaxDecks) return;
    deckBusTransposeSemis_[static_cast<std::size_t>(deck)].store(semitones, std::memory_order_relaxed);
}

void NativeAudioEngineCore::setDeckBusSpectral(int deck, double chaos,
                                               double airDb) noexcept {
    if (deck < 0 || static_cast<std::size_t>(deck) >= kMaxDecks) return;
    const auto di = static_cast<std::size_t>(deck);
    deckBusChaos_[di].store(std::clamp(chaos, -1.0, 1.0), std::memory_order_relaxed);
    deckBusAirDb_[di].store(std::clamp(airDb, 0.0, 12.0), std::memory_order_relaxed);
}

void NativeAudioEngineCore::setCarveAmount(int node, double amount, int sourceMask,
                                           double shimmer, int sendSkipMask) noexcept {
    if (node < 0 || static_cast<std::size_t>(node) >= kMaxCarveNodes) return;
    const auto ni = static_cast<std::size_t>(node);
    carveAmount_[ni].store(std::clamp(amount, 0.0, 1.0), std::memory_order_relaxed);
    carveSourceMask_[ni].store(sourceMask, std::memory_order_relaxed);
    carveShimmerAmount_[ni].store(std::clamp(shimmer, 0.0, 1.0), std::memory_order_relaxed);
    if (ni < kMaxDecks)
        deckCarveSendSkipMask_[ni].store(sendSkipMask, std::memory_order_relaxed);
}

void NativeAudioEngineCore::analyzeCarve(std::size_t node, const float* left,
                                         const float* right, int frames,
                                         double sampleRate) noexcept {
    if (node >= kMaxCarveNodes || frames <= 0 || left == nullptr || right == nullptr) return;
    CarveAnalyzer& an = carveAnalyzer_[node];
    double split[kCarveBands - 1];
    for (int b = 0; b < kCarveBands - 1; ++b)
        split[b] = 1.0 - std::exp(-2.0 * 3.14159265358979 * kCarveCrossoverHz[b] / sampleRate);
    const double kEnv = 1.0 - std::exp(-1.0 / (kCarveEnvSecs * sampleRate));
    for (int i = 0; i < frames; ++i) {
        double rest = 0.5 * (static_cast<double>(left[i]) + static_cast<double>(right[i]));
        for (int b = 0; b < kCarveBands - 1; ++b) {
            // Second-order lowpass (two cascaded one-poles) of the running remainder; the band
            // is then subtracted so band + rest ≡ input regardless of the filter shape.
            an.lp[b][0] += split[b] * (rest       - an.lp[b][0]);
            an.lp[b][1] += split[b] * (an.lp[b][0] - an.lp[b][1]);
            const double band = an.lp[b][1];
            rest -= band;
            an.env[b] += kEnv * (std::abs(band) - an.env[b]);
        }
        an.env[kCarveBands - 1] += kEnv * (std::abs(rest) - an.env[kCarveBands - 1]);
    }
    double total = 0.0;
    for (int b = 0; b < kCarveBands; ++b) total += an.env[b];
    auto& weights = carveWeights_[node];
    if (total < kCarveSilenceFloor) {
        weights.fill(0.0);   // a silent node carves nothing
        return;
    }
    for (int b = 0; b < kCarveBands; ++b)
        weights[b] = std::clamp(an.env[b] / total * kCarveWeightScale, 0.0, 1.0);
}

void NativeAudioEngineCore::applyCarve(std::size_t node, float* const* bus, int channels,
                                       int frames, double sampleRate,
                                       int sendSkipMask) noexcept {
    if (node >= kMaxCarveNodes || frames <= 0) return;
    channels = std::clamp(channels, 0, static_cast<int>(kDeckBusChannels));
    if (channels <= 0) return;
    CarveGainStage& st = carveStage_[node];
    CarveShimmer& sh = carveShimmer_[node];
    const double amount = carveAmount_[node].load(std::memory_order_relaxed);
    const int mask = carveSourceMask_[node].load(std::memory_order_relaxed);
    const double shimmer = carveShimmerAmount_[node].load(std::memory_order_relaxed);
    double& pumpEnv = carvePumpEnv_[node];
    // Fast skip once fully released: amount off, pump decayed, every band back at unity,
    // shimmer silent.
    if (amount <= 1.0e-4 && pumpEnv <= 1.0e-4) {
        bool converged = true;
        for (int b = 0; b < kCarveBands; ++b)
            if (st.gain[b] < 0.999 || sh.gain[b] > 1.0e-3) { converged = false; break; }
        if (converged) return;
    }
    // Source weights = per-band MAX across the source NODES (covers a shared side — deck C on
    // the same side as B, or a deck and an FX return both assigned to side A).
    double src[kCarveBands] = {};
    for (std::size_t j = 0; j < kMaxCarveNodes; ++j) {
        if ((mask & (1 << j)) == 0) continue;
        for (int b = 0; b < kCarveBands; ++b)
            src[b] = std::max(src[b], carveWeights_[j][b]);
    }
    // Carve DRIVER per band = strong absolute base (opposite's presence, always audible) plus
    // a dominance bonus (extra where the opposite out-occupies THIS node). Similar full-palette
    // material still ducks hard via the base; the momentary per-band winner keeps its bands
    // (its opposite is quiet there → low src) while the loser is carved deeper (high src + high
    // dominance) → an interlocked mosaic rather than a symmetric volume-like dip.
    const auto& own = carveWeights_[node];
    double drive[kCarveBands];
    for (int b = 0; b < kCarveBands; ++b) {
        const double dom = std::clamp(src[b] - own[b], 0.0, 1.0);
        drive[b] = std::clamp(kCarveBaseFrac * src[b] + kCarveDomBonus * dom, 0.0, 1.0);
    }
    // Onset-driven pump: deepen the carve on each transient from the incoming (source) side.
    // Fed only while the fader actually carves (amount > 0); env attacks fast, releases short.
    const double blockSecs0 = static_cast<double>(frames) / sampleRate;
    double onset = 0.0;
    if (amount > 1.0e-4)
        for (std::size_t j = 0; j < kMaxCarveNodes; ++j)
            if (mask & (1 << j)) onset = std::max(onset, xmodOnsetPrev_[j]);
    {
        const double pk = onset > pumpEnv
            ? std::min(1.0, blockSecs0 / kPumpAttackSecs)
            : std::min(1.0, blockSecs0 / kPumpReleaseSecs);
        pumpEnv += (onset - pumpEnv) * pk;
    }
    const double effAmount = std::min(1.0, amount + kPumpDepth * pumpEnv);
    double split[kCarveBands - 1];
    for (int b = 0; b < kCarveBands - 1; ++b)
        split[b] = 1.0 - std::exp(-2.0 * 3.14159265358979 * kCarveCrossoverHz[b] / sampleRate);
    const double kAtk = 1.0 - std::exp(-1.0 / (kCarveAttackSecs * sampleRate));
    const double kRel = 1.0 - std::exp(-1.0 / (kCarveReleaseSecs * sampleRate));
    double target[kCarveBands];
    for (int b = 0; b < kCarveBands; ++b)
        target[b] = 1.0 - effAmount * drive[b] * kCarveMaxCut;

    // ── Shimmer resonators (bands 1…N-1; resonant lows would just be mud) ────────────
    // Per-block coefficient update: centre = geometric band centre, slid toward the
    // LOUDER neighbour of the source side's spectrum (smoothed — the resonances glide as
    // the other track's content moves) and detuned ±kShimmerDetuneOct on L/R.
    const double moveK = std::min(1.0, blockSecs0 / kShimmerMoveSecs);
    double shimmerTarget[kCarveBands] = {};
    // TPT SVF coefficients per band per channel: a1..a3 + k (bandpass out normalized by k).
    // A second "sparkle" set for the top bands rings an octave above centre (air).
    double svfA1[kCarveBands][kDeckBusChannels];
    double svfA2[kCarveBands][kDeckBusChannels];
    double svfA3[kCarveBands][kDeckBusChannels];
    double spA1[kCarveBands][kDeckBusChannels];
    double spA2[kCarveBands][kDeckBusChannels];
    double spA3[kCarveBands][kDeckBusChannels];
    const double svfK = 1.0 / kShimmerQ;
    for (int b = 1; b < kCarveBands; ++b) {
        // Shimmer follows the same dominance driver + pump as the duck, so the bands that get
        // carved are exactly the bands that ring back.
        shimmerTarget[b] = shimmer * effAmount * drive[b] * kShimmerWet;
        const double lo = kCarveCrossoverHz[b - 1];
        const double hi = (b < kCarveBands - 1) ? kCarveCrossoverHz[b] : 12000.0;
        const double baseHz = std::sqrt(lo * hi);
        const double wDown = src[b - 1];
        const double wUp = (b < kCarveBands - 1) ? src[b + 1] : 0.0;
        const double slide = std::clamp(wUp - wDown, -1.0, 1.0) * kShimmerMoveOct;
        sh.moveOct[b] += (slide - sh.moveOct[b]) * moveK;
        const bool sparkle = (b >= kShimmerSparkleLo);
        for (int ch = 0; ch < channels; ++ch) {
            const double detune = (ch == 0) ? kShimmerDetuneOct
                                : (ch == 1) ? -kShimmerDetuneOct : 0.0;
            const double fc = std::clamp(baseHz * std::exp2(sh.moveOct[b] + detune),
                                         20.0, 0.45 * sampleRate);
            const double g = std::tan(3.14159265358979 * fc / sampleRate);
            const double a1 = 1.0 / (1.0 + g * (g + svfK));
            svfA1[b][ch] = a1;
            svfA2[b][ch] = g * a1;
            svfA3[b][ch] = g * g * a1;
            if (sparkle) {
                const double fcS = std::clamp(fc * 2.0, 20.0, 0.45 * sampleRate);  // octave up
                const double gS = std::tan(3.14159265358979 * fcS / sampleRate);
                const double a1S = 1.0 / (1.0 + gS * (gS + svfK));
                spA1[b][ch] = a1S;
                spA2[b][ch] = gS * a1S;
                spA3[b][ch] = gS * gS * a1S;
            }
        }
    }

    for (int i = 0; i < frames; ++i) {
        // Smooth per sample: carve engages fast (attack) and releases musically; the
        // shimmer wet gains follow the same law.
        for (int b = 0; b < kCarveBands; ++b) {
            const double k = target[b] < st.gain[b] ? kAtk : kRel;
            st.gain[b] += k * (target[b] - st.gain[b]);
            const double ks = shimmerTarget[b] > sh.gain[b] ? kAtk : kRel;
            sh.gain[b] += ks * (shimmerTarget[b] - sh.gain[b]);
        }
        for (int ch = 0; ch < channels; ++ch) {
            // XN-03 — the single-carve rule: channels 2.. are this deck's feeds to sends 1..4.
            // A send whose RETURN carries its own crossfader side is left DRY here, because that
            // return carves itself downstream; carving both would duck the same signal twice, in
            // opposing directions. Stereo nodes (returns, input) pass sendSkipMask = 0.
            if (ch >= 2 && (sendSkipMask & (1 << (ch - 2))) != 0) continue;
            float* buf = bus[ch];
            if (buf == nullptr) continue;
            const double x = static_cast<double>(buf[i]);
            double rest = x;
            double y = 0.0;
            auto& lp = st.lp[ch];
            for (int b = 0; b < kCarveBands - 1; ++b) {
                // Second-order split (matches the analyzer); band is subtracted so the
                // reconstruction stays exact (sum of bands ≡ input) at unity gains.
                lp[b][0] += split[b] * (rest    - lp[b][0]);
                lp[b][1] += split[b] * (lp[b][0] - lp[b][1]);
                y += lp[b][1] * st.gain[b];
                rest -= lp[b][1];
            }
            y += rest * st.gain[kCarveBands - 1];
            // Re-inject the carved bands as RESONANCE: the pre-duck signal rings through
            // the moving, detuned bandpasses, scaled by the same source weights. The top
            // bands add an octave-up sparkle tap for air.
            for (int b = 1; b < kCarveBands; ++b) {
                if (sh.gain[b] <= 1.0e-4) continue;
                auto& s = sh.svf[b][ch];
                // TPT state-variable filter (Zavalishin), bandpass tap.
                const double v3 = x - s.ic2;
                const double v1 = svfA1[b][ch] * s.ic1 + svfA2[b][ch] * v3;
                const double v2 = s.ic2 + svfA2[b][ch] * s.ic1 + svfA3[b][ch] * v3;
                s.ic1 = 2.0 * v1 - s.ic1;
                s.ic2 = 2.0 * v2 - s.ic2;
                y += svfK * v1 * sh.gain[b];   // k·v1 = unity-peak bandpass
                if (b >= kShimmerSparkleLo) {
                    auto& sp = sh.sparkleSvf[b][ch];
                    const double sv3 = x - sp.ic2;
                    const double sv1 = spA1[b][ch] * sp.ic1 + spA2[b][ch] * sv3;
                    const double sv2 = sp.ic2 + spA2[b][ch] * sp.ic1 + spA3[b][ch] * sv3;
                    sp.ic1 = 2.0 * sv1 - sp.ic1;
                    sp.ic2 = 2.0 * sv2 - sp.ic2;
                    y += svfK * sv1 * sh.gain[b] * kShimmerSparkle;
                }
            }
            buf[i] = static_cast<float>(y);
        }
    }
}

double NativeAudioEngineCore::detectXModOnset(std::size_t node, const float* left,
                                              const float* right, int frames,
                                              double sampleRate) noexcept {
    if (node >= kMaxCarveNodes || frames <= 0 || left == nullptr || right == nullptr) return 0.0;
    XModDetector& d = xmodDetector_[node];
    // Per-callback coefficients (sampleRate is stable within a callback; cheap to derive).
    const double kLp   = 1.0 - std::exp(-2.0 * 3.14159265358979 * 150.0 / sampleRate);
    const double kAtk  = 1.0 - std::exp(-1.0 / (0.003 * sampleRate));   // ~3 ms attack
    const double kRel  = 1.0 - std::exp(-1.0 / (0.080 * sampleRate));   // ~80 ms release
    const double kSlow = 1.0 - std::exp(-1.0 / (1.0 * sampleRate));     // ~1 s normalizer
    for (int i = 0; i < frames; ++i) {
        const double x = 0.5 * (static_cast<double>(left[i]) + static_cast<double>(right[i]));
        d.lp += kLp * (x - d.lp);
        const double a = std::abs(d.lp);
        d.envFast += (a > d.envFast ? kAtk : kRel) * (a - d.envFast);
        d.envSlow += kSlow * (a - d.envSlow);
    }
    d.refractorySecs -= static_cast<double>(frames) / sampleRate;
    // Crest factor = fast/slow ratio: "how much louder than its own average right now" —
    // immune to mastering level/compression. Edge-triggered with hysteresis + refractory.
    const double crest = d.envFast / std::max(d.envSlow, 1.0e-6);
    constexpr double kOnThresh  = 1.8;
    constexpr double kOffThresh = 1.3;
    constexpr double kRefractory = 0.09;   // s — one onset per ~1/16 at fast tempos
    double strength = 0.0;
    if (!d.above && crest > kOnThresh && d.refractorySecs <= 0.0
        && d.envSlow > 1.0e-5) {           // gate: no onsets out of silence/noise floor
        d.above = true;
        d.refractorySecs = kRefractory;
        strength = std::clamp((crest - 1.0) / 3.0, 0.3, 1.0);
    } else if (d.above && crest < kOffThresh) {
        d.above = false;
    }
    return strength;
}

void NativeAudioEngineCore::setTapeReverseHold(std::size_t deck, bool active) noexcept {
    if (deck >= kMaxDecks) return;
    tapeReverseRequest_[deck].store(active ? 1 : -1, std::memory_order_release);
}

void NativeAudioEngineCore::processTapeReverse(std::size_t deck, float* left, float* right,
                                               std::uint32_t frameCount,
                                               std::size_t loopFrames) noexcept {
    TapeReverseState& t = tapeReverse_[deck];
    if (t.capacity == 0 || left == nullptr || right == nullptr) return;

    // ~11 ms equal-power-ish crossfade between live and reversed, matching SequencerNode.
    constexpr float kXfadeStep = 1.0f / 512.0f;

    // Latch the latest hold request (engage +1 / release −1). Engage seeds a fresh pass
    // anchored just behind the write head so the most recent audio replays first.
    const int req = tapeReverseRequest_[deck].exchange(0, std::memory_order_acquire);
    if (req == 1 && !t.active) {
        t.active      = true;
        t.loopLength  = std::clamp<std::size_t>(loopFrames, frameCount,
                                                t.capacity / 2);
        t.readCounter = 0;
        // Start one frame behind the write head (the most recently captured frame).
        t.readHead = (t.writeHead + t.capacity - 1) % t.capacity;
    } else if (req == -1) {
        // Release: stop looping; the crossfade ramps back to the live signal.
        t.active = false;
    }

    for (std::uint32_t f = 0; f < frameCount; ++f) {
        // Always capture the live (forward) post-stretch signal first.
        t.ringL[t.writeHead] = left[f];
        t.ringR[t.writeHead] = right[f];
        t.writeHead = (t.writeHead + 1) % t.capacity;

        // Ramp the reversed/live crossfade.
        if (t.active) t.fraction = std::min(1.0f, t.fraction + kXfadeStep);
        else          t.fraction = std::max(0.0f, t.fraction - kXfadeStep);

        if (t.fraction <= 0.0f) continue;  // fully live — nothing to overlay

        const float rl = t.ringL[t.readHead];
        const float rr = t.ringR[t.readHead];

        // Advance the backwards read head, looping the captured region. While held, each
        // loop boundary re-anchors to the latest write position so cell edits made during
        // the hold are heard on the next pass (mirrors SequencerNode's double-buffer).
        if (t.active && t.loopLength > 0) {
            if (++t.readCounter >= t.loopLength) {
                t.readHead    = (t.writeHead + t.capacity - 1) % t.capacity;
                t.readCounter = 0;
            } else {
                t.readHead = (t.readHead + t.capacity - 1) % t.capacity;
            }
        } else {
            // Releasing: keep reading backwards until the fade reaches zero.
            t.readHead = (t.readHead + t.capacity - 1) % t.capacity;
        }

        const float live = 1.0f - t.fraction;
        left[f]  = left[f]  * live + rl * t.fraction;
        right[f] = right[f] * live + rr * t.fraction;
    }
}

Diagnostics NativeAudioEngineCore::diagnostics() const noexcept {
    return {
        callbackLoad_.load(std::memory_order_acquire),
        callbackCount_.load(std::memory_order_acquire),
        deadlineMissCount_.load(std::memory_order_acquire),
        activeVoices_.load(std::memory_order_acquire),
        declaredDSPLatencyFrames_.load(std::memory_order_acquire),
        hardwareLatencyFrames_.load(std::memory_order_acquire),
        bufferSizeFrames_.load(std::memory_order_acquire),
        sampleRate_.load(std::memory_order_acquire),
        droppedVoiceCount_.load(std::memory_order_acquire),
        triggerOverflowCount_.load(std::memory_order_acquire),
        peakVoiceCount_.load(std::memory_order_acquire)
    };
}

BenchmarkResult NativeAudioEngineCore::runImpulseBenchmark(std::uint32_t callbackCount) {
    BenchmarkResult result;
    const std::uint32_t frames = bufferSizeFrames_.load(std::memory_order_acquire);
    if (frames == 0 || outputStorage_[0].size() < frames) {
        result.diagnostics = diagnostics();
        result.peakFrames.fill(-1);
        return result;
    }

    std::fill(inputLeft_.begin(), inputLeft_.end(), 0.0f);
    std::fill(inputRight_.begin(), inputRight_.end(), 0.0f);
    inputLeft_[0] = 1.0f;
    inputRight_[0] = 1.0f;

    std::array<float*, laneCount> outputPointers {};
    for (std::size_t lane = 0; lane < laneCount; ++lane) {
        outputPointers[lane] = outputStorage_[lane].data();
    }

    result.peakFrames.fill(-1);
    const std::uint32_t iterations = std::max<std::uint32_t>(callbackCount, 1);
    const bool wasRunning = running_.exchange(true, std::memory_order_acq_rel);
    for (std::uint32_t callback = 0; callback < iterations; ++callback) {
        for (auto& lane : outputStorage_) {
            std::fill(lane.begin(), lane.end(), 0.0f);
        }

        render(inputLeft_.data(), inputRight_.data(), outputPointers, frames);
        for (std::size_t lane = 0; lane < laneCount; ++lane) {
            float maximum = 0.0f;
            std::int32_t peakFrame = -1;
            for (std::uint32_t frame = 0; frame < frames; ++frame) {
                const float magnitude = std::abs(outputStorage_[lane][frame]);
                if (magnitude > maximum) {
                    maximum = magnitude;
                    peakFrame = static_cast<std::int32_t>(frame);
                }
            }
            result.peakFrames[lane] = peakFrame;
        }
    }
    running_.store(wasRunning, std::memory_order_release);

    result.diagnostics = diagnostics();
    return result;
}

bool NativeAudioEngineCore::registerSample(NativeSample sample) {
    if (sample.id.empty() || sample.left.empty() || sample.sampleRate <= 0.0) {
        return false;
    }
    if (!sample.right.empty() && sample.right.size() != sample.left.size()) {
        return false;
    }
    // Onset endpoints for choke deferral (control thread, once per install). Forward scan finds
    // the first audible frame, backward scan the last; both early-exit, so real material costs a
    // handful of frames and only an all-silent file pays a full pass (and stays at 0/0 → the
    // conservative immediate-choke fallback).
    {
        const std::size_t frameCount = sample.left.size();
        const bool stereo = !sample.right.empty();
        const auto audibleAt = [&](std::size_t frame) noexcept {
            const float magnitude = stereo
                ? std::max(std::fabs(sample.left[frame]), std::fabs(sample.right[frame]))
                : std::fabs(sample.left[frame]);
            return magnitude >= kOnsetThresholdLinear;
        };
        sample.onsetFrames = 0;
        sample.lastSoundFrame = 0;
        for (std::size_t frame = 0; frame < frameCount; ++frame) {
            if (audibleAt(frame)) {
                sample.onsetFrames = frame;
                for (std::size_t back = frameCount; back-- > frame;) {
                    if (audibleAt(back)) {
                        sample.lastSoundFrame = back;
                        break;
                    }
                }
                break;
            }
        }
    }
    const std::string id = sample.id;
    controlSamples_.insert_or_assign(id, std::make_shared<const NativeSample>(std::move(sample)));
    return true;
}

void NativeAudioEngineCore::retainSamples(const std::vector<std::string>& sampleIds) {
    const std::unordered_set<std::string> retained(sampleIds.begin(), sampleIds.end());
    for (auto iterator = controlSamples_.begin(); iterator != controlSamples_.end();) {
        if (retained.find(iterator->first) == retained.end()) {
            iterator = controlSamples_.erase(iterator);
        } else {
            ++iterator;
        }
    }
}

std::size_t NativeAudioEngineCore::registeredSampleCount() const noexcept {
    return controlSamples_.size();
}

std::size_t NativeAudioEngineCore::registeredSampleBytes() const noexcept {
    std::size_t bytes = 0;
    for (const auto& [id, sample] : controlSamples_) {
        bytes += id.capacity();
        if (sample) bytes += (sample->left.capacity() + sample->right.capacity()) * sizeof(float);
    }
    return bytes;
}

OfflineRenderResult NativeAudioEngineCore::renderOffline(const NativeSequencerSnapshot& snapshot,
                                                          std::uint64_t frameCount,
                                                          std::uint32_t chunkSizeFrames) const {
    const auto startTime = std::chrono::steady_clock::now();
    OfflineRenderResult result;
    result.left.assign(frameCount, 0.0f);
    result.right.assign(frameCount, 0.0f);
    result.unsupportedFeatures = snapshot.unsupportedFeatures;
    result.worldGeneration = publishedWorldGeneration_.load(std::memory_order_acquire);
    result.worldSampleBytes = registeredSampleBytes();
    for (const auto& track : snapshot.tracks) {
        if (track.sampleId.empty()) {
            if (std::find(track.steps.begin(), track.steps.end(), 1) != track.steps.end()) {
                result.unsupportedFeatures.push_back("missingSample:unassigned");
            }
        } else if (controlSamples_.find(track.sampleId) == controlSamples_.end()) {
            result.unsupportedFeatures.push_back("missingSample:" + track.sampleId);
        }
    }
    std::sort(result.unsupportedFeatures.begin(), result.unsupportedFeatures.end());
    result.unsupportedFeatures.erase(
        std::unique(result.unsupportedFeatures.begin(), result.unsupportedFeatures.end()),
        result.unsupportedFeatures.end());

    const double sampleRate = sampleRate_.load(std::memory_order_acquire);
    if (sampleRate <= 0.0 || snapshot.bpm <= 0.0 || frameCount == 0) {
        return result;
    }

    RenderWorld world;
    world.generation = result.worldGeneration;
    world.sequencerState = snapshot;
    world.unsupportedFeatures = result.unsupportedFeatures;
    for (const auto& track : snapshot.tracks) {
        const auto sample = controlSamples_.find(track.sampleId);
        if (sample != controlSamples_.end() && sample->second
            && world.samples.find(track.sampleId) == world.samples.end()) {
            world.sampleBytes += (sample->second->left.size() + sample->second->right.size()) * sizeof(float);
            world.samples.emplace(track.sampleId, sample->second);
        }
    }
    result.worldSampleBytes = world.sampleBytes;
    NativeRenderState renderState;
    const std::uint64_t chunkSize = std::max<std::uint64_t>(1, chunkSizeFrames);
    for (std::uint64_t chunkStart = 0; chunkStart < frameCount; chunkStart += chunkSize) {
        const auto frames = static_cast<std::uint32_t>(std::min<std::uint64_t>(
            chunkSize, frameCount - chunkStart));
        renderSequencerFrames(world,
                              renderState,
                              result.left.data() + chunkStart,
                              result.right.data() + chunkStart,
                              nullptr,
                              nullptr,
                              nullptr,
                              nullptr,
                              frames);
    }
    result.triggerEvents.assign(renderState.triggerEvents.begin(),
                                renderState.triggerEvents.begin() + renderState.triggerEventCount);
    result.triggerOverflowCount = renderState.triggerOverflowCount;
    result.droppedVoiceCount = renderState.droppedVoiceCount;
    result.stolenVoiceCount = renderState.stolenVoiceCount;
    result.peakVoiceCount = renderState.peakVoiceCount;
    result.renderDurationNanoseconds = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - startTime).count());
    return result;
}

OfflineRenderResult NativeAudioEngineCore::renderPublishedWorld(std::uint64_t frameCount,
                                                                 std::uint32_t chunkSizeFrames) {
    const auto startTime = std::chrono::steady_clock::now();
    OfflineRenderResult result;
    result.left.assign(frameCount, 0.0f);
    result.right.assign(frameCount, 0.0f);
    consumePublishedWorld();
    for (auto& rs : callbackRenderState_) { rs = {}; }
    if (renderWorld_ == nullptr || frameCount == 0) {
        return result;
    }

    result.unsupportedFeatures = renderWorld_->unsupportedFeatures;
    result.worldGeneration = renderWorld_->generation;
    result.worldSampleBytes = renderWorld_->sampleBytes;
    const std::uint32_t configuredFrames = bufferSizeFrames_.load(std::memory_order_acquire);
    if (configuredFrames == 0) {
        return result;
    }
    const std::uint32_t chunkSize = std::max<std::uint32_t>(
        1, std::min(chunkSizeFrames, configuredFrames));
    std::fill(inputLeft_.begin(), inputLeft_.end(), 0.0f);
    std::fill(inputRight_.begin(), inputRight_.end(), 0.0f);
    std::array<float*, laneCount> outputPointers {};
    for (std::size_t lane = 0; lane < laneCount; ++lane) {
        outputPointers[lane] = outputStorage_[lane].data();
    }

    const bool wasRunning = running_.exchange(true, std::memory_order_acq_rel);
    for (std::uint64_t chunkStart = 0; chunkStart < frameCount; chunkStart += chunkSize) {
        const auto frames = static_cast<std::uint32_t>(std::min<std::uint64_t>(
            chunkSize, frameCount - chunkStart));
        for (auto& lane : outputStorage_) {
            std::fill_n(lane.begin(), frames, 0.0f);
        }
        render(inputLeft_.data(), inputRight_.data(), outputPointers, frames);
        std::copy_n(outputStorage_[laneIndex(AudioLane::mainLeft)].begin(),
                    frames,
                    result.left.begin() + chunkStart);
        std::copy_n(outputStorage_[laneIndex(AudioLane::mainRight)].begin(),
                    frames,
                    result.right.begin() + chunkStart);
    }
    running_.store(wasRunning, std::memory_order_release);
    const auto& rs0 = callbackRenderState_[0];
    result.triggerEvents.assign(rs0.triggerEvents.begin(),
                                rs0.triggerEvents.begin() + rs0.triggerEventCount);
    result.triggerOverflowCount = rs0.triggerOverflowCount;
    result.droppedVoiceCount = rs0.droppedVoiceCount;
    result.stolenVoiceCount = rs0.stolenVoiceCount;
    result.peakVoiceCount = rs0.peakVoiceCount;
    result.renderDurationNanoseconds = static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now() - startTime).count());
    return result;
}

void NativeAudioEngineCore::renderSequencerFrames(const RenderWorld& world,
                                                  NativeRenderState& state,
                                                  float* left,
                                                  float* right,
                                                  float* send1,
                                                  float* send2,
                                                  float* send3,
                                                  float* send4,
                                                  std::uint32_t frameCount,
                                                  const NativeSequencerSnapshot* snapshotOverride,
                                                  int instrumentDeck,
                                                  bool allowLiveOverrides) const noexcept {
    const auto& snapshot = snapshotOverride != nullptr ? *snapshotOverride : world.sequencerState;
    // Live per-track control overrides only apply in the realtime callback path (not offline render).
    // Single per-block gate: if the global control epoch is no newer than the epoch stamped onto this
    // world, then no fader has moved since it was published — so skip ALL per-voice override checks
    // (zero added cost in the common, no-fader-moving case). When a fader is being swept the global
    // epoch outruns the (coalesced) world stamp and the per-voice path engages. See LiveTrackControl.
    const std::uint64_t liveOverrideWorldEpoch = world.liveControlEpochAtPublish;
    const bool liveOverridesActive = allowLiveOverrides
        && instrumentDeck >= 0 && instrumentDeck < static_cast<int>(kMaxDecks)
        && liveControlEpoch_.load(std::memory_order_acquire) > liveOverrideWorldEpoch;
    const double sampleRate = sampleRate_.load(std::memory_order_relaxed);
    if (left == nullptr || right == nullptr || sampleRate <= 0.0 || snapshot.bpm <= 0.0) {
        return;
    }

    // Phase 9: masterSpeed scales the effective BPM
    const double effectiveBpm = snapshot.bpm * std::max(0.1, snapshot.masterSpeed);
    const auto targetFramesPerStep = static_cast<std::uint64_t>(std::max(
        1102.0, std::floor(sampleRate * 60.0 / (effectiveBpm * 4.0))));
    if (state.currentFramesPerStep == 0) {
        // Seed with the ACTUAL session tempo, not a hard-coded 120 BPM placeholder: the first
        // step (and any cell triggered on it) is timed against currentFramesPerStep, and an
        // extended-cell cap computed at the wrong tempo runs the voice dry partway through the
        // first cell on every fresh playback (it only corrected from step 2 once the real value
        // was latched at the step boundary below).
        state.currentFramesPerStep = targetFramesPerStep;
        state.masterStep = snapshot.startStep;
        state.patternAnchorStep = 0;   // fresh transport: musical == startStep, like before anchors
        state.pendingAnchorStep = -1;
        state.prevResolvedStep.fill(-1);
        state.locatorEngaged.fill(0);
        state.locatorWasActive.fill(0);
        state.switchResumePending.fill(0);
        state.clearRateMorph();
    }
    // Turntable restart: currentFramesPerStep normally re-latches only at step boundaries,
    // which is right for musical tempo moves but deadlocks the tape-stop band — at micro-BPM
    // (TP varispeed → ~0) one step lasts hours, so raising the tempo again would never take
    // effect. When the tempo has risen drastically mid-step (>4×), re-latch immediately and
    // rescale stepFrame so the musical phase within the step is preserved. The 4× guard keeps
    // ordinary beatmatch moves (nudge/sync, small ratios) on the boundary-latch behaviour.
    if (state.currentFramesPerStep > targetFramesPerStep * 4) {
        const double phase = static_cast<double>(state.stepFrame)
                           / static_cast<double>(state.currentFramesPerStep);
        state.currentFramesPerStep = targetFramesPerStep;
        state.stepFrame = static_cast<std::uint64_t>(
            phase * static_cast<double>(targetFramesPerStep));
    }
    // Live sub-1 grain-window refresh: fine (<~12ms) beat-repeat windows are baked into the voice
    // at spawn, so a subdivision zoom or sub-cell shift would otherwise only be heard at the next
    // step-boundary re-trigger. Re-derive each ringing grain voice's window from the CURRENT
    // snapshot (via the spawn-time anchors) once per block; voices whose window is unchanged are
    // left untouched (in particular their stretch feed cursor — resetting it every block would
    // stutter the feed). Roll-mode (coarse) responds at sub-tick rate and needs none of this.
    // Audio-thread-only, no allocations.
    if (snapshot.isBeatRepeatActive && snapshot.beatRepeatSubdivision > 1
        && snapshot.beatRepeatLength <= 1 && state.currentFramesPerStep > 0) {
        const std::uint64_t refreshSubFrames = std::max<std::uint64_t>(8,
            state.currentFramesPerStep
                / static_cast<std::uint64_t>(snapshot.beatRepeatSubdivision));
        if (refreshSubFrames < static_cast<std::uint64_t>(sampleRate * 0.012)) {
            const std::size_t sub = std::max<std::size_t>(1, snapshot.beatRepeatSubdivision);
            const std::size_t k   = std::min<std::size_t>(snapshot.beatRepeatStartSubcell, sub - 1);
            for (auto& v : state.voices) {
                if (!v.active || v.stopping || !v.grainWindowEnabled) continue;
                if (v.grainStepSrcLen <= 0.0) continue;
                const double subSrcLen = v.grainStepSrcLen / static_cast<double>(sub);
                const double windowPos = v.grainBasePos + static_cast<double>(k) * subSrcLen;
                const std::size_t srcEnd = v.endFrame;
                if (windowPos >= static_cast<double>(srcEnd)) {
                    // Shifted onto the slice's silent tail (true-timeline semantics) → fade out.
                    v.stopping = true;
                    v.fadeFramesRemaining = 1;
                    continue;
                }
                std::size_t gStart = static_cast<std::size_t>(std::llround(windowPos));
                std::size_t gLen   = std::max<std::size_t>(2,
                    static_cast<std::size_t>(std::llround(subSrcLen)));
                if (gStart >= srcEnd && srcEnd > 2) gStart = srcEnd - 2;
                if (srcEnd > gStart) gLen = std::min(gLen, srcEnd - gStart);
                gLen = std::max<std::size_t>(2, gLen);
                if (gStart == v.grainWindowStart && gLen == v.grainWindowLen) continue;
                // Preserve the intra-cycle phase across the move so the buzz doesn't hiccup.
                double phase = v.position - static_cast<double>(v.grainWindowStart);
                if (v.grainWindowLen > 1)
                    phase = std::fmod(phase, static_cast<double>(v.grainWindowLen));
                if (!(phase >= 0.0)) phase = 0.0;
                phase = std::min(phase, static_cast<double>(gLen - 1));
                v.loopStartFrame   = gStart;
                v.loopEndFrame     = gStart + gLen;
                v.grainWindowStart = gStart;
                v.grainWindowLen   = gLen;
                v.grainWrapped     = true;   // a moved window is mid-content: taper both edges
                v.position         = static_cast<double>(gStart) + phase;
                if (v.useRubberBand) {
                    v.rbInputConsumed = static_cast<std::size_t>(v.position);
                    v.rbSourcePos     = v.position;
                }
            }
        }
    }
    if (!snapshot.isPlaying) {
        // Reset step position so the next play() starts from startStep cleanly.
        state.masterStep = snapshot.startStep;
        state.patternAnchorStep = 0;   // musical == startStep on the next play
        state.pendingAnchorStep = -1;
        state.stepFrame = 0;
        state.currentFramesPerStep = 0;
        state.prevResolvedStep.fill(-1);
        state.locatorEngaged.fill(0);
        state.locatorWasActive.fill(0);
        state.switchResumePending.fill(0);
        // Stop kills any in-flight scene glide / pending cut / pre-boundary freeze / rate morph.
        state.preBoundaryFreezeUntilStep = -1;
        state.sceneGlideFramesRemaining = 0;
        state.sceneCutAtStep = -1;
        state.clearRateMorph();
    }

    // Rate morph (multiply glide): detect per-track multiply-detent changes by VALUE DIFF of
    // consecutive consumed snapshots — never command tags, which the DJ coordinator can drop;
    // the latest value always arrives and still diffs. An eligible change starts a velocity
    // glide (the per-frame machinery in the trigger loop below) instead of the instant
    // stateless switch; every other change — including all of them when rateMorphFrames == 0 —
    // just re-latches, leaving the instant path bit-identical to the pre-morph engine.
    {
        const std::size_t morphTrackCount = std::min(snapshot.tracks.size(), kMaxGrainTracks);
        if (!state.morphPrevSeeded) {
            for (std::size_t ti = 0; ti < morphTrackCount; ++ti)
                state.morphPrevMult[ti] =
                    std::clamp(snapshot.tracks[ti].patternSpeedMultiplier, 0.001, 16.0);
            state.morphPhase.fill(0);
            state.morphPrevSeeded = true;
        } else for (std::size_t ti = 0; ti < morphTrackCount; ++ti) {
            const auto& mt = snapshot.tracks[ti];
            const double cur = std::clamp(mt.patternSpeedMultiplier, 0.001, 16.0);
            if (cur != state.morphPrevMult[ti]) {
                const bool eligible = snapshot.rateMorphFrames > 0 && snapshot.isPlaying
                    && mt.tpMorphEligible && !mt.useTimeStretch && mt.playbackMode == 0
                    && mt.trackType == 0 && !mt.grainEnabled && !mt.muted && !mt.steps.empty();
                if (eligible) {
                    // Mid-morph retarget restarts the ramp from the INSTANTANEOUS value, so a
                    // second detent drag mid-glide bends onward with no discontinuity.
                    const double m1 = state.morphPhase[ti] != 0 ? state.morphM[ti]
                                                                : state.morphPrevMult[ti];
                    const auto total = std::max<std::uint32_t>(1, snapshot.rateMorphFrames);
                    state.morphM[ti]      = m1;
                    state.morphM2[ti]     = cur;
                    // Exponential ramp — linear in semitones, so the T+P pitch bend is
                    // turntable-honest rather than sagging through the multiplier midpoint.
                    state.morphFactor[ti] = std::pow(cur / m1, 1.0 / static_cast<double>(total));
                    state.morphFramesLeft[ti]     = total;
                    state.morphHoldFramesLeft[ti] = 0;
                    if (state.morphPhase[ti] == 0) {
                        // Entering from the locked path: the free cursor is STALE (never reset)
                        // — it must be seeded to the canonical position on first use. A
                        // genuinely free track's cursor is live; seeding would jump the tape.
                        const bool freeCursorLive = mt.freeRateEnabled
                            || mt.lfo1FreeRateDepth != 0.0f || mt.lfo2FreeRateDepth != 0.0f
                            || mt.lfo3FreeRateDepth != 0.0f || mt.lfo4FreeRateDepth != 0.0f;
                        state.morphSeedPending[ti] = freeCursorLive ? 0 : 1;
                    }
                    state.morphPhase[ti] = 1;
                } else {
                    state.morphPhase[ti] = 0;   // ineligible change: instant, today's path
                }
                state.morphPrevMult[ti] = cur;
            } else if (state.morphPhase[ti] != 0 && mt.muted) {
                state.morphPhase[ti] = 0;   // trigger-muted mid-morph: nothing sounds — cancel
            }
        }
    }

    // Phase 11: pre-render pass — feed input to all active RB stretchers so that
    // `available() >= frameCount` before we enter the per-frame drain loop below.
    // Uses stack-allocated batches of 256 frames; no heap allocation.
    for (auto& voice : state.voices) {
        if (!voice.active || !voice.useRubberBand || voice.rubberBandSlot < 0
            || voice.preSilenceFramesRemaining > 0) continue;
        auto* rb = voiceStretchPool_.get(voice.rubberBandSlot);
        if (!rb) continue;

        // Phase E: once per callback, apply LFO pitch modulation and glide to the RB pitch scale.
        // Uses end-of-buffer LFO phases — same one-per-buffer approximation as the return-track LFO.
        {
            // Advance glide ramp by frameCount frames (capped at total).
            double effectivePitchScale = voice.rbBasePitchScale;
            bool rbCellPitchStreamed = false;
            if (voice.cellLengthSteps > 1 && state.currentFramesPerStep > 0
                && voice.trackIndex < snapshot.tracks.size()
                && !snapshot.tracks[voice.trackIndex].pitchOffsets.empty()) {
                // Reg-mode extension-step pitch streaming (melodic): drive the transpose from the
                // CURRENT sub-step's melodic pitch (with within-cell glide) for multi-step cells,
                // so each extension step's individual pitch is heard (matches the varispeed path).
                // Reads the LIVE snapshot's globalPitchOffset, so it already follows pitch moves —
                // the live-pitch-base bend below must not stack on top.
                const double semi = cellStreamSemitone(snapshot.tracks[voice.trackIndex],
                    voice.cellOriginStep, voice.cellLengthSteps,
                    voice.cellElapsedFrames, state.currentFramesPerStep,
                    voice.chordIntervalSemitones);
                effectivePitchScale = std::pow(2.0, semi / 12.0);
                voice.cellElapsedFrames += frameCount;   // advance pattern time per callback (RB path)
                rbCellPitchStreamed = true;
            } else if (voice.rbGlideTotalFrames > 0) {
                const std::uint32_t advance = std::min<std::uint32_t>(frameCount, voice.rbGlideFramesRemaining);
                if (advance > 0) voice.rbGlideFramesRemaining -= advance;
                const double t = 1.0 - static_cast<double>(voice.rbGlideFramesRemaining)
                                     / static_cast<double>(voice.rbGlideTotalFrames);
                effectivePitchScale = voice.rbGlideSourcePitchScale
                    + t * (voice.rbGlideTargetPitchScale - voice.rbGlideSourcePitchScale);
            }
            // LFO pitch mod in semitones → multiply into pitch scale.
            if (voice.hasLfoModulation) {
                const double lfo1v = lfoWaveValue(state.lfo1Phase,
                    snapshot.lfo1Waveform, snapshot.lfo1Symmetry, state.randVal1)
                    * snapshot.modChannels[0].depth;   // per-channel master depth
                const double lfo2v = lfoWaveValue(state.lfo2Phase,
                    snapshot.lfo2Waveform, snapshot.lfo2Symmetry, state.randVal2)
                    * snapshot.modChannels[1].depth;
                const double pitchMod = voice.lfo1PitchDepth * lfo1v + voice.lfo2PitchDepth * lfo2v;
                if (pitchMod != 0.0) {
                    effectivePitchScale *= std::pow(2.0, pitchMod / 12.0);
                }
            }
            // Live pitch base: bend the ringing RB voice by the ramped delta between the
            // track's current global pitch and the value baked at trigger (UI units are
            // half-semitones, hence /2). trackBaseCurrent holds last block's settled value
            // here (this pass runs before the ramp update) — one callback of lag, inaudible.
            if (!rbCellPitchStreamed && voice.trackIndex < kMaxEnvelopeTracks) {
                const float livePitch = state.trackBaseCurrent[voice.trackIndex][kRampChanPitch];
                if (livePitch != voice.bakedPitchBase) {
                    effectivePitchScale *= std::pow(2.0,
                        (static_cast<double>(livePitch - voice.bakedPitchBase) / 2.0) / 12.0);
                }
            }
            effectivePitchScale = std::max(0.01, effectivePitchScale);
            // Route through the pool so the key-lock tonality limit rides along.
            voiceStretchPool_.setTranspose(voice.rubberBandSlot, effectivePitchScale);
        }

        const auto& rbSample = *voice.sample;
        const bool   rbRev   = voice.reversed;
        const std::size_t rbEnd   = voice.endFrame;
        const std::size_t rbStart = voice.startFrame;

        // Phase 5b fixed-output: read source in fixed batches and produce
        // outN = round(inN * timeRatio) output frames into the slot's ring (timeRatio =
        // output/input duration, matching RubberBand's setTimeRatio convention). Pitch comes
        // from the transpose factor set above. timeRatio == 1 → melodic-pitch-only (1:1 time).
        // batchSize 256 with ratio ≤ 2 keeps outN ≤ 512 (within the slot proc/ring buffers),
        // so the UPPER bound must stay at 2.0 (≤2x slow-down). The lower bound can safely go
        // below 0.5 (smaller outN, no buffer growth); 0.25 allows up to a 4x speed-up so a 4x
        // multiplier (timeRatio = 1/4) is honoured rather than capped at 2x.
        const int ssSlot = voice.rubberBandSlot;
        const double tsRatio = std::clamp(voice.rbTimeRatio, 0.25, 2.0);
        // Produce enough output to cover this callback PLUS the startup latency, which is
        // burst-discarded below so the first audible frame lands ON the trigger tick (the
        // old one-frame-per-tick skip started every stretched voice ~latency late: ~10 ms
        // on the standard bank, ~40 ms on the HQ bank).
        const int fillTarget = static_cast<int>(frameCount)
            + static_cast<int>(voice.rbLatencySkipRemaining);
        // Phase A: deck varispeed (TP) — when active — is applied here as a CLEAN resample of the
        // source FEED (stride = varispeedRate), so the per-voice stretcher only does melodic
        // transpose / per-track time-stretch (TP layered on top, independent). varispeedRate == 1.0
        // (non-TP) keeps the original integer 1:1 feed below byte-for-byte.
        // Rate morph: a morphing T+P track's melodic (RB) voices carry the multiplier in the
        // feed stride — scale it by the instantaneous ratio so their pitch glides with the
        // varispeed voices. Block granularity (like setTranspose above) — inaudible stair-step.
        double vsrBase = voice.varispeedRate;
        if (voice.trackIndex < kMaxGrainTracks
            && state.morphPhase[voice.trackIndex] != 0 && voice.bakedPatternMult > 0.0) {
            vsrBase *= state.morphM[voice.trackIndex] / voice.bakedPatternMult;
        }
        const double vsr = std::max(0.0001, vsrBase);
        // Sample-mode consolidation: loop-window wrap for stretched (melodic / time-stretch) voices.
        // The non-RB path wraps voice.position (line ~3653); the stretcher feeds the source itself,
        // so it must wrap rbInputConsumed / rbSourcePos here instead of finalizing at the window end —
        // otherwise REG+loop (and OWN+loop) with melodic pitch active just played through once and
        // stopped. Only forward windows loop (loopWrapEnabled is set only when !reversed).
        const bool rbLoop = voice.loopWrapEnabled && !rbRev
            && voice.loopEndFrame > voice.loopStartFrame + 1;
        const std::size_t feedEnd = rbLoop ? voice.loopEndFrame : rbEnd;
        if (vsr == 1.0) {
            while (!voice.rbFinalized &&
                   voiceStretchPool_.ringCount(ssSlot) < fillTarget) {
                constexpr int batchSize = 256;
                const std::size_t remaining = feedEnd > voice.rbInputConsumed
                    ? feedEnd - voice.rbInputConsumed : 0;
                const int tofeed = static_cast<int>(std::min<std::size_t>(batchSize, remaining));
                const int n = (tofeed > 0) ? tofeed : batchSize;  // silent block flushes the tail
                float inL[batchSize], inR[batchSize];
                for (int i = 0; i < n; ++i) {
                    if (tofeed == 0) { inL[i] = inR[i] = 0.0f; continue; }
                    std::size_t pos;
                    if (rbRev) {
                        const std::size_t consumed = voice.rbInputConsumed - rbStart + static_cast<std::size_t>(i);
                        pos = (rbEnd > consumed) ? rbEnd - 1 - consumed : rbStart;
                    } else {
                        pos = voice.rbInputConsumed + static_cast<std::size_t>(i);
                    }
                    if (pos < rbSample.left.size()) {
                        inL[i] = rbSample.left[pos];
                        inR[i] = rbSample.right.size() > pos ? rbSample.right[pos] : rbSample.left[pos];
                    } else {
                        inL[i] = inR[i] = 0.0f;
                    }
                }
                const float* ch[2] = { inL, inR };
                const int outN = std::max(1, static_cast<int>(std::lround(n * tsRatio)));
                voiceStretchPool_.produceIntoRing(ssSlot, ch, n, outN);
                if (tofeed == 0) {
                    // Source exhausted: keep flushing silence until the stretcher's whole
                    // pipeline (≈ 2× its startup latency of input) has been pushed out, so
                    // note tails aren't left stuck inside — matters for the HQ bank, whose
                    // pipeline is deeper than one flush batch.
                    const int flushTotal =
                        static_cast<int>(voiceStretchPool_.latencyFrames(ssSlot)) * 2;
                    for (int flushed = n; flushed < flushTotal; flushed += batchSize) {
                        voiceStretchPool_.produceIntoRing(ssSlot, ch, batchSize,
                            std::max(1, static_cast<int>(std::lround(batchSize * tsRatio))));
                    }
                    voice.rbFinalized = true;
                    break;
                }
                voice.rbInputConsumed += static_cast<std::size_t>(tofeed);
                if (voice.rbInputConsumed >= feedEnd) {
                    // Loop: wrap the source feed back to the window start and keep going (the voice
                    // is retired by the next trigger's self-cut or the owner gate/attack release).
                    // One-shot: finalize. The while loop still terminates because each iteration
                    // produces outN >= 1 frames into the ring until ringCount >= frameCount.
                    if (rbLoop) { voice.rbInputConsumed = voice.loopStartFrame; voice.grainWrapped = true; }
                    else        { voice.rbFinalized = true; break; }
                }
            }
        } else {
            // Varispeed-resampled feed (TP): fractional source cursor (voice.rbSourcePos) advanced
            // by ±vsr per fed sample, read through the anti-aliased sinc reader (which band-limits
            // on pitch-up). The stretcher still applies melodic transpose / per-track stretch only.
            while (!voice.rbFinalized &&
                   voiceStretchPool_.ringCount(ssSlot) < fillTarget) {
                constexpr int batchSize = 256;
                float inL[batchSize], inR[batchSize];
                int  n = 0;
                bool sourceExhausted = false;
                const bool haveRight = rbSample.right.size() > rbStart;
                for (int i = 0; i < batchSize; ++i) {
                    const double pos = rbRev
                        ? voice.rbSourcePos - static_cast<double>(i) * vsr
                        : voice.rbSourcePos + static_cast<double>(i) * vsr;
                    if (rbRev) {
                        if (pos < static_cast<double>(rbStart)) { sourceExhausted = true; break; }
                    } else {
                        // feedEnd == rbEnd when not looping (no behaviour change for one-shots).
                        if (pos >= static_cast<double>(feedEnd)) { sourceExhausted = true; break; }
                    }
                    inL[i] = sincResampler_.read(rbSample.left, pos, rbStart, rbEnd, vsr);
                    inR[i] = haveRight
                        ? sincResampler_.read(rbSample.right, pos, rbStart, rbEnd, vsr)
                        : inL[i];
                    ++n;
                }
                if (n == 0 && rbLoop) {
                    // Cursor sat exactly at the loop end — wrap to the window start and keep feeding.
                    // The next iteration reads from loopStart (< feedEnd) and produces output, so the
                    // while loop still makes progress and terminates once the ring is filled.
                    voice.rbSourcePos = static_cast<double>(voice.loopStartFrame);
                    voice.grainWrapped = true;
                    continue;
                }
                if (n == 0) {
                    // Source exhausted — flush the stretcher's whole pipeline with silence
                    // (≈ 2× its startup latency of input) so the tail fully drains, then finalize.
                    for (int i = 0; i < batchSize; ++i) inL[i] = inR[i] = 0.0f;
                    const float* ch[2] = { inL, inR };
                    const int outN = std::max(1, static_cast<int>(std::lround(batchSize * tsRatio)));
                    const int flushTotal =
                        static_cast<int>(voiceStretchPool_.latencyFrames(ssSlot)) * 2;
                    for (int flushed = 0; flushed < flushTotal; flushed += batchSize)
                        voiceStretchPool_.produceIntoRing(ssSlot, ch, batchSize, outN);
                    voice.rbFinalized = true;
                    voice.rbInputConsumed = rbEnd;
                    break;
                }
                const float* ch[2] = { inL, inR };
                const int outN = std::max(1, static_cast<int>(std::lround(n * tsRatio)));
                voiceStretchPool_.produceIntoRing(ssSlot, ch, n, outN);
                const double advance = static_cast<double>(n) * vsr;
                voice.rbSourcePos += rbRev ? -advance : advance;
                if (rbLoop && voice.rbSourcePos >= static_cast<double>(feedEnd)) {
                    // Wrap the fractional cursor back into the loop window (keep the overshoot).
                    const double span = static_cast<double>(feedEnd - voice.loopStartFrame);
                    voice.rbSourcePos = static_cast<double>(voice.loopStartFrame)
                        + std::fmod(voice.rbSourcePos - static_cast<double>(feedEnd), span);
                    voice.grainWrapped = true;
                }
                // Keep rbInputConsumed tracking progress (= rbStart + framesConsumed) for the
                // downstream end-of-sample check; both directions count up to rbEnd.
                const double framesConsumed = rbRev
                    ? (static_cast<double>(rbEnd > 0 ? rbEnd - 1 : 0) - voice.rbSourcePos)
                    : (voice.rbSourcePos - static_cast<double>(rbStart));
                voice.rbInputConsumed = rbStart + static_cast<std::size_t>(std::max(0.0, framesConsumed));
                // One-shot: source exhausted → finalize. Looping voices already wrapped above and
                // must keep running (retired by the next trigger / owner gate, not here).
                if (sourceExhausted && !rbLoop) { voice.rbFinalized = true; voice.rbInputConsumed = rbEnd; break; }
            }
        }
        // Burst-discard the startup latency in this pre-render pass (rather than one frame
        // per output tick) so the voice's first audible frame lands ON the trigger tick.
        // The drain's per-tick skip branch remains only as a safety net for the rare case
        // where the ring couldn't reach fillTarget (e.g. capacity-clipped flush).
        if (voice.rbLatencySkipRemaining > 0) {
            float dl = 0.0f, dr = 0.0f;
            while (voice.rbLatencySkipRemaining > 0
                   && voiceStretchPool_.popFrame(ssSlot, dl, dr)) {
                --voice.rbLatencySkipRemaining;
            }
            // Finalized with less output than the skip (ultra-short slice fully consumed by
            // the latency window): nothing meaningful left — stop waiting for it.
            if (voice.rbFinalized) voice.rbLatencySkipRemaining = 0;
        }
        voice.rbOutputAvailable = static_cast<std::size_t>(voiceStretchPool_.ringCount(ssSlot));
    }

    // Envelope-follower detector smoothing coefficients (attack 0.5 ms, release 25 ms) —
    // matches SequencerNode's envelopeAttackTime/envelopeReleaseTime. coeff = 1 - exp(-1/(t·fs)).
    const float envDetectAttackCoeff  = 1.0f - std::exp(-1.0f / static_cast<float>(0.0005 * sampleRate));
    const float envDetectReleaseCoeff = 1.0f - std::exp(-1.0f / static_cast<float>(0.025  * sampleRate));
    // Per-LFO envelope-follower flags + volume-depth scaling (AVFoundation scales the volume/gain
    // depth ×2 for envelope followers and widens the modulation clamp from 2.0 to 3.0).
    const bool  lfo1IsEnv   = snapshot.lfo1Waveform == NativeLfoWaveform::envelopeFollower;
    const bool  lfo2IsEnv   = snapshot.lfo2Waveform == NativeLfoWaveform::envelopeFollower;
    const float envVolScale1 = lfo1IsEnv ? 2.0f : 1.0f;
    const float envVolScale2 = lfo2IsEnv ? 2.0f : 1.0f;
    const float volModMax    = (lfo1IsEnv || lfo2IsEnv) ? 3.0f : 2.0f;

    // Global per-send fader tap (pre/post). Loaded once per block; pre-fader divides the
    // per-voice volume fader back out of the send tap (see the voice mix below).
    const bool send1PostFader = sendPostFader_[0].load(std::memory_order_acquire);
    const bool send2PostFader = sendPostFader_[1].load(std::memory_order_acquire);
    const bool send3PostFader = sendPostFader_[2].load(std::memory_order_acquire);
    const bool send4PostFader = sendPostFader_[3].load(std::memory_order_acquire);

#if SCOOPY_PLUGIN_HOST
    // Per-track instrument MIDI generation. The audible core renders every deck through the DJ world
    // path, so the caller passes the deck index this render owns (`instrumentDeck` ≥ 0) and we key
    // instrument slots by (deck, track). −1 = don't generate (offline render). Gated by the flag.
    const bool generateInstrumentMidi =
        instrumentDeck >= 0 && instrumentHostingEnabled_.load(std::memory_order_acquire);
#endif

    // Audio-rate grain (pulsar) mode: per-block fast-path flag so non-grain sessions pay nothing.
    bool anyGrainTracks = false;
    for (const auto& t : snapshot.tracks) { if (t.grainEnabled) { anyGrainTracks = true; break; } }

    // Per-track output routing (external mixing): while the per-device toggle is on, tracks with
    // outputAssign 1/2 are mono-summed hard onto that side of their deck pair, ignoring pan.
    // Realtime only — offline bounce (instrumentDeck < 0) always renders normal pan.
    const bool routingOn =
        perTrackRoutingActive_.load(std::memory_order_relaxed) && instrumentDeck >= 0;

    // ===== Live track-base ramp (per-track slider bases: 4 sends + volume, pan, tone) =====
    // Target read once per block: the epoch-gated live override while a fader is moving, else the
    // snapshot value. state.trackBaseCurrent glides toward the target over kTrackBaseRampSeconds
    // so a fader flick lands click-free, and — because the target follows the snapshot after the
    // coalesced republish — ringing voices keep tracking the fader permanently (the old per-frame
    // override fell back to the voice's trigger-baked value once the epoch gate closed). Voices
    // add their trigger-baked per-step offsets on top, so per-step automation stays a hard
    // per-hit jump. Steady state (no fader moving, ramps settled) contributes zero per-frame work.
    constexpr float kTrackBaseRampSeconds = 0.004f;
    // Snap-to-target epsilon per channel (tone spans ±100, Q 0.5…18, pitch ±24, everything else
    // ~0…2). ⚠️ POSITIONAL — the order must track the kRampChan* constants exactly:
    //   send1..4, volume, pan, tone, assign1, assign2, pitch, Q, drive, muteGain
    constexpr float kRampSnapEps[kTrackRampChannels] =
        { 1.0e-4f, 1.0e-4f, 1.0e-4f, 1.0e-4f, 1.0e-4f, 1.0e-4f, 1.0e-2f, 1.0e-4f, 1.0e-4f,
          1.0e-3f, 1.0e-3f, 1.0e-2f, 1.0e-4f };
    struct TrackBaseRamp {
        std::uint16_t track;
        std::uint8_t channel;
        bool snapAtEnd;             // this block completes the ramp → land exactly on target
        float inc;
        float target;
        std::uint32_t frames;
    };
    std::array<TrackBaseRamp, kMaxEnvelopeTracks * kTrackRampChannels> baseRamps;
    std::size_t baseRampCount = 0;
    {
        const auto rampTotalFrames = std::max<std::uint32_t>(
            1u, static_cast<std::uint32_t>(kTrackBaseRampSeconds * sampleRate));
        const std::size_t rampTrackCount =
            std::min<std::size_t>(snapshot.tracks.size(), kMaxEnvelopeTracks);
        const bool deckValid = instrumentDeck >= 0 && instrumentDeck < static_cast<int>(kMaxDecks);
        for (std::size_t t = 0; t < rampTrackCount; ++t) {
            const auto& tk = snapshot.tracks[t];
            // Output-routing placement weights: 1 on the assigned side while routing is active,
            // else 0. Riding the ramp declicks toggle flips and 1↔2 reassignments (~4 ms).
            const float a1T = (routingOn && tk.outputAssign == 1) ? 1.0f : 0.0f;
            const float a2T = (routingOn && tk.outputAssign == 2) ? 1.0f : 0.0f;
            const float snapBase[kTrackRampChannels] =
                { tk.send1Level, tk.send2Level, tk.send3Level, tk.send4Level,
                  tk.volume, tk.pan, tk.tone, a1T, a2T,
                  static_cast<float>(tk.globalPitchOffset), tk.toneQ, tk.filterDrive,
                  tk.mixMuted ? 0.0f : 1.0f };
            const LiveTrackControl* ctl = (liveOverridesActive && deckValid)
                ? &liveTrackControl_[static_cast<std::size_t>(instrumentDeck)][t] : nullptr;
            for (std::size_t n = 0; n < kTrackRampChannels; ++n) {
                float target = snapBase[n];
                bool liveOverridden = false;
                if (ctl != nullptr) {
                    if (n < kNumSends) {
                        if (ctl->sendEpoch[n].load(std::memory_order_acquire) > liveOverrideWorldEpoch) {
                            target = ctl->send[n].load(std::memory_order_acquire);
                            liveOverridden = true;
                        }
                    } else if (n == kRampChanVolume) {
                        if (ctl->volumeEpoch.load(std::memory_order_acquire) > liveOverrideWorldEpoch) {
                            target = ctl->volume.load(std::memory_order_acquire);
                            liveOverridden = true;
                        }
                    } else if (n == kRampChanPan) {
                        if (ctl->panEpoch.load(std::memory_order_acquire) > liveOverrideWorldEpoch) {
                            target = ctl->pan.load(std::memory_order_acquire);
                            liveOverridden = true;
                        }
                    } else if (n == kRampChanTone) {
                        if (ctl->toneEpoch.load(std::memory_order_acquire) > liveOverrideWorldEpoch) {
                            target = ctl->tone.load(std::memory_order_acquire);
                            liveOverridden = true;
                        }
                    } else if (n == kRampChanQ) {
                        if (ctl->qEpoch.load(std::memory_order_acquire) > liveOverrideWorldEpoch) {
                            target = ctl->q.load(std::memory_order_acquire);
                            liveOverridden = true;
                        }
                    }
                    // kRampChanAssign1/2 take no live override — always snapshot+flag derived.
                }
                float& cur = state.trackBaseCurrent[t][n];
                if (!state.trackBaseSeeded) { cur = target; continue; }
                const float diff = target - cur;
                if (diff == 0.0f) continue;
                if (std::fabs(diff) < kRampSnapEps[n]) { cur = target; continue; }
                // Scene glide: while a pattern-switch glide is in flight, the four settings lanes
                // stretch over the REMAINING glide frames instead of the 4 ms declick — a linear
                // audio-thread glide that self-corrects per block (diff/inc re-derive from the
                // current value each block, landing exactly when the counter runs out). A live
                // fader grab (open epoch override) wins back the 4 ms response for its lane; the
                // other lanes (sends, routing assigns, Q, drive) always keep the declick.
                std::uint32_t rampTotal = rampTotalFrames;
                if (state.sceneGlideFramesRemaining > 0 && !liveOverridden
                    && (n == kRampChanVolume || n == kRampChanPan
                        || n == kRampChanTone || n == kRampChanPitch)) {
                    rampTotal = std::max(state.sceneGlideFramesRemaining, rampTotalFrames);
                }
                baseRamps[baseRampCount++] = TrackBaseRamp{
                    static_cast<std::uint16_t>(t), static_cast<std::uint8_t>(n),
                    rampTotal <= frameCount,
                    diff / static_cast<float>(rampTotal),
                    target,
                    std::min(frameCount, rampTotal) };
            }
        }
        state.trackBaseSeeded = true;
        // Advance the scene-glide window by this block (deck-source-frame domain — under DJ
        // time-stretch the audible glide time scales with the stretch ratio; documented).
        if (state.sceneGlideFramesRemaining > 0) {
            state.sceneGlideFramesRemaining -=
                std::min(frameCount, state.sceneGlideFramesRemaining);
        }
    }

    for (std::uint32_t outputFrame = 0; outputFrame < frameCount; ++outputFrame) {
        // Deferred pattern-anchor move (sample-exact scene switch): applied HERE, above the
        // frame's step locals, so the crossing frame already resolves in the NEW scene's space
        // (musical step 0 → its step 0 triggers on this exact frame). The pending one-shot
        // riders were armed in the OLD musical space — rebase them by the same delta: both
        // become exactly 0, so the pre-boundary freeze clears and the clean cut fires on the
        // crossing frame, before this frame's triggers (today's ordering, exactly).
        if (state.pendingAnchorStep >= 0
            && static_cast<std::int64_t>(state.masterStep) >= state.pendingAnchorStep) {
            const std::int64_t delta = state.pendingAnchorStep - state.patternAnchorStep;
            if (state.preBoundaryFreezeUntilStep >= 0) state.preBoundaryFreezeUntilStep -= delta;
            if (state.sceneCutAtStep >= 0) state.sceneCutAtStep -= delta;
            state.patternAnchorStep = state.pendingAnchorStep;
            state.pendingAnchorStep = -1;
        }
        const std::uint64_t frame = state.framePosition;
        // The MUSICAL step (absolute clock − pattern anchor): every pattern-position/boundary
        // computation in this loop runs in this domain — 0 is the current cycle's start, and it
        // wraps to 0 when a scheduled scene switch moves the anchor. The absolute clock is
        // state.masterStep (used only for the transport advance and the humanize hash seeds).
        const std::uint64_t masterStep = static_cast<std::uint64_t>(std::max<std::int64_t>(
            0, static_cast<std::int64_t>(state.masterStep) - state.patternAnchorStep));
        const std::uint64_t stepFrame = state.stepFrame;

        // Advance active track-base ramps: one update per (track, channel) per frame, shared by
        // every voice of the track. Empty (the common case) whenever no fader is in motion.
        // Linear interpolation between two in-range values stays in range — no clamp needed.
        for (std::size_t ri = 0; ri < baseRampCount; ++ri) {
            auto& rp = baseRamps[ri];
            if (rp.frames == 0) continue;
            float& cur = state.trackBaseCurrent[rp.track][rp.channel];
            if (--rp.frames == 0 && rp.snapAtEnd) cur = rp.target;
            else cur += rp.inc;
        }
        // Quantized launch: while the transport is held (deck armed, awaiting the boundary) or in
        // its sub-block lead-in, suppress trigger evaluation so the deck stays silent until its
        // step-0 downbeat lands on the exact aligned frame. The transport advance below mirrors this.
        const bool launchGated = state.transportHeld || state.launchLeadInFrames > 0;

        // Pattern-scene switch freeze — two mirrored halves around the boundary frame:
        //  · OLD-world half (fallback install path): once deck A's playhead reaches a PARKED switch
        //    boundary, stop this (old) world from triggering. The boundary-install at the top of the
        //    NEXT render callback can only fire after masterStep has already advanced into the
        //    boundary step, so without this the old pattern would trigger the boundary step (its
        //    step 0) right before the swap and overlap the new pattern.
        //  · NEW-world half (sample-exact early install): the switch world is already installed but
        //    the boundary hasn't been crossed yet — suppress its triggers (incl. flam sub-hits and
        //    micro-BR sub-ticks, all inside this gated loop) until the exact crossing frame, where
        //    the gate clears and the new pattern's step 0 fires.
        // Deck 0 only; already sounding voices ring out naturally in both halves. (Read-only access
        // to audio-thread-owned park state.)
        if (state.preBoundaryFreezeUntilStep >= 0
            && static_cast<std::int64_t>(masterStep) >= state.preBoundaryFreezeUntilStep) {
            state.preBoundaryFreezeUntilStep = -1;
        }
        const bool switchFreezeGated =
            instrumentDeck == 0
            && ((parkedSwitchWorld_ != nullptr
                 && static_cast<std::int64_t>(masterStep) >= parkedBoundaryStep_)
                || state.preBoundaryFreezeUntilStep >= 0);

        // Scene clean-cut one-shot: at the boundary frame (before this frame's triggers are
        // evaluated below) fade every still-ringing voice over the choke fade, so the old scene
        // stops cleanly under the new downbeat and the boundary's fresh voices are never touched.
        // FX/send tails deliberately keep ringing. Voices already fading faster keep their fade.
        if (instrumentDeck == 0 && state.sceneCutAtStep >= 0
            && static_cast<std::int64_t>(masterStep) >= state.sceneCutAtStep) {
            for (auto& v : state.voices) {
                if (!v.active) continue;
                if (v.stopping && v.fadeFramesRemaining <= chokeFadeFrames) continue;
                v.stopping = true;
                v.fadeFramesRemaining = chokeFadeFrames;
            }
            state.sceneCutAtStep = -1;
        }

        // Micro-step beat repeat ("roll"): when subdivision > 1, re-fire the looped slice at evenly
        // spaced sub-step boundaries within the step (1/subdivision of a step apart), on top of the
        // normal step-boundary hit. Each sub-tick re-attacks the slice from its start — the existing
        // whole-step BR fold below already pins every track's step to beatRepeatStartStep at length 1,
        // so no fold change is needed; we only manufacture the extra trigger frames here. Frame-space,
        // deck-global, and track-independent, so it is computed once per output frame.
        bool brMicroHit = false;
        bool brMicroWindowed = false;
        std::uint64_t brSubFrames = 0;
        const bool brMicroActive = snapshot.isBeatRepeatActive
            && snapshot.beatRepeatSubdivision > 1
            && snapshot.beatRepeatLength <= 1
            && state.currentFramesPerStep > 0;
        if (brMicroActive) {
            // Resolution floor: never request sub-ticks closer than kMinBrSubFrames apart, so extreme
            // BPM × 1/32 cannot demand sub-frame retriggers (mirrors the flam per-frame-advance guard).
            constexpr std::uint64_t kMinBrSubFrames = 8;
            brSubFrames = std::max(kMinBrSubFrames,
                state.currentFramesPerStep / static_cast<std::uint64_t>(snapshot.beatRepeatSubdivision));
            // Hybrid by window size. Sub-1 is a TRUE fractional TIMELINE window — the k-th of
            // `subdivision` equal sub-cells of the STEP (output time), positioned by
            // beatRepeatStartSubcell — realized two ways:
            //  - Coarse (sub-cell ≥ ~12 ms): a hard re-trigger "roll" seeded at the sub-cell's source
            //    offset. Each sub-tick re-attacks (crisp transients) and the next sub-tick's self-cut
            //    ends the window at exactly the sub-cell duration. Sub-ticks read the live snapshot,
            //    so zoom/shift respond at sub-cell rate.
            //  - Fine (< ~12 ms): the re-trigger declick/attack ramp would eat the window, so one
            //    grain voice loops the sub-cell's source window under a Tukey seam envelope.
            const std::uint64_t grainThresholdFrames = static_cast<std::uint64_t>(
                sampleRate_.load(std::memory_order_relaxed) * 0.012);
            brMicroWindowed = brSubFrames < grainThresholdFrames;
            // stepFrame == 0 is the primary boundary (fired by the normal trigger path); the sub-ticks
            // are the interior multiples of brSubFrames (roll mode only).
            brMicroHit = !brMicroWindowed && stepFrame > 0 && (stepFrame % brSubFrames) == 0;
        }

        if (snapshot.isPlaying && !launchGated && !switchFreezeGated) for (std::size_t trackIndex = 0; trackIndex < snapshot.tracks.size(); ++trackIndex) {
            const auto& track = snapshot.tracks[trackIndex];
            // Per-track frame-exact launch gate (Clip-launch). Before the gate-open boundary, or at/after
            // a scheduled stop boundary, the track is silent (no trigger this frame). `patternMasterStep`
            // phase-anchors a launched track so step 0 lands on launchAnchorStep. Default anchors (-1)
            // leave the track on the global phase — no effect on normal playback, DJ sync, or scenes.
            //
            // Anticipatory launch (per-track pattern start point): launchGateStep < launchAnchorStep
            // opens the gate `lead = anchor - gate` steps EARLY. During the lead-in window the effective
            // step is negative relative to the anchor; we fold it forward by one pattern period so the
            // track reads its TAIL (steps stepCount-lead … stepCount-1) and arrives at step 0 exactly on
            // launchAnchorStep — grid-aligned with the other tracks. When launchGateStep is -1 the gate
            // falls back to launchAnchorStep and this is bit-identical to the previous behaviour.
            const std::int64_t launchGate =
                (track.launchGateStep >= 0) ? track.launchGateStep : track.launchAnchorStep;
            if (launchGate >= 0
                && static_cast<std::int64_t>(masterStep) < launchGate) {
                continue;   // gate-open boundary not reached yet → silent
            }
            if (track.launchStopStep >= 0
                && static_cast<std::int64_t>(masterStep) >= track.launchStopStep) {
                continue;   // scheduled stop boundary reached → silent (no trailing step)
            }
            std::uint64_t patternMasterStep;
            if (track.launchAnchorStep >= 0) {
                const std::size_t anchorStepCount = track.steps.size();
                std::int64_t delta = static_cast<std::int64_t>(masterStep) - track.launchAnchorStep;
                // Lead-in window (anticipatory launch only): fold the negative offset forward one period
                // so it reads the pattern tail. lead < stepCount, so a single period guarantees delta ≥ 0.
                if (delta < 0 && anchorStepCount > 0)
                    delta += static_cast<std::int64_t>(anchorStepCount);
                patternMasterStep = (delta < 0) ? 0 : static_cast<std::uint64_t>(delta);
            } else {
                patternMasterStep = masterStep;
            }
            // THE THREE OUTPUTS. Each is an independent switch, so this is not a dispatch between
            // track TYPES — it is simply "drive whichever outputs this track has turned on".
            // The note outputs run BEFORE the muted/empty skip below, because a track with no
            // sample lane is force-muted in the snapshot and would otherwise never get here.
            const bool sampleOut = (track.trackType == 0);
            if ((track.instrumentOutEnabled || track.midiOutEnabled) && !track.steps.empty()) {
#if SCOOPY_PLUGIN_HOST
                if (generateInstrumentMidi && track.instrumentOutEnabled)
                    generateInstrumentMidiForTrack(track, instrumentDeck, static_cast<int>(trackIndex),
                                                   patternMasterStep, stepFrame, state, outputFrame);
#endif
                // No fallback, no inference: the port sounds because the user asked it to.
                // The DSP dials speak CC only on a track with NO audio path of its own — on a
                // sampler or an instrument they move real audio, and doubling them onto CC would
                // give one gesture two invisible owners.
                if (track.midiOutEnabled)
                    generateExternalMidiForTrack(track, instrumentDeck, static_cast<int>(trackIndex),
                                                 patternMasterStep, stepFrame, state, outputFrame,
                                                 /*sendDialCCs*/ !sampleOut && !track.instrumentOutEnabled);
            }
            if (!sampleOut) continue;   // the SAMPLE output is off — nothing to trigger below
            if (track.muted || track.steps.empty()) {
                continue;
            }
            // Audio-rate grain (pulsar) mode: the track's audio comes from the grain pass below,
            // not step voices — suppress step triggering for this track.
            if (track.grainEnabled) {
                continue;
            }

            // Free-rate mod gate (hoisted from the free-rate block below): a modulator routed to
            // .freeRate engages the phasor even at the 1× neutral base. Also consulted by the
            // rate morph, which must know whether the free cursor is genuinely live.
            const bool hasFreeRateMod = track.lfo1FreeRateDepth != 0.0f || track.lfo2FreeRateDepth != 0.0f
                || track.lfo3FreeRateDepth != 0.0f || track.lfo4FreeRateDepth != 0.0f;

            // Rate morph: advance the multiply glide one frame. During the ramp morphM walks
            // m1→m2 exponentially; at the ramp's end a locked track holds at exactly m2 until
            // the landing probe below finds the locked math's next canonical trigger boundary
            // (a genuinely free track just stays on the free path — nothing to land).
            bool trackMorphing = trackIndex < kMaxGrainTracks && state.morphPhase[trackIndex] != 0;
            if (trackMorphing && state.morphPhase[trackIndex] == 1) {
                state.morphM[trackIndex] *= state.morphFactor[trackIndex];
                if (--state.morphFramesLeft[trackIndex] == 0) {
                    state.morphM[trackIndex] = state.morphM2[trackIndex];
                    if (track.freeRateEnabled || hasFreeRateMod) {
                        state.morphPhase[trackIndex] = 0;
                        trackMorphing = false;
                    } else {
                        state.morphPhase[trackIndex] = 2;
                        // Bounded wait: canonical boundaries are ≤ ceil(1/m2) master steps apart,
                        // so one period + a spare step always contains one. Force-land on expiry.
                        const double m2 = state.morphM2[trackIndex];
                        const auto holdSteps = static_cast<std::uint64_t>(
                            std::ceil(std::max(1.0, 1.0 / m2))) + 1;
                        state.morphHoldFramesLeft[trackIndex] = static_cast<std::uint32_t>(
                            std::min<std::uint64_t>(holdSteps * state.currentFramesPerStep,
                                                    std::numeric_limits<std::uint32_t>::max()));
                    }
                }
            }

            // Phase 6: rhythmic offset — determine how many frames into the master step to delay trigger
            // values: 0=none, 1=1/4, 2=1/2, 3=3/4, 4=1/3, 5=2/3
            std::uint64_t rhythmicOffsetFrames = 0;
            if (track.rhythmicOffset != 0 && state.currentFramesPerStep > 0) {
                const double fps = static_cast<double>(state.currentFramesPerStep);
                switch (track.rhythmicOffset) {
                case 1: rhythmicOffsetFrames = static_cast<std::uint64_t>(fps * 0.25); break;
                case 2: rhythmicOffsetFrames = static_cast<std::uint64_t>(fps * 0.5);  break;
                case 3: rhythmicOffsetFrames = static_cast<std::uint64_t>(fps * 0.75); break;
                case 4: rhythmicOffsetFrames = static_cast<std::uint64_t>(fps / 3.0);  break;
                case 5: rhythmicOffsetFrames = static_cast<std::uint64_t>(fps * 2.0 / 3.0); break;
                default: break;
                }
            }
            // Phase 7: humanize timing jitter — deterministic hash of (ABSOLUTE step, trackIndex).
            // Deliberately the absolute clock, not the musical step: the jitter draw stays
            // bit-identical to the pre-anchor engine and never repeats a sequence at a switch.
            if (track.humanize > 0.0f && state.currentFramesPerStep > 0) {
                std::uint64_t h = (state.masterStep * 2654435761ULL) ^ (static_cast<std::uint64_t>(trackIndex) * 0x9e3779b9ULL);
                h ^= h >> 33; h *= 0xff51afd7ed558ccdULL; h ^= h >> 33;
                const double jitterFrac = (h & 0x7FFFFFFFULL) / static_cast<double>(0x7FFFFFFFULL);
                const std::uint64_t jitterFrames = static_cast<std::uint64_t>(
                    static_cast<double>(state.currentFramesPerStep) * track.humanize * 0.25 * jitterFrac);
                rhythmicOffsetFrames = std::min(rhythmicOffsetFrames + jitterFrames,
                                                state.currentFramesPerStep - 1);
            }

            std::uint64_t triggerOffset = 0;
            // Rate morph landing: during the hold the cursor runs at exactly m2; probe the
            // locked math each frame and land the moment it fires a canonical trigger. Ringing
            // voices get the morph ratio BAKED (frozen — snapping their ratios back to 1 would
            // pitch-jump old notes), then the morph clears and control falls through to the
            // locked path below, whose identical triggerOffsetAtFrame call fires the canonical
            // trigger on this very frame — the resync coincides with a fresh trigger, never a
            // mid-cell re-slice, and the track is back in canonical alignment.
            if (trackMorphing && state.morphPhase[trackIndex] == 2) {
                std::uint64_t landOffset = 0;
                const bool boundaryNow = triggerOffsetAtFrame(patternMasterStep, stepFrame,
                                                              state.currentFramesPerStep,
                                                              track.patternSpeedMultiplier,
                                                              rhythmicOffsetFrames, landOffset);
                bool land = boundaryNow;
                if (!land && state.morphHoldFramesLeft[trackIndex] > 0
                    && --state.morphHoldFramesLeft[trackIndex] == 0) {
                    land = true;   // bounded-wait expiry: force the resync now
                }
                if (land) {
                    const double m2 = state.morphM2[trackIndex];
                    for (auto& v : state.voices) {
                        if (!v.active || v.trackIndex != trackIndex
                            || v.bakedPatternMult <= 0.0) continue;
                        const double r = m2 / v.bakedPatternMult;
                        if (r != 1.0) {
                            if (v.useRubberBand) {
                                v.varispeedRate *= r;
                            } else {
                                v.rate *= r;
                                if (v.glideSourceRate != 0.0) v.glideSourceRate *= r;
                                v.cellRateScale *= r;
                            }
                        }
                        v.bakedPatternMult = m2;
                    }
                    // The resync must read as a CONTIGUOUS continuation to the locked path.
                    // prevResolvedStep is stale from before the morph (the free path only
                    // updates it on firing crossings), so without this the landing inside an
                    // extended cell looks like a locator-style jump — the mid-cell entry cuts
                    // the ringing voice (and its offset can overshoot the cell cap into
                    // silence). Seeding prev = the canonical step just before the landing step
                    // keeps the ringing voice ringing through the landing, which is the whole
                    // "no mid-cell re-slice" promise.
                    if (!track.steps.empty() && trackIndex < state.prevResolvedStep.size()) {
                        const auto safeM2 = std::clamp(track.patternSpeedMultiplier, 0.001, 16.0);
                        const std::uint64_t landingLocal = static_cast<std::uint64_t>(
                            std::floor(static_cast<double>(patternMasterStep) * safeM2 + 0.000001))
                            + landOffset;
                        const std::size_t sc = track.steps.size();
                        // Boundary landing: the step firing THIS frame is landingLocal; seed its
                        // predecessor. Hold-expiry landing (no boundary now): the step currently
                        // in progress is landingLocal's floor; the NEXT boundary resolves +1, so
                        // seeding the current step keeps that one contiguous too.
                        const std::uint64_t seedLocal = boundaryNow
                            ? (landingLocal == 0 ? 0 : landingLocal - 1) : landingLocal;
                        if (boundaryNow ? landingLocal > 0 : true)
                            state.prevResolvedStep[trackIndex] =
                                static_cast<std::int32_t>(seedLocal % sc);
                    }
                    state.morphPhase[trackIndex] = 0;
                    trackMorphing = false;
                }
            }
            // Flam/ratchet: a flam sub-hit is a retrigger of the SAME cell at an interior frame of
            // the cell's window (not on a multiplier boundary). isFlamRepeat marks those frames so
            // the per-step rhythmic re-check is bypassed and the hit-frame test below applies.
            bool isFlamRepeat = false;
            bool freeRateHit = false;   // this hit came from the free-rate phasor (audio-rate resynthesis)
            bool brMicroRetrigger = false;  // this hit is a micro beat-repeat sub-tick (frame-space roll)
            // Effective free-rate magnitude at trigger, captured for the per-step cell-cap below. The
            // cell's OUTPUT duration scales with how fast the pattern playhead advances: locked =
            // patternSpeedMultiplier localSteps per masterStep; free = effRate × multiplier. Default 1
            // (locked / no free rate) so a non-free voice uses the multiplier alone.
            double freeRateMagForCap = 1.0;
            std::uint64_t flamWindowStart = 0;
            std::uint64_t flamWindowLen = 0;
            // Free-rate (audio-rate resynthesis): a continuous, modulatable retrigger driven by a
            // per-track PHASE ACCUMULATOR instead of the bar-locked boundary math — so the rate can
            // sweep freely (up to audio rate) without the ±1-frame period jitter. Gated to T / T+P
            // (never time-stretch). The phasor decides WHEN to fire; the pattern cell under the
            // playhead (located via owningBoundaryAtFrame) decides WHAT plays. Toggling free off
            // returns to the locked path below (bar-synced groove), untouched.
            // REG-only (playbackMode 0): the per-step cell-cap bounds each grain to one cycle of
            // source audio, so the tape reverse captures the exact cycle (a "splice"), not the whole
            // sample. OWN (playbackMode 3) plays a continuous owner voice with no per-cycle cap, so we
            // deliberately leave it on the locked groove — free rate is a REG bonus.
            // A free-rate modulator (LFO/EnvFol/Env routed to .freeRate on any channel) should engage
            // the phasor even at the 1× neutral base, so an assigned modulator is audible without
            // first nudging the base off 1×.
            // (hasFreeRateMod hoisted above the rate-morph advance.) A morphing track is FORCED
            // onto the phasor: the glide is a continuous velocity, which only the accumulator
            // can express — the locked math would teleport on every intermediate value. Morph
            // eligibility already requires REG + !useTimeStretch, so the extra gates only ever
            // veto stale state, never fight the force.
            const bool freeActive = (track.freeRateEnabled || hasFreeRateMod || trackMorphing)
                && !track.useTimeStretch
                && track.playbackMode == 0
                && state.currentFramesPerStep > 0 && trackIndex < state.ratchetPhase.size()
                && !track.steps.empty();
            if (freeActive) {
                // Free-rate = continuous PATTERN-PLAYBACK SPEED (the multiplier, but continuous &
                // modulatable). A per-track step cursor advances at freeRate steps per master step;
                // each time it crosses into a new pattern step we trigger that step. So sweeping
                // freeRate up reads the pattern faster and faster, and at audio rate the cell
                // sequence fuses into a tone — resynthesis from the pattern itself. The locked path
                // below stays bar-synced and untouched (toggle off = back to the groove).
                const std::size_t scN = track.steps.size();
                const double sc = static_cast<double>(scN);
                double& cursor = state.ratchetPhase[trackIndex];   // fractional step position in [0, sc)
                if (cursor >= sc || cursor < 0.0) cursor = 0.0;
                // Rate morph seed: entering the free path from the locked path, the cursor is
                // stale (it is never reset) — place it on the CANONICAL locked position so the
                // glide departs exactly from where the groove is, mid-cell included (no re-slice;
                // the next crossing simply fires the next cell).
                if (trackMorphing && state.morphSeedPending[trackIndex]) {
                    state.morphSeedPending[trackIndex] = 0;
                    const double fpsD = static_cast<double>(state.currentFramesPerStep);
                    double pos = (static_cast<double>(patternMasterStep)
                                  + static_cast<double>(stepFrame) / fpsD)
                                 * state.morphM[trackIndex];
                    pos = std::fmod(pos, sc);
                    if (pos < 0.0 || !std::isfinite(pos)) pos = 0.0;
                    cursor = pos;
                }
                // Plays the EXACT pattern with no skips: fire on every step crossing (the cell's
                // primary hit) AND, within a step, on its flam sub-slots — so flam layers on the free
                // rate (a flam-N cell re-fires N× across its free-rate window). Per-frame advance is
                // smaller than a flam sub-slot for the supported range, so no hit is missed.
                const double S = std::floor(cursor);
                const std::size_t curIdx = static_cast<std::size_t>(S) % scN;
                const int flamF = (curIdx < track.flamCounts.size())
                    ? std::clamp<int>(track.flamCounts[curIdx], 1, kMaxFlam) : 1;
                const double prevFrac = cursor - S;
                // LFO → free-rate modulation: wobble the cursor advance by any LFO assigned to the
                // `.freeRate` modifier target (depths resolved in the facade). Slow LFO = vibrato /
                // auto rhythm↔tone sweeps; audio-rate LFO = FM (metallic/vocal/bell). The standard
                // LFO-modifier path — right-click the rate box to assign an LFO.
                // Signed (tape): negative freeRate runs the phasor BACKWARD — the pattern is read in
                // reverse and (see voice trigger) the grains play reversed. Magnitude near zero is the
                // slowest read (lowest pitch); zero = tape stop. No floor-to-0 here.
                // Forced (morph-only) entry must NOT leak a parked off-1 freeRate slider value:
                // a locked track's stored freeRate is inert until free mode is engaged.
                double effRate = (track.freeRateEnabled || hasFreeRateMod) ? track.freeRate : 1.0;
                if (track.lfo1FreeRateDepth != 0.0f || track.lfo2FreeRateDepth != 0.0f
                    || track.lfo3FreeRateDepth != 0.0f || track.lfo4FreeRateDepth != 0.0f) {
                    // ch0/1 use the legacy waveform here; scale by their master depth. ch2/3 are
                    // read from modChannelValue[] which is already depth-scaled in the mod loop.
                    const double lfo1v = lfoWaveValue(state.lfo1Phase, snapshot.lfo1Waveform,
                                                      snapshot.lfo1Symmetry, state.randVal1)
                                         * snapshot.modChannels[0].depth;
                    const double lfo2v = lfoWaveValue(state.lfo2Phase, snapshot.lfo2Waveform,
                                                      snapshot.lfo2Symmetry, state.randVal2)
                                         * snapshot.modChannels[1].depth;
                    const double mod = lfo1v * track.lfo1FreeRateDepth + lfo2v * track.lfo2FreeRateDepth
                        + static_cast<double>(state.modChannelValue[2]) * track.lfo3FreeRateDepth
                        + static_cast<double>(state.modChannelValue[3]) * track.lfo4FreeRateDepth;
                    effRate = track.freeRate * (1.0 + mod);
                }
                // The multiply is folded in FIRST (patternSpeedMultiplier = the track's discrete
                // multiply), then the free rate scales it: effective pattern-read speed =
                // multiply × freeRate. So at freeRate = 1 the phasor matches the locked groove
                // (incl. double-time) and the free rate is a continuous modifier layered on top.
                // Rate morph: the glide substitutes the INSTANTANEOUS multiplier for the
                // snapshot's landed value — the cursor's velocity bends, its position never
                // jumps. magForCap compensates so the cap consumers' product
                // (patternSpeedMultiplier × magForCap) equals the true advance effRate × m(t).
                const double patternMult = trackMorphing
                    ? state.morphM[trackIndex] : track.patternSpeedMultiplier;
                cursor += effRate * patternMult
                          / static_cast<double>(state.currentFramesPerStep);
                freeRateMagForCap = trackMorphing   // signed; cap uses the magnitude
                    ? effRate * patternMult / std::max(0.0001, track.patternSpeedMultiplier)
                    : effRate;
                bool crossed = false;
                if (std::floor(cursor) != S) {
                    crossed = true;                                   // moved into another step (either direction)
                } else if (flamF > 1
                    && std::floor((cursor - S) * flamF) != std::floor(prevFrac * flamF)) {
                    crossed = true;                                   // flam sub-slot crossing (either direction)
                }
                if (cursor >= sc) { cursor -= sc; crossed = true; }   // forward pattern wrap is a step crossing
                if (cursor < 0.0)  { cursor += sc; crossed = true; }  // reverse pattern wrap is a step crossing
                if (!crossed) {
                    continue;  // still within the current step / sub-slot
                }
                isFlamRepeat = true;   // bypass the per-step rhythmic re-gate below
                freeRateHit = true;    // localStep comes from the cursor; skip flam k-loop + cell-entry skip
            } else if (!triggerOffsetAtFrame(patternMasterStep,
                                      stepFrame,
                                      state.currentFramesPerStep,
                                      track.patternSpeedMultiplier,
                                      rhythmicOffsetFrames,
                                      triggerOffset)) {
                // Not a primary boundary. It can still fire as a micro beat-repeat sub-tick (deck
                // global, timed in frame space) or a flam sub-hit inside the current cell's window.
                if (brMicroHit) {
                    isFlamRepeat = true;       // bypass the per-step rhythmic re-gate below
                    brMicroRetrigger = true;   // bypass the flam sub-hit grid test (timed above, not on it)
                } else if (!track.hasFlamCells
                    || !owningBoundaryAtFrame(patternMasterStep, stepFrame, state.currentFramesPerStep,
                                              track.patternSpeedMultiplier, rhythmicOffsetFrames,
                                              triggerOffset, flamWindowStart, flamWindowLen)) {
                    continue;
                } else {
                    isFlamRepeat = true;
                }
            }
            // Free-rate takes the step straight from its continuously-advancing cursor; locked
            // derives it from masterStep × the (discrete) multiplier as before.
            const auto localStep = freeRateHit
                ? static_cast<std::uint64_t>(std::floor(state.ratchetPhase[trackIndex]))
                : (static_cast<std::uint64_t>(
                       std::floor(static_cast<double>(patternMasterStep) * track.patternSpeedMultiplier + 0.000001))
                   + triggerOffset);
            const std::size_t stepCount = track.steps.size();
            std::size_t step = static_cast<std::size_t>(localStep % stepCount);

            // Phase 6: locator repeat — tile [locatorStartStep, locatorEndStep] across the pattern
            // (LCM) cycle, realigning at every pattern boundary. Keyed off the pattern-relative
            // position (natStep = localStep % stepCount), anchored so natStep == locStart maps to
            // region position 0. This fits the slice as many whole times as the pattern allows and
            // fills the remainder with a partial repeat, then realigns at the bar — so every pattern
            // cycle plays the identical region-position sequence (bar-periodic). This mirrors the
            // beat-repeat fold below; the difference is intent, not math: the locator is the
            // bar-locked variant, whereas users reach for beat repeat to free-run the exact slice.
            // (Earlier this used the free-running localStep directly, which drifted relative to the
            // bar whenever locLen did not divide stepCount evenly.)
            //
            // Engagement latch: toggling locator on ARMS the track — the pattern keeps playing
            // normally and the loop only ENGAGES once the natural playhead first enters the region,
            // so it catches the playhead at the locator point instead of snapping there immediately.
            // The latch holds for the rest of the active span and re-arms on the next off→on toggle
            // (see locatorWasActive).
            //
            // The window is stored as start + an "extended" end (locatorEndStep = locStart + len - 1)
            // which may exceed stepCount-1 to denote a window that wraps past the pattern end. We work
            // in distance-from-start space (diff) so wrap is handled uniformly: a step is inside the
            // window when diff < locLen, and the looped position is (locStart + diff % locLen) folded
            // back into the pattern with % stepCount.
            if (track.locatorRepeatActive && trackIndex < state.locatorEngaged.size()) {
                const std::size_t locStart = std::min(track.locatorStartStep, stepCount - 1);
                std::size_t locLen = (track.locatorEndStep >= track.locatorStartStep)
                    ? (track.locatorEndStep - track.locatorStartStep + 1) : std::size_t{1};
                locLen = std::min(std::max<std::size_t>(1, locLen), stepCount);
                // A length-1 window loops that single step: the latch engages when the playhead
                // reaches locStart (diff == 0) and then pins step to locStart every frame
                // (diff % 1 == 0). `locLen` is clamped to ≥ 1 above, so this always runs when the
                // locator is active — the user asked for one-step selections to loop, not be inert.
                if (locLen >= 1) {
                    const std::size_t natStep = static_cast<std::size_t>(localStep % stepCount);
                    const std::size_t diff    = (natStep + stepCount - locStart) % stepCount;

                    if (!state.locatorWasActive[trackIndex])
                        state.locatorEngaged[trackIndex] = 0;            // fresh toggle → re-arm
                    if (!state.locatorEngaged[trackIndex] && diff < locLen)
                        state.locatorEngaged[trackIndex] = 1;            // playhead reached the window

                    if (state.locatorEngaged[trackIndex])
                        step = (locStart + (diff % locLen)) % stepCount;
                    // else: not engaged yet — leave `step` at the natural pattern position.
                }
            }
            // Record the active flag for next-frame rising-edge detection (runs unconditionally so an
            // off period is observed and the next on-toggle re-arms).
            if (trackIndex < state.locatorWasActive.size())
                state.locatorWasActive[trackIndex] = track.locatorRepeatActive ? 1 : 0;

            // Beat repeat (global, per deck): fold the playhead into the repeated region
            // [start, start+len), wrapping across the pattern end if needed. The loop phase must
            // FREE-RUN — this is the "play the exact captured slice over and over" tool and must stay
            // perfectly fixed, never realigning at the bar (that is the locator's job, above).
            //
            // beatRepeatStartStep is an absolute virtual step (the master step captured at activation,
            // the same monotonic counter as localStep). The phase is therefore derived straight from
            // the free-running distance since activation, modulo the window length:
            //     phase = (localStep − anchor) mod brLen,   anchor = beatRepeatStartStep·multiplier
            // and the played pattern step is (brStart + phase) % stepCount. Taking the distance mod
            // stepCount BEFORE mod brLen (the previous approach) injected a phase jump at every pattern
            // boundary whenever brLen did not divide stepCount (e.g. lengths 3/5/6/7), so the repeated
            // section appeared to "shift" on its own. Working from the un-wrapped counter keeps the
            // slice fixed for every length, and is identical to the old code when brLen divides
            // stepCount (the 1/2/4/8/16 cases). natStep keeps advancing underneath, so deactivating
            // still resumes wherever the playhead would naturally be.
            if (snapshot.isBeatRepeatActive && snapshot.beatRepeatLength >= 1) {
                const std::size_t brStart = static_cast<std::size_t>(snapshot.beatRepeatStartStep) % stepCount;
                const std::size_t brLen   = std::min(std::max<std::size_t>(1, snapshot.beatRepeatLength), stepCount);
                const std::int64_t anchor = static_cast<std::int64_t>(std::llround(
                    static_cast<double>(snapshot.beatRepeatStartStep) * track.patternSpeedMultiplier));
                const std::int64_t brLenI = static_cast<std::int64_t>(brLen);
                std::int64_t phase = (static_cast<std::int64_t>(localStep) - anchor) % brLenI;
                if (phase < 0) phase += brLenI;   // guard the brief activation-snapshot lag
                step = (brStart + static_cast<std::size_t>(phase)) % stepCount;
            }

            // Phase 7: backward playback direction — traverse steps in reverse.
            // XOR the global session-reverse transport (snapshot.reverseTransport) so the WHOLE
            // session mirrors its step order without mutating each track's own direction.
            if (track.playbackDirectionBackward ^ snapshot.reverseTransport) {
                step = (stepCount - 1) - step;
            }

            // Phase 7: randomize — pick a random active step (deterministic per localStep)
            bool forceActivate = false;
            if (track.randomize) {
                std::uint64_t rSeed = (localStep * 6364136223846793005ULL)
                    ^ (static_cast<std::uint64_t>(trackIndex) * 2654435761ULL);
                rSeed ^= rSeed >> 33; rSeed *= 0xff51afd7ed558ccdULL; rSeed ^= rSeed >> 33;
                std::size_t activeCount = 0;
                for (const auto& s : track.steps) if (s) ++activeCount;
                if (activeCount > 0) {
                    const std::size_t target = rSeed % activeCount;
                    std::size_t found = 0;
                    for (std::size_t s = 0; s < stepCount; ++s) {
                        if (track.steps[s]) {
                            if (found == target) { step = s; break; }
                            ++found;
                        }
                    }
                    forceActivate = true;
                }
            }

            // Phase 6: per-step rhythmic offset override
            if (!track.rhythmicOffsetSteps.empty() && step < track.rhythmicOffsetSteps.size()) {
                const std::uint8_t perStepRhythmic = track.rhythmicOffsetSteps[step];
                if (perStepRhythmic != 0 && state.currentFramesPerStep > 0) {
                    const double fps = static_cast<double>(state.currentFramesPerStep);
                    std::uint64_t perStepOffsetFrames = 0;
                    switch (perStepRhythmic) {
                    case 1: perStepOffsetFrames = static_cast<std::uint64_t>(fps * 0.25); break;
                    case 2: perStepOffsetFrames = static_cast<std::uint64_t>(fps * 0.5);  break;
                    case 3: perStepOffsetFrames = static_cast<std::uint64_t>(fps * 0.75); break;
                    case 4: perStepOffsetFrames = static_cast<std::uint64_t>(fps / 3.0);  break;
                    case 5: perStepOffsetFrames = static_cast<std::uint64_t>(fps * 2.0 / 3.0); break;
                    default: break;
                    }
                    // Flam sub-hits live inside the (track-level) window and are intentionally off the
                    // per-step rhythmic boundary, so skip this re-gate for them (flam + per-step
                    // rhythmic offset uses the track-level window — a rare combination).
                    if (!isFlamRepeat && perStepOffsetFrames != rhythmicOffsetFrames) {
                        std::uint64_t retriggerOffset = 0;
                        if (!triggerOffsetAtFrame(patternMasterStep, stepFrame, state.currentFramesPerStep,
                                                  track.patternSpeedMultiplier, perStepOffsetFrames, retriggerOffset)) {
                            continue;
                        }
                    }
                }
            }

            // Phase 6 / mid-cell entry (must run BEFORE the active-step gate below): an extended reg
            // cell stores its owner step active and every covered extension step INACTIVE, so the
            // extensions are normally heard only via the owner's ringing voice. When a locator /
            // beat-repeat loop or a skip-step jump folds the playhead into the middle of such a cell
            // WITHOUT having played the owner contiguously, the owner step can be entirely outside the
            // captured region — so we re-trigger from the owner with a mid-cell sample offset (applied
            // after voice setup). Detecting this here lets the active-step gate pass the remapped
            // (now-owner) step; previously the gate dropped the inactive extension first, which
            // silenced beat-repeat / locator regions that captured only extension steps. Reg variants
            // take this path generally; OWN mode (playbackMode 3) keeps the owner-required skip EXCEPT
            // while beat repeat is active (so its slice re-attacks each cycle); backward playback keeps
            // the skip.
            bool cellEntry = false;
            bool switchResumeOwnEntry = false;
            std::size_t entryOriginStep = step;
            std::uint32_t entryStepOffset = 0;
            {
                const std::int32_t prevStepForTrack =
                    (trackIndex < state.prevResolvedStep.size())
                        ? state.prevResolvedStep[trackIndex] : std::int32_t{-1};
                if (trackIndex < state.prevResolvedStep.size())
                    state.prevResolvedStep[trackIndex] = static_cast<std::int32_t>(step);

                // Seamless "Run" switch resume one-shot for THIS track: consume it now so it applies
                // to exactly the first step this track processes after the switch, then clears (see
                // NativeRenderState::switchResumePending). Used by both the OWN multi-step entry below
                // and the OWN single-step backscan further down.
                bool ownResumeArmed = false;
                if (trackIndex < state.switchResumePending.size()
                    && state.switchResumePending[trackIndex] != 0) {
                    ownResumeArmed = true;
                    state.switchResumePending[trackIndex] = 0;
                }

                bool withinExtendedCell = false;
                if (!track.cellLengths.empty()) {
                    std::size_t ownerOrigin = step;
                    for (std::size_t origin = 0; origin < step; ++origin) {
                        const std::size_t cellLen = origin < track.cellLengths.size()
                            ? track.cellLengths[origin] : std::size_t{1};
                        if (cellLen > 1 && origin < stepCount && track.steps[origin] != 0
                            && step < origin + cellLen) {
                            withinExtendedCell = true;
                            ownerOrigin = origin;
                            break;
                        }
                    }
                    // Rate morph: a morph-FORCED free hit is a bent locked groove, not a pulsar —
                    // it must keep extended-cell semantics (extensions skip, the owner voice rings
                    // through at the bent rate), so it takes the contiguous branch below. The
                    // morph's crossings are consecutive localSteps, so prevResolvedStep keeps them
                    // contiguous. Genuinely-free tracks keep the pulsar re-attack even mid-morph.
                    const bool morphForcedOnly = trackMorphing
                        && !track.freeRateEnabled && !hasFreeRateMod;
                    if (withinExtendedCell
                        && ((freeRateHit && !morphForcedOnly) || brMicroRetrigger)) {
                        // Free-rate / micro beat-repeat: every hit re-attacks the cell from the owner's
                        // start (a pulsar/ratchet/roll); no contiguity skip, no mid-cell offset.
                        step = ownerOrigin;
                    } else if (withinExtendedCell) {
                        // Contiguous continuation: the owner / an earlier extension of THIS cell led
                        // straight here, so its voice is still ringing — leave `step` on the inactive
                        // extension so the gate below skips it, exactly as before.
                        // Strict adjacency (prev == step-1), not "anywhere earlier in the cell":
                        // a locator re-drag / skip that folds the playhead FORWARD by more than one
                        // step inside the same extended cell used to satisfy the old `< step` range
                        // test and keep the stale owner voice ringing for a full window pass instead
                        // of re-attacking. Normal forward playback (prev == step-1) is unchanged.
                        const bool contiguous = prevStepForTrack >= 0
                            && static_cast<std::size_t>(prevStepForTrack) >= ownerOrigin
                            && static_cast<std::size_t>(prevStepForTrack) + 1 == step;
                        const bool regVariant = (track.playbackMode != 3);
                        // Beat repeat captures the slice under the window and must re-attack it every
                        // cycle. An OWN cell longer than the BR window would otherwise keep its original
                        // owner voice ringing (owner-required skip) and just play the long sample out
                        // instead of looping the captured step(s). So under BR, treat an OWN extension
                        // like a jumped-into cell: re-trigger from the owner with a mid-cell offset.
                        // Outside BR the skip stands (locator / skip-step jumps keep the ringing owner),
                        // and a contiguous step inside a multi-step BR window still rings through.
                        const bool brSliceReentry = snapshot.isBeatRepeatActive;
                        // Seamless "Run" scene switch: let OWN multi-step cells (continuous / loop)
                        // resume mid-sample at the running position too — but NOT OWN chopper (short
                        // slices; re-entering mid-chop is meaningless). Strictly one-shot so locator /
                        // skip-step jumps keep the OWN owner-skip (preserving the ringing owner voice).
                        const bool ownChopper = (track.playbackMode == 3
                            && track.defaultChopIndex >= 0 && !track.chopPoints.empty());
                        // Deck-0 (composition / suppressed-owner) only: the arm is a deck-0 concept,
                        // so decks B/C must keep their OWN owner-skip even while a deck-0 switch is armed.
                        const bool switchEntryOwn = ownResumeArmed && instrumentDeck == 0 && !ownChopper;
                        if (contiguous || (track.playbackDirectionBackward ^ snapshot.reverseTransport)
                            || (!regVariant && !brSliceReentry && !switchEntryOwn)) {
                            // Owner-required skip retained (gate drops the still-inactive `step`).
                        } else {
                            // Jumped into the cell — re-trigger from the owner (the same-track
                            // voice-stop below fades the previously-entered voice cleanly) and offset
                            // into the sample. Remapping to the (active) owner lets the gate pass.
                            cellEntry = true;
                            entryOriginStep = ownerOrigin;
                            entryStepOffset = static_cast<std::uint32_t>(step - ownerOrigin);
                            step = ownerOrigin;
                        }
                    }
                }

                // OWN single-step long-sample resume (the common owner-mode case: cellLength==1, the
                // whole sample plays from one active step, so the multi-step detection above can't
                // reach it). On a seamless "Run" switch, backscan to the most-recent active owner
                // BEHIND the playhead and re-enter its sample at the running offset — exactly where it
                // would be sounding had the scene been running. Deck-0 / forward / non-chopper only,
                // and only with no locator / beat-repeat remap active (those own the playhead). The
                // crossed step itself must be inactive (an active step is a fresh hit, played from the
                // top). One-shot via ownResumeArmed so locator / skip-step jumps are unaffected.
                if (ownResumeArmed && !cellEntry && !withinExtendedCell
                    && instrumentDeck == 0
                    && track.playbackMode == 3
                    && !(track.playbackDirectionBackward ^ snapshot.reverseTransport)
                    && !(track.defaultChopIndex >= 0 && !track.chopPoints.empty())
                    && !snapshot.isBeatRepeatActive && !track.locatorRepeatActive
                    && step < stepCount && step < track.steps.size() && track.steps[step] == 0) {
                    for (std::size_t o = step; o-- > 0; ) {
                        if (o < track.steps.size() && track.steps[o] != 0) {
                            cellEntry            = true;
                            switchResumeOwnEntry = true;
                            entryOriginStep      = o;
                            entryStepOffset      = static_cast<std::uint32_t>(step - o);
                            step                 = o;
                            break;
                        }
                    }
                }
            }

            // Active-step gate: inactive steps drop out here. A rescued mid-cell entry above has
            // already remapped `step` to its active owner, so it passes; a contiguous / owner-required
            // extension is still inactive and is skipped.
            if (!forceActivate && track.steps[step] == 0) {
                continue;
            }

            // Flam/ratchet hit-frame test. The primary boundary (isFlamRepeat == false) is always
            // flam hit 0 and fires unconditionally. For interior frames, fire only when stepFrame
            // lands on one of the evenly-spaced sub-hits k·(window/flamCount), k = 1…flamCount-1.
            // Each sub-hit re-triggers the same cell (same step), producing the ratchet.
            // Free-rate and micro beat-repeat hits are timed in frame space (above), not on the flam
            // sub-hit grid — skip this test for them.
            if (isFlamRepeat && !freeRateHit && !brMicroRetrigger) {
                const std::uint8_t flamCount = (step < track.flamCounts.size())
                    ? static_cast<std::uint8_t>(std::clamp<int>(track.flamCounts[step], 1, kMaxFlam)) : 1;
                if (flamCount < 2 || flamWindowLen == 0) {
                    continue;
                }
                bool onSubHit = false;
                for (std::uint8_t k = 1; k < flamCount; ++k) {
                    const std::uint64_t subFrame = flamWindowStart + static_cast<std::uint64_t>(
                        std::llround(static_cast<double>(k) * static_cast<double>(flamWindowLen)
                                     / static_cast<double>(flamCount)));
                    if (stepFrame == subFrame) { onSubHit = true; break; }
                }
                if (!onSubHit) {
                    continue;
                }
            }

            // Modulation overhaul: a cell starts here for `trackIndex` at this trigger frame. Fire
            // the gate for any envelope-type mod channel sourced from this track (works for silent
            // trigger lanes too — this runs regardless of sample presence). The gate stays open for
            // the cell's length (extension cells → longer hold), then the envelope releases.
            {
                const std::uint32_t cellLen = (step < track.cellLengths.size()
                    && track.cellLengths[step] > 1)
                    ? static_cast<std::uint32_t>(track.cellLengths[step]) : 1;
                const std::uint64_t closeFrame = frame
                    + static_cast<std::uint64_t>(cellLen) * state.currentFramesPerStep;
                for (int ch = 0; ch < kModChannelCount; ++ch) {
                    if (snapshot.modChannels[ch].type == NativeModChannelType::envelope
                        && snapshot.modChannels[ch].triggerSourceTrack == static_cast<int>(trackIndex)) {
                        state.modGatePendingTrigger[ch] = true;
                        state.modPendingCloseFrame[ch] = closeFrame;
                    }
                }
            }

            const auto sampleIterator = world.samples.find(track.sampleId);
            if (sampleIterator == world.samples.end() || !sampleIterator->second) {
                continue;
            }

            // Per-cell chord: resolve this step's interval slots (semitones above the cell's own
            // pitch) into a local stack; slot 0 is the root. Gated on the precomputed
            // hasChordCells flag so non-chord tracks pay nothing. REG stretch-to-cell collapses
            // to root-only when per-step pitch is not applied there (time+pitch overrides the
            // rate below; time-only without melodic mode never applies a transpose) — a sibling
            // would be an identical doubled voice (+6 dB, phasey), not a chord note.
            double chordIvs[1 + kMaxChordExtraNotes] = {};
            int chordNoteCount = 1;
            if (track.hasChordCells) {
                const std::size_t chordBase = step * static_cast<std::size_t>(kMaxChordExtraNotes);
                for (int k = 0; k < kMaxChordExtraNotes; ++k) {
                    if (chordBase + k < track.chordIntervals.size()
                        && track.chordIntervals[chordBase + k] != 0) {
                        chordIvs[chordNoteCount++] =
                            static_cast<double>(track.chordIntervals[chordBase + k]);
                    }
                }
                const bool stretchToCellPre = (track.playbackMode == 0) && track.stretchEnabled
                    && !track.useTimeStretch && state.currentFramesPerStep > 0;
                if (stretchToCellPre && !(track.stretchTimeOnly && track.melodicPitchMode)) {
                    chordNoteCount = 1;
                }
            }

            // Adaptive self-cut fade: a retrigger fades the previous same-track voice over
            // chokeFadeFrames (~11ms). When a track is dense — pattern multiplier × flam produces
            // many hits per step — that fixed fade is longer than the gap between hits, so the
            // fades overlap and the strikes turn to mush. Cap the fade to the per-hit spacing
            // (framesPerStep / (multiplierHits × flamCount)) with a short declick floor so dense
            // ratchets stay crisp while sparse note changes keep the smooth 512-frame crossfade.
            std::uint32_t selfCutFade = chokeFadeFrames;
            {
                const int mHits = (track.patternSpeedMultiplier >= 1.9)
                    ? std::max(1, static_cast<int>(std::lround(track.patternSpeedMultiplier))) : 1;
                const int fHits = (step < track.flamCounts.size())
                    ? std::clamp<int>(track.flamCounts[step], 1, kMaxFlam) : 1;
                // Free-rate: per-hit spacing is set by freeRate (× flam), not the multiplier — so the
                // choke fade tracks the audio-rate gap and stays crisp instead of smearing.
                int hitsPerStep = freeRateHit
                    ? std::max(1, static_cast<int>(std::lround(std::max(1.0, track.freeRate) * fHits)))
                    : std::max(1, mHits * fHits);
                // Micro beat-repeat ROLL mode adds sub-step retriggers; fold them in so the self-cut
                // fade tracks the sub-tick gap and dense rolls stay crisp instead of smearing. Grain
                // mode (brMicroWindowed) has no sub-hits — shortening its step-boundary fade there
                // would be pure loss.
                if (brMicroActive && !brMicroWindowed)
                    hitsPerStep = std::max(hitsPerStep, static_cast<int>(snapshot.beatRepeatSubdivision));
                if (hitsPerStep > 1 && state.currentFramesPerStep > 0) {
                    const std::uint64_t gap = state.currentFramesPerStep / static_cast<std::uint64_t>(hitsPerStep);
                    // Leave a small margin so the fade completes before the next strike fires.
                    const std::uint64_t capped = gap > 24 ? gap - 16 : std::max<std::uint64_t>(8, gap / 2);
                    selfCutFade = static_cast<std::uint32_t>(std::min<std::uint64_t>(chokeFadeFrames, capped));
                }
            }

            // Cross-track choke: a trigger in a non-zero choke group cuts voices of OTHER tracks in
            // the same group (open/closed-hat style). Same-track behaviour is governed by voiceMode.
            // Both cuts are onset-DEFERRED: armDeferredCut below (on the fully-initialized root
            // voice) waits out the voice's pre-silence plus the sample's scanned head silence, so
            // the ringing group is cut when the new note actually sounds, not when it is scheduled.
            const bool wantGroupChoke = track.chokeGroup != 0;
            // Mono voice mode self-cuts the previous voice on this track; poly lets retriggers stack
            // (long/overlapping cells and ratchets ring out instead of cutting themselves off).
            const bool wantSelfCut = !track.polyphonic;

            // Chord spawn group: iteration 0 spawns the root, then one voice per resolved
            // interval — same frame, different pitch. The choke / mono self-cut is armed once on
            // the ROOT voice and only cuts voices triggered BEFORE it, so siblings never cut each
            // other; the NEXT trigger's self-cut still cuts all of them (same trackIndex) as a
            // group. The loop body below is the pre-existing single-voice init, kept at its
            // original indentation to keep the diff reviewable; per-iteration overrides are
            // marked with `chordNi`.
            for (int chordNi = 0; chordNi < chordNoteCount; ++chordNi) {

            auto voiceIterator = acquireVoiceSlot(state);
            if (voiceIterator == state.voices.end()) {
                ++state.droppedVoiceCount;
                continue;
            }
            // When stealing an active voice, release its stretch slot and count the steal before reuse.
            if (voiceIterator->active) {
                ++state.stolenVoiceCount;
                if (voiceIterator->rubberBandSlot >= 0) {
                    voiceStretchPool_.checkin(voiceIterator->rubberBandSlot);
                    voiceIterator->rubberBandSlot = -1;
                }
            }

            const NativeSample& sample = *sampleIterator->second;

            // Phase 4: per-step volume/pan/mix/trim offsets
            const float stepVolOff = step < track.volumeOffsets.size() ? track.volumeOffsets[step] : 0.0f;
            const float stepMixOff = step < track.mixVolumeOffsets.size() ? track.mixVolumeOffsets[step] : 0.0f;
            const float stepPanOff = step < track.panOffsets.size() ? track.panOffsets[step] : 0.0f;
            // Phase 7: accent multiplier (off=1.0, soft=1.25, hard=1.5)
            const float accentLevel = step < track.accentLevels.size() ? track.accentLevels[step] : 0.0f;
            const float accentMult = accentLevel >= 2.0f ? 1.5f : (accentLevel >= 1.0f ? 1.25f : 1.0f);
            // Phase 7: humanize volume jitter (±humanize × 0.15 around 1.0). Absolute-step seed
            // (not musical) — same rationale as the timing-jitter hash above.
            float humanizeVolMult = 1.0f;
            if (track.humanize > 0.0f) {
                std::uint64_t hv = (state.masterStep * 3935559000370003845ULL) ^ (static_cast<std::uint64_t>(trackIndex) * 8765432109876543ULL);
                hv ^= hv >> 31; hv *= 0x9e3779b97f4a7c15ULL; hv ^= hv >> 27;
                const float hvFrac = static_cast<float>(hv & 0xFFFFFF) / static_cast<float>(0x1000000);
                humanizeVolMult = 1.0f + track.humanize * 0.15f * (hvFrac * 2.0f - 1.0f);
            }
            const float effVolume = std::clamp((track.volume + stepVolOff + stepMixOff) * accentMult * humanizeVolMult, 0.0f, 2.0f);
            const float effPan    = std::clamp(track.pan + stepPanOff, -1.0f, 1.0f);

            const double stepStartMsOff = step < track.sampleStartMsOffsets.size() ? track.sampleStartMsOffsets[step] : 0.0;
            const double stepEndMsOff   = step < track.sampleEndMsOffsets.size() ? track.sampleEndMsOffsets[step] : 0.0;
            const auto extraStartFrames = static_cast<std::size_t>(std::max(0.0, stepStartMsOff / 1000.0 * sampleRate));
            const auto extraEndFrames   = static_cast<std::ptrdiff_t>(stepEndMsOff / 1000.0 * sampleRate);
            const std::size_t adjSampleStart = track.sampleStartFrame + extraStartFrames;
            const std::size_t adjSampleEnd = track.sampleEndFrame > 0
                ? static_cast<std::size_t>(std::max<std::ptrdiff_t>(0,
                    static_cast<std::ptrdiff_t>(track.sampleEndFrame) + extraEndFrames))
                : 0;

            const double stepPitch = step < track.pitchOffsets.size() ? track.pitchOffsets[step] : 0.0;
            // Chord sibling: the interval is added in PRE-remap space so Just-intonation
            // voicings land on tuned scale degrees (a major third becomes 386 c, not 400 c).
            const double semitones = scoopy::tunedSemitones(
                    (track.globalPitchOffset + stepPitch) / 2.0 + chordIvs[chordNi], track.tuningIndex)
                + track.fineTuneCents / 100.0;
            const double pitchRate = std::pow(2.0, semitones / 12.0);

            // A melodic multi-step (extended) cell must take the per-voice melodic path even when
            // the ORIGIN step's pitch is 0, because a later sub-step may be pitched — that
            // extension pitch is streamed as a melodic transpose (time-preserved), not varispeed.
            // Require at least one pitched sub-step so flat melodic cells skip the stretcher.
            bool melodicMultiStepCell = false;
            if (track.melodicPitchMode && !track.cellLengths.empty()
                && step < track.cellLengths.size() && track.cellLengths[step] > 1
                && !track.pitchOffsets.empty()) {
                const std::size_t cellLen = track.cellLengths[step];
                const std::size_t nSteps = track.pitchOffsets.size();
                for (std::size_t s = 0; s < cellLen; ++s) {
                    const double sp = (track.globalPitchOffset
                        + track.pitchOffsets[(step + s) % nSteps]) / 2.0
                        + track.fineTuneCents / 100.0;
                    if (sp != 0.0) { melodicMultiStepCell = true; break; }
                }
            }

            // Pre-compute whether RubberBand will be used (needed before glide capture + cell cap)
            const bool djStretchEarly = snapshot.djTimeStretchActive && snapshot.djTimeStretchRatio != 1.0;
            const bool willUseRB = (track.useTimeStretch && track.speedMultiplier != 1.0)
                || (track.melodicPitchMode && semitones != 0.0)
                || melodicMultiStepCell
                || djStretchEarly;

            // Per-cell glide gate: the transition INTO this step glides only when its glide flag is
            // set. An empty glideSteps array means "legacy" (glide every transition) so sessions
            // saved before per-cell glide keep sounding the same.
            const bool stepWantsGlide = track.glidePercentBetweenSteps > 0.0
                && (track.glideSteps.empty()
                    || (step < track.glideSteps.size() && track.glideSteps[step]));

            // Phase 5: capture previous voice rate/pitch (and tone/pan/volume) for glide before zero-init
            double prevRateForGlide = 0.0;
            double prevRbPitchScaleForGlide = 0.0;
            float  prevVolumeForGlide = -1.0f;   // < 0 ⇒ no previous voice → skip param glide
            float  prevPanForGlide    = 0.0f;
            float  prevToneForGlide   = 0.0f;
            if (stepWantsGlide) {
                for (const auto& v : state.voices) {
                    if (v.active && v.trackIndex == static_cast<std::uint32_t>(trackIndex)) {
                        if (willUseRB) {
                            prevRbPitchScaleForGlide = (v.rbGlideTotalFrames > 0)
                                ? v.rbGlideTargetPitchScale : v.rbBasePitchScale;
                        } else {
                            prevRateForGlide = v.glideSourceRate > 0.0 ? v.glideSourceRate : v.rate;
                        }
                        // baseTone/basePan/baseVolume hold the previous cell's target values
                        // (the ramp is computed into locals, so these stay at the target).
                        prevVolumeForGlide = v.baseVolume;
                        prevPanForGlide    = v.basePan;
                        prevToneForGlide   = v.baseTone;
                        break;
                    }
                }
            }

            *voiceIterator = {};
            voiceIterator->sample = &sample;

            // Trim boundaries (base + per-step offsets)
            std::size_t sampleEnd = (adjSampleEnd > 0 && adjSampleEnd <= sample.left.size())
                ? adjSampleEnd
                : (track.sampleEndFrame > 0 && track.sampleEndFrame <= sample.left.size()
                    ? track.sampleEndFrame : sample.left.size());
            std::size_t sampleStart = (adjSampleStart < sampleEnd)
                ? adjSampleStart : std::size_t{0};

            // Sample-mode consolidation: owner chopper. When a chop slice is selected (OWN mode,
            // defaultChopIndex >= 0), play that slice [chopPoints[idx]..chopPoints[idx+1]] instead of
            // the full trim. Per-cell override via cellChopIndices (>=0). Last slice runs to sampleEnd.
            if (track.playbackMode == 3 && track.defaultChopIndex >= 0 && !track.chopPoints.empty()) {
                int chopIdx = track.defaultChopIndex;
                if (step < track.cellChopIndices.size() && track.cellChopIndices[step] >= 0)
                    chopIdx = track.cellChopIndices[step];
                const int activeChops = std::max(1, std::min(8, track.chopCount));
                if (chopIdx >= 0 && chopIdx < activeChops
                    && chopIdx < static_cast<int>(track.chopPoints.size())) {
                    const double startMs = track.chopPoints[static_cast<std::size_t>(chopIdx)];
                    const bool hasNext = (chopIdx + 1 < activeChops)
                        && (chopIdx + 1 < static_cast<int>(track.chopPoints.size()));
                    const double endMs = hasNext
                        ? track.chopPoints[static_cast<std::size_t>(chopIdx + 1)] : 0.0;
                    // chopPoints are in ms; convert against the SAMPLE's own rate (sample.left is
                    // stored at the file's native rate, NOT the engine rate). Using the engine rate
                    // here misplaced every chop by sampleSR/engineSR (e.g. 44.1k file on a 48k device
                    // → ~9% too deep), playing the wrong slice. Mirrors the live-trigger path above.
                    const double sampleSR = sample.sampleRate > 0.0 ? sample.sampleRate : sampleRate;
                    const std::size_t cs = static_cast<std::size_t>(
                        std::max(0.0, startMs) / 1000.0 * sampleSR);
                    const std::size_t ce = endMs > 0.0
                        ? static_cast<std::size_t>(endMs / 1000.0 * sampleSR)
                        : sampleEnd;
                    if (ce > cs && ce <= sample.left.size()) {
                        sampleStart = cs;
                        sampleEnd   = ce;
                    }
                }
            }

            // Phase 6: per-step reverse — XOR with global reversed flag.
            // Phase 7: backward playback direction (DJ Q/A reverse-play) ALSO plays each
            // sample backwards (matches legacy SequencerNode: playReversed includes
            // patternReverse). Fold it in here so startFrame/endFrame and the initial
            // position below are consistent with voice.reversed — otherwise a backward
            // voice was seeded at startFrame yet decremented its position, instantly
            // running out of range → silence (the broken Q/A behaviour).
            const bool perStepRev = step < track.reverseSteps.size() && track.reverseSteps[step];
            // Tape free-rate: a negative free rate runs the phasor backward (above) AND plays each
            // grain reversed, so the whole track sounds like tape running backwards. Varispeed only
            // (free-rate is already gated off in time-stretch). Folded in here so startFrame/endFrame
            // and the initial position stay consistent with voice.reversed.
            const bool freeReverse = track.freeRateEnabled && !track.useTimeStretch
                && track.playbackMode == 0 && track.freeRate < 0.0;   // REG-only (see freeActive)
            const bool effectiveReversed =
                track.reversed ^ perStepRev ^ track.playbackDirectionBackward ^ freeReverse
                ^ snapshot.reverseTransport;

            if (effectiveReversed) {
                voiceIterator->endFrame   = sampleEnd;
                voiceIterator->startFrame = findNearestZeroCrossing(sample, sampleStart);
            } else {
                voiceIterator->startFrame = findNearestZeroCrossing(sample, sampleStart);
                voiceIterator->endFrame   = sampleEnd;
            }

            // Sample-mode consolidation: REG + stretch → stretch the sample to fill the (extended)
            // cell. playbackMode 0 = regular; distinct from per-track time-stretch (useTimeStretch).
            // Map the whole trimmed sample (startFrame..endFrame) onto cellLen × framesPerStep output
            // frames. time+pitch = varispeed (rate); time-only = the per-voice stretcher (rbTimeRatio).
            const bool stretchToCell = (track.playbackMode == 0) && track.stretchEnabled
                && !track.useTimeStretch && state.currentFramesPerStep > 0;
            double stretchCellRate  = 1.0;   // varispeed: source frames per output frame (time+pitch)
            double stretchCellRatio = 1.0;   // stretcher: output/input (time-only, pitch preserved)
            if (stretchToCell) {
                const std::size_t scLen = (!track.cellLengths.empty() && step < track.cellLengths.size())
                    ? std::max<std::size_t>(1, track.cellLengths[step]) : 1;
                // Same pattern-advance correction as the cell-cap below: one localStep occupies
                // framesPerStep / (multiplier × freeRate) output frames, so a slowed-down cell is
                // longer and the sample must stretch to fill it (otherwise it cuts off early).
                const double scAdvance = std::max(0.0001,
                    std::max(0.0001, track.patternSpeedMultiplier)
                    * (freeActive ? std::abs(freeRateMagForCap) : 1.0));
                const double cellOutputFrames = static_cast<double>(scLen)
                    * static_cast<double>(state.currentFramesPerStep) / scAdvance;
                const double naturalSpan = (voiceIterator->endFrame > voiceIterator->startFrame)
                    ? static_cast<double>(voiceIterator->endFrame - voiceIterator->startFrame) : 0.0;
                if (naturalSpan > 0.0 && cellOutputFrames > 0.0) {
                    stretchCellRate  = naturalSpan / cellOutputFrames;
                    stretchCellRatio = cellOutputFrames / naturalSpan;
                }
            }

            // Sample-mode consolidation: loop-window wrap. OWN+loop = continuous; REG+loop loops the
            // window too (cell-binding / per-cell pitch refinements are a follow-up). The window
            // defaults to the full trimmed sample; the cell-cap is skipped so the window isn't shrunk.
            const bool loopWrap = (track.playbackMode == 2)   // legacy standalone .loop
                || (track.loopEnabled && (track.playbackMode == 0 || track.playbackMode == 3));

            // Phase 6: cap endFrame to cell duration.
            // Skipped for stretch-to-cell and loop: those manage the voice span themselves.
            // REG mode (playbackMode 0): the cell length defines the playback window, so cap even a
            // single-step cell to one step — otherwise an isolated REG hit rings out the whole sample
            // like owner mode (wrong). Other modes (owner, etc.) keep the cellLen>1-only behavior so
            // their single cells still play the full sample.
            if (!track.cellLengths.empty() && step < track.cellLengths.size()
                && !stretchToCell && !loopWrap) {
                const std::size_t cellLen = std::max<std::size_t>(1, track.cellLengths[step]);
                if ((cellLen > 1 || track.playbackMode == 0) && state.currentFramesPerStep > 0) {
                    // baseRate here is the output/input time ratio used to map the cell's
                    // output duration back to a source-frame span (cellFrames / baseRate).
                    // melodic-pitch (no TS): 1:1 time. timeStretch: time ratio = 1/multiplier
                    // (2x multiplier plays faster/shorter, pitch preserved — matches legacy
                    // SampleBank.getTimeStretchedBuffer where timePitch.rate = multiplier and
                    // output length = 1/multiplier). Must stay in lock-step with the per-voice
                    // rbTimeRatio assigned below.
                    double baseRate;
                    if (willUseRB && !track.useTimeStretch)
                        baseRate = 1.0;
                    else if (willUseRB && track.useTimeStretch)
                        baseRate = std::max(0.0001, 1.0 / track.speedMultiplier);
                    else
                        // Non-RB varispeed: the voice consumes (pitchRate × speedMultiplier ×
                        // externalVarispeed) SOURCE frames per OUTPUT frame (see voice.rate below).
                        // baseRate is an output/input ratio (cellFrames / baseRate = source span),
                        // so it must be the RECIPROCAL of that consumption rate — otherwise a
                        // pitched-up extended cell caps its source span too short and falls silent
                        // partway through the cell (bug). externalVarispeed is folded in here since
                        // voice.rate carries it for non-RB voices (the willUseRB fold below is for
                        // the stretcher feed only and does not apply to this branch).
                        baseRate = std::max(0.0001,
                            1.0 / std::max(0.0001, pitchRate * track.speedMultiplier
                                                   * snapshot.externalVarispeedRatio));
                    // Phase A: DJ TP / varispeed makes a stretched (RB/SS) voice consume its
                    // source proportionally faster (the deck plays the whole sample faster), so
                    // the cell maps onto a larger source span. Fold externalVarispeedRatio into the
                    // mapping for RB/SS voices so the cell end is capped at the right length. (The
                    // non-RB branch carries varispeed via voice.rate, not the stretcher feed.)
                    if (willUseRB && snapshot.externalVarispeedRatio != 1.0)
                        baseRate = std::max(0.0001,
                            baseRate / std::max(0.0001, snapshot.externalVarispeedRatio));
                    // The cell's OUTPUT duration is cellLen localSteps, but ONE localStep is not one
                    // master step's worth of frames when the pattern playhead is sped up or slowed
                    // down. Locked: the playhead advances patternSpeedMultiplier localSteps per master
                    // step (so /2 = a localStep lasts 2× framesPerStep). Free rate: it advances
                    // effRate × multiplier localSteps per master step. Without this the cap clamps the
                    // source span to one step at 1× and the sample cuts off partway through a
                    // slowed-down cell (the reported REG-multiply / free-rate bug). patternAdvance =
                    // localSteps consumed per framesPerStep of output; cell output = cellLen / advance.
                    const double patternAdvance = std::max(0.0001,
                        std::max(0.0001, track.patternSpeedMultiplier)
                        * (freeActive ? std::abs(freeRateMagForCap) : 1.0));
                    const double cellOutputFrames =
                        static_cast<double>(cellLen * state.currentFramesPerStep) / patternAdvance;
                    const auto cellLimitSampleFrames = static_cast<std::size_t>(
                        cellOutputFrames / baseRate);
                    const std::size_t cellLimitEnd = voiceIterator->startFrame + cellLimitSampleFrames;
                    if (voiceIterator->endFrame > cellLimitEnd) {
                        voiceIterator->endFrame = cellLimitEnd;
                    }
                }
            }

            // Sample-mode consolidation: configure loop-window wrap + owner gate/attack envelope.
            if (loopWrap && !effectiveReversed) {
                voiceIterator->loopWrapEnabled = true;
                // Window defaults to the full trimmed sample; honor Ls/Le when set (ms → frames).
                std::size_t ls = voiceIterator->startFrame;
                std::size_t le = voiceIterator->endFrame;
                if (track.loopStartMs > 0.0) {
                    const auto f = static_cast<std::size_t>(track.loopStartMs / 1000.0 * sampleRate);
                    if (f > ls && f < le) ls = f;
                }
                if (track.loopEndMs > 0.0) {
                    const auto f = static_cast<std::size_t>(track.loopEndMs / 1000.0 * sampleRate);
                    if (f > ls && f <= voiceIterator->endFrame) le = f;
                }
                voiceIterator->loopStartFrame = ls;
                voiceIterator->loopEndFrame   = le;
            }
            // Owner gate/attack apply to OWN voices (playbackMode 3), incl. OWN+loop.
            if (track.playbackMode == 3 && (track.ownerModeGate > 0.0f || track.ownerModeAttack > 0.0f)) {
                voiceIterator->ownerEnvelope  = true;
                voiceIterator->ownerGatePct   = track.ownerModeGate;
                voiceIterator->ownerAttackPct = track.ownerModeAttack;
            }

            // Micro beat-repeat sub-1 positioning happens AFTER the Phase-11 stretch decision and
            // the mid-cell entry below — it needs the resolved rate/feed mode to map the timeline
            // sub-cell into source frames, and it composes on top of a mid-cell entry offset.
            const std::size_t initialPosition = effectiveReversed
                ? voiceIterator->endFrame - 1
                : voiceIterator->startFrame;
            voiceIterator->position = static_cast<double>(
                findDirectionalZeroCrossing(sample, initialPosition, effectiveReversed));

            // Phase 11: determine if RubberBand is needed
            {
                const bool djStretch = snapshot.djTimeStretchActive
                    && snapshot.djTimeStretchRatio != 1.0;
                bool needsRB = false;
                double rbTimeRatio  = 1.0;
                double rbPitchScale = 1.0;

                if (track.useTimeStretch && track.speedMultiplier != 1.0) {
                    needsRB    = true;
                    // timeRatio = output/input = 1/multiplier so a 2x multiplier plays the
                    // sample faster/shorter (pitch preserved), matching legacy.
                    rbTimeRatio = 1.0 / track.speedMultiplier;
                    // Per-step pitch in TS mode is a pitch-shift (transpose), independent of the
                    // time-stretch — otherwise a TS cell's individual pitch was dropped.
                    if (semitones != 0.0) rbPitchScale = std::pow(2.0, semitones / 12.0);
                }
                if (track.melodicPitchMode && semitones != 0.0) {
                    needsRB     = true;
                    rbPitchScale = std::pow(2.0, semitones / 12.0);
                    if (!track.useTimeStretch) rbTimeRatio = 1.0;
                }
                if (melodicMultiStepCell) {
                    // Origin pitch may be 0 but a later sub-step pitched — take the melodic path
                    // so the streamed extension-step transpose is applied.
                    needsRB = true;
                    if (!track.useTimeStretch) rbTimeRatio = 1.0;
                }
                if (djStretch) {
                    needsRB    = true;
                    rbTimeRatio = snapshot.djTimeStretchRatio;
                    if (!track.melodicPitchMode || semitones == 0.0) rbPitchScale = 1.0;
                }

                // Phase 5b: Signalsmith per-voice handles melodic pitch AND per-track
                // time-stretch. DJ tempo sync is the per-deck bus, so the per-voice djStretch
                // path is intentionally ignored here (avoids double tempo application).
                needsRB = (track.melodicPitchMode && semitones != 0.0)
                       || (track.useTimeStretch && track.speedMultiplier != 1.0)
                       || melodicMultiStepCell
                       || (stretchToCell && track.stretchTimeOnly);   // REG+stretch, pitch-preserving
                // timeRatio = output/input = 1/multiplier so a 2x multiplier plays the sample
                // faster/shorter (pitch preserved), matching legacy getTimeStretchedBuffer.
                // REG+stretch time-only: ratio maps the sample onto the cell's output duration.
                rbTimeRatio  = (stretchToCell && track.stretchTimeOnly)
                             ? stretchCellRatio
                             : ((track.useTimeStretch && track.speedMultiplier != 1.0)
                                ? 1.0 / track.speedMultiplier : 1.0);
                // Per-step pitch is a transpose for melodic AND time-stretch voices (TS preserves
                // time, so the cell's pitch must come from the stretcher's transpose, not the rate).
                rbPitchScale = ((track.melodicPitchMode || track.useTimeStretch) && semitones != 0.0)
                             ? std::pow(2.0, semitones / 12.0) : 1.0;

                // DJ TP / varispeed (.timeAndPitchTempo): the whole deck shifts pitch AND tempo
                // together (a turntable — coupled pitch+time resample). The two backends differ:
                //  * Signalsmith (Phase A): apply it as a CLEAN resample of the source FEED
                //    (voice.varispeedRate, consumed in the produceIntoRing loop), keeping the
                //    per-voice stretcher dedicated to melodic transpose / per-track stretch only —
                //    TP is layered on top, independent, with no phase-vocoder turntable artifacts.
                //    The post-stretch voice output (hence the send taps) carries the pitched signal.
                //  * RubberBand fallback: its streaming feed can't resample, so keep the legacy
                //    fold (pitch ×ratio, time ÷ratio) so melodic/stretch voices still follow pitch.
                // externalVarispeedRatio is 1.0 outside TP mode (and in TS mode) → no-op there.
                //
                // Per-track T+P (.timeAndPitch) multiplier is ALSO a varispeed of the sample (both
                // time and pitch — a 2x track plays an octave up at double tempo). Non-RB voices
                // already fold it into voice.rate; RB voices (melodic / per-track stretch) would
                // otherwise DROP it, so a melodic T+P track ignored the multiplier. Fold it into the
                // same varispeed path. It applies ONLY in T+P: useTimeStretch carries its multiplier
                // via rbTimeRatio, and timeOnly sends speedMultiplier == 1.
                const double tpMult = (!track.useTimeStretch && track.speedMultiplier != 1.0)
                    ? track.speedMultiplier : 1.0;
                const double varispeed = snapshot.externalVarispeedRatio * tpMult;
                double voiceVarispeedRate = 1.0;
                if (needsRB && varispeed != 1.0) {
                    voiceVarispeedRate = std::max(0.0001, varispeed);
                }

                voiceIterator->useRubberBand = needsRB;
                if (needsRB) {
                    // Melodic voices (explicit per-step pitch or streamed multi-step pitch) get
                    // the HQ bank — big window, warble-free tonal shift. Percussive time-stretch
                    // and REG stretch-to-cell stay on the standard short window (tight transients).
                    const bool wantHQ = (track.melodicPitchMode && semitones != 0.0)
                                     || melodicMultiStepCell;
                    const int slot = voiceStretchPool_.checkout(rbTimeRatio, rbPitchScale, wantHQ,
                                                                track.preserveFormants);
                    voiceIterator->rubberBandSlot         = slot;
                    voiceIterator->varispeedRate          = voiceVarispeedRate;
                    voiceIterator->rbInputConsumed        = voiceIterator->startFrame;
                    voiceIterator->rbSourcePos            = effectiveReversed
                        ? static_cast<double>(voiceIterator->endFrame > 0 ? voiceIterator->endFrame - 1 : 0)
                        : static_cast<double>(voiceIterator->startFrame);
                    voiceIterator->rbOutputAvailable      = 0;
                    voiceIterator->rbFinalized            = false;
                    voiceIterator->rbTimeRatio            = rbTimeRatio;
                    // If pool is exhausted, fall back gracefully to varispeed
                    if (slot < 0) {
                        voiceIterator->useRubberBand          = false;
                        voiceIterator->rbLatencySkipRemaining = 0;
                        voiceIterator->rate = std::max(0.0001,
                            pitchRate * track.speedMultiplier * snapshot.externalVarispeedRatio);
                    } else {
                        voiceIterator->rbLatencySkipRemaining = voiceStretchPool_.latencyFrames(slot);
                        voiceIterator->rate             = 1.0;
                        voiceIterator->rbBasePitchScale = rbPitchScale;
                        // Prime the stretcher with source pre-roll so the first audible frame is
                        // full-quality (no cold-start transient), then fade in over a few ms.
                        primeStretchVoice(slot, sample, voiceIterator->startFrame,
                                          voiceIterator->endFrame, effectiveReversed,
                                          rbTimeRatio > 0.0 ? 1.0 / rbTimeRatio : 1.0);
                        voiceIterator->rbAttackFadeRemaining = rbAttackFadeTotal_;
                        // RB pitch glide: ramp from previous voice's pitch scale to the new one.
                        // Chord: root only — gliding a sibling from the root's previous pitch
                        // would smear the voicing; siblings start on their target interval.
                        if (chordNi == 0
                            && prevRbPitchScaleForGlide > 0.0
                            && prevRbPitchScaleForGlide != rbPitchScale
                            && stepWantsGlide
                            && state.currentFramesPerStep > 0) {
                            voiceIterator->rbGlideSourcePitchScale  = prevRbPitchScaleForGlide;
                            voiceIterator->rbGlideTargetPitchScale  = rbPitchScale;
                            voiceIterator->rbGlideTotalFrames       = static_cast<std::uint32_t>(
                                state.currentFramesPerStep
                                    * std::clamp(track.glidePercentBetweenSteps / 100.0, 0.0, 1.0));
                            voiceIterator->rbGlideFramesRemaining   = voiceIterator->rbGlideTotalFrames;
                        } else {
                            voiceIterator->rbGlideTotalFrames     = 0;
                            voiceIterator->rbGlideFramesRemaining = 0;
                        }
                        // Reg-mode extension-step pitch streaming for MELODIC voices: a multi-step
                        // cell's per-sub-step melodic transpose is streamed in the per-callback
                        // pre-render pass. Within-cell pitch walk owns the sub-step transitions, so
                        // suppress the inter-trigger transpose glide set above (don't let them fight).
                        if (!track.cellLengths.empty() && step < track.cellLengths.size()
                            && track.cellLengths[step] > 1) {
                            voiceIterator->cellLengthSteps        = static_cast<std::uint32_t>(track.cellLengths[step]);
                            voiceIterator->cellOriginStep         = step;
                            voiceIterator->cellElapsedFrames      = 0;
                            voiceIterator->rbGlideTotalFrames     = 0;
                            voiceIterator->rbGlideFramesRemaining = 0;
                        }
                    }
                } else {
                    voiceIterator->rubberBandSlot = -1;
                    // Parity Gap A: apply classic varispeed ratio (.timeAndPitchTempo) to voice rate
                    voiceIterator->rate = std::max(0.0001,
                        pitchRate * track.speedMultiplier * snapshot.externalVarispeedRatio);

                    // REG+stretch, time+pitch: override the rate so the whole sample is consumed
                    // over the cell's output duration (varispeed — pitch follows the stretch).
                    if (stretchToCell) {
                        voiceIterator->rate = std::max(0.0001,
                            stretchCellRate * snapshot.externalVarispeedRatio);
                    }

                    // Reg-mode extension-step pitch streaming: a multi-step regular cell plays as
                    // ONE varispeed voice; stream the per-sub-step pitch (and glide between them)
                    // live by ramping the rate as the cell advances (see NativeRenderVoice).
                    // Only the varispeed branch (this else) needs it — melodic/TS go through the
                    // stretcher and are handled at the trigger pitch for now. Stretch keeps a
                    // constant rate, so its per-cell pitch streaming is intentionally skipped.
                    if (!track.cellLengths.empty() && step < track.cellLengths.size()
                        && track.cellLengths[step] > 1 && !stretchToCell) {
                        voiceIterator->cellLengthSteps  = static_cast<std::uint32_t>(track.cellLengths[step]);
                        voiceIterator->cellOriginStep   = step;
                        voiceIterator->cellElapsedFrames = 0;
                        voiceIterator->cellRateScale    = std::max(0.0001,
                            track.speedMultiplier * snapshot.externalVarispeedRatio);
                        // Within-cell glide owns the sub-step transitions; suppress the
                        // inter-trigger rate glide so the two don't fight.
                        voiceIterator->glideSourceRate    = 0.0;
                        voiceIterator->glideFramesRemaining = 0;
                        voiceIterator->glideTotalFrames   = 0;
                    }
                }
            }

            // Mid-cell entry: this voice was triggered from the owner because playback jumped into
            // the middle of an extended reg cell (locator/beat-repeat loop or skip-step). Advance the
            // playback position to where the sample would be sounding now, and resume the per-sub-step
            // pitch walk at the right sub-step so pitch/glide stay continuous. Reg variants only.
            if (cellEntry && entryStepOffset > 0 && state.currentFramesPerStep > 0) {
                const double fps = static_cast<double>(state.currentFramesPerStep);
                const std::size_t srcStart = voiceIterator->startFrame;
                const std::size_t srcEnd   = voiceIterator->endFrame;
                const double span = (srcEnd > srcStart)
                    ? static_cast<double>(srcEnd - srcStart) : 0.0;
                double offsetFrames = 0.0;

                if (stretchToCell) {
                    // Whole sample mapped onto cellLen output frames → proportional position.
                    const std::size_t cellLen =
                        (!track.cellLengths.empty() && entryOriginStep < track.cellLengths.size())
                            ? std::max<std::size_t>(1, track.cellLengths[entryOriginStep]) : 1;
                    offsetFrames = span
                        * (static_cast<double>(entryStepOffset) / static_cast<double>(cellLen));
                } else if (voiceIterator->useRubberBand) {
                    // Melodic / time-stretch: the feed advances at the varispeed feed rate; per-sub-step
                    // pitch is applied as a transpose (driven by cellElapsedFrames), not source rate.
                    offsetFrames = static_cast<double>(entryStepOffset) * fps
                        * std::max(0.0001, voiceIterator->varispeedRate);
                } else if (switchResumeOwnEntry) {
                    // OWN single-step long sample: the whole sample plays at the owner's constant rate
                    // (no per-step pitch walk — OWN has no cell sub-steps). Advance the source by the
                    // elapsed output frames at that rate. OWN+loop wraps below; OWN one-shot clamps.
                    offsetFrames = static_cast<double>(entryStepOffset) * fps
                        * std::max(0.0001, voiceIterator->rate);
                } else {
                    // Plain varispeed reg cell: integrate the per-sub-step playback rate (pitch walk),
                    // matching the live streaming in cellStreamSemitone / the position advance loop.
                    const std::size_t nSteps = track.pitchOffsets.size();
                    for (std::uint32_t s = 0; s < entryStepOffset; ++s) {
                        double semi = 0.0;
                        if (nSteps > 0) {
                            const std::size_t idx = (entryOriginStep + s) % nSteps;
                            semi = scoopy::tunedSemitones((track.globalPitchOffset + track.pitchOffsets[idx]) / 2.0
                                                              + chordIvs[chordNi], track.tuningIndex)
                                 + track.fineTuneCents / 100.0;
                        }
                        const double rate = std::pow(2.0, semi / 12.0) * voiceIterator->cellRateScale;
                        offsetFrames += fps * std::max(0.0001, rate);
                    }
                }

                if (voiceIterator->loopWrapEnabled) {
                    // Reg+loop: wrap the accumulated offset into the loop window.
                    const double ls = static_cast<double>(voiceIterator->loopStartFrame);
                    const double le = static_cast<double>(voiceIterator->loopEndFrame);
                    const double loopSpan = (le > ls) ? (le - ls) : 0.0;
                    double pos = static_cast<double>(srcStart) + offsetFrames;
                    if (loopSpan > 0.0 && pos > le) {
                        pos = ls + std::fmod(pos - le, loopSpan);
                    }
                    offsetFrames = pos - static_cast<double>(srcStart);
                } else if (span > 0.0) {
                    // One-shot: clamp inside the sample.
                    offsetFrames = std::min(offsetFrames, span - 1.0);
                }
                offsetFrames = std::max(0.0, offsetFrames);

                const double newPos = static_cast<double>(srcStart) + offsetFrames;
                voiceIterator->position          = newPos;
                voiceIterator->cellElapsedFrames =
                    static_cast<std::uint64_t>(entryStepOffset) * state.currentFramesPerStep;
                if (voiceIterator->useRubberBand) {
                    voiceIterator->rbInputConsumed = static_cast<std::size_t>(newPos);
                    voiceIterator->rbSourcePos     = newPos;
                }
            }

            // Micro beat-repeat sub-1 positioning (timeline-domain): the window is the k-th of
            // `subdivision` equal OUTPUT-TIME sub-cells of the step, positioned by
            // beatRepeatStartSubcell. The sub-cell is mapped into source frames at THIS voice's
            // consumption rate (mirroring the mid-cell entry branches above), so the repeat period
            // is tempo-locked for short one-shots, multi-step cells, and pitched/stretched slices
            // alike — never derived from the slice's content length. Offsets are applied ON TOP of
            // the position established above (mid-cell entry included). Two realizations:
            //  - roll (coarse, handled by brMicroHit sub-ticks): hard re-trigger seeded at the
            //    sub-cell's source offset; the next sub-tick's self-cut ends the window at exactly
            //    the sub-cell duration, so no loop window is set here.
            //  - grain (fine): one voice loops the sub-cell's source window under the Tukey seam
            //    envelope (the RB feed honors a non-onset loopStartFrame).
            // True-timeline semantics: a sub-cell positioned past the slice's content is SILENCE
            // (the slice would not have been sounding there), not a fold back into the content.
            // Forward only — reversed micro falls back to per-step playback (rare combo).
            if (brMicroActive && !effectiveReversed && state.currentFramesPerStep > 0) {
                const double fps  = static_cast<double>(state.currentFramesPerStep);
                const std::size_t sub = std::max<std::size_t>(1, snapshot.beatRepeatSubdivision);
                const std::size_t k   = std::min<std::size_t>(snapshot.beatRepeatStartSubcell, sub - 1);
                const std::size_t srcStart = voiceIterator->startFrame;
                const std::size_t srcEnd   = voiceIterator->endFrame;
                const double span = (srcEnd > srcStart)
                    ? static_cast<double>(srcEnd - srcStart) : 0.0;
                // Source frames consumed per OUTPUT frame (the mid-cell entry mapping):
                // stretch-to-cell spreads the whole sample over the cell's output duration; the
                // stretcher feed advances at the varispeed stride; plain voices at the sampler rate.
                double srcPerOut;
                if (stretchToCell) {
                    const std::size_t cellLen =
                        (!track.cellLengths.empty() && step < track.cellLengths.size())
                            ? std::max<std::size_t>(1, track.cellLengths[step]) : 1;
                    srcPerOut = span / (fps * static_cast<double>(cellLen));
                } else if (voiceIterator->useRubberBand) {
                    srcPerOut = std::max(0.0001, voiceIterator->varispeedRate);
                } else {
                    srcPerOut = std::max(0.0001, voiceIterator->rate);
                }
                const double subSrcLen = (fps / static_cast<double>(sub)) * srcPerOut;
                const double subSrcOff = static_cast<double>(k) * subSrcLen;
                const double basePos   = voiceIterator->position;   // srcStart or mid-cell entry
                const double windowPos = basePos + subSrcOff;
                if (span <= 0.0 || windowPos >= static_cast<double>(srcEnd)) {
                    // Silent sub-cell: kill the just-initialized voice with the immediate-fade
                    // idiom so voice bookkeeping stays consistent.
                    voiceIterator->stopping = true;
                    voiceIterator->fadeFramesRemaining = 1;
                } else if (brMicroWindowed) {
                    std::size_t gStart = static_cast<std::size_t>(std::llround(windowPos));
                    std::size_t gLen   = std::max<std::size_t>(2,
                        static_cast<std::size_t>(std::llround(subSrcLen)));
                    if (gStart >= srcEnd && srcEnd > 2) gStart = srcEnd - 2;
                    // A window overrunning the trimmed content clamps (its period shortens slightly)
                    // rather than reading past the trim — accepted at these <~12ms sizes.
                    if (srcEnd > gStart) gLen = std::min(gLen, srcEnd - gStart);
                    gLen = std::max<std::size_t>(2, gLen);
                    voiceIterator->loopWrapEnabled    = true;
                    voiceIterator->loopStartFrame     = gStart;
                    voiceIterator->loopEndFrame       = gStart + gLen;
                    voiceIterator->grainWindowEnabled = true;
                    voiceIterator->grainWindowStart   = gStart;
                    voiceIterator->grainWindowLen     = gLen;
                    voiceIterator->grainStepSrcLen    = fps * srcPerOut;
                    voiceIterator->grainBasePos       = basePos;
                    // A window starting at the slice onset keeps its raw attack on the first pass
                    // (grainWrapped=false skips the leading Tukey taper once); a mid-content start
                    // has no transient to preserve and needs the taper as a declick from cycle one.
                    voiceIterator->grainWrapped = (gStart > srcStart);
                    // Seed inside the window; snap to a zero crossing but never past mid-window.
                    std::size_t seed = findDirectionalZeroCrossing(sample, gStart, false);
                    seed = std::min(seed, gStart + gLen / 2);
                    voiceIterator->position = static_cast<double>(seed);
                    if (voiceIterator->useRubberBand) {
                        voiceIterator->rbInputConsumed = seed;
                        voiceIterator->rbSourcePos     = static_cast<double>(seed);
                    }
                } else if (k > 0) {
                    // Roll with a positioned window: seed this (sub-tick or step-boundary) attack
                    // at the sub-cell's source offset. k == 0 keeps the untouched onset seed.
                    const std::size_t seed = findDirectionalZeroCrossing(
                        sample, static_cast<std::size_t>(std::llround(windowPos)), false);
                    voiceIterator->position = static_cast<double>(seed);
                    if (voiceIterator->useRubberBand) {
                        voiceIterator->rbInputConsumed = seed;
                        voiceIterator->rbSourcePos     = static_cast<double>(seed);
                    }
                }
            }

            voiceIterator->baseVolume      = effVolume;
            // Carry accent×humanize so reg-mode extension-step volume streaming (cellStreamVolume)
            // can reapply it on top of each sub-step's additive volume.
            voiceIterator->cellVolMult     = accentMult * humanizeVolMult;
            voiceIterator->basePan         = effPan;
            // Decomposed bake for the live-ramped bases: audible = (base + add) × cellVolMult
            // (volume) / (base + add) (pan/tone), recomposed per frame when the live base moves.
            voiceIterator->volAdd          = stepVolOff + stepMixOff;
            voiceIterator->panAdd          = stepPanOff;
            voiceIterator->bakedVolBase    = track.volume;
            voiceIterator->bakedPanBase    = track.pan;
            voiceIterator->bakedToneBase   = track.tone;
            voiceIterator->bakedPitchBase  = static_cast<float>(track.globalPitchOffset);
            voiceIterator->basePitchSemitones = semitones;
            voiceIterator->chordIntervalSemitones = chordIvs[chordNi];
            voiceIterator->leftGain        = effVolume * std::sqrt(0.5f * (1.0f - effPan));
            voiceIterator->rightGain       = effVolume * std::sqrt(0.5f * (1.0f + effPan));
            // Send levels + per-step send automation (additive offset on this step, clamped 0…1).
            // Lets a single hit be routed to a plugin/FX send without riding the live fader.
            {
                const float s1Off = step < track.send1Offsets.size() ? track.send1Offsets[step] : 0.0f;
                const float s2Off = step < track.send2Offsets.size() ? track.send2Offsets[step] : 0.0f;
                const float s3Off = step < track.send3Offsets.size() ? track.send3Offsets[step] : 0.0f;
                const float s4Off = step < track.send4Offsets.size() ? track.send4Offsets[step] : 0.0f;
                voiceIterator->send1Level  = std::clamp(track.send1Level + s1Off, 0.0f, 1.0f);
                voiceIterator->send2Level  = std::clamp(track.send2Level + s2Off, 0.0f, 1.0f);
                voiceIterator->send3Level  = std::clamp(track.send3Level + s3Off, 0.0f, 1.0f);
                voiceIterator->send4Level  = std::clamp(track.send4Level + s4Off, 0.0f, 1.0f);
                // The tap adds these to the ramped live slider base (sendNLevel above is the
                // fallback total for tracks beyond the live-control range).
                voiceIterator->sendOffset[0] = s1Off;
                voiceIterator->sendOffset[1] = s2Off;
                voiceIterator->sendOffset[2] = s3Off;
                voiceIterator->sendOffset[3] = s4Off;
            }
            voiceIterator->stereoMode      = track.stereoMode;
            voiceIterator->trackIndex      = static_cast<std::uint32_t>(trackIndex);
            voiceIterator->chokeGroup      = track.chokeGroup;
            voiceIterator->reversed        = effectiveReversed;

            // Phase 2: LFO depths
            voiceIterator->lfo1PitchDepth   = track.lfo1PitchDepth;
            voiceIterator->lfo2PitchDepth   = track.lfo2PitchDepth;
            voiceIterator->lfo1VolDepth     = track.lfo1VolDepth;
            voiceIterator->lfo2VolDepth     = track.lfo2VolDepth;
            voiceIterator->lfo1PanDepth     = track.lfo1PanDepth;
            voiceIterator->lfo2PanDepth     = track.lfo2PanDepth;
            voiceIterator->lfo1FilterDepth  = track.lfo1FilterDepth;
            voiceIterator->lfo2FilterDepth  = track.lfo2FilterDepth;
            voiceIterator->hasLfoModulation = (track.lfo1PitchDepth != 0.0f || track.lfo2PitchDepth != 0.0f
                || track.lfo1VolDepth != 0.0f || track.lfo2VolDepth != 0.0f
                || track.lfo1PanDepth != 0.0f || track.lfo2PanDepth != 0.0f
                || track.lfo1FilterDepth != 0.0f || track.lfo2FilterDepth != 0.0f);

            // Phase 3: envelope
            {
                const std::size_t totalFrames = voiceIterator->endFrame - voiceIterator->startFrame;
                if (track.attackPercent > 0.0 && totalFrames > 0) {
                    const auto attackFrames = static_cast<std::size_t>(
                        totalFrames * std::clamp(track.attackPercent / 100.0, 0.0, 1.0));
                    voiceIterator->attackEndFrame = voiceIterator->startFrame + attackFrames;
                }
                if (track.releasePercent > 0.0 && totalFrames > 0) {
                    const auto releaseFrames = static_cast<std::size_t>(
                        totalFrames * std::clamp(track.releasePercent / 100.0, 0.0, 1.0));
                    voiceIterator->releaseStartFrame = voiceIterator->endFrame > releaseFrames
                        ? voiceIterator->endFrame - releaseFrames : voiceIterator->startFrame;
                }
                voiceIterator->fadeCurveExp = static_cast<float>(std::max(0.1, track.fadeCurve));
            }

            // Phase 5: glide (skip for RB voices — rate is fixed at 1.0, glide has no effect)
            // Chord: root only — siblings start on their target interval (see RB glide above).
            {
                const double targetRate = voiceIterator->rate;
                if (chordNi == 0 && !voiceIterator->useRubberBand && prevRateForGlide > 0.0
                    && prevRateForGlide != targetRate && stepWantsGlide) {
                    voiceIterator->glideSourceRate = prevRateForGlide;
                    voiceIterator->glideTotalFrames = static_cast<std::uint32_t>(
                        state.currentFramesPerStep
                            * std::clamp(track.glidePercentBetweenSteps / 100.0, 0.0, 1.0));
                    voiceIterator->glideFramesRemaining = voiceIterator->glideTotalFrames;
                }
            }

            // Phase 6: pre-silence delay (+ smart swing on the same delay path)
            {
                const double stepPreSilenceOff = step < track.preSilenceMsOffsets.size()
                    ? track.preSilenceMsOffsets[step] : 0.0;
                const double totalPreSilenceMs = track.preSilenceMs + stepPreSilenceOff;
                std::uint32_t silenceFrames = totalPreSilenceMs > 0.0
                    ? static_cast<std::uint32_t>(std::max(0.0, totalPreSilenceMs / 1000.0 * sampleRate))
                    : 0u;
                // Smart swing: push every odd onset late by a fraction of the local-onset
                // interval. Tempo-relative (scales with framesPerStep), so the groove holds
                // across BPM changes; manual pre-silence still adds on top.
                //
                // Both the parity and the magnitude are keyed to the LOCAL onset grid, not the
                // master 16th, so swing stays correct under pattern multipliers:
                //   • parity uses localStep (the monotonic onset index), not the wrapped pattern
                //     `step` — otherwise an odd-length pattern flips which steps swing every cycle,
                //     and a multiplier shifts which onsets count as "off-beat".
                //   • the delay scales by the local onset interval framesPerStep / multiplier, so
                //     at amount=1 an off-beat onset is pushed half-way to the next onset regardless
                //     of multiplier (at M=2 the old code pushed a full sub-step → collisions).
                if (track.swingAmount > 0.0 && (localStep % 2) == 1 && state.currentFramesPerStep > 0) {
                    constexpr double kSwingMaxFraction = 0.5; // amount=1 → half an onset interval late
                    const double swingMultiplier = std::clamp(track.patternSpeedMultiplier, 0.001, 16.0);
                    const double localFramesPerStep =
                        static_cast<double>(state.currentFramesPerStep) / swingMultiplier;
                    silenceFrames += static_cast<std::uint32_t>(std::llround(
                        localFramesPerStep
                            * std::clamp(track.swingAmount, 0.0, 1.0) * kSwingMaxFraction));
                }
                if (silenceFrames > 0) {
                    voiceIterator->preSilenceFramesRemaining = silenceFrames;
                }
            }

            // Rate morph: bake the pattern multiplier this voice triggers under. Set at the
            // guaranteed finalization (voices are pooled — a stale previous-life value would
            // corrupt the morph ratio). Mid-morph voices bake the snapshot's landed target;
            // the per-frame morphM/bakedPatternMult ratio bends them to the instantaneous
            // glide value, converging to exactly 1 at landing.
            voiceIterator->bakedPatternMult = std::clamp(track.patternSpeedMultiplier, 0.001, 16.0);
            voiceIterator->active = true;
            // Stamp trigger order so the UI playhead can find the voice you last heard START,
            // rather than whichever the round-robin allocator left earliest in the array.
            voiceIterator->triggerSerial = ++state.voiceTriggerSerial;
            // Root only: arm the onset-deferred choke / self-cut now that position, rate, RB
            // mapping and pre-silence are all final (a zero delay fires immediately, matching
            // the old trigger-time cut). Siblings share the root's cut.
            if (chordNi == 0) {
                armDeferredCut(state, *voiceIterator, wantGroupChoke, wantSelfCut, selfCutFade);
            }
            // Phase 8: track clipper
            voiceIterator->trackClipper.setParametersFromDrive(track.trackGain);

            // Phase 1: tone filter (base tone + per-step offset)
            {
                const float stepToneOff = step < track.toneOffsets.size() ? track.toneOffsets[step] : 0.0f;
                const float effectiveTone = std::clamp(track.tone + stepToneOff, -100.0f, 100.0f);
                voiceIterator->baseTone = effectiveTone;
                voiceIterator->toneAdd  = stepToneOff;
                voiceIterator->toneFilter.sampleRate = sampleRate;
                voiceIterator->toneFilter.reset();
                voiceIterator->toneFilter.setParameters(effectiveTone, track.toneQ, track.toneMode,
                                                track.filterDrive);
            }

            // Per-cell parameter glide: when the transition into this step glides, ramp tone/pan/
            // volume from the previous cell's values into this voice's targets over the same window
            // as the pitch glide. Only set up when something actually changed (else snap as before).
            // Chord: root only (siblings share the root's targets; ramping them all would double up).
            if (chordNi == 0 && stepWantsGlide && prevVolumeForGlide >= 0.0f && state.currentFramesPerStep > 0) {
                if (prevVolumeForGlide != voiceIterator->baseVolume
                    || prevPanForGlide  != voiceIterator->basePan
                    || prevToneForGlide != voiceIterator->baseTone) {
                    voiceIterator->glideSourceVolume = prevVolumeForGlide;
                    voiceIterator->glideSourcePan    = prevPanForGlide;
                    voiceIterator->glideSourceTone   = prevToneForGlide;
                    voiceIterator->glideParamTotalFrames = static_cast<std::uint32_t>(
                        state.currentFramesPerStep
                            * std::clamp(track.glidePercentBetweenSteps / 100.0, 0.0, 1.0));
                    voiceIterator->glideParamFramesRemaining = voiceIterator->glideParamTotalFrames;
                }
            }
            // One UI trigger event per cell, not per chord note.
            if (chordNi == 0) {
                if (state.triggerEventCount < NativeRenderState::maxTriggerEvents) {
                    state.triggerEvents[state.triggerEventCount++] = {
                        frame,
                        static_cast<std::uint32_t>(trackIndex),
                        static_cast<std::uint32_t>(step)
                    };
                } else {
                    ++state.triggerOverflowCount;
                }
            }

            } // chord spawn group
        }

        // Phase 2: compute global LFO values for this frame.
        //
        // LFO-DIV rework: the LFO is grid-LOCKED. Its phase is DERIVED from the musical grid
        // position (musical step + intra-step fraction) rather than free-integrated, so a cycle
        // always begins at musical step 0, effCycle, 2·effCycle… `effCycle` (grid steps, possibly
        // fractional) is resolved in Swift from the {cycleSteps, ratio, lcmMode} triple. On a
        // scene switch the anchor moves and the musical step resets to 0, re-anchoring the cycle.
        const std::uint64_t lfoMusicalStep = static_cast<std::uint64_t>(std::max<std::int64_t>(
            0, static_cast<std::int64_t>(state.masterStep) - state.patternAnchorStep));
        const double lfoGridPosSteps = static_cast<double>(lfoMusicalStep)
            + (state.currentFramesPerStep > 0
                ? static_cast<double>(state.stepFrame) / static_cast<double>(state.currentFramesPerStep)
                : 0.0);
        // MOD-12 AGITATION: the LFO is a grid-locked per-step value sequence (agitationValue).
        // `lfoNCycleSteps` is the PERIOD in grid steps (the "Length" — the sequence is that many
        // cells, and repeats every that many steps). `phaseOffset` shifts the grid position by that
        // fraction of the period. The UI phase is the position within ONE period, so the ModCanvas
        // draws exactly `period` cells with a riding playhead.
        auto agitationPhase = [&](double period) -> double {
            const double loop = agitationLoopSteps(period);
            const double p = lfoGridPosSteps / std::max(1e-6, loop);
            return p - std::floor(p);
        };
        auto agitationAt = [&](int ch, double period) -> double {
            const auto& mc = snapshot.modChannels[ch];
            return agitationValue(lfoGridPosSteps + mc.lfoPhaseOffset * std::max(1.0, period),
                                  period, mc.lfoEase, mc.lfoSlant, mc.lfoCyclic, mc.lfoJitter, ch);
        };
        const double lfo1Loop = agitationPhase(snapshot.lfo1CycleSteps);
        const double lfo2Loop = agitationPhase(snapshot.lfo2CycleSteps);
        // lfoNIsEnv = legacy envelope-FOLLOWER waveform → use the follower output (1-sample latency).
        // Otherwise the Agitation engine. Envelope-TYPE channels are overridden after the loop below.
        double lfo1Val = lfo1IsEnv ? static_cast<double>(state.lfo1EnvOutput)
                                   : agitationAt(0, snapshot.lfo1CycleSteps);
        double lfo2Val = lfo2IsEnv ? static_cast<double>(state.lfo2EnvOutput)
                                   : agitationAt(1, snapshot.lfo2CycleSteps);
        // Publish the PRE-depth analytic LFO/follower value for channels 0/1 into modChannelValue[0/1]
        // so the UI waveform monitor can read it via deckModChannelValue (Swift applies channel depth,
        // matching the legacy getCurrentLFO1/2Value semantics). The mod-channel loop below skips ch0/1
        // for LFO/follower (`if (ch < 2) break`) and nothing else consumes these slots in that mode, so
        // this is additive. When ch0/1 is an Envelope, the loop writes the envelope value into the same
        // slot (the correct monitor source for that mode) — so only publish here for non-Envelope types.
        if (snapshot.modChannels[0].type != NativeModChannelType::envelope)
            state.modChannelValue[0] = static_cast<float>(lfo1Val);
        if (snapshot.modChannels[1].type != NativeModChannelType::envelope)
            state.modChannelValue[1] = static_cast<float>(lfo2Val);
        // Publish the loop-position phase for the UI playhead; FREEZE when stopped. Agitation is
        // stateless (targets are hashed by segment index), so there is no per-cycle random reseed.
        if (snapshot.isPlaying) {
            if (snapshot.lfo1Waveform != NativeLfoWaveform::envelopeFollower) state.lfo1Phase = lfo1Loop;
            if (snapshot.lfo2Waveform != NativeLfoWaveform::envelopeFollower) state.lfo2Phase = lfo2Loop;
        }

        // Modulation overhaul: advance envelope-type mod channels and compute their per-frame
        // value (channels 0/1 keep using lfo1Val/lfo2Val directly). The gate (open + close frame)
        // is set in the trigger loop above from the source track's cell. Stage: 1 pre-sustain,
        // 2 sustain-hold (folded into 1's eval), 3 release, 0 idle.
        {
            const double msPerFrame = 1000.0 / sampleRate;
            // All channels compute Envelope here when type==envelope (so channels 0/1 gain
            // envelope too). LFO/Follower for channels 2/3 are computed here; channels 0/1 LFO/
            // Follower stay on the legacy lfo1Val/lfo2Val path (waveform-driven) above.
            for (int ch = 0; ch < kModChannelCount; ++ch) {
                const auto& mc = snapshot.modChannels[ch];
                switch (mc.type) {
                case NativeModChannelType::lfo: {
                    if (ch < 2) break;   // channels 0/1 use lfo1Val/lfo2Val (computed above)
                    // MOD-12 AGITATION — same per-step value sequence as ch0/1.
                    state.modChannelValue[ch] = static_cast<float>(agitationAt(ch, mc.lfoCycleSteps));
                    if (snapshot.isPlaying) state.modPhase[ch] = agitationPhase(mc.lfoCycleSteps);
                    break;
                }
                case NativeModChannelType::envFollower:
                    if (ch < 2) break;   // channels 0/1 use legacy lfo1Val/lfo2Val
                    // Output computed in the follower tail (1-sample latency), like lfo1/2.
                    state.modChannelValue[ch] = state.modFollowerOutput[ch];
                    break;
                case NativeModChannelType::envelope: {
                    const auto& env = mc.envelope;
                    if (state.modGatePendingTrigger[ch]) {
                        state.modEnvStage[ch]       = 1;
                        state.modEnvElapsedMs[ch]   = 0.0;
                        state.modGateCloseFrame[ch] = state.modPendingCloseFrame[ch];
                        state.modGatePendingTrigger[ch] = false;
                    }
                    // MOD-2d — BIPOLAR envelopes. The state machine stays entirely in the stored
                    // 0…1 space (so `modEnvReleaseStartValue` and the evaluators are unchanged);
                    // the reinterpretation happens once, at publish. Per the user's decision,
                    // **0.5 is the centre**: 0 → −1, 0.5 → 0, 1 → +1. That lets an envelope push a
                    // parameter DOWN and then up, and — because idle rests on the envelope's own
                    // FIRST node rather than a hard 0 — the release lands where idle sits, with no
                    // discontinuity at the end.
                    //
                    // Unipolar (the default, and every existing session) keeps its exact old
                    // behaviour, idle 0.0f included. This is additive.
                    const auto publish = [&](float raw01) {
                        state.modChannelValue[ch] = env.bipolar ? raw01 * 2.0f - 1.0f : raw01;
                    };
                    switch (state.modEnvStage[ch]) {
                    case 1:
                    case 2: {
                        if (snapshot.isPlaying) state.modEnvElapsedMs[ch] += msPerFrame;
                        const float v = evalBreakpointPreSustain(env, state.modEnvElapsedMs[ch]);
                        publish(v);
                        if (state.modGateCloseFrame[ch] != 0 && frame >= state.modGateCloseFrame[ch]) {
                            state.modEnvStage[ch]             = 3;
                            state.modEnvReleaseMs[ch]         = 0.0;
                            state.modEnvReleaseStartValue[ch] = v;   // stored space — deliberately
                        }
                        break;
                    }
                    case 3: {
                        if (snapshot.isPlaying) state.modEnvReleaseMs[ch] += msPerFrame;
                        bool finished = false;
                        const float v = evalBreakpointRelease(env, state.modEnvReleaseMs[ch],
                                                              state.modEnvReleaseStartValue[ch], finished);
                        if (finished) {
                            state.modEnvStage[ch] = 0;
                            // Fall to the idle rest value rather than snapping to a hard 0, which
                            // for a bipolar envelope would be a jump to full-negative.
                            publish(env.bipolar && env.nodeCount > 0 ? env.value[0] : 0.0f);
                        } else {
                            publish(v);
                        }
                        break;
                    }
                    default:
                        publish(env.bipolar && env.nodeCount > 0 ? env.value[0] : 0.0f);
                        break;
                    }
                    break;
                }
                }
                // MOD-2: publish the shape playhead (see NativeRenderState::modChannelPhase). Done
                // here, after the type switch, because this is the one place the channel's type is
                // resolved for all four channels — including ch0/1, whose LFO/follower values come
                // from the legacy lfo1/lfo2 path but whose TYPE still lives in modChannels[].
                {
                    float ph = -1.0f;
                    switch (mc.type) {
                    case NativeModChannelType::lfo: {
                        const double raw = (ch < 2) ? (ch == 0 ? state.lfo1Phase : state.lfo2Phase)
                                                    : state.modPhase[ch];
                        ph = static_cast<float>(raw - std::floor(raw));
                        break;
                    }
                    case NativeModChannelType::envFollower:
                        ph = -1.0f;   // no static shape to ride — that monitor scrolls
                        break;
                    case NativeModChannelType::envelope: {
                        const double total = breakpointTotalMs(mc.envelope);
                        if (total <= 0.0 || state.modEnvStage[ch] == 0) { ph = -1.0f; break; }
                        const double sustainMs = breakpointSustainMs(mc.envelope);
                        // Position along the DRAWN timeline: the pre-sustain walk holds at the
                        // sustain node while the gate is open, then the release walks on from there.
                        const double pos = (state.modEnvStage[ch] == 3)
                            ? sustainMs + state.modEnvReleaseMs[ch]
                            : std::min(state.modEnvElapsedMs[ch], sustainMs);
                        ph = static_cast<float>(std::clamp(pos / total, 0.0, 1.0));
                        break;
                    }
                    }
                    state.modChannelPhase[ch] = ph;
                }

                // Per-channel master depth: scale the channel's value at the source so depth=0
                // fully silences it. Channels 2/3 are consumed via modChannelValue[] everywhere
                // (per-voice env3/env4 and the free-rate phasor), so scaling here covers them all.
                if (ch >= 2)
                    state.modChannelValue[ch] *= static_cast<float>(snapshot.modChannels[ch].depth);
            }
            // Channels 0/1: when set to Envelope, use the envelope value instead of the legacy
            // LFO/follower value (computed above). LFO/Follower keep the legacy lfo1Val/lfo2Val.
            // (modChannelValue[0/1] is NOT pre-scaled here; the envelope override applies ch depth
            // explicitly below so all three type paths for ch0/1 are scaled uniformly.)
            const double ch0Depth = snapshot.modChannels[0].depth;
            const double ch1Depth = snapshot.modChannels[1].depth;
            if (snapshot.modChannels[0].type == NativeModChannelType::envelope)
                lfo1Val = static_cast<double>(state.modChannelValue[0]) * ch0Depth;
            if (snapshot.modChannels[1].type == NativeModChannelType::envelope)
                lfo2Val = static_cast<double>(state.modChannelValue[1]) * ch1Depth;
            // LFO/Follower paths for ch0/1 use lfo1Val/lfo2Val computed at 3288/3292; scale them too.
            if (snapshot.modChannels[0].type != NativeModChannelType::envelope)
                lfo1Val *= ch0Depth;
            if (snapshot.modChannels[1].type != NativeModChannelType::envelope)
                lfo2Val *= ch1Depth;
        }

        float leftMix = 0.0f;
        float rightMix = 0.0f;
        float send1Mix = 0.0f;
        float send2Mix = 0.0f;
        float send3Mix = 0.0f;
        float send4Mix = 0.0f;
        std::uint32_t activeVoiceCount = 0;
        // Envelope-follower detector input: accumulate the source track's mono post-gain
        // magnitude this frame (summed across its voices), used after the voice loop.
        const int envSrc1 = lfo1IsEnv ? snapshot.lfo1EnvelopeSourceTrack : -1;
        const int envSrc2 = lfo2IsEnv ? snapshot.lfo2EnvelopeSourceTrack : -1;
        float envMag1 = 0.0f;
        float envMag2 = 0.0f;
        // Generic channels 2/3 env-follower detector inputs.
        int   modFollowerSrc[kModChannelCount] = {};
        float modFollowerMag[kModChannelCount] = {};
        for (int ch = 2; ch < kModChannelCount; ++ch) {
            modFollowerSrc[ch] = (snapshot.modChannels[ch].type == NativeModChannelType::envFollower)
                ? snapshot.modChannels[ch].followerSourceTrack : -1;
        }
        for (auto& voice : state.voices) {
            if (!voice.active || voice.sample == nullptr) {
                continue;
            }
            ++activeVoiceCount;

            // Onset-deferred choke / self-cut: fire the armed cut the frame this voice reaches
            // audible material. Must run BEFORE the pre-silence early-out so the countdown ticks
            // through the scheduled delay too. A cutter that is itself stopping (choked/stolen
            // while still silent) never fires — a note that never sounds chokes nothing.
            if ((voice.pendingGroupChoke || voice.pendingSelfCut) && !voice.stopping) {
                if (voice.pendingCutFrames == 0) {
                    executeDeferredCut(state, voice);
                } else {
                    --voice.pendingCutFrames;
                }
            }

            // Phase 6: pre-silence — count down delay before producing audio
            if (voice.preSilenceFramesRemaining > 0) {
                --voice.preSilenceFramesRemaining;
                continue;
            }

            // Phase 5: glide — interpolate playback rate
            double effectiveRate = voice.rate;
            if (voice.glideFramesRemaining > 0 && voice.glideTotalFrames > 0) {
                const double t = 1.0 - static_cast<double>(voice.glideFramesRemaining)
                    / static_cast<double>(voice.glideTotalFrames);
                effectiveRate = voice.glideSourceRate + t * (voice.rate - voice.glideSourceRate);
                --voice.glideFramesRemaining;
            }

            // Volume/pan/tone: trigger-composed totals are the fast path; when the live ramped
            // track base differs from the base captured at trigger (fader in motion, or a ringing
            // voice whose bake predates the last fader move), recompose from the live base + the
            // voice's per-step offsets so the move is heard AND sticks after the republish.
            float glideVol  = voice.baseVolume;
            float glidePan  = voice.basePan;
            float glideTone = voice.baseTone;
            bool liveBaseDiffers = false;
            // Live pitch base: nonzero when the track's global pitch moved after this voice
            // triggered (scene morph, pitch edit) — the rate is bent by this delta below.
            float livePitchDeltaUI = 0.0f;
            // Live resonance: the ramped track base, which is the snapshot value unless a live
            // override is newer. There are no per-step Q offsets, so unlike tone it needs no
            // recomposition — it IS the value. Defaults to the voice's own cached Q so a track index
            // out of range cannot change the filter.
            float liveQ = voice.toneFilter.lastQ;
            float liveFilterDrive = voice.toneFilter.lastDrive;
            if (voice.trackIndex < kMaxEnvelopeTracks) {
                const auto& tBase = state.trackBaseCurrent[voice.trackIndex];
                if (tBase[kRampChanVolume] != voice.bakedVolBase
                    || tBase[kRampChanPan]  != voice.bakedPanBase
                    || tBase[kRampChanTone] != voice.bakedToneBase) {
                    liveBaseDiffers = true;
                    glideVol  = std::clamp((tBase[kRampChanVolume] + voice.volAdd)
                                               * voice.cellVolMult, 0.0f, 2.0f);
                    glidePan  = std::clamp(tBase[kRampChanPan]  + voice.panAdd, -1.0f, 1.0f);
                    glideTone = std::clamp(tBase[kRampChanTone] + voice.toneAdd, -100.0f, 100.0f);
                }
                livePitchDeltaUI = tBase[kRampChanPitch] - voice.bakedPitchBase;
                liveQ            = tBase[kRampChanQ];
                liveFilterDrive  = tBase[kRampChanFilterDrive];
            }

            // Per-cell parameter glide: ramp tone/pan/volume from the previous cell's values toward
            // this voice's (live-recomposed) targets. When active, force the gain/pan/tone recompute
            // below (even with no LFO) so the ramp is heard; LFO modulation stacks on top.
            const bool paramGliding = voice.glideParamFramesRemaining > 0
                && voice.glideParamTotalFrames > 0;
            if (paramGliding) {
                const float gt = 1.0f - static_cast<float>(voice.glideParamFramesRemaining)
                    / static_cast<float>(voice.glideParamTotalFrames);
                glideVol  = voice.glideSourceVolume + gt * (glideVol  - voice.glideSourceVolume);
                glidePan  = voice.glideSourcePan    + gt * (glidePan  - voice.glideSourcePan);
                glideTone = voice.glideSourceTone   + gt * (glideTone - voice.glideSourceTone);
                --voice.glideParamFramesRemaining;
            }

            // Phase 2: LFO modulation → adjust gain/pan/filter/rate.
            // Read the LFO depths LIVE from the current snapshot (AVFoundation re-reads these
            // every frame). Baking them at trigger time left held/sustained voices stale: a depth
            // change — e.g. a sidechain duck set to -100 — never reached a voice that was already
            // playing (it would keep modulating at its trigger-time depth, or not at all if it was
            // triggered at depth 0), so the modifier appeared to "do nothing" on long voices.
            float effLeftGain  = voice.leftGain;
            float effRightGain = voice.rightGain;
            // The per-voice volume fader baked into effL/effR gains (baseVolume × LFO vol mod).
            // Used to divide the fader back out for a pre-fader send tap. Pan + envelope stay.
            float voiceFaderGain = voice.baseVolume;

            // Sample-mode consolidation: owner gate/attack envelope (elapsed-frame, so it works for
            // OWN+loop whose position only wraps). gate>0 = sustain that % of the sample duration then
            // release to silence; attack>0 = fade-in over that %. A looping voice is retired once the
            // release fully closes (it would otherwise loop silently forever).
            float ownerEnvGain = 1.0f;   // kept for the gain-recompute branch below (it rebuilds
                                         // effL/effR from scratch and must reapply this envelope)
            if (voice.ownerEnvelope && voice.endFrame > voice.startFrame) {
                const double refFrames = static_cast<double>(voice.endFrame - voice.startFrame);
                const double elapsed   = static_cast<double>(voice.lifetimeFrames);
                if (voice.ownerAttackPct > 0.0f) {
                    const double fadeLen = refFrames * (voice.ownerAttackPct / 100.0);
                    if (fadeLen > 0.0 && elapsed < fadeLen)
                        ownerEnvGain *= static_cast<float>(elapsed / fadeLen);
                }
                if (voice.ownerGatePct > 0.0f) {
                    const double sustainEnd  = refFrames * (voice.ownerGatePct / 100.0);
                    const double releaseTail = std::min(refFrames * 0.1, refFrames - sustainEnd);
                    if (elapsed >= sustainEnd) {
                        if (releaseTail > 0.0) {
                            const double prog = (elapsed - sustainEnd) / releaseTail;
                            ownerEnvGain *= static_cast<float>(std::max(0.0, 1.0 - std::min(1.0, prog)));
                            if (prog >= 1.0 && voice.loopWrapEnabled && !voice.stopping) {
                                voice.stopping = true; voice.fadeFramesRemaining = 1;
                            }
                        } else {
                            ownerEnvGain = 0.0f;
                            if (voice.loopWrapEnabled && !voice.stopping) {
                                voice.stopping = true; voice.fadeFramesRemaining = 1;
                            }
                        }
                    }
                }
                effLeftGain  *= ownerEnvGain;
                effRightGain *= ownerEnvGain;
            }

            float gainMod = 1.0f;   // LFO gain modulation → pre-clipper drive (applied below)
            const NativeTrackSnapshot* liveTrack = voice.trackIndex < snapshot.tracks.size()
                ? &snapshot.tracks[voice.trackIndex] : nullptr;

            // Reg-mode extension-step pitch streaming (multi-step varispeed cells): derive the
            // base rate from the CURRENT sub-step's pitch offset, gliding into the next sub-step's
            // pitch over the last glide% of the step — reproducing legacy's pre-rendered per-cell
            // pitch walk (SequencerNode/CellSegmentProcessor) without baking a buffer. The LFO
            // pitch modulation below still compounds on top of this base rate.
            bool cellPitchStreamed = false;
            if (voice.cellLengthSteps > 1 && liveTrack != nullptr
                && state.currentFramesPerStep > 0 && !liveTrack->pitchOffsets.empty()) {
                const double semi = cellStreamSemitone(*liveTrack, voice.cellOriginStep,
                    voice.cellLengthSteps, voice.cellElapsedFrames, state.currentFramesPerStep,
                    voice.chordIntervalSemitones);
                effectiveRate = std::max(0.0001,
                    std::pow(2.0, semi / 12.0) * voice.cellRateScale);
                // cellStreamSemitone reads the LIVE snapshot's globalPitchOffset, so this voice
                // already follows pitch changes — the live-pitch-base delta below must not
                // apply on top (it would double-count the move).
                cellPitchStreamed = true;
            }

            // Rate morph: bend the ringing varispeed voice by the ratio between the track's
            // instantaneous morphing multiplier and the multiplier baked at trigger, so already-
            // sounding notes glide with the pattern (turntable). Placed AFTER the cell-stream
            // block above, which rebuilds effectiveRate from cellRateScale. RB voices get the
            // same ratio on their feed stride in the pre-render pass instead. Outside a morph
            // the ratio is identically 1 (landing bakes it in), so this multiplies nothing.
            if (!voice.useRubberBand && voice.trackIndex < kMaxGrainTracks
                && state.morphPhase[voice.trackIndex] != 0 && voice.bakedPatternMult > 0.0) {
                effectiveRate *= state.morphM[voice.trackIndex] / voice.bakedPatternMult;
            }

            // Reg-mode extension-step volume streaming: a multi-step REGULAR cell plays as ONE voice,
            // so honor each sub-step's per-cell volume (gain + mix offsets) and glide between sub-steps
            // the same way pitch does — otherwise the whole cell holds the owner step's volume and
            // per-cell edits on extension cells are inaudible. Each sub-step resolves to
            // track.volume + offsets[sub], matching what the grid shows per cell (ContentView). OWNER
            // mode (3) intentionally continues the owner cell with no transitions, so it is excluded
            // and keeps the baked owner-step volume.
            bool cellVolStreaming = false;
            if (voice.cellLengthSteps > 1 && liveTrack != nullptr
                && state.currentFramesPerStep > 0 && liveTrack->playbackMode == 0) {
                float streamedVol = cellStreamVolume(*liveTrack, voice.cellOriginStep,
                    voice.cellLengthSteps, voice.cellElapsedFrames, state.currentFramesPerStep);
                // streamedVol composes from the snapshot fader; substitute the live ramped base
                // so a volume fader move reaches a streaming multi-step cell immediately too.
                if (voice.trackIndex < kMaxEnvelopeTracks)
                    streamedVol += state.trackBaseCurrent[voice.trackIndex][kRampChanVolume]
                                 - liveTrack->volume;
                glideVol = std::clamp(streamedVol * voice.cellVolMult, 0.0f, 2.0f);
                cellVolStreaming = true;
            }

            const float lfo1VolD   = liveTrack ? liveTrack->lfo1VolDepth    : voice.lfo1VolDepth;
            const float lfo2VolD   = liveTrack ? liveTrack->lfo2VolDepth    : voice.lfo2VolDepth;
            const float lfo1PanD   = liveTrack ? liveTrack->lfo1PanDepth    : voice.lfo1PanDepth;
            const float lfo2PanD   = liveTrack ? liveTrack->lfo2PanDepth    : voice.lfo2PanDepth;
            const float lfo1PitchD = liveTrack ? liveTrack->lfo1PitchDepth  : voice.lfo1PitchDepth;
            const float lfo2PitchD = liveTrack ? liveTrack->lfo2PitchDepth  : voice.lfo2PitchDepth;
            const float lfo1FiltD  = liveTrack ? liveTrack->lfo1FilterDepth : voice.lfo1FilterDepth;
            const float lfo2FiltD  = liveTrack ? liveTrack->lfo2FilterDepth : voice.lfo2FilterDepth;
            // Gain depth has no baked per-voice fallback (read live; 0 when no live track).
            const float lfo1GainD  = liveTrack ? liveTrack->lfo1GainDepth   : 0.0f;
            const float lfo2GainD  = liveTrack ? liveTrack->lfo2GainDepth   : 0.0f;
            // Modulation overhaul: channels 3 & 4 (envelope sources). Their per-track depths have
            // no baked per-voice fallback (envelopes are always read live). The source values
            // (state.modChannelValue) are computed in the global section above.
            const float lfo3VolD   = liveTrack ? liveTrack->lfo3VolDepth    : 0.0f;
            const float lfo4VolD   = liveTrack ? liveTrack->lfo4VolDepth    : 0.0f;
            const float lfo3PanD   = liveTrack ? liveTrack->lfo3PanDepth    : 0.0f;
            const float lfo4PanD   = liveTrack ? liveTrack->lfo4PanDepth    : 0.0f;
            const float lfo3PitchD = liveTrack ? liveTrack->lfo3PitchDepth  : 0.0f;
            const float lfo4PitchD = liveTrack ? liveTrack->lfo4PitchDepth  : 0.0f;
            const float lfo3FiltD  = liveTrack ? liveTrack->lfo3FilterDepth : 0.0f;
            const float lfo4FiltD  = liveTrack ? liveTrack->lfo4FilterDepth : 0.0f;
            const float lfo3GainD  = liveTrack ? liveTrack->lfo3GainDepth   : 0.0f;
            const float lfo4GainD  = liveTrack ? liveTrack->lfo4GainDepth   : 0.0f;
            const double env3Val   = static_cast<double>(state.modChannelValue[2]);
            const double env4Val   = static_cast<double>(state.modChannelValue[3]);
            const bool liveHasLfoMod = lfo1PitchD != 0.0f || lfo2PitchD != 0.0f
                || lfo1VolD != 0.0f || lfo2VolD != 0.0f || lfo1PanD != 0.0f || lfo2PanD != 0.0f
                || lfo1FiltD != 0.0f || lfo2FiltD != 0.0f || lfo1GainD != 0.0f || lfo2GainD != 0.0f
                || lfo3PitchD != 0.0f || lfo4PitchD != 0.0f || lfo3VolD != 0.0f || lfo4VolD != 0.0f
                || lfo3PanD != 0.0f || lfo4PanD != 0.0f || lfo3FiltD != 0.0f || lfo4FiltD != 0.0f
                || lfo3GainD != 0.0f || lfo4GainD != 0.0f;
            const bool livePitchBends = livePitchDeltaUI != 0.0f && !cellPitchStreamed;
            // Filter resonance / mode moved after this voice triggered. Without this term the block
            // below never runs for a Q-or-mode-only edit, so the change would not reach the filter at
            // all until the next hit — which is exactly the bug being fixed. `mixMoving` keeps the
            // block alive for the few ms of a mode crossfade even after the parameters have settled.
            const NativeToneFilter::Mode liveMode =
                liveTrack != nullptr ? liveTrack->toneMode : voice.toneFilter.lastMode;
            const bool liveFilterDiffers = liveQ != voice.toneFilter.lastQ
                || liveFilterDrive != voice.toneFilter.lastDrive
                || liveMode != voice.toneFilter.lastMode
                || voice.toneFilter.mixIsMoving();
            if (liveHasLfoMod || paramGliding || cellVolStreaming || liveBaseDiffers || livePitchBends
                || liveFilterDiffers) {
                // Live pitch base: bend the ringing voice by the ramped delta between the
                // track's current global pitch and the value baked at trigger, so pitch
                // edits and scene morphs glide already-playing audio (UI units are
                // half-semitones, hence /2; the per-scale tuning remap is skipped for the
                // bend — endpoints re-latch exactly on the next trigger).
                if (livePitchBends) {
                    effectiveRate *= std::pow(2.0,
                        (static_cast<double>(livePitchDeltaUI) / 2.0) / 12.0);
                }
                const double pitchMod = lfo1PitchD * lfo1Val + lfo2PitchD * lfo2Val
                    + lfo3PitchD * env3Val + lfo4PitchD * env4Val;
                if (pitchMod != 0.0) {
                    effectiveRate *= std::pow(2.0, pitchMod / 12.0);
                }
                const float volMod = std::clamp(1.0f
                    + static_cast<float>(lfo1Val) * lfo1VolD * envVolScale1
                    + static_cast<float>(lfo2Val) * lfo2VolD * envVolScale2
                    + static_cast<float>(env3Val) * lfo3VolD
                    + static_cast<float>(env4Val) * lfo4VolD, 0.0f, volModMax);
                // Gain modulation: same envelope ×2 scale + widened clamp as volume. Applied to
                // the signal entering the track clipper (matches AVF's signalPreClipperGain), so
                // it changes drive/loudness; the volume (fader) path stays separate.
                gainMod = std::clamp(1.0f
                    + static_cast<float>(lfo1Val) * lfo1GainD * envVolScale1
                    + static_cast<float>(lfo2Val) * lfo2GainD * envVolScale2
                    + static_cast<float>(env3Val) * lfo3GainD
                    + static_cast<float>(env4Val) * lfo4GainD, 0.0f, volModMax);
                const float panMod = std::clamp(glidePan
                    + static_cast<float>(lfo1Val) * lfo1PanD
                    + static_cast<float>(lfo2Val) * lfo2PanD
                    + static_cast<float>(env3Val) * lfo3PanD
                    + static_cast<float>(env4Val) * lfo4PanD, -1.0f, 1.0f);
                // Reapply the owner gate/attack envelope: the rebuild above starts from the raw
                // fader/pan gains (previously the envelope was silently dropped on this path).
                effLeftGain  = glideVol * volMod * std::sqrt(0.5f * (1.0f - panMod)) * ownerEnvGain;
                effRightGain = glideVol * volMod * std::sqrt(0.5f * (1.0f + panMod)) * ownerEnvGain;
                voiceFaderGain = glideVol * volMod;

                // Update tone filter with LFO filter modulation (and per-cell tone glide)
                const float filteredTone = std::clamp(glideTone
                    + static_cast<float>(lfo1Val) * lfo1FiltD
                    + static_cast<float>(lfo2Val) * lfo2FiltD
                    + static_cast<float>(env3Val) * lfo3FiltD
                    + static_cast<float>(env4Val) * lfo4FiltD, -100.0f, 100.0f);
                // ⚠️ THIS LINE USED TO READ:
                //     setParameters(filteredTone, voice.toneFilter.lastQ, voice.toneFilter.lastMode)
                // i.e. it fed the filter's OWN cached Q and mode straight back into itself. Q and
                // filter mode could therefore not be moved on a ringing voice by ANY means — not a
                // fader, not a menu, not even a full world republish. Only the next trigger picked
                // them up. Both now come from the live track state: Q through its ramp lane (so a
                // drag is smooth and epoch-gated like volume/pan/tone), mode straight off the
                // snapshot (an enum cannot ramp — the filter crossfades its output mix instead).
                voice.toneFilter.setParameters(filteredTone, liveQ, liveMode, liveFilterDrive);
            }

            float renderedLeft  = 0.0f;
            float renderedRight = 0.0f;

            // Phase 11: RubberBand voices drain one output frame per tick.
            // Non-RubberBand voices use the existing Hermite interpolation path.
            if (voice.useRubberBand && voice.rubberBandSlot >= 0) {
                auto* rb = voiceStretchPool_.get(voice.rubberBandSlot);
                if (rb && voice.rbOutputAvailable > 0) {
                    float outL = 0.0f, outR = 0.0f;
                    voiceStretchPool_.popFrame(voice.rubberBandSlot, outL, outR);
                    --voice.rbOutputAvailable;
                    if (voice.rbLatencySkipRemaining > 0) {
                        // Discard startup-latency output so the first audible frame
                        // aligns with the trigger frame.
                        --voice.rbLatencySkipRemaining;
                    } else {
                        // Short fade-in over the first audible frames to mask any residual
                        // cold-start transient that survives the seek() pre-roll.
                        if (voice.rbAttackFadeRemaining > 0 && rbAttackFadeTotal_ > 0) {
                            const float t = 1.0f - static_cast<float>(voice.rbAttackFadeRemaining)
                                                 / static_cast<float>(rbAttackFadeTotal_);
                            const float g = t * t;  // ease-in
                            outL *= g;
                            outR *= g;
                            --voice.rbAttackFadeRemaining;
                        }
                        renderedLeft  = outL;
                        renderedRight = outR;
                    }
                }
                // Voice ends when input is exhausted and all output has been drained.
                if (voice.rbInputConsumed >= voice.endFrame && voice.rbOutputAvailable == 0) {
                    voice.stopping = true;
                    voice.choked   = false;
                    if (voice.fadeFramesRemaining == 0)
                        voice.fadeFramesRemaining = shortSampleEndFadeFrames;
                }
            } else {
                const auto& leftChannel  = voice.sample->left;
                const auto& rightChannel = voice.sample->right.empty() ? voice.sample->left : voice.sample->right;
#if SCOOPY_SINC_RESAMPLER
                // TP / varispeed quality path: anti-aliased 16-tap windowed sinc.
                // effectiveRate is the per-sample source advance; |rate|>1 (pitch-up)
                // engages the anti-alias low-pass inside read().
                const double aaRate = std::abs(effectiveRate);
                renderedLeft  = sincResampler_.read(leftChannel,  voice.position, voice.startFrame, voice.endFrame, aaRate);
                renderedRight = sincResampler_.read(rightChannel, voice.position, voice.startFrame, voice.endFrame, aaRate);
#else
                renderedLeft  = interpolate(leftChannel,  voice.position, voice.startFrame, voice.endFrame);
                renderedRight = interpolate(rightChannel, voice.position, voice.startFrame, voice.endFrame);
#endif
            }
            switch (voice.stereoMode) {
            case StereoMode::mono: {
                const float mono = (renderedLeft + renderedRight) * 0.5f;
                renderedLeft  = mono;
                renderedRight = mono;
                break;
            }
            case StereoMode::leftOnly:
                renderedRight = renderedLeft;
                break;
            case StereoMode::rightOnly:
                renderedLeft = renderedRight;
                break;
            case StereoMode::stereo:
                break;
            }

            voice.toneFilter.processSample(renderedLeft, renderedRight);
            // Phase 2: LFO gain modulation scales the signal driving the clipper (pre-clipper),
            // matching AVF's signalPreClipperGain — louder → more drive, negative depth → ducks.
            if (gainMod != 1.0f) {
                renderedLeft  *= gainMod;
                renderedRight *= gainMod;
            }
            // Phase 8: track clipper (applied post-filter, pre-gain/fade — matches TrackClipper position in AVF)
            voice.trackClipper.processSample(renderedLeft, renderedRight);

            float fade = 1.0f;
            if (voice.stopping && voice.fadeFramesRemaining > 0) {
                const float remaining = static_cast<float>(voice.fadeFramesRemaining)
                    / static_cast<float>(chokeFadeFrames);
                fade = voice.choked ? remaining : std::sqrt(remaining);
                --voice.fadeFramesRemaining;
                if (voice.fadeFramesRemaining == 0) {
                    voice.active = false;
                    if (voice.rubberBandSlot >= 0) {
                        voiceStretchPool_.checkin(voice.rubberBandSlot);
                        voice.rubberBandSlot = -1;
                    }
                }
            } else {
                const auto integerPosition = static_cast<std::size_t>(
                    std::max(0.0, std::floor(voice.position)));
                const double framesFromEnd = voice.reversed
                    ? static_cast<double>(integerPosition - voice.startFrame)
                    : static_cast<double>(voice.endFrame - integerPosition);
                const auto voiceFrameCount = voice.endFrame - voice.startFrame;

                // Phase 3: custom release fade (or default end-fade)
                if (voice.releaseStartFrame > 0 && integerPosition >= voice.releaseStartFrame) {
                    // Custom release: t goes 1→0 as position moves from releaseStart→end
                    const std::size_t releaseLen = voice.endFrame - voice.releaseStartFrame;
                    if (releaseLen > 0) {
                        const float t = static_cast<float>(voice.endFrame - integerPosition)
                            / static_cast<float>(releaseLen);
                        fade = std::pow(std::max(0.0f, t), voice.fadeCurveExp);
                    }
                } else {
                    // Default short click-prevention end fade
                    const std::uint32_t fadeLength = voiceFrameCount > sampleEndFadeFrames * 2
                        ? sampleEndFadeFrames : shortSampleEndFadeFrames;
                    if (framesFromEnd >= 0.0 && framesFromEnd < fadeLength) {
                        fade = std::sqrt(static_cast<float>(framesFromEnd)
                                         / static_cast<float>(fadeLength));
                    }
                }
                if (framesFromEnd <= 2.0) { fade = 0.0f; }

                // Phase 3: custom attack fade
                if (voice.attackEndFrame > voice.startFrame
                    && integerPosition < voice.attackEndFrame) {
                    const std::size_t attackLen = voice.attackEndFrame - voice.startFrame;
                    if (attackLen > 0) {
                        const float t = static_cast<float>(integerPosition - voice.startFrame)
                            / static_cast<float>(attackLen);
                        const float attackFade = std::pow(std::max(0.0f, std::min(1.0f, t)),
                                                           voice.fadeCurveExp);
                        fade *= attackFade;
                    }
                }

                // Micro beat-repeat windowed grain: Tukey amplitude window across each grain cycle so
                // the loop seam (position wrap at grainWindowStart+grainWindowLen) is silent→silent —
                // no click — while the flat centre keeps the transient body at full level.
                if (voice.grainWindowEnabled && voice.grainWindowLen > 1) {
                    const double len = static_cast<double>(voice.grainWindowLen);
                    double rel = static_cast<double>(integerPosition)
                               - static_cast<double>(voice.grainWindowStart);
                    rel -= std::floor(rel / len) * len;          // wrap into [0, len)
                    const double tt = rel / len;                 // 0..1 across the grain
                    constexpr double edge = 0.25;                // cosine taper fraction each side
                    float w = 1.0f;
                    if (tt < edge) {
                        // Leading taper only once the window has wrapped (or started mid-content):
                        // an onset-anchored window keeps its raw attack on the first pass instead
                        // of fading the transient in. The trailing taper below always applies, so
                        // the first seam is still prepared silent→silent.
                        if (voice.grainWrapped)
                            w = static_cast<float>(0.5 * (1.0 - std::cos(M_PI * tt / edge)));
                    } else if (tt > 1.0 - edge)
                        w = static_cast<float>(0.5 * (1.0 - std::cos(M_PI * (1.0 - tt) / edge)));
                    fade *= w;
                }
            }

            // Mixer-true mute: the ramped per-track mute gain multiplies the FINAL contribution —
            // main mix (both routing branches), the post-fader send tap AND the pre-fader tap
            // (which divides voiceFaderGain back out but never `fade`), and the follower feeds.
            // This is what makes mute/solo kill RINGING audio in ~4 ms; `muted` only gates
            // triggers (stop/pause territory). Additive per-step volume offsets can't leak past
            // it because they live inside effLeft/RightGain, which `fade` scales.
            if (voice.trackIndex < kMaxEnvelopeTracks) {
                fade *= state.trackBaseCurrent[voice.trackIndex][kRampChanMuteGain];
            } else if (voice.trackIndex < snapshot.tracks.size()
                       && snapshot.tracks[voice.trackIndex].mixMuted) {
                fade = 0.0f;
            }

            // Per-track output routing: blend between the normal panned placement and a hard
            // mono-sum onto the assigned side of the deck pair. The weights ride the live ramp
            // (click-free); beyond the ramp range they switch hard from the snapshot.
            float aw1 = 0.0f, aw2 = 0.0f;
            if (voice.trackIndex < kMaxEnvelopeTracks) {
                aw1 = state.trackBaseCurrent[voice.trackIndex][kRampChanAssign1];
                aw2 = state.trackBaseCurrent[voice.trackIndex][kRampChanAssign2];
            } else if (routingOn && voice.trackIndex < snapshot.tracks.size()) {
                const int oa = snapshot.tracks[voice.trackIndex].outputAssign;
                aw1 = oa == 1 ? 1.0f : 0.0f;
                aw2 = oa == 2 ? 1.0f : 0.0f;
            }
            if (aw1 > 0.0f || aw2 > 0.0f) {
                // Pan-free voice gain: equal-power pan only rotates (effL,effR) — their norm is
                // volume × LFO-vol × owner-envelope exactly, so this ignores base pan, per-step
                // pan offsets, pan LFO, per-cell pan glide and live pan overrides.
                const float g = std::sqrt(effLeftGain * effLeftGain + effRightGain * effRightGain);
                const float mono = (renderedLeft + renderedRight) * 0.70710678f; // L+R, −3 dB
                const float normalW = std::max(0.0f, 1.0f - aw1 - aw2);
                leftMix  += (renderedLeft  * effLeftGain  * normalW + mono * g * aw1) * fade;
                rightMix += (renderedRight * effRightGain * normalW + mono * g * aw2) * fade;
            } else {
                leftMix  += renderedLeft  * effLeftGain  * fade;
                rightMix += renderedRight * effRightGain * fade;
            }
            // Post-fader send tap (legacy): includes the voice volume fader. Pre-fader tap
            // divides that fader back out, leaving pan + envelope shaping. Each bus picks its
            // own tap via send1/2PostFader (global per send bus).
            const float sendSample = (renderedLeft * effLeftGain + renderedRight * effRightGain) * 0.5f * fade;
            const float sendSamplePre = voiceFaderGain > 1.0e-6f ? sendSample / voiceFaderGain : 0.0f;
            // SIG-3 activity/clip tap: the TRUE per-channel track output at the END of the
            // chain — post tone filter, post the Phase-8 track clipper (above), post volume/pan
            // (effL/RGain) and post the mute fade. max(|L|,|R|), NOT a mono fold: the meter also
            // flags a HOT track (fill goes red near 0 dBFS), and a mono fold would under-read a
            // hard-panned peak by ~6 dB and miss exactly the clip it exists to show.
            if (voice.trackIndex < kMaxEnvelopeTracks) {
                const float outL = std::fabs(renderedLeft  * effLeftGain  * fade);
                const float outR = std::fabs(renderedRight * effRightGain * fade);
                float& blockPeak = state.trackMixBlockPeak[voice.trackIndex];
                blockPeak = std::max(blockPeak, std::max(outL, outR));
            }
            // Send levels: ramped live per-track base (slider fader or override — see the ramp
            // setup above the frame loop) + this voice's trigger-baked per-step offset. Heard on
            // ringing voices immediately AND after the republish (no snap-back), click-free.
            float s1Lvl = voice.send1Level, s2Lvl = voice.send2Level,
                  s3Lvl = voice.send3Level, s4Lvl = voice.send4Level;
            if (voice.trackIndex < kMaxEnvelopeTracks) {
                const auto& sBase = state.trackBaseCurrent[voice.trackIndex];
                s1Lvl = std::clamp(sBase[0] + voice.sendOffset[0], 0.0f, 1.0f);
                s2Lvl = std::clamp(sBase[1] + voice.sendOffset[1], 0.0f, 1.0f);
                s3Lvl = std::clamp(sBase[2] + voice.sendOffset[2], 0.0f, 1.0f);
                s4Lvl = std::clamp(sBase[3] + voice.sendOffset[3], 0.0f, 1.0f);
            }
            send1Mix += (send1PostFader ? sendSample : sendSamplePre) * s1Lvl;
            send2Mix += (send2PostFader ? sendSample : sendSamplePre) * s2Lvl;
            send3Mix += (send3PostFader ? sendSample : sendSamplePre) * s3Lvl;
            send4Mix += (send4PostFader ? sendSample : sendSamplePre) * s4Lvl;
            if (envSrc1 >= 0 && static_cast<int>(voice.trackIndex) == envSrc1) envMag1 += std::fabs(sendSample);
            if (envSrc2 >= 0 && static_cast<int>(voice.trackIndex) == envSrc2) envMag2 += std::fabs(sendSample);
            for (int ch = 2; ch < kModChannelCount; ++ch)
                if (modFollowerSrc[ch] >= 0 && static_cast<int>(voice.trackIndex) == modFollowerSrc[ch])
                    modFollowerMag[ch] += std::fabs(sendSample);

            if (!voice.useRubberBand) {
                voice.position += voice.reversed ? -effectiveRate : effectiveRate;
                // Advance pattern-time elapsed frames for reg-mode extension-step pitch streaming.
                ++voice.cellElapsedFrames;
                ++voice.lifetimeFrames;
                if (voice.loopWrapEnabled && voice.loopEndFrame > voice.loopStartFrame + 1) {
                    // Loop-window wrap (forward). The voice keeps looping until choked by the next
                    // trigger; OWN gate/attack shaping + REG cell-binding are layered in F2b.
                    if (voice.position >= static_cast<double>(voice.loopEndFrame)) {
                        const double over = voice.position - static_cast<double>(voice.loopEndFrame);
                        voice.position = static_cast<double>(voice.loopStartFrame) + over;
                        if (voice.position >= static_cast<double>(voice.loopEndFrame))
                            voice.position = static_cast<double>(voice.loopStartFrame);
                        voice.grainWrapped = true;
                    }
                } else if (voice.position < static_cast<double>(voice.startFrame)
                    || voice.position >= static_cast<double>(voice.endFrame)) {
                    voice.active = false;
                    // RB voices are deactivated in the stopping fade path or the pre-render drain;
                    // this branch is non-RB, so no checkin needed here.
                }
            }
        }
        state.peakVoiceCount = std::max(state.peakVoiceCount, activeVoiceCount);
        state.currentVoiceCount = activeVoiceCount;

        // Envelope-follower: smooth each source track's magnitude (attack 0.5 ms / release 25 ms,
        // approximating AVFoundation's normalized-RMS detector), then derive the follower output
        // (silence gate, gain boost clamped to unity, LFO attack/release). One-sample latency:
        // these outputs are consumed at the top of the next frame.
        auto updateEnvFollower = [&](int srcTrack, float mag, float gain,
                                     float attack, float release, float& lfoOut) {
            if (srcTrack < 0 || srcTrack >= static_cast<int>(kMaxEnvelopeTracks)) { lfoOut = 0.0f; return; }
            float& level = state.trackEnvelopeLevel[static_cast<std::size_t>(srcTrack)];
            const float coeff = mag > level ? envDetectAttackCoeff : envDetectReleaseCoeff;
            level += (mag - level) * coeff;
            if (!std::isfinite(level) || level < 0.0f) level = 0.0f;
            const float env = level <= 0.001f ? 0.0f : std::min(1.0f, level * gain);
            const float attackAlpha  = attack  > 0.0f ? std::pow(10.0f, -attack  * 4.0f) : 1.0f;
            const float releaseAlpha = release > 0.0f ? std::pow(10.0f, -release * 4.0f) : 1.0f;
            const float a = env > lfoOut ? attackAlpha : releaseAlpha;
            const float next = lfoOut + (env - lfoOut) * a;
            lfoOut = std::isfinite(next) ? next : 0.0f;
        };
        updateEnvFollower(envSrc1, envMag1, snapshot.lfo1EnvelopeGain,
                          snapshot.lfo1EnvelopeAttack, snapshot.lfo1EnvelopeRelease, state.lfo1EnvOutput);
        updateEnvFollower(envSrc2, envMag2, snapshot.lfo2EnvelopeGain,
                          snapshot.lfo2EnvelopeAttack, snapshot.lfo2EnvelopeRelease, state.lfo2EnvOutput);
        for (int ch = 2; ch < kModChannelCount; ++ch) {
            if (modFollowerSrc[ch] < 0) continue;
            const auto& mc = snapshot.modChannels[ch];
            updateEnvFollower(modFollowerSrc[ch], modFollowerMag[ch], mc.followerGain,
                              mc.followerAttack, mc.followerRelease, state.modFollowerOutput[ch]);
        }
        // ===== Audio-rate grain (pulsar) pass =====
        // Per grain-enabled track: a fractional phasor emits windowed slices of the track's own
        // sample (cell-gated), summed through the track's volume/pan/clipper into the deck mix.
        // DJ tempo/pitch is applied downstream by the per-deck bus stretcher (grains ride the deck
        // output like every other voice), so no explicit deck-ratio math is needed here.
        if (anyGrainTracks) {
            constexpr double kPi = 3.14159265358979323846;
            const std::size_t grainTrackCount = std::min<std::size_t>(snapshot.tracks.size(), kMaxGrainTracks);
            for (std::size_t ti = 0; ti < grainTrackCount; ++ti) {
                const auto& track = snapshot.tracks[ti];
                if (!track.grainEnabled) continue;
                auto& sched = state.grainSchedulers[ti];

                // Resolve this track's sample.
                const NativeSample* sample = nullptr;
                {
                    const auto it = world.samples.find(track.sampleId);
                    if (it != world.samples.end() && it->second) sample = it->second.get();
                }

                // --- Per-step cell gate (recompute only when the musical step changes) ---
                // Musical step: the gate follows the pattern grid, so it re-aligns with the new
                // scene's downbeat when the anchor moves at a scheduled switch. The backward jump
                // at a wrap simply differs from lastGateStep and recomputes — safe by design.
                const std::uint64_t grainMusicalStep = static_cast<std::uint64_t>(std::max<std::int64_t>(
                    0, static_cast<std::int64_t>(state.masterStep) - state.patternAnchorStep));
                if (grainMusicalStep != sched.lastGateStep) {
                    sched.lastGateStep = grainMusicalStep;
                    bool open = false;
                    double semi = 0.0;
                    const std::size_t stepCount = track.steps.size();
                    if (stepCount > 0) {
                        const std::size_t cur = static_cast<std::size_t>(grainMusicalStep % stepCount);
                        // Owning cell = nearest active step at/below `cur` whose cell length covers it.
                        for (std::size_t back = 0; back <= cur; ++back) {
                            const std::size_t o = cur - back;
                            if (track.steps[o] != 0) {
                                const std::size_t cellLen = (o < track.cellLengths.size()
                                    && track.cellLengths[o] > 0) ? track.cellLengths[o] : 1;
                                if (o + cellLen > cur) {
                                    open = true;
                                    const double sp = o < track.pitchOffsets.size() ? track.pitchOffsets[o] : 0.0;
                                    semi = scoopy::tunedSemitones((track.globalPitchOffset + sp) / 2.0, track.tuningIndex) + track.fineTuneCents / 100.0;
                                }
                                break; // first active step governs the gate (active or a gap)
                            }
                        }
                    }
                    // Rising edge: reseat scan cursor + phasor for a clean grain-train attack.
                    if (open && !sched.gateOpen) {
                        sched.scanCursor01 = std::clamp(track.grainScanPosition, 0.0, 1.0);
                        sched.phasorAccum = 0.0;
                    }
                    sched.gateOpen = open;
                    sched.cellSemitones = semi;
                }

                if (sample == nullptr || sample->left.empty()) continue;
                const auto& Lc = sample->left;
                const auto& Rc = sample->right.empty() ? sample->left : sample->right;
                const std::size_t sampLen = Lc.size();
                std::size_t sampStart = std::min(track.sampleStartFrame, sampLen > 0 ? sampLen - 1 : 0);
                std::size_t sampEnd = (track.sampleEndFrame > 0 && track.sampleEndFrame <= sampLen)
                    ? track.sampleEndFrame : sampLen;
                if (sampEnd <= sampStart + 1) { sampStart = 0; sampEnd = sampLen; }
                const double sampSpan = static_cast<double>(sampEnd - sampStart);

                // Grain content read rate (formant) + fundamental Hz.
                double readRate = std::pow(2.0, track.grainPitchSemitones / 12.0);
                if (!track.grainKeyTrack) readRate *= std::pow(2.0, sched.cellSemitones / 12.0);
                double grainHz;
                if (track.grainRateMode == 1) {
                    const double stepRate = state.currentFramesPerStep > 0
                        ? sampleRate / static_cast<double>(state.currentFramesPerStep) : 0.0;
                    grainHz = stepRate * std::max(0.01, track.grainSyncRatio);
                } else {
                    grainHz = track.grainRateHz;
                }
                if (track.grainKeyTrack) grainHz *= std::pow(2.0, sched.cellSemitones / 12.0);
                grainHz = std::clamp(grainHz, 0.1, sampleRate * 0.5);
                const double periodFrames = sampleRate / grainHz;
                // Pulsar: one discrete pulsaret per period, capped at the period so grains never
                // overlap (overlapping grains read different offsets at once → comb-smear / mush).
                // pulsaretLen < period leaves a silence gap → the buzzy, formant-rich pulsar tone;
                // the formant peak sits at ~1/pulsaretDuration. grainLengthMs is the requested
                // pulsaret duration (the "formant" control: shorter = brighter, bigger gap).
                const double requestedLen = std::max(2.0, track.grainLengthMs * sampleRate / 1000.0);
                const std::uint32_t grainLenFrames = static_cast<std::uint32_t>(
                    std::min(requestedLen, std::max(2.0, periodFrames)));

                const bool gateOK = sched.gateOpen && snapshot.isPlaying && !launchGated;

                // --- Spawn (fractional-period phasor → jitter-free pitch) ---
                if (gateOK) {
                    sched.phasorAccum += 1.0;
                    if (sched.phasorAccum >= periodFrames) {
                        const double frac = sched.phasorAccum - periodFrames; // sub-sample phase
                        sched.phasorAccum -= periodFrames;
                        for (auto& g : sched.grains) {
                            if (g.active) continue;
                            double scan01 = sched.scanCursor01;
                            float amp = 1.0f;
                            if (track.grainRandomize > 0.0) {
                                auto nextRand = [&sched]() -> double {
                                    sched.rngState ^= sched.rngState << 13;
                                    sched.rngState ^= sched.rngState >> 17;
                                    sched.rngState ^= sched.rngState << 5;
                                    return (sched.rngState & 0xFFFFFFu) / static_cast<double>(0x1000000);
                                };
                                scan01 += (nextRand() - 0.5) * track.grainRandomize;
                                amp = static_cast<float>(1.0 - track.grainRandomize * 0.5 * nextRand());
                            }
                            scan01 = std::clamp(scan01, 0.0, 1.0);
                            g.sample = sample;
                            g.readRate = readRate;
                            g.length = grainLenFrames;
                            g.age = static_cast<std::uint32_t>(frac); // 0 (frac < 1); phase via readPos
                            g.readPos = static_cast<double>(sampStart) + scan01 * sampSpan + frac * readRate;
                            g.ampScale = amp;
                            g.active = true;
                            break;
                        }
                    }
                    // Scan drift (ordered scrub through the file).
                    if (track.grainScanSpeed != 0.0 && sampSpan > 0.0) {
                        sched.scanCursor01 += track.grainScanSpeed / sampSpan;
                        sched.scanCursor01 -= std::floor(sched.scanCursor01); // wrap to [0,1)
                    }
                } else {
                    sched.phasorAccum = 0.0;
                }

                // --- Render active grains ---
                float gL = 0.0f, gR = 0.0f;
                for (auto& g : sched.grains) {
                    if (!g.active) continue;
                    const double tt = g.length > 0
                        ? static_cast<double>(g.age) / static_cast<double>(g.length) : 1.0;
                    float win;
                    switch (track.grainWindow) {
                    case 1: { // Tukey (cosine tapers, 25% each side)
                        const double a = 0.5;
                        if (tt < a * 0.5)
                            win = static_cast<float>(0.5 * (1.0 + std::cos(kPi * (2.0 * tt / a - 1.0))));
                        else if (tt > 1.0 - a * 0.5)
                            win = static_cast<float>(0.5 * (1.0 + std::cos(kPi * (2.0 * tt / a - 2.0 / a + 1.0))));
                        else win = 1.0f;
                        break;
                    }
                    case 2: { // Gaussian
                        const double d = (tt - 0.5) / 0.18;
                        win = static_cast<float>(std::exp(-0.5 * d * d));
                        break;
                    }
                    default: // Hann
                        win = static_cast<float>(0.5 - 0.5 * std::cos(2.0 * kPi * tt));
                        break;
                    }
                    win *= g.ampScale;
                    gL += interpolate(Lc, g.readPos, sampStart, sampEnd) * win;
                    gR += interpolate(Rc, g.readPos, sampStart, sampEnd) * win;
                    g.readPos += g.readRate;
                    ++g.age;
                    if (g.age >= g.length
                        || g.readPos >= static_cast<double>(sampEnd)
                        || g.readPos < static_cast<double>(sampStart)) {
                        g.active = false;
                    }
                }

                // --- Track volume / pan / clipper / sends → deck mix ---
                // One pulsaret at a time (no overlap), so the windowed peak is ~unity — no overlap
                // compensation needed.
                const float vol = track.volume;
                const float pan = std::clamp(track.pan, -1.0f, 1.0f);
                float outL = gL * vol * std::sqrt(0.5f * (1.0f - pan));
                float outR = gR * vol * std::sqrt(0.5f * (1.0f + pan));
                sched.clipper.setParametersFromDrive(track.trackGain);
                sched.clipper.processSample(outL, outR);
                // Mixer-true mute (post-clipper so the clipper state keeps running): kills the
                // grain output AND its send feed below. Grain tracks previously ignored mute
                // entirely — the trigger gate never applied to this pass.
                if (ti < kMaxEnvelopeTracks) {
                    const float muteGain = state.trackBaseCurrent[ti][kRampChanMuteGain];
                    outL *= muteGain;
                    outR *= muteGain;
                } else if (track.mixMuted) {
                    outL = 0.0f;
                    outR = 0.0f;
                }
                // Per-track output routing (see the voice mix-sum): approximate for grain tracks —
                // the stateful clipper runs on the panned pair, so the post-clipper mono sum keeps
                // a slight pan-derived level shading (not worth a second clipper state).
                float ga1 = 0.0f, ga2 = 0.0f;
                if (ti < kMaxEnvelopeTracks) {
                    ga1 = state.trackBaseCurrent[ti][kRampChanAssign1];
                    ga2 = state.trackBaseCurrent[ti][kRampChanAssign2];
                } else if (routingOn) {
                    ga1 = track.outputAssign == 1 ? 1.0f : 0.0f;
                    ga2 = track.outputAssign == 2 ? 1.0f : 0.0f;
                }
                if (ga1 > 0.0f || ga2 > 0.0f) {
                    const float gm = (outL + outR) * 0.70710678f; // L+R, −3 dB
                    const float nW = std::max(0.0f, 1.0f - ga1 - ga2);
                    leftMix  += outL * nW + gm * ga1;
                    rightMix += outR * nW + gm * ga2;
                } else {
                    leftMix  += outL;
                    rightMix += outR;
                }
                const float grainSend = (outL + outR) * 0.5f;
                // SIG-3 activity/clip tap (see the voice-loop twin): grain outL/outR are already
                // post-volume/pan/clipper/mute — max(|L|,|R|) is this track's true output peak.
                if (ti < kMaxEnvelopeTracks) {
                    float& blockPeak = state.trackMixBlockPeak[ti];
                    blockPeak = std::max(blockPeak, std::max(std::fabs(outL), std::fabs(outR)));
                }
                // Ramped live slider base (see the ramp setup above the frame loop): fader moves
                // are heard immediately and click-free. Grain tracks have no per-step offsets.
                if (ti < kMaxEnvelopeTracks) {
                    const auto& sBase = state.trackBaseCurrent[ti];
                    send1Mix += grainSend * sBase[0];
                    send2Mix += grainSend * sBase[1];
                    send3Mix += grainSend * sBase[2];
                    send4Mix += grainSend * sBase[3];
                } else {
                    send1Mix += grainSend * track.send1Level;
                    send2Mix += grainSend * track.send2Level;
                    send3Mix += grainSend * track.send3Level;
                    send4Mix += grainSend * track.send4Level;
                }
            }
        }

        // ⚠️ THERE USED TO BE A HARD CLIP HERE:
        //     leftMix  = std::clamp(leftMix,  -1.0f, 1.0f);
        //     rightMix = std::clamp(rightMix, -1.0f, 1.0f);
        //
        // A raw, un-anti-aliased ±1.0 clamp on the DECK's voice sum — before the X-MIX carve, before
        // the crossfader, before the deck gain, before the master stage, and before the master fader.
        // It is not in the legacy engine (checked: the deleted SequencerNode has no such clamp); the
        // migration introduced it. Two things were wrong with it:
        //
        //   1. It clipped a signal that had not finished being mixed. Pulling the master fader down
        //      could not rescue a hot deck, because the damage was already done four stages upstream.
        //      That is the actual reason "more headroom since the migration" felt untrue: the OUTPUT
        //      ceiling went down (the fader now sits after the master clip), while the point at which
        //      the mix STARTED clipping moved earlier.
        //   2. It is a hard clip with no oversampling and no ADAA of any kind, so every deck that ran
        //      hot was folding broadband alias straight into the mix — the very thing the master
        //      clipper's oversampler exists to avoid, undone before the master clipper ever saw it.
        //
        // The ±10 blow-up guard below is retained: it is a NaN/runaway backstop, three decades above
        // anything musical, and it does not shape audio.
        //
        // Consequence to know about: the deck bus can now exceed ±1.0, so the output meter and
        // pushOutputCapture's peak scan will see it. That is correct — they are supposed to.
        //
        // P8-3: flush the recursion's state before it goes subnormal. On silence this filter
        // free-runs (y[n] = 0.9995·y[n-1]) and STICKS at ~1e-42 forever — see NativeDenormal.hpp.
        // The flush is applied to the value that becomes the state, so both the state and the
        // sample written below are clean.
        const float blockedLeft =
            flushDenormal(leftMix - state.dcInputLeft + dcBlockR * state.dcOutputLeft);
        const float blockedRight =
            flushDenormal(rightMix - state.dcInputRight + dcBlockR * state.dcOutputRight);
        state.dcInputLeft = leftMix;
        state.dcInputRight = rightMix;
        state.dcOutputLeft = blockedLeft;
        state.dcOutputRight = blockedRight;
        left[outputFrame] = std::clamp(blockedLeft, -10.0f, 10.0f);
        right[outputFrame] = std::clamp(blockedRight, -10.0f, 10.0f);
        if (send1 != nullptr) send1[outputFrame] = std::clamp(send1Mix, -10.0f, 10.0f);
        if (send2 != nullptr) send2[outputFrame] = std::clamp(send2Mix, -10.0f, 10.0f);
        if (send3 != nullptr) send3[outputFrame] = std::clamp(send3Mix, -10.0f, 10.0f);
        if (send4 != nullptr) send4[outputFrame] = std::clamp(send4Mix, -10.0f, 10.0f);
        ++state.framePosition;
        if (snapshot.isPlaying && !state.transportHeld) {
            // Quantized launch sub-block lead-in: consume silent frames without advancing the
            // transport so the deck's step-0 downbeat lands on the aligned frame (see launchGated).
            if (state.launchLeadInFrames > 0) {
                --state.launchLeadInFrames;
            } else {
                ++state.stepFrame;
                if (state.stepFrame >= state.currentFramesPerStep) {
                    state.stepFrame = 0;
                    ++state.masterStep;
                    state.currentFramesPerStep = targetFramesPerStep;
                }
            }
        }
    }
}

std::unique_ptr<RenderWorld> NativeAudioEngineCore::buildWorld() const {
    auto world = std::make_unique<RenderWorld>();
    world->mixerState = controlMixerState_;
    world->sequencerState = controlSequencerState_;
    world->unsupportedFeatures = controlSequencerState_.unsupportedFeatures;

    std::unordered_set<std::string> referencedSampleIds;
    for (const auto& track : controlSequencerState_.tracks) {
        if (!track.sampleId.empty()) {
            referencedSampleIds.insert(track.sampleId);
        }
    }
    for (const auto& sampleId : referencedSampleIds) {
        const auto sample = controlSamples_.find(sampleId);
        if (sample == controlSamples_.end() || !sample->second) {
            world->unsupportedFeatures.push_back("missingSample:" + sampleId);
            continue;
        }
        world->sampleBytes += (sample->second->left.size() + sample->second->right.size()) * sizeof(float);
        world->samples.emplace(sampleId, sample->second);   // shared_ptr copy (no PCM duplication)
    }
    std::sort(world->unsupportedFeatures.begin(), world->unsupportedFeatures.end());
    world->unsupportedFeatures.erase(
        std::unique(world->unsupportedFeatures.begin(), world->unsupportedFeatures.end()),
        world->unsupportedFeatures.end());
    return world;
}

std::uint64_t NativeAudioEngineCore::publishWorld(std::unique_ptr<RenderWorld> world) {
    retireAcknowledgedWorlds();
    world->generation = nextWorldGeneration_.fetch_add(1, std::memory_order_relaxed);
    // Stamp the live-control epoch so the audio thread can tell whether a per-track scalar override
    // is newer than this world. Reads >= any override epoch set before this publish was triggered,
    // so once the coalesced republish carrying the moved fader value lands here, the override stops
    // winning and the snapshot takes over (seamless hand-back). See LiveTrackControl.
    world->liveControlEpochAtPublish = liveControlEpoch_.load(std::memory_order_acquire);
    RenderWorld* published = world.get();
    ownedWorlds_.push_back(std::move(world));
    RenderWorld* coalesced = pendingWorld_.exchange(published, std::memory_order_acq_rel);
    if (coalesced != nullptr) {
        ownedWorlds_.erase(
            std::remove_if(ownedWorlds_.begin(), ownedWorlds_.end(),
                           [coalesced](const std::unique_ptr<RenderWorld>& owned) {
                               return owned.get() == coalesced;
                           }),
            ownedWorlds_.end());
    }
    publishedWorldGeneration_.store(published->generation, std::memory_order_release);
    return published->generation;
}

void NativeAudioEngineCore::installWorld(RenderWorld* pending) noexcept {
    if (pending == nullptr) return;
    // Per-deck transport state in the incoming world.
    auto deckIsPlaying = [](const RenderWorld* w, std::size_t di) -> bool {
        if (w == nullptr) return false;
        if (w->djMode) return di < kMaxDecks && w->decks[di].active && w->decks[di].snapshot.isPlaying;
        return di == 0 && w->sequencerState.isPlaying;
    };
    // Atomic control path: instead of wiping all render state on every publish — which cut held
    // voices, LFO phases, glide and the envelope-follower detector on every live parameter tweak
    // (each modifier drag → pushState → republish) — keep the render state and re-point each
    // active voice's sample pointer from the outgoing world to the incoming one (matched by
    // sample id). Per-voice params are read live from the snapshot, so edits apply seamlessly.
    // The outgoing voice->sample is still valid here (its world is retained until acknowledged).
    // A deck that is NOT playing in the new world is fully reset, so pressing stop still cuts it.
    for (std::size_t di = 0; di < kMaxDecks; ++di) {
        auto& rs = callbackRenderState_[di];
        if (deckIsPlaying(pending, di)) {
            for (auto& v : rs.voices) {
                if (!v.active || v.sample == nullptr) continue;
                const auto it = pending->samples.find(v.sample->id);
                if (it != pending->samples.end() && it->second) {
                    v.sample = it->second.get();     // same audio data, new world storage
                } else {
                    // Sample no longer in the new world → release and stop the voice.
                    if (v.rubberBandSlot >= 0) {
                        voiceStretchPool_.checkin(v.rubberBandSlot);
                        v.rubberBandSlot = -1;
                    }
                    v.sample = nullptr;
                    v.active = false;
                }
            }
        } else {
            // Stopped/inactive deck: release held stretch slots, then reset (cut sound).
            for (auto& v : rs.voices) {
                if (v.rubberBandSlot >= 0) {
                    voiceStretchPool_.checkin(v.rubberBandSlot);
                    v.rubberBandSlot = -1;
                }
            }
            rs = {};
        }
    }
    renderWorld_ = pending;
    activeVoices_.store(pending->mixerState.activeVoices, std::memory_order_release);
    // The DJ bus stretcher no longer adds output-timeline delay: neutral decks bypass it
    // (zero delay) and off-tempo engages are history-primed (outputSeek aligns the stretched
    // output to "now"), so the old unconditional busStretcher startupLatencyFrames() add here
    // over-reported the latency readout by ~150 ms in DJ mode. Report the base value only.
    declaredDSPLatencyFrames_.store(pending->mixerState.declaredDSPLatencyFrames,
                                    std::memory_order_release);
    acknowledgedWorldGeneration_.store(pending->generation, std::memory_order_release);
}

void NativeAudioEngineCore::consumePublishedWorld() noexcept {
    RenderWorld* pending = pendingWorld_.exchange(nullptr, std::memory_order_acq_rel);
    if (pending == nullptr) return;

    // Frame-exact pattern-scene switch routing. The deck-0 snapshot carries the switch tag (DJ mode
    // = the suppressed-owner composition path; single-deck otherwise). A tagged, not-yet-installed
    // world is PARKED (not installed): the old pattern keeps rendering until render() reaches the
    // boundary. An untagged world (or an already-installed switch eventID still being re-published
    // by the coordinator while Swift hasn't observed the boundary) installs normally.
    const NativeSequencerSnapshot& snap =
        pending->djMode ? pending->decks[0].snapshot : pending->sequencerState;
    const std::uint64_t eid = snap.patternSwitchEventID;
    const std::int64_t boundary = snap.patternSwitchBoundaryStep;

    auto dropPark = [this]() noexcept {
        if (parkedSwitchWorld_ == nullptr) return;
        RenderWorld* old = parkedSwitchWorld_;
        parkedSwitchWorld_ = nullptr;
        parkedBoundaryStep_ = -1;
        parkedSwitchGeneration_.store(0, std::memory_order_release);
        // Never installed → no voices point into it → safe to free immediately.
        ownedWorlds_.erase(
            std::remove_if(ownedWorlds_.begin(), ownedWorlds_.end(),
                           [old](const std::unique_ptr<RenderWorld>& w) { return w.get() == old; }),
            ownedWorlds_.end());
    };

    if (eid != 0 && boundary >= 0 && eid != lastInstalledSwitchEventID_) {
        // Replace any previously parked world (a re-arm carrying fresher data / a new target).
        if (parkedSwitchWorld_ != pending) dropPark();
        std::int64_t b = boundary;   // MUSICAL step (matches the published playhead domain)
        const std::uint32_t period = snap.patternSwitchPeriod;
        // Late arm: boundary already passed → roll forward by one period (= one full cycle of
        // the OUTGOING scene) to the next cycle. Compared in musical space.
        if (period > 0) {
            const std::int64_t now =
                static_cast<std::int64_t>(callbackRenderState_[0].masterStep)
                    - callbackRenderState_[0].patternAnchorStep;
            while (b <= now) b += static_cast<std::int64_t>(period);
        }
        parkedSwitchWorld_ = pending;
        parkedBoundaryStep_ = b;
        parkedSwitchEventID_ = eid;
        parkedSwitchGeneration_.store(pending->generation, std::memory_order_release);
        return; // hold — do NOT install; old world keeps rendering until the boundary
    }

    // Untagged publish (eid == 0) cancels/supersedes any pending park; install normally.
    if (eid == 0) dropPark();
    installWorld(pending);

    // Seamless "Run" pattern-scene switch (eid != 0 && boundary < 0): the world just installed with
    // the grid phase preserved. Make the new scene's cells that span the current playhead resume
    // mid-sample (instead of waiting to re-trigger from their owner) by resetting prevResolvedStep —
    // every spanning cell then reads as a fresh mid-cell entry at the next step boundary, reusing the
    // existing offset math. Guarded on eid so the coordinator's repeated republishes of the same
    // switch don't re-fire entries every block. Also arm the OWN-mode entry one-shot.
    if (eid != 0 && boundary < 0 && eid != lastInstalledSwitchEventID_) {
        lastInstalledSwitchEventID_ = eid;
        installedSwitchEventID_.store(eid, std::memory_order_release);
        callbackRenderState_[0].prevResolvedStep.fill(-1);
        callbackRenderState_[0].switchResumePending.fill(1);
        callbackRenderState_[0].clearRateMorph();  // Run switch cancels any multiply glide
        // Scene glide / clean cut riders (same arming as the parked-boundary install shapes,
        // but the switch is NOW): glide from the current values toward this world's settings,
        // and cut fades everything ringing as of the current playhead position. The anchor is
        // deliberately untouched — Run-immediate preserves the running musical position.
        callbackRenderState_[0].sceneGlideFramesRemaining = snap.patternSwitchGlideFrames;
        if (snap.patternSwitchCut) {
            callbackRenderState_[0].sceneCutAtStep =
                static_cast<std::int64_t>(callbackRenderState_[0].masterStep)
                    - callbackRenderState_[0].patternAnchorStep;   // musical "now"
        }
    }
}

void NativeAudioEngineCore::retireAcknowledgedWorlds() {
    const auto acknowledged = acknowledgedWorldGeneration_.load(std::memory_order_acquire);
    // Exclude the parked switch world's generation: it can be LOWER than `acknowledged` (it was
    // published before later edits) yet is still held by the audio thread until its boundary, so a
    // newer non-switch publish must not free it (the v1 use-after-free). parkedGen 0 = no park (no
    // world has generation 0), so the guard is inert when nothing is parked.
    const auto parkedGen = parkedSwitchGeneration_.load(std::memory_order_acquire);
    ownedWorlds_.erase(
        std::remove_if(ownedWorlds_.begin(), ownedWorlds_.end(),
                       [acknowledged, parkedGen](const std::unique_ptr<RenderWorld>& world) {
                           return world->generation < acknowledged && world->generation != parkedGen;
                       }),
        ownedWorlds_.end());
}

void NativeAudioEngineCore::updateTiming(std::uint64_t elapsedNanoseconds,
                                         std::uint32_t frameCount) noexcept {
    const double sampleRate = sampleRate_.load(std::memory_order_relaxed);
    const double deadlineNanoseconds = sampleRate > 0.0
        ? (static_cast<double>(frameCount) / sampleRate) * 1'000'000'000.0
        : 0.0;
    const double load = deadlineNanoseconds > 0.0
        ? static_cast<double>(elapsedNanoseconds) / deadlineNanoseconds
        : 0.0;

    callbackLoad_.store(load, std::memory_order_release);
    callbackCount_.fetch_add(1, std::memory_order_release);
    if (load > 1.0) {
        deadlineMissCount_.fetch_add(1, std::memory_order_release);
    }
}

} // namespace scoopyloops
