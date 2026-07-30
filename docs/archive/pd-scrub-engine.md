# PD-SCRUB-ENGINE — turntable scrubbing in the deck reader

*Engine design for position-driven scrubbing (P4 domain, follows `playback-composer.md` §1).
Signed inputs: D-WZ-RAMP-01 (10 ms), D-WZ-DSP-01 (f32 buffers / f64 sum), D-WZ-VARISPEED-01
(adaptive SINC tier), D-WZ-DECKSRC-01. Reference studied in depth: Parlante V101
`AudioWaveformEditor/Services/AudioEngineScrubbing.swift` (the "tape scrub" renderer) —
every claim about it below is quoted from that source, and where the reference does NOT
do something, this document says so rather than inventing it.*

---

## 0. Honest statement of the current state

`wz_deck_seek` (engine/src/wz_engine.cpp:468) posts a frame; the render thread consumes it
at block top (wz_engine.cpp:820-825) and **assigns** it to `d.playhead`:

```cpp
const int64_t seek = d.pendingSeek.exchange(-1, std::memory_order_acq_rel);
if (seek >= 0) {
    const double target = static_cast<double>(seek);
    d.playhead = target < static_cast<double>(dFrames)
                     ? target
                     : static_cast<double>(dFrames > 0 ? dFrames - 1 : 0);
}
```

That is a **jump**. Three consequences:

1. It is a hard waveform discontinuity — a click, bounded only by how similar the two
   sample values happen to be. Nothing in the deck path ramps around it.
2. It does not drag the audio. The pitch you hear during a drag is `d.rate`, unchanged;
   the position teleports underneath it. A turntable does the opposite.
3. Its ABI comment claims "Clamped to the buffer, NOT to the loop region", but the render
   pass's loop wrap fires on the same block and folds it back in — which
   `engine/tools/deck_seek_test.cpp:75-86` pins as the real behaviour (seek 3500 with
   region [0,1000) lands at 500). The comment and the fixture disagree; the fixture is right.

Everything below is the design for real scrubbing. `wz_deck_seek` survives unchanged in
**semantics** (it is still a jump-to-frame, still folds into the region) and gains only a
declick — see §7.3.

---

## 1. What the reference actually does (verified, quoted)

### 1.1 Topology

Turntable mode (`UserPreferences.shared.enableTrackpadScrubbingTurntableMode`) runs a
**dedicated `AVAudioSourceNode`** wired straight to the main mixer
(`ensureTapeScrubRendererConnected`, AudioEngineScrubbing.swift:40-70). The normal
`playerNode` is **stopped** for the duration:

```swift
wasPlayingBeforeScrub = playerNode.isPlaying
if wasPlayingBeforeScrub { ...; playerNode.stop(); ... }
playerNode.reset()
```

So: **audio keeps playing while scrubbing, but from a different source node.** Normal
playback is suspended, not rate-modulated.

The source is a pre-loaded PCM window: the whole file for small files, else a rolling
10-second window reloaded when the target nears within
`max(4096, sampleRate*0.25)` frames of an edge (`loadAndUpdateScrubWindow`, line 598;
reload margin at line 680). Wizard does not need this at all — the deck buffer is already
resident, chunked and RT-readable.

### 1.2 What the drag maps to — BOTH position and rate, independently

The view computes a pixel velocity (WaveformView.swift:1621-1624):

```swift
let deltaTime = currentTimestamp - (lastDragTimestampForVelocity ?? currentTimestamp)
let deltaX = currentLocation.x - (lastDragLocationForVelocity ?? currentLocation).x
let velocityX: CGFloat = (deltaTime > 0.001) ? (deltaX / CGFloat(deltaTime)) : 0.0
```

and the view model computes an **absolute** zoom-aware target frame from the x position
(AudioPlayerViewModel.swift:4622-4636 — `normalizedX * viewportWidth` mapped to a sample).
Both are handed to the engine (`updateTapeScrubInput`, AudioEngineScrubbing.swift:127-137):

```swift
let targetRate = Self.hybridTapeScrubRate(forVelocityX: velocityX, direction: direction, tuning: tapeScrubTuning)
tapeScrubRenderState.targetFrame = Double(targetFrame)
tapeScrubRenderState.targetRate  = targetRate
tapeScrubRenderState.targetGain  = abs(targetRate) > 0.001 ? 1.0 : 0.0
```

Rate mapping (line 12-27), in **pixels per second**:

```swift
guard magnitude >= tuning.deadZoneVelocity else { return 0 }   // 2 pt/s
let normalized = magnitude / tuning.normalVelocity              // 100 pt/s == 1.0x
let shaped = pow(normalized, 0.9)
return max(-tuning.maxRate, min(tuning.maxRate, shaped * sign)) // ±3.0
```

### 1.3 The render loop — the load-bearing 20 lines

`renderTapeScrub` (line 213-268), per output frame:

```swift
tapeScrubLiveState.framesSinceInput += 1
if tapeScrubLiveState.framesSinceInput > holdFrames {          // 0.040 s
    tapeScrubLiveState.targetRate = 0
    tapeScrubLiveState.targetGain = 0
}
tapeScrubLiveState.smoothedRate = smoothedScrubValue(current:..., target: targetRate,  timeConstant: 0.006)
tapeScrubLiveState.cursorFrame  = smoothedScrubValue(current:..., target: targetFrame, timeConstant: 0.035)
tapeScrubLiveState.gain         = smoothedScrubValue(current:..., target: targetGain,  timeConstant: 0.012)
...
data[frameIndex] = readTapeScrubSample(...) * gain             // linear interpolation
tapeScrubLiveState.cursorFrame += tapeScrubLiveState.smoothedRate
```

