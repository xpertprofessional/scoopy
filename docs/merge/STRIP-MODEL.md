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

A strip can hold **grid + tape together** — a scoopy deck with a looper recording
the deck's own output.

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

## Open questions
- **Input strips and the channel bus:** does a live-input strip get the full
  channel DSP + sends immediately (run an input through master DRV, and record
  *that* into a tape)? If yes, "record the input" and "record the deck output"
  are literally the same tap on the channel bus — the cleanest outcome. (Awaiting
  the user.)
- The `LOOPER-DESIGN.md` sub-questions: overdub semantics (reuse signed
  D-WZ-OVERDUB-01?), and loop-length↔tempo quantize on capture.

## Engine status against this model
- **Grid (§6):** built — multi-deck sessions, per-deck BPM, master sync
  (`sl_deck_set_tempo_sync`), add/drop a deck (`sl_deck_clear`).
- **Tape (§5):** NOT built — the next big engine chunk. Transplants wizard's
  `wz_deck_*` (record/scrub/varispeed/loop/overdub/takes) into the merged engine
  under `sl_` names, per SL-ABI-V3 §5. All that machinery is already written and
  tested in wizard's donor engine.
- **Channel:** the 4 sends + master drive/clipper already exist in scoopy's core;
  wiring them as the uniform strip channel is UI + ABI exposure.
