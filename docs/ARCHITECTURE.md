# Wizard — architecture (frozen reference)

> The stable reference for building the patchbay-recorder. Every session reads this
> instead of re-deriving architecture. Changes to this file are their own reviewed
> ledger increment.
> Work items and status live in `/MIGRATION.md`. User-signed audio decisions:
> `docs/DECISIONS.md`. Product identity, the deck laws and display modes:
> `~/audio-routing-research/wizard/CONCEPT.md`. Capture-layer ground truth:
> `~/audio-routing-research/feasibility.md` (July 2026).

*Laws are stated as laws; numbered decisions live in `docs/DECISIONS.md` and are
referenced here as `D-WZ-*`.*

---

## 1. Tier split

Four tiers, identical in spirit to parlante-next:

| Tier | Contents | May contain |
|---|---|---|
| `engine/` | ⚠️ **RETIRED at H2a (D-SL-ONEHOST-01).** Held wizard's portable core — routing graph, channels, decks, ASRC, recorder drains, loopback, watchdog, metering — as static lib `wz_engine` behind C ABI `wz_engine.h`. The P3 flip made scoopy's core the survivor and by 2026-07-30 nothing but its own tests reached it. The directory now holds ONLY the vendored libsamplerate, which `wz_decode` links. **The live core is `vendor/` + `slengine/` behind SL ABI v3 — see `docs/merge/SL-ABI-V3.md`.** | No device code, no file-format code, no platform headers. RT-safe render path: no locks, no allocation, no IO. |
| `host/` | JUCE 8: duplex device IO, decode/encode, **capture backends** (process taps, PipeWire), crash-safe WAV writers, plugin hosting + out-of-process scanner. | Platform code lives here and only here. |
| `shell/` | JUCE 8 `WebBrowserComponent` app. **Shell law (verbatim from parlante):** a shell may contain ONLY EngineLink transport, window/menu chrome, file dialogs, lifecycle/permissions. Anything else is a bug. Wizard adds exactly two shell items: window min/max constraints for the two display modes, and an always-on-top toggle. | |
| `web/` | React 18 + TS + Vite + Zustand + Zod. Owns the **Patch** document. Committed `webdist/` bundle. | |

**Capture backends belong in `host/`** — process taps are Objective-C++/CoreAudio,
PipeWire is C + a thread loop; both are platform IO, which is what `host/` exists for.
The engine never sees a PID, an `AudioObjectID`, or a `pw_stream` — it sees timestamped
float blocks pushed into source rings.

### Signed deviations from feasibility.md

