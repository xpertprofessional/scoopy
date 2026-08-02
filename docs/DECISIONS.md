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

## D-SL-MORPH-01 · 2026-07-29 · The strip IS the deck — real GridPanel, one kind per strip (ratifies D-4)
**Decision:** (1) a session-loaded strip expands to a large tile (~3×3 cells) hosting the REAL
`GridPanel` at DJ density — the same component that IS the DJ deck view in scoopyloops since
AR-6 — with the deck verbs folded into the strip header; collapsed, it keeps the compact face.
(2) Strips are ONE KIND EACH: a scoopy-session (grid) strip or a looper (tape) strip — no
composite grid+tape element; "the looper records the deck's own output" is two routed strips
(patch grid-strip bus → looper strip's record tap). (3) "Stacked" is the recorded answer only
if a combined face ever returns. (4) Amends D-SL-PANELS-01: djmode/transport/deckmixer leave
the ≡ menu (their windows hang on WaitingForState in the merged host); code stays; the ≡ menu
is interim scaffolding, dissolving as panel jobs rehome onto the plane.
**Rationale:** the user's words — the strip should show "exactly what we see when we toggle dj
deck view" (single performance deck), and strips should "be different: scoopy session grid or
looper" rather than combining. The parity target is already in-tree web code; a projection
would be a second deck UI to maintain. One-kind strips kill the P3-X1 migration, let sends
route into loopers, and keep carve (cross-strip by construction) as the one-click loop→grid path.
**Consequences:** P3-X1 retired-by-decision; STRIP-MODEL's "a strip can hold BOTH" amended;
the deck tile needs a plane-side source for GridPanel@dj (P3-D4-M measures adapter vs shell
topics); per-session-track taps remain a future decision (Method-B feedback trap unchanged).
The build record is the P3.5 queue in `docs/merge/P3-LEDGER.md`.

## D-WZ-PDC-01 · 2026-07-29 · PDC in a live mixer: parallel paths only — SIGNED, P6 opens
**Decision:** plugin latency is compensated across PARALLEL paths only (never the full graph);
each channel's latency is exposed in the UI; insert latency is subtracted from record-path
timestamps. Live monitoring stays immediate. Signed live by the user (AskUserQuestion), who
also directed the implementation route: REUSE scoopyloops' own `NativePluginHost` (JUCE-based
C++/ObjC++ — crash-safe out-of-process VST3/AU scanner + per-return `NativePluginSlot`), whose
header the merged tree already vendors and whose render machinery already sits in the vendored
core behind `SCOOPY_PLUGIN_HOST=0`.
**Rationale:** full-graph PDC delays live monitoring — wrong for a live-capture instrument
(the parlante deviation is offline-vs-live, documented since the proposal). The reuse route:
the "plugin hosting path we already created in scoopyloops" is JUCE C++, not Swift — porting
would be rebuilding what exists.
**Consequences:** P6 un-parks. P3-3-1/P3-3-2 (FX returns audible) unblock — their config path
IS the hosted plugin. The P6 queue (P3-LEDGER.md): vendor `NativePluginHost.mm` + flip
`SCOOPY_PLUGIN_HOST=1` + link JUCE plugin formats → fxSlot dispatch + scanner/picker live →
plugin audible on a return (returnFx flips true) → JUCE-hosted editor windows (replacing
FxSlotWindowController.swift's job) → fx-slot state (identifier + state blob) persisted per
return in the `.scoopyMap` → per-channel latency surfacing per this decision.

## D-SL-DECKFULL-01 · 2026-07-29 · The expanded strip is the WHOLE deck, and it goes full-viewport (extends D-SL-MORPH-01)
**Decision:** (1) the expanded grid tile carries the classic scoopy deck **transport in full** —
the toolbar row (OPEN · ■ · ▶ · » · REV · NUDGE · DBL · EJECT · SAVE), the SYNC/pulse + TR ·
WIN · BR row, the scene row (pads 1–8 · S R CU · SCN · MUTE · GRID/PERF) and the master row
(BPM · VOL · DRV · S1–S4) — every verb REBUILT on merged companion lanes (the P3-D4-2 pattern),
never mounted from `TransportPanel`'s `DeckBlock` as-is. (2) It stays a **plane tile** rather
than becoming a per-strip window, and gains **full-viewport mode**: the focused strip fills the
viewport on command, Tab cycles strips at full size, one key drops back to the map; compose
stays reachable from the tile. (3) Looper (tape) strips LATER gain deck-like transport
possibilities (a fixed-value rate slider, transport verbs) — queued, deliberately not now.
**Rationale:** the user's words — the deck window should be "pretty much exactly the scoopy
loops dj deck view WITH its deck transport … this way we can be sure our advanced scoopy
system functions correctly ongoing". Validating the advanced system in place is the point; a
separate window per strip would turn strip-tabbing into window-switching.
**Consequences:** P7 opens as "the deck, whole". STRIP-DECK.md's "Deliberately NOT folded"
list is superseded item by item (OPEN · DBL · WIN/TR · GRID/PERF all fold in), and D4-2's
header verbs migrate DOWN into the classic rows — one control, one home, which also closes
that row's recorded SYNC deviation. `DeckBlock`'s verb set (`deckSection` / `transportDeck` /
`menuTransport` / `djSetting`, the desktop-shell coupling the P3-M-1 measurement found) is the
REHOMING SOURCE LIST, not a mount target. Full-viewport is a VIEW-layer state and must never
write the document's cell geometry.

## D-SL-LAUNCH-01 · 2026-07-29 · Launch chooser: PLANE or mapless COMPOSE
**Decision:** app launch offers **PLANE** (today's behaviour, `openPanel("plane")`) or
**COMPOSE** — and the compose path is **MAPLESS**: the compose window boots on deck 0 with no
map document created at all, and `ComposeWindow` gains explicit session **open / new / save**
UI.
**Rationale:** the user — "at app launch we are prompted for PLANE or COMPOSE and via this path
we can launch a compose window with all possibilities (load and save) without having to open
the map / plane first." `sessionStore` already owns every verb (save/open/create/rename/
delete/import/export); autosave-only UI was the gap, not the machinery.
**Consequences:** `MergedMain.cpp`'s unconditional `openPanel("plane", "", isMain)` branches;
PANEL-AUDIT gains a launch note. The single-publisher rule (P3-C2, `composingDecks`) is
trivially satisfied on the mapless path — there is no plane to contend for the deck.

## D-SL-NAV-01 · 2026-07-29 · One keymap, live in the merged host — focused-strip semantics
**Decision:** the full keymap (`web/src/commands/keymap.ts`) actually DISPATCHES in
WizardMerged via a **JS dispatch layer** — HotkeyManager's job rehomed, because that Swift
class does not exist here and ~90 of ~100 entries are `owner:"native"`, i.e. declared,
documented, generated into a Help window, and dead. The keymap's own header already names
"the TS dispatcher" as the deferred plan; this signs it. Deck-A/B key PAIRS (Q/W/E vs A/S/D,
`-` switch active deck, ⌘⇧1/2/3 send-to-deck) **collapse to one set targeting the FOCUSED
strip**; Tab moves strip focus; focus is a visible highlight wired into the existing
`focusModel` / `claimKeyboard` arbitration. One open detail, spec'd provisional in
NAV-SHORTCUTS.md: digits as scene-launch-on-the-focused-strip (scoopy muscle memory) versus
focus-jump — the recommendation being digits = scenes, modifier+digits = focus jump,
Tab/⇧Tab = cycle.
**Rationale:** the user — "the list is long and should work fully, so we need to be able to
high decks and strip to use our navigation system". A/B pairs are a two-deck vocabulary; a
plane holds up to eight strips, so focus is the only model that scales without inventing a
second one.
**Consequences:** the `forwardKey` / `useNativeKeyForwarding` lane retires (nothing in
`shell/` ever handled it); `context:"dj"` entries re-context onto the focused strip; the
collision tests extend per-context; `Generated/ShortcutList.swift` emission is kept honest or
retired in the same commit, because `protocol:check` gates its drift. Full-viewport Tab
cycling (D-SL-DECKFULL-01) rides this same focus model. `docs/merge/NAV-SHORTCUTS.md` becomes
the normative spec, produced by row P7-K0.

## D-SL-MAPPERF-01 · 2026-07-29 · The map holds the performance: the overlay layer (ratifies both MAP-SCHEMA hazards)
**Decision:** `sessionPerf` / `perfBySession` generalizes into a per-(strip, session)
**performance overlay** carrying every session-level setting worth restoring for a
performance. It is re-applied at map load AND after any compose republish of that deck. The
write-routing law: **plane-surface edits to session parameters land in the OVERLAY; compose
edits land in the SESSION.** Maps must also restore FX-slot state (already queued as P6-5) and
tape audio (the `tapeLoadTake` no-op becomes a row). Deliberately NOT persisted: device and
hardware routings (the user: "flexible on devices and hardware routings of course") and MIDI
mappings (blocked — the merged shell publishes no `midiLearn` topic).
**Rationale:** the user — "a map should basically hold all settings saved, but be flexible on
devices and hardware routings … anything that is worth storing so it can be restored easily
for a performance."
**Consequences:** both of MAP-SCHEMA's ⚠️ hazards are settled by construction. The *bleed*
hazard ("unpinned edits bleed across maps", which said **settle this before the plane UI
exposes any session-parameter control**) is answered by the write-routing law — and this
RETROACTIVELY legalizes P3-D4-1a, which crossed that line when MasterRow's BPM/VOL/DRV became
real document writes; the control's behaviour is unchanged, only its persistence target moves
(row P8-4). The *stomp* hazard is answered by re-apply-after-republish becoming law — the
document's own proposed fix, now signed (row P8-3). P8 opens.

## D-SL-DECKOUT-01 · 2026-07-29 · A grid strip's channel bus must carry its deck (a defect, hoisted)
**Decision:** a grid-deck strip's `channelOut` MUST carry that deck's mix. Today it carries
only what is routed INTO it: `ChannelBank::mixInto` sets `elemL/elemR` for
`ChannelSourceKind::tape` alone (`slengine/src/sl_channel.cpp:598-604`), and `sl_channel.h`
states outright that a gridDeck channel's meter reads 0 because "this bank deliberately mixes
nothing for it". This is a **defect against shipped behaviour**, not a new feature: P3-R3's
signed gesture (REC on a grid strip spawns a looper patched from the source's bus) records
silence, and `channelBus` capture of a grid strip does too. It is hoisted as **P3.5-E3**,
ahead of P7. The fix mechanism is measured in the row — a deck-out lane read inside `mixInto`
versus a new `SourceEndpoint::deckOut` naming the core's existing `AudioLane::deckA/B/C`.
**Rationale:** the two-routed-strips model (D-SL-MORPH-01) is the ONLY way to loop a deck now
that strips are one-kind-each, so a silent deck bus does not merely lose a feature — it
invalidates the decision that replaced the composite strip.
**Consequences:** the P3.5-AUDIT user gate's outstanding "looper routing (two strips)" walk
would today pass only if nobody listened back; the gate row is annotated to wait for E3. The
audible ctest fixture extends the `sl_route_test` / `plane_audio_test` shape: a grid strip's
bus carries its deck, and chained into a looper it records sound.

## D-SL-RECFROM-01 · 2026-07-29 · Looper inputs: the `record from ▸` menu first, the matrix grid second
**Decision:** a looper strip picks its source through the existing per-strip ⋯ **`record from ▸`**
menu, grown to every source kind the engine already has — other strips' bus (built), other
strips' **send taps** S1–S4 (engine-proven at `sl_route_test:244-266`, with **no UI able to
author one** today: `patchDrag` is always constructed with `send: null`), **FX returns** (the
record-the-wet path STRIP-MODEL names), device inputs (built), and virtual pairs when they
exist. The Matrix then grows the dense **sources × destinations grid editor**
(ROUTING-MATRIX's second view) as the precise surface, and with it route-gain editing
(`slRoute/setGain` is dispatch-live with zero web callers) and the feedback toggle honouring
the create-muted precedent.
**Rationale:** the user asked for "intuitive ways to choose audio inputs for looper (via fx
send from a deck e.g. …)". One gesture, plane-native and already learned, beats a new surface;
the grid follows for when a table beats spaghetti. Broad routing opens as phase **P9**, after
P7 and P8.
**Consequences:** no engine work for the send-tap path — this is authoring UI over a proven
graph. The recorded routing debt rides P9 with it: the duplicate-cable guard exists only in
`onRecordFromStrip` (a repeated shift-drag silently doubles gain), feedback edges are created
at unity against ROUTING-MATRIX's own precedent, and `feedbackMs()` hardcodes 512/48000 so the
price shown on every cable is wrong at any other block size. Cue bus, per-deck outs and
multi-hardware-output stay designed-not-queued.

## D-WZ-VDEV-02 · 2026-07-29 · Other-app audio: third-party interim now, the native device unparked (amends D-WZ-VDEV-01)
**Decision:** third-party virtual devices (BlackHole, Loopback) selected as the input device
are the **acknowledged interim path** for getting another app's audio into a session — it
works today through `slDevices/setInput` + a `deviceInput` route, and costs documentation plus
a hint in the input picker, no engine code. The native **Wizard Out** device (16 ch / 8 stereo
pairs, D-WZ-VDEV-01) is **UNPARKED** and earmarked as phase **P10**, opening after P9.
**Rationale:** the user wants "the virtual interface that would allow other app audio right in
the session". The design is signed and the capture ABI exists — but only `CaptureFake.cpp`
backs it, the real path is CoreAudio process-tap plus an AudioServerPlugIn loopback driver
(macOS 14.4 floor), and `sl_route_*` has no `virtualDeviceInput` source kind at all. That is
weeks of platform work; naming the interim path costs a paragraph and unblocks users now.
**Consequences:** MIGRATION.md's PARKED P2-05 / P2-06 / P2-07 rows gain an unparked-by-this-
decision note pointing at P10. P10's genuinely new work is the `sl_route_*` `virtualDeviceInput`
kind and wiring a real backend where the fake stands; `host/include/wz_capture.h` and
ARCHITECTURE.md's macOS tap design stand as written. Nothing in P9 waits on it.

## D-SL-PDC-REF-01 · 2026-07-30 · PDC compensates WET-vs-WET only (settles D-WZ-PDC-01's reference point)
**Decision:** "parallel-path compensation" means **each host return's wet is delayed by
(max active return latency − its own) before it sums to main**. Every dry path is untouched.
Signed live by the user (AskUserQuestion) after the plan audit found the clause had no
unambiguous reading.
**Rationale:** ARCHITECTURE.md:236-240 glosses the term as "dry-vs-send alignment", but there
is no separate monitor path to spare — a strip's dry is written once at `sl_channel.cpp:731-732`
(the comment says "this is the record tap"), the meter is taken off the same samples, and that
same buffer pours to main at :752-765. There are no channel inserts at all (source kinds are
none/tape/gridDeck, `sl_engine.h:360-365`); the only plugin slots are the four per-return ones.
So the literal dry-vs-send reading delays what the performer hears, which D-WZ-PDC-01 forbids
two sentences after it requires the compensation. Wet-vs-wet is the only reading that satisfies
both halves as signed: returns already sit downstream of the monitoring path, so aligning them
against each other costs the performer nothing.
**Consequences:** P6-6 is REFUSED as written and splits into P6-6a / P6-6b / P6-6c (see the
ledger). The dry-vs-send reading is recorded as REFUSED here so it cannot quietly return.
ARCHITECTURE.md:236-240's gloss is superseded by this entry. Clause 3 (record-stamp
subtraction) is scoped by this reading: only a record source that can carry return wet is a
subject, which today is a bus/main capture, never a strip's dry tap.

