# Wizard — Work Ledger

> Source of truth for all work items. One row per item, one item per commit.
> Status: `todo` / `in-progress` / `done` / `blocked(<reason>)` / `awaiting-decision` /
> `awaiting-user` / `awaiting-signoff`.
> Types: `spec` / `schema` / `build` / `fixture` / `gate` / `delete`.
> Rules and loop protocol: `docs/ARCHITECTURE.md` §11. Signed audio decisions:
> `docs/DECISIONS.md`.

## Top-level roadmap (read FIRST every orient — the reflected view; update at phase entry/exit)

- **Now — P0 walking skeleton + risk spike (OPEN, entered 2026-07-23).** Stand up the repo
  on the parlante-next template (`engine`/`host`/`shell`/`web`, keyed C ABI, ledger, signed
  decisions, gates green from commit 1). Target of the phase gate P0-G1: shell boots on
  macOS + Linux, sound out, meters move, all gates green. Seven decisions signed this
  session (D-WZ-NAME/RATE/CLOCK/DSP/CORE-01/CORE-02/DESIGN-01 — see `docs/DECISIONS.md`).
  **Schema v1.**
- **Next — P1 mixer slice (same-clock only).** Channels bound to hardware inputs + one deck
  playing a decoded file; faders/pan/mute/sends; main + monitor buses; strip meters;
  routing matrix (DAG-only). No ASRC yet — everything on the device clock. **PD design
  identity** interleaves after P1.
- **Later — P2 capture + ASRC** (the drift fixture is the centerpiece; `wz_capture.h` +
  fake backend → macOS taps → ASRC → Linux PipeWire) · **P3 deck recorder** (Law C-3
  gapless handoff + crash-safe BWF) · **P4 playback composer** (1–8 decks, signed
  varispeed, loopback + watchdog, 8-bus spatial map, strip mode) · **P5 virtual device**
  (clean-room AudioServerPlugIn) · **P6 plugins** · **P7 sessions** · **P8 release**.
- **Blocked on user:** P0-R (AudioCap/TCC empirical spike — runbook written, user fills the
  blanks) · P0-G1 visual boot confirmation on Linux · creating a GitHub remote (CI cannot
  run until one exists — outward-facing, the user's call).
- **Parked decisions (awaiting-decision, do not block):** D-WZ-DECK-01 (before P3) ·
  D-WZ-PDC-01 (before P6) · D-WZ-SHARED-01 (after P2).

## Phase P0 — walking skeleton + risk spike

| id | type | item | status | handoff note |
|---|---|---|---|---|
| P0-01 | build | Repo scaffold: dirs per REPO-BLUEPRINT §1, README, docs/ARCHITECTURE.md (+ loop protocol/decision cadence/completeness rules), docs/DECISIONS.md (7 signed), this ledger, .gitignore, initial commit | done | 24074e9. git init; docs seeded from design docs + parlante process sections; 7 decisions written in id·date·decision·rationale·consequences form; 3 parked rows |
| P0-02 | build | web/ scaffold: Vite + React 18 + TS + Zustand + Zod + vitest; strict TS (noUncheckedIndexedAccess), base:'./' for resource-provider serving; typecheck + test green | done | mirrors parlante web config (tsconfig strict flags, vite base:'./', vitest env node); placeholder App; typecheck + test green. protocol/abi/tokens/webdist scripts declared, wired in P0-03/08/09/10 |
| P0-03 | schema | web/protocol/schema.ts v1: schemaVersion handshake, ping, getCapabilities; HotFrame scalars (schemaVersion, engineTimeSamples, cpuLoad, feedbackAlarm, main/monitor peaks); PARAM_IDS seeded (mainGain); codegen → shell/generated/WZProtocol.h; protocol:check gate tamper-tested | done | wz::protocol namespace, 8 HotFrame scalars (schemaVersion slot 0), caps carry processCapture/virtualDevice/pluginHosting/fileSystem/audioDeviceSelection; 5 protocol tests; protocol:check fails on SCHEMA_VERSION bump, OK on restore. WorldPublish Patch shape lands P1 |
| P0-04 | build | engine/ CMake: wz_engine static lib, C++20, -ffp-contract=off + strict warnings; wz_engine.h ABI v1 subset (create/destroy, param-by-name, render N bus outs = silence, hotframe w/ schemaVersion echo); null_smoke ctest; top-level enable_testing() | todo | |
| P0-05 | build | Vendor JUCE 8.0.13 + libsamplerate (copy from parlante-next); libsamplerate_smoke ctest; JUCE_USE_CURL=0 on every JUCE-linking target | todo | |
| P0-06 | build | shell/ JUCE WebView app: boots, serves committed webdist/ via resource provider; wz_webresources lib + web_resources_test (traversal containment, MIME) | todo | |
| P0-07 | build | EngineLink TS + JuceLink transport (Command round-trip + HotFrame push); wzCommand native fn → pure CommandDispatch (ping/getCapabilities, headless-tested); wzParam listener keyed by name; 30 Hz wzHotFrame timer; capabilities handshake end-to-end; vitest cases | todo | |
| P0-08 | gate | ABI coverage gate: checkAbiCoverage.ts parses hand-written engine source vs schema.ts (not the generated header — circular); engine/tools/abi-not-carried.json; wired into npm test + abi:check; tamper-tested | todo | |
| P0-09 | gate | webdist freshness gate: webdistFresh.ts hashes bundle inputs → webdist/.buildhash on bundle; webdist:check recomputes; kept out of npm test; tamper-tested | todo | |
| P0-10 | build | Design token core: vendor tokens.ts + base.css from ScoopyLoops; check-tokens.ts gate + PD-05-style portability fixture; app-local token group for channel accents + rec/feedback lamps only (D-WZ-DESIGN-01) | todo | |
| P0-11 | build | host/ AudioIO duplex device (D-WZ-RATE-01): JUCE input+output one callback, bus→device-channel map, drives wz_engine_render; engine told real device rate + quantum; first audible increment (tone/passthrough) with main peaks moving | todo | |
| P0-12 | build | CI: .github/workflows/ci.yml — web job (typecheck/test/protocol:check/abi:check/check:tokens/webdist:check vs committed artifacts) + native matrix (macos-14, ubuntu-latest: configure/build/ctest). No Windows (v1 platform decision); WizardDriver excluded from Linux | todo | |
| P0-R | spec | docs/specs/capture.md: AudioCap/TCC empirical runbook with blanks — exact prompt text, when it fires, tccutil reset behavior, denial recovery, NSAudioCaptureUsageDescription hand-typing, signing requirement. User fills the blanks; loop skips it | awaiting-user | ROADMAP "P0-R first" reinterpreted as parallel per approved plan — no P0/P1 code depends on TCC; first dependent code is P2 taps |
| P0-G1 | gate | **Phase gate (human):** shell boots on macOS + Linux, sound out, meters move, all gates green | todo | offered only after the P0-AUDIT row confirms every P0 spec/CONFIRM is covered |

## Parked decisions

| id | needed before | status | question |
|---|---|---|---|
| D-WZ-DECK-01 | P3 | awaiting-decision | Deck RAM policy: cap per deck, then stop / spill / degrade-to-file? |
| D-WZ-PDC-01 | P6 | awaiting-decision | Parallel-path-only PDC in a live mixer (deviates from parlante full-PDC) |
| D-WZ-SHARED-01 | after P2 | awaiting-decision | Extract @suite/design-tokens + @suite/slp-codegen (rule of three) |
