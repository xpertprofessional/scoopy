# Turntablism scratch for the looper — behaviour spec

**Written 2026-08-02.** Research complete, **nothing built**. This document
exists so implementation can start in a fresh session without re-deriving any of
it. Line numbers were verified on that date against the tree — confirm they
still point at the same thing, but **trust the finding**.

Reference PDFs are staged at **`~/reference/scratching/`** (outside the repo,
per the plugin line's provenance convention) with a `SOURCES.md` describing each
and how to extract text from them. §7 records what was and was not consulted.

Read alongside: `docs/merge/TAPEPLUGIN-KICKOFF.md` (the looper product),
`docs/archive/pd-scrub-engine.md` (the scrub renderer's own design record),
`docs/DESIGN.md`, and `D-SL-STUDIO-01` in `docs/DECISIONS.md`.

---

## 0. The proposal, and the decisions already taken

**The feature.** Tempo-locked scratch patterns — baby, chirp, flare,
transformer, crab, orbit — that execute for as long as you hold them, plus a
2D pad where X is the record and **Y is a crossfader**. It must reach **both
ScoopyTape (VST) and Studio**, not only the plugin it was imagined in.

**Signed or ruled already (user, 2026-08-02):**

| # | Decision |
|---|---|
| 1 | The fast fader gate becomes a **proposed exception to D-WZ-RAMP-01** (~1–3 ms). ⚠️ **Not signed yet — sign before building it.** §4.2 carries the argument. |
| 2 | **Ship on the existing linear interpolation**; measure aliasing rather than pre-emptively implementing D-WZ-VARISPEED-01 on the tape. §4.6. |
| 3 | **The 2D pad belongs to SCRATCH MODE**, not to ordinary scrubbing. Y stays meaningless for a normal scrub. |
| 4 | **The pattern generator posts `scrub_to` from `processBlock`**, not from a message-thread timer. §4.1. |
| 5 | **This work carves the `TapeRow` block** that Studio's S8 needs, so the feature reaches both products by construction. §5. |
| 6 | Reference PDFs live at `~/reference/scratching/`. |

---

## 1. What a scratch actually is

**Two independent gesture streams.** Every named technique is a combination of
them; the record motion alone is almost always just "push forward, pull back".

- **The record hand** — position over time. Maps onto the existing `scrub_to`.
- **The fader hand** — a fast amplitude gate. **Does not exist in this engine.**

**A click** (TTM's term) is *"the break in the sound caused by the closing and
opening of the fader in as little time as possible."* Note it is a **momentary
close**, not a toggle — so for open-fader techniques the fader's resting state
during a stroke is OPEN and a click dips it.

**Open- vs closed-fader techniques.** Open-fader scratches (baby, scribble,
flare, orbit) *"begin and end in the open fader position"* and **the direction
change is heard**. Closed-fader scratches (chirp, transformer) cut at the
reversal so it is not heard.

### ⚠️ The phantom click — the thing you do not author

TTM, verbatim:

> at the exact point where the record changes direction, the record is
> momentarily completely motionless. The instant where the record is still
> creates an extremely short period of silence — a phantom click — which breaks
> the sound of the scratch without requiring any movement of the fader.

It is why a baby scratch produces discrete bursts with **no fader at all**, and
why a two-click flare sounds like four.

**It is emergent from the rate curve, not from either stream.** Our reader
passes rate through zero at every reversal with a 10 ms one-pole
(`sl_tape.cpp:632`), so we may already produce it. **Measuring that is the first
task in §6** — it decides whether this feature is "author some curves" or "model
the platter", and it costs nothing.

---

## 2. The technique table

Sourced from TTM's definitions (`~/reference/scratching/`), restated in our own
terms as a data model. "Reversal heard" is a *consequence* of fader rest state,
not an independent field.

| Technique | Fader rest | Clicks per stroke | Reversal heard | Notes |
|---|---|---|---|---|
| **Baby** (rub) | open, never moves | 0 | yes | The reference case. Pure record hand; all articulation is phantom clicks. |
| **Forward** (cut) | open on push, closed on pull | — | no (pull silent) | Only the forward stroke sounds. |
| **Military** | alternating | — | mixed | Forward scratches interspersed with rubs; record hand steady, fader hand cuts. |
| **Scribble** | open | 0 | yes | Very fast, tiny span — a tremor, not a stroke. ~20 reversals/s. |
| **Stab** (jab, scrape) | opens **immediately after** the gesture starts | 0 | n/a | Fast push or pull, high pitch; the re-cue is not heard. |
| **Chirp** | closes **directly after** the gesture starts | — | no | One tone per stroke, from the *start and end fragment only*. Hard to time. |
| **Transformer** | closed | several, spread across the stroke | no | Multiple tones per stroke; also cut at the reversal. |
| **Flare** (1-click) | **open** | 1, mid-stroke | yes | 1 real + 1 phantom per stroke. |
| **Flare** (2-click) | **open** | 2 | yes | The canonical case: 2 real + 2 phantom ⇒ *sounds like 4*. |
| **Crab** | **open** | 4, rapid | yes | Fader bounced thumb-against-four-fingers. Audio-wise a 4-click flare. |
| **Orbit** | **open** | as the flare | yes | A flare that continues on **both** strokes rather than one. |

⚠️ **Techniques chain.** TTM notes adjacent open-fader scratches *share* their
open-fader boundary symbols — a sequence is not a list of isolated figures. A
pattern format should allow concatenation.

⚠️ **Practice diverges from the taxonomy.** The single-DJ study is blunt about
it: *"Techniques are not often played subsequently in full, but rather shortened
or abruptly changed, going into next technique."* Treat the table as the
vocabulary, not as a description of a performance.

---

## 3. The measured numbers

From the KTH studies. **These are what to tune from — do not invent taste
values.** Attributions in `~/reference/scratching/SOURCES.md`.

### Tempo — the evidence that tempo-locking is right

- **Crossfader IOIs cluster at 1/32, 1/16 and 1/8 notes.** Record strokes are
  dominated by 1/8 (mean IOI **213 ms**, SD 130) — the authors conclude *the
  record hand keeps the pulse*.
- Two constant-duration trends fall out at **73 ms and 155 ms**, identified as
  **1/32 and 1/16 at 90 bpm**.
- The analysed improvisation ran at **~96 bpm**, 12 bars of 4/4.

**So a beat-grid pattern representation is a description of what DJs do, not an
approximation of it.** Period belongs in musical divisions, never milliseconds.

### Timing

- **Record and fader both move ≈51 ms before the tone.** The record reaches
  speed *first*, then the fader opens. A pattern that opens the gate at t=0 of a
  stroke will sound wrong.
- **Direction-change silence ≈5 ms** (the authors' own estimate, used to insert
  tone offsets).
- **Below 10 ms is not a tone** — their artifact-rejection floor.
- Longest tones ≈**800 ms**; **60% of tones have IOI < 167 ms**.
- **Only 54% of performance time is sound.**

### The reversal statistics — surprising and load-bearing

- 135 direction changes in the analysed piece, **~4.5 per second**.
- **Only 21.5% of reversals are heard.** The authors: *"in a normal scratch
  improvisation … about **70–90% of the directional changes are silenced**."*

⚠️ **Consequence for defaults:** closed-fader behaviour dominates real playing.
A feature that defaults to open-fader (all reversals audible) will sound busier
and less idiomatic than a real performance.

### Amplitude, and the crossfader curve

- **Sound level correlates 0.8 with record speed** — faster is *louder*,
  independently of the fader. Worth modelling; we currently do not.
- Tones **50–150 ms** are the controllable range for level; below 50 ms level
  varies wildly.
- **The crossfader curve, measured:** the run is **45 mm**, but *"the
  interesting part, from silence to full volume, spans only **two-three
  millimetres**"*, a few mm from the end of its travel.

⚠️ **This is the most actionable single number for the Y axis.** A battle
crossfader is effectively a **gate with a ~5%-of-travel transition band**, not a
linear fader. A pad whose Y maps linearly to gain over the full height will feel
nothing like a crossfader. Put the transition in a narrow band and make the rest
of the travel dead — and note the dead zone is where the hand *rests*, which is
what makes clicking fast possible at all.

### Motion and pitch

- **Span is small:** chirps used only the first **20° of a 144° sample**.
- **Reversals land at the extrema** of the position curve, always — strokes are
  whole units.
- **Pitch span within a single tone: mean 2109 cents** (>1.5 octaves), max >7
  octaves. *"Pitch stability is not pursued, nor, possibly, even attainable."*
  So the record velocity is **not** constant within a stroke; a triangle wave
  would be wrong, something sine-ish is right.
- **Scribble** ≈20 reversals/s, sustainable for seconds.

### The move that defines the craft

DJs held tone durations near-equal **by adjusting the fader-off duration while
letting gesture speed vary**.

> The fader lane absorbs timing error; the record lane carries expression.

That asymmetry should shape the control surface: expose span/speed to the
player, let click widths compensate automatically.

---

## 4. How this maps onto our engine

### 4.1 The record hand — EXISTS, and needs no engine change

`sl_tape_scrub_begin/to/end` (`sl_engine.h:309-317`). The render law
(`sl_tape.cpp:618-647`): the control thread posts **only where the finger is**,
and the render derives rate from the gap —

```
target = scrubTarget.load()                       // :623  ONCE PER BLOCK
want   = clamp((target - playhead) / frames, -4, 4)  // :627
scrubRate += alpha * (want - scrubRate)           // :632  one-pole, 10 ms
playhead  += scrubRate                            // :634
out = sampleLerp(playhead) * rampShape(scrubGain) // :639
```

`pd-scrub-engine.md:396-403` already argues the engine should stay a dumb
position-follower and let the caller post targets: *"a UI that wants a fling
just keeps posting decaying targets… The engine needs no code, no constant, and
no new state to support it."* **An auto-scratch is that same shape.**

**`scrub_to` is one relaxed atomic store** (`sl_tape.cpp:222`) — RT-safe in
fact, merely *declared* control-thread by the header's blanket note. That is
what makes decision 4 free.

#### The control-rate ceiling — the number that decides the design

**`scrubTarget` is read exactly once per engine block and never interpolated**
(`sl_tape.cpp:623`). The block is fixed at 512 frames (`sl_engine_create(rate,
512, …)`, e.g. `ScoopyTapeProcessor.cpp:34`), so:

- **Ceiling: 93.75 target updates/s = 10.67 ms grain @48 k**, whatever the
  caller does.
- **A 40 Hz message timer gives 25 ms grain plus message-thread jitter** (it is
  preempted by editor work, WebView paints and `dispatchFromUi` under
  `stateLock`). Adequate for a slow baby scratch; **unusable from flare upward**.
- **Posting per engine chunk from `processBlock` hits the ceiling exactly, for
  free** — the processor already chunks by `engineBlock`
  (`ScoopyTapeProcessor.cpp:164-201`).

**Precedent for writing engine state from `processBlock`:**
`HostParams::pushToEngine` does it already, under the D-SL-DECKPLUGIN-04
amendment, and its stated reason is this same argument one octave down —
*"a 6 Hz LFO resampled at the 40 Hz pump is a staircase."* The codebase has also
already written down that the pump is not good enough for musical timing:
*"Closing that needs the launch decision to happen inside the audio callback"*
(`ScoopyPluginProcessor.cpp`, the quantized-launch comment).

⚠️ **The gap law divides by `frames`.** A **position-driven** generator ("where
should the playhead be at time t") is block-agnostic and safe. A generator that
tries to command a *rate* by opening a fixed gap is **not** — it would produce a
different rate at a different block size.

⚠️ **Residual jitter:** reversals land on the block grid, ±5.3 ms. Acceptable
for everything up to a flare; the escape hatch if it proves audible is §6.

### 4.2 The fader hand — NEW, and it needs an exception to signed law

**Nothing in the tree can gate faster than 10 ms.** Every amplitude control is
welded to the one constant: `sl_channel_set_level`, `sl_channel_set_mute` (also
a 10 ms glide, not a switch), `sl_channel_set_monitor`, route gain, and the
tape's internal `scrubGain`. The header states it as law
(`sl_engine.h:433-438`): *"All glide on the one 10 ms constant (D-WZ-RAMP-01) —
no parameter reaches the summing math as a step."*

**Why 10 ms cannot work here:** measured clicks are 30–70 ms end to end. A 10 ms
ramp down plus 10 ms up inside a 40 ms click never reaches silence, and a crab's
four clicks per stroke smear into a wobble.

**The proposed exception, for signing:**

> A scratch click is a **musical event the listener is meant to hear**, not the
> declick of a switch. D-WZ-RAMP-01's own consequences clause enumerates what it
> governs — *"solo, monitor assign, insert bypass"* — all of which are state
> changes that should be inaudible. A click is the opposite category: its whole
> function is to be heard. The exception is therefore narrow and named: one
> per-tape gate, ~1–3 ms shaped, reachable only by the scratch path.

**Where it must apply.** Inside the tape's **per-sample loops**, not in the
channel:
- the scrub path (`sl_tape.cpp:628-643`), beside `sg` at `:639-642`, and
- the `renderVarispeed` lambda (`sl_tape.cpp:714+`), so a transformer works on a
  **normally playing loop** and not only during a scrub.

Putting it in `ChannelBank::mixInto` would be **block-accurate only** — the
targets there are hoisted once per block, so the *decision instant* would sit on
the same 10.7 ms grid regardless of how fast the ramp is. **The ramp shape and
the decision instant are two different problems; sample accuracy lives in the
latter.**

**Precedent that the topology allows it:** a per-sample gate array already
exists in the route pour — `sl_channel.cpp:608`,
`g = sm * extra * (gate != nullptr ? gate[i] : 1.0)` (the monitor gate lane).
Proven RT-safe, already per-sample; it is simply not reachable from the ABI and
not applied at the tape's own stage.

### 4.3 Tempo — EXISTS

`HostSync::capture` runs at the top of every `processBlock` and **pairs ppq with
`sl_engine_time_samples`** under a seqlock (`HostSync.cpp:22-46`) — that pairing
is the sample-exact anchor a beat-locked generator needs, and it is already
computed for you.

⚠️ **`ScoopyTapeProcessor` has no `pump` at all** and that is deliberate
(`ScoopyTapeProcessor.h:92-105`): pump writes *deck* params, and a tape has no
deck. Its 40 Hz timer only emits `hostTransport`.

### 4.4 Beat-accurate scheduling — EXISTS for decks, NOT for tapes

The canonical shape is `hostLaunchFrame` (`sl_engine.cpp:381-386`): an absolute
engine-frame mailbox, resolved against the block about to render, firing with a
**sub-block lead-in** via `requestLaunchWithLeadIn`. Its doctrine comment says
why: *"The boundary is resolved INSIDE render() … which is what buys sample
accuracy: no UI-thread poll can be jitter-free."*

**The tape has no equivalent** — no tape verb accepts an engine frame; its only
scheduling primitives are block-top mailboxes (`pendingReset`, `pendingSeek`,
`scrubTarget`). If pattern *starts* need to be beat-exact rather than
block-exact, this is the pattern to copy.

### 4.5 Traps — do not rediscover these

- **`cueFrame` is re-armed on every scrub block** (`sl_tape.cpp:644`). A running
  auto-scratch **continuously overwrites the user's cue point**. Decide whether
  a pattern suppresses cue arming.
- **Rate is hard-clamped to ±4×** (`:627`). A scratch asking for more is
  silently rate-limited and will *lag* its target until the target reverses.
- **`scrub_end` modes were designed and never shipped**
  (`pd-scrub-engine.md:380-400` proposed `0 = resume`, `1 = hold`). What
  actually happens: rate coasts to zero, gain fades 10 ms, then the playhead
  **snaps to the loop `entry`** (`sl_tape.cpp:678`) — or goes silent entirely if
  the tape was idle (`:590`). **A pattern that ends mid-loop will jump.**
- **`pubScrubRate` is write-only** (`sl_tape.h:132`) — no getter, no HotFrame
  slot, no reader anywhere. Any on-screen rate readout needs a new accessor.
- **Every `slTape scrubTo` today is a full JSON round-trip over the WebView
  bridge.** Fine for a hand; **definitively not a scratch transport**.
- **`HostParams` is not an APVTS**: a hand-written 131-entry C table
  (`HostParams.cpp:31-54`), **append-only frozen**, addressing grid tracks and
  deck 0. **There is no tape lane.** And ScoopyTape's own parameter IDs are
  still unsigned (`TAPEPLUGIN-KICKOFF.md` §8) — that item now blocks two
  features, not one.

### 4.6 Audio quality — a known, accepted risk

The scrub reader is **2-point linear interpolation** (`sampleLerp`,
`sl_tape.cpp:639`). Scratching drives ±4× excursions with a measured mean pitch
span of 2109 cents per tone — the worst case for a 2-point interpolator.

**D-WZ-VARISPEED-01 already signed** an adaptive converter (SINC_MEDIUM while
moving, SINC_BEST when parked ~250 ms, identity at exactly 1.0) that was **never
built on the tape path**; libsamplerate is vendored but unused in production.

Per decision 2: **build on linear, then A/B real scratch gestures.** If aliasing
is audible, the cheap intermediate is cubic Hermite (the core already has that
path for grid voices) before the full adaptive machinery.

---

## 5. Reaching every product — why this starts with a block

`D-SL-STUDIO-01 L1`:

> A **face** is a layout; a **block** is a component. **Faces compose blocks; a
> face never rebuilds a block.** Product difference lives in exactly three
> places: which blocks a face mounts, what `getCapabilities` answers, and
> `viewDensity`.

Enforced by `faces:check`.

**The looper today lives in exactly two products:** ScoopyTape (where it *is*
the product) and the **frozen** plane (a 48 px lane, `Strip.tsx:984`). It is in
**neither Studio, ScoopyDeck, nor the companion**, and `PluginTapePanel.tsx` is
a hand-wired face that **mounts no block at all**.

So adding scratch to `PluginTapePanel` would build it into the one product it
already lives in *and* violate L1. **Carve `TapeRow` first.** Studio's step S8
already needs exactly that carve (*"mount `PluginTapePanel`'s tree as a
collapsible bottom row — `TapeWave` already takes an optional height for exactly
this"*), so doing it here hands S8 a finished block and makes scratch reach both
products by construction.

Also binding:
- **L2 — one preset home.** Scratch patterns are preset state and go to
  `D-SL-PRESET-01`'s home, not a fourth one.
- **Availability is `getCapabilities`, never "which face am I in"** —
  `schema.ts:364`, `capabilitiesStore.ts:16`, `SlDispatch.cpp:64`,
  `browserLink.ts:360`, with the schema version bumped in **two** places under
  `schema:check`. The companion's WASM path has **no tape at all**, so the block
  must render **inert with a stated reason** (DESIGN.md §6/§7), never broken.
- ⚠️ Any new `faces:check` rule must have **no known false positive** — the
  gate's own header records that "does this face re-declare the transport?" was
  measured and rejected because the glyphs appear legitimately in tooltips, in
  prose, and as `PluginTapePanel`'s own transport.

---

## 6. The data model, and the open questions

### The model

A technique is a **pair of lanes over one normalised stroke**, plus placement:

```
Technique {
  faderRest:   'open' | 'closed'
  clicks:      number[]        // positions in [0,1) within the stroke
  clickWidth:  number          // ms closed, per click
  strokeShape: 'sine' | 'asymmetric' | …   // NOT triangle — pitch is not constant
  span:        number          // fraction of the loop; measured span is SMALL
  period:      musical division // 1/8, 1/16, 1/32 — never milliseconds
}
```

Phantom clicks are **not** in `clicks[]` — they emerge from the reversal.

**Recommendation: the technique is the preset.** Choosing "two-click flare"
fixes `faderRest`, `clicks`, `clickWidth` and `strokeShape`; only **period** and
one **depth/span** control stay live. That matches TTM (a technique is a fixed
figure; tempo and placement vary), matches the plugin line's preset convention,
and keeps the surface inside one control row instead of six.

In `docs/DESIGN.md` vocabulary that is: the technique is a **`Select`** (a
choice), period a **`Stepper`** over musical divisions (the detent idiom
`stepSpeedRatio` already uses — log-spaced values step by *index*, never by
value), and depth a **`GeoRange`** — never a bare range input. Anything a
technique fixes is **not drawn at all** rather than drawn disabled, per rule 7.

### Open questions — answer these, do not re-derive them

1. **Does the phantom click already happen?** Record a hand back-and-forth scrub
   and look for the reversal notch. **Do this first — it is free and it decides
   the scope of everything else.**
2. **Release semantics.** Complete the stroke (faithful: reversals are at the
   extrema, strokes are whole units) or cut immediately (responsive)? Interacts
   with the `entry` snap in §4.5.
3. **The cue side-effect.** Should a running pattern suppress `cueFrame` arming?
4. **Y-axis law.** Linear, or a battle-curve gate with a ~5%-of-travel
   transition band and dead ground either side (§3)? The measurement says the
   latter; it has never been tried on a trackpad.
5. **Does level follow speed?** The 0.8 correlation is real and we do not model
   it. Cheap to add, changes the character a lot.
6. **Is ±4× enough**, and does the ±5.3 ms block-grid reversal jitter become
   audible on flares and crabs? If it does, the escape hatch is an **engine-side
   scratch oscillator** — phase/span/shape evaluated per sample in the render,
   like the grain scheduler — which removes the ceiling entirely at the cost of
   putting scratch knowledge inside the engine.

### Staged path

1. **Measure the phantom click** (question 1).
2. **Carve `TapeRow`** + its `faces:check` rule; mount in Studio and ScoopyTape.
3. **Record hand only, no gate** — generator in `processBlock` posting
   `scrub_to`. **Zero engine change**, and it already delivers baby, scribble
   and stab. Proves the concept audibly before any ABI work.
4. **Sign the D-WZ-RAMP-01 exception**, then build the gate → chirp,
   transformer, flare, crab, orbit.
5. Scratch mode's X/Y pad inside the block.

---

## 7. Provenance

**Consulted** (all freely available, staged at `~/reference/scratching/` with
full citations in its `SOURCES.md`):

- **TTM v1**, Carluccio / Imboden / Pirtle, 2000 — © 2000 John Carluccio. Used
  for the technique taxonomy, the click and open/closed-fader concepts, and the
  phantom click. **Cited and paraphrased; never vendored.** The table in §2 is
  *our* encoding of publicly documented behaviour, not a copy of the booklet's
  figures.
- **Hansen, Fabiani & Bresin**, *Analysis of the acoustics and playing
  strategies of turntable scratching*, KTH — the source of nearly every number
  in §3.
- **Hansen & Bresin**, *Analysis of a genuine scratch performance*, GW 2003 /
  LNCS 2915 — the crossfader-curve measurement and the reversal statistics.
- **Hansen**, PhD thesis, KTH 2010 — context, and **Skipproof**, the Pure Data
  virtual turntable that models these techniques for high-level control. Direct
  prior art for this feature; its aim is stated as letting non-experts *"play
  expressively within the stylistic boundaries of DJ playing practices."*

**NOT consulted or copied:** no DJ-software source (Serato, Traktor, Mixxx) was
read. **The Skipproof Pd patch was not obtained or transcribed** — it is cited
as prior art for the *concept*, never as an implementation to follow. Nothing in
this spec is a transcription; it is built from published descriptions of
externally observable behaviour plus our own engine's measured characteristics,
which is the same rule `plugins/scoopy-pulsar/docs/PROVENANCE.md` applies to
nuPG.

**Keep this current:** if a new source is consulted, add it here and to
`~/reference/scratching/SOURCES.md` in the same commit.
