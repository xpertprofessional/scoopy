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

## D-WZ-ASRC-01 · 2026-07-23 · Live-tap ASRC converter tier: SINC_BEST always

**Decision:** Every source that needs asynchronous sample-rate conversion — process
taps, the virtual-device input, any independently-clocked source — runs its live
streaming ASRC at **libsamplerate `SRC_SINC_BEST_QUALITY`** (~145 dB SNR), uniformly. No
per-ratio tier switching; the near-unity drift-correction case and the genuine
rate-conversion case (e.g. 44.1→48 kHz) both use best quality.

**Rationale:** The user prioritized uniform mastering-grade audio over
maximum-concurrent-taps. One converter tier is simpler (no re-pick on `formatChanged`, no
branch that could pick wrong), removes a class of "why does this tap sound different" bugs,
and keeps every captured signal at the same fidelity as the hardware-input path. The CPU
cost is bounded by the tap cap (D-WZ-TAPCAP-01), and libsamplerate SINC_BEST at
near-unity ratios is cheaper than at large ratios (little actual filtering), so the drift
case is not as expensive as the worst case.

**Consequences:** `asrc.cpp` instantiates one `SRC_STATE` per source at
`SRC_SINC_BEST_QUALITY` via the streaming `src_process` API; the PI controller
(ARCHITECTURE §2: timestamp error + ring-fill deviation) steers `src_ratio` each block.
Device inputs on the duplex clock still **bypass ASRC entirely** (D-WZ-RATE-01). The
per-tap CPU cost sets the tap cap. Revisit only if the cap proves too low on target
hardware (then a MEDIUM tier for near-unity drift becomes the escape hatch — logged, not
built).

## D-WZ-TAPCAP-01 · 2026-07-23 · Concurrent-tap cap: 16, soft

**Decision:** At most **16 concurrent taps** (feasibility §7 risk-register figure). The cap
is **soft**: the UI warns as the count approaches it and refuses to arm the 17th with a
clear reason; it never tears down an existing tap. Hardware inputs and decks do not count
against it (only capture sources that spawn an aggregate device + IO thread + ring do).

**Rationale:** feasibility §7 flags aggregate-device thread proliferation as a real cost —
"N taps = N capture threads + N rings." 16 covers realistic use ("tap every app I have
open") while bounding thread/CPU/memory. Soft-refuse (not degrade-everyone) keeps the
running mix stable; the number pairs with the SINC_BEST tier (D-WZ-ASRC-01) as a
documented envelope.

**Consequences:** `wz_capture.h` / the host capture manager tracks the active tap count and
returns a `WZ_CAP_AT_CAPACITY` status past 16; the source picker surfaces the count
(e.g. "13/16") and the refusal. The CPU/memory envelope at 16 × SINC_BEST is measured and
documented in `docs/specs/capture.md`. The constant is a named `kMaxConcurrentTaps` so
raising it later is one edit + a re-measure.

## D-WZ-DECK-01 · 2026-07-24 · Deck memory policy: cap + stop, ~256 MB/deck

**Decision:** Each deck's in-RAM record buffer (which doubles as the playback buffer —
Law C-3) is capped at **256 MB** (≈ 11 min 39 s of STEREO float32 at 48 kHz — ≈23 min is the MONO figure; corrected 2026-07-24). On reaching
the cap, **recording stops on that deck** and a UI indicator shows it; the deck keeps
looping and varispeed-bending what it captured. The crash-safe BWF/RF64 file
(D-WZ-CORE-02) is written in parallel **regardless** and holds the full take up to the
cap — it is the durable artifact.

