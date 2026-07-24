# PD-CANVAS — one unified item on a boundless plane

*Design plan for the user's UI direction (2026-07-24): **"free arrangable players /
decks / input in a field, only one item, no separated input and deck channels — our
vision needs improvement."** This is a proposal awaiting sign-off (morning decision #1);
nothing here is built. Informed by the REAL GRM Player documentation, now located and
read: `sites.inagrm.com/download/grmplayer/documentation` (cited inline).*

## 1. Why the current console is wrong (by our own laws)

CONCEPT's founding law is *everything is a channel*. The console we built violates it:
a **sources rail** on the left, a **channel rack** in the middle, a **deck rack** below —
three different visual species for what the schema already models as one type. The split
is a UI artifact, not a domain truth:

- `Channel.source.kind` already includes `deviceInput`, `deck`, `appTap`,
  `virtualDeviceInput`, `busTap` — a deck strip and an input strip are the **same object**
  with a different `source`.
- P3 made this concrete: a deck records *its channel's source*. "Input" and "deck" are
  two moments in one object's life, not two objects.

So the user's instinct is not a redesign whim — it is the schema asserting itself against
a UI that hid it.

## 2. What GRM Player actually does (verified, not inferred)

The workspace is *"un simple espace géométrique en deux dimensions, **un plan sans limite
apparente**"* — a two-dimensional geometric space, **a plane with no apparent limits**
[PlanTravail]. Objects are **dragged into place**; zoom/pan controls sit bottom-right with
a "Default" reset [PlanTravail]. Sequence *ardoises* (slates) are *"réparties dans le plan
de travail"* — distributed across the workspace [03-Interface].

Two object types compose:
- **Séquence** — a slate holding sound on one or more tracks.
- **Lecteur** — a player slate you **drag onto a sequence** from the players drawer; it
  then "appears in the sequence with its controls" [Rajouter_un_lecteur].

Player kinds: **Single Player** (one cursor traversing the file, variable direction and
speed) and **Player × n** (multiple readers acting as loops/windows over the same sound).
The reading-window span is dragged vertically, and *"selon la taille de la fenêtre de
lecture on passera d'une répétition à de la synthèse granulaire"* — window size alone
takes you from repetition to granular synthesis [Rajouter_un_lecteur].

**The transferable idea:** GRM separates *the material* (sequence) from *the ways of
reading it* (players), and lets N readers live on one material. That is a **deeper**
unification than merging our input and deck strips — and it maps onto Wizard exactly.

## 3. The proposal: the Cell

**One object type. One name. Placed freely on a boundless plane.**

A **Cell** binds a Source and optionally holds captured audio. Every current species is
the same Cell in a different state:

| Today | As a Cell |
|---|---|
| input strip | Cell(source = deviceInput), no material |
| app tap strip | Cell(source = appTap), no material |
| deck | Cell(source = …) **that has recorded material** |
| FX return | Cell(source = busTap) |
| loopback | Cell(source = busTap of a bus) |

Every Cell always has: a **source**, a **level**, a **pan**, **mute/solo**, a **cue**
toggle, an **output bus**, a **meter**. A Cell *with material* additionally shows a
waveform, a loop brace, transport (loop / one-shot / retrigger) and the signed varispeed
thumb. **Recording is just the verb that gives a Cell material** — which is precisely Law
C-3: you record into the thing you were already listening to, and it loops the instant you
stop.

### 3.1 Borrowing GRM's deeper split — *later, not now*

GRM's material/reader split suggests a v2: **multiple readers on one Cell's material**
(N playheads, each with its own window + speed → granular from the same buffer). Our
engine is *already* capable — decks are independent units reading buffers. This is
recorded as a **future** direction (PD-CANVAS-2), deliberately out of the first cut: the
first cut must prove free placement + one item type, not add a synthesis model.

## 4. Layout & interaction

