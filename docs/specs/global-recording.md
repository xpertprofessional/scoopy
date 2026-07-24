# Global recording spec (P7-GREC domain)

*Governs P7-GREC-01 and its follow-up rows. **Signed: D-WZ-GREC-01 (2026-07-24) —
record-time mode: sum-only or multitrack** — the separately-signed policy D-WZ-DECK-01's
consequences demanded for long-form capture. Builds on: docs/specs/recorder.md (P3 drain
machinery) · Laws C-1/C-2 (CONCEPT §2) · D-WZ-CORE-02 (WavWriter) · D-WZ-CLOCK-01
(engine-sample stamps). User's words (2026-07-24): "global recording in wizard records
full stereo sum of entire app but also a session like multi-track with added timestamps
so all channels can be easily rearranged in a DAW with correct timings when they were
activated."*

## 1. Two artifacts of a global record

One press of the global record button produces:

1. **The master sum** — a crash-safe BWF/RF64 file of bus 0, tapped **post-master-fader**
   (the same point P4-03's LoopbackBus snapshots: what actually left the app). This is
   the "full stereo sum of the entire app".
2. **The session multitrack** — timestamped per-channel material (see §3 for what exactly
   is captured) such that a DAW reconstructs the session with correct timings from the
   files alone, no project file needed.

Unlike a deck take (two artifacts, RAM + file), a global record is **file-only**: no RAM
buffer, no 256 MB cap, not live-loopable. Live looping stays the decks' domain
(D-WZ-DECK-01); global recording is the archivist, not the instrument.

## 2. The timestamp law (Law C-2, extended to files)

No shared timeline is introduced — Law C-1 holds. Every captured file carries its
`startEngineSample`, and **P3-04 already writes that stamp into the BWF `bext`
`TimeReference` field** ("Law C-2's anchor rides inside the audio file itself"). The only
new rule a global record adds is a **common origin**:

> Every file belonging to one global record carries
> `TimeReference = startEngineSample − globalRecordStartSample`.

A DAW that honors BWF TimeReference (all majors do: "import at original position") then
lays every file — the sum, each armed strip, each deck take made during the record — at
exactly the moment it was activated. The stamps ARE the multitrack relationship; the DAW
placement is a subtraction, same as align-to-deck-N.

## 3. What captures — the record-time mode (SIGNED, D-WZ-GREC-01)

Global recording is **modal, chosen when the record starts**:

- **Sum-only** — just artifact 1, the master sum. The disk-saving mode: one file,
  ~17 MB/min.
- **Multitrack** — the sum PLUS a continuous crash-safe capture of **every active
  strip**, from global-record start (or the strip's activation, whichever is later) to
  stop, each file stamped to the common origin (§2). Covers streamed-through material
  (app taps, virtual-interface inputs) that never touches a deck.

One decision at record start, nothing to forget mid-take. A per-strip **session-arm**
inside multitrack mode (pay disk only for chosen strips) is an explicitly **later
refinement**, not this cut.

## 4. What it costs (honest)

- **Disk**: stereo 48 kHz / 24-bit ≈ 17 MB/min ≈ 1 GB/h per file. Multitrack with 8
  active strips ≈ 9 GB/h. RF64 promotion past 4 GB is already built (P3-04). No cap —
  the file is the product — but free-space checks + a running size readout belong in the
  UI (the cost is stated, not hidden).
- **CPU/RT**: per captured strip, one block-copy into a drain ring (the P3 pattern —
  overrun counted, never blocks render). One background service thread can pull all
  drains, exactly as RecordService already serves every recording deck.
- **Not covered**: per-strip capture is post-fader mixdown of that strip (its
  contribution), not a dry input archive — dry capture would be a different, pre-fader
  tap point and is out of scope for this draft.

## 5. Fixtures (sketch)

1. `global_sum_test` — the sum file equals bus 0's post-fader output frame-for-frame.
2. `global_stamp_test` — two strips activated at staggered times in multitrack mode →
   their files' TimeReference values differ by exactly the real activation gap;
   common-origin placement reconstructs the session sample-exact.
3. `global_kill_test` — SIGKILL mid-record → sum and every captured strip's file
   recoverable within one flush quantum (the `wav_killtest` pattern, N writers).

## 6. Order (ledger P7-GREC-01..)

engine bus/strip drain taps + GlobalRecordService (N writers, one thread — P7-GREC-01) →
schema (globalRecordStart/stop + mode, common-origin stamping) → UI (global ● button with
the sum/multitrack choice, running size readout) → fixtures → the DAW-import walkthrough
documented.

## Sources

- `docs/specs/recorder.md` §§4–5 (drain machinery, Law C-2), `docs/DECISIONS.md`
  D-WZ-DECK-01 (the "separately-signed policy" clause), EBU Tech 3285 (BWF `bext`
  TimeReference semantics).
