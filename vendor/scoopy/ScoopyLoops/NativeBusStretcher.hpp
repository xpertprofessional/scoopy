#pragma once


  #include "Signalsmith/signalsmith-stretch.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <thread>
#include <vector>

namespace scoopyloops {

// Bus tempo-sync ratio bounds (output/input duration). The Signalsmith fixed-output
// path renders inFrames = round(framesToRender / ratio) source frames per callback.
//   * Slowing down (ratio > 1) SHRINKS inFrames → costs nothing extra, so the upper
//     bound can be generous.
//   * Speeding up (ratio < 1) GROWS inFrames → the MIN ratio sets the input-scratch size
//     (ceil(maxBlock / minRatio)) and the per-callback render cost, so keep it modest.
// kBusStretchMinRatio = 0.25 → up to 4× speed-up (scratch = 4× block).
inline constexpr double kBusStretchMinRatio = 0.25;

// Slow-down / freeze ceiling, shared by BPM sync and granular browse/scrub. Far past the
// musical range so a master tempo near 0 BPM (or a browse speed near 0) drives inFrames
// down to 1 — a single source frame phase-randomised across the whole output: a frozen
// grain (spectral freeze). Slowing down SHRINKS inFrames, so this large ceiling costs no
// extra scratch (sizing is set by the MIN ratio / speed-up path only). 4096 → inFrames
// clamps to 1 at a 512-frame callback.
inline constexpr double kBusBrowseMaxRatio = 4096.0;

// Texture node bank: fixed analysis windows (ms), hop = block/4. One continuous "texture"
// control morphs along the bank — between nodes the two neighbours run in parallel and
// equal-power crossfade. A newly-needed node is engaged with a SPREAD warm-up (cheap
// seek() from history, then its output is produced-and-discarded across the following
// callbacks until its startup latency has drained) — steady-state cost only, never a
// prime burst, so live texture drags cannot glitch the callback. Small windows =
// grainy/robotic scrub; large = smeared spectral wash (480/960 ms = Paulstretch
// territory). Node 2 (120 ms/30 ms) = the classic presetDefault sound, which is why the
// default texture sits on it.
inline constexpr int    kBusTextureNodes = 6;
inline constexpr double kBusTextureBlockMs[kBusTextureNodes] = { 25.0, 60.0, 120.0, 240.0, 480.0, 960.0 };
inline constexpr double kBusTextureDefault = 2.0 / 5.0;   // node 2 = 120 ms (legacy default)

// Warp Focus weighting (see setWarpFocus): logistic in log-frequency about a FIXED center,
// h(f) = 1/(1 + (fc/f)^k). k = 1.5 puts the 10%→90% transition across ≈ ±2.1 octaves
// (~180 Hz … 3.5 kHz around the 800 Hz center) — gentle enough that the composite warp
// map stays effectively monotone at musical alpha values.
inline constexpr double kWarpFocusCenterHz = 800.0;
inline constexpr double kWarpFocusSlope    = 1.5;

// One per-deck time-stretch BUS: a single multi-channel stretcher (per texture node)
// processes [mainL, mainR, send1..send4] together, so main and sends share an identical
// group delay and stay sample-locked by construction.
class NativeBusStretcher {
public:
    using Stretch = signalsmith::stretch::SignalsmithStretch<float>;

    // Allocate all texture nodes + scratch/history. Call off the audio thread.
    //
    // asyncWarmup=false (default): the node warm-up (worst-case process + outputSeek per
    // node, so the render thread never allocates later) runs inline — configure() returns
    // fully warm. This is what the standalone plugin wants (hosts expect prepareToPlay to
    // block, and auval renders immediately after).
    //
    // asyncWarmup=true: the warm-up runs on a background thread and configure() returns
    // immediately (~600 ms sooner for a 6-node bank — measured as a main-thread hang at
    // app launch, since the JUCE device open must happen on main). Until it finishes,
    // isWarm() is false and every method that touches the stretcher nodes is a safe
    // no-op / dry bypass; the caller should keep the bus on its dry path and engage only
    // once isWarm() reports true (the core does this in processDeckBusStretch).
    void configure(double sampleRate, int channels, int maxBlockFrames,
                   bool asyncWarmup = false);

    ~NativeBusStretcher();