with the one-pole being exactly our idiom (line 29-33):

```swift
let coefficient = 1.0 - exp(-1.0 / (sampleRate * timeConstant))
return current + (target - current) * coefficient
```

Tuning constants, verbatim (AudioEngineService.swift:84-92):
`normalVelocity 100.0 · maxRate 3.0 · deadZoneVelocity 2.0 · rateSmoothingTime 0.006 ·
cursorCorrectionTime 0.035 · gainRampTime 0.012 · inputHoldTime 0.04`.

So the cursor is **simultaneously** integrated by the smoothed rate *and* pulled toward the
posted absolute position by a 35 ms one-pole. That is the "hybrid": rate makes the pitch,
position makes the truth, and the 35 ms pole arbitrates.

### 1.4 How it avoids clicks

Three mechanisms, all continuous, no crossfade anywhere in the turntable path:

- the cursor **never jumps** — it is one-poled to the target, so position is C⁰;
- the rate is one-poled (6 ms), so pitch is C⁰;
- a **gain envelope** (one-pole, 12 ms) with target `1` only when `|targetRate| > 0.001`,
  so approaching a standstill fades to silence rather than holding DC.

A cosine crossfade *does* exist (`applyContinuousCrossfadeToBuffer`, line 974-1007) but it
belongs to the **non-turntable discrete** path, which schedules short buffers with
`.interrupts`. It is not used while tape-scrubbing.

### 1.5 Smoothing / inertia

There is **no inertia and no fling** in the tape-scrub renderer. `turntableInertia` /
`updateVelocityWithInertia` (line 783-804) exist in the file but are only reachable from
the older `applyPlaybackRate` path, not from `renderTapeScrub`. What looks like inertia is
the **input-hold timeout**: 40 ms with no fresh input ⇒ `targetRate = 0`, `targetGain = 0`,
so the platter coasts to silence through the 6 ms/12 ms poles. Input smoothing upstream is
a 4-sample exponentially weighted average of pixel velocity (`calculateSmoothedVelocity`,
weight `pow(1.5, i+1)`, line 718-752).

### 1.6 On release

`stopScrubbing()` (line 1381-1457):

```swift
let finalTapeScrubFrame = stopTapeScrubRenderer()
stopAudioImmediately()                                  // stop + reset + drop buffers
varispeedNode.rate = varispeedRateBeforeScrub           // restore the USER's rate (a step)
playerNodeSeekFrame = max(0, min(fileLen - 1, finalFrame))
...
if shouldResume { play() }                              // only if it was playing BEFORE
```

So: **audio stops dead**, the user's varispeed rate (saved at `startScrubbing`, line 364)
is restored as a hard assignment, the playhead lands on the last rendered scrub frame, and
normal playback resumes **only if the deck was playing before the scrub began**. No decay,
no fling continuation.

### 1.7 Edges, loops, threading in the reference

- **Edges** (line 259-267): the cursor is clamped to the source range, the rate is zeroed
  *against the wall only* (`targetRate = max(0, targetRate)` at the bottom,
  `min(0, ...)` at the top — you can always drag back inward), and `targetGain = 0` so
  hitting the edge fades out.
- **Loop region**: nothing. The scrub path has no loop concept; the reference's loop
  machinery lives in the playback path only. There is no reference answer for §6.
- **Threading**: `NSLock` with `try()` on the render thread and a render-private copy
  (`tapeScrubLiveState`), reconciled through `sessionID`/`inputID` counters; on lock
  contention it *keeps rendering from the private copy* (line 161-191). It is a
  best-effort non-blocking lock, and it still touches `AVAudioPCMBuffer` references (ARC
  retain/release) on the render thread. Wizard's mailbox/seqlock discipline is strictly
  stronger and we keep ours.

### 1.8 The one thing the reference gets wrong, and why we diverge

**Position and rate are computed independently and can contradict each other.** The rate
comes from *pixels* per second with a fixed `normalVelocity = 100 pt/s`; the position comes
from the *zoom-aware* x→sample mapping. Zoom in 100× and dragging 100 pt/s still yields
rate ≈ 1.0, but the finger is now covering 100× fewer samples per second. The 35 ms cursor
pole then has to drag the cursor backwards against a rate integrator that is pushing it
forward at 1×, forever, for the whole gesture. What you hear is not the speed your hand is
moving at.

Wizard **derives the rate from the position** (§2). The two can then never disagree, and
the chase pole's remaining job is only to absorb mailbox latency — a strictly smaller job.

---

## 2. Decision 1 — position-driven, rate-derived

**Decision.** The control thread posts **only position**, stamped with host time. The
render thread **derives** the rate by differentiating it. There is no rate input to the
scrub path.

```
rate = Δframe / Δwallclock-frames
     = (frame_now − frame_prev) / ((host_ns_now − host_ns_prev) · 1e-9 · fs)
```