**Rationale:** Wizard's decks are a live looper — takes are phrases, not full sessions
(long-form session capture is the file's job). A generous fixed per-deck cap keeps total
RAM bounded (~2 GB worst case, 8 decks) and predictable, and **never glitches under memory
pressure** — the failure mode a sliding-window or grow-until-watermark policy risks on the
audio thread. Simplest correct foundation; the cap is a signed constant, raisable later
without a design change.

**Consequences:** `deck.cpp`'s record buffer grows in committed chunks from the control
thread up to the cap; a `recordCapReached` flag surfaces in HotFrame (per-deck block) so
the UI can light the indicator. The parallel drain (`recorder.cpp` → host WavWriter) is
unaffected by the cap — the file keeps whatever was recorded. Degrade-to-window
(unbounded file + RAM window) is explicitly **not** built; if long-form live-loopable
capture is ever wanted it is a new, separately-signed policy. The record buffer's growth
is off the RT path (control-thread commit, seqlock-published length — the render thread
only ever reads a committed length).

---

## D-WZ-PDCANVAS-01 · 2026-07-24 · UI vision: one unified Cell on a boundless plane

**Decision:** Adopt the unified-item UI. The three visual species (sources rail, channel
rack, deck rack) collapse into **one object type — a "Cell" — freely placed on a boundless,
pannable/zoomable plane**. Every current strip (device input, app tap, deck, bus tap,
loopback) is the same Cell in a different state; "recording" is just the verb that gives a
Cell material. Sequence the build as **PD-CANVAS-01..05** (schema → Plane+Cell →
selection-driven Inspector → drag-to-create → retire the old panels). The two deeper GRM
ideas — N readers per sound (granular) and A/B/C/D snapshot morphing — are **out of the
first cut** (PD-CANVAS-2 / -3).

**Rationale:** CONCEPT's founding law is *everything is a channel*; the fixed console
violated it by splitting inputs from decks. The schema already models one strip type
(`Channel.source.kind` covers every species; `decks[]` is material storage, not a second
model), so this is a **rendering** change, not a data-model change — no array merge. GRM
Player proves the boundless-plane interaction model works in a shipping instrument. The
"everything inline is cluttered" objection is answered by an always-visible,
selection-driven **Inspector** (the Cell carries what you touch while playing; the
Inspector holds what you set precisely) — not a hidden mode.

**Consequences:** Engine cost **zero** — geometry never crosses the ABI. Schema is additive:
`cell{x,y,w,h}` on Channel + `plane{scale,panX,panY}` on Patch + one SCHEMA_VERSION bump
with a NAMED auto-layout migration (old Patches lay out into rows). `uiMode`'s "strip"
becomes a zoom-out view, not a separate layout. ~600 lines of panels are rewritten to
`Plane`+`Cell`+`Inspector`+drawers (+~150 for the Inspector; the routing matrix's per-strip
bus choice moves into it); all logic (usePatch, takeAlign, MeterCanvas, faderCurve,
VarispeedSlider, DeckWaveform) is reused as-is. Full plan: `docs/specs/pd-canvas.md`.
Unblocks P4-08 (re-scoped to zoom-out). Supersedes the parked D-WZ-PDC-01? No — that is PDC
latency, unrelated.

## D-WZ-TAKE-01 · 2026-07-24 · Take file naming & storage: timestamped, in the package

**Decision:** A recorded take is written as **`Takes/deck<N>_YYYY-MM-DD_HH-MM-SS.wav`**
inside the session's Takes area (the `.wizard` package's `Takes/` folder, D-WZ-CORE-02 /
P7). Self-describing, human-readable, sorts by time. No content-hash names; no name prompt
at stop.

**Rationale:** Wizard is a looper — interrupting a take-stop to ask for a filename kills the
flow. Timestamped names are self-describing and chronologically sortable, which matches how
a performer thinks about takes. Content-hash names dedupe but are unreadable, and the
package already handles collisions on load.

**Consequences:** `RecordService`/host WavWriter name the file at `beginTake` from the deck
index + wall-clock; the sidecar `.json` (Law C-2 stamp) sits beside it. Unblocks P3-05/07
naming. The package (P7-04) already carries and de-duplicates these by basename.

## D-WZ-MON-01 · 2026-07-24 · Monitor-while-recording default ON; no auto-mute of the source

*Amended by D-WZ-MON-02 (2026-07-24, evening): the no-auto-change rule now has one signed
exception — the record→loop handoff auto-closes the deck's own monitor switch (overdub
excepted). Everything else here stands.*

