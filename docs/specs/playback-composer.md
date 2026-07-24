# Playback composer spec (P4 domain)

*Governs P4-02..P4-09. Laws: CONCEPT §2 (C-1 no timeline · C-3 instant turnaround)
and §4 (spatial playback falls out of the bus map). Signed inputs: D-WZ-DSP-01,
D-WZ-RAMP-01, D-WZ-DECKSRC-01. Two P4 values are PROVISIONAL pending user sign-off —
see §7 and `docs/MORNING-DECISIONS.md`.*

This is the phase where Wizard becomes an instrument rather than a mixer: record a
phrase, have it loop the instant you stop (already true — Law C-3, P3), then **bend it
live** (varispeed/reverse), **stack more takes** on other decks, **resample the whole mix
back into a deck** (LoopbackBus), and **spread it across a multi-channel output layout**.

## 1. Signed varispeed (the deck's live instrument control)

One **signed rate** per deck: `rate ∈ [−16, −1/16] ∪ [1/16, 16]`, negative = reverse.
Pitch and speed are coupled (tape behavior — parlante D-05's precedent, and CONCEPT's
explicit "varispeed and reverse"). `rate = 1.0` is the identity path and MUST be
bit-exact: a deck at unity reads its buffer directly with no resampler in the path.

**Engine model.** The deck's playhead becomes a fractional position advanced by `rate`
each frame. Reading at a fractional position requires interpolation:

- The playhead is `double`; `|rate| == 1.0` short-circuits to a direct integer read
  (bit-exact identity, no filter, no drift).
- Otherwise the deck reads through a **per-deck streaming resampler** driven by the
  signed rate. Reverse is not a special case in the reader: the playhead simply advances
  negatively and the same interpolation applies (this is the unification CONCEPT asks for
  — reverse is "a first-class mode everywhere", not a separate code path).
- Rate changes are **smoothed** (D-WZ-RAMP-01's one-pole, ~10 ms) so a knob sweep is a
  tape glide, not a zipper. The smoothed rate is what the reader consumes.
- Loop wrap under varispeed: the region is half-open `[start, end)`; forward wrap goes
  `end → start`, reverse wrap goes `start → end`. Both are gapless, sample-exact at
  `|rate| == 1`, and phase-continuous otherwise.

**Quality (PROVISIONAL — morning decision #5).** GRM Player's speed-tracking resample
("the slower a sound is played, the more accurately it is resampled", so 1/100 and 1/1000
speeds stay clean — `design-notes-grm-player.md`) is the bar. Proposal: libsamplerate
streaming at `SINC_MEDIUM` for live rate changes, escalating to `SINC_BEST` when the rate
is stationary for > ~250 ms (the common case: you set a speed and leave it). Identity
bypasses both.

## 2. LoopbackBus — the one legal cycle

Wizard's differentiator needs a deck to be able to record **Wizard's own output**
(record-own-output, resample the mix). That is a cycle, which the P1 graph forbids
outright (routing.md §5). The LoopbackBus is the single legal cycle edge:

- A patch may route a bus back into a channel **only through the LoopbackBus**, which
  reads the **previous block** of that bus — the classic `send~`/`receive~` one-block
  delay. Deliberate feedback becomes well-defined; the render schedule stays acyclic
  **by construction**, so no cycle detection runs on the audio thread.
- Cost: exactly one block of latency on the loopback path (at 512/48k, 10.7 ms). That is
  the honest price and it is stated in the UI, not hidden.
- The routing matrix gains **↺ cells**: a loopback edge is never created implicitly — the
  user asks for it explicitly, and `patchValidation` still refuses any cycle that does
  *not* pass through the LoopbackBus.

## 3. Feedback watchdog — the safety no graph check can provide

An internal cycle is now structurally impossible except through the LoopbackBus. An
**external** loop is undetectable by construction (out → another app → "Wizard Out" →
back in), and users *will* build one by accident (feasibility §7).

- The watchdog measures sustained bus level; past the threshold it **engages a hard
  limiter** and raises `feedbackAlarm` (already a HotFrame scalar since P0, already wired
  to the UI lamp since P1-08 — this phase makes it fire).
- **Threshold (PROVISIONAL — morning decision #6).** ARCHITECTURE §2 proposes
  **> +6 dBFS RMS sustained over 250 ms**. Not peak: a single transient must never trip
  it. The limiter is a hard ceiling engaged with a D-WZ-RAMP-01 ramp (never a click), and
  releases only after the level has been below the threshold for a hold period.
- The own-PID exclusion in system-mix taps (P2) is the *other* half of this guard; both
  are needed.

## 4. Output buses & spatial playback

Up to **8 user output buses** mapped to device channels. CONCEPT §4's claim — quad / 5.1 /
octophonic **falls out of the bus map for free** — is realized here: a "spatial layout" is
nothing but an output map with more than two entries, so no separate spatial engine
exists. Per-channel output assign chooses a bus; the bus map chooses device channels.
Refusal is honest: a layout wider than the device's output count is shown as unmapped
(routing.md §4's monitor precedent), never silently folded.

## 5. Deck rack completion

Add/remove decks 1–8 (schema already caps at 8), waveform + loop brace per deck,
`align to deck N` acting on the C-2 stamp delta (P3-07's math, now with a UI verb), and
one-click take→deck (already shipped in P3-09).

## 6. Strip mode (its own increment)

The compact horizontal layout (CONCEPT §6) — decks collapse to rec/loop/one-shot + mini
waveform + varispeed thumb; channels to mini-faders + meters. The shell contributes only
window min/max constraints + always-on-top (shell law). **Sequencing note:** if
PD-CANVAS (morning decision #1 — one unified freely-arranged item) is adopted, strip mode
becomes "zoom out" on the canvas rather than a separate layout, and this row should be
re-scoped rather than built as specified. Do not build it before that decision.

## 7. Provisional values (parked, do not block)

| # | Value | Proposal | Where |
|---|---|---|---|
| 5 | Live varispeed converter tier | SINC_MEDIUM live, SINC_BEST when stationary >250 ms, identity bypass | §1 |
| 6 | Watchdog threshold | > +6 dBFS RMS sustained 250 ms, ramped limiter, hold before release | §3 |

Both are audio-quality choices: they go to the user (`MORNING-DECISIONS.md`) before the
increment that depends on them is built. Everything else in P4 builds now.

## 8. Fixtures

1. `varispeed_test` — identity is **bit-exact** (no resampler in the path at rate 1.0);
   ±rate reads the buffer at the right positions; reverse wrap and forward wrap are both
   gapless; a rate sweep produces no discontinuity beyond the ramp bound.
2. `loopback_test` — a bus routed back into a channel yields exactly the **previous
   block** (one-block delay, not zero, not two); the schedule stays acyclic; a
   non-loopback cycle is still refused at edit time.
3. `watchdog_test` — a feedback ramp engages the limiter and raises `feedbackAlarm`
   within budget; a single transient does NOT trip it; release happens only after the
   hold period.
4. `output_map_test` — 8 buses map to device channels; a layout wider than the device is
   reported unmapped rather than folded.
