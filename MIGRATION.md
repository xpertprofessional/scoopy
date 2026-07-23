# Wizard — Work Ledger

> Source of truth for all work items. One row per item, one item per commit.
> Status: `todo` / `in-progress` / `done` / `blocked(<reason>)` / `awaiting-decision` /
> `awaiting-user` / `awaiting-signoff`.
> Types: `spec` / `schema` / `build` / `fixture` / `gate` / `delete`.
> Rules and loop protocol: `docs/ARCHITECTURE.md` §11. Signed audio decisions:
> `docs/DECISIONS.md`.

## Top-level roadmap (read FIRST every orient — the reflected view; update at phase entry/exit)

- **Now — P1 mixer slice OPEN (entered 2026-07-23; P0-G1 signed on macOS — user heard the
  boot tone).** Same-clock only: channels bound to duplex hardware inputs + one deck
  playing a decoded file; faders/pan/mute/solo; main + monitor buses; per-strip meters on
  HotSurface; routing matrix (DAG-only). No ASRC — everything on the device clock. Four
  P1 audio decisions signed 2026-07-23: **D-WZ-PAN-01** (−3 dB constant-power),
  **D-WZ-FADER-01** (−∞..+6 dB parlante taper, unity at 0.75), **D-WZ-RAMP-01** (10 ms
  raised-cosine mute / one-pole smoothers), **D-WZ-DECKSRC-01** (resample at load,
  SINC_BEST, zero SRC on the live path). Build order P1-01 → P1-09 below; the boot tone
  is DELETED in P1-04 (replaced by real summing + metering). **Gate P1-G1: mix mic + file;
  cue-monitor on device channels 3/4.**
- **Later — phase by phase, each with its centerpiece fixture and its blocking decision:**
  - **P2 capture + ASRC.** Order: `wz_capture.h` + deterministic fake backend (fixtures
    first) → macOS taps (open/close/format-change/process-vanish lifecycle) → source rings
    + ASRC PI controller (**centerpiece: `asrc_drift_test`, 48000 vs 48000.3 Hz synthetic
    clocks, simulated hour, <1 ms**) → source picker + TCC UX (needs P0-R findings) →
    Linux PipeWire backend (the abstraction proof; needs P0-G1-LINUX). Listening gate:
    zipper-free small ratio walks, else the polyphase fallback (risk register).
  - **P3 deck recorder.** Record with live monitor; **centerpiece: `deck_handoff_test` —
    record-stop → looping playback, gapless, sample-exact (Law C-3)**; parallel crash-safe
    BWF drain (`wav_killtest`: SIGKILL mid-record → recoverable); engine-sample stamps +
    "align to deck N" (Law C-2). **Blocked on D-WZ-DECK-01 (deck RAM policy) — sign before
    build.**
  - **P4 playback composer.** Full 1–8 deck rack; signed varispeed incl. reverse;
    LoopbackBus + watchdog (**centerpiece: `watchdog_test` — feedback ramp engages limiter
    within budget**); 8-bus output map + spatial UI; **strip mode as its own increment**
    (compact-first deck rack; shell adds only window constraints + always-on-top).
  - **P5 virtual device.** Clean-room AudioServerPlugIn from Apple's sample (GPL sources
    read-for-API-understanding ONLY — signed); sign/notarize/install scripts;
    channel-count decision row (2ch vs 2×2ch vs 16ch). Gate: ScoopyLoops selects "Wizard
    Out" and appears as a strip. *Parallelizable with P4.*
  - **P6 plugins.** Out-of-process scanner (Scoopy pattern), 4 inserts/strip, 4 FX
    send/returns as ordinary Channels. **Blocked on D-WZ-PDC-01 — sign before build.**
  - **P7 sessions.** STORED-zip package (`session.json` + `Takes/` + `Samples/`),
    preserve-don't-drop golden corpus, autosave + kill-restore soak.
  - **P8 release.** Notarized DMG bundling the driver pkg; Linux deb/flatpak; PD identity
    gate (third-wearer contract applied).
  - **PD design identity** interleaves after P1. **D-WZ-SHARED-01** (extract
    @suite/design-tokens + slp-codegen) decided after P2.