**Decision:** When a deck is armed to record, **per-deck monitoring defaults ON** — you hear
what you are capturing. Separately: when a deck records a strip that is already audible in
the mix, Wizard does **NOT** auto-mute the source strip; the (possible) doubling is
**accepted**, and the user mutes manually if they want.

**Rationale:** Monitor-on is the looper expectation. On the source-mute sub-question: an app
that silently changes another strip's state during a take is doing something behind the
user's back — the exact "hidden state change" Wizard avoids elsewhere (vanished-source,
unresolved-deck postures all *keep working and say what changed*). Predictability beats
cleverness; the user has a mute button.

**Consequences:** P3-10 builds the per-deck monitor switch defaulting ON. Recording does not
touch the source strip's mute/gain. Doubling is a user-visible, user-fixable condition, not
a silent auto-behavior. `monitorSwitch` (reserved Channel field) drives it.

## D-WZ-VARISPEED-01 · 2026-07-24 · Live varispeed converter: adaptive tier

**Decision:** A deck bending speed live uses an **adaptive** streaming resampler:
**SINC_MEDIUM while the rate is moving**, upgrading to **SINC_BEST once the rate has been
stationary ~250 ms**, and **identity (no resampler at all) at rate exactly 1.0**.

**Rationale:** Meets GRM's quality bar ("the slower a sound is played, the more accurately
it is resampled") for the common "set a speed and leave it" case, stays cheap during a live
sweep (8 decks sweeping at once is the worst case), and is bit-exact when not bending. This
mirrors the deck-load decision's spirit (D-WZ-DECKSRC-01) applied to the live path, and is
distinct from D-WZ-ASRC-01 (live *taps*, always SINC_BEST — a tap cannot be "parked").

**Consequences:** P4-02/P4-09 replace the current linear interpolation with a libsamplerate
streaming converter carrying two quality states + an identity bypass; the identity path
stays bit-exact (the varispeed `snapUnity` UI + engine 1 ppm snap already make rate 1.0
reachable). A ~250 ms stationary timer in the deck render state picks the moment to upgrade.

## D-WZ-WATCHDOG-01 · 2026-07-24 · Feedback watchdog: +6 dBFS RMS sustained 250 ms

**Decision:** The feedback watchdog engages a **ramped hard limiter and raises the alarm
when a bus's RMS exceeds +6 dBFS sustained over 250 ms**, releasing only after a hold period
below threshold. **RMS, not peak**, so a single loud transient never trips it.

**Rationale:** External feedback loops (out → another app → "Wizard Out" → back in) are
structurally undetectable — the watchdog is the only guard. +6 dBFS/250 ms distinguishes a
runaway loop (sustained, climbing) from loud-but-legitimate material (transient). A lower
threshold (0 dBFS) or shorter window (100 ms) reacts sooner but false-trips on real content
— worse for a performance tool than a slightly later catch.

**Consequences:** P4-04 builds the per-bus RMS detector + ramped limiter + `feedbackAlarm`
HotFrame scalar (already reserved). Threshold/window/hold are signed constants, tunable
later without a design change. The limiter ramp uses the D-WZ-RAMP-01 shape.

## D-WZ-DEVGONE-01 · 2026-07-24 · Absent session device: fall back to default, loudly

**Decision:** Device selection is saved in the session (name + fallback). When the named
device is absent on open (different machine, or unplugged), Wizard **falls back to the
default device AND surfaces a loud, non-blocking notice** naming the device it wanted versus
the one it got.

**Rationale:** Same posture the app already takes for a vanished capture source or an
unresolved deck: keep working, keep the reference, and *say what changed*. Silent fallback
risks recording the wrong input unnoticed (the failure Wizard exists to prevent); opening
with no device teaches distrust (an instrument that boots silent feels broken). Per-machine
memory is a nice later refinement but is invisible state — deferred.

**Consequences:** P7-08 adds device identity to the session schema (name + a fallback) and
the open path emits a session notice through the existing banner. Per-machine device memory
is explicitly a **later** enhancement, not this cut.

## D-WZ-RINGRECOVER-01 · 2026-07-24 · Ring latency recovery: adaptive growth now, servo later

