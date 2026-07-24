#pragma once

#include <cstdint>

namespace scoopyloops {

// ─────────────────────────────────────────────────────────────────────────────────────────────
// TPT / ZDF state-variable filter (topology-preserving transform, trapezoidal integration).
// Cytomic (Andrew Simper) "SvfLinearTrapOptimised2" form; the derivation is Zavalishin's
// "The Art of VA Filter Design". Both are published and the algorithm is explicitly public domain.
//
// WHY THIS REPLACED A BIQUAD. The previous implementation was an RBJ cookbook biquad in
// Direct-Form-II-Transposed, and for a STATIC filter it was fine — an RBJ lowpass and a TPT lowpass
// are the same bilinear transform of the same 2-pole prototype, so they have the same poles and the
// same magnitude response. The problem is that this filter is never static: cutoff is modulated by
// LFOs, per-cell glide, per-step offsets and fader moves, and the coefficients are recomputed every
// sample.
//
// A direct form's state variables are not physical. They are convolutions of past input and output,
// weighted by the CURRENT coefficients. Change the coefficients and you have silently redefined what
// the stored energy means, so the filter emits a transient corresponding to no input at all — and
// DF2T is the worst common form for exactly this. Measured on the old code (engine/tools/
// DSP-BASELINE.md): a one-sample cutoff jump on a Q=8 bandpass injected **+30.78 dB** of overshoot.
//
// A TPT filter's two state variables ARE physical: they are the integrator (capacitor) voltages.
// They mean the same thing at any coefficient, so cutoff and resonance can be changed every single
// sample with no transient, and the structure is stable for any g > 0, k > 0. There is no
// coefficient-continuity requirement at all. That — not the frequency response — is why every
// modern filter (Ableton's circuit models, Serum, Vital, NI's Reaktor Core, Cytomic's own) is on
// this topology.
//
// The other two properties that fall out for free:
//   • `g = tan(π·fc/fs)` is the exact prewarp, so the cutoff is exact at any frequency — no BLT
//     squashing of the response as it approaches Nyquist.
//   • Every response (LP/HP/BP/notch/peak/shelf) is the same recursion with a different 3-scalar
//     output mix (m0, m1, m2). Mode switching costs nothing and — because the STATE is
//     mode-independent — changing mode on a ringing voice is click-free by construction.
//
// All methods are called on the audio thread; no allocation, no virtual dispatch.
// ─────────────────────────────────────────────────────────────────────────────────────────────
struct NativeToneFilter {
    enum class Mode : std::uint8_t { tone = 0, lowPass, highPass, bandPass, notch };

    double sampleRate = 44100.0;

    // Trapezoidal SVF coefficients. a1/a2/a3 come from (g, k); m0/m1/m2 select the response.
    //
    // m0/m1/m2 are the CURRENT (ramped) output mix; tm0/tm1/tm2 below are where it is heading. They
    // are separate because a mode change is a step in the output otherwise — see the crossfade note
    // on `mixMoving`.
    //
    // gCoeff is the raw integrator gain (tan(π·fc/fs)) kept alongside the folded a1/a2/a3, because
    // the DRIVEN kernel needs it: after v1 is saturated, v2 must be re-integrated from the
    // SATURATED v1 (v2 = ic2eq + g·v1ˢ), and g is no longer recoverable from a2/a1 without a divide.
    double a1 = 0.0, a2 = 0.0, a3 = 0.0;
    double gCoeff = 0.0;
    double m0 = 1.0, m1 = 0.0, m2 = 0.0;

    // Integrator state per channel — the capacitor voltages. PHYSICAL, hence modulation-safe.
    double ic1L = 0.0, ic2L = 0.0;
    double ic1R = 0.0, ic2R = 0.0;

    // Smooth-chase state (frequency and Q lag toward target each sample).
    double frequencychase = 8000.0;
    double resonancechase = 0.7071;

    // Cached parameters.
    float lastTone = 0.0f;    // -100 … +100 (bipolar in `tone` mode; unipolar 0…100 in the others)
    float lastQ    = 0.7071f; // the ACTUAL quality factor, 0.5 … 18 — NOT a normalised 0…1
    // Resonance drive, 0 … 100 (UI units). 0 = the linear kernel, bit-identical to before the
    // feature existed. Above 0, a saturator engages on the band-pass node INSIDE the state update —
    // see processSample. This is what the old output-tanh pretended to be: the tanh sat OUTSIDE the
    // filter, so the resonant peak still ballooned freely (+24 dB at Q=16) and the tanh merely
    // squared the result off. Saturating the state bounds the stored energy itself, so resonance
    // self-limits and compresses the way an analog SVF's does.
    float lastDrive = 0.0f;
    Mode  lastMode = Mode::tone;
    bool  hasInitializedChaseState = false;