- **Blocked on user:** P0-G1 sign-off — (1) launch Wizard + confirm boot tone/meter,
  (2) Linux visual boot, (3) create a GitHub remote so CI proves Linux · P0-R (AudioCap/TCC
  spike — runbook written at `docs/specs/capture.md`, user fills the blanks).
- **Parked decisions (awaiting-decision, do not block):** D-WZ-DECK-01 (before P3) ·
  D-WZ-PDC-01 (before P6) · D-WZ-SHARED-01 (after P2).

## Phase P0 — walking skeleton + risk spike

| id | type | item | status | handoff note |
|---|---|---|---|---|
| P0-01 | build | Repo scaffold: dirs per REPO-BLUEPRINT §1, README, docs/ARCHITECTURE.md (+ loop protocol/decision cadence/completeness rules), docs/DECISIONS.md (7 signed), this ledger, .gitignore, initial commit | done | 24074e9. git init; docs seeded from design docs + parlante process sections; 7 decisions written in id·date·decision·rationale·consequences form; 3 parked rows |
| P0-02 | build | web/ scaffold: Vite + React 18 + TS + Zustand + Zod + vitest; strict TS (noUncheckedIndexedAccess), base:'./' for resource-provider serving; typecheck + test green | done | mirrors parlante web config (tsconfig strict flags, vite base:'./', vitest env node); placeholder App; typecheck + test green. protocol/abi/tokens/webdist scripts declared, wired in P0-03/08/09/10 |
| P0-03 | schema | web/protocol/schema.ts v1: schemaVersion handshake, ping, getCapabilities; HotFrame scalars (schemaVersion, engineTimeSamples, cpuLoad, feedbackAlarm, main/monitor peaks); PARAM_IDS seeded (mainGain); codegen → shell/generated/WZProtocol.h; protocol:check gate tamper-tested | done | wz::protocol namespace, 8 HotFrame scalars (schemaVersion slot 0), caps carry processCapture/virtualDevice/pluginHosting/fileSystem/audioDeviceSelection; 5 protocol tests; protocol:check fails on SCHEMA_VERSION bump, OK on restore. WorldPublish Patch shape lands P1 |
| P0-04 | build | engine/ CMake: wz_engine static lib, C++20, -ffp-contract=off + strict warnings; wz_engine.h ABI v1 subset (create/destroy, param-by-name, render N bus outs = silence, hotframe w/ schemaVersion echo); null_smoke ctest; top-level enable_testing() | done | 5627516. Keyed params carry a CHANNEL index from day one (mainGain master-global; per-channel in P1, no re-layout). Monotonic clock (D-CLOCK-01). null_smoke: bad-args, keyed round-trip, N-bus silence + null-ptr skip, rate introspection, hotframe capacity refusal |
| P0-05 | build | Vendor JUCE 8.0.13 + libsamplerate (copy from parlante-next); libsamplerate_smoke ctest; JUCE_USE_CURL=0 on every JUCE-linking target | done | c98a9a7. JUCE 8.0.13 (matches siblings); libsamplerate PRIVATE into wz_engine (no ABI leak), built EXCLUDE_FROM_ALL before strict flags; smoke proves SINC_BEST resample. 2/2 ctest green |
| P0-06 | build | shell/ JUCE WebView app: boots, serves committed webdist/ via resource provider; wz_webresources lib + web_resources_test (traversal containment, MIME) | done | app boots + builds .app, creates engine at boot (handshake path). wz_webresources headless-tested (SPA fallback, MIME, query/fragment strip, traversal containment). webdist/ bundle committed. 3/3 ctest. ⚠️ visual boot unconfirmed (screencapture blocked in dev env) → P0-G1 user check |
| P0-07 | build | EngineLink TS + JuceLink transport (Command round-trip + HotFrame push); wzCommand native fn → pure CommandDispatch (ping/getCapabilities, headless-tested); wzParam listener keyed by name; 30 Hz wzHotFrame timer; capabilities handshake end-to-end; vitest cases | done | engineLink/hotSurface vendored (pl→wz names); useEngineLink boots handshake + streams hotframes → store; App shows shell status + live clock + schema. wz_command lib shared by app + headless command_dispatch_test. 4 native + 17 web green |
| P0-08 | gate | ABI coverage gate: checkAbiCoverage.ts parses hand-written engine source vs schema.ts (not the generated header — circular); engine/tools/abi-not-carried.json; wired into npm test + abi:check; tamper-tested | done | ports verbatim (same kParamNames[]/kHotFrameLength ids); catches uncarried param, order drift, extra scalar, stale waiver. Tamper-tested 2 ways; 20 web green |
| P0-09 | gate | webdist freshness gate: webdistFresh.ts hashes bundle inputs → webdist/.buildhash on bundle; webdist:check recomputes; kept out of npm test; tamper-tested | done | ports verbatim. STALE on source edit, OK after rebundle. Kept out of npm test (mid-increment edits normal); CI/commit gate only |
| P0-10 | build | Design token core: vendor tokens.ts + base.css from ScoopyLoops; check-tokens.ts gate + PD-05-style portability fixture; app-local token group for channel accents + rec/feedback lamps only (D-WZ-DESIGN-01) | done | SHARED_CHROME + SHARED_TYPE byte-identical; Scoopy primitives NOT copied. check:tokens catches hardcoded hex + dangling var (asks tokenVars(), exact by construction); tamper-tested. Portability fixture pins the hexes. 25 web green |
| P0-11 | build | host/ AudioIO duplex device (D-WZ-RATE-01): JUCE input+output one callback, bus→device-channel map, drives wz_engine_render; engine told real device rate + quantum; first audible increment (tone/passthrough) with main peaks moving | done | duplex 2in/2out, opens at engine rate + refuses mismatch; renders into device output as bus buffers, chunked to engine max block. Engine: setTestTone (-18 dBFS 440 Hz, schema v2) + main-bus peak metering → HotFrame; UI toggle + dBFS readout. Input opened, engine consumption P2. 4 native + 25 web green. ⚠️ audible/visual = P0-G1 user check |
| P0-11a | build | Engine rebuild at the DEVICE QUANTUM (D-WZ-CLOCK-01): P0-11 chunks device blocks to the engine's fixed max block (48000/512 at boot); the engine block should equal the device quantum, and a device rate/quantum change should tear down + rebuild the engine (loud UI notice per D-WZ-RATE-01). Wire in P1 when channels make the quantum matter | todo | seeded from P0-11 |
| P0-12 | build | CI: .github/workflows/ci.yml — web job (typecheck/test/protocol:check/abi:check/check:tokens/webdist:check vs committed artifacts) + native matrix (macos-14, ubuntu-latest: configure/build/ctest). No Windows (v1 platform decision); WizardDriver excluded from Linux | done | web + native matrix; all 6 web gates verified in CI form locally; Release configure/build/ctest 4/4 green on macOS. ⚠️ needs a GitHub remote to actually run (outward-facing — user's call) |
| P1-metering | build | Move per-strip meters off the React store onto the HotSurface canvas (one rAF loop, ≤2 ms/frame budget). P0-11's store-routed main peak is the walking-skeleton path only — the real per-channel/bus meters render outside React | todo | seeded from P0-11 |
| P0-R | spec | docs/specs/capture.md: AudioCap/TCC empirical runbook with blanks — exact prompt text, when it fires, tccutil reset behavior, denial recovery, NSAudioCaptureUsageDescription hand-typing, signing requirement. User fills the blanks; loop skips it | awaiting-user | written. ROADMAP "P0-R first" reinterpreted as parallel per approved plan — no P0/P1 code depends on TCC; first dependent code is P2 taps |
| P0-AUDIT | spec | Phase audit: diff P0 specs/CONFIRMs against built rows, materialize every gap as a row before offering P0-G1 | done | all P0-01..12 done; follow-ups materialized (P0-11a, P1-metering); only awaiting-user rows left (P0-R, remote). No P0 gaps unrowed |
| P0-G1 | gate | **Phase gate (human):** shell boots on macOS + Linux, sound out, meters move, all gates green | done (macOS) | **SIGNED 2026-07-23: user heard the boot tone on macOS** — device→engine→meter→UI path confirmed end-to-end. Clean Release build + ctest 4/4 + all 6 web gates green. Remaining legs carried as their own rows: P0-G1-LINUX (visual boot) + P0-G1-CI (GitHub remote) — neither blocks P1 (macOS is the primary platform; Linux is the P2 abstraction proof) |
| P0-G1-LINUX | gate | Linux visual boot check (CI builds but cannot run a GUI) | awaiting-user | do before P2's PipeWire backend lands; not a P1 blocker |
| P0-G1-CI | gate | Create GitHub remote + push so the CI matrix actually runs (outward-facing — user's call) | awaiting-user | local CI-form runs green; remote proves ubuntu leg |

## Phase P1 — mixer slice (same-clock only)

| id | type | item | status | handoff note |
|---|---|---|---|---|
| P1-01 | spec | `docs/specs/routing.md`: channel-strip param set (gain/pan/mute/solo now; sends/arm/monitor-switch fields reserved), bus set (main + monitor now; fx1..4 + ≤8 user outputs reserved), pan/fader/ramp math transcribed from D-WZ-PAN/FADER/RAMP-01, DAG rule (loopback = P4), HotFrame per-channel block layout, same-clock input rule | done | normative math pinned (pan 1e-12, fader web↔engine 1e-9, ramp slope bound); srcRing fields reserved per strip so the P2 stride is stable; wz_engine_render_io extension named; 6 fixtures enumerated; solo = in-place main-only ramp |
| P1-02 | schema | Patch v3: Channel/Bus/Deck(playback-stub)/OutputMap schemas, WorldPublish envelope (strict, preserve-don't-drop), per-channel ParamWrite (name + channel index), commands: publishWorld, deckLoadFile, deckTrigger, transport-ish deck state in HotFrame per-deck block | done | schema v3. Full SourceKind enum ships now (forward-readable Patches); reserved strip fields (sends/arm/monitorSwitch/inserts) validated but engine-ignored; hotFrameLength/channelFieldIndex/deckFieldIndex helpers + codegen'd channel_block/deck_block strides; paramWrite coalesces per (id,channel); gain/pan/mute/solo WAIVED until P1-03 (abi-not-carried exercised for real); +deckSetLoop command; dispatch for publishWorld/deck* lands P1-03/07. 29 web + 4 native green |
| P1-03 | build | Engine world builder: wz_world_begin/channel_begin/set/end/commit — RCU snapshot install (Scoopy sl_snapshot_* pattern), per-channel param table, precomputed acyclic render order (trivial in P1: channels → buses) | done | world.h ChannelState w/ per-strip param atomics + render-side smoother slots; keyed world fields (wz_world_key_for_name, unknown ignored); commit = atomic swap, retired snapshots freed once renderWorldRev passes them (bounded by edit count if device closed); builder values ARE document values (no carry-over — publish self-heals a racing ParamWrite); publishWorld dispatch installs the Patch (kind→enum by schema order, malformed = structured fail); gain/pan/mute/solo waivers REMOVED (carried for real). world_test + dispatch publish cases; 5 native + 29 web green |
| P1-04 | build | Engine summing: channel DSP (D-WZ-PAN-01 pan, D-WZ-FADER-01 gain, D-WZ-RAMP-01 smoothers — no param reaches summing as a step), float64 accumulate (D-WZ-DSP-01) into main + monitor, per-strip peak/RMS, HotFrame per-channel blocks + real monitor peaks. **DELETE the boot tone** (setTestTone command + engine path + UI toggle) | done | fader = Fritsch–Carlson monotone cubic in dB (fader.cpp + faderCurve.ts twins, golden-pinned in P1-05); render_io carries same-clock inputs; preallocated f64 accumulators (render never allocates); fresh strips seed AT targets (publish ≠ gesture); solo ducks main only; NaN squelched at strip input; per-strip meters post-fader/mute pre-solo; hotframe = scalars + 7-slot channel blocks, short buffer refused, shell buffer grown-only; mainGain is now a fader POSITION (default 0.75); boot tone deleted everywhere (schema v4). Repo moved to ~/xpert/apps/wizard mid-increment (user); fresh configure, all green. 5 native + 29 web |
| P1-05 | fixture | Summing null-tests: pan-law table exact to 1e-12, ramp slope bound (no step > raised-cosine slope), 2-strip sum vs double-precision reference, NaN/denormal guards, fader-curve web↔engine pin fixture | done | summing_test (ctest) + faderCurve.test.ts (vitest) share ONE checked-in 21-point golden table @1e-9 — the cross-language pin; pan table 1e-12; engine-settled gains vs float32 quantization 1e-6; mute ramp slope-bounded AND ends at exact 0; NaN squelched; solo ducks main only w/ cue alive; fader monotone over 1000 steps both sides. 6 native + 33 web green |
| P1-06 | build | Host same-clock input feed: duplex input channels → deviceInput Sources → strips inside the same callback (no rings, no ASRC — same clock, D-WZ-RATE-01); input enumeration into the world; audioDeviceSelection capability true | done | AudioIO passes chunk-offset input pointers into wz_engine_render_io (same callback, zero added latency); getDeviceInfo command (shell-owned, parlante chooseAndLoadFile precedent) returns active-compacted inputs (index i == srcChan i), outputChannels, monitorAvailable (≥4 outs). Schema v5. DEVIATION: audioDeviceSelection stays FALSE — enumeration ≠ selection; honest capability. Device picker seeded as P1-10. 6 native + 33 web green |
| P1-10 | build | Device picker: choose which duplex device Wizard opens (list devices, switch = engine rebuild at new rate per D-WZ-RATE-01, loud notice). Flips audioDeviceSelection true. Not needed for P1-G1 (default device suffices); may slip to P2 | todo | seeded from P1-06 deviation |
| P1-07 | build | Deck v0 (playback only): host Decoder (JUCE AudioFormatManager) → off-thread SINC_BEST resample at load (D-WZ-DECKSRC-01, progress surfaced) → wz_deck_load; engine deck unit idle→looping/oneShot (wz_deck_trigger, seqlock loop spec); deckLoadFile + deckTrigger commands; record states are P3 | todo | |
| P1-08 | build | Web console v0: channel rack (fader w/ unity detent at 0.75, pan, mute/solo, HotSurface strip meters ≤2 ms/frame), sources browser v0 (device inputs + file-open), deck cell (load/play/loop), main+monitor meters; Patch store + WorldPublish wiring | todo | consumes P1-metering row |
| P1-09 | build | Routing matrix v0 (channels × main/monitor/outputs, DAG-validated at edit time, loopback cells absent until P4) + output map v0 (bus → device channel pairs; monitor → device 3/4 when present) | todo | |
| P1-AUDIT | spec | Phase audit: diff P1 spec/CONFIRMs vs built rows; materialize gaps | todo | before the gate, always |
| P1-G1 | gate | **Phase gate (human): mix a mic and a file; cue-monitor on device channels 3/4** | todo | |

## Parked decisions

| id | needed before | status | question |
|---|---|---|---|
| D-WZ-DECK-01 | P3 | awaiting-decision | Deck RAM policy: cap per deck, then stop / spill / degrade-to-file? |
| D-WZ-PDC-01 | P6 | awaiting-decision | Parallel-path-only PDC in a live mixer (deviates from parlante full-PDC) |
| D-WZ-SHARED-01 | after P2 | awaiting-decision | Extract @suite/design-tokens + @suite/slp-codegen (rule of three) |
