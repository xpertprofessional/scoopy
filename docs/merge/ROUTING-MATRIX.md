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

## Scheduling: ordered by default, delayed only where it must be

> **AMENDED 2026-07-25 (decided with the user at P2 planning).** This section
> originally said every route is inherently one block delayed and no cycle
> detection is needed. That is cheap to build and wrong to ship, because it
> contradicts the analysis already signed in `docs/specs/pd-modular-routing.md`:
> with strip→strip chaining and sub-mixing — both explicit wants above — a
> per-hop delay makes latency **accumulate** (one block per hop) and makes two
> parallel paths of different depth **comb-filter**. §1.3 of that document calls
> the comb "the failure mode that will actually burn a user": it is not an error,
> nothing warns, it just sounds hollow. The replacement below keeps the feedback
> feature and drops the trap.

There are **two kinds of edge**, and conflating them is what caused the problem:

| | **tap-by-order** (the default) | **tap-by-delay** (a feedback edge) |
|---|---|---|
| reads | the source's **current** block | the source's **previous** block |
| latency | **zero** | one block (~10.7 ms @ 512/48k) |
| used for | strip→strip chains, sub-mixes, sends, inputs | deliberate feedback (FX return → its own feeder) |
| cycles | impossible — refused at edit time | allowed; the block boundary breaks the loop |

At publish time the control thread **topologically sorts** the strips and the
render walks them in that order, so an ordinary chain adds no latency at all. A
route that would **close a cycle** is refused at edit time unless the user
explicitly confirms it as a feedback edge; those read the previous block's
snapshot, are **created muted** (the standing precedent — an unmuted unity
loopback is an instant sustained feedback path), and carry their computed **+ms
on the object**, because a delay you cannot see is the thing that burns you.

Feedback stays a first-class want — resampling FX and feedback networks are the
point of the whole feature. It just stops being the accidental default for
routing that was never meant to be delayed at all.

**Ships with it: a per-hardware-output leaky-RMS detector + ramped limiter.**
Today the watchdog guards the main bus only, so a runaway living between two
other outputs is both undetected and unlimited on the way to an amplifier
(pd-modular-routing §2.1, guard G1). Giving outputs an owner without giving them
a limiter is worse than doing neither.

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

**Sends are individually routable** (user, 2026-07-25). Each send **defaults** to
its FX — send *n* → FX *n*, the main use case, and what a new strip arrives with —
but any send can be re-pointed through the matrix: send 3 into another strip's
input to feed its looper, for instance. The split is that the **channel owns the
send's level** and the **routing document owns its destination**; a send tap is an
ordinary source in the graph, under the same ordering and feedback-edge rules as
everything else. All of it lives in the map.

## Settled sub-question — the send / record tap point

*Resolved at P2 planning, 2026-07-25 (was: "does a recorded tape include
send-returns or just the dry channel?").*

A strip's **record tap is its channel output** — post-element, post-DRV,
post-level: exactly what that strip contributes to the mix. Sends stay
**post-fader** by default. So a recorded tape is **dry of the global FX
returns**, because a return is a global lane rather than part of any one strip's
output; a recording that should carry the wet is made by routing that return into
a strip explicitly, which the matrix already expresses.

That keeps "record this strip" meaning one unambiguous thing, and leaves "record
the wet too" reachable without a second tap-point mode to explain. Capturing the
whole processed sum, returns included, is a *different verb* with its own record
source kind — `mainMix`, already built and fixtured (SL-ABI-V3 §5).
