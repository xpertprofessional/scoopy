# Deck recorder spec (P3 domain)

*Governs P3-02..P3-09. Signed: D-WZ-DECK-01 (cap+stop, 256 MB/deck) · D-WZ-CORE-02 (WAV
writer in host, dependency-free) · D-WZ-RATE-01 (takes at engine rate) · D-WZ-CLOCK-01
(engine-sample stamps). Laws: CONCEPT §2 — C-1 no timeline · C-2 timestamps make
multitrack · C-3 instant turnaround.*

## 1. The two artifacts of one recording

Every deck recording produces, simultaneously, from one arm→stop:

1. **The in-RAM record buffer** — grows during recording, and on stop **IS** the playback
   buffer (Law C-3: no file round-trip, no gap). Loopable + varispeed-bendable
   immediately. Capped at 256 MB/deck (D-WZ-DECK-01).
2. **The durable BWF/RF64 file** — written in parallel by the host from a lock-free drain,
   with a sidecar of metadata. The authoritative *stored* copy; never read back for live
   playback (the RAM buffer is authoritative — risk register "still-draining playback").

The buffer and the file are the same audio; they diverge only when the RAM cap stops the
buffer while the file keeps whatever was already drained.

## 2. States & the Law C-3 handoff

Deck states extend the P1 set: `idle → recording → looping | oneShot` (plus stop→idle).
`wz_deck_record_start` arms + begins capturing the deck's channel Source into the record
buffer, monitoring live (per-deck monitor switch, default on). `wz_deck_record_stop`:

- Returns the take's **startEngineSample** (Law C-2 anchor).
- **If loop is enabled, the deck switches to looping playback of the just-captured buffer
  in the SAME render block** — the gapless handoff. The record buffer becomes the loop
  buffer with no copy, no reallocation, no file touch. `deck_handoff_test` is the proof:
  record N frames, stop-with-loop, and the first played sample is buffer[loopStart] with
  zero gap or repeat at the seam.
- If loop is off, stop → idle with the buffer retained (loadable/playable).

The record input is the deck's channel Source (device input, another deck, a tap once P2's
backends land) — the deck records whatever its strip would monitor.

## 3. Buffer growth (off the RT path)

The record buffer grows in **committed chunks from the control thread**; the render thread
reads only a **seqlock-published committed length** (never a torn or growing length). Per
block, the render thread appends captured input into the current chunk's tail (bounded,
pre-reserved headroom); when a chunk fills, the control thread commits it and reserves the
next (allocation never on the audio thread). On reaching the 256 MB cap: the render thread
stops appending, sets `recordCapReached`, and the deck transitions per stop semantics; the
drain/file are unaffected.

## 4. The parallel drain → file (host)

`recorder.cpp` (engine) exposes a **lock-free drain ring** per deck: the render thread
writes captured frames + the block's `startEngineSample`; `wz_deck_drain` pulls them on the
host's `RecordService` thread, which feeds the host **WavWriter** (D-WZ-CORE-02). The
drain is independent of the RAM buffer — an overrun is counted + flagged, never blocks
render. Draining lags the buffer slightly; the file is the durable copy, the buffer the
live path (never read the file back for playback).

### 4.1 Crash-safe WAV (host, dependency-free)

BWF/RF64, written with a **pre-patched header + periodic flush**: the header's size fields
are written up-front for the max, then patched on clean close; on a mid-record SIGKILL the
file is still parseable to the last flushed frame (length correct ± one flush quantum).
`wav_killtest` proves it: fork, record, SIGKILL the child mid-write, reopen → recoverable,
length within one flush quantum. RF64 kicks in past the 4 GB WAV limit. Sidecar JSON:
`{deckId, startEngineSample, wallClock, sourceDesc, sampleRate, channels}`.

## 5. Multitrack from stamps (Law C-2)

Every take carries its `startEngineSample` (the engine's monotonic sample clock at
record-start). Two takes realign by the **delta** of their stamps — a subtraction, not an
editing session. "Align deck 2 to deck 1" = shift deck 2's loop origin by
`(start2 − start1)`. No shared timeline exists (Law C-1); the stamps ARE the multitrack
relationship. Fixture: record on deck 1, start deck 2 mid-take from a different input,
stop both → the stamp delta equals the real inter-start sample gap, exactly.

## 6. HotFrame (per-deck block, already reserved since P1)

`recordLengthSamples` (committed buffer length, live) and `recordDrainFill` (drain ring
backlog) are populated during recording; a `recordCapReached` bit rides one of them or a
new reserved field (schema increment). `state` reflects `recording`. The record indicator
+ cap-reached lamp read these.

## 7. Fixtures (P3, ctest)

1. `deck_handoff_test` — record → stop-with-loop → gapless, sample-exact loop of the
   captured buffer (no seam gap/repeat); the record buffer IS the play buffer (same
   pointer/rate).
2. `deck_stamp_test` — two decks, staggered record starts → stamp delta == real gap;
   align-to-deck-N shifts by the delta exactly.
3. `record_cap_test` — a synthetic long record hits the 256 MB cap → recording stops,
   `recordCapReached` set, buffer still loops, no allocation-on-RT.
4. `wav_killtest` (host) — SIGKILL mid-record → WAV recoverable, length ± one flush
   quantum; RF64 past 4 GB.
5. `recorder_drain_test` — drain ring never blocks render; overrun counted; frames +
   stamps arrive in order.

## 8. Order (ledger P3-01..)

spec (this) → engine record buffer + drain rings + stamps → the Law C-3 handoff +
`deck_handoff_test` → host WavWriter + `wav_killtest` → RecordService wiring → schema +
dispatch (recordStart/recordStop, take list) → stamps/align + `deck_stamp_test` →
`record_cap_test` → UI (arm/rec/take list/align/cap lamp) → P3-AUDIT → gate.
