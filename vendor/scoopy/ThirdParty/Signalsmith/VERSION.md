# Signalsmith Stretch

**Upstream version:** 1.3.2
**Pinned commit:** `57b93f4e9206a089a45387eaa39bdc9f310d3308` (main, 2026-01-24, `version[3] = {1,3,2}`)
**Source:** https://github.com/Signalsmith-Audio/signalsmith-stretch
**License:** MIT (see `LICENSE.txt`)

## Dependency: signalsmith-linear

Since 1.2, the stretch header depends on **signalsmith-linear** (STFT + FFT) instead of the old
bundled `dsp/` library. We vendor it at:

- **signalsmith-linear version:** 0.3.1 (tag `0.3.1`)
- **Source:** https://github.com/Signalsmith-Audio/linear
- **License:** MIT (see `signalsmith-linear/LICENSE.txt`)

## Local patches (re-apply when re-vendoring!)

- **`setPhaseChaos(Sample)` + `phaseChaos` member** in `signalsmith-stretch.h` (marked
  `[ScoopyLoops local patch]`): BIPOLAR −1…+1 control over the per-bin time factor used
  for phase propagation beyond `maxCleanStretch` (the two former `timeFactorDist` sites
  in `processSpectrum`, now routed through the shared `binTimeFactorFor()` lambda — see
  the blur patch below). +1 = stock diffuse/airy extreme-stretch/freeze; 0 = coherent
  phase advance at the true factor → periodic comb/metallic looped-grain freeze; −1 =
  all bins advance at the clean-stretch rate → the frozen spectrum rolls forward as a
  locked drone. Driven by the Stretch tuner ("Phase chaos" slider) via
  `NativeBusStretcher::setPhaseChaos` → `NativeAudioEngineCore::setDeckBusSpectral`.
- **`setPhaseBlur(Sample)` + `phaseBlur` member + `binTimeFactorFor()` lambda** in
  `signalsmith-stretch.h` (marked `[ScoopyLoops local patch]`): 0…1 spectral blur — a
  symmetric ±`blur·maxCleanStretch` per-bin dispersion of the phase-propagation rate
  (`blurDist`, declared next to `timeFactorDist` in `processSpectrum`) that works at ANY
  stretch ratio. At clean ratios (incl. unity) it opens the random path itself, turning
  the stretcher into a spectral diffuser at normal playing tempo; `phaseChaos < 0` slides
  the dispersion centre toward the clean-stretch rate there (rolling blur cloud), while
  `chaos ≥ 0` is inert at clean ratios. At extreme stretch blur adds width on top of the
  chaos character. `blur == 0` keeps every branch and RNG draw bit-identical to the
  chaos-patch-only build (null-test guarantee). IMPORTANT: `timeFactorDist` has reversed
  (invalid) bounds when `!randomTimeFactor`, so the clean-ratio path must only draw from
  `blurDist`. Driven via `NativeBusStretcher::setSpectralBlur` (per-callback push of the
  modulated `blurEff_` to all nodes).

## Vendored closure

- `signalsmith-stretch.h` — the stretch engine (`signalsmith::stretch::SignalsmithStretch<float>`)
- `signalsmith-linear/` — `stft.h`, `fft.h`, `linear.h` + `platform/` backend headers. Header-only;
  every `#include` is standard library or relative within the directory.
- `LICENSE.txt` / `signalsmith-linear/LICENSE.txt` — MIT.

To re-vendor: clone both repos, copy `signalsmith-stretch.h` from the stretch repo root and
`stft.h`/`fft.h`/`linear.h`/`platform/` from the linear repo root (NOT the `include/` shim dirs).
Match the linear tag pinned by the stretch repo's `CMakeLists.txt` (`GIT_TAG`).

## Integration notes

- Header-only, C++. No static library, no `LIBRARY_SEARCH_PATHS`, no per-arch `.a`.
- Include via `#include "Signalsmith/signalsmith-stretch.h"` with `HEADER_SEARCH_PATHS`
  containing `$(SRCROOT)/ThirdParty`. The header's `#include "signalsmith-linear/stft.h"`
  resolves against its own directory, so no extra search path is needed.
- FFT backend: plain C++ by default. `SIGNALSMITH_USE_ACCELERATE` would switch to the Apple
  Accelerate backend (`platform/fft-accelerate.h`) — not enabled yet; flip deliberately and A/B.
- New API vs 1.1.0 we can use: `splitComputation` flag on `presetDefault`/`configure` (spreads
  FFT cost evenly, +1 interval latency), formant preservation (`setFormantSemitones`,
  `setFormantFactor`, `setFormantBase(0)` = auto-detect), `flush()`, `exact()`,
  `seekLength()`/`outputSeekLength()`.
- `presetDefault(nCh, sampleRate)` still = 120 ms window / 30 ms interval.
- `process(in, inN, out, outN)` is fixed-output; time ratio = inN/outN.
- Migration history: `SIGNALSMITH_STRETCH_MIGRATION_PLAN.md` (replaced GPL RubberBand).

## Local patches ([ScoopyLoops patch] markers — re-apply on re-vendor)
- `signalsmith-linear/fft.h`, `signalsmith-linear/platform/fft-pffft.h`: added `#include <cstring>`
  — both call `std::memcpy`, and libstdc++ 13+ (ubuntu-latest, emscripten) and the MSVC STL no
  longer include it transitively; Apple libc++ does, which is why only non-mac CI legs failed
  (engine-matrix run 29920142607).