Units are self-evidently correct: dragging over one second of material in one second of
wallclock gives exactly `1.0`, at any zoom, on any display, with any pointing device. The
sign falls out of the drag direction — **reverse is not a code path**, exactly as
`playback-composer.md` §1 already demands of varispeed ("reverse is not a special case in
the reader").

**Why host-stamped and not engine-clock-differenced.** Deriving `Δt` from "engine frames
since the previous consumed post" would quantise `Δt` to a block (10.7 ms at 512/48k) and
make the derived rate depend on the device quantum. Stamping the post is already this
ABI's discipline for anything crossing an async boundary — `wz_source_write(..., double
source_rate, uint64_t host_time_ns)` (wz_engine.h:117). Same idiom, same reason
(D-WZ-CLOCK-01). Result: **the derived rate is block-size independent**; only the *instant
a post takes effect* carries the usual ≤1-block latency.

**Collapsed posts are not a problem.** The mailbox is single-slot: if three drag samples
land inside one block, only the newest survives. The derived rate is still correct, because
the numerator and the denominator span the *same* interval — `(f₃−f₀)/(t₃−t₀)` is the mean
rate over exactly the material that was skipped. Dropping intermediate posts loses
micro-detail, never bias.

Guards: `Δt ≤ 0` (equal or backwards host stamps) ⇒ **hold the previous derived rate**,
never divide. Mirrors the reference's `deltaTime > 0.001` guard at WaveformView.swift:1623.

---

## 3. Decision 2 — click-free

**Decision.** Continuous position interpolation for the drag; a 10 ms raised-cosine
crossfade *only* for genuine jumps. Two mechanisms, both built from the **existing**
D-WZ-RAMP-01 primitives — `alpha`, `step`, `rampStep()`, `rampShape()` (wz_engine.cpp:649,
683-684). No second smoothing idiom is introduced.

### 3.1 The drag needs no crossfade at all

While scrubbing, the playhead is never assigned — only integrated and pulled:

```
playhead += smRate;                          // C⁰: smRate is one-poled
playhead += alphaPos · (target − playhead);  // C⁰: an exponential approach, never a step
```

A discontinuity is therefore impossible by construction. This is the reference's insight
(§1.4) and it is the right one. The engine's existing 1 ppm rate snap (wz_engine.cpp:855)
is untouched and still applies.

### 3.2 The gain envelope — the D-WZ-RAMP-01 raised cosine, reused

The reference uses a *third* one-pole (12 ms) for gain. We use the engine's existing
**10 ms raised-cosine mute envelope**, because D-WZ-RAMP-01 says one constant and
wz_engine.cpp already owns exactly this stepper/shaper pair:

```cpp
d.scrubRamp = rampStep(d.scrubRamp, scrubGainTarget, step);   // step = 1/(0.010·fs)
const double g = rampShape(d.scrubRamp);                      // 0.5·(1 − cos(π·r))
```

`scrubGainTarget` is `1.0` when the platter is moving and inside the buffer, `0.0`
otherwise (§6). The raised cosine has zero slope at both ends, so the fade to a standstill
and the fade back up are both provably click-free; the maximum sample-to-sample gain change
is `(π/2)·step` — which is exactly the bound the fixtures assert (§9.2).

### 3.3 The identity path is bypassed during a scrub

The bit-exact branch (`d.smRate == 1.0 || d.smRate == -1.0` ⇒ `sample(ch, (uint64)playhead)`,
wz_engine.cpp:858-862) **must not** fire while scrubbing. The chase term at §3.1 leaves the
playhead fractional, so a snap to ±1 would swap `sampleLerp(100.5)` for `sample(100)` —
a step of up to half a sample interval, i.e. a click, produced *by* the anti-click machinery.

While `scrubActive`, always call `sampleLerp`. Nothing is lost: `sampleLerp` already
short-circuits `if (frac == 0.0) return a;` (deck.h:99), so a scrub that happens to land on
an integer position is still bit-exact. The identity path returns the instant the scrub is
released and the smoother settles back on ±1 — the existing 1 ppm snap makes that reachable
in ~0.1 s, as its own comment says.

### 3.4 Jumps get the crossfade

Genuine discontinuities remain: `wz_deck_seek`, and the loop-region fold on release (§6).
For these, run **two readers** for `kRampFrames = 0.010·fs` (480 at 48k) and cross-blend
with the same raised cosine:

```
out = (1 − rampShape(x))·read(oldPlayhead) + rampShape(x)·read(newPlayhead)
oldPlayhead += smRate;  newPlayhead += smRate;  x += step;
```

Zero added latency (unlike fade-down/jump/fade-up, which costs 10 ms), no allocation, two
`sampleLerp` calls per frame for 480 frames. One mechanism, two callers.

### 3.5 Resampler tier — a scoped divergence from D-WZ-VARISPEED-01

D-WZ-VARISPEED-01 puts a libsamplerate streaming converter in the varispeed path
(SINC_MEDIUM moving / SINC_BEST parked / identity at 1.0). **The scrub path uses
`sampleLerp`, not the SRC**, deliberately:

- a streaming SRC is a monotone forward pipeline with a ratio; a scrub reverses direction
  arbitrarily and repeatedly, and each reversal would require `src_reset()` — which discards
  the filter history and therefore *clicks*. The one thing a scrub must not do.
- the decision's own rule already selects the cheap tier while the rate is moving, and
  during a scrub the rate is moving by definition — it never parks.
- the reference reaches the same conclusion: `readTapeScrubSample` is
  `linearInterpolate(data[frame0], data[frame1], fraction:)` (line 275-305).

Cost is honest: linear interpolation above ~2× has audible imaging. Bounded (`|rate| ≤ 16`),
masked by the gesture, and gone the moment you release. Named upgrade path if it bothers
anyone in practice: swap `sampleLerp` for a 4-point Hermite in the scrub reader — no ABI
change, no decision change. This divergence is scoped to `scrubActive` and to nothing else.

---

## 4. Decision 3 — one rate, one smoother, one reader

**Decision.** Scrubbing drives the **same `d.smRate`** the varispeed path drives. It does
not create a second rate, a second smoother, or a second reader. What changes is only where
the smoother's *target* comes from:

```
tgtRate = scrubActive ? derivedScrubRate      // §2, clamped per §4.1
                      : clampVarispeed(d.rate)  // existing [1/16,16] clamp
