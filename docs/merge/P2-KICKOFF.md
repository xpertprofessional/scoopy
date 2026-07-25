# P2 kickoff — the merged strip-suite: implementation plan

*Written 2026-07-25 at the close of the design phase. This is the brief for the
implementation session. Read alongside the design docs it consolidates:
`STRIP-MODEL.md`, `LOOPER-DESIGN.md`, `ROUTING-MATRIX.md`, `SL-ABI-V3.md`, and
memory `merge-mission`. Supersedes P1-KICKOFF's framing ("host scoopy's UI in
wizard's shell") — see P1-STATUS's MISSION section.*

## Mission (confirmed with the user)

Merge wizard and scoopy into **one native+web app, scoopy leading** (its native
engine + web UI; Swift carved off; wizard's engine is the donor). Wizard
contributes its **strip/map plane**, its **recording/looper** and a **master
sync/tempo section**, built **into scoopy's web UI**. The browser companion
survives separately. This is NOT wizard hosting scoopy — it is the two apps
merging their **strips and decks**.

## The product, in one picture

A **plane** (replacing scoopy's DJ deck view; compose view untouched) of
**strips**. A strip = a uniform **channel** + composable **elements**:

- **Channel** (always): level · **4 FX sends** · **master DSP (DRV)** ·
  **transport + time-stretch** (scoopy's per-deck transport, now every strip's) ·
  output · **record-arm**. Record is one tap on the channel bus, identical for
  every source.
- **Elements** (added on demand): **Grid** (a scoopy session — sequenced) ·
  **Tape** (a wizard deck — continuous: record/scrub/varispeed/loop/overdub) ·
  **Input** (live, full channel incl. sends). A **file player is a tape from a
  file**. So: two content engines (grid + tape) + input.
- Strips start **empty**; **presets** ("looper strip", "deck strip") keep it fast.
- **Multiple decks/sessions coexist, each its own BPM**, any lockable to a master.
- The **routing matrix** patches anything→anything (device inputs, any app's
  audio via the virtual device, FX returns, strip outputs) in real time,
  click-free.

## Two engines, and their status

- **Grid (SL-ABI-V3 §6) — BUILT.** Multi-deck sessions, per-deck BPM, master sync
  (`sl_deck_set_tempo_sync`), add/drop a deck (`sl_deck_clear`), the whole v3 ABI
  (identity/render/snapshots/params/HotFrame), rendering through AudioIO. All
  headless-tested (ctest ~50). Exposes scoopy's DJ-mode multi-deck; the pinned
  core is untouched.
- **Tape (SL-ABI-V3 §5) — NOT BUILT (next).** Wizard's `wz_deck_*` transplants
  1:1 under `sl_` names: chunked planar storage, seqlock loop, scrub mailbox,
  overdub SUM/REPLACE, insert splice, record service, 256 MB cap, Law C-2 stamps,
  C-3 handoff. All written+tested in `apps/wizard/engine`. **First architectural
  question:** where does wizard's deck code live in the merged engine? (a) merged
  engine links BOTH scoopy core + wizard engine, mixing outputs; or (b) port the
  deck code into the `slengine` tier. Scope this before writing.

## Implementation order (proposed)

1. **§5 tape-deck engine** — resolve the (a)/(b) fork, transplant wizard's decks
   into the merged engine under `sl_` names, headless-test (record→buffer→loop→
   scrub renders; overdub; take drains). This gives strips their tape powers.
2. **The channel** — expose the uniform strip channel over the ABI: level, the 4
   sends, master DSP (DRV), record tap. Sends + master drive already exist in
   scoopy's core (AudioLane sends, master clipper/drive); this is exposure + the
   record tap on the channel bus.
3. **Routing** — the RCU-published routing graph (any source→destination),
   ramped/click-free, with the virtual-device pairs as sources. Feedback
   (FX return→strip) is 1-block-delayed and allowed.
4. **The plane UI in scoopy's web** — bring wizard's `plane/` (Plane/Strip) into
   scoopy's web (apps/scoopy, writable home), a strip hosting grid/tape/input
   elements on the channel, driven by the engine. Master-tempo control; sync
   toggles; carve-loop→grid-track. Plane patching + the matrix grid as the two
   routing views. (Web build → `bundle:mac` → re-vendor → `WizardMerged` → run.)
5. **Persistence** — the plane-map/session persists strips, elements, routing,
   and recorded **takes** (one take underlies a scrubbable tape and any carved
   grid track — no duplicate audio). Reuse wizard's crash-safe takes + scoopy kit.

Engine + headless-testable work (1–3) comes first; the plane UI (4) is GUI,
verified by running `WizardMerged`, and is collaborative on look/feel.

## Laws / constraints to hold

- **scoopy's core is the ONE writable engine home** (`apps/scoopy`, hash-pinned
  into the merge via engine.lock) until the P3 flip. Merged-repo engine work
  lives in the wizard-owned `slengine` tier; core changes go to `apps/scoopy`.
- **Never hand-mirror a mapping** — generate it from the pinned authority with a
  check gate (track-params, HotFrame, worldmap all do this; the tape ABI's keyed
  surface should too).
- **RT-safe + click-free**: route/world changes are atomic RCU swaps + ramps;
  no locks or allocation on the audio thread.
- **Keep every scoopy grid power and every wizard tape power intact** — the merge
  adds a channel + plane around them, it does not reduce either.
- **Reuse signed wizard decisions** (D-WZ-VDEV-01 virtual device, D-WZ-OVERDUB-01
  destructive overdub, D-WZ-GREC-01 global record, D-WZ-RATE-01 rate rebuild).
- **GUI is verified by a human run-pass** (kickoff law 5) — the agent cannot see
  the screen.

## Open sub-questions (settle in-flight, non-blocking)
- Overdub semantics for a strip loop (reuse D-WZ-OVERDUB-01 destructive?).
- Loop-length ↔ tempo quantize on capture (bars at the strip's bpm?).
- Send tap pre/post the record tap (does a recorded tape include send-returns?).
- Master-bpm value + tempo ramp: plane-owned number driving per-deck sync ratios,
  with the core's `rateMorphFrames` for the glide.

## Reflection prompt for the new session

Before building, re-read this + the three design docs and sanity-check: does the
"channel + composable elements" strip model + two-engine (grid/tape) split still
hold against the mission, and does the §5 (a)/(b) engine-integration fork have a
clear winner once wizard's deck internals are re-read? Then start at
implementation step 1.
