// ─────────────────────────────────────────────────────────────────────────────────────────────
// P8-3 — the core's OWN denormal guard, because the host's is not always there.
//
// Every `juce::ScopedNoDenormals` in this codebase lives in the HOST layer (NativeJuceDeviceHost,
// NativePluginHost). That was fine while the only host was JUCE: it set FTZ/DAZ around the whole
// callback and the core never had to think about it. Compile the host out — which is exactly what
// the WASM build does — and the protection silently vanishes with it, because **WebAssembly has no
// flush-to-zero mode at all.** The spec mandates full IEEE-754 subnormals; there is no
// `_MM_SET_FLUSH_ZERO_MODE` to reach for, and there never will be.
//
// WHAT ACTUALLY GOES WRONG — measured, not theorised (engine/tools/denormal_test.cpp):
//
// The DC blocker is a one-pole recursion, y[n] = x[n] − x[n−1] + 0.9995·y[n−1], with FLOAT state.
// When the mix goes silent, x is exactly 0 and the state free-runs: y[n] = 0.9995·y[n−1], with
// nothing to re-normalise it. It decays geometrically, crosses FLT_MIN (1.18e-38) about 3.4 s into
// the silence, and then does something worse than merely being slow:
//
//     IT STOPS DECAYING AND STICKS.
//
// Around 1.4e-42 the decay step (0.0005·y) drops below half the gap between adjacent subnormals, so
// `0.9995f * y` rounds straight back to `y`. The recursion reaches a FIXED POINT inside the
// subnormal range and stays there — forever, or until the next loud signal re-normalises it. So the
// exposure is not a 0.7-second window during a fade-out; it is **every sample, for the rest of the
// session, on the audio thread**, on any platform that does not flush. Stop the transport in a
// browser and the engine quietly enters permanent subnormal arithmetic. (Measured: 279,826
// subnormal output samples in a 20 s render; zero after this fix.)
//
// This is invisible three ways, which is why it survived to now: it is not a build error, not a
// test failure, and NOT AN AMPLITUDE ERROR — the numbers are perfectly correct. A peak-residual
// null test cannot see it (a subnormal is below −760 dBFS; the gate is −80 dB), which is precisely
// why P8-3b's −153 dBFS result did not mean what the ledger read it to mean.
//
// ⚠️ HONEST ABOUT THE COST, because the ledger was not. The migration row calls this "a 10–100×
// CPU cliff". THAT WAS NOT REPRODUCED HERE. Measured on Apple Silicon, on the very render that
// produces the 279,826 subnormals above: native 170 ms → 168 ms, and WASM under node 440 ms →
// 435 ms. No cliff, either side. ARM64 handles subnormals in hardware; the catastrophic penalty is
// an x86/SSE phenomenon, where the FPU traps to microcode. So the cliff is REAL BUT PLATFORM-BOUND
// — and the companion runs in browsers on Intel Macs, Windows and Linux, which is most of them.
// This guard is cheap insurance for the platforms that do trap, not a speedup for the one we happen
// to develop on. Do not quote a 10–100× figure for Apple Silicon; it is not there.
//
// WHAT IS FULLY PROVEN, then, is the stuck state and the platform DIVERGENCE: without this flush,
// macOS (which flushes via the host's FTZ) drives the tail to exactly 0 while WASM (which cannot)
// parks it at 1.4e-42 forever. Those are different numbers, from the same source, on the same
// scene — and "the composition works identical" is the entire premise of Phase 8. That is why this
// is unconditional rather than `#if EMSCRIPTEN`: a guard that ran only in the browser would leave
// the two platforms computing different tails, which is the thing Phase 8 exists to prevent.
//
// THE THRESHOLD is 1e-25, and it is deliberately far ABOVE the subnormal boundary rather than at
// it. Two reasons: (1) flushing *before* the subnormal range is entered means the expensive
// arithmetic never happens even once, rather than being caught after the fact; (2) it makes the two
// platforms agree exactly — the explicit flush fires first, so FTZ's own boundary never gets a
// chance to matter. 1e-25 is ≈ −500 dBFS. The 24-bit noise floor is −144 dB. Nothing that is
// zeroed here was ever going to be heard, or even representable, in an output sample.
// ─────────────────────────────────────────────────────────────────────────────────────────────
#pragma once

namespace scoopyloops {

/// ≈ −500 dBFS. Below any audible, ditherable or even representable signal; far above FLT_MIN.
inline constexpr float kDenormalFloatFloor = 1e-25f;
inline constexpr double kDenormalDoubleFloor = 1e-25;

/// Snap a value that is on its way to nothing to actual nothing, before it becomes subnormal.
///
/// Branch, not `std::fabs` — this runs per sample per channel in the hot loop, and a compare
/// against two constants is what every DSP codebase uses here for a reason.
[[nodiscard]] inline float flushDenormal(float v) noexcept {
    return (v > -kDenormalFloatFloor && v < kDenormalFloatFloor) ? 0.0f : v;
}

[[nodiscard]] inline double flushDenormal(double v) noexcept {
    return (v > -kDenormalDoubleFloor && v < kDenormalDoubleFloor) ? 0.0 : v;
}

}  // namespace scoopyloops