```

Everything downstream — the one-pole, the 1 ppm snap, the lerp reader, the loop wrap — is
the code that is already there.

Three properties fall out for free, which is the reason for the decision:

1. **The user's rate setting is never touched.** `d.rate` is a control-thread atomic; the
   scrub never writes it. `wz_deck_rate()` returns 0.5 throughout a scrub if the user set
   0.5. The reference has to explicitly save and restore
   (`varispeedRateBeforeScrub = varispeedNode.rate`, line 364; restored line 1415) — we have
   nothing to save because we never clobbered it.
2. **Release is a glide, not a step.** On release, `tgtRate` switches back to the user's
   rate and the existing 10 ms one-pole walks `smRate` there. If the platter was stopped
   (`smRate == 0`) and the user's rate is 1.0, the deck **spins up like a turntable** over
   ~10 ms. The reference restores its rate as a hard assignment and only gets away with it
   because it has stopped all audio first.
3. **Normal playback is not suspended.** Unlike the reference (which stops `playerNode` and
   renders from a separate `AVAudioSourceNode`), Wizard's deck keeps rendering from the same
   reader the whole time. There is no handoff, therefore no handoff seam.

### 4.1 The scrub clamp is not the varispeed clamp

The varispeed clamp forces `|rate| ∈ [1/16, 16]` because "0 would stall the playhead"
(wz_engine.cpp:837-840). During a scrub, **0 is the most important value in the range** —
it is a stopped platter. So the scrub target uses a different rule:

| | varispeed | scrub |
|---|---|---|
| floor | `1/16` (0 forbidden) | none — 0 is legal and means *stopped* |
| ceiling | `±16` | `±16` (same, `kScrubMaxRate`) |
| dead zone | none | `|r| < kScrubDeadRate` ⇒ 0 **and** gain target 0 |
| smoother | 10 ms one-pole | same |
| 1 ppm snap | yes | yes |
| identity branch | yes | **no** (§3.3) |

`kScrubDeadRate = 1/512 ≈ 0.001953` — 1/512 of realtime is below any audible motion. The
reference's dead zone is 2 pt/s, which is a pixel quantity and therefore not portable
across zoom levels; ours is in rate units and is.

### 4.2 The scrub renders in `idle` too

A turntable makes sound when you move it whether or not the motor is on. Today the deck
pre-pass short-circuits `idle` to silence (wz_engine.cpp:800-805). New rule: **`scrubActive`
overrides the idle short-circuit.** `recording` still short-circuits (§6.3). This is the
only state-machine change scrubbing makes.

---

## 5. Decision 4 — release behaviour

**Reference behaviour first (§1.6):** audio stops dead, the user's rate is restored as a
step, the playhead lands on the last rendered scrub frame, and playback resumes **only if
the deck was playing before the scrub started**. No decay, no fling continuation, no
inertia anywhere in the tape-scrub renderer (§1.5).

**Recommendation.** Keep the reference's *policy* — release resumes what was there before —
but replace its *mechanism* (a hard stop) with the glide §4 gives us for free. Two release
modes on the ABI, because the caller genuinely knows which one it means:

| `wz_deck_scrub_end` mode | behaviour |
|---|---|
| `0` = **resume** (default) | Deck returns to the state it had when `scrub_begin` was consumed (`looping` / `oneShot` / `idle`). `tgtRate` reverts to the user's `d.rate`; `smRate` glides there over ~10 ms; the scrub gain ramps to 1.0 over the same 10 ms. If the pre-scrub state was `idle`, this is identical to mode 1. |
| `1` = **hold** | `scrubGainTarget = 0`; when the raised cosine reaches 0 (≤ 10 ms), state → `idle`, playhead latched at the released frame. This is the reference's behaviour exactly. |

**No fling, no inertia, no velocity decay in the engine.** Justification, in order:

1. The reference has none — what reads as coasting is the 40 ms input-hold fading the
   platter to silence, and we adopt that (§7.2, `kScrubHoldSeconds = 0.040`, verbatim).
2. Inertia is engine state the UI cannot deterministically cancel. Grab the platter again
   mid-fling and the two authorities fight; every DJ-software bug of this shape is that.
3. **The architecture already gives it away for free.** The path is position-driven, so a
   UI that wants a fling just keeps posting decaying targets after the pointer is up
   (`frame += v·dt; v *= k`) and calls `scrub_end` when `|v|` is negligible. The engine
   needs no code, no constant, and no new state to support it, and the UI keeps sole
   authority over the gesture. That is the right layer for a *feel* parameter.

---

## 6. Decision 5 — loop region, and Decision 6 — silence and edges

### 6.1 Loop region: leave it while held, fold on release

**Decision.** While `scrubActive`, the loop wrap is **suspended**; the playhead is bounded
only by `[0, frames)`. On release, if the playhead is outside an enabled region, it is
folded back **with phase preserved** and the fold is crossfaded (§3.4):

```
forward:  folded = rs + fmod(playhead − rs, regionLen)
reverse:  folded = re − fmod(rs − playhead, regionLen)     // same expressions as wz_engine.cpp:874-892
```

Rationale, and it is a narrow one: *a loop is a loop* stays true for every existing caller.
`wz_deck_seek` keeps folding immediately — `deck_seek_test.cpp:75-86` continues to pass
unchanged, deliberately. The exemption exists only for the duration of a held gesture,
because the gesture's entire purpose is "scrub outside the region to find the part you want
to loop" — which is what `wz_engine.h:144-146` already promises and cannot currently deliver.
Let go, and the region reasserts itself within one block.

The reference offers no guidance here: its scrub path has no loop concept at all (§1.7).

### 6.2 Edges — the record hits the label

Adopt the reference's edge rule (line 259-267) directly, translated to buffer bounds:

```
if (playhead < 0)            { playhead = 0;            if (smRate < 0) smRate = 0; scrubGainTarget = 0; }
if (playhead > frames − 1)   { playhead = frames − 1;   if (smRate > 0) smRate = 0; scrubGainTarget = 0; }
```

The rate is zeroed **only against the wall**, so dragging back inward is instantly live and
the gain ramps up again through the same raised cosine. Past the end of a buffer you hear
silence, not the last sample held as DC, and not a wrap.

### 6.3 Empty deck, and RECORDING

- **Empty deck** (`frames == 0`): `wz_deck_scrub_begin` is accepted and `scrub_to` posts are
  accepted, but the render pass keeps its existing `dFrames == 0 ⇒ silence` short-circuit
  (wz_engine.cpp:800-805) and additionally forces `scrubGainTarget = 0`. Output is exactly
  zero, `pubPlayhead` is 0, no NaN, no division by `regionLen == 0` (guarded already).
  Deliberately not an error: the UI may legitimately begin a gesture on a deck a load is
  about to fill.

- **RECORDING is refused, not queued.** `wz_deck_scrub_begin` on a deck whose state is
  `recording` is a **no-op that also clears the scrub mailbox** (`scrubCmd = 0`,
  `scrubActive = 0`). Reasons: the record pass owns `d.frames` and appends at the head, a
  recording deck's playback pass is silent by contract (wz_engine.cpp:798-801), and a scrub
  posted an instant before `record_start` must not fire when recording stops. Additionally,
  the **Law C-3 stop→loop handoff clears scrub state** (alongside its existing
  `pendingReset.store(0)`, wz_engine.cpp:711) so a fresh take always begins at the region
  entry and never at a stale scrub target.

  Scrubbing a deck *while it records* is out of scope, permanently: there is no second
  playhead, and inventing one would make the instant-turnaround handoff ambiguous. The
  refusal is silent at the ABI and visible in the HotFrame (`scrubbing` stays 0), which is
  the house pattern for "asked for something the state doesn't allow".

---

## 7. Decision 7 — the ABI

### 7.1 New calls (three), in `wz_engine.h` after `wz_deck_seek`

```c
/* --- turntable scrubbing (docs/specs/pd-scrub-engine.md) -----------------
 * POSITION-DRIVEN: the caller posts only WHERE the finger is; the engine
 * DERIVES the rate by differentiating that position against the host clock,
 * so pitch and speed fall out of how fast you drag, at any zoom, and reverse
 * is not a separate mode. Contrast wz_deck_seek, which JUMPS.
 *
 * Take the platter. Seeds the scrub position from the deck's CURRENT playhead
 * -- engaging never jumps and never clicks. Remembers the deck's transport
 * state for mode-0 release. Renders even from `idle` (a turntable makes sound
 * when you move it). A deck in the RECORDING state refuses: the call is a
 * no-op and clears any pending scrub. Control thread, RT-safe. */