## D-SL-MAPOPEN-01 · 2026-07-30 · A map open LOADS its strips' sessions, blocking, before the overlay
**Decision:** `openMap` resolves each grid strip's `sessionId` through `useCompanion.open(sessionId, deck)`
**before** any overlay op runs, and waits for them. A session that cannot be resolved becomes an
UNRESOLVED STRIP preserving both the reference and the overlay — the shape MAP-SCHEMA.md:176-178
already promises — rather than an empty strip that looks like a session with nothing in it.
Signed live by the user.
**Rationale:** the plan audit found that opening a map never opens any session at all
(`mapFiles.ts:70-88` is slMap/open → loadMap → setMap → applyMap and stops; boot is session-free
at `PlanePanel.tsx:374`). The only production `useCompanion.open()` callers are the manual strip
menu, the compose return and ComposeWindow. So "reopen → everything back" had no loaded session
to restore ONTO, and the whole P8 overlay sits on that load path. The symptom already renders
today — `Inspector.tsx:424-432` says "session not loaded". Blocking rather than progressive
because P8-3's re-apply needs a deterministic order, and a progressive load makes the overlay
race the world it is meant to correct.
**Consequences:** new row **P8-0**, ahead of P8-2, owning the load path. P8-3's re-apply gets a
completion hook to hang off instead of the fire-and-forget `setTimeout` the audit found. P8-6's
round-trip gate becomes reachable. A slower map open on a large set is the accepted cost.

