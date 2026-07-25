# Looper / recorder in the merged strip model — methods to decide

*Design brainstorm, 2026-07-25. Open question, not a decision. Decides how the
looper/recorder relates to a scoopy session inside a plane strip.*

## What's already settled (user, 2026-07-25)

- A **strip** = a **source** + a shared **channel** (level · 4 FX sends · master
  DSP e.g. DRV · tempo · record). Every strip type gets the same channel.
- The looper is **part of a strip** and **coexists with a scoopy deck** — a strip
  can have a deck AND a looper; the looper can record its own source.
- **Scoopy's per-deck transport + time-stretch become the strip's playback
  controls**, available to every strip type (deck, looper, file, input).
- The plane **replaces scoopy's DJ deck view**; scoopy's compose view is untouched.

## The deciding constraint

The recorder must be able to capture the **sequencer output** — the deck's mixed
audio, not just a live input. "Record the sum of the tracks" is a **bus tap**
(post-deck-mix), which is inherently a strip/bus operation, not something a track
*inside* the grid can do without eating its own session's output (feedback) and
needing a careful pre-this-track tap. **This one requirement is what separates
the methods below.**

A second constraint: a **continuous loop** is not a stepped grid trigger. The
grid sequences sampler tracks at step boundaries; a loop is one continuous span.
Forcing a loop into the step grid (Method B) fits awkwardly.

## The methods

### Method A — Looper is a strip-level recorder + loop, beside the session (RECOMMENDED core)
The strip owns a recorder that taps one of: a live input, the **strip's output
bus** (= the deck's sequencer output), or a global mix. It records into a strip
**loop buffer** and plays it through the strip's transport (time-stretchable to
tempo). The session grid stays pure — a grid of sampler tracks, unchanged.
- **+** Sequencer-output recording is clean (tap the output bus, no session-internal feedback).
- **+** Reuses wizard's existing, SIGNED record model (deck record, overdub = destructive mix-into-buffer, global record) directly.
- **+** Loop rides the strip's deck-transport (play/stop, bpm-sync, time-stretch) for free — your point #3.
- **−** A strip can then hold two playback layers (a deck grid + a loop). Arguably fine (layering), but it is two things in one strip.

### Method B — Looper is a special session TRACK TYPE (recorded-audio row in the grid)
Your "a track row that specifies recorded audio." The grid gains a track type
that holds a captured loop instead of a sequenced sampler.
- **+** Reuses scoopy's per-track mixer/sends/mute/solo — the recorded track is first-class in the grid.
- **−** **The sequencer-output trap:** a track recording the sum of the *other* tracks is a track eating its own session's mix — needs a pre-this-track tap and feedback guards. This is the hard part and it lives right in the session model.
- **−** Loop-vs-step mismatch: a continuous loop isn't a stepped trigger; it only fits as "one long sample triggered at step 0, looping," which strains the grid paradigm.
- **−** Recording a live INPUT into a session track turns the session into a capture surface, changing its nature.

### Method C — Record → Take → Sample, played by a normal session track (existing flow)
Recording (strip-level tap) produces a **take** (WAV); the take loads as a
**sample** into an ordinary sampler track, looped via the track's existing
loopEnabled/loopStart/loopEnd params.
- **+** Cleanest reuse — no new track type; the loop is "just another sample"; sync/stretch via existing track params.
- **+** Recording stays strip-level (clean bus/input tap), only the *result* enters the grid.
- **−** Not live looping — record-then-load is a beat late (though wizard's overdub gives live-ish capture).

### Method D — Hybrid: Method A core + Method C "promote to grid" (RECOMMENDED overall)
Recording is strip-level (Method A's clean tap + wizard's overdub/take engine).
The captured loop plays as a **strip loop layer** immediately (live looping).
When you want it *in* the session — sequenced, mixed as a track — you **commit
the take to a session track** (Method C). Separates the two concerns cleanly:
- **Capture** is always strip-level (bus/input tap) — no session-internal feedback, works for sequencer output.
- **Playback** is either a strip loop (live, layered) OR a promoted session-track sample (sequenced in the grid).

## Recommendation

**Method D** (Method A as the core, Method C as the "fold into the grid" path).
The single deciding fact is that recording the sequencer output is a **bus tap**,
which is a strip-level operation — so the recorder belongs to the strip, not to a
grid track. Method B puts the recorder where the feedback/paradigm problems are
worst. Keeping **capture (strip-level) separate from playback (strip loop vs
promoted grid track)** gives you live looping, clean sequencer-output recording,
DRV/tempo on the loop for free (it rides the channel + deck transport), and the
scoopy grid stays fully intact — with an explicit door to move a loop into the
session as a normal track when you want it sequenced.

**Open sub-questions if we go Method D:**
- Overdub semantics for a strip loop: reuse the SIGNED D-WZ-OVERDUB-01 (destructive mix-into-buffer, still drains to a crash-safe take)?
- Does a promoted-to-grid loop keep a link back to the strip loop, or is it a one-way copy?
- Loop length ↔ tempo: does capture quantize the loop to bars at the strip's bpm (so it stays in sync when tempo changes)?

## The resolution — TWO playback engines, not one (user, 2026-07-25)

The user surfaced the flaw in "a loop becomes a grid track": a grid track is
DISCRETE (stepped triggers), so it **loses scrubbing** — and "record my session
output and scrub on it" is a first-class want. Forcing recorded audio onto the
grid throws away the continuous-audio powers (scrub, varispeed, loop-region,
overdub) that make a recorder worth having.

The resolution is that the merged system already has **two playback engines**,
and they are BOTH first-class — this is exactly what SL-ABI-V3 designed:

- **§6 — the scoopy SESSION/GRID:** sequenced sampler tracks, discrete step
  triggers, patterns, chop. Composition. (Built.)
- **§5 — the wizard TAPE-DECK:** a continuous audio buffer with a playhead —
  record, **scrub**, varispeed, loop-region, overdub, crash-safe takes. This IS
  the looper/recorder. (Transplants from wizard's donor engine; NOT built yet.)

So the answer to "are record and loop the same source?" is **yes** — they are the
**same continuous tape-deck buffer.** You record into it; the "loop" is a region
(start/end) of that same buffer, played continuously — so it is scrubbable,
varispeedable, overdubbable, exactly like a wizard deck, because it IS one.

**A strip can hold BOTH:** a tape-deck (record / scrub / loop of continuous
audio) AND a scoopy grid (sequenced composition). They coexist, and audio flows
between them:

- **Record + scrub + loop** live in the **tape-deck** (§5, continuous) — no
  scrubbing lost, because the recorded audio never had to become a grid track.
- **Carve a region → a grid track** (§6) only WHEN you want it sequenced/chopped
  in the composition. That is the one-way bridge that "changes session content."

This keeps every scoopy grid power AND every wizard tape power, in one strip,
with a clear door between them. Method D still holds — it just names the strip
loop as a wizard tape-deck (§5) rather than a vague "loop buffer."

**Consequence for the engine:** the merged engine needs §5 (wizard's deck
surface — record/scrub/overdub/loop of a continuous buffer) transplanted in
alongside §6 (built). SL-ABI-V3 §5 already specifies this 1:1 from wz_deck_*.
That is the next big engine chunk.

**Persistence:** recorded audio persists as wizard's crash-safe **takes** (WAV),
referenced by the session/plane-map — reusing wizard's take system + scoopy's
kit/session. A carved grid track references the same take as a sample. So one
recording underlies both the scrubbable tape-deck and any grid track carved from
it — no duplicate audio.
