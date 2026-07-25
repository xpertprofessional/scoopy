# The routing matrix — a modular, real-time patchbay

*Design, 2026-07-25. The connective layer that makes strips modular: anything
can feed anything, changed live without clicks. Companion to `STRIP-MODEL.md`.*

## Goal

A super-modular patchbay where any SOURCE can feed any DESTINATION, re-patchable
**in real time, click-free, never hanging**, with a UI that makes dense routing
feel intuitive.

## Sources (anything that produces signal)

- **Device inputs** — hardware interface channels.
- **Virtual interface pairs** — the xpert virtual device (SIGNED D-WZ-VDEV-01:
  16 ch / 8 stereo pairs, one driver). **Any running app's audio** routes into
  these pairs, Loopback-style and app-agnostic (no per-app bridge — that was the
  signed 2026-07-24 resolution). This is how "send any running app's audio" works.
- **FX returns** — the wet output of FX 1–4 (so a return can be re-used, not just
  summed to main).
- **Strip outputs** — each strip's channel output, so a strip can feed another
  strip (chaining, re-processing, sub-mixing).

## Destinations (anything that consumes signal)

- **Strip source-inputs** — a strip's `input` element takes a routed source (a
  device input, an app/virtual pair, an FX return, or another strip).
- **FX sends 1–4** — per the strip channel; the matrix can also route arbitrary
  sources into a send.
- **Main / cue / hardware outputs.**
- **A strip's record tap** — record any routed signal (one bus tap, per STRIP-MODEL).

## Feedback is allowed (FX return → strip)

Routing an FX return back into a strip is a first-class want. It is **safe by
construction**: the engine renders lanes in a fixed order per block, so a
return→strip route is **inherently one block delayed** (the return computed this
block feeds the strip next block). That is a few-ms feedback delay, not an
infinite instant loop — musically useful (resampling FX, feedback networks), with
gain staging the user's responsibility. No cycle detection needed; the block
boundary breaks the loop.

## Real-time, click-free, no hangs — how

The routing graph is part of the engine's **published world** (the RCU state
scoopy's `publishDJWorld` / wizard's `wz_world_commit` already swap atomically):

- **No hangs / RT-safe:** a re-patch rebuilds the routing graph on the control
  thread and installs it with ONE atomic pointer swap (RCU). The audio thread
  reads the current graph each block and never locks. This machinery exists in
  both engines already.
- **Click-free:** a changed connection is **ramped**, not switched — the old
  connection ramps down and the new ramps up over a few ms (D-WZ-RAMP-01 / the
  core's existing gain ramps). No instant on/off, so no click. Every re-patch is
  a short crossfade.

So you can re-patch a live signal flow while it plays and hear it morph, not glitch.

## UI — two complementary views, one routing state

The plane is already a patch canvas (PD-CANVAS), so lean into that:

- **Plane patching** — visual patch-cables between strip outputs, sources, FX
  returns and sends, right on the plane. Spatial, creative, matches the boundless
  canvas. Drag a cable; adjust level on the cable.
- **Matrix grid** (the existing RoutingMatrix panel evolved) — sources ×
  destinations, dense and precise, for when you want a table not a spaghetti.

Both drive the **same** routing state, so you pick the view per task. Both apply
live (click-free), so routing is a performance surface, not a setup screen. The
UX goal: routing feels like patching a modular, not filling a spreadsheet.

## Relation to the strip channel

The strip's 4 sends are the *common* case of routing (strip → FX), always present
on the channel. The matrix is the *general* case (any source → any destination),
including the paths sends can't express (app audio → strip, FX return → strip,
strip → strip). Sends and matrix are the same underlying graph at two levels of
convenience.

## Open sub-question
- Send tap point: pre/post the strip's record tap (does a recorded tape include
  send-returns or just the dry channel) — carried from STRIP-MODEL; settle when
  wiring the channel bus.
