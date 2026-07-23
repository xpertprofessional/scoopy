# Wizard

**The patchbay-recorder of the suite.** One sentence: *every sound on this machine is a
channel strip.*

| App | Verb set |
|---|---|
| ScoopyLoops | compose, perform |
| Parlante | master, edit, deliver |
| **Wizard** | **source, route, record, re-play** |

Any running application (via process tap), hardware input, file, or Wizard's own output
becomes a *channel*; any channel reaches any output bus, any of 1–8 recorder/player
decks, or the monitor. Other applications can select **"Wizard Out"** as their audio
device and thereby become channels too.

Wizard is deliberately **not a DAW timeline** and **not a sequencer**. Its performance
surface is the mixer itself plus a rack of 1–8 independent recorder/player decks — the
"playback composer": record anything, loop it or one-shot it, and record the next thing
live into another deck while the first plays.

## Repository map

| Path | Contents |
|---|---|
| `engine/` | Portable C++20 core — routing graph, channels, decks, ASRC, recorder drains, loopback, watchdog, metering. Static lib `wz_engine` behind the C ABI `engine/include/wz_engine.h`. No device code, no file-format code, no platform headers. |
| `host/` | JUCE 8 — duplex device IO, decode/encode, capture backends (macOS process taps, Linux PipeWire), crash-safe WAV writers, plugin hosting. Platform code lives here and only here. |
| `shell/` | JUCE 8 `WebBrowserComponent` app. **Shell law:** transport, window/menu chrome, file dialogs, lifecycle/permissions — nothing else. |
| `web/` | React 18 + TS + Vite + Zustand + Zod. Owns the **Patch** document. |
| `webdist/` | Committed web bundle (freshness-gated by `webdist:check`). |
| `driver/mac/` | Standalone AudioServerPlugIn sub-project — the "Wizard Out" virtual device (P5). |

## Documents

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Frozen reference: tier split, engine modules, ABI shapes, capture backends, HotFrame, UI panels, gates, **loop protocol** |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Signed audio decisions — buildable without re-asking |
| [MIGRATION.md](MIGRATION.md) | Work ledger, one row per increment. **Read its Top-level roadmap first every session.** |
| [docs/specs/](docs/specs/) | Per-domain specs (capture · routing · asrc-clock · decks · recorder · …) |

Design-phase source documents and the capture-layer ground truth live outside this repo
in `~/audio-routing-research/` (`feasibility.md`, July 2026).

## Build

```sh
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j
ctest --test-dir build --output-on-failure

cd web && npm ci && npm run typecheck && npm test
```

v1 platforms: **macOS 14.4+** and **Linux (PipeWire)**. Windows is deferred by decision —
its virtual-device kernel-driver cost is commercial, not technical (feasibility §2, §4.2).
