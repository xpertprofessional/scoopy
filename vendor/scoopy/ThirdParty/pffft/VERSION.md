# pffft (vendored subset)

- **Upstream:** https://github.com/marton78/pffft (the maintained fork of Julien Pommier's PFFFT)
- **Commit:** `a4b03590cc2a4bea56f9721996e3057835799179` (fetched 2026-07-22)
- **License:** `LICENSE.txt` (BSD-like, FFTPACK heritage — see file)
- **Subset:** single-precision only — `pffft.h` (from upstream `include/pffft/`), `pffft.c`,
  `pffft_common.c`, `pffft_priv_impl.h`, `simd/pf_*_float.h` + `simd/pf_float.h` (from upstream
  `src/`). The double-precision variant, fastconv, fftpack test harness, and bench tools are
  deliberately NOT vendored.
- **Why (XP-0c / P8-3c):** Signalsmith's fast FFT backend off Apple. On macOS/Xcode the app uses
  Accelerate (`SIGNALSMITH_USE_ACCELERATE=1`); the portable CMake build selects pffft via
  `SIGNALSMITH_USE_PFFFT=1` on non-Apple native targets (Windows/Linux). WASM stays on
  Signalsmith's own scalar FFT until the P8-3c browser measurement pass.
- **Include layout:** `ThirdParty/` is already on the engine include path, so the Signalsmith
  wrapper's `#include "pffft/pffft.h"` resolves here; `pffft.c`'s own `#include "pffft.h"` and
  `#include "simd/pf_float.h"` resolve file-relative. No upstream file was modified.
