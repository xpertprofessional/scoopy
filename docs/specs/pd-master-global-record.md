# Master section + global record

*User direction, 2026-07-24: "we need a master section with global record, this is also
where all timestamp multitrack data is created so when we record the global we always tape
the entire map and each strip reports like a single (stereo) track. to save resource we
could create smart system that does not record silent output but notes time stamps to
reconstruct a multitrack session perfectly, if that is something to consider (just an
idea)."*

Settles the master question three reviews analysed (`pd-master-as-strip.md`,
`pd-modular-routing.md`, `pd-global-record-as-strip.md`): **the master stays a section, not
a strip.** Their reasoning holds — the master fader acts after the sum, scales all eight
buses, and sits upstream of the loopback snapshot and the watchdog; and a master strip that
gained material would be rebound to a deck source at publish and stop tapping the bus
entirely.

## 1. The master section owns the session's time origin

Global record is where `globalRecordStartSample` is minted. Every per-strip file written
during a global take carries

```
TimeReference = startEngineSample − globalRecordStartSample
```

which is D-WZ-GREC-01's rule, and it is the whole reason the result is DAW-ready without an
alignment pass: dropping every file at 0:00 in any DAW reproduces the session exactly.

**This only became true today.** P3-15 found the stamp was severed — `TimeReference` shipped
as 0 on every take — so until it was fixed, "stamped to a common origin" would have produced
a pile of files all claiming to start at zero. Global record must not be built on an
unverified stamp: `recorder_drain_test` now pins the hand-off.

## 2. Every strip is a track

"Tape the entire map": in multitrack mode each strip contributes one stereo file, whatever
kind it is — input, tap, loopback, or a deck playing material. That is the CONCEPT law
("everything is a channel") paying off at the archive layer: there is no per-kind special
case to write.

**Tap point: post-fader, per strip.** The file should be what that strip CONTRIBUTED to the
mix, not what it might have contributed — otherwise the files do not sum to the recorded
master and the archive contradicts the sum sitting beside it. (Note the deck record path is
*pre*-fader; global capture must not reuse it for this reason. See §5.)

## 3. The silence idea — worth doing, with one hard boundary

The user's idea: do not record silent output, note timestamps, reconstruct perfectly.

**It maps exactly onto machinery Wizard already has.** A take is already a stamped file. So
a strip that is quiet for a while need not write silence — it can end its segment and start
a new stamped one when sound returns. Reconstruction is then "place each segment at its
`TimeReference`", which is the same operation a DAW import already performs. No new format,
no sparse-WAV invention, no manifest: **segments ARE the representation.**

The saving is not marginal. Eight strips at 48 k stereo float is ~12 GB/h; in a real session
most strips are silent most of the time.

**The boundary that makes "perfectly" true or false:**

| Gate | Reconstruction | Verdict |
|---|---|---|
| **Exact digital zero** | bit-exact — the skipped samples were literally `0.0` | **Yes.** Safe, provable, and the common case: a stopped deck, an unbound strip, a muted strip all emit exact zeros. |
| **Threshold ("quiet enough")** | lossy — room tone, noise floor and reverb tails are discarded | **No.** A live mic is never digitally silent, so a threshold would silently truncate decay tails and change the recording. |

So: **gate on exact zero only.** It is the difference between a compression that is provably
lossless and one that quietly edits the user's audio. If a threshold is ever wanted it must
be a separate, signed, clearly-labelled decision — not smuggled in as an optimisation.

**Second boundary — hysteresis.** Even with an exact-zero gate, a segment must not be
chopped by a single zero sample between two notes. Require a minimum silent RUN (order of a
second) before closing a segment, and re-open on the first non-zero sample. This costs a
little silence on disk and buys files that correspond to musical events.

## 4. Modal at record time (D-WZ-GREC-01, unchanged)

- **Sum only** — one crash-safe BWF of bus 0, post-master-fader, post-limiter. The
  disk-saving mode.
- **Multitrack** — the sum PLUS per-strip segments as above.

Global capture stays **file-only**: no RAM buffer, no 256 MB cap, not live-loopable. It is
the archivist, not the instrument. That is what keeps a 3-hour set possible when a deck caps
at **11:39** stereo (`256 MiB/(ch·4)` — note D-WZ-DECK-01's "≈23 min stereo" is the *mono*
figure and needs correcting).

## 5. What must NOT be reused

- **The deck record path.** It captures ENGINE INPUT channels, pre-fader, into a capped RAM
  buffer that Law C-3 makes live-loopable. Every one of those properties is wrong here.
- **A deck per strip.** `kMaxDecks = 8` and the cap would end a long set mid-song.

Reuse the *plumbing* — the drain ring, `WavWriter`'s crash-safe BWF/RF64, the sidecar, the
stamp — not the deck object.

## 6. Sequencing

1. `P7-GREC-01` — sum-only global record from the post-master-fader/post-limiter snapshot
   (the signal already exists at the loopback tap), its own drain + writer. Mints
   `globalRecordStartSample`.
2. `P7-GREC-02` — per-strip post-fader taps; multitrack mode writes one file per strip,
   all stamped to the common origin.
3. `P7-GREC-03` — exact-zero segmentation with hysteresis (the user's idea), applied to
   the per-strip writers only. Sum-only mode never segments: the master is the one file
   that should be continuous.
4. `P7-GREC-04` — a fixture that RECONSTRUCTS: write a known multi-strip session with
   silence, then prove that placing every segment at its `TimeReference` reproduces the
   sum sample-for-sample. Without this, "perfectly" is a claim rather than a property.