**Decision:** A source ring recovers from a one-time upset (glitch / stall / device format
change) via the already-signed **adaptive ring growth** (D-WZ-CLOCK-01): on sustained
underrun the ring grows 1.5×→3× and logs it. A gentle **average-based fill servo** to claw
back latency is deferred until it can ship **behind an hour-long soak fixture** proving it
never fights the ASRC feedforward path.

**Rationale:** Growth handles the *dangerous* direction (underrun → dropout) with no
control-law subtlety, and is already signed. A continuous fill servo is the "right" answer
for latency recovery but is exactly the class of feedback loop that fought the ASRC
feedforward once before and had to be torn out — it earns its place only with a soak
fixture at the `asrc_drift_test` bar, not by feel.

**Consequences:** P2-03a scope for now is confined to adaptive growth (largely already
present per D-WZ-CLOCK-01) + logging; the average-fill servo becomes a separate future row
gated on its soak fixture. No servo lands unattended. Latency after a non-underrun upset may
stay a few ms off until the source is re-armed — an accepted, logged condition.

## D-WZ-VDEV-01 · 2026-07-24 · Virtual device: 16 channels (8 stereo pairs)

**Decision:** "Wizard Out" is **one 16-channel device — 8 stereo pairs**. An app routes
each feed (a DAW's stems, ScoopyLoops' decks and FX outs, or just its stereo output on
pair 1) to a pair of its choosing; Wizard maps **pair *n* → its own equal strip**
(`source.kind = virtualDeviceInput`, already reserved).

**Rationale:** The interface is app-agnostic, Loopback-style — there is no app-specific
bridge, and all strips are equal (user framing, 2026-07-24). Multi-pair routing becomes a
v1 property for the cost of a channel-count constant in the same driver; deferring it
(2ch now) would land the upgrade on the most expensive release path we have
(sign/notarize/install a second driver). N×2ch devices would buy per-app attribution at
the cost of N drivers and device-list clutter — not worth it unless attribution proves
essential.

**Consequences:** P5 builds the AudioServerPlugIn (and the Linux null-sink) with 16
channels. Apps that only write channels 1–2 use one pair; idle pairs cost nothing.
Per-pair source-app attribution is not knowable from the device alone — strips are named
by the user, not auto-named after apps. The P5 gate is unchanged: ScoopyLoops selects
"Wizard Out" and appears as a strip.

## D-WZ-MON-02 · 2026-07-24 · Loop handoff auto-closes monitoring; overdub keeps it live

**Decision:** At the Law C-3 record→loop handoff, the deck's `monitorSwitch`
**auto-closes in the same render block** — the loop replaces the live input, no doubled
beat. **In overdub mode the switch stays open** (hearing the input against the loop is
the point). This **amends D-WZ-MON-01**: its no-auto-change rule gains exactly this one
exception, scoped to the deck's *own* monitor switch; other strips are still never
touched.

**Rationale:** The performer's ear is the argument: the instant a loop closes, input +
loop together is doubling, not information. Closing the deck's own switch at the handoff
is not a hidden state change in the D-WZ-MON-01 sense — it is the visible, expected
completion of the gesture the user just performed, on the object they performed it on.
A per-deck preference can be added later if real sessions show both habits.

**Consequences:** P3-10 builds the switch with this handoff behavior: armed → monitoring
ON (D-WZ-MON-01), stop-with-loop → switch closes at the same block boundary as the C-3
handoff, stop-without-loop → switch state unchanged, overdub (D-WZ-OVERDUB-01) → switch
stays open while layering. The switch remains user-flippable at any time; the automation
only sets it at the handoff instant, never fights the user afterwards.

## D-WZ-OVERDUB-01 · 2026-07-24 · Same-deck overdub: mix-into-buffer (sound-on-sound)

**Decision:** Overdubbing into a looping deck **sums the captured input into the loop
buffer at the playhead** — classic destructive sound-on-sound. One deck, one buffer, one
fattening loop.

