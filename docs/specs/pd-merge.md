# PD-MERGE — collapse to one map, one strip, four surfaces

*User direction, 2026-07-24: **"merging console and plane, 1 map for all, 1 strip for all,
keep it simple before we expand too much and clutter the code. routing matrix, map, master
strip, settings is all we need for now."***

This supersedes the transitional console/plane toggle (D-WZ-PDCANVAS-01 shipped it as a
safety net; this retires it) and **prunes** the three design reviews down to what we
actually build. The reviews are kept as reference, not as a backlog.

## 1. The whole app is four surfaces

| Surface | What it is | Built from |
|---|---|---|
| **Map** | the boundless plane; every Strip lives here. There is no second place a Strip can be. | `plane/Plane.tsx` |
| **Strip** | the ONE object. Input, tap, loopback, deck-with-material are states of it, never separate species. | `plane/Strip.tsx` |
| **Master strip** | main fader, monitor/cue, main+monitor meters, feedback lamp. Fixed, always visible — it is not a Strip on the map because it is the destination, not a source. | `panels/MasterSection.tsx` |
| **Routing matrix** | the bus ledger — and the global place where each strip's INPUT is flipped, live. Summoned, not resident. | `panels/RoutingMatrix.tsx` |
| **Settings** | device in/out, capabilities, session/package actions. Summoned, not resident. | new, absorbs `panels/DevicePicker.tsx` |

Everything else is **deleted**, not hidden: `SourcesBrowser`, `ChannelRack`, `DeckRack`,
`TakesPanel`, the `view` toggle, and `uiMode`'s console/strip pairing as a *layout*.

## 2. What we are deliberately NOT building

The reviews proposed considerably more. Recording the refusals is the point of this
document — otherwise they leak back in one increment at a time.

| Proposed | Verdict |
|---|---|
| Hold-to-trace routing highlight, edge bus rail, matrix-as-overlay-ledger | **No.** The bus chip (D-WZ-ROUTINGVIEW-01) plus the summoned matrix is enough. Revisit only if the chip demonstrably fails. |
| Three zoom density tiers with hysteresis + counter-scaled type | **Not now.** One geometric zoom. "Strip mode = zoom out" stays a *claim* until someone needs it. |
| Status-line priority ladder (7 ranked states) | **Reduced.** One status line, but a plain first-match, no ranking machinery. |
| Spawn puck, source dedupe, ⌥-force-duplicate, marquee multi-select | **No.** One "add strip" affordance. |
| Snapshot slots A–F, N-readers-per-material, granular | **Out.** PD-CANVAS-2/-3 remain future, unscheduled. |
| Background dot field, inverse numeric fields, glyph-flip on reverse | **Cosmetic, later.** |

**Rule for this phase: no new surface, no new persisted field, unless one of the four
surfaces cannot work without it.**

## 3. Where the retired panels' jobs go

Nothing is lost; each job moves onto one of the four.

- **Binding a source** (was `SourcesBrowser`) → an **add-strip** action on the map. Pick a
  source, a Strip appears. That is the only creation gesture.
  - **A strip has no kind — only a source and (maybe) material.** *(Fixed 2026-07-24: the
    first `+ strip` shipped three creation paths — "an input", "an empty deck", "a
    loopback" — which reintroduced the very species this phase abolishes. You could tell
    what a strip *was* by which button had made it.)* One flat list of things a strip can
    LISTEN TO: nothing, a device input, a stereo pair, `↺ main`, `↺ cue`. An "empty deck"
    is just a strip whose source is *nothing*; it becomes a player the moment you record or
    load into it. This is the same reason overdub works on a loaded file as readily as on
    a take — there was never a second species to exclude.
  - **Loopback is a source you select, not a kind of strip.** It is Wizard's own bus, read
    one block behind (the one legal cycle), sampled after the master fader and limiter. Its
    danger belongs to the source too: a strip listening to a bus **arrives muted**, at
    creation *and* when a live strip is re-pointed at one.
  - **The routing matrix is where inputs are flipped in real time** — an `in` column, every
    strip in one place, the whole source list on each. Re-pointing never disturbs material:
    a strip looping a take keeps looping while you change what it hears. A vanished source
    stays listed as `(gone)` instead of the control silently showing something else.
- **Takes** (was `TakesPanel`) → takes are **material**, and material belongs to a Strip.
  Loading a take is an action *on a Strip*; the take list is reached from the same
  add-strip affordance. No fifth surface.
  - *Open question for the user:* the Law C-2 **align-to-take** verb (P3-07) currently
    lives in the takes panel. It is genuinely useful and has no obvious home on a Strip.
    Proposal: it moves into the Settings/session surface as a session-level operation.
- **Per-strip bus choice** (was `ChannelRack`'s picker) → the bus **chip** on the Strip
  opens it; the matrix stays the overview.
- **Deck transport** (was `DeckRack`) → already on the Strip.
- **Device choice** (was inside the sources rail) → Settings.

## 4. Sequencing — smallest safe steps

Each row is independently shippable and leaves the app working.

1. **PD-MERGE-01 — Settings surface.** Absorb `DevicePicker`; add session/package actions.
   Nothing else moves yet.
2. **PD-MERGE-02 — add-strip on the map.** One affordance that binds a source (and can
   load a take as material). Retires `SourcesBrowser`.
3. **PD-MERGE-03 — master strip beside the map.** Fixed placement, unchanged behaviour.
4. **PD-MERGE-04 — matrix as summoned overlay** from the map.
5. **PD-MERGE-05 — delete the console.** Remove `ChannelRack`, `DeckRack`, `TakesPanel`,
   the `view` toggle and the dead CSS. The map is the only view. *(This is PD-CANVAS-05.)*
6. **PD-MERGE-06 — `uiMode` cleanup.** With the console gone, `uiMode`'s `'strip'` value is
   meaningless as a layout. Either delete the field (version bump + migration) or
   re-document it as a zoom level. Do NOT leave it lying as a lie.

## 5. Laws this phase must not break

- **One Strip component.** If a second strip-like component appears, the phase has failed.
- **Geometry never crosses the ABI.** Map/Strip layout stays UI-only.
- **Deleting a panel deletes its CSS.** Dead selectors are how a "simplified" UI silently
  regrows.
- **No silent silence.** Whatever is retired, a Strip that cannot be heard must still say
  why (the unmapped chip is the current example).
- **preserve-don't-drop.** Retiring a panel never drops a persisted field without a named
  migration.
