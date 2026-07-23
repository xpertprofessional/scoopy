# Wizard — Signed Audio Decisions

> Log of user-signed low-level decisions. Once signed here, an item is buildable without
> re-asking. Format: id · date · decision · rationale · consequences.
> Sibling precedents referenced as `parlante D-*` (`~/parlante-next/docs/DECISIONS.md`).

## D-WZ-NAME-01 · 2026-07-23 · Product name & identifiers

**Decision:** The app ships as **Wizard**. ABI prefix `wz_`, protocol **WZP**, C++
namespaces `wizard::host` / `wz::protocol`, virtual device **"Wizard Out"**, repo
`~/wizard`. No later rename pass is planned.

**Rationale:** The design docs weighed Presa / Banco / ScoopyTaps and kept Wizard as the
working name; the user confirmed it. Every design identifier already uses `wz_`, so
committing to it removes a find/replace step and the risk of a half-applied rename.

**Consequences:** All generated artifacts key off these strings — `WZ_ABI_VERSION`,
`shell/generated/WZProtocol.h`, native functions `wzCommand` / events `wzParam` /
`wzHotFrame`. A future rebrand is a deliberate, gated, all-artifacts increment, not a
casual edit.

## D-WZ-RATE-01 · 2026-07-23 · Engine graph runs at the output device rate

**Decision:** The engine graph runs at **whatever sample rate the output duplex device is
opened at**. Hardware inputs arrive in the *same* duplex callback as the output → they
are same-clock and carry **zero sample-rate conversion** on the live path; the
main/monitor output is bit-exact to the device. Every asynchronous source — process taps,
the "Wizard Out" virtual-device input, decoded deck files — is ASRC'd (streaming SRC for
files) *into* the engine rate. **Takes are written at the engine rate.** A device
sample-rate change tears down and rebuilds the engine at the new rate with a loud,
user-visible notice (no silent re-clock).

**Rationale:** Wizard's analogue of parlante D-SR-01, adapted: parlante has one source so
it opens the device at the *file's* rate; Wizard mixes many independently-clocked sources,
so there is no single "source rate." Following the output device keeps the one path that
must stay pristine — what you monitor and what you record of hardware inputs — free of any
resampler, and confines ASRC to sources that are asynchronous by nature anyway. Consistent
with ARCHITECTURE §2 ("device inputs … bypass ASRC entirely").

**Consequences:** `host/AudioIO` opens one duplex device and reports its actual rate +
quantum to `wz_engine_create` / `wz_engine_set_sample_rate`. The engine's block size is
the device quantum (see D-WZ-CLOCK-01). ASRC lands in P2, not P0/P1 (P1 is same-clock
only). The recorder stamps takes in engine samples; realignment across takes (Law C-2) is
a pure sample delta because all takes share the engine clock. Multi-device / separate
monitor clock is explicitly out of scope for v1 (a later multi-clock question).

## D-WZ-CLOCK-01 · 2026-07-23 · Block size & per-source ring depth (the latency floor)

**Decision:** The engine block size equals the **output device quantum**. Each per-source
lock-free ring targets a fill of **1.5× the quantum**, and is **adaptive**: a ring that
sustains underruns grows its target (1.5× → up to 3×) and logs the event. `srcRingFill`,
`srcDropouts` and `srcDriftPpm` are **per-strip HotFrame fields**, so starvation and clock
drift are visible live on every channel, never discovered in a desynced file an hour later.

**Rationale:** feasibility §7 names buffer/latency alignment as a choice that "constrains
your lowest achievable latency permanently," and clock drift as the number-one failure
mode. 1.5× quantum is the smallest slack that absorbs a well-behaved tap's cadence jitter
while keeping mic monitoring tight (~16 ms added at 512/48k); adaptivity means a hostile
source degrades gracefully (grows its own ring, flags itself) instead of dropping out or
forcing everyone to the conservative depth. Per-strip drift telemetry makes the failure
mode diagnosable in real time.

**Consequences:** Minimum added latency per asynchronous source ≈ 1.5× quantum; hardware
inputs on the duplex clock add none. The ASRC PI controller (P2) owns ring growth and
publishes fill/drift/dropout counters into HotFrame. The UI surfaces them on the strip
(`srcDriftPpm` deliberately on every channel). `metering.cpp` / `source_ring.cpp` carry
these counters from P2; the HotFrame per-channel block reserves the fields from P0.