    // Reset integrator state (call on voice activate; do NOT reset the chase, so smoothing continues).
    void reset() noexcept;

    // Cheap — caches parameters only. Coefficients are built in processSample, from the chase.
    //
    // ⚠️ THE SPLIT IS LOAD-BEARING. Instrument slots call this once per BLOCK
    // (NativeAudioEngineCore.cpp, outside the frame loop) and rely on the per-sample chase to smooth
    // between calls. Move the coefficient math in here and instrument tracks get an audible zipper
    // on every tone sweep.
    //
    // `drive` defaults to 0 (linear) so the eight call sites that predate the parameter — the soak
    // target, render_null, denormal_test among them — compile and behave unchanged.
    void setParameters(float tone, float q, Mode mode, float drive = 0.0f) noexcept;

    // Called once per sample on the audio thread. Modifies left/right in-place.
    // No-op when the effective tone is <= 0.5 (except band-pass, which colours everywhere).
    void processSample(float& left, float& right) noexcept;

    // True while a mode crossfade is still in flight. The engine's per-sample recompute is gated on
    // "something changed", so it needs to know to keep calling us for the few ms after a mode change
    // has otherwise settled — else the crossfade stalls half-way and the filter parks on a blend.
    [[nodiscard]] bool mixIsMoving() const noexcept { return mixMoving; }

private:
    // The tone→Hz mapping (exp/pow/log) depends ONLY on lastTone, lastMode and sampleRate — never on
    // the chase — so it is computed when those change, not per sample. Leaving it in the hot path is
    // what kept the old filter at 0.29% of a core per voice even when nothing was moving.
    double targetFreq       = 8000.0;
    double targetSampleRate = 0.0;    // 0 forces a refresh on the first updateCoefficients()

    // The mode the current coefficients were built from; the chase values double as the freq/Q
    // provenance, since the coefficients are rebuilt on every sample the chase actually moves.
    //
    // ⚠️ `coeffValid` is NOT redundant with `coeffMode`, and leaving it out is a silent, total
    // failure rather than a subtle one. `coeffMode` initialises to `tone`, so a track that is
    // ACTUALLY in tone mode matched the "nothing changed" early-out on its very first sample and
    // returned before any coefficient had ever been built — leaving a1/a2/a3 at 0 and m0 at 1, i.e.
    // a straight passthrough. The tone filter was completely flat, and only in tone mode (the other
    // four modes were saved by coeffMode disagreeing). Validity has to be tracked, not inferred.
    Mode coeffMode  = Mode::tone;
    bool coeffValid = false;

    // ── The mode crossfade ───────────────────────────────────────────────────────────────────
    // Changing mode changes which node of the filter you TAP (LP is v2, BP is v1, HP is
    // v0 − k·v1 − v2, …). The two taps carry different instantaneous values, so switching between
    // them steps the output — measured at +65 dB above the signal's own slew (BP→LP at Q=16) — and
    // that is true of ANY topology, including a biquad. It is NOT a state problem: the SVF's state
    // is perfectly physical and does not need to change at all.
    //
    // But because every response is a linear combination of the SAME two state variables, the fix
    // is nearly free HERE and is impossible in a biquad (which would need two filters running in
    // parallel to crossfade between): ramp the output mix instead of switching it. An intermediate
    // (m0,m1,m2) is an exact linear blend of the two responses, so this is a true crossfade, not an
    // approximation of one. ~1.35 ms, the same chase constant as cutoff and Q.
    //
    // `mixSeeded` snaps the mix on first activation and on voice retrigger — without it every new
    // voice would audibly crossfade in from the m0=1 passthrough the struct default represents.
    double tm0 = 1.0, tm1 = 0.0, tm2 = 0.0;
    bool   mixSeeded = false;
    bool   mixMoving = false;

    double effectiveTone() const noexcept;
    double calculateTargetFrequency() const noexcept;
    void   refreshTargetFrequency() noexcept;
    void   updateCoefficients() noexcept;
    bool   isLowpassMode() const noexcept;
};

} // namespace scoopyloops