**Rationale:** User's pick (over the auto-new-deck and layer-list alternatives): the
looper feel wants the layer to land *in* the loop, not on another strip, and the
destructive model is the cheapest and the truest to hardware loopers. It respects
D-WZ-DECK-01 trivially — mixing in place does not grow the buffer, so the 256 MB cap and
the RT no-allocation rule are untouched.

**Consequences:** New engine work (a P3 follow-up row): an overdub state where the deck
plays its loop AND sums input into the same chunked buffer at the playhead. The RAM
buffer is destructive — **but the drain side still runs: each overdub pass drains to its
own crash-safe, stamped take file**, so the material of every pass survives on disk even
though the pre-mix buffer state does not (recorder.md §9's invariant). Monitoring stays
live during overdub per D-WZ-MON-02. A layer-list (non-destructive) model remains a
possible future decision, not this one.

## D-WZ-GREC-01 · 2026-07-24 · Global recording: record-time mode — sum only, or multitrack

**Decision:** Global recording is **modal at record time**: the user chooses **stereo
sum only** (bus 0 post-master-fader, one crash-safe BWF — the disk-saving mode) or
**multitrack** (the sum PLUS a continuous per-strip capture of every active strip, each
file stamped to the common origin `TimeReference = startEngineSample −
globalRecordStartSample`). Global capture is **file-only**: no RAM buffer, no 256 MB
cap, not live-loopable — the archivist, not the instrument (that stays D-WZ-DECK-01's
domain).

**Rationale:** User's pick: make the cost optional at the moment it is incurred — sum
only "if you want to save memory", full multitrack when the session matters. A mode
beats per-strip arming for the first cut (one decision at record start, nothing to
forget mid-take); per-strip session-arm inside multitrack mode remains a later
refinement. The stamps make the multitrack DAW-ready by themselves: P3-04 already writes
the engine-sample stamp into BWF bext TimeReference, so "import at original position"
reconstructs the session — Law C-2 extended to files, no shared timeline introduced
(Law C-1 holds).

**Consequences:** Builds per `docs/specs/global-recording.md` (now signed policy): engine
bus/strip drain taps → GlobalRecordService (N writers, one thread, the RecordService
pattern) → schema (globalRecordStart/stop + the mode) → UI (global ● with a sum/multitrack
choice + running size readout) → fixtures (`global_sum_test`, `global_stamp_test`,
`global_kill_test`). Multitrack disk cost is real (~1 GB/h per stereo file; sum + 8
strips ≈ 9 GB/h) and is stated in the UI, not hidden. Per-strip capture is that strip's
post-fader contribution, not a dry archive (a pre-fader tap would be a new decision).


## D-WZ-ARRIVAL-01 · 2026-07-24 · Material arrives STOPPED, not playing

**Decision:** A Strip that gains material by a user action that is not recording —
dropping a file, loading a take — **arrives stopped**. It does NOT auto-play. The one
exception is unchanged and remains a law: **record-stop → looping playback instantly**
(Law C-3), because there the user's gesture WAS the transport.

**Rationale:** The design review argued for arriving-looping as the antidote to GRM's
documented discoverability failure ("couldn't even figure out how to make the sound loop"),
making the discoverable verb *stop*. The user chose stopped, and that is the right call for
this app: Wizard already holds the line that software which makes sound you did not ask for
is hostile (restore lands decks idle for the same reason). Discoverability is bought with
affordances, not with unrequested audio.

**Consequences:** Drop-a-file and load-a-take land idle with the transport visible.
Discoverability must therefore be carried by the Strip's own affordances (a prominent,
never-moving transport; consequence-stating tooltips) rather than by motion. Law C-3's
stop→loop handoff is untouched.

## D-WZ-RECMODEL-01 · 2026-07-24 · Recording is a verb on every Strip (two steps)

**Decision:** Make "recording is the verb that gives a Strip material" true in code, in two
steps. **(A) now, no schema:** the record verb is present on every Strip; recording captures
**that Strip's own source** rather than a hardcoded `inputs[0]`; where the engine cannot
capture a given source kind the verb is **visibly disabled with the reason**, never silently
inert. **(B) `PD-CANVAS-06`, before PD-CANVAS-05 retires the console:** add
`material: { deckId }` to Channel ALONGSIDE `source`, one version bump, named migration,
engine untouched.

