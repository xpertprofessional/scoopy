# Routing & mixer spec (P1 domain — same-clock slice)

*Governs P1-02..P1-09. Signed math: D-WZ-PAN-01 · D-WZ-FADER-01 · D-WZ-RAMP-01 ·
D-WZ-DSP-01 · D-WZ-DECKSRC-01 (docs/DECISIONS.md). Deviations from this spec are
spec edits first, build second.*

## 1. Scope of the P1 slice

Everything runs on the **device clock** (D-WZ-RATE-01): duplex hardware inputs and deck
buffers only. No source rings, no ASRC, no taps — those are P2. No record path — P3.
No sends/FX/inserts — P6 (fields are *reserved* in the schema now so adding them is an
increment, not a migration).

## 2. The Channel strip (the universal object)

A Channel binds exactly one Source and carries, in P1:

| Param | Range / unit | Engine behavior |
|---|---|---|
| `gain` | fader position 0..1 → dB via §3 curve | one-pole smoothed (§4), applied in float64 |
| `pan` | −1..+1 | −3 dB constant-power (§3), smoothed |
| `mute` | bool | 10 ms raised-cosine ramp (§4) — never a step |
| `solo` | bool | in-place solo: non-soloed strips ramp to silence on MAIN only (monitor unaffected); solo set is world state, ramp is engine state |
| `outputAssign` | bus id | P1: `main` (always) + optional `monitor` |

Reserved (schema fields exist, engine ignores until their phase): `send1..4` amounts +
pre/post flags (P6), `recordArm` (P3), `monitorSwitch` per-deck monitoring (P3),
4 insert slots (P6).

**Source kinds in P1:** `deviceInput` (duplex input channel pair or mono pick),
`deck`, `none` (strip placeholder — silent, preserved). The full kind set
(`appTap`, `systemMixExcept`, `virtualDeviceInput`, `busTap`) arrives P2/P4/P5;
the schema enum carries all kinds from v3 so Patches stay forward-readable
(preserve-don't-drop).

## 3. Signed math (normative)

**Pan (D-WZ-PAN-01):** `θ = (pan + 1) · π/4`; `gainL = cos θ`, `gainR = sin θ`.
Center = −3.0103 dB per side. Fixtures pin the table at pan ∈
{−1, −0.5, 0, +0.5, +1} to 1e-12.

**Fader (D-WZ-FADER-01):** position p ∈ [0,1] → dB, parlante mapping:
- p = 0 → −∞ (true zero, no ramp-in from denormals)
- p ∈ (0, 1]: piecewise-smooth audio taper with **unity (0 dB) at p = 0.75** and
  **+6 dB at p = 1.0**; reference points (pinned by fixture): 0.05 → −60 dB,
  0.25 → −24 dB, 0.50 → −8 dB, 0.75 → 0 dB, 1.00 → +6 dB. The curve is the
  monotone cubic through these points in dB-space (one shared TS+C++ table;
  the web↔engine pin fixture asserts both sides evaluate identically to 1e-9).

**Ramps (D-WZ-RAMP-01):** one constant `kRampMs = 10`.
- Mute/unmute (and any boolean audio switch): raised-cosine gain ramp,
  `g(t) = ½(1 + cos(πt/T))` over T = 10 ms.
- Continuous params (gain, pan): one-pole smoother `y += α(x − y)` with α set for
  ~10 ms settling (α = 1 − exp(−1/(0.01·fs))). Fixture bound: consecutive-sample
  gain delta never exceeds the raised-cosine max slope for the same T.

**Summing (D-WZ-DSP-01):** strip products and bus accumulation in `double`;
buffers stay `float`. One conversion to float at the bus output.

## 4. Buses

P1 buses: `main` (stereo) and `monitor` (stereo cue). Reserved: `fx1..fx4` returns
(P6, themselves Channels of kind `busTap`) and up to 8 user output buses (P4 spatial).
Output map v0: `main` → device channels 1/2; `monitor` → device channels 3/4 **when the
device has ≥4 outputs**, else monitor is unmapped (UI shows why — never silently
re-routed to 1/2).

## 5. Graph rule

Render order is a precomputed acyclic schedule over channels → buses. **P1 has no legal
cycles at all** (the LoopbackBus and its one-block-delay edge arrive in P4); the routing
matrix refuses any edit that would create a cycle, at edit time, in TS (the document
owner) — the engine never sees an illegal world.

## 6. Same-clock input rule (P1-06)

Duplex input channels are delivered in the same callback that renders output
(D-WZ-RATE-01). The host hands the input pointers to the engine render call for the same
block (`wz_engine_render_io` extends render with const input buses); strips bound to
`deviceInput` read directly from those buffers. **No buffering, no rings, no latency
added** — input-to-output latency in P1 is exactly the device round-trip.

## 7. Deck v0 (P1-07, playback only)

States: `idle → looping | oneShot` via `wz_deck_trigger` (record states are P3; the enum
carries them from v3). Loop range = half-open [start, end), seqlock-published. Load path
per D-WZ-DECKSRC-01: decode (host, JUCE) → off-audio-thread SINC_BEST resample to engine
rate → `wz_deck_load` swaps the buffer in with the render callback detached
(whileSuspended; RCU hot-swap is a later refinement). Varispeed field exists in the
schema (signed rate, default 1.0) but the engine plays at 1.0 only until P4.

## 8. HotFrame layout (v3)

Scalars (unchanged order): `schemaVersion, engineTimeSamples, cpuLoad, feedbackAlarm,
mainPeakL/R, monitorPeakL/R`. Then **per-channel blocks** behind a named base offset,
stride codegen'd: `peakL, peakR, rmsL, rmsR, srcRingFill, srcDriftPpm, srcDropouts`
(the last three always present, zero until P2 — reserving them now keeps the stride
stable and makes drift *visible the day taps land*). Then **per-deck blocks**:
`state, playhead, loopStart, loopEnd, rate, recordLengthSamples, recordDrainFill`
(record fields zero until P3). Block counts ride WorldPublish; the UI derives offsets
from the codegen'd map, never hand-computed.

## 9. Meters

Per-strip peak + RMS computed in the engine (float64), published per block, drawn by the
HotSurfaceRegistry canvas loop (one rAF, ≤2 ms/frame budget — parlante gate). The P0
store-routed main-peak path is deleted with the boot tone in P1-04; **no meter data
flows through React state from P1 on.**

## 10. Fixtures (P1-05, ctest + vitest twins)

1. Pan table exact to 1e-12 at the 5 reference pans.
2. Fader curve web↔engine pin: both implementations evaluate the reference points and
   200 interpolated positions identically to 1e-9.
3. Ramp slope bound: no consecutive-sample gain delta exceeds the 10 ms raised-cosine
   max slope, across mute toggles mid-block and fader jumps.
4. Two-strip sum vs a double-precision reference implementation: bit-exact.
5. NaN/denormal guard: a NaN input sample never propagates past its strip; denormal
   feed decays to true zero.
6. Solo ramp: soloing strip A ramps strip B to silence on main while B's monitor feed
   is untouched.
