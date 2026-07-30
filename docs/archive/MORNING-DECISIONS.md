# Morning decisions — for the user, 2026-07-24

> ## ✅ ALL DECIDED — 2026-07-24
> Every open decision below was answered (each matched the recommendation) and **signed into
> `docs/DECISIONS.md`**: D-WZ-PDCANVAS-01 (adopt the unified Cell UI, sequence
> PD-CANVAS-01..05) · D-WZ-TAKE-01 (timestamped take names) · D-WZ-MON-01 (monitor default
> ON, no auto-mute of the source) · D-WZ-VARISPEED-01 (adaptive converter tier) ·
> D-WZ-WATCHDOG-01 (+6 dBFS / 250 ms RMS) · D-WZ-DEVGONE-01 (fall back to default + loud
> notice) · D-WZ-RINGRECOVER-01 (adaptive ring growth now, servo later behind a soak
> fixture). The five gated ledger rows are unblocked (P3-10, P4-08, P4-09, P7-08, P2-03a)
> and PD-CANVAS-01..05 build rows are seeded. **The queue below is kept for the record.**

*Queue built by the autonomous loop overnight. Each entry states the question, the options
with trade-offs, and my recommendation. All are now signed (see banner).*

## 1. ⭐ THE BIG ONE — UI vision: one unified item, freely arranged

**Your words (2026-07-24):** *"free arrangable players / decks / input in a field, only
one item, no separated input and deck channels — our vision needs improvement."*

This is a **product-shape change**, not a tweak, so it wants your sign-off before it
touches built code. Today's console is a fixed console: a sources rail, a horizontal
channel rack, a deck rack, a monitor section. Your direction collapses that into **one
object type on a freely-arrangeable canvas** — closer to GRM Player's workspace of
"readers", and honestly closer to what Wizard *is* (CONCEPT's own law says *everything is
a channel*; the current UI violates that by splitting inputs from decks).