**Rationale:** `Channel.source` currently does two jobs — where signal comes FROM and where
material LIVES. That single conflation is why a mic Strip has no record button, why a deck
Strip records a hardcoded input, and why provenance is lost once a take exists. Step B is
the real repair; it is scheduled BEFORE the console is retired because afterwards there is
no second surface left to repair it on.

**Consequences:** A is a correctness fix and ships now. The interim rebind the review
proposed for A (rebinding the recorded Channel's `source` to the new deck) is **rejected**:
it would silently drop the strip's input binding, so a mic strip would stop hearing the mic
the moment it gained a loop — wrong for a looper, and it would be churned away by B anyway.
Until B lands, "a Strip keeps its source AND holds material" is not expressible; the record
verb is honest about that rather than pretending.

## D-WZ-ROUTINGVIEW-01 · 2026-07-24 · Routing on the plane: the bus chip, and nothing more yet

**Decision:** Audio routing is shown on the plane by an **always-on bus chip on every
Strip** — and nothing else for now. No general cable layer. The review's further layers
(hold-to-trace highlight, an edge bus rail doubling as a drop target, the RoutingMatrix as a
summoned ledger) are **deferred** until the chip proves insufficient.

**Rationale:** Wizard's graph is a STAR (each strip → one of 8 buses), not a mesh; drawing
cables would picture a topology the app does not have. The chip is the smallest thing that
answers "where does this go?" at a glance, and it is the piece every richer layer would sit
on top of anyway. Shipping the smallest correct surface first is how we avoid building
chrome we then have to defend.

**Consequences:** Every Strip carries its bus as a chip. Kind colour must move OFF the name
text so the chip can own colour without the two hues fighting (the review's point: kind is
what it IS, bus is where it GOES). The existing RoutingMatrix stays available in the console
and is not yet re-hosted on the plane. If the chip proves too weak, the trace/rail layers are
already specified in `docs/specs/pd-plane-playground.md`.


## D-WZ-SCRUBCUE-01 · 2026-07-24 · Scrubbing arms a one-shot cue point

**Decision.** After you scrub (or jump-seek) a deck, the next trigger fires **from the
scrubbed frame**, not from the loop region's entry edge. The cue is a **one-shot**: the
trigger consumes it, so the loop wrap immediately after returns to the region entry, and a
second trigger with no scrub in between starts at the entry again. A cue lying outside an
active loop region folds into it on the wrap, exactly like any other position — a loop is
a loop. New material (load, insert, record) disarms it.

**Rationale.** Scrub to the drop, hit ⟳, it fires from there: the classic turntable/CDJ
cue, and the thing a looper is for. The previous behaviour — ⟳ always starts at the region
entry — was never chosen. It is what remained after PD-SCRUB-01 fixed a *stale mailbox*
bug, where a pending scrub was applied on some later block and happened to override the
trigger's reset. Fixing that bug left the opposite behaviour standing by accident, which is
why this was parked as PD-SCRUB-05 rather than left to whatever the code did.

One-shot rather than "scrub moves the loop in-point" (the third option) keeps auditioning
non-destructive: you can drag through material to find a spot without editing the region
you carefully set. The cost is a second start point existing at all, which is paid for by
making it **visible** — the Strip draws a cue notch — and by keeping its life short enough
(one trigger) that it cannot be forgotten about.

**Consequences.** `Deck::cueFrame` is render-owned, armed by both the playing and the
STOPPED scrub paths (parking the head on a stopped deck is the commonest way to set a cue)
and cleared in `reset()`. `deck_seek_test` REVERSES its old assertion and now pins all
three properties: fires at the cue · the cue is consumed · an out-of-region cue folds. The
UI mirrors the cue locally instead of adding a HotFrame field — the UI issued the seek, so
it already knows, and it clears on the same gesture the engine consumes it.

## D-WZ-ALIGN-01 · 2026-07-24 · The align-to-take verb is dropped, not rehomed

**Decision.** The Law C-2 align-to-take verb (P3-07) does not move to Settings or onto the
Strip. It is **removed from the current UI**, and P7-GREC's common origin is the supported
way to line a session up.

**Rationale.** It lost its home when the takes panel went (pd-merge §3 left this open).
Global record mints `globalRecordStartSample` and stamps every file with
`TimeReference = startEngineSample − globalRecordStartSample`, so dropping all files at
0:00 in any DAW already reproduces the session — which is most of what manual alignment was
for. Keeping a session-wide operation parked on some surface "because it exists" is how a
simplified UI regrows.

**Consequences.** The stamping machinery stays and is still tested (`recorder_drain_test`
pins the hand-off) — this removes a *verb*, not a law. If the need reappears, it comes back
as its own row with a stated use case rather than as an orphan button.

## Parked — awaiting decision (do not block earlier phases)

| id | needed before | question |
|---|---|---|
| **D-WZ-DECK-01** | P3 | Deck memory policy: 8 decks × long takes live in RAM for instant playback. Cap per deck, then — stop, spill, or degrade-to-file? |
| **D-WZ-PDC-01** | P6 | PDC in a live mixer: full-graph PDC delays monitoring. Proposal: compensate parallel paths only, expose per-channel latency, subtract insert latency from record-path stamps. Deviates from parlante's full-PDC (offline vs live). |
| **D-WZ-SHARED-01** | after P2 | Rule of three: extract `@suite/design-tokens` + `@suite/slp-codegen` as private packages once the third vendored copy proves out. |

## D-SL-STORE-01 · 2026-07-28 · The merged app's library is native disk (ratifies D-1)
**Decision:** the session/sample library lives on native disk behind the contained `slFiles`
dispatch (atomic staged writes, verbatim names, traversal refused, trash-first removal); OPFS
remains the browser companion's storage only.
**Rationale:** measured — the JUCE WKWebView could LIST an OPFS library but not WRITE one; every
"new session" was a zero-length landmine. The flip is the same move `slMap` made, one tier down,
and routing `opfs.ts` wholesale flipped sessions, samples and the file browser in one seam.
**Consequences:** the library is a visible folder beside Takes; the zero-length corrupt-session
class is unmanufacturable; the read-only `/takes` mount rides the same namespace (carve).

## D-SL-TAPEBPM-01 · 2026-07-28 · A tape learns its bpm by inference, with a refuse-band (ratifies D-2)
**Decision:** a recorded tape's bpm derives from loop length + the take's `bpmAtStart` stamp,
snapped to the nearest power-of-two beat count in log space; >±20% off every power of two infers
NOTHING (Inspector field stays empty for the hand); the user's typed value always wins and is
never re-derived; loaded files are manual-only.
**Rationale:** neighbours on the scale are 2× apart, so a hand-stopped loop lands unambiguously;
"unknown" beats a confidently wrong number that stretches a tape to nonsense when sync engages.
**Consequences:** quantized capture (SL-ABI-V3 §5's record_start_quantized) stays the later,
by-construction upgrade, deferred with §7.

## D-SL-TAPESYNC-01 · 2026-07-28 · Sync ≠ stretch: varispeed default, opt-in stretcher, C-3 closes dry (ratifies D-3)
**Decision:** a synced tape defaults to `timePitch` (zero latency, pitch rides rate);
`timeStretch` is per-strip opt-in accepting the stretcher's group delay; the Law C-3
record→loop handoff NEVER engages the stretcher in its own block; no cross-element delay
matching until an alignment problem is heard.
**Rationale:** a freshly closed loop must play NOW; the ~116 ms group delay is a price the
performer chooses per strip, not a tax on every capture.
**Consequences:** TAPE-STRETCH.md is the normative spec; the all-or-nothing bypass group stays
decks-only.

## D-SL-PANELS-01 · 2026-07-28 · deckmixer and djmode stay reachable as windows (D-5, interim)
**Decision:** both panels keep their ≡ doors while the plane matures; the retire-and-rehome
audit is revisited at the polish pass. Instrument stays doorless until P6 (pluginHosting false).
**Rationale:** "nothing lost" outranks tidiness while the replacement surface is still growing.
