# Morning decisions 2 — for the user, opened 2026-07-28

*Queued by the Fable 5 review session. Same contract as `docs/MORNING-DECISIONS.md`:
each entry is the question, the options with trade-offs, and a recommendation.
Rows marked `provisional(D-n)` in `P3-LEDGER.md` BUILD the recommendation and log
it; your sign-off (or veto) re-tunes them. Nothing here blocks the loop.*

## D-1 · Session store flip: native, not OPFS — veto window

**Question:** replace the merged app's OPFS session library with a native store
(`slSession` dispatch backed by `host/src/SessionStore.cpp`), OPFS remaining only
for the browser companion?

- **A (recommended, building):** native store. Evidence: the JUCE WKWebView host
  can LIST OPFS but cannot WRITE it (0cccde4 — every new session was a corrupt
  zero-length landmine); the shell already owns `.scoopyMap` natively via `slMap`;
  P3-ROADMAP names this "THE FLIP". Sessions land on disk, visible, backupable.
- **B:** keep debugging OPFS on the WKWebView host. Cost: unexplained platform
  write failure, storage invisible to the user, and the browser/host split stays.

**Consequence of A to be aware of:** session files move to a real folder (like
takes in `WizardMerged/Takes`); any sessions that exist only in some browser
profile's OPFS would need an export/import path (none are known to exist in the
merged app — it could never save one).

## D-2 · How a tape learns its tempo (the sync ratio's missing input)

**Question:** a tape knows frames, not beats. What supplies `originalBpm` for
`djSyncLaw`?

- **A (recommended, building):** record-time stamp + inference + override.
  Capture stamps `bpmAtStart` (master BPM at record start) into the take sidecar
  — already spec'd at MAP-SCHEMA.md:60, never built. Loop region → beats by
  nearest power-of-two bars at the stamped bpm. Inspector gets an editable
  beats/bpm field that always wins. Loaded files (no stamp): manual only.
- **B:** quantized capture (`sl_tape_record_start_quantized`, SL-ABI-V3 §5) so a
  loop is bar-exact by construction. Better long-term; needs the §7 engine beat
  clock, which is deliberately unbuilt. Kept as the follow-up, not the blocker.
- **C:** audio BPM detection. Heaviest, least predictable; not proposed now.

## D-3 · Tape stretch latency policy (the collision with Law C-3)

**Question:** the Signalsmith bus stretcher costs ~5120 frames (~116 ms) of group
delay even at unity, and the grid decks handle this with an all-or-nothing bypass
so every deck keeps identical delay. A tape's freshly-closed loop (Law C-3:
same-block record→loop handoff) cannot silently gain 116 ms. What is the policy?

- **A (recommended, building):** *sync ≠ stretch by default.* A tape's default
  `tempoMode` is **timePitch** (varispeed — zero latency, already built; pitch
  moves with rate, which is honest tape behaviour). `timeStretch` is per-strip
  opt-in; choosing it accepts the group delay, the C-3 handoff always closes dry,
  and the stretcher engages on the next tempo intent with a crossfade. The
  all-or-nothing delay-matching stays a decks-only policy until someone hears an
  alignment problem.
- **B:** extend the all-or-nothing group across decks AND tapes (uniform delay,
  strict beat alignment) — cost: closing one loop with any stretch active would
  delay-shift everything, or force 116 ms onto fresh loops.
- **C:** stretch always, accept latency everywhere. Simplest mentally, worst for
  live looping.

## D-4 · The playful mutual UI — your taste is the spec

The functional baseline (transport rows, sync, scrub/overdub verbs, master verbs,
doors to panels) is loop-buildable and being built. The MORPH — how a strip that
holds grid + tape *looks and feels*, how the plane reads as one playful
instrument rather than panels-in-boxes — is a product-shape call like PD-CANVAS
was, and it wants your direction before code. Inputs when you return:
- which of `pd-strip-anatomy.md` / `pd-visual-language.md` / `pd-plane-playground.md`
  still express what you want for the MERGED strip (they predate the merge);
- whether grid + tape in one strip render stacked, tabbed, or morphing (the wave
  and the scene pads competing for the same rectangle is the concrete question);
- what "playful" means to veto against: color, motion, physicality, sound-reactive?

## D-5 · Panel hosting taste calls

The P3-4-1 audit will table all 19 panels. Most doors are mechanical (a panels
menu). The taste calls expected: does `djmode` survive as a surface when the plane
IS the DJ view? Does `transport` stay a window once its verbs fold into the
master section? Do settings-like panels (general/audio/appearance/midi/perf)
group under one settings door? Queue answers per-panel when the audit lands.