void wz_deck_scrub_begin(wz_engine* e, uint32_t deck);

/* Post one drag sample: the frame the pointer is over NOW, and the host's
 * monotonic timestamp for it (same discipline as wz_source_write -- the rate
 * must not depend on the device quantum). `frame` is fractional on purpose:
 * sub-sample pointer resolution is free and quantising it would add a rate
 * jitter floor. Clamped to [0, frames). Single-slot seqlock mailbox: posts
 * arriving faster than blocks collapse to the newest with NO bias to the
 * derived rate. A non-monotonic or duplicate timestamp holds the previous
 * derived rate rather than dividing. Control thread, RT-safe, single writer. */
void wz_deck_scrub_to(wz_engine* e, uint32_t deck, double frame,
                      uint64_t host_time_ns);

/* Let go. mode 0 = RESUME: the deck returns to its pre-scrub transport state
 * and the smoothed rate GLIDES back to the deck's own `rate` over the
 * D-WZ-RAMP-01 10 ms (a stopped platter spins back up); an out-of-region
 * playhead folds back into an active loop region, phase-preserved and
 * crossfaded. mode 1 = HOLD: fade out over the 10 ms raised cosine, then
 * -> idle at the released frame. No fling and no inertia live in the engine:
 * the path is position-driven, so a UI that wants momentum simply keeps
 * posting decaying targets. Control thread. */