- **Boundless plane.** Cells carry `x, y, w, h` in the Patch. Zoom + pan, with a
  "fit"/reset control (GRM's precedent). No grid enforced; light snapping.
- **Placement is meaning.** Group by role, by song section, by physical stage position —
  the arrangement is the user's, and it persists in the session.
- **Drag to create.** Drag a source (from a sources drawer, GRM's *tiroir*) onto the
  plane → a Cell appears there. Drag a Take onto the plane → a Cell with material.
- **Strip mode becomes zoom-out**, not a separate layout — this is why P4-08 is held.
  A zoomed-out plane where Cells collapse to mini-cells *is* the docked strip.
- **The one thing GRM gets wrong, we avoid.** Reviewers found it unintuitive — *"couldn't
  even figure out how to make the sound loop"* without the manual [kvr 500424]. Our
  antidote: every Cell shows its controls inline (no hidden modes), plus a single "?"
  that reveals labels in place.

```
┌ plane (pannable, zoomable) ─────────────────────────────────────────────┐
│                                                                          │
│   ┌ Mic ────────┐        ┌ Spotify ─────┐                                │
│   │ ▁▂▃ meter   │        │ ▁▂▃ meter    │      ┌ Take 3 ──────────────┐  │
│   │ ──●── lvl   │        │ ──●── lvl    │      │ ▁▂▃▅▇▅▃▂ waveform    │  │
│   │ L──●──R  ●C │        │ L──●──R      │      │ └── loop brace ──┘   │  │
│   │ ● rec       │        │ ● rec        │      │ ⟳ ▸ ⟲  speed ├─●──┤  │  │
│   └─────────────┘        └──────────────┘      │ ──●── lvl   out▸bus2 │  │
│                                                 └──────────────────────┘  │
│                    ┌ Loopback (main) ┐                                    │
│                    │ ↺ prev-block    │        [+ source]  [zoom −/+/fit]  │
│                    └─────────────────┘                                    │
└──────────────────────────────────────────────────────────────────────────┘
   ONE species. A Cell with material simply shows more.
```

## 5. What it costs (honest)

- **Engine: zero.** Nothing below the UI changes — this is why building engine-first was
  right. Varispeed, loopback, watchdog, buses, recorder all stand.
- **Schema: small, additive.** Add `x, y, w, h` (+ a `uiScale`/pan for the plane) to
  Channel/Patch. `uiMode` becomes a view state. Old Patches load with an auto-layout.
- **UI: a real rewrite of the panels** — `ChannelRack`, `DeckRack`, `SourcesBrowser`,
  `RoutingMatrix` (~600 lines) become `Plane` + `Cell` + drawers. The *logic* (usePatch,
  takeAlign, MeterCanvas, faderCurve) is reusable as-is.
- **What we'd lose:** the rack's fixed-width scannability, and "where is everything?" when
  a plane gets messy — mitigated by fit-to-content, and by the fact that arrangement is
  the user's own memory aid.

## 6. Proposed sequencing

1. **Decide** (#1). If adopted:
2. `PD-CANVAS-01` schema: Cell geometry + plane view state, migration from the current
   Patch (auto-layout existing channels into rows).
3. `PD-CANVAS-02` the `Plane` (pan/zoom/fit, selection) + `Cell` (all states in one
   component).
4. `PD-CANVAS-03` drag-to-create from a sources drawer + take drawer.
5. `PD-CANVAS-04` retire `ChannelRack`/`DeckRack`/`SourcesBrowser`; re-scope P4-08 strip
   mode as zoom-out.
6. `PD-CANVAS-2` (later, optional): N readers per Cell — GRM's granular model.

**Recommendation: adopt.** It is what the schema already says, it is what the user asked
for, the engine is untouched, and GRM Player proves the interaction model works in a
shipping instrument.

## Sources

- [Plan de travail](https://sites.inagrm.com/download/grmplayer/documentation/co/PlanTravail.html) — "un plan sans limite apparente", drag placement, zoom/pan/Default
- [Interface](https://sites.inagrm.com/download/grmplayer/documentation/co/03-Interface.html) — named regions; "ardoises séquences réparties dans le plan de travail"
- [Rajouter un lecteur](https://sites.inagrm.com/download/grmplayer/documentation/co/Rajouter_un_lecteur.html) — drag a player onto a sequence; Single Player vs Player × n; window span → granular
- [KVR t=500424](https://www.kvraudio.com/forum/viewtopic.php?t=500424) — the discoverability critique we must avoid
