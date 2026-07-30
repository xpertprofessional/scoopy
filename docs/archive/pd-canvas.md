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

### 3.0 On-Cell vs. Inspector — resolving the clutter tension

An earlier draft of this plan said "every Cell shows *its controls* inline (no hidden
modes)". Read literally that is unbuildable: a plane of a dozen Cells each showing loop
points, output-bus choice, cue routing and (later) plugin state is *less* legible, not
more — it recreates the density we are fleeing. The GRM manual shows the real answer, which
we had misread: the slate carries **what you touch while playing**, and an always-visible,
selection-driven **Inspector** carries **what you set precisely** [Inspecteur; design-notes
§4.1]. Crucially that is *not* a hidden mode — the panel is always on screen and always
reflects the current selection, so nothing is behind a gesture you must first discover.

The split for a Wizard Cell:

| On the Cell (always visible, direct-manipulation) | In the Inspector (selected Cell only) |
|---|---|
| meter, level, pan, mute/solo, cue, record | exact loop in/out samples (drag is coarse; type here) |
| waveform + loop brace (drag to set region) | output-bus picker, cue routing |
| transport (loop/one-shot/retrigger), speed thumb | source rebind, rename, per-Cell gain trim |
| the "?" that labels everything in place | (later) plugin slot, snapshot A/B/C/D + glide |

This keeps the plane scannable *and* keeps every live gesture on the object — the
combination the console rack and the raw GRM plane each miss in opposite directions. It
also means a zoomed-out/strip Cell can drop to just the left column and stay usable, which
is the mechanism behind "strip mode is zoom-out" below.

### 3.1 Borrowing GRM's deeper split — *later, not now*

GRM's material/reader split suggests a v2: **multiple readers on one Cell's material**
(N playheads, each with its own window + speed → granular from the same buffer). Our
engine is *already* capable — decks are independent units reading buffers. This is
recorded as a **future** direction (PD-CANVAS-2), deliberately out of the first cut: the
first cut must prove free placement + one item type, not add a synthesis model. The manual
confirms the mechanism is *N cursors sharing one moving window* (`empan`), not a distinct
DSP engine [design-notes §4.2] — so PD-CANVAS-2 is a UI-and-scheduling problem, not a new
synthesis model.

A second future (**PD-CANVAS-3**): GRM's per-slate **A/B/C/D memory slots with an
interpolation time** — set two states of a Cell and morph between them over a chosen
duration [design-notes §4.3]. This is the "instrument, not a mixer" posture (CONCEPT §2)
made literal, and Wizard has no equivalent today. Also out of the first cut.

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
  antidote: the live gestures live on the Cell (no hidden *modes*), the precise settings
  live in an always-visible Inspector (§3.0 — not a hidden mode either), and a single "?"
  reveals labels in place. Note GRM *has* an Inspector and still confused reviewers; the
  difference is that our on-Cell controls cover the whole performance loop, so a first-time
  user never *needs* the Inspector to make a sound loop — only to fine-tune it.

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

### 4.1 Verified workspace mechanics (from PlanTravail, not inferred)

Reading the workspace page itself pins down the interaction model and, more usefully,
shows where Wizard should *diverge* rather than copy:

- **Zoom is discrete +/− with a Default reset, bottom-right** [PlanTravail]. Adopt the
  position (bottom-right is where the hand already is after placing Cells), but add a
  **fit-to-content** alongside Default — GRM has no overview aid at all, which is part of
  its "where is everything?" problem.
- **CORRECTED 2026-07-24 — GRM ships BOTH a background grid and snapping.** An earlier pass
  of this document claimed it had neither, reading only PlanTravail; the **Preferences** page
  exposes *"Affiche la grille de fond"* (show the background grid) and *"Aimante les ardoises
  sur la grille"* (snap the slates to the grid). So light snapping is **not** our invention —
  it is precedent, which strengthens rather than weakens the case for it. It should still
  stay light and defeatable (alignment guides when an edge is within a few screen px, plus an
  opt-out modifier); placement is meaning (§4), and a *forced* grid would impose a meaning the
  user did not choose.
- **No minimap/overview exists** [PlanTravail]. fit-to-content (frame all Cells) is the
  cheap answer and is enough at Wizard's scale (≤ a few dozen Cells), so a minimap is
  explicitly out of the first cut.
- **Workspace rotation** (pivot the whole plane left/right) exists in GRM [PlanTravail] and
  is **explicitly rejected** for Wizard: it serves GRM's multi-user around-a-table touch
  model, and for a single pointer user it only adds disorientation with no gain for
  role-based arrangement.