## D-WZ-DSP-01 · 2026-07-23 · Internal processing precision (adopts parlante D-DSP-01)

**Decision:** Audio buffers and plugin I/O are **float32** (VST3/AU/LV2 consume float32
regardless); **gain, summing (channel → bus → main), pan laws, and metering (peak/RMS)
accumulate in float64 (`double`)**. Each bus sum is computed in double, then delivered as
float32 to the device.

**Rationale:** Identical to parlante's reasoning — mastering-grade protection against
cumulative rounding through the summing stages without paying 2× memory/bandwidth on every
buffer, which would gain little since plugins downconvert at their boundary anyway. Wizard
sums *more* paths than parlante (many channels × several buses + sends + loopback), so the
double-precision bus accumulator matters more, not less.

**Consequences:** Engine buffer type = `float`; mix accumulators, gain stages, send taps,
loopback mix and metering use `double`. The C ABI render path stays float32. Determinism
tests target a rounding floor consistent with double-precision summing.

## D-WZ-CORE-01 · 2026-07-23 · No miniaudio in the portable core

**Decision:** The portable engine core uses **no audio framework** — not miniaudio (which
feasibility §6.2 recommends). Mixing/summing/metering are hand-written C++; sample-rate
conversion uses **libsamplerate** (already a suite dependency, parlante D-05); device IO
and file IO live in `host/` (JUCE).

**Rationale:** feasibility's own case for miniaudio is that it "only contributes
mixing/resampling/format conversion — capture is hand-written regardless." The suite
already owns each of those: a custom-C++ mixing idiom (ScoopyLoops / Parlante engines),
libsamplerate for SRC, and JUCE for device IO. miniaudio would be a fourth audio framework
contributing nothing the platform doesn't already provide, and another dependency to keep
deterministic across macOS + Linux.

**Consequences:** `engine/` links only libsamplerate (vendored). No new third-party audio
runtime enters the build. The engine stays free of device and file-format code by
construction.

## D-WZ-CORE-02 · 2026-07-23 · WAV writer lives in host/, not the engine

**Decision:** The crash-safe BWF/RF64 recorder file writer lives in **`host/`**
(feasibility §6.1 puts "file writing" in the portable core; parlante's
no-file-code-in-engine law wins). It is written **dependency-free portable C++** so a
future WASM/companion build could reuse it. The *engine* side of recording is a
**lock-free drain only** (`recorder.cpp`): per-deck rings + engine-sample start stamps,
never touching files.

**Rationale:** Keeps the engine's RT render path pure (no IO, no allocation, no locks) and
keeps every platform/file concern in the tier that exists for it. Writing the WAV encoder
dependency-free (rather than via JUCE's `AudioFormatWriter`) preserves the option to
compile it into a browser companion later, at no cost now.

**Consequences:** `host/src/WavWriter.cpp` (portable) + `host/src/RecordService.cpp`
(per-deck drain threads → writers + sidecars) consume `wz_deck_drain`. The kill-test
(`wav_killtest`) proves a SIGKILL mid-record leaves a recoverable file. Lands in P3.

## D-WZ-DESIGN-01 · 2026-07-23 · Vendor the design token core only at P0

**Decision:** At P0, Wizard vendors the **token core only** from the shared identity:
`web/src/design/tokens.ts` + `base.css` + the `check:tokens` gate + a PD-05-style
portability fixture. ScoopyLoops' interaction primitives (DragBox, controls.tsx,
ContextMenu, focus model, typefaces, looks — ~6 k LOC) are **not** copied. Wizard's
channel-strip / deck anatomy is built app-local; the full shared identity is applied at
the **PD** phase (after P1), when Wizard joins the "same identity, three wearers" contract
as the third wearer.

**Rationale:** The no-hardcoded-colors law is worth enforcing from commit 1 (it is the
cost parlante is now paying for deferring it), but Scoopy's control primitives carry
Scoopy-specific concepts (decks A/B/C, mod channels M1–M4) that Wizard would have to prune,
and a mixer's controls differ enough that copying them wholesale would import more debt
than reuse. Token core is the high-value, low-coupling slice.

