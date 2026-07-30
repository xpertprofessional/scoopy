# The merged strip model

*Converging design, 2026-07-25. Captures decisions reached with the user in the
plane/looper design conversation. Companion to `LOOPER-DESIGN.md` (the tape-deck
detail) and the mission in memory `merge-mission`.*

## A strip = a uniform CHANNEL + composable ELEMENTS

A strip is not a fixed "type" (deck-strip vs looper-strip). It is a **uniform
channel** with **elements added into it**. It starts **empty** — a channel with
an "add" affordance — and you drop in what you want.

### The channel (always present)
Identical for every strip, whatever it hosts:
- level
- the **4 FX sends** (moved out of scoopy's DJ view into the plane)
- **master DSP** (e.g. DRV / drive) — reaches every strip, not just full decks
- **transport + time-stretch** — scoopy's per-deck transport becomes the strip's
  playback controls, available to every strip type
- output routing
- **record-arm** — the capability is universal (see tape below)

### The elements (added on demand) — two content engines + input
- **Grid** — a scoopy session (sequenced sampler tracks). The composer engine
  (SL-ABI-V3 §6, built).
- **Tape** — a wizard tape-deck: a continuous audio buffer with a playhead —
  record / **scrub** / varispeed / loop-region / overdub / crash-safe takes. The
  looper/recorder engine (SL-ABI-V3 §5, NOT built yet — transplants 1:1 from
  wizard's `wz_deck_*`).
- **Input** — live audio into the channel (and recordable into a tape).

**A file player is just a tape loaded from a file** instead of from a recording —
same element, different fill. So "looper" and "file player" are one thing. The
model reduces to **two content engines (grid + tape) + input**, composable per
strip.

### Record capability universal, tape element on demand
Every strip *can* record (record-arm is part of the channel), but the **tape
element materialises when you arm/record** — it does not sit there empty on every
strip. So a fresh or pure-input strip carries no dead tape-deck; hitting record
creates the tape. Capability everywhere, clutter nowhere.

~~A strip can hold **grid + tape together** — a scoopy deck with a looper recording
the deck's own output.~~ **AMENDED by D-SL-MORPH-01 (user, 2026-07-29): strips are
ONE KIND EACH — a grid (session) strip or a looper (tape) strip, never both in one
strip.** The use case survives as **two routed strips**: the grid strip's bus
patches into a looper strip's record tap (ROUTING-MATRIX; P3-R1..R3). REC on a
grid strip spawns/targets its linked looper strip instead of growing a tape
element in place. Everything else in this section (uniform channel, element
composability at the model tier, record-arm universality) stands.

### Presets keep the quick-looper fast
Empty-start would slow the "quick looper" want, so: **presets.** "New looper
strip" = channel + tape armed (one click). "New deck strip" = channel + grid.
Flexibility for power users, presets for speed.

## Recording ↔ grid: capture is strip-level, playback is a choice

(Full rationale in `LOOPER-DESIGN.md`.) Recording the sequencer output is a
**bus tap**, so capture lives on the strip/tape, never inside a grid track
(which would eat its own session's mix and lose scrubbing). The captured audio:
- plays as a **continuous tape** (scrub/varispeed/loop) — nothing lost; OR
- is **carved (start/end region) → a scoopy grid track** when you want it
  sequenced/chopped in the composition. This one-way bridge changes session
  content.

### Carve frees the tape-deck (DECIDED)
Carving a region into a grid track **frees the tape element** (clears it for the
next capture) — carving is a commitment to the grid, and keeping both playing
would double the same audio. **Nothing is lost:** everything is one persisted
crash-safe take; the carved region becomes the grid track's sample and the FULL
take stays in the take library, reloadable into a tape later. Freeing = clearing
the layer, not destroying the audio.

To *keep* scrubbing a recording, simply don't carve it. Carving = "done
performing this live; make it a composition element."

## Persistence
Recorded audio persists ONCE as a wizard crash-safe **take** (WAV), referenced by
the session / plane-map. The scrubbable tape and any grid track carved from it
point at the **same** take — recording never bloats the session, and a carved
track is "this take, as a sampler sample." Reuses wizard's take system +
scoopy's kit/session.

## Input is a full channel citizen (DECIDED)

A live-input strip gets the **full channel** — level, the **4 FX sends**, master
DSP (DRV), the lot — exactly like a grid or tape strip (user, 2026-07-25). So an
input can feed FX 1–4, run through master drive, and be recorded *after* all of
that into a tape.

**The consequence that closes the model: there is no special-case recorder.**
Recording is always "capture this strip's **channel bus**" — and the channel bus
is the same whether the source is a grid (sequencer output), a live input, or a
file. "Record the input" and "record the deck output" are literally the same
operation on the same bus. One tap, one code path, every source.

## The lane budget — what bounds how many decks there are (user, 2026-07-25)

Rather than an arbitrary deck count, the mixer has a **content budget of 8 mono
lanes (4 stereo)**, and each element spends from it:

- a **grid** deck is inherently stereo → **2 lanes**
- a **tape** may be mono → **1 lane**, or stereo → **2**

So a plane holds 4 stereo decks, or 3 stereo grids + 2 mono tapes, or any other
combination that fits. The limit stops being a number to remember and becomes the
same thing it is on a hardware mixer: how many channels you have left.

**FX returns sit OUTSIDE the 8**, as fixed infrastructure — the mixer's 4 stereo
aux returns — because a budget that let an FX silently cost you a deck would
punish using the effects. Main and cue are the output section, likewise outside.

Enforced at the **document/publish** level (sum of active element widths ≤ 8), not
in engine array sizes: the engine keeps capacity for 8 tapes regardless, so the
policy stays a line of validation to tune rather than a rebuild. It also describes
today's reality for free — the pinned core's 3 grid decks are 6 lanes, leaving 2
mono tape lanes.

## Resolved sub-questions

- **Overdub:** reuse the signed D-WZ-OVERDUB-01 unchanged — destructive
  sound-on-sound (SUM/REPLACE) into the buffer at the playhead, with every pass
  still draining to its own crash-safe stamped take, so the material survives on
  disk even though the pre-mix buffer does not. **Built** (SL-ABI-V3 §5). One
  addition the port makes explicit: overdub reads its input during the playback
  pass, which runs before the mix exists, so a **mix-sourced overdub is refused**
  rather than silently layering the previous block.
- **Send tap point:** the strip's record tap is its **channel output** —
  post-element, post-DRV, post-level — with sends **post-fader** by default. A
  recorded tape is therefore dry of the global FX returns (a return is a global
  lane, not part of one strip's output); routing a return into a strip is how you
  record the wet, and capturing the whole processed sum is the separate `mainMix`
  record source. Reasoning in `ROUTING-MATRIX.md`.
- **Loop-length ↔ tempo quantize on capture:** deferred with SL-ABI-V3 §7 (the
  master transport). P2 ships immediate capture, which is wizard's proven
  behaviour; bar-exact capture needs a beat clock to be exact against.
- **Looper transport parity (queued 2026-07-29, D-SL-DECKFULL-01):** one-kind
  strips stand unchanged — the looper/tape strip stays its own strip, as it is
  today. What it gains LATER is deck-like transport: the user's own example was
  "same transport possibilities like scoopy transport (i.e. rate slider with
  fixed values)". This is the channel's "transport + time-stretch" promise above
  made concrete for tapes, deliberately deferred rather than dropped — row P7-P1,
  `blocked(user-deferred)`, opening on the user's call.
- **A grid strip's channel bus must carry its deck (defect, 2026-07-29):** this
  document's closing argument — "there is no special-case recorder … recording is
  always capture this strip's **channel bus**" — is not yet TRUE for grid strips.
  `ChannelBank::mixInto` mixes the element for tapes only, so a grid strip's bus
  is silent and the two-routed-strips path that D-SL-MORPH-01 made the ONLY way
  to loop a deck records nothing. Hoisted as row P3.5-E3 (D-SL-DECKOUT-01).

## Engine status against this model
- **Grid (§6):** built — multi-deck sessions, per-deck BPM, master sync
  (`sl_deck_set_tempo_sync`), add/drop a deck (`sl_deck_clear`).
- **Tape (§5):** **BUILT 2026-07-25** as `sl_tape_*` (not `sl_deck_*` — §6 had
  already spent that name on grid decks). Wizard's `wz_deck_*`
  (record/scrub/varispeed/loop/overdub/takes) ported into `slengine`, 21/21 entry
  points carried under a symmetric coverage gate, with the record source
  generalised from "an input channel" to a KIND — which is what makes "capture
  this bus" the same operation for every source, as this document argued it must
  be. 8 tapes, an index space independent of the 3 grid decks.
- **Channel:** **BUILT 2026-07-25** as `sl_channel_*` — level, 4 sends, mute,
  and the record tap, all ramped. It turned out to be a **projection rather than
  a mixer**: a grid deck already has a channel inside the core, a tape had none,
  so the one surface is implemented here for tapes and forwarded onto the core's
  per-deck controls for grid decks. That is this document's "identical for every
  strip, whatever it hosts" made literal without stacking a second gain stage on
  the engine that already applied one. DRV is deferred (it is already per-deck in
  the core; tapes gain it later) — see P2-KICKOFF step 2 for the reasoning.