- **Selection is tap-and-drag on the object; a marquee is additive later.** GRM's
  double-click / shift-click modifiers are for *temporal* selection inside a track — an
  editor gesture Wizard does not want (§4.5 of design-notes: editing is Parlante's job).

## 5. What it costs (honest)

- **Engine: zero.** Nothing below the UI changes — this is why building engine-first was
  right. Varispeed, loopback, watchdog, buses, recorder all stand.
- **Schema: small, additive** — and now spelled out concretely in §7. A `cell {x,y,w,h}` on
  Channel, a `plane {scale,panX,panY}` on Patch, one SCHEMA_VERSION bump with a named
  migration that auto-lays-out old Patches. Crucially **no array merge**: `Channel` is
  already the one strip type and `decks[]` is material storage, so the "one object type"
  is a rendering change, not a data-model change.
- **UI: a real rewrite of the panels** — `ChannelRack`, `DeckRack`, `SourcesBrowser`,
  `RoutingMatrix` (~600 lines) become `Plane` + `Cell` + `Inspector` + drawers (add ~150
  lines for the Inspector; the routing matrix's per-strip bus choice largely *moves into*
  it rather than being rebuilt). The *logic* (usePatch, takeAlign, MeterCanvas, faderCurve)
  is reusable as-is.
- **What we'd lose:** the rack's fixed-width scannability, and "where is everything?" when
  a plane gets messy — mitigated by fit-to-content, and by the fact that arrangement is
  the user's own memory aid.

## 6. Proposed sequencing

1. **Decide** (#1). If adopted:
2. `PD-CANVAS-01` schema: Cell geometry + plane view state, migration from the current
   Patch (auto-layout existing channels into rows).
3. `PD-CANVAS-02` the `Plane` (pan/zoom/fit, selection) + `Cell` (all states in one
   component, showing only the always-visible left-column controls per §3.0).
4. `PD-CANVAS-03` the **Inspector** — a selection-driven property panel holding the
   set-precisely controls (§3.0). Built alongside the Cell because the two are designed as
   a pair; splitting them would ship a Cell that either clutters or hides.
5. `PD-CANVAS-04` drag-to-create from a sources drawer + take drawer.
6. `PD-CANVAS-05` retire `ChannelRack`/`DeckRack`/`SourcesBrowser`; re-scope P4-08 strip
   mode as zoom-out (a strip Cell = the Cell's left column only).
7. `PD-CANVAS-2` (later, optional): N readers per Cell — GRM's granular model (UI +
   scheduling; engine already capable).
8. `PD-CANVAS-3` (later, optional): per-Cell A/B/C/D snapshots with a glide time.

**Recommendation: adopt.** It is what the schema already says, it is what the user asked
for, the engine is untouched, and GRM Player proves the interaction model works in a
shipping instrument.

## 7. Concrete schema (PD-CANVAS-01) — so the decision is a yes/no to a real plan

The single most important schema fact, verified against `web/protocol/schema.ts`: **the
unification needs no array merge.** `Channel` is *already* the one strip type — its
`source.kind` is `deviceInput | appTap | deck | virtualDeviceInput | busTap`. The `decks[]`
array is not a second species; it is **material storage** (buffer/loop/rate/sourcePath) that
a Channel with `source.kind === 'deck'` points into. The three racks are a *rendering*
split over one model, not two models. So the Cell is a Channel; "a Cell with material" is a
Channel whose source resolves to a deck.

That makes PD-CANVAS-01 purely additive:

```ts
// added to ChannelSchema — every strip becomes placeable
cell: z.object({
  x: z.number(), y: z.number(),          // plane coordinates (unbounded, like GRM)
  w: z.number().positive(),              // Cell size; height derives from state
  h: z.number().positive(),              // (a material Cell is taller — waveform)
}).strict(),

// added to PatchSchema — the viewport is document state (persists per §4)
plane: z.object({
  scale: z.number().positive(),          // zoom; Default resets to 1
  panX: z.number(), panY: z.number(),    // pan offset
}).strict(),
// uiMode: keep the field, reinterpret 'strip' as "zoomed-out view", not a layout.
```

- **Bump SCHEMA_VERSION once.** The migration is a NAMED per-version step (sessions.md §3
  discipline): a pre-Cell Patch has no `cell`/`plane`, so the migration **auto-lays-out**
  existing channels into rows (the current rack order → a tidy grid) and defaults
  `plane = {scale:1, panX:0, panY:0}`. No user data is invented or dropped — geometry is
  the only new axis and it gets a deterministic default.
- **Strictness holds.** Both new objects are `.strict()`; the preserve-don't-drop law is
  unaffected because nothing existing is removed.
- **Engine/protocol untouched.** Geometry never crosses the ABI — the engine has never
  known where a strip is drawn, and still won't. `protocol:check`/`abi:check` see no change.

This is the whole schema surface. Everything else in PD-CANVAS is UI over it.

## Sources

- [Plan de travail](https://sites.inagrm.com/download/grmplayer/documentation/co/PlanTravail.html) — "un plan sans limite apparente"; zoom +/−/Default bottom-right; NO grid/snap; workspace rotation; no minimap (all verified §4.1)
- [Fonctionnalités avancées](https://sites.inagrm.com/download/grmplayer/documentation/co/05_Fonctionalites_avancees.html) — the advanced control surface is OSC + JavaScript (a pointer toward Wizard's own eventual scripting/automation posture, not v1)
- [Interface](https://sites.inagrm.com/download/grmplayer/documentation/co/03-Interface.html) — named regions; "ardoises séquences réparties dans le plan de travail"
- [Rajouter un lecteur](https://sites.inagrm.com/download/grmplayer/documentation/co/Rajouter_un_lecteur.html) — drag a player onto a sequence; Single Player vs Player × n; window span → granular
- [Inspecteur](https://sites.inagrm.com/download/grmplayer/documentation/co/Inspecteur.html) — the always-visible, selection-driven property panel (§3.0's resolution)
- [Lecteurs](https://sites.inagrm.com/download/grmplayer/documentation/co/Lecteurs.html) — empan/verrouillage; A/B/C/D memories + interpolation (PD-CANVAS-3)
- [KVR t=500424](https://www.kvraudio.com/forum/viewtopic.php?t=500424) — the discoverability critique we must avoid
