# Tape timeStretch — the spec (P3-2b-4)

*Written 2026-07-28, before the build (P3-2b-5), per the §11 rule. Everything
here is measured against the tree, not remembered; file:line references were
verified during the P3-2b sizing pass. Policy choices follow D-3's
recommendation (MORNING-DECISIONS-2) and are re-tunable on sign-off.*

## What this adds, in one sentence

A tape whose `tempoMode` is `timeStretch` follows the master WITHOUT its pitch
moving — the second half of "stretch and re-pitch every element to the master",
whose varispeed half (`timePitch`) shipped in P3-2b-3.

## The mechanism — reuse, not invention

**The stretcher is `NativeBusStretcher` (Signalsmith), used as-is.**
`NativeBusStretcher.cpp` includes only its own header; the class knows nothing
about decks, grids or snapshots; channel count is a `configure()` argument
(stereo tape = 2, vs the deck bus's 6). It is already on `slengine`'s link line
(`target_link_libraries(wz_sl_engine PUBLIC scoopy_engine)`), so instantiating
it in the tape tier costs no new dependency and no extraction.

**The data path rides the reader we already trust.** The Signalsmith
fixed-output model takes N input frames and asks for M output frames; duration
scales by M/N with pitch preserved. So per render block:

1. the tape READER runs exactly as in varispeed mode at the sync ratio —
   consuming `round(block × ratio)` source frames through the same smoothed,
   loop-wrapping, seqlock-disciplined path P3-2b-3 uses (`sl_tape.cpp`'s
   reader), into a per-tape staging buffer;
2. the stretcher turns those into `block` output frames, pitch-preserved.

One reader, two modes: `timePitch` sends the reader's output straight to the
channel; `timeStretch` sends it through the stretcher first. The ratio number
is THE SAME `tapeEffectiveRate` magnitude TS already computes — no second law.

## What must be PORTED (not shared): the engage/declick machinery

The deck bus's bypass↔stretch crossfade lives as private core state
(`busHistory_`/`busDisengageWet_`/`busBypassPrev_` etc.,
`NativeAudioEngineCore.cpp:912-1002`) and is not extractable without
refactoring the core — which the dual-home law makes a bigger step than this
feature. The tape tier therefore carries its own, smaller version:

- **Engage**: prime the stretcher with the last `blockFrames()` of already-
  played material (`engagePrimed` exists for exactly this), then equal-power
  crossfade bypass→wet over one block.
- **Disengage**: equal-power crossfade wet→bypass over one block, then release.
- No history ring is needed beyond one block: the tape's material is already
  RAM-resident and addressable by frame — the deck bus needed a ring because
  its input is transient; ours is the buffer itself.

## The latency policy (D-3's recommendation, made concrete)

The stretcher costs ~`startupLatencyFrames()` (~5120 frames ≈ 116 ms @44.1k)
of group delay. The rules:

1. **Sync ≠ stretch.** `timePitch` (varispeed, zero latency) stays the default;
   `timeStretch` is per-strip opt-in. Choosing it accepts the delay.
2. **Law C-3 always closes dry.** The record→loop handoff never engages the
   stretcher in its own block; a freshly closed loop plays immediately at
   unity. Stretch engages on the NEXT tempo intent (a sync toggle, a master
   move) with the crossfade — by which point the performer has what they asked
   for (the loop, now) and the delay buys what they asked for next (the sync).
3. **No cross-element delay matching yet.** The core's all-or-nothing bypass
   group stays a grid-deck policy. A stretched tape is late by its group delay
   relative to a dry one; D-3 records this as the accepted cost until someone
   HEARS an alignment problem — at which point the fix is joining the core's
   group, not inventing a third mechanism.

## The loop-wrap rule

The reader wraps its playhead mid-block with fractional carry
(`sl_tape.cpp:716-747`); a phase vocoder sees a wrap as a splice and smears it.
**The stage-1 read above is therefore SPLIT at loop boundaries**: the staging
buffer is filled in wrap-contiguous runs, and the stretcher's `process()` is
called per run (the fixed-output model permits partial blocks). A loop shorter
than one block degenerates to per-lap calls, which is correct and merely
CPU-heavier — the cap on silliness is the existing `|rate| ≤ 16` clamp.

## Resource policy

- **Lazy**: a tape's stretcher is allocated and `configure()`d when the tape
  first ENTERS `timeStretch` (control thread — the mode change is a dispatch,
  never RT), using `asyncWarmup` so the ~600 ms warmup never blocks; released
  when the tape leaves the mode or resets.
- Worst case 8 stretchers × 2ch is smaller than the deck buses' standing
  3 × 6ch; no additional cap is imposed.

## ABI and plumbing (the build's checklist, P3-2b-5)

- `sl_tape_set_tempo_mode(e, tape, mode)` — 0 timePitch · 1 timeStretch.
  Engine-side the mode picks the tape's output path; the RATIO continues to
  arrive via `sl_tape_set_rate` (one number, one setter, mode decides what it
  drives — mirroring `applyDeckParams`' shape).
- Dispatch: `slTape {action:'setTempoMode'}`; TS: `tapeEffectiveRate` drops its
  "timeStretch returns manual rate" guard and `applyTempo` sends mode + ratio
  for tapes (the deck trio's shape); the strip's tape row gains the grid row's
  tempo-mode button (T+P / STR).
- HotFrame: none needed — no new telemetry, the existing tape state suffices.

## The fixture (P3-2b-6, already rowed)

`tape_sync_test` gains the stretch half: under a 2× ratio the output must play
the material in HALF the duration with pitch UNCHANGED — duration by frame
count to the loop's return, pitch by zero-crossing rate within tolerance — and
the C-3 handoff must measure DRY (no added latency) in the block after stop.