**What it would mean concretely**
- **One item** ("Cell"? "Player"? — naming is part of the decision): binds a Source
  (input · app tap · file · deck · another cell's output), and *optionally* records/loops.
  An "input strip" is just a cell with no recording; a "deck" is a cell that has recorded.
  The schema already supports this — `Channel.source.kind` already includes `deck`; the
  split is purely a UI artifact.
- **Free placement**: x/y position + size per cell in the Patch (`uiMode` becomes a
  layout, not a mode). Spatial arrangement carries meaning (group by role, by song part).
- **What we'd lose/keep**: the fixed-width rack's scannability, and the strip-mode
  collapse (CONCEPT §6) would need rethinking as "zoom out" rather than "different
  layout".

**Cost (now spelled out concretely — this brief is a summary; the plan is the source):**
- **Engine: zero.** Geometry never crosses the ABI; the engine has never known where a
  strip is drawn. `protocol:check`/`abi:check` see no change.
- **Schema: additive, and NO array merge** — the load-bearing finding of the later passes.
  `Channel` is *already* the one strip type (`source.kind` = deviceInput | appTap | deck |
  busTap …) and `decks[]` is just material storage, not a second species. So "one object
  type" is a **rendering** change, not a data-model change. PD-CANVAS-01 adds only
  `cell{x,y,w,h}` on Channel + `plane{scale,panX,panY}` on Patch + one SCHEMA_VERSION bump
  with a named auto-layout migration (§7 of the plan gives the exact Zod).
- **UI: ~600 lines of panels rewritten to `Plane` + `Cell` + `Inspector` + drawers**
  (+~150 for the Inspector; the routing matrix's per-strip bus choice largely *moves into*
  the Inspector rather than being rebuilt). All logic (usePatch, takeAlign, MeterCanvas,
  faderCurve, VarispeedSlider, DeckWaveform) is reusable as-is.

**My recommendation: ADOPT.** A full design plan is now written and has been deepened over
three research passes: **`docs/specs/pd-canvas.md`** — read that, not this summary.
Headlines that changed since this brief was first drafted:
- **The GRM manual was found and read in full** (public HTML at sites.inagrm.com). Its
  workspace is literally *"un plan sans limite apparente"* with drag placement + zoom/pan.
  **Your instinct matches a shipping instrument's model.**
- **The "clutter" objection is answered (§3.0).** Putting *every* control on every Cell is
  unbuildable — a plane of a dozen Cells each showing loop points + bus + cue would be less
  legible, not more. GRM's real answer (which we'd misread): the Cell carries what you
  touch *while playing*; an always-visible, selection-driven **Inspector** carries what you
  set *precisely*. Not a hidden mode. This also gives "strip mode = zoom-out" its mechanism
  (a strip Cell is just the Cell's left column).
- **Two futures, deliberately out of the first cut:** PD-CANVAS-2 = GRM's N-readers-on-one-
  sound (granular; our decks already do this — it's UI+scheduling, not new DSP); PD-CANVAS-3
  = GRM's A/B/C/D snapshot slots with a glide time ("instrument, not mixer").

**Decide:** (a) adopt, sequence as **PD-CANVAS-01..05** (schema → Plane+Cell → Inspector →
drag-to-create → retire old panels) · (b) adopt **and** pull the N-readers model (CANVAS-2)
into the first cut · (c) refine the vision further before committing. My rec is **(a)** —
ship the free-placement + one-item model first; add readers/snapshots once it's proven.

## 2. Take naming + storage layout (needed by P3-05/07, soon)

When a deck stops recording, the file needs a name and a home.
- (a) `Takes/deck1_2026-07-24_14-32-05.wav` in the session package (Scoopy's STORED-zip
  discipline; P7 formalizes the package) — **recommended**, self-describing, sorts by time.
- (b) Content-hash names (dedupe-friendly, unreadable to humans).
- (c) User-prompted name at stop — kills the flow of a looper.

## 3. Monitor-while-recording default (P3-03, soon)

CONCEPT says per-deck monitoring is "optional/switchable". Default?
- (a) **ON** — you hear what you're capturing; the looper expectation. **Recommended.**
- (b) OFF — avoids doubling when the source is already audible through its own strip
  (which it *is*, in Wizard — the deck records a strip that's already in the mix).

Sub-question this exposes: when a deck records a strip that's already audible, do we
mute the source strip during recording (like a channel-to-tape console), or accept the
doubling? My instinct: **accept it** (no hidden state changes), and let the user mute.

## 4. GRM Player manual — DONE (no longer blocked on you)

Found it: the official documentation is public HTML at
`sites.inagrm.com/download/grmplayer/documentation` (I had been defeated by the
JS-shelled marketing page and the Scribd copy). Read and mined into
`docs/specs/pd-canvas.md` §2 with direct quotes: the boundless-plane workspace, drag
placement, zoom/pan, the sequence/player split, Single Player vs Player × n, and the
window-span → granular continuum. Nothing further needed from you here.

## 5. Live varispeed converter tier (P4-02, soon)

A deck bending speed live needs a streaming resampler. GRM Player's bar: "the slower a
sound is played, the more accurately it is resampled" — clean at 1/100, 1/1000 speed.
- (a) **SINC_MEDIUM while the rate is moving, SINC_BEST once it's been stationary
  ~250 ms, identity (no resampler at all) at rate 1.0** — **recommended**: cheap during a
  sweep, mastering-grade for the common "set a speed and leave it" case, and bit-exact
  when you aren't bending at all.
- (b) SINC_BEST always — simplest, most CPU during sweeps (8 decks sweeping at once is
  the worst case).
- (c) SINC_MEDIUM always — lightest, gives up quality on a parked extreme slow-down.

## 6. Feedback-watchdog threshold (P4-04, soon)

External feedback loops (out → another app → "Wizard Out" → back in) are structurally
undetectable; the watchdog is the only guard.
- **Proposed (from ARCHITECTURE §2): engage a ramped hard limiter + raise the alarm when
  bus RMS exceeds +6 dBFS sustained over 250 ms**, releasing only after a hold period
  below threshold. RMS-not-peak so a single transient never trips it.
- Alternatives: a lower threshold (0 dBFS) trips earlier but risks false positives on
  loud legitimate material; a shorter window (100 ms) reacts faster but is twitchier.

---

*Loop status: **P3 is BUILD-COMPLETE** (recorder, C-3 handoff, crash-safe takes, C-2
align, cap, UI, take management) — only P3-10 (decision #3) and the human gate P3-G1
remain. **P4 playback composer is open**; its spec landed and rows are seeded. Parked:
P2-05/06/07 (your machine + TCC runbook + Linux). CI: blocked on GitHub Actions billing.*

---

## Decision #7 — what a session does when its audio device is gone

**Found by:** P7-AUDIT. Blocks P7-08.

`sessions.md` §1 says device selection belongs in the session, "as a name + a fallback,
so a session opened on another machine **degrades, not fails**". Today it is not saved at
all — reopening a session always lands on the default device. That is safe but forgetful:
your interface selection does not survive a quit.

Saving it raises the question the spec left open — what happens when the named device
is not there (a different machine, or the interface simply unplugged)?

| | option | what you get | cost |
|---|---|---|---|
| **A** | **Fall back to the default device, silently** | always makes sound | you can be recording to the wrong input without noticing — the failure Wizard exists to prevent |
| **B** | **Fall back to the default device, and say so loudly** | always makes sound, and a banner names the device it wanted vs the one it got | one more notice to read |
| **C** | **Open with no device until you choose** | never records the wrong input by accident | a session can open silent, which feels broken if you forget why |
| **D** | **Remember per-machine**: each machine keeps its own device choice for the same session | a shared session works on both machines with no fuss | more state, and it is invisible — hard to explain when it surprises you |

**My recommendation: B**, with **D** as a later refinement. B is the same posture the app
already takes everywhere else (the vanished-source strip, the unresolved deck): keep
working, keep the reference, and *say* what changed. C is the puritan reading and I think
it is wrong here — an app that opens silent teaches you to distrust it.

The reason this is yours and not mine: A vs B vs C is a judgment about how loud Wizard
should be when the world changed underneath a session, and that is a taste call about
your app.

---

## Decision #8 — how a source ring recovers latency after a one-time upset (P2-03a)

**Found by:** the loop reaching P2-03a (ring-fill re-centering). This is an audio-quality
control-law call, so it is a decision, not a silent implementation — the last time I tuned a
ring servo by feel (the ASRC PI trim) it fought the feedforward path and I had to tear it
out. I will not re-introduce that class of bug unattended.

**The situation.** The ASRC holds long-term rate perfectly (feedforward: 0.0002 ms/hr). But
a *one-time* upset — a device format change, a glitch, a scheduling stall — can leave a
source ring sitting at the wrong fill level (extra latency, or dangerously close to
underrun). Pure feedforward matches the *rate* going forward but never re-centres that
one-time offset. The question is what, if anything, should pull it back.

| | option | behaviour | risk |
|---|---|---|---|
| **A** | **Leave it (status quo)** | the offset persists; latency is a few ms off until the source is re-armed | none — but a bad upset stays bad for the whole session |
| **B** | **Slow fill servo, average-based** | a gentle bias nudges the ring back to target fill over seconds, driven by *average* fill so it is immune to per-block sawtooth and cannot fight the feedforward rate | a servo is exactly what bit us before; must be average-based + rate-limited, and proven by a soak fixture |
| **C** | **Adaptive ring growth (D-WZ-CLOCK-01)** | on sustained underrun the ring grows 1.5×→3× and logs it; never shrinks | recovers headroom but not latency; a grown ring adds permanent latency |
| **D** | **One-shot re-centre on detected upset** | only on a *flagged* discontinuity (format change/glitch), resnap fill once; no continuous servo | needs a reliable upset signal; silent if an upset goes undetected |

**My recommendation: C now, B later, both behind a soak fixture.** C is the safe,
already-signed mechanism (D-WZ-CLOCK-01) and handles the dangerous direction (underrun) with
no control-law subtlety. B is the "right" answer for latency recovery but only earns its
place once there is an hour-long soak fixture proving it never fights feedforward — the same
bar `asrc_drift_test` set. D is elegant but only as good as its upset detector.

Why this is yours: A vs B vs C/D is a judgment about how hard Wizard should work to claw
back latency versus how much control-law risk that is worth — a taste call about the audio
path, which you asked to sign.

---

# New queue — seeded 2026-07-24 evening (virtual-interface routing + looper + global recording)

> ## ✅ ALL DECIDED — 2026-07-24 (same evening)
> All four answered and **signed into `docs/DECISIONS.md`**: D-WZ-VDEV-01 (#9: 16ch, 8
> stereo pairs — the recommendation) · D-WZ-MON-02 (#10: auto-close on loop handoff,
> overdub stays live — the recommendation; amends D-WZ-MON-01) · D-WZ-OVERDUB-01 (#11:
> **mix-into-buffer** — the user chose destructive sound-on-sound over the auto-new-deck
> recommendation; the drain side still files every pass as a crash-safe take) ·
> D-WZ-GREC-01 (#12: **record-time mode** — sum-only or multitrack, the user's own
> variant of option (c): the choice moves from per-strip arming to one mode picked at
> record start). Rows P5-00/P3-12/P7-GREC closed; build rows P3-13, P5-01, P7-GREC-01
> seeded. **The queue below is kept for the record.**

> Seeded from your evening concept session. Framing you set:
> *"all strips within wizard are equal and just receive audio input from a selected
> source (live input, recorded / loop, loaded file)"* — the virtual interface routes
> audio from **any** app, Loopback-style; there is no app-specific bridge (ScoopyLoops is
> just one app that routes in, and stays the P5 gate example). Ledger rows: P5-00,
> P3-12, P7-GREC.

## 9. Virtual-interface channel count (P5-00 — the already-anticipated decision row)

The P5 roadmap has always carried "channel-count decision row (2ch vs 2×2ch vs 16ch)".
Your concept now gives it real context: apps route **one or many stereo pairs** into
Wizard (a DAW's stems, ScoopyLoops' individual decks and FX outs), and each pair lands as
its own equal strip (`source.kind = virtualDeviceInput` — already in the schema).

- (a) **One 16ch device (8 stereo pairs)** — one "Wizard Out" in every app's device
  list; an app that can address output channels routes each feed to a pair; Wizard maps
  pair *n* → strip. Simplest install, richest routing. Cost: apps that only ever write
  channels 1–2 use one pair and the rest sit idle; per-pair *source app* attribution is
  not knowable from the device alone.
- (b) **N × 2ch devices ("Wizard Out 1..4")** — each app (or each feed) picks its own
  device, so attribution is per-device and dumb stereo-only apps can still occupy
  separate strips. Cost: N drivers to install/sign, device-list clutter, N is a hard
  ship-time constant.
- (c) **2ch only** — the minimum that passes the P5 gate; multi-pair routing deferred.
  Cheapest driver work now, but the concept above is then blocked on a *second* driver
  release, and driver releases are the most expensive kind (signing/notarization/install).

**My recommendation: (a) 16ch**, because it makes multi-pair routing a v1 property for
the cost of a channel-count constant in the same driver, and (c)'s deferral lands on the
most expensive release path we have. (b) only if per-app attribution proves essential.

## 10. Monitor handoff on loop close (amends D-WZ-MON-01; feeds P3-10)

**Your words (2026-07-24):** *"recordings with live looping can stop the monitoring
playback but we should also be able to stack / overdub loop recordings keep the input
live."*

D-WZ-MON-01 (signed this morning) says: monitor defaults ON, recording never auto-mutes.
The refinement: at the C-3 record→loop handoff, auto-close the deck's `monitorSwitch` so
the loop replaces the live input in the same block — except in overdub mode, where the
input stays live against the loop. Full option analysis in `recorder.md` §9.

- (a) Keep the signed behavior (no automatic state change, user flips the switch).
- (b) **Auto-close on loop handoff, stay open in overdub mode** — matches your words.
- (c) Per-deck preference (default = b).

**My recommendation: (b)**, revisiting as (c) only if a real session shows both habits.
This is a *performance-feel* call — exactly the class D-WZ-MON-01 said you sign.

## 11. Same-deck overdub model (new engine design; recorder.md §9)

There is no way today to layer into a looping deck — "stacking" means other decks.
Options with full trade-offs in `recorder.md` §9: (a) **mix-into-buffer** (destructive
sound-on-sound, cheapest, no undo) · (b) **layer list** (non-destructive, undo = drop a
layer, but multiplies RAM against the 256 MB cap → D-WZ-DECK-01 amendment needed) ·
(c) **auto-new-deck** (zero engine change, full undo, burns decks).

**My recommendation: (c) now, (b) later.** (c) is one UI verb over machinery that is
already fixture-proven, so overdub works the day it's signed; (b) is the real instrument
feature and deserves its own increment once the cap amendment is thought through. (a) is
the only irreversible option in an app whose take-management already refuses to destroy
anything (P3-11 moves to Trash, never unlinks) — destructive-by-default fits Wizard badly.

## 12. Global recording policy (→ D-WZ-GREC-01; spec draft at docs/specs/global-recording.md)

**Your words (2026-07-24):** *"global recording in wizard records full stereo sum of
entire app but also a session like multi-track with added timestamps so all channels can
be easily rearranged in a DAW with correct timings when they were activated."*

D-WZ-DECK-01 explicitly reserved this: long-form capture "is a new, separately-signed
policy". The draft spec proposes: master sum = crash-safe BWF of bus 0 post-fader;
multitrack = Law C-2 stamps written as BWF TimeReference against a common record-start
origin (P3-04 already writes the stamp into the file — a DAW's "import at original
position" then reconstructs the session by itself). The fork is what captures per strip:

- (a) Continuous per-channel capture for every active strip (true multitrack, ~1 GB/h
  per stereo file).
- (b) Sum + manifest of existing deck takes (near-free, but streamed-through material
  exists only inside the sum).
- (c) **Sum always + per-strip "session-arm" toggle (default off)** for continuous
  capture — degrades to (b) unarmed, reaches (a) fully armed, honest about disk.

**My recommendation: (c).** Full costs and fixtures in the spec draft.