**Consequences:** `web/` gets `design/tokens.ts` + `base.css` with `DEFAULT_TOKENS`
byte-identical to the sibling apps, a `check:tokens` gate in CI, and app-local token
groups for channel-kind accents and the record/feedback lamps only. `D-WZ-SHARED-01`
(rule of three → extract `@suite/design-tokens`) is decided after P2, once this third copy
has proven itself.

## D-WZ-PAN-01 · 2026-07-23 · Pan law: −3 dB constant-power

**Decision:** Every channel strip pans with the **−3 dB constant-power (sine/cosine)
law**: `gainL = cos(θ)`, `gainR = sin(θ)`, `θ = (pan+1)·π/4`. Center = −3 dB per side.

**Rationale:** Perceived loudness stays constant while a source moves — the correct
behavior for a live performance mixer, and the de-facto industry default (analog
consoles, Logic, Live). Mono-sum of a centered source lands at unity, so no center
build-up feeds the watchdog.

**Consequences:** Bakes into `channel.cpp` summing math (float64 per D-WZ-DSP-01) and
into every null-test fixture from P1 onward. The pan smoother rides the D-WZ-RAMP-01
constant.

## D-WZ-FADER-01 · 2026-07-23 · Fader taper & range: −∞..+6 dB, parlante mapping

**Decision:** Channel and main faders run **−∞ to +6 dB** with parlante's audio-taper
mapping (unity at 0.75 of the throw; bottom of throw = true −∞ mute). One curve family
across the suite.

**Rationale:** Suite coherence — one muscle memory across Parlante and Wizard. +6 dB is
enough boost for a quiet tap without handing a feedback-capable graph more rope than the
watchdog's +6 dBFS RMS trip point.

**Consequences:** The fader→dB curve is a shared web-side utility + an engine-side gain
application; the two are pinned against each other by a fixture. UI fader rendering gets
a unity detent at 0.75.

## D-WZ-RAMP-01 · 2026-07-23 · Click-free ramp: 10 ms raised-cosine

**Decision:** One engine-wide smoothing constant: **10 ms**. Mute/unmute is a
raised-cosine gain ramp over 10 ms; fader and pan changes settle through a one-pole
smoother with ~10 ms time constant. No parameter reaches the summing math as a step.

**Rationale:** Scoopy's `SL_T_MIX_MUTED` lesson (hard switches click) + parlante's
raised-cosine declick family. 10 ms is inaudible as a fade yet guaranteed click-free on
bass-heavy material; 5 ms can thump, 20 ms feels soft when the mute button is a
performance gesture.

**Consequences:** 480 samples at 48 k. `channel.cpp` owns the smoothers; fixtures assert
no sample-to-sample gain step exceeds the ramp's slope bound. Applies to every future
switched path (solo, monitor assign, insert bypass).

## D-WZ-DECKSRC-01 · 2026-07-23 · Deck file loading: resample at load, SINC_BEST

**Decision:** Files whose rate differs from the engine rate are resampled **once, at
load time, off the audio thread**, with libsamplerate **SINC_BEST_QUALITY**, into the
deck buffer at the engine rate. Playback is a straight buffer read — zero per-block SRC
on the render path.

**Rationale:** D-WZ-RATE-01's clean-path principle extended to decks: the live path
carries no resampler. Parlante D-05 precedent — best quality for anything baked. Keeps
Law C-3's symmetry intact: buffer rate == engine rate == take rate, so record→loop
handoff and take realignment stay sample-exact with no rate bookkeeping.

**Consequences:** Load of a long mismatched-rate file costs seconds (off-thread,
progress surfaced); RAM holds the converted copy (input to the D-WZ-DECK-01 memory
decision before P3). Live varispeed (P4) remains a separate engine-side streaming SRC
regardless of source rate.

---

## Parked — awaiting decision (do not block earlier phases)

| id | needed before | question |
|---|---|---|
| **D-WZ-DECK-01** | P3 | Deck memory policy: 8 decks × long takes live in RAM for instant playback. Cap per deck, then — stop, spill, or degrade-to-file? |
| **D-WZ-PDC-01** | P6 | PDC in a live mixer: full-graph PDC delays monitoring. Proposal: compensate parallel paths only, expose per-channel latency, subtract insert latency from record-path stamps. Deviates from parlante's full-PDC (offline vs live). |
| **D-WZ-SHARED-01** | after P2 | Rule of three: extract `@suite/design-tokens` + `@suite/slp-codegen` as private packages once the third vendored copy proves out. |