void wz_deck_scrub_end(wz_engine* e, uint32_t deck, uint32_t mode);
```

`wz_deck_set_rate` / `wz_deck_rate` are **unchanged** and remain the user's rate throughout
a scrub (§4). `wz_deck_seek` is **unchanged in semantics** (§7.3).

### 7.2 Deck state — control→render mailbox and render-owned fields

Added to `struct Deck` (deck.h). The seqlock is the *same* idiom as `publishLoop`/`readLoop`
already in that file (deck.h:139-157), not a new one.

```cpp
// --- scrub mailbox (control → render) ------------------------------------
std::atomic<uint32_t> scrubCmd{0};   // 0 none · 1 begin · 2 end-resume · 3 end-hold
std::atomic<uint32_t> scrubSeq{0};   // seqlock AND freshness counter: odd = write
double   scrubFrameRaw = 0.0;        // guarded by scrubSeq
uint64_t scrubHostNs   = 0;          // guarded by scrubSeq
void publishScrub(double f, uint64_t ns);            // control thread, single writer
bool readScrub(double&, uint64_t&, uint32_t& ver) const;  // render, torn-free

// --- render-owned --------------------------------------------------------
uint32_t scrubActive     = 0;
uint32_t scrubVerSeen    = 0;   // last scrubSeq consumed
double   scrubTarget     = 0.0; // clamped to [0, frames-1]
double   scrubPrevFrame  = 0.0;
uint64_t scrubPrevNs     = 0;
double   scrubRateTgt    = 0.0; // derived, pre-smoothing
double   scrubStarve     = 0.0; // engine frames since a fresh post
uint32_t scrubResumeState = 0;  // DeckState to restore on end-resume
double   scrubRamp       = 0.0; // raised-cosine ramp position [0,1]
uint32_t scrubEnding     = 0;   // 1 = fading out for end-hold
// --- declick crossfade (jumps only: wz_deck_seek, release fold) ----------
double   xfadePos = -1.0;       // ramp position [0,1]; < 0 = inactive
double   xfadeOld = 0.0;        // outgoing reader's playhead

// --- render → UI ---------------------------------------------------------
std::atomic<double>   pubScrubRate{0.0};
std::atomic<uint32_t> pubScrubbing{0};
```

`std::atomic<double>` is already used on this struct (`rate`, `pubPlayhead`), so no new
portability surface.

**Thread split.** Control thread: `scrub_begin/to/end` — three atomic stores plus one
seqlock publish; no lock, no allocation, no branch on render state. Render thread: consumes
the mailbox once at block top, owns everything else. **The render thread never locks and
never allocates**, exactly as today — note the contrast with the reference, which does
`tapeScrubRenderLock.try()` and touches ARC-managed buffer references on its audio callback
(§1.7).

### 7.3 `wz_deck_seek` — semantics unchanged, declick added

It stays a jump, and it stays subject to the region fold (`deck_seek_test.cpp` unchanged).
The only change: the assignment at wz_engine.cpp:820-825 arms the §3.4 crossfade
(`xfadeOld = playhead; xfadePos = 0`) instead of stepping. Its ABI comment must be corrected
to say what the fixture proves — that a seek **is** folded into an active loop region — and
to point at `wz_deck_scrub_*` for the behaviour the current wording promises.

### 7.4 HotFrame — a real, named consequence

Two fields appended to `DECK_BLOCK_FIELDS` (web/protocol/schema.ts:70-79), so the UI can
show platter speed and never lie about whether the engine is scrubbing:

```ts
'scrubbing',   // 1 while a scrub gesture holds the platter
'scrubRate',   // the SIGNED rate the reader is actually using (derived, smoothed)
```

Deck block stride goes **8 → 10**. Consequences to carry in the same commit:
regenerate `WZProtocol.h` (web/scripts/generate-protocol.ts), update `web/src/protocol.test.ts`,
and update the hand-rolled index math in `engine/tools/deck_seek_test.cpp:32`
(`8 + channelCount*7 + deck*8 + 1` → `deck*10 + 1`). Also worth fixing in passing: the
comment at wz_engine.cpp:1171 says "stride 7" while the loop writes 8 fields.

---

## 8. Block-level pseudocode

Constants (all at `fs = 48000`):

| symbol | value | at 48k | source |
|---|---|---|---|
| `kRampSeconds` | 0.010 | 480 frames | D-WZ-RAMP-01, **existing** |
| `alpha` | `1 − exp(−1/(0.010·fs))` | 2.08117e-3 | **existing**, wz_engine.cpp:683 |
| `step` | `1/(0.010·fs)` | 2.08333e-3 | **existing**, wz_engine.cpp:684 |
| `kScrubChaseSeconds` | 0.035 | — | adopted **verbatim** from the reference's `cursorCorrectionTime` |
| `alphaPos` | `1 − exp(−1/(0.035·fs))` | 5.95061e-4 | derived |
| `kScrubHoldSeconds` | 0.040 | 1920 frames | adopted **verbatim** from the reference's `inputHoldTime` |
| `kScrubDeadRate` | 1/512 | 1.953e-3 | new (rate units, not pixels — see §4.1) |
| `kScrubMaxRate` | 16.0 | — | same ceiling as varispeed |
| rate snap | 1e-6 | — | **existing** 1 ppm snap, wz_engine.cpp:855 |

Why 35 ms for the chase: a position error of `e` frames contributes `e·alphaPos` frames per
frame of *extra* rate, i.e. a 1000-frame error adds 0.595× at 48k — audible as a catch-up
glide, never as a jump — and the error halves in `ln2 · 0.035 = 24.3 ms`. Slower than the
rate pole on purpose: position corrects, rate performs.

### Block top (per deck, replacing wz_engine.cpp:815-828)

```
cmd = scrubCmd.exchange(0)
if cmd == 1 and state != recording and scrubActive == 0:
    scrubActive = 1;  scrubResumeState = state
    scrubTarget = scrubPrevFrame = playhead      // engaging NEVER jumps
    scrubPrevNs = 0;  scrubRateTgt = 0;  scrubStarve = 0;  scrubEnding = 0
    // scrubRamp keeps its current value: if the deck was audible it stays audible