    // True once the (possibly background) node warm-up has completed. Acquire-ordered:
    // a true result makes the warmed stretcher state visible to this thread.
    bool isWarm() const noexcept { return warm_.load(std::memory_order_acquire); }

    // Full reset to neutral; marks the deck inactive. Call from stop().
    void reset();

    // Reset on active<->inactive transitions so a re-activated deck starts clean.
    void setActive(bool active);

    // Produce `outFrames` of stretched output from `inFrames` of input (fixed-output model:
    // the stretch ratio is implicit in the counts; `ratio` is ignored). Runs one or — while
    // the texture morphs between nodes — two stretchers and equal-power blends them.
    // Appends the input to the internal history ring afterwards (feeds node priming).
    void process(const float* const* in, int inFrames,
                 float* const* out, int outFrames, double ratio);

    // Group delay (frames) of the current primary node (input+output latency).
    int startupLatencyFrames() const;

    // Continuous window-texture control, 0…1 across the node bank (see kBusTextureBlockMs).
    // RT-safe member write; the audible value is one-pole smoothed inside process() (~50 ms)
    // so coarse UI steps don't zipper. Newly-needed nodes are primed from history — no
    // reallocation, no dropout (unlike the removed live-reconfigure path).
    void setTexture(double texture01);

    // Pitch-shift the whole bus, decoupled from the time-stretch ratio. RT-safe (plain member
    // writes). `semitones` = transpose amount; `tonalityLimit` (0 = off) key-locks frequencies
    // above that fraction of the sample-rate. Realized inside the permanently-installed custom
    // frequency map (mapWarp) — NOT via setTransposeSemitones, which would clear that map.
    void setTranspose(double semitones, double tonalityLimit);

    // Spectral warp (scrub/freeze sound design), applied inside the same custom frequency map.
    // All values in NORMALIZED frequency (fraction of sample-rate; 0.5 = Nyquist):
    //   * shiftNorm — additive frequency shift (breaks harmonic ratios: detune-beating small,
    //     metallic/bell at larger values, hollow when negative).
    //   * alpha    — spectral stretch exponent about pivotNorm (1 = none; >1 spreads the
    //     overtones, <1 compresses them; pivot frequency stays anchored).
    // RT-safe (plain member writes); evaluated per spectral peak per hop.
    void setWarp(double shiftNorm, double alpha, double pivotNorm);

    // Warp Focus, BIPOLAR −1…+1 (0 = off, bit-identical to the unfocused warp): weights the
    // warp DISPLACEMENT (the alpha exponent's log-frequency stretch + the additive shift)
    // per spectral peak by a logistic in log-frequency about a fixed ~800 Hz center
    // (kWarpFocusCenterHz/kWarpFocusSlope). < 0 confines the warp to lows/mids (high peaks
    // progressively pinned); > 0 keeps the stock high-biased character but pins lows/mids.
    // Negative focus also enables the vendored low-fill patch (setFreqMapLowFill) so bass
    // content below the lowest detected peak follows the warp instead of the rigid stock
    // translate. Transpose/key-lock and the pivot are never weighted. RT-safe.
    void setWarpFocus(double focusBipolar);

    // MOD gesture (the one "motion" control): a spring-loaded, momentary bipolar envelope
    // sweeping the spectral warp with FIXED musical relations (see the gesture-voicing
    // block in updateGestureModulation). Performed via ⌥+nudge keys or the on-screen deck
    // paddle; evaluated once per process() (block rate, well above gesture speeds).
    //
    // NOTE: spectral values never drive bus engagement — the core engages a deck's bus for
    // tempo reasons (ratio/transpose/browse) or the explicit SPECTRAL toggle only, and
    // force-neutralizes the creative layer (warp/blur/gesture) while the toggle is off
    // (see NativeAudioEngineCore::pushSpectralParams). So SP off at unity is silent/dry
    // by construction, no matter what values are dialled in.

    // Set the gesture target: −1…+1 while performed (keys send ±1, the paddle its
    // fractional drag position), 0 = released. The envelope charges toward the target
    // while held (fast at first — a tap already zaps) and springs back to 0 on release
    // over a time proportional to how long it was held. RT-safe plain member write.
    void setGestureTarget(double target);

    // Current gesture value for the UI paddle (−1…+1, manual envelope + X-MOD pulses
    // combined) — read by the core after process(). Plain member read, render thread.
    double gestureValue() const noexcept { return gestureDisplay_; }

