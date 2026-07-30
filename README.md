# Scoopy — the merged tree

**ScoopyLoops' full instrument, hosted on Wizard's plane.** One sentence: *the plane of
channel strips is the main view, and scoopy's decks, loopers and mixer live inside it.*

This repository is the **merge** of two apps:

| Donor | What it brought |
|---|---|
| **ScoopyLoops** | The advanced DJ/looper instrument — the audio core (`ScoopyLoops/`, C++20), the complete React UI (`web/`), sessions/kits/maps, the grid sequencer, decks A–C, FX returns |
| **Wizard** | The *plane* — an infinite surface of channel strips with routing, patching, per-strip recording, and the JUCE shell that hosts it all natively |

The shipping ScoopyLoops app lives in its own sibling repository; this tree is a strict
**superset** of its web UI (byte-identical panels, verified by audit) plus the plane, the
merged JUCE host, and the SL ABI v3 engine seam. Nothing of scoopy's may be lost — that
is the merge's standing law.

The app target is **WizardMerged**: scoopy's real webdist in multi-window JUCE WebViews,
speaking to a real engine through wizard's audio IO. Strips are one kind each — a grid
(deck) strip or a looper (tape) strip; "the looper records the deck" is two routed
strips. A deck strip expands into a ~2×3-cell tile hosting the REAL `GridPanel`
(D-SL-MORPH-01). Plugin hosting on the FX returns (scoopyloops' own `NativePluginHost`,
AU + VST3) is compiled in and being wired up (phase P6).

## Repository map

| Path | Contents |
|---|---|
| `ScoopyLoops/` | The audio core — C++20, in-tree and writable since P3-0. Engine DSP, sequencer, decks, returns, and `NativePluginHost.mm` (JUCE AU/VST3 hosting, real in the app target, stubbed for the headless gates) |
| `vendor/scoopy/engine/` | The core's portable CMake build + the DSP gates (null test, denormal, filter/clipper characterisation, choke, scene-switch, …) — also the WASM build the browser worklet uses |
| `slengine/` | SL ABI v3 — the merged engine's C surface over the core (`sl_engine.h`), plus tape/channel/watchdog subsystems |
| `engine/` | Wizard's own portable engine (`wz_engine`) — routing graph, recorder drains, metering |
| `host/` | JUCE 8 platform tier: duplex device IO, decode/encode, crash-safe writers |
| `shell/` | The **WizardMerged** app: WebView windows, SlDispatch command seam, settings, lifecycle. Shell law: transport + chrome + dialogs, nothing else |
| `web/` | React 18 + TS + Vite. Scoopy's entire UI **plus** the plane (`src/plane/`), the BrowserLink seam, stores, persistence (sessions/kits/maps, migrations) |
| `webdist/` | Committed web bundle, freshness-gated (`npm run webdist:check`) |
| `ThirdParty/JUCE` | JUCE 8 (CMake) |

## Documents

| Document | Contents |
|---|---|
| [docs/merge/P3-LEDGER.md](docs/merge/P3-LEDGER.md) | **The work ledger — orient here first.** One row per increment; the open phase queue is at the bottom (currently P6: plugins on the returns) |
| [docs/merge/STRIP-DECK.md](docs/merge/STRIP-DECK.md) | The strip-as-deck spec (the expandable deck tile) |
| [docs/archive/STRIP-MODEL.md](docs/archive/STRIP-MODEL.md) | What a strip is — one element kind each, routing, record taps |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Tier split, ABI shapes, HotFrame, gates, **loop protocol** |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Signed decisions — buildable without re-asking |

## Build

```sh
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure          # 65 gates: DSP, ABI, dispatch, audio fixtures

cd web && npm ci
npm run typecheck && npm test                       # vitest (1400+)
npm run bundle                                      # rebuild webdist (the app serves THESE bytes)
```

The app: `build/shell/WizardMerged_artefacts/WizardMerged.app`. On macOS the AU/VST3
plugin host compiles in by default (`SCOOPY_PLUGIN_HOST_ENABLED=ON`); the same binary is
its own out-of-process scan worker (`--scan-plugin <format> <id>`).

Loop protocol: one increment per commit, all gates green before push, ledger row updated
in the same commit. Green gates in a desktop browser are **not** proof — features must be
verified in the real JUCE host (WKWebView), which reaches different code paths.