elif cmd == 2 and scrubActive:                   // end-resume
    scrubActive = 0
    state = scrubResumeState                     // tgtRate reverts to d.rate → §4 glide
    if loopEnabled and playhead outside [rs,re):
        xfadeOld = playhead; xfadePos = 0        // §3.4
        playhead = fold(playhead)                // §6.1, phase-preserved
elif cmd == 3 and scrubActive:
    scrubEnding = 1                              // fade first, transition when the ramp hits 0

if scrubActive:
    (f, ns, ver) = readScrub()                   // seqlock, torn-free
    if ver != scrubVerSeen:
        scrubVerSeen = ver
        scrubTarget  = clamp(f, 0, dFrames − 1)
        dtFrames = (ns − scrubPrevNs) * 1e-9 * fs
        if scrubPrevNs != 0 and dtFrames > 0:
            r = (scrubTarget − scrubPrevFrame) / dtFrames
            if |r| < kScrubDeadRate: r = 0
            scrubRateTgt = clamp(r, −kScrubMaxRate, +kScrubMaxRate)
        scrubPrevFrame = scrubTarget;  scrubPrevNs = ns;  scrubStarve = 0
    else:
        scrubStarve += frames                    // engine frames, not host time
        if scrubStarve > kScrubHoldSeconds * fs:
            scrubRateTgt = 0                     // finger stopped ⇒ platter stops (§1.5)
else:
    // existing pendingReset / pendingSeek / region-clamp block, unchanged,
    // except pendingSeek now arms the §3.4 crossfade instead of stepping
```

### Per-frame (replacing wz_engine.cpp:845-901)

```
tgtRate = scrubActive ? scrubRateTgt : clampVarispeed(d.rate)   // §4.1

smRate += alpha * (tgtRate − smRate)
if |tgtRate − smRate| < 1e-6: smRate = tgtRate                  // existing 1 ppm snap

if scrubActive or scrubRamp < 1.0:
    gainTgt = (scrubActive and !scrubEnding and |smRate| >= kScrubDeadRate
               and dFrames > 0 and 0 <= playhead <= dFrames−1) ? 1.0 : 0.0
    scrubRamp = rampStep(scrubRamp, gainTgt, step)              // EXISTING stepper
    g = rampShape(scrubRamp)                                    // EXISTING shaper
else:
    g = 1.0

// read: sampleLerp only while scrubbing (§3.3); identity branch otherwise, unchanged
s0 = scrubActive ? sampleLerp(0, playhead) : readAsToday(0, playhead)
s1 = channels > 1 ? (scrubActive ? sampleLerp(1, playhead) : readAsToday(1, playhead)) : s0

if xfadePos >= 0:                                               // §3.4, jumps only
    w  = rampShape(xfadePos)
    s0 = (1−w)*sampleLerp(0, xfadeOld) + w*s0
    s1 = (1−w)*(channels>1 ? sampleLerp(1, xfadeOld) : sampleLerp(0, xfadeOld)) + w*s1
    xfadeOld += smRate;  xfadePos += step
    if xfadePos >= 1.0: xfadePos = −1.0

dl[i] = g * s0;  dr[i] = g * s1

playhead += smRate                                              // integrate: makes the pitch
if scrubActive:
    playhead += alphaPos * (scrubTarget − playhead)             // chase: makes it true
    if playhead < 0:            { playhead = 0;          if smRate < 0: smRate = 0 }   // §6.2
    if playhead > dFrames − 1:  { playhead = dFrames−1;  if smRate > 0: smRate = 0 }
    // loop wrap SUSPENDED while held (§6.1)
    if scrubEnding and scrubRamp <= 0.0:
        scrubActive = 0;  scrubEnding = 0;  state = idle        // §5 mode 1
else:
    ... existing forward/reverse loop-wrap block, unchanged ...