    // Gesture shape (persisted per deck): depth scales how far the voicing sweeps at full
    // deflection (0…1, default 1); riseSecs is the charge time constant (smaller = snappier
    // taps AND faster full sweeps). RT-safe plain member writes.
    void setGestureShape(double depth, double riseSecs);

    // X-MOD (cross-deck modulation): the OPPOSITE deck's low-band onsets are injected here
    // as short pulses that ride the same gesture voicing. amount is BIPOLAR −1…+1: + = hits
    // push toward rise (laser stabs), − = hits push toward dive (spectral sidechain — the
    // other deck's kick smears/darkens this deck instead of ducking it). 0 = off. RT-safe.
    void setCrossMod(double amount);

    // Inject one opposite-deck onset (strength 0…1, from the core's detector). Instant
    // attack, fixed exponential decay (see the gesture-voicing block). Render thread only.
    void injectGesturePulse(double strength);

    // External continuous modulation summed DIRECTLY into the gesture voicing (bypasses the
    // performance spring/envelope) — for host-side LFOs in the standalone plugin wrapper.
    // Bipolar −1…+1, 0 = off. RT-safe plain member write. The app never sets this (stays 0),
    // so the deck/pool behaviour is unchanged.
    void setModExternal(double bipolar);

    // Freeze/extreme-stretch phase character (ScoopyLoops patch in the vendored header),
    // BIPOLAR −1…+1: +1 = stock diffuse/airy (random per-bin phase advancement); 0 =
    // coherent — the same grain loops in lockstep → periodic comb/metallic/robotic
    // freeze; −1 = all bins advance at the clean-stretch rate — the frozen spectrum
    // ROLLS forward as a locked drone instead of buzzing statically. RT-safe.
    void setPhaseChaos(double chaosBipolar);

    // Spectral blur base, 0…1 (ScoopyLoops patch in the vendored header): symmetric
    // per-bin dispersion of the phase-propagation rate at ANY ratio — the control that
    // turns the engaged bus into a spectral diffuser at normal playing tempo (unity),
    // where phase chaos alone is inert. Small = chorus-like shimmer whose grain follows
    // the texture window; 1 = dense smearing wash. The MOD gesture blooms it further;
    // the effective value is pushed to all nodes each process(). RT-safe.
    void setSpectralBlur(double blur01);

    // Air: post-stretch high-shelf (~5 kHz, 0…+12 dB) applied to the mixed bus output.
    // Phase-vocoder freezes/extreme stretches inherently soften highs (random-phase
    // decorrelation + peak-interpolated synthesis smears the peakless HF region; the warp
    // relocates or clamps HF energy) — this recovers the sparkle. RT-safe member write.
    void setAir(double gainDb);

    // Formant shift (semitones), independent of pitch — uses Signalsmith's built-in formant
    // engine (setFormantSemitones on every node). 0 = off (no cost). RT-safe.
    void setFormant(double semitones);

    // Spectral tilt EQ, bipolar −1…+1: >0 brightens (boost highs / cut lows), <0 darkens,
    // about a ~1 kHz pivot. Post-stretch, on the mixed output. 0 = flat. RT-safe.
    void setTilt(double tiltBipolar);

    // Clear to a neutral state without touching the active flag. RT-safe (no allocation).
    // Disengages all nodes and clears the internal history.
    void resetNeutral();

    // Declick engage: prime the active node(s) from the CORE's pre-stretch history so the
    // first process() after a neutral-bypass → stretch transition is aligned to "now".
    // `history` = `channels` pointers to `historyFrames` time-ordered frames ending at the
    // current input position. RT-safe after configure().
    void engagePrimed(const float* const* history, int historyFrames);

    // Ideal history length for engagePrimed() at this playback rate (= input/output speed).
    // Conservative: sized for the LARGEST node so any texture position can prime fully.
    int engageInputLength(double playbackRate) const;

    int blockFrames() const;      // current primary node's analysis window (frames)
    int intervalFrames() const;   // current primary node's hop (frames)

private:
    struct Node {
        Stretch stretcher;
        int    block    = 0;
        int    interval = 0;
        // Spread warm-up: output frames still to produce-and-discard before this node's
        // stream is timeline-aligned (0 = ready). Set to outputLatency() at engage.
        int    warmupRemaining = 0;
        // Short post-warm-up gain ramp (0…1) so a node never pops in at full weight.
        double fadeGain = 0.0;
        bool   engaged  = false;   // being fed (warming or ready)
        bool   ready() const noexcept { return engaged && warmupRemaining <= 0; }
    };