- **D-WZ-CORE-01 — no miniaudio.** Feasibility §6.2 recommends miniaudio for the
  portable core. Its own reasoning ("the framework only contributes
  mixing/resampling/format conversion — capture is hand-written regardless") cuts the
  other way here: the suite already owns a mixing-graph idiom (custom C++ engines), a
  device-IO layer (JUCE in `host/`, proven by parlante's `AudioOutput` and Scoopy's
  `sl_host.h`), and an SRC dependency (libsamplerate, parlante D-05, already vendored).
  miniaudio would be a fourth audio framework contributing nothing the platform doesn't
  already have.
- **D-WZ-CORE-02 — WAV writer in `host/`, not the engine.** Feasibility §6.1 puts "file
  writing" in the portable core; parlante's no-file-code-in-engine law wins. The writer
  is nevertheless written dependency-free portable C++ inside `host/` so a future
  WASM/companion build could reuse it. The *engine* side of recording is a lock-free
  drain only.

---

## 2. Engine core modules (`engine/src/`)

| Module | Responsibility |
|---|---|
| `graph.cpp` | Channel/bus/deck topology as an RCU-installed world snapshot (Scoopy `sl_snapshot_*` pattern). Render order is a precomputed acyclic schedule; every legal cycle passes through the LoopbackBus (below), so scheduling never sees a cycle. |
| `channel.cpp` | Strip DSP: gain (float64 accumulate, parlante D-DSP-01 adopted verbatim), pan, click-free mute ramps (Scoopy `SL_T_MIX_MUTED` lesson), 4 send taps, insert-slot invocation, per-strip peak/RMS. |
| `source_ring.cpp` | Per-source SPSC lock-free ring, written by host capture threads, read by the render thread. Every write carries `{host_time_ns, source_sample_rate}`. Fill level + overrun/underrun counters surface in HotFrame. |
| `asrc.cpp` | Per-source ASRC: libsamplerate streaming API, ratio steered by a PI controller on (a) timestamp error between source host-time and engine host-time and (b) ring-fill deviation. Device inputs arriving in the same duplex callback as the output are same-clock and **bypass ASRC entirely**. |
| `deck.cpp` | 1–8 deck units. Each owns a record buffer — grown/committed from the control thread, read by the render thread — that **doubles as the playback buffer**: record with live monitor pass-through → stop with loop on → **same-block handoff to looping playback, gapless** (Law C-3). Signed varispeed rate incl. reverse via engine-side streaming SRC; one-shot/retrigger; seqlock-published loop spec (parlante `transport_set_loop` pattern). Loaded files/takes decode (in host) into the same buffer type. Memory policy is D-WZ-DECK-01 (see ROADMAP risks). |
| `recorder.cpp` | Per-deck lock-free drain rings + engine-sample start stamps, feeding the host's file writers **in parallel with** the in-memory buffer. The file is the durable artifact; the buffer is the instant-playback path. Overrun = counted + flagged, never blocks render. Never touches files. |
| `loopback.cpp` | The **LoopbackBus** — the one legal cycle edge. Any patch routing a bus back into a channel (record-own-output, resample) reads the *previous block* of that bus — the classic send~/receive~ one-block-delay solution. Deliberate feedback is well-defined; the schedule stays acyclic by construction. |
| `watchdog.cpp` | Runaway-level safety: sustained bus level over threshold (e.g. > +6 dBFS RMS over 250 ms) engages a hard limiter + raises `feedbackAlarm` in HotFrame. Catches the loop no graph check can see (out → other app → virtual device → back in). |
| `metering.cpp` | Peak/RMS per channel + bus; correlation on main. LUFS is deliberately **not** here — mastering is Parlante's job; a seam is left. |

---

## 3. C ABI — `engine/include/wz_engine.h` ⚠️ HISTORICAL

> **THIS ABI NO LONGER EXISTS.** `engine/include/wz_engine.h` was deleted at H2a
> (D-SL-ONEHOST-01) along with the engine behind it. **The live ABI is SL ABI v3 —
> `slengine/include/sl_engine.h`, specified in `docs/merge/SL-ABI-V3.md`, which is the
> document to read and to change.** This section is kept, unedited below, because the
> CONVENTIONS it states are the ones v3 inherited (keyed-not-positional params resolved
> by name at boot, RT-safety annotated per function, nothrow, no C++ types across the
> boundary) and because several v3 units are transplants whose provenance notes still
> point here — e.g. `slengine/src/sl_tape.cpp:1`. Read it as the donor's record, never as
> a description of code you can call.

Conventions from `parlante-next/engine/include/pl_engine.h`: keyed-not-positional params
(resolved by name once at boot; adding a field is a new key, never a re-layout), RT-safety
annotation per function, nothrow, no C++ types across the boundary.

```c
#define WZ_ABI_VERSION 1
typedef struct wz_engine wz_engine;

wz_engine* wz_engine_create(double sample_rate, uint32_t max_block_frames,
                            int32_t schema_version);

/* keyed channel params — Scoopy ABI-v2 pattern */
int32_t  wz_param_id_for_name(const char* name);       /* "gain","pan","send1",... */
void     wz_param_set(wz_engine*, uint32_t channel, int32_t id, double v); /* RT-safe */

/* world (topology) — snapshot builder, RCU commit; deck count 1–8 is a world property */
void     wz_world_begin(wz_engine*);
uint32_t wz_world_channel_begin(wz_engine*, const char* channel_key);
void     wz_world_channel_set(wz_engine*, int32_t key, double v);  /* unknown key ignored */
void     wz_world_channel_end(wz_engine*);
uint64_t wz_world_commit(wz_engine*);                   /* lock-free publish */

/* source feed — called from HOST capture threads (one writer per source) */
int32_t  wz_source_ring_open(wz_engine*, const char* source_key,
                             uint32_t channels, uint32_t capacity_frames);
void     wz_source_write(wz_engine*, int32_t ring, const float* interleaved,
                         uint32_t frames, double source_rate,
                         uint64_t host_time_ns);         /* RT-safe, lock-free SPSC */
void     wz_source_ring_close(wz_engine*, int32_t ring);

/* decks — combined recorder/player units */
int32_t  wz_deck_load(wz_engine*, uint32_t deck, uint32_t channels,
                      uint64_t frames, const float* const* data, double rate);
void     wz_deck_record_start(wz_engine*, uint32_t deck);
uint64_t wz_deck_record_stop(wz_engine*, uint32_t deck);
         /* returns the take's startEngineSample; if loop is enabled the deck
            switches to looping playback of the captured buffer in the same
            block — the Law C-3 handoff happens inside the engine */
void     wz_deck_trigger(wz_engine*, uint32_t deck, uint32_t mode); /* loop/oneShot/stop/retrigger */
void     wz_deck_set_loop(wz_engine*, uint32_t deck, uint32_t enabled,
                          uint64_t start, uint64_t end);  /* seqlock publish */
void     wz_deck_set_rate(wz_engine*, uint32_t deck, double rate);  /* signed; <0 = reverse */
uint32_t wz_deck_drain(wz_engine*, uint32_t deck, float* out,
                       uint32_t capacity, uint64_t* out_start_sample);
         /* file-drain for host writers, parallel to the in-memory buffer */

/* plugin inserts — host-provided processor invoked ON the render thread */
typedef void (*wz_insert_proc)(void* ctx, uint32_t slot, float* const* ch,
                               uint32_t channels, uint32_t frames);
void     wz_engine_set_insert_proc(wz_engine*, wz_insert_proc, void* ctx);
void     wz_insert_set_latency(wz_engine*, uint32_t slot, uint32_t frames); /* PDC */

/* render — multichannel: host maps up to 8 output buses + monitor to device
   channels and/or the virtual device */
void     wz_engine_render(wz_engine*, float* const* bus_out,
                          uint32_t bus_count, uint32_t frames);
uint32_t wz_engine_hotframe(const wz_engine*, double* out, uint32_t capacity);
```

The insert callback is the one place engine purity bends: JUCE plugin instances (host)
must process *inside* the graph. A C function pointer + latency report keeps JUCE types
out of the engine while keeping plugins in the signal path — same spirit as Scoopy.

---

## 4. Capture interface — `host/include/wz_capture.h`

Host-tier C ABI in the `ScoopyLoops CODEX 9/engine/include/sl_host.h` idiom: status
enums (not bools), caller-owned string buffers, opaque UTF-8 ids, and **polled topology
generation, never callbacks into app code from HAL listeners** — Scoopy's
use-after-free lesson adopted as law.

```c
typedef enum { WZ_SRC_PROCESS, WZ_SRC_SYSTEM_MIX_EXCEPT, WZ_SRC_DEVICE_INPUT,
               WZ_SRC_VIRTUAL_INPUT } wz_cap_kind;
typedef struct { const char* id; const char* name; wz_cap_kind kind;
                 int32_t pid; uint32_t channels; } wz_cap_source_info;

wz_cap_status wz_cap_refresh_sources(wz_cap*);      /* snapshot; then count/info */
uint64_t      wz_cap_topology_generation(wz_cap*);  /* POLLED */

typedef void (*wz_cap_deliver)(void* ctx, const float* interleaved,
                               uint32_t frames, uint32_t channels,
                               double sample_rate, uint64_t host_time_ns);
typedef void (*wz_cap_notify)(void* ctx, wz_cap_event evt);  /* formatChanged,
                               sourceGone, permissionDenied — CONTROL thread */
wz_cap_status wz_cap_open(wz_cap*, const char* source_id,
                          wz_cap_deliver, wz_cap_notify, void* ctx,
                          wz_cap_handle** out);
wz_cap_status wz_cap_close(wz_cap_handle*);

/* optional per platform — core degrades gracefully on UNSUPPORTED */
wz_cap_status wz_cap_virtual_device_status(wz_cap*, wz_vdev_status* out);
wz_cap_status wz_cap_virtual_device_ensure(wz_cap*, const char* name,
                                           uint32_t channels);
```

**Flagged deviation from feasibility §6.1:** the research doc specifies a *pull*
`read() → (frames, host_timestamp, sample_time)`. Both real backends (CoreAudio IOProc,
`pw_stream` process callback) are *push*; a pull API would force an extra ring inside
every backend just to invert control, and the engine already owns per-source rings. So
the interface is **push-with-timestamps**: `wz_cap_deliver` carries `host_time_ns` and
the actual `sample_rate` on **every** delivery — preserving the document's critical
discipline ("timestamps, not just frames"), which is the part that cannot be retrofitted.
Host glue is one line: deliver → `wz_source_write`. Format changes arrive as a
`formatChanged` notify followed by deliveries carrying the new rate/channel count; the
ASRC re-primes without stopping any recording (feasibility §7 renegotiation requirement).

### 4.1 macOS backend — `host/src/capture/mac/`

- `TapSource.mm` — feasibility §3.2's sequence verbatim:
  `kAudioHardwarePropertyTranslatePIDToProcessObject` → `CATapDescription` (both
  polarities: process-list, and system-mix-except; the *except* list **always includes
  Wizard's own PID** by default — the first feedback guard) →
  `AudioHardwareCreateProcessTap` → private aggregate device wrapping the tap →
  `AudioDeviceCreateIOProcIDWithBlock` (the block is the `wz_cap_deliver` call,
  `host_time_ns` from the `AudioTimeStamp`) → `AudioDeviceStart`. Property listener on
  `kAudioTapPropertyFormat` → `formatChanged`. Teardown mirrors, always off the audio
  thread.
- `ProcessWatch.mm` — process lifecycle ("record Spotify whenever it starts"): pending
  source bindings re-resolve on `kAudioHardwarePropertyProcessObjectList` changes; a
  vanished process tears its tap down and marks the channel's source `unresolved` —
  the strip stays, silent, reference intact.
- Hardware inputs come through the **same duplex JUCE device** as the output — same
  clock, no ASRC.
- **Virtual device input:** the driver (see REPO-BLUEPRINT §driver) is a standalone
  loopback device living in `coreaudiod`, so Wizard reads its input side as *a normal
  CoreAudio input device* — no custom shared memory or IPC between app and driver.
  `WZ_SRC_VIRTUAL_INPUT` is enumerated by device UID prefix; it has its own clock →
  normal ASRC path, exactly like a tap.
- OS floor: **macOS 14.4** (feasibility §3 recommendation, adopted).

### 4.2 Linux backend — `host/src/capture/linux/PipeWireBackend.cpp`

One `pw_thread_loop`. Registry listener enumerates `Stream/Output/Audio` nodes
(id = `object.serial`, name from `application.name`/`node.name`) → `WZ_SRC_PROCESS`.
Capture = `pw_stream` with `PW_KEY_TARGET_OBJECT` (+ `PW_KEY_STREAM_CAPTURE_SINK` where
appropriate); the process callback is `wz_cap_deliver` with `pw_time`-derived
timestamps. Virtual device = a null sink (`support.null-audio-sink`, media.class
`Audio/Sink`, named "Wizard Out") loaded via `pw_context_load_module`; its monitor
ports are `WZ_SRC_VIRTUAL_INPUT`. System-mix-except may ship reduced on Linux v1
(labeled limitation — PipeWire's model makes the per-app path primary anyway). No
signing, no permissions — which is why Linux is the abstraction-validation platform
(feasibility §8 build order, adopted).

---

## 5. Plugin hosting

Scoopy's pattern wholesale, in `host/src/plugins/`:

- `NativePluginHost.cpp` — JUCE `AudioPluginInstance` hosting: VST3 + AU on macOS,
  VST3 + LV2 on Linux. Editor windows owned by the shell tier; state as opaque base64
  blobs in the Patch.
- `plugin_scanner` — separate executable; **out-of-process scanning** so a crashing
  plugin kills the scanner, not the app (Scoopy's shipped pattern). Results cached as
  JSON.
- **Portable plugin references** per Scoopy's cross-platform law: manufacturer + name +
  version; per-format identifier string as a hint only; resolution falls back exact-id →
  same-plugin-other-format → **unresolved = inert + preserved**.

**Placement in the graph:** (a) **4 per-channel insert slots** — capture channels
benefit as much as decks (gate/EQ on a Zoom tap); (b) **4 send buses → FX-return
channels** whose insert chain *is* the effect (Scoopy's aux DNA; returns are ordinary
Channels, so they get meters, routing, and record-arm for free — a wet-only return can
be recorded). Sends are post-fader by default; pre/post per send is a schema field from
day one, defaulted post.

**PDC — D-WZ-PDC-01 (needs sign-off before P6):** in a *live capture* mixer, full-graph
PDC is wrong — it delays monitoring. Proposal: compensate **parallel paths only**
(dry-vs-send alignment), expose per-channel reported latency in the UI, and subtract
insert latency from record-path timestamps so takes line up. This deviates from
Parlante's full-PDC (M-5) because Parlante is offline-editing; Wizard is live.

---

## 6. HotFrame (30 Hz `Float64Array`, codegen'd index map)

- **Scalars:** `schemaVersion, engineTimeSamples, cpuLoad, feedbackAlarm,
  mainPeakL/R, monitorPeakL/R`.
- **Per-deck blocks** (stride codegen'd behind a named base offset): `state, playhead,
  loopStart, loopEnd, rate, recordLengthSamples, recordDrainFill`.
- **Per-channel blocks:** `peakL, peakR, rmsL, rmsR, srcRingFill, srcDriftPpm,
  srcDropouts`.

`srcDriftPpm` on every strip is deliberate: clock drift is this app's number-one
failure mode (feasibility §7) and must be *visible live*, not discovered in a desynced
file an hour later.

---

## 7. Web UI

### 7.1 Console mode

```
┌──────────────────────────────────────────────────────────────┐
│ Transport/record bar: per-deck ● rec indicators · engine     │
│ clock · take counter · mode switch (console/strip)           │
├────────────┬─────────────────────────────────┬───────────────┤
│ SOURCES    │ CHANNEL RACK (horizontal strips)│ MONITOR       │
│ apps (pid) │ ┌strip┐┌strip┐┌strip┐┌FX ret┐  │ cue source    │
│ devices    │ │meter││ ... ││ ... ││ ... │   │ level · dim   │
│ files      │ │fader│ two-tier block anatomy  │ main meters   │
│ virt. dev  │ │sends│ (Scoopy MIXER-CONCEPT)  │ feedback lamp │
│ (drag →)   │ └arm──┘                         │               │
├────────────┴─────────────────────────────────┴───────────────┤
│ DECK RACK (1–8, add/remove): per deck — arm · ● rec · loop · │
│ one-shot · retrig · waveform + loop brace · signed varispeed │
│ slider w/ reverse zone · "align to deck N" · "load take"     │
│ TAKES list (click → any deck)                                │
├──────────────────────────────────────────────────────────────┤
│ ROUTING MATRIX (collapsible): channels × buses/outputs,      │
│ loopback edges marked ↺, cycle-without-loopback = refused    │
│ OUTPUT MAP: buses → device channels (stereo/quad/5.1/octo)   │
└──────────────────────────────────────────────────────────────┘
```

- **Channel strip** = Scoopy's two-tier block anatomy: top = level (inside-label bar) +
  meter + M/S; bottom = source picker + OUT picker; sends as micro-bars; arm + monitor
  toggles. Fixed widths, no resize on state change (Scoopy's learned constraint).
- **Source picker doubles as the TCC UX surface** on macOS: an app strip whose tap is
  permission-blocked shows the "grant system-audio access" state inline.
- **Routing matrix** is the TS document editor; DAG-ness validated at edit time; loopback
  offered only via explicit ↺ cells (which create LoopbackBus edges).
- All meters/waveforms/playheads render via the **HotSurfaceRegistry** pattern — one rAF
  canvas loop outside React, HotFrame-driven, parlante's ≤2 ms/frame budget gate adopted.

### 7.2 Strip mode

A short, wide horizontal window (~one strip tall) docking along a screen edge, running
beside a full-screen sibling or DAW. Decks → compact cells (rec/loop/one-shot + mini
waveform + varispeed thumb); channels → mini-faders + meters; monitor → lamp + cue
toggle; matrix and sources open as transient overlays. The mode is a schema field; the
shell only supplies window constraints + optional always-on-top. Designed
**compact-first** in P4 so the collapse is a layout change, not a redesign. The compact
strip anatomy is a Wizard-local token group — never a fork of the shared identity.

### 7.3 Vendored pieces & protocol

- `web/src/design/` from the shared identity (tokens byte-identical `DEFAULT_TOKENS`,
  `base.css`, `check:tokens` gate, PD-05-style portability fixture — Wizard is the
  third wearer; app-local groups only for channel-kind accents and the record/feedback
  lamps).
- Parlante's waveform renderer (peak-over-RMS pyramid) for decks and take previews.
- Parlante's `EngineLink` / HotFrame plumbing (`web/src/engine/`, `web/src/hotsurface/`).
- Own `web/protocol/schema.ts`, own `SCHEMA_VERSION`, same four message classes:
  **Command** (JSON-RPC), **ParamWrite** (coalesced, keyed by name + channel index),
  **WorldPublish** (the Patch), **HotFrame**. Zod strict schemas +
  preserve-don't-drop law verbatim.

---

## 8. Shared-platform strategy

Copy-with-contract (parlante D-09 discipline), each copy with a named drift guard:

| Piece | Copied from | Drift guard |
|---|---|---|
| Design tokens + `check:tokens` | ScoopyLoops via parlante's PD contract | PD-05-style portability fixture |
| SLP codegen (`generate-protocol.ts` → `WZProtocol.h`) | `parlante-next/web/scripts/` | `protocol:check` |
| EngineLink / HotFrame / HotSurfaceRegistry | `parlante-next/web/src/engine/`, `hotsurface/` | shared-shape unit test |
| ABI coverage gate | `parlante-next/web/scripts/checkAbiCoverage.ts` + waiver file | CI |
| Session container (STORED zip: `session.json` + `Takes/` + `Samples/`) | ScoopyLoops package pattern | golden-corpus round-trip gate |

**D-WZ-SHARED-01 (rule of three):** tokens and the SLP codegen toolchain are now
vendored three times. After Wizard P0 proves the copies work, extract
`@suite/design-tokens` and `@suite/slp-codegen` as private npm packages; apps pin
versions; the fixtures remain the compatibility gates.

`wz_capture.h` is deliberately **not** shared yet — no sibling needs it — but its C ABI
is written so it can become the suite's device/capture library later (the "shared device
layer" combined power, industrialized).

---

## 9. Correctness gates (all in CI from P0)

| Gate | What it proves |
|---|---|
| `npm run protocol:check` | schema ↔ codegen (`shell/generated/WZProtocol.h`) drift |
| `npm run abi:check` | every engine field carried end-to-end or explicitly waived in `engine/tools/abi-not-carried.json`. **No third state.** |
| `npm run check:tokens` + portability fixture | no hardcoded colors/fonts in `web/`; the shared identity stays byte-identical across the three apps |
| `npm run webdist:check` | committed bundle freshness (`webdist/.buildhash`) |
| `asrc_drift_test` | 48 000 vs 48 000.3 Hz synthetic clocks, simulated hour, alignment error < 1 ms |
| `deck_handoff_test` | record-stop → looping playback is gapless and sample-exact (Law C-3) |
| `wav_killtest` | SIGKILL mid-record → WAV recoverable, length correct ± one flush quantum |
| `watchdog_test` | feedback ramp engages the limiter + raises `feedbackAlarm` within budget |
| UI perf budget | hotSurface frame ≤ 2 ms at 30 Hz |
| Cross-platform determinism | `-ffp-contract=off`; the same patch renders bit-identically on macOS and Linux |
| Session golden corpus | STORED-zip byte-stable re-encode; preserve-don't-drop both directions; kill-restore soak |

Gates run against **committed** artifacts in CI (no regeneration first), so a stale
generated header, ABI drift or a stale bundle fails the build. Every gate is
tamper-tested when it lands: it must be observed failing on drift, not merely passing.

## 10. Decision cadence (user-mandated — never install features blindly)

Any increment touching an **audio-quality-relevant low-level choice** STOPS and brings
the decision to the user with a concise recommendation + trade-offs. Standing decision
classes for Wizard:

engine rate & clock model (D-WZ-RATE-01, D-WZ-CLOCK-01) · ASRC design (control loop,
filter quality, ratio-walk behavior) · internal precision and summing · buffer/quantum
and per-source ring depth · PDC strategy in a live mixer (D-WZ-PDC-01) · deck memory
policy (D-WZ-DECK-01) · declick/crossfade parameters at deck seams · varispeed resampler
tier · feedback-watchdog thresholds · recorder file format and flush policy · virtual
device channel layout.

Signed decisions land in `docs/DECISIONS.md` and become buildable without re-asking.
Mechanical/structural increments proceed without stopping. Pending decisions are parked
as `awaiting-decision` ledger rows; **the loop continues on unblocked items.**

## 11. Loop protocol (every session)

*Rewritten 2026-07-31 for the merge. The previous version — orient on
`/MIGRATION.md`, one item per commit, ≤500 LOC, one new row per ⚠️ — was
wizard's, and by 2026-07-30 it had produced 97 open rows of which 23 were
sub-lettered chores. Feature work now moves in **bundles**.*

1. **Orient:** read `docs/merge/P3-LEDGER.md` — the **BUNDLES** section first
   (B1–B8: each names a donor binding, the rows it consumes, and its door), then
   the phase blocks for rows no bundle has claimed. `docs/DECISIONS.md` is the
   law; `docs/merge/PARALLEL-PROTOCOL.md` §0 is the standing ruling on what a
   unit of work is, and its §10 "Awaiting the user" is the live decision backlog.
   Priority: broken-build fix > the bundle in flight > the next bundle >
   unclaimed rows.
2. **Execute one bundle** — a coherent donor-binding-sized unit: the shell/engine
   seam, the web UI, the door, the tests. **There is no LOC cap.** A bundle spans
   several commits; each commit is coherent and green on its own, and the bundle
   is not done until its door is reachable in the real host.
3. **Verify:** `ctest --test-dir build --output-on-failure`, then in `web/`:
   `npm run typecheck && npm test` plus **all TEN drift gates** (`params:check` ·
   `shared:check` · `worldmap:check` · `hotframe:check` · `tape:check` ·
   `trackparams:check` · `webdist:check` · `check:tokens` · `schema:check` ·
   `nativemethods:check` — `web/package.json` is the authority; there is no
   `protocol:check`), then the walks and the real-host proof the row's gate line
   names. `npm run bundle` **LAST** before `git add`. Red → fix or revert fully.
4. **Continue or park:** more machine-runnable work → next bundle step. Only
   human-gated items left → post "awaiting sign-off/decision on: …" and stop.

The loop never leaves the tree unbuildable, never writes to `../scoopyloops`,
and changes schemas only via `web/protocol/schema.ts` + regeneration.

### Completeness rules — no skipped or half-built features

- **Follow-ups fold in, they do not multiply.** A ⚠️ a bundle uncovers is either
  fixed inside that bundle or added to the **one** standing `HYGIENE` row. It
  gets its own ledger row only if it is feature-sized. (The old rule — every
  mention gets its own row, in the same commit — is what generated the
  forty-odd-row cycles; it is retired.)
- **Done means whole, and reachable.** A bundle is `done` only when its
  behaviours are covered AND a visible door reaches them in the JUCE WKWebView
  host. Tests pass ≠ it works ≠ it shipped ≠ you can reach it.
- **Deviations from the donor are signed, not silent.** Where the merged app
  departs from `../scoopyloops`, the departure goes in `docs/DECISIONS.md` with
  its reason. A divergence nobody asked for is a regression wearing a redesign's
  clothes.
- **Audit before a human gate.** A phase closes with a `P<X>-AUDIT` row: diff the
  specs against what was built and materialise the gaps. The audit — not memory —
  decides the phase is complete.

## 12. Phases

P0 walking skeleton + risk spike → P1 mixer slice (same-clock only) → P2 capture + ASRC
→ P3 deck recorder → P4 playback composer (+ strip mode) → P5 virtual device →
P6 plugins → P7 sessions → P8 release engineering.
Plus **PD — design identity** (interleaves after P1). Row detail: `/MIGRATION.md`;
phase intent and risks: `~/audio-routing-research/wizard/ROADMAP.md`.