## D-SL-E4-HOIST-01 · 2026-07-30 · P3.5-E4 is hoisted ahead of P7
**Decision:** P3.5-E4 (a grid strip's own channel bus carries nothing — the unbuilt half of
D-SL-DECKOUT-01) takes a position in the global order **ahead of P7**, rather than staying
parked with no phase. Signed live by the user.
**Rationale:** E4 is a hard dependency of P9-1's headline walk (a grid strip's send tap records
silence without it) and of P7-T4's master sends, and it retires the `setDeckGainOverride`
projection at `sl_engine.cpp:456-469` that two further phases would otherwise build on top of.
Finishing the signal path once, while E3 is fresh, is cheaper than unpicking it later.
**Consequences:** global order becomes … → P6-6a/b/c → P6-AUDIT → **P3.5-E4** → P7 → P8 → P9.
E4's scope is widened by the audit's finding that `projectToCore` forwards all four SENDS as
well as level/mute, so retiring only the level/mute projection would double-send.

## D-SL-FACES-01 · 2026-07-30 · Both strip faces render the same state — pads and SYNC do not move
**Decision:** scene pads and SYNC stay on the COLLAPSED strip face; the expanded deck tile's
classic rows are the expanded-face instances of the **same store state**, not a rehoming.
P7-T2's "SYNC promoted out of the grid row" and P7-T3's "P3-U8's pads rehomed" are amended
accordingly. Signed live by the user.
**Rationale:** `Strip.tsx:903-921` and :1136 render GridScenes/GridControls unguarded by
`expanded` today, while :965 shows the file gates deliberately when it means to — "both faces,
one state" is the built convention, not an accident. Launching a scene from a collapsed strip is
the plane's primary performance gesture (P3-U8's shipped door), and at 692×612 per expanded tile
you cannot keep more than one or two decks visible, so the collapsed face has to stay playable.
**Consequences:** "one control, one home" is explicitly NOT the rule for state that is played —
it governs verbs with side effects (D4-2's SAVE/⏏), not performance surfaces. P7-T5's tile walk
must additionally assert the collapsed face still plays.

## D-SL-ONEHOST-01 · 2026-07-30 · One host, one engine tier — and the gates run WebKit
**Decision:** `WizardMerged` is the ONLY host. The donor tier that survived the P3 flip only via
its own tests is retired: wizard's `Main.cpp` shell, its `CommandDispatch` dispatcher, the P1
`spike/` target, `wz_engine` and its ~21 tests, `SessionStore`, `PackageStore` and the `Wz*`
engine bindings. `engine/` is **reduced, not deleted** — it survives as the vendored
libsamplerate the decoder needs. Separately, the browser walk gates change their default engine
from Chromium to **WebKit**, and a native `MergedWalk` target is built to cover the JuceLink half
no browser walk can reach. Signed live by the user, in answer to their own question about whether
this tree runs two different webviews.
**Rationale:** it does not — `juce::WebBrowserComponent` IS WKWebView on macOS and WebKitGTK on
Linux, one engine named at two levels. But the question was pointing at something real twice over.
(a) Three files looked like the app and one was: `Main.cpp` had been orphaned since 2026-07-27
with no target compiling it, and `spike/` was still built ON by default serving *another repo's*
bundle six days after its own written deletion condition was met. `RenderSink.h:3` states the
whole tier's reason — "P1 of the merge runs TWO engines side by side" — and that stopped being
true at the flip. (b) The gates measure the wrong engine: seven of eight walks hardcode
`chromium` while the app ships WebKit, and `browser_prod_test.mjs:88-103` is already a written
account of a WebKit-only OPFS behaviour the other engines "happen to tolerate". The JuceLink half
is invisible to any browser walk at all — this host has shipped an empty `slParam` listener and
an uninjected `__slPanelArg`, both green.
**Consequences:** new ledger section **H** (H1 · H2a · H2b · H3 · H4 · H5). Three things are kept
deliberately and must not be swept up as leftovers: `engine/ThirdParty/libsamplerate` (the only
supplier of `samplerate`, which `wz_decode` links and P8-5 needs); `RenderSink.h` +
`TakeDrainSource.h` (their two-engine reason dies, but the live one — keeping `wz_record`
engine-free and JUCE-free for a future WASM/companion build — does not); and `wz_capture` +
`CaptureFake`, which P10 names by file as its foundation. The cost accepted: `render_sink_test`
stops proving two engines share the device seam, because there is only one engine. What is bought:
"the door is unreachable in the real app" stops being a finding a human makes at a phase gate.

## D-SL-TOPROW-01 · 2026-07-30 · The master bar is three zones, and the wizard-era file verbs leave it
**Decision:** the plane's top row is rebuilt as **document (left) · master (centre) · output (right)**.
`save` / `export` / `open` collapse into one `map ▾` menu; `≡ panels` leaves the bar entirely (FX 1–4
rehome to the strip mixer at P7-MIX-0, settings goes under `map ▾`); `compose` leaves the bar as a
per-strip verb (P7-T1 already puts OPEN in the tile's toolbar row). Signed live by the user, whose
words were: *"the current one is old from wizard plane and includes many item we are not asking for
in the final version."*
**Rationale:** today four file/panel buttons sit BEFORE the master cluster, which is shoved right of a
spacer — backwards for a performance surface. The centre zone becomes the only contiguous group a
person touches during a set (transport · tempo · clock · quantum · BR · REV); everything else is
before-or-after work. P3-P1's own note already called `≡ panels` "interim scaffolding, dissolving as
the remaining jobs rehome" — this is that dissolution.
**Consequences:** new rows P11-1…P11-6. The bar gains a clock SOURCE, a launch QUANTUM, a TAP, an
INPUT channel, CAPTURE and a HEALTH readout — see the three decisions below for the ones with
engine cost. `Master.tsx`'s shipped stereo meter, limiter lamp, fader, transport, BR/REV and BPM
steppers are KEPT unchanged; this is a re-zoning plus additions, not a rewrite of what works.

## D-SL-XFADER-01 · 2026-07-30 · The crossfader returns, with ASSIGNABLE sides
**Decision:** the crossfader comes back on the top row, and its two sides are **assigned per strip**
(a strip menu item: crossfade side A / B / neither) rather than being deck A vs deck B. Signed live.
**Rationale:** `crossfaderEngaged` / `crossfaderPosition` are in scoopy's own `ToolbarUiState`, but
D-SL-MORPH-01 made the plane N one-kind-each strips instead of two decks, so "the crossfader" had no
two sides left to name. Assignment restores the instrument's signature gesture without reintroducing
the deck-pair model the strip model deliberately retired.
**Consequences:** needs a per-strip document field (the side) plus an assignment affordance in the
strip menu, so it is a document change and not only a control — MAP schema bump. The engine already
carries the crossfader; what is missing is which strips it acts on. Rows P11-4.

## D-SL-HEALTH-01 · 2026-07-30 · The bar reports dropouts and CPU
**Decision:** a health readout on the top row showing `<rate> · <block> · <cpu>%` plus a **monotonic
dropout/xrun count since the set began**, with a colour flip once anything has dropped. Signed live.
**Rationale:** measured 2026-07-30 — **nothing in the tree reports CPU load, xruns or dropouts**: not
`web/protocol`, not a topic, not a field. On stage the question "is it about to glitch" currently has
no answer at all. The count is the part that matters: a CPU percentage tells you how it feels now, a
dropout count tells you whether it already failed while you were not looking.
**Consequences:** a new HotFrame field for CPU load and a monotonic dropout counter — engine work,
small. Row P11-5. Deliberately NOT bundled with P9-4's accumulated per-path latency: that number has
its own definition problem and would delay this one.

## D-SL-CAPTURE-01 · 2026-07-30 · One CAPTURE button — the main mix to the library
**Decision:** a single **CAPTURE** verb on the top row that arms/stops a main-mix recording to the
session library, showing elapsed time while it runs. NOT split into capture-vs-bounce. Signed live.
**Rationale:** measured 2026-07-30 — `mainMix` exists today ONLY as a record tap for a looper strip
(`stripOps.ts:142`, `RECORD_SOURCE.mainMix`); there is no "record the set to disk" verb anywhere,
though scoopy's contract carries both `activeIsOutputRecording` and `activeIsBouncing`. A live
instrument that cannot record its own output is missing the one thing that cannot be redone
afterwards. Bounce is deliberately excluded: it needs an OFFLINE render path this engine has no row
for, and pairing them would block the verb people actually need behind the one they do not.
**Consequences:** row P11-6. Lands beside the takes a looper already writes, through the same
recorder — the take machinery exists (P3-F3's stereo-bus fix applies directly), what is missing is a
main-mix source and a door. `activeIsBouncing` stays unimplemented and is recorded as such.

## D-SL-ARCHIVE-01 · 2026-07-30 · The history moves to docs/archive, and the pd-* question closes
**Decision:** a `docs/archive/` directory now holds the zero-citation historical record —
`/MIGRATION.md`, both MORNING-DECISIONS files (every decision in them signed), the P1/P2
kickoff+status docs, `P1-SPIKE-JUCE-WEBVIEW.md`, `P3-ROADMAP.md`, `STRIP-MODEL.md`
(superseded by D-SL-MORPH-01), and the eleven wizard-era `pd-*.md` plane design studies.
The pd-* move settles the question D-4 left open on 2026-07-28: the user chose **archive**
(this session, via direct question). Signed live.
**Rationale:** ~300 KB of pre-merge history sat in the orientation path; sessions kept
re-reading documents whose every open question had since been signed into this file. The
pd-* studies predate the merge and are superseded where D-SL-MORPH-01 / D-SL-DECKFULL-01
speak; nothing cited them as open intent. Archiving is `git mv` — content byte-identical,
recoverable, still citable by name from source comments (paths rewritten to
`docs/archive/`).
**Consequences:** `docs/archive/README.md` states the contract (write-once, never a spec).
`P3-LEDGER-ARCHIVE.md` stays in `docs/merge/` (already correctly parked, and its rows'
old-path citations stay byte-identical). DECISIONS.md's own historical citations are NOT
rewritten — this file is append-only law.

## D-SL-DECKROWS-01 · 2026-07-31 · The classic deck rows, and four deviations from the donor
**Decision:** the donor's deck block is REBUILT on the expanded tile as three rows
(`plane/deckRows.tsx`), never mounted from `panels/TransportPanel.tsx`. Four donor
divergences signed live by the user, each asked as a question with the donor's behaviour on
the table:

1. **`playOnce` PORTS.** The plane's "a grid deck has no one-shot" convention is amended;
   the tile's toolbar row carries ▸¹, arming a stop at the end of the current LCM cycle
   (`BeatSequencer.swift:3573-3587`, whole).
2. **TP mode REPLICATES the donor's exclusivity.** Engaging SYNC drops TR and vice versa —
   but per STRIP, where the donor has one global `DJModeManager.pitchModeEnabled`, because
   D-SL-MORPH-01 retired the fixed deck slots that global belonged to. MAP v9; the 8→9
   migration defaults it FALSE, which is both what a v8 map behaved like and the donor's own
   default, so migration and fresh-strip agree.
3. **`gridHidden` / perform mode are SESSION LIFETIME**, not persisted. The donor keeps
   `gridHidden` as a UI pref; persisting it here belongs in the D-SL-MAPPERF-01 overlay and
   is a later row.
4. **Beat repeat stays armable while STOPPED.** The donor disables it — an engine limitation
   there, not intent, and the merged world-projection does not share it.

Plus one the DONOR corrected in us: **DBL is the DJ instant double**, not "double the
pattern length". `NativeDJCoordinator.doubleDeck(from:to:)` clones a deck's session onto
another deck as an unsaved copy so a track can be mixed against itself. Its target is ASKED
FOR here (a menu of eligible strips) rather than hardcoded as "the other deck", since the
plane has N strips of one kind each. The plan said otherwise; reading the reference before
designing is what caught it, which is PARALLEL-PROTOCOL §0 rule 2 earning its place.

**Rationale:** `TransportPanel`'s ported `DeckBlock` carries these exact rows and every
control in it speaks `deckSection` / `transportDeck` / `djSetting` — commands NO host
answers — reading a `toolbar` topic of spelled-out neutrals. Mounting it would have put nine
dead controls on screen, which is the defect the four rules exist for.

**Consequences:** two engine seams built (`sl_deck_skip_step`, deck param `texture`); the
`strip-deckverbs` header span retires into the rows; `setMetaFacts`'s dedup rewritten
exhaustive; `menuTransport` gains a real answerer so Space starts a deck for the first time
in the merged host. Row P7-T3 ships SCOPED and says so on screen — S·R·CU·SCN·MUTE are scene
verbs and land with **B2**, because five controls that reach nothing are worse than an
honest gap. Retiring the nine dead verbs is row **B1-RETIRE**: it forces deleting
`TransportPanel`/`DjPanel`, and four test files pin live laws through them that must be
rehomed, not dropped.

## D-SL-QUANTUM-01 · 2026-07-31 · Every strip names what it launches against, and 'auto' is the answer that needs no setup
**Decision:** the launch quantum's reference is **per strip**, on grid strips AND tape/looper
strips alike, defaulting to **`auto`**. `auto` resolves in a stated order:

1. the **sync-master** strip, if one wears the badge;
2. else the **lowest-numbered PLAYING** strip;
3. else nothing to wait for — the launch fires immediately.

A strip may instead name a specific reference. The strip surface shows what `auto` resolved
to, so it is never a mystery which grid a launch is waiting on. Signed live, the user's words:
*"in most cases we'll have only 2 decks active, but the new loopers also need to quantize their
launch sensefully… choose a target per strip? use a logical default order that can be easily
adjusted by user."*

**Rationale:** `quantize.md` §4.2 offered three answers and recommended an explicit sync-master
(B). The user's framing adds two facts that change it. First, the common case is **two active
decks**, where any explicit nomination is a setup step for a question with one obvious answer —
so the default must be automatic. Second, **loopers launch too**, which §4.2 did not consider:
a tape strip's ⟳/▸ wants the same grid a deck's does, and a looper spawned mid-set must not
require a configuration step before it can land on the beat. A per-strip field with an `auto`
default is the only shape that is free in the common case and still exact when a looper needs
to lock to something specific. The resolution ORDER is what makes `auto` predictable rather
than clever — the donor's "first audibly-playing deck" is the same instinct, stated.

**Consequences:** a per-strip document field (MAP schema bump) on both element kinds, so it is
a document change and not only a control. Row P11-3c, plus the quantum control itself and the
sync-master badge. The engine ABI beneath it is already done (P11-3b) and stays unchanged —
`sl_deck_request_quantized_launch` already takes `ref_deck` per call, which is exactly what a
per-strip reference resolves to. ⚠️ Tape strips have no `launchArmed` equivalent in the engine
yet; quantized LOOPER launch needs that seam before its control can ship, and it is a row.

## D-SL-REMOTE-01 · 2026-07-31 · `scoopy` is the remote; wizard is the old tree
**Decision:** `origin` points at **github.com/xpertprofessional/scoopy**; the former origin is
renamed `wizard` and kept. `host-hygiene` pushes there. Signed live.
**Rationale:** `origin` still pointed at the wizard repo this tree partly came from, so every
default `git push` and `gh` invocation aimed at the wrong project — `P3-PUSH` never running is
the only reason that never landed anywhere wrong. The user confirmed scoopy is the remote.
**Consequences:** `wizard` stays configured, so the donor-era history remains reachable.

## D-SL-SAVE-01 · 2026-07-31 · ⌘S saves the SESSION, everywhere
**Decision:** `⌘S` saves the **session**; `⇧⌘S` saves the **map**. One meaning for `⌘S` on
every surface — the mapless compose window and the plane behave identically. Signed live,
settling P7-K0b.
**Rationale:** the donor's `⌘S` saves the session (`quickSaveSession`), and the map is the
outer container that changes far less often, so it takes the modified chord. The alternative —
context-sensitive, map on the plane and session in compose — makes one key do two things
depending on which window has focus, which is exactly what stops muscle memory transferring
between the two surfaces B5 exists to make equal.
**Consequences:** the compose window's save UI and the plane's keymap both bind `⌘S` to the
session save. ⚠️ The plane AUTOSAVES the map already (`attachAutosave`), so `⇧⌘S` is a flush +
name-it path rather than the only way a map survives — it must not imply the map is otherwise
unsaved.

## D-SL-UNDO-01 · 2026-07-31 · Topology is undoable; other companion edits are not, and say so
**Decision:** `undoStore` gains ONE new entry kind — **topology** (add / remove track). `bpm`,
`masterVolume` and `loadSample` stay outside undo and are written down as such. Signed live.
**Rationale:** `undoStore` is per-track and pattern-shaped (`UndoEntry` carries a `trackIndex`
and two `GridPatternState`s), so it cannot express a topology or document change at all — this
is a new kind, not a flag. The donor scopes its entries (`pushCompletedUndoEntry(scope:
.topology)`) and brackets `addTrackInternal` in one. Scoping to topology takes the case the
ledger row names — *"an accidental append is the easiest edit to want back"* — without making
every document mutator bracket itself, and without `loadSample` undo having to restore a kit
reference as well as a row.
**Consequences:** row P3.5-E8g-h-b closes for topology and stays open, explicitly, for the
rest. ⌘Z after `setBpm` continues to do nothing and that is now a stated behaviour rather than
an omission.

## D-SL-ECHO-01 · 2026-07-31 · The owner-echo guard gets a release that this stack can fire
**Decision:** close P3.5-E8g-g. The companion emits the equivalent of Swift's `swiftEdit` when
it pushes a document change from a non-grid source, so `GridPanel`'s `adoptNextEcho` escape
actually releases. Signed live.
**Rationale:** the guard drops any `gridPattern/<i>` landing within `OWNER_ECHO_QUIET_MS`
(300 ms) of the panel's own publish, and its ONLY escape fires on an event the merged stack
never emits — the guard came across from the donor and its release did not, the same species as
P7-K7 and P8-P1. Nothing is known to hit it today, but it is a silent-drop path with no owner,
which is the defect class this project keeps paying for.
**Consequences:** the escape needs a trigger the companion can actually raise; the guard itself
stays (it exists to stop the grid re-rendering its own echo, and removing it risks a feedback
loop on every edit).

## D-SL-CHOOSER-01 · 2026-07-31 · The launch chooser remembers, and defaults to it
**Decision:** the PLANE / COMPOSE chooser (D-SL-LAUNCH-01) **pre-selects the last choice**, so
Enter goes where you usually go. It still appears every launch. Signed live.
**Rationale:** the donor skips asking entirely and restores the last face from session metadata
(`AutoSaveManager.isDJMode`). That respects habit but removes the choice; a chooser that
remembers keeps both. Always-asking-neutrally adds a decision to a moment already decided.
**Consequences:** one persisted setting for the last choice. A "don't ask again" path was
considered and NOT taken — it would reintroduce the donor's invisible-restore behaviour behind
a checkbox, and the chooser is the thing the user asked for.

## D-SL-DECKPLUGIN-01 · 2026-07-31 · ScoopyDeck: a plugin entry point, amending ONEHOST
**Decision:** a VST3/AU/Standalone plugin target **ScoopyDeck** (`shell/plugin/`) joins the
tree — a stripped compose face with a single-deck DJ performance flip, tempo-synced to the
DAW host. This AMENDS D-SL-ONEHOST-01 rather than violating it: the plugin is a third entry
point onto the SAME shell libraries (one dispatcher, one webdist, one engine tier), exactly
as `MergedWalk` is the second. What ONEHOST forbids — a second shell implementation — stays
forbidden. User-approved plan: 2026-07-31. Three sub-rulings, all user-confirmed:
  · **No plugin-in-plugin, ever.** ScoopyDeck never compiles `NativePluginHost.mm`; the
    no-op stub answers, `pluginHosting` reads false, and the FX/instrument doors refuse
    honestly. The deck is a MIDI device + sampler; sends route to DAW effects via multi-out.
  · **Watchdog off in-DAW.** `sl_watchdog_set_enabled(e, 0)` at engine create. The seam is
    marked "test seam only"; this entry widens its charter to hosts whose output feeds a
    mixer rather than speakers — a hidden limiter on a plugin output is a mixdown surprise,
    and the DAW's own chain is the protection layer there. The APP keeps it always-on.
  · **Host tempo is a second master source, not a second tempo authority.** The tempo law
    stays in TS (`djSyncLaw`); the plugin's native pump only carries the host's BPM into the
    same per-deck ratio the plane already publishes. `masterTempo`/`sessionBpm` stay refused
    on the param lane.
**Rationale:** the user wants the composing+deck surface inside a DAW with host sync and
multi-out routing. Every load-bearing piece already exists host-agnostic: `sl_render_io` is
processBlock-shaped behind `RenderSink`, the engine emits 26 lanes, the sync axis is deck
scope, and the vendored JUCE is a full checkout with `juce_audio_plugin_client`. A separate
repo would vendor-copy the web/bridge plumbing and drift — the ONEHOST failure one layer up.
**Consequences:** formats VST3+AU+Standalone (code `ScDk`/`Scpy`); 4 mono send buses + main/
deck/cue/4 return-wet pairs; state chunk embeds sample PCM (self-contained projects);
host-transport follow is user-switchable, default ON. Settings/Takes live under
`ScoopyDeck/`, never `WizardMerged/`. `NativePluginHost.mm`'s per-executable rule now has a
third case: this executable deliberately OMITS it.

## D-SL-DECKPLUGIN-02 · 2026-08-01 · ScoopyDeck v2: the four kickoff forks, signed
**Decision:** the four blocking decisions in `docs/merge/DECKPLUGIN-V2-KICKOFF.md`
("Decisions needed", D1–D4) are answered as follows. Signed live 2026-08-01.
  · **D1 — Five output buses: Main + Send 1–4.** Deck, Cue and Return 1–4 are CUT. This
    **amends DECKPLUGIN-01's** "main/deck/cue/4 return-wet pairs" consequence line.
    ⚠️ **Signed first as "Main + Return 1–4" and CORRECTED the same day**, on the user's
    re-confirmation, after measuring the engine: the Return lanes carry the wet output of
    the core's INTERNAL return processors, and this host has none — the legacy internal
    delay was retired (P6-3) and hosted plugins are forbidden outright by DECKPLUGIN-01.
    Four buses of guaranteed silence. What actually leaves the plugin is the SEND lanes;
    the DAW track a send is routed into IS the return, processed there and summed in the
    DAW's mixer. That is what "a return is external via multi-out" means here, and it is
    the same fact `HostServices::externalReturns` reports. Cue duplicated Main; the Deck
    bus read silent by design (per-deck lanes fill only when `djMode && dedicatedOutput`)
    and enabling it **removed the deck from Main**, a routing surprise rather than a tap.
    **Consequence that had no caller anywhere:** the core defaults every return to
    host-plugin mode, so a plugin-less host consumed all four sends into an empty slot and
    the send buses were silent. `sl_return_set_external` is the new ABI door and
    ScoopyDeck flips all four at engine create. The smaller layout is also the leading
    suspect-fix for the Live instantiation failure (kickoff §4), which stays to be
    diagnosed on its own terms.
  · **D2 — Tempo source and transport source are TWO switches.** `CLK HOST/INT` keeps its
    current meaning and governs `followTransport` **only**. A second control picks the
    master-BPM source: host, or the typed master-BPM box. All four combinations are
    reachable and musically real — notably "follow the DAW's play/stop, stretch against my
    own 140", which is the only way to tell TP from TS at all today (§2). Consistent with
    DECKPLUGIN-01's "host tempo is a second master SOURCE, not a second authority": the
    tempo law stays in TS, this switch only chooses which number feeds it.
  · **D3 — ScoopyDeck claims `Space` when the WebView holds OS focus.** Deck transport wins
    over DAW transport once the user has clicked into the plugin; click-out releases. This
    matches the standalone app's muscle memory, which the user ranked above host uniformity.
    **Stated cost, accepted:** hosts that take `Space` before the plugin sees it (Live and
    Logic both do, in some focus states) will silently not deliver it — the claim is
    best-effort, not guaranteed, and must never be load-bearing for stopping audio. A
    visible deck-transport control remains the reliable path. Requires the OS-focus work in
    §8 (`setWantsKeyboardFocus`/`grabKeyboardFocus`) to be real at all.
  · **D4 — One instance driving N decks.** NOT a cross-instance registry. The engine already
    resolves `sl_deck_request_quantized_launch(deck, refDeck, steps)` **inside the audio
    callback**, sample-accurately, and multi-out already gives each deck a bus — so joint
    launching on a cycle boundary works today in one instance and never quite will across
    instances. §9 is therefore a multi-deck UI/routing job, not IPC. **Bitwig's per-plugin
    process sandbox becomes irrelevant** (it would have broken a registry outright), as does
    the VST3-instance-cannot-see-an-AU-instance limit.
**Rationale:** each fork was presented with its cost; these are the user's answers. D1 and
D4 both shrink surface — fewer buses, no registry — and both remove a mechanism that looked
like a feature but was silent or impossible in practice. D2 and D3 both spend a little
complexity (one extra control, one focus dependency) to buy back behaviour the user actually
performs with.
**Consequences:** kickoff §4 loses its bus-count question and keeps only the Live diagnosis;
§2 gains a second switch beside the master-BPM box; §8's OS-focus item is promoted from
"nice" to **prerequisite** for D3; §9 is rescoped from registry to multi-deck.

## D-SL-DECKPLUGIN-03 · 2026-08-01 · Launch quantize across instances, on the HOST's clock
**Decision:** ScoopyDeck quantizes deck launches against the **DAW's timeline**, and that is
what makes joint launching work across separate plugin instances. Signed live 2026-08-01,
answering *"how can we make quantizing decks possible across vst instances? quantize deck
launch in dj mode by cycle or fixed value."* Three parts, all user-chosen:
  · **The reference is the host's `ppqPosition`.** Every instance of every format already
    receives the SAME ppq, sampled by the same audio thread on the same block boundaries. Two
    instances that independently resolve "launch at ppq X" therefore land together with **no
    IPC, no shared memory and no registry** — the same way hardware locks to MIDI clock.
    Half of this already exists: `hostAlignedStartStep()` derives the deck's entry step purely
    from ppq. ⚠️ This does NOT contradict **D4** (D-SL-DECKPLUGIN-02), and the distinction is
    the whole point: D4 rejected instances OBSERVING EACH OTHER's state. This is instances
    independently agreeing on an EXTERNAL clock, which has none of the failure modes D4 named.
  · **Two quantum shapes, one model.** A FIXED length (beats, 1/2/4/8 bars) and MY CYCLE (the
    deck's own LCM length) resolve identically: the boundary is the next multiple of that
    length on the host grid. Anchoring the cycle to the host rather than to when you pressed
    play is what makes two decks of equal cycle length phase-lock for free, and what keeps
    unequal ones landing on shared boundaries.
  · **AMENDING D4: a deck may NAME another instance's cycle.** This is the one case the host
    clock cannot answer alone — B must know A's cycle length and phase anchor. A small
    process-wide lock-free record carries exactly that (`cycle length ppq · anchor ppq ·
    playing · a name`), which is a fraction of the registry D4 rejected and exists for one
    question rather than as a general mirror. **Stated limits, accepted:** it is PER PROCESS,
    so Bitwig's per-plugin sandbox and a VST3/AU mix both see nothing — a named reference that
    is not in this process must **fall back to the host grid and SAY so**, never wait forever.
**Precision:** launches resolve in `processBlock`, sample-exact — not on the 40 Hz message
pump, which lands up to 25 ms late and flams a downbeat. The core already proves the shape:
`requestQuantizedLaunch` does the expensive world republish AHEAD on the message thread
(`active + launchArmed + startStep`), arms with a single atomic, and resolves the boundary
inside `render()`. A host-grid launch is that same door with a boundary the processor computes
from ppq, so it needs an engine seam that takes an absolute engine FRAME rather than a
reference deck.
**Rationale:** the user asked for cross-instance quantize after D4 had ruled out the registry,
and the honest answer is that joint launching never needed one — it needed a shared clock,
which a DAW already is. Choosing sample-exact over block-accurate is the user's call and the
right one for the stated use (dropping two decks together); ~10 ms of flam is audible on a
tight downbeat.
**Consequences:** kickoff §9 is rewritten from "multi-deck in one instance" to this. New work:
a `sl_deck_request_launch_at_frame`-shaped ABI seam + its core half, the ppq→frame resolver on
the processor's audio thread, the cross-instance record, and a launch-quantum control on the
deck face (D-SL-QUANTUM-01 already settled that the REFERENCE is per strip with an `auto`
default — this supplies the plugin's answer for what `auto` resolves to: the host grid).

## D-SL-DECKPLUGIN-04 · 2026-08-01 · Host automation replaces the modulation system
**Decision:** ScoopyDeck exposes **131 host-automatable parameters** and the donor's M1–M4
modulation bank is **not ported**. The DAW's LFOs and automation lanes become the modulation
sources; the plugin exposes the TARGETS. User-approved 2026-08-01, four forks answered:
  · **Scope — per-track AND deck.** 16 tracks × 8 targets (pitch, volume, pan, tone, sends
    1–4) + deck transpose/texture + master level. 16 is the web tier's `MAX_TRACKS`; a fresh
    session ships 8, and the upper lanes sit inert until a session that deep arrives, because
    a plugin's parameter list is built at load and cannot wait to see a document.
  · **Semantics — ADDITIVE OFFSETS, neutral at 0** (master: 0 dB). This is the ruling that
    makes the rest work. The web UI keeps owning every base value and the host owns only its
    contribution, so there is no two-writer arbitration to get wrong and no feedback loop to
    guard — and it is the same shape the donor's bank used (additive semitones on pitch,
    additive tone units on the filter), so this is a change of SOURCE, not of meaning. An
    absolute binding was rejected: it would have made every UI edit a host notification and
    every bound control a second writer.
  · **Deck `rate` and all tempo params stay OUT.** `masterTempo`/`sessionBpm` were already
    refused on the param lane (DECKPLUGIN-01) and `syncRatio`/`tempoMode`/`rate` are
    republish-class and would fight `HostSync::pump`'s one-tempo-authority rule. Also
    excluded: every boolean/enum/structural param (mute, reverse, loop region, chop, locators
    — commands, not modulation), the per-step array lanes (document data), FX slots (they
    expose no continuous params at all), route gains (dynamic id space, cannot be a fixed
    layout) and the crossfader (does not exist in this engine build).
  · **The layout is FROZEN once released, and append-only.** A DAW addresses automation by
    index (AU) and id (VST3), so a reorder silently re-points a user's existing curves at the
    wrong control. Ids are deck-qualified (`d0.t03.pitch`) though only deck 0 is automatable,
    so D-SL-DECKPLUGIN-02 · D4's N-decks-in-one-instance appends rather than breaks. The
    target table is spelled out in `HostParams.cpp` rather than enumerated from the ABI,
    precisely so a target appended to the engine cannot re-shape a shipped plugin's list.
**Rationale:** 48 of 86 protocol commands are answered by nobody and `modChannel` is one of
them; the bank was parked (NAV-SHORTCUTS PARK-A). Porting it meant rebuilding four channel
types, a 28-op protocol command, an arm-to-map routing UX and its persistence. Host automation
delivers the same destinations through a source every DAW user already owns, and the engine
turned out to have the seam for it: the core's per-track base-ramp composition already glides
over 4 ms and already reaches ringing voices, so an offset is one added term rather than five
new injection sites.
**Stated costs, accepted — what host automation CANNOT replace:** the donor's LFO was
grid-locked and re-anchored to musical step 0, with an `lcmMode` that tied its period to the
pattern LCM (DAW automation is timeline-locked, so phrase alignment is lost); `.envelope`
channels were triggered by another track's step pattern (no host analogue at all); `freeRate`
modulation ran at AUDIO rate for FM/vibrato (host automation is block-rate); and four sources
summed into one target (a DAW gives one lane per parameter). Anyone who wants those back is
asking for an in-plugin modulator, not for this.
**Consequences:** a new RT-safe ABI family — `sl_track_mod_*`, `sl_deck_mod_*`,
`sl_master_set_mod` — which is **the one parameter family an audio thread may write** (plain
relaxed atomics, no republish); `processBlock`'s thread law is amended to permit exactly it,
and the push is per block because a 6 Hz LFO resampled at the 40 Hz pump is a staircase. Core
edits landed in `ScoopyLoops/NativeAudioEngineCore.{hpp,cpp}` — permitted: `engine.lock.json`
pins only `vendor/scoopy/engine/*` and ThirdParty, and its `_doc` says the core's writable home
is this tree (the "forbidden to edit" comment atop `sl_engine.cpp` was stale and is corrected).
A per-deck nonzero-lane counter skips the mechanism whole so an un-automated render stays
bit-identical, which the DSP characterization gates depend on. State chunk goes **v2 → v3**
(sparse map of non-default offsets); the bump is deliberate so an older build REFUSES a v3
chunk rather than loading it with the offsets silently dropped and then overwriting the user's
project on the next save. No web-tier change and no new protocol command: the surface is the
host's, not the page's.

## D-SL-STUDIO-01 · 2026-08-02 · Scoopy Studio is the product; the plane is frozen

**Decision:** The standalone app becomes **Scoopy Studio** — the original ScoopyLoops
**compose view, expanded**, with no DJ mode and therefore **one engine, not three decks**.
Studio is the only door: the PLANE/COMPOSE launch chooser is removed. Specifically it
carries the full expanded compose view (all shortcuts, all controls), plugin instruments,
full transport plus a master tempo applying TS/TP over session BPM, the four FX plugin
sends with output control on each, a main output with a stereo control — or two level
controls when output-1/2 mode is on — capture of the stereo sum, and an optional
**Scoopy Tape** bottom row that is both a looper and an input recorder able to push what
it captured into the session. Studio additionally **organizes the session folders** the
whole line plays from, carries **full MIDI output** as the original does, and **owns
appearance for every Scoopy app**. **Performance moves to the ScoopyDeck VST.**

**The plane surface is FROZEN, not deleted** — `PlanePanel` · `Plane` · `Strip` ·
`Matrix` · `Cables` · `Inspector` · `Library` and the map document keep compiling, keep
their tests green, and stay reachable at `?panel=plane`. They receive no further work.
This is reversible by design; `web/src/plane/` **cannot** be deleted in any case, because
it also holds the compose window, both plugin faces and the `plane.css` all four import.

**Three laws follow, and they are the point of this entry:**

· **L1 — the component law.** A **face** is a layout; a **block** is a component.
  **Faces compose blocks; a face never rebuilds a block.** Product difference lives in
  exactly three places: which blocks a face mounts, what `getCapabilities` answers, and
  `viewDensity`. The browser companion is a first-class face under this law, not an
  afterthought. Enforced by a new gate, `faces:check`.

· **L2 — one library, one preset home.** Sessions, samples and takes belong to the
  person, not to which face of scoopy opened them (`PluginBackend.cpp:17-32` already
  says so and already shares the library). Studio is the only app that *organizes* them;
  ScoopyDeck, ScoopyTape and the companion consume the same library. Preset state gets
  one ruling instead of the three homes that exist today.

· **L3 — appearance is published, not compiled.** One resolved token blob on disk,
  written by Studio, read at startup and watched by every Scoopy product.

**Rationale:** The merge has been building two products on one surface, and the ledger
recorded it: ~50 of ~81 open rows were plane / DJ / map-performance / routing work, while
whole compose-view features the original ships — instruments, MIDI out, output routing —
were unbuilt. Meanwhile the plugin line shipped ~20 commits with **no ledger rows at
all**. Choosing Studio collapses the surface count and lets the rows that remain be the
ones that make the standalone app equal to the original.

The single-engine ruling is what makes it cheap rather than a rewrite. `GridSource`
already separates data source from view density, and the merged engine writes
`djTrackStepD*T*` every block while **never** writing the compose lanes `trackStep0..15`
— so a compose-density mount reads a frozen playhead today. With one engine, deck 0 *is*
the session, so Studio mounts `djSource(0)` at compose density: the same mount ScoopyDeck
already proves, at a different density. The two products stop being two implementations.

**Consequences:**
· `D-SL-CHOOSER-01` and `D-SL-LAUNCH-01` are **superseded** — there is no chooser and no
  PLANE door to remember. `launchFaceOverride()` survives, because `MergedWalk` needs it
  and it is how the frozen plane stays reachable.
· `D-SL-MAPPERF-01` (the map holds the performance) is **dormant, not revoked**: it
  governs a surface that no longer receives work.
· `PARALLEL-PROTOCOL.md` is superseded and the three lane worktrees are removed; its §0
  (work by donor binding) survives and the Studio steps inherit it. `P3-LEDGER.md` is
  re-scoped from queue to row detail.
· The CMake target keeps the name `WizardMerged` for now — the product name changes, the
  build identifier does not, because 124 commits of docs and gate output name it. A
  target rename is a deliberate all-artifacts increment, per `D-WZ-NAME-01`'s precedent.
· A new gate, `faces:check`, joins the ten drift gates.
· Three things this entry does NOT settle, and which must be signed separately: the
  preset-home ruling under L2; whether the JUCE token header may be edited in
  `apps/scoopyloops/PluginCommon/` or must move to `xpert/shared/` first (L3); and
  whether the Chrome-extension bridge follows the DJ deck into freeze.

## D-SL-RENAME-01 · 2026-08-02 · Scoopy Studio, all the way down — and the library moves with it

**Decision:** The full rename, not a display name. CMake target `WizardMerged` →
**`ScoopyStudio`**; product name **"Scoopy Studio"**; bundle id `com.wizard.merged` →
`com.scoopyloops.scoopystudio`; app data `~/Library/Application Support/WizardMerged/` →
`~/Library/Application Support/Scoopy/`.

⚠️ **THE APP-DATA MOVE IS A MIGRATION, AND IT IS THE WHOLE RISK.** That directory is not
preferences. `PluginBackend.cpp:17-32` derives the **shared session library** from it
(`<data>/Takes/../Library`), deliberately, so the app and both plugins read one library —
*"sessions, samples and takes belong to the PERSON, not to which face of scoopy they
opened."* And ScoopyDeck's state chunk stores `sessionName` — a **reference by name into
that library**. So a DAW project saved before the rename asks for a session by name after
it, and if the library did not come along, `session ▾` lists nothing and every saved
project comes back empty. The failure is silent, delayed, and lands in someone's set.

**Therefore the rename ships with all three of these or it does not ship:**
1. **Move on first run** — old directory → new, once, before anything reads either.
2. **An old-path fallback** — if the new path is absent and the old one exists, read the
   old one. A migration that fails must degrade to "still works", never to "empty".
3. **A test** that a library written at the old path is found after the rename. Pulsar
   already paid for this lesson in the same `Application Support` territory
   (`Snapshots.cpp:258-265`, and its first-run fix for JUCE's `userApplicationDataDirectory`
   returning `~/Library`, one level too high) — read it before writing this.

**ORDERING:** the rename lands **before S7**, which makes the sessions folder
user-settable. Migrating a path and then making that path configurable in the other order
means doing the migration twice, against a moving target.

**Rationale:** the window said the wizard-era name while every doc, decision and gate said
Scoopy Studio. `D-WZ-NAME-01` set the precedent that a rebrand is *"a deliberate, gated,
all-artifacts increment, not a casual edit"* — this is that increment, taken on purpose.

**Consequences:** `~/Library/Application Support/Scoopy/` becomes the line-wide root, which
is also where `D-SL-THEME-01` publishes `theme.json` — one directory for the whole product
line rather than one per binary. Docs, gate output and ~130 commits' worth of prose name
`WizardMerged`; they are not rewritten, and this entry is what explains the mismatch.

## D-SL-PRESET-01 · 2026-08-02 · The session owns instruments; the machine owns its bank

**Decision:** One home per kind of preset state, replacing the three that exist today.

· **Instruments live in the SESSION.** `instrumentPluginIdentifier` +
  `instrumentPluginStateBase64` + `instrumentPluginRef` on the track, as the donor has it
  (`Track.swift:405-418`). A session is the unit that travels, and a track that sounds
  through a plugin is not the same track without it.
· **`PortablePluginRef` comes across with it** — `resolveInstrumentIdentifier`'s ladder
  (`BeatSequencer.swift:19809`): exact id → this machine's format hint → same
  manufacturer+name in any format → **nil = inert but PRESERVED**. An unresolvable plugin
  must never be dropped from the document; a session that forgets is worse than one that
  cannot play.
· **Machine-scoped state uses the SHARED BANK, and the bank wins.** Pulsar's shape
  (`README.md:81-90`, pinned by `plugin_state_test.cpp`): the bank is authoritative, a
  project carries a copy, restore MERGES and the project fills only the slots the bank
  lacks. Its reason is exact — a project embeds the bank as of the save, so letting the
  project win makes opening a month-old project roll every slot back.
· **The permanent caveat is recorded, not fixed** (verbatim from
  `PortablePluginIdentityTests.swift`): crossing formats keeps the BINDING and may lose the
  plugin's internal preset. That is a cross-platform fact, not a defect.

⚠️ **DERIVED, AND FLAGGED AS SUCH: the FX-return presets have to move.** They work today
(schema v96 + P6-5b) and they live in the **`.scoopyMap`** — which `D-SL-STUDIO-01` just
froze. Studio has no map, so as things stand it has nowhere to keep an FX chain. Reading
this ruling with the donor's own split (FX returns were app-level in `AudioDeviceManager`,
never in the session), FX-return plugin + state becomes **machine-scoped: the shared bank,
bank-wins, with a project copy** — a "studio setup" that follows the machine rather than
each song. This is the reading S4/S6 will build unless corrected; it is called out here
because it is a consequence of the ruling rather than part of the question asked.

## D-SL-THEME-01 · 2026-08-02 · The JUCE token header moves to `shared/`, and is loaded, not compiled

**Decision:** `PluginCommon/ScoopyTokens.h` moves to **`xpert/shared/design/`** and vendors
back into each consumer through `shared.lock.json` + `shared:sync`, exactly as
`tokens.core.ts` already does. It stops being `constexpr`-only: it becomes a **runtime
loader** for the token blob `D-SL-STUDIO-01`'s L3 publishes, with today's compiled values as
the fallback, so a missing or malformed file degrades to the current look rather than a
blank rectangle — the discipline Pulsar's fallback panel already follows.

**Rationale:** the palette is restated **three times in C++ today** —
`apps/scoopyloops/PluginCommon/ScoopyTokens.h`, `scoopy-pulsar`'s `FallbackPanel.h`, and a
bare literal in its `PluginEditor.cpp:317` — and they have already drifted: the header still
carries `accent 0xffbfbfbf` "placeholder" against the shared core's `#ef8b9a`. Its own rule
says it is *"the single edit point… enforced by review"*, and review did not hold.
`D-WZ-SHARED-01`'s rule of three is satisfied by the drift itself.

**Consequences:** `shared:check` gains a hash gate over a file that has never had one, and
the `#bfbfbf` → `#ef8b9a` fix ships with the move. The blob lands at
`~/Library/Application Support/Scoopy/theme.json` — a **file**, never `UserDefaults.standard`,
because a plugin in Logic runs under the host's bundle id and would never see it.

⚠️ **ONE THING THIS DOES NOT AUTHORISE.** Creating `shared/design/ScoopyTokens.h` writes to
`shared/`. **Vendoring it back into `apps/scoopyloops/PluginCommon/` writes to the donor
repo, which `CLAUDE.md` forbids** — moving the file to `shared/` does not dissolve that rule,
it only moves where the source of truth lives. So Trombone and Spectral keep their current
compiled copy until that write is separately authorised or their repo is worked in directly.
Pulsar is in `xpert/plugins/` and is not covered by the rule, so it can adopt immediately.

## D-SL-COMPANION-01 · 2026-08-02 · The extension bridge grows with the companion

**Decision:** `web/src/companion/` (the Chrome-extension bridge) is **live work**, not
frozen with the DJ deck. It grows with the browser companion.

**Rationale:** the companion is a product the user keeps using; the bridge is its control
surface, and the DJ deck's retirement is about the app's surface, not the browser's.

**Consequences:** its capability list is DJ-shaped and will need reshaping —
`transport · tempo · tempoOverride · mainGain · levels · restartAt`, where `restartAt`
exists specifically to schedule dual-window DJ launches (`RESTART_IMMEDIATE_MS = 20`). A
compose-shaped companion wants different verbs, and `BRIDGE_VERSION` is how that change is
made without breaking an installed extension. Note the ceiling this inherits from the WASM
engine and cannot exceed: **no tape, no recording, one deck**, and sends render **dry**
(`returnFx: false`) — deliberately, "a dry host rather than a wrong-sounding one".

## D-SL-SCRATCHGATE-01 · 2026-08-02 · The scratch click is an exception to the 10 ms ramp

**Decision:** A narrow, named exception to `D-WZ-RAMP-01`. **One per-tape gate, ~2 ms
raised-cosine (tunable 1–3 ms), reachable only from the scratch path**, applied inside
`sl_tape.cpp`'s per-sample loops. Nothing else moves: channel level, mute, monitor
assign, route gain, insert bypass and the tape's own `scrubGain` all keep the one 10 ms
constant, and `rampShape` is literally the same function — only the step differs.

**Rationale:** `D-WZ-RAMP-01`'s consequences clause enumerates what it governs — *"solo,
monitor assign, insert bypass"* — and every item is a **state change that should be
inaudible**. A scratch click is the opposite category: it is a **musical event the
listener is meant to hear**. The fader hand is one of the two gesture streams a scratch
is made of (`docs/specs/scratching.md` §1); a technique is *defined* by where its clicks
fall.

The measured numbers make 10 ms not merely suboptimal but non-functional here. Clicks
run **30–70 ms end to end**, so a 10 ms ramp down plus 10 ms up inside a 40 ms click
never reaches silence at all, and a crab's four clicks per stroke smear into a wobble
instead of four events. The control is not "too soft" — it does not produce the
phenomenon.

⚠️ **This entry contradicts a sentence in the decision it excepts, and does so
knowingly.** `D-WZ-RAMP-01`'s rationale says *"5 ms can thump"* on bass-heavy material.
It can, and at 2 ms it will more. **That is the instrument.** A battle crossfader's
travel from silence to full volume measures **2–3 mm out of a 45 mm run** — it is a gate
with a hair trigger, not a fader, and DJs select the sharpest cut a mixer offers. The
transient at the edge of the gate is part of the sound of the technique, which is
precisely why the general rule cannot be read onto it.

**Consequences:**

· **It lives in the TAPE, per sample, on BOTH paths** — the scrub path and the ordinary
  playback path. Both, because a transformer is played over a **normally playing loop**,
  not only during a scrub; putting it in one place would ship half the technique table.
  On the playback side it is reached with **`span = 0`** — not a magic value but literally
  what the field says, the record hand moving nothing.
  ⚠️ **Amended on implementation (2026-08-02):** this entry originally named the
  `renderVarispeed` lambda as the site. It is applied as a per-sample pass over that
  lambda's **output** instead, because `renderVarispeed` runs **twice** during a stretch
  transition — a dry leg and a wet leg, with playhead and `smRate` saved and restored
  around it — so advancing the pattern phase inside it would run the gesture at double
  speed for exactly as long as a crossfade lasts. Same stage, same per-sample
  granularity, phase advanced once; the distinction this decision actually rests on
  (the tape's stage, not `mixInto`'s block-hoisted targets) is untouched.
· **Not in `ChannelBank::mixInto`.** Targets there are hoisted once per block, so the
  *decision instant* would sit on the ~10.7 ms block grid however fast the ramp was. The
  ramp shape and the decision instant are two different problems and only the second one
  needs sample accuracy — a distinction worth stating because getting the first right
  while leaving the second on the block grid looks like a fix and is not one.
· **The topology already allows it.** A per-sample gate array exists in the route pour
  (`sl_channel.cpp:608`, `g = sm * extra * (gate != nullptr ? gate[i] : 1.0)` — the
  monitor gate lane), proven RT-safe. It is simply not reachable from the ABI and not
  applied at the tape's own stage.
· **Bounded by construction.** The gate is per-tape and multiplies only that tape's
  output, so it cannot reach the master, another channel, or any path a scratch is not
  running on. A tape with no scratch active holds the gate at 1.0 and is bit-identical to
  today, which the DSP characterization fixtures depend on.
· It also, incidentally, cleans up something nobody authored: the reader **parks on a DC
  pedestal** at each reversal rather than on silence (measured 0.72–0.87 in
  `sl_tape_scratch_test`). A closed-fader technique cuts exactly there, so the gate
  zeroes it — and since 70–90% of reversals are silenced in real playing, idiomatic use
  masks the pedestal for free.