    // Composite frequency map installed ONCE per node at configure() via setFreqMap and
    // driven by the shared plain members below (written from the render thread — same
    // thread as process(), no atomics needed). Reproduces the library's transpose+key-lock
    // math exactly (which a custom map replaces), then applies the spectral warp:
    //   1. key-lock transpose: f ≤ corner → f·mult; above → f + (mult−1)·corner
    //   2. stretch about pivot: pivot·(f/pivot)^alpha
    //   3. additive shift, clamped to [0, 0.5] (normalized; edge plateaus stay monotonic).
    // Evaluated per detected spectral peak per hop (sparse) — allocation-free.
    // Reads the EFFECTIVE warp values (static SH/WA + gesture modulation), refreshed once per
    // process() before the stretchers run.
    float mapWarp(float f) const noexcept {
        double f1 = (f <= keylockCorner_) ? f * transposeMult_
                                          : f + (transposeMult_ - 1.0) * keylockCorner_;
        if (warpFocus_ == 0.0) {
            // Stock path, expressions untouched — bit-identical at neutral focus (the app
            // never sets focus, so its deck/pool spectral output cannot change).
            if (warpAlphaEff_ != 1.0) {
                const double p = warpPivotEff_ > 1.0e-9 ? warpPivotEff_ : 1.0e-9;
                f1 = p * std::pow(std::max(f1, 1.0e-9) / p, warpAlphaEff_);
            }
            f1 += warpShiftEff_;
        } else {
            // Focus weight at the RAW peak frequency (where the content sits, pre-transpose):
            // h = logistic in log-frequency about the fixed center (0 at lows → 1 at highs);
            // w² scales the warp displacement — exactly w² on the log-displacement
            // (α−1)·ln(f/p) and on the additive shift. QUADRATIC because attenuating a log
            // displacement linearly is perceptually weak (w = 0.02 still moves a 10 kHz
            // peak ~9% at α = 2): squaring keeps the gentle k = 1.5 shoulder but truly
            // pins the far band at full focus. Pivot and transpose stay unweighted.
            const double h = 1.0 / (1.0 + std::pow(warpFocusCenterNorm_
                                                   / std::max(static_cast<double>(f), 1.0e-9),
                                                   kWarpFocusSlope));
            const double w1 = 1.0 - std::abs(warpFocus_) * (warpFocus_ > 0.0 ? 1.0 - h : h);
            const double w = w1 * w1;
            const double a = 1.0 + (warpAlphaEff_ - 1.0) * w;
            if (a != 1.0) {
                const double p = warpPivotEff_ > 1.0e-9 ? warpPivotEff_ : 1.0e-9;
                f1 = p * std::pow(std::max(f1, 1.0e-9) / p, a);
            }
            f1 += warpShiftEff_ * w;
        }
        // Hard clamp to the band. NOTE: this MUST stay identity-preserving for in-band values —
        // at pure tempo-sync (no transpose/warp) f1 is already in [0, 0.5], so the clamp is a
        // no-op and the map is identity (time-stretch only, no pitch change). A soft-fold "edge
        // taper" was tried here but its knee reached into legitimately in-band low/high
        // frequencies and pitched the whole mix — a real energy taper needs a vendored
        // setFreqMap weight (out-of-band peaks attenuated, not remapped), deferred.
        return static_cast<float>(std::clamp(f1, 0.0, 0.5));
    }

    // Advance the MOD gesture envelope by one callback and refresh the effective warp
    // values (the fixed gesture voicing lives here).
    void updateGestureModulation(int outFrames);

    // Post-stretch high-shelf on the mixed output (see setAir()).
    void applyAirShelf(float* const* out, int outFrames);

    // Post-stretch bipolar tilt EQ on the mixed output (see setTilt()).
    void applyTilt(float* const* out, int outFrames);

    // Begin a node's spread warm-up: cheap seek() from the internal history (buffer copies
    // only — no burst), then process() discards its output until warmupRemaining drains.
    void beginNodeWarmup(int nodeIndex);
    // Join a still-running configure() warm-up thread (idempotent).
    void joinWarmup();
    void appendHistory(const float* const* in, int frames);
    int  linearizeHistory(int frames);   // newest `frames` → histLin_, returns count