pubPlayhead.store(playhead);  pubScrubRate.store(smRate);  pubScrubbing.store(scrubActive)
```

Allocation count: 0. Locks: 0. Branches added to the non-scrub path: one (`scrubActive`),
predictable and false.

---

## 9. Fixtures

New: `engine/tools/deck_scrub_test.cpp` (+ its `add_executable` in `engine/CMakeLists.txt`,
matching the existing 8 entries). House style: `CHECK()` macro, ramp buffers where a sample
identifies its own frame, `wz_engine_set_watchdog_enabled(e, 0)` for above-full-scale ramps,
real sample-value assertions — no "it didn't crash" tests.

Two source buffers do all the work:
- **RAMP** — `buf[i] = i`. Output value *is* the read position, so pitch and direction are
  directly measurable.
- **DC** — `buf[i] = 1.0`. Any nonzero Δ in the output is *purely the gain envelope*, so the
  declick bound becomes an exact number instead of a guess.

Host stamps are synthesised: `ns += 1e9 * blockFrames / 48000` per posted block, so the
fixture controls the derived rate to the digit.

**9.1 Pitch falls out of position** *(the load-bearing test)*
RAMP, 48000 frames, no loop. `scrub_begin`; post targets advancing **+256 frames per 256-frame
block** with matching stamps (= exactly realtime). After ~250 blocks of settling, assert
`l[i+1] − l[i]` is `1.00 ± 0.02` across a block. Then **+512/block** ⇒ `2.00 ± 0.04`. Then
**−256/block** ⇒ `−1.00 ± 0.02`, and assert the output ramp strictly **descends** — proving
reverse falls out of the drag with no reverse code path. Then **+0/block** ⇒ output decays to
`|x| < 1e-6`. Also assert `wz_deck_rate(e,0)` is untouched at every step.

**9.2 No click, exactly bounded** *(the second load-bearing test)*
DC buffer. One continuous gesture: begin → accelerate to 4× → decelerate through **zero** →
reverse to −2× → `scrub_end(mode 1)`. Concatenate every output sample of the whole gesture
and assert
`|out[n] − out[n−1]| <= (π/2)·step·(1 + 1e-3)` for all n — the exact maximum slope of
`rampShape` (§3.2), which is the only thing that can change on a DC source. This one number
falsifies any accidental step, in the envelope, at the zero crossing, or at the release.
Repeat with a RAMP buffer and the rate-aware bound
`|Δ| <= max|smRate| + (π/2)·step·|x|max`.

**9.3 Stop the finger, stop the platter**
RAMP. Post one target, then render `0.040 s + 0.010 s + one block` with **no further posts**.
Assert output decays to `|x| < 1e-6` and that `pubPlayhead` is **bit-identical across two
consecutive blocks** — the platter is stopped, not creeping at the `1/16` varispeed floor
(which is precisely what would happen if the scrub clamp were reused, §4.1).

**9.4 The user's rate survives, and the deck spins back up**
`wz_deck_set_rate(e, 0, 0.5)`, trigger loop, scrub at 2× for 100 blocks, asserting
`wz_deck_rate(e,0) == 0.5` **exactly** at every block. `scrub_end(mode 0)`; assert the deck
returns to `state == looping` and, after ~250 blocks of glide, the RAMP advances
`0.50 ± 0.01` per sample. Assert the glide itself is monotone — no overshoot past 0.5.

**9.5 Loop exemption is scoped to the gesture**
Region `[0, 1000)`, deck looping, RAMP of 4000. Scrub the target to **3500**; assert
`pubScrubbing == 1` and `pubPlayhead` **reaches ~3500 — outside the region.** Then
`scrub_end(mode 0)`; assert within one block `pubPlayhead ∈ [0, 1000)` and ≈ `3500 mod 1000
= 500` (phase preserved, ±1 block of travel), and on a DC buffer that the fold obeys 9.2's
bound. Finally assert `wz_deck_seek(e, 0, 3500)` **still folds immediately** — i.e.
`deck_seek_test.cpp:75-86` is untouched by this feature.

**9.6 Edges**
RAMP. Drag the target to 0 and keep posting negative targets: assert `pubPlayhead == 0.0`,
`pubScrubRate == 0.0` (zeroed against the wall) and output `|x| < 1e-6`. Then post increasing
targets: assert audio returns **and** that the return obeys 9.2's slope bound (the gain
ramped up, it did not switch on). Repeat at `frames − 1`. Then a fresh engine with a deck
that was **never loaded**: `scrub_begin` + posts + 10 blocks ⇒ every output sample exactly
`0.0f`, every value finite, `pubScrubbing` readable, no crash.

**9.7 Recording refuses, and C-3 clears the scrub**
`record_start`; `scrub_begin`; post targets; render 10 blocks. Assert (a) `state` stays
`3` (recording), (b) `pubScrubbing == 0`, (c) `recordLengthSamples` advanced by **exactly**
`10 · blockFrames` — the scrub disturbed nothing, (d) the deck's playback contribution is
exactly silent. Then `record_stop` with loop enabled: assert playback begins at the **region
entry**, not at the stale scrub target, in the same block (Law C-3 preserved).

**9.8 `wz_deck_seek` is now click-free**
DC buffer, deck looping. `wz_deck_seek` to a distant frame mid-block; assert 9.2's bound
holds across the jump — a **new** guarantee (today this steps). On RAMP, assert the crossfade
lasts exactly `kRampFrames` and that after it the output equals the ramp at the new position
to within one lerp interval.

**9.9 Block-size independence of the derived rate**
Run the identical gesture (identical `{frame, host_time_ns}` post sequence) at
`max_block_frames` 64 and 256. Assert the *derived rate* after settling matches to within
1e-3 — this is the property §2's host stamping buys, and the negative control is the
alternative design: differencing the engine clock would make the rate a function of the
quantum. Note explicitly in the test's header comment that this is **not** the sample-exact
chunk invariance `render_chunk_invariance_test` asserts for playback: a scrub post takes
effect at block top, so ≤ 1 block of *timing* difference is expected and allowed. Being clear
about which invariance holds is the point of the fixture.

---

## 10. Proposed decision record

`D-WZ-SCRUB-01 · Turntable scrubbing is position-driven` — the control thread posts only a
host-stamped position; the engine derives the rate by differentiating it; the derived rate
drives the **existing** varispeed smoother and reader (no second rate, no second reader, no
second smoothing idiom); the user's `rate` is never written; release glides back through
D-WZ-RAMP-01; no inertia lives in the engine. Divergences from D-WZ-VARISPEED-01 (§3.5) and
from the loop-wrap invariant (§6.1) are each scoped to `scrubActive` and named here.
Raise for sign-off before P4's scrub increment is built — it is a *feel* decision as much as
a DSP one, and §5's release policy in particular is a user question.