    std::array<Node, kBusTextureNodes> nodes_;
    std::vector<std::vector<float>> histRing_;   // [channel][cap] internal pre-stretch input
    std::vector<std::vector<float>> histLin_;    // linearization scratch (time-ordered)
    std::vector<std::vector<float>> blendBuf_;   // secondary node output during a morph
    std::vector<std::vector<float>> warmBuf_;    // warming/fallback node output scratch
    int histCap_   = 0;
    int histPos_   = 0;
    int histCount_ = 0;
    // The node whose output holds the bus while a desired node is still warming (the last
    // node that was ready and audible). −1 until the first engage.
    int fallbackNode_ = -1;

    double sampleRate_      = 44100.0;
    int    channels_        = 4;
    int    maxBlockFrames_  = 512;
    double textureTarget_   = kBusTextureDefault;
    double textureSmoothed_ = kBusTextureDefault;
    double transposeMult_   = 1.0;   // 2^(semitones/12)
    double keylockCorner_   = 1.0;   // tonality/√mult (normalized); 1.0 = above Nyquist = off
    double warpShiftNorm_   = 0.0;   // additive shift, fraction of sample-rate (static base)
    double warpAlpha_       = 1.0;   // spectral stretch exponent (1 = none; static base)
    double warpPivotNorm_   = 200.0 / 44100.0;   // stretch anchor, fraction of sample-rate
    double warpFocus_       = 0.0;   // bipolar −1…+1 (0 = off; see setWarpFocus)
    double warpFocusCenterNorm_ = kWarpFocusCenterHz / 44100.0;   // normalized at configure()
    // Effective values consumed by mapWarp = base + gesture modulation (per callback).
    double warpShiftEff_    = 0.0;
    double warpAlphaEff_    = 1.0;
    double warpPivotEff_    = 200.0 / 44100.0;
    // Spectral blur (0…1): base set via the panel (Phase 3 DSP), modulated like the warp
    // targets; blurEff_ is refreshed per callback alongside the warp values.
    double blurBase_        = 0.0;
    double blurEff_         = 0.0;
    // MOD gesture state (see setGestureTarget()): spring-loaded momentary envelope.
    double gestureTarget_      = 0.0;   // −1…+1 while performed, 0 = released
    double gestureValue_       = 0.0;   // current envelope value (−1…+1)
    double gestureHeldSecs_    = 0.0;   // time performed so far (sets the release length)
    double gestureReleaseSecs_ = 0.3;   // computed at the release edge
    double gestureDepth_       = 1.0;   // voicing scale at full deflection (see setGestureShape)
    double gestureRiseSecs_    = 0.35;  // charge time constant (see setGestureShape)
    // X-MOD state (see setCrossMod()/injectGesturePulse()).
    double xmodAmount_         = 0.0;   // bipolar −1…+1 (0 = off)
    double xmodPulse_          = 0.0;   // current pulse envelope (0…1, decays after inject)
    double modExternal_        = 0.0;   // host-LFO input summed into g (plugin only; app = 0)
    double gestureDisplay_     = 0.0;   // manual + X-MOD combined, for the UI paddle
    // Air shelf state (per channel one-pole lowpass; shelf = x + gain·(x − lp)).
    double airGain_         = 0.0;   // linear extra gain on the HF component (0 = off)
    double airCoeff_        = 0.0;   // lowpass coefficient for the ~5 kHz corner
    std::array<double, 8> airLp_ {}; // per-channel lowpass state
    // Tilt EQ state (bipolar; out = x + gain·(x − 2·lp) about a ~1 kHz one-pole split).
    double tiltGain_        = 0.0;   // signed amount (0 = flat)
    double tiltCoeff_       = 0.0;   // one-pole split coefficient (~1 kHz)
    std::array<double, 8> tiltLp_ {};// per-channel lowpass state
    bool   wasActive_       = false;
    bool   configured_      = false;
    // Node warm-up completion gate (see configure(asyncWarmup:)). While false, methods
    // touching the stretcher nodes no-op / bypass — the warm-up thread owns the nodes.
    std::atomic<bool> warm_ { false };
    std::thread warmupThread_;
};

} // namespace scoopyloops
