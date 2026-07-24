# PD-PLANE-PLAYGROUND — the interaction model for the boundless plane

*Interaction spec for PD-CANVAS-02..05 (D-WZ-PDCANVAS-01). Downstream of
`docs/CONCEPT.md` (Laws C-1/C-2/C-3), `docs/specs/pd-canvas.md` (the plan),
`docs/specs/design-notes-grm-player.md` (what GRM verifiably does),
`docs/specs/routing.md` and `docs/specs/playback-composer.md` (how audio actually
flows). This document **adds interaction detail**; where it appears to narrow
pd-canvas.md it says so explicitly and gives the reason.*

*Constraints held throughout: no timeline (Law C-1) · no engine change · pointer-first,
single user · `RoutingMatrix` and `SourcesBrowser` are repurposed, never re-invented.*

**Naming note.** This document says **Cell** (pd-canvas.md's word). The component that
renders it today is `web/src/plane/Strip.tsx`. Same object; the rename is cosmetic and
not required by anything here.

---

## 0. The brief, restated as a design target

The user asked for an **intuitive playground** of **few objects** — *"1 player that can do
it all."* That phrase is a constraint on the *count*, not just the look. Every decision
below is judged against three tests:

1. **The Few test.** Does this make it easier to end up with 5 objects than with 25?
2. **The Playground test.** Can you touch it and hear a change, without reading anything?
3. **The Comprehension test.** After 20 minutes away, does the plane still tell you where
   the audio goes? (routing.md's graph must stay legible on a plane with no cables.)

A diagram passes 3 and fails 2. A toy passes 2 and fails 3. The plane has to pass both,
and "few objects" is what makes that possible: comprehension is cheap at n=6 and
impossible at n=60. **The object budget is the design.**

---

## 1. CREATION — how a thing gets onto the plane

### 1.1 The rule: nothing arrives unbound, nothing arrives silent

> **R-CREATE-1.** A Cell is never created without a Source. There is no empty Cell you
> then configure.
>
> **R-CREATE-2.** A Cell is audible the moment it exists: `gain = 0.75` (unity detent,
> D-WZ-FADER-01), `mute = false`, `outBus = 0` (main). A Cell that arrives *with material*
> arrives **looping**.

R-CREATE-1 kills the "form to fill in" failure mode. An unbound Cell is a dialog wearing
a rectangle: it teaches the user that the plane is a place where you *configure* things.
The schema's `source.kind: 'none'` stays what routing.md §2 says it is — a **preserved
placeholder for a source that vanished** (preserve-don't-drop), never a creation state.

R-CREATE-2 is the single strongest antidote to GRM's documented failure
(*"couldn't even figure out how to make the sound loop"* [kvr 500424]). **If it is already
looping, that question is never asked.** The discoverable verb becomes *stop*, and stop is
trivially discoverable because it is the thing you reach for when noise is happening. This
is also GRM's own stated philosophy (*faire et entendre* — doing and hearing) applied more
literally than GRM applies it, and it is Law C-3 generalised: C-3 says a *recording* loops
the instant you stop; R-CREATE-2 says a *loaded* thing loops the instant it lands.

### 1.2 Three creation gestures, no more

| Gesture | Result | Rationale |
|---|---|---|
| **Double-click empty plane** | Spawn puck opens **at that point** → pick a source → Cell appears there, bound, audible | The point of creation is where you pointed. No travel to a rail and back. |
| **Drop a file / Take onto empty plane** | Cell **with material** at the drop point, loaded and **looping** | The OS drag is already the user's mental model for "put this here". |
| **Drop a file / Take onto an existing Cell** | That Cell's **material is replaced** — no new Cell | The Few test. This is AudioMulch 2's drag-over-to-attach, adapted. |

Everything else is deleted from the vocabulary. Notably **there is no duplicate/copy verb
in v1** — duplication is the single fastest route from 6 objects to 30, and nothing in the
brief needs it.

### 1.3 The spawn puck (replaces the persistent sources rail)

`SourcesBrowser` today is a permanent left rail (`web/src/panels/SourcesBrowser.tsx`).
On the plane it is **re-hosted, not retired**: the same list, the same
`addSourceChannel` / `addLoopbackStrip` / `addDeckWithStrip` actions, summoned at a point
and dismissed on choice or Escape.

```
   double-click here
          ↓
      ┌───────────────────────────────┐
      │ bind…                    [esc]│
      │ ─────────────────────────────  │
      │ ● Built-in Mic                │   ← device inputs
      │ ● Scarlett 2i2 In 1           │
      │   Scarlett In 1/2   (pair)    │
      │ ─────────────────────────────  │
      │ ◼ Spotify            on plane→│   ← already bound: FOCUS, don't duplicate
      │ ◼ Safari                      │
      │ ─────────────────────────────  │
      │ ▤ empty deck            3/8   │   ← material Cell, no material yet
      │ ↺ loopback · main   +10.7 ms  │   ← cost stated, per playback-composer §2
      │ ↺ loopback · cue              │
      └───────────────────────────────┘
```

- It opens **anchored to the click point**, flips to stay on screen, and closes on choice,
  Escape, or any click outside. It never persists — the plane has no permanent rail.
- **Escape creates nothing.** There is no orphan state to clean up.
- The freshly created Cell is **left selected**, so the Inspector is already showing it and
  `Delete` is a one-key undo of the creation.

### 1.4 Keeping it to FEW — four concrete mechanisms

1. **Source dedupe (the big one).** A Source already bound on the plane is listed as
   `on plane →`, and choosing it **pans/zooms to the existing Cell and selects it**
   instead of creating a second one. One mic = one Cell, enforced by the only affordance
   that could break it. (Escape hatch, deliberately awkward: `⌥`-click the entry forces a
   second binding. Rare, real — two decks reading the same input — but never accidental.)
2. **Material is not an object.** Loading a Take, loading a file, and recording all put
   *material into a Cell*. None of them creates a Cell. A session with twelve takes can be
   a plane with three Cells.
3. **Delete is one key and always available.** `Delete` / `Backspace` on the selection.
   Cheap removal is what makes cheap creation safe.
4. **Soft advisory at 12.** Past 12 Cells the plane's fit control gains a quiet
   `12 cells · tidy` affordance (§2.4). No hard cap, no nagging, no modal. It is a
   thermometer, not a gate.

**Rejected: a persistent drawer/palette.** AudioMulch 2 added a side-bar palette
precisely because its creation flow (right-click → *New Contraption* menu) was slow at
*hundreds* of objects. At six objects a permanent rail costs screen edge every second to
save two seconds once, and it reintroduces the "sources are a different species over
there" split that D-WZ-PDCANVAS-01 exists to remove.

---

## 2. ARRANGEMENT — free placement, and what placement is allowed to mean

### 2.1 Recommendation

> **R-PLACE-1.** Placement is **mnemonic and expressive, never operative.** Moving a Cell
> changes **no audio, ever** — not its bus, not its level, not its cue state, not its
> neighbours.
>
> **R-PLACE-2.** The plane may **express** routing spatially on demand (`tidy by bus`,
> §2.4), but the flow is one-way: **routing → layout, never layout → routing.**

This is a *refinement* of pd-canvas.md §4's "Placement is meaning", not a contradiction.
§4's own examples — *"group by role, by song section, by physical stage position"* — are
all **user meaning**, and it ends *"the arrangement is the user's."* R-PLACE-1 states the
other half: the *machine* reads no meaning out of position.

### 2.2 Why not proximity/zone routing

Borderlands is the honest counter-argument and it is worth stating properly, because it
*works*: its grain clouds read whatever sound rectangles they sit over — *"By selecting a
cloud and moving it over a rectangle, the sound contained in the rectangle will be sampled
at the relative position of each grain voice"*, and *"where files overlap the grains mix
their audio"*. Position **is** the patch, and it is delightful.

It works there because of three properties Wizard does not have:

| Borderlands | Wizard |
|---|---|
| Consequence is **continuous** — a 3 px nudge changes the sound 3 px worth | Consequence is **discrete** — a bus reassignment is a jump, and can silence a Cell (bus 5 on a 2-out device is *unmapped*, routing.md §4) |
| Consequence is **immediately audible and self-explaining** | A wrong bus on an unmapped output is **silence with no visible cause** |
| Touch-first, deliberate, whole-hand gestures | Pointer-first: a 4 px accidental drag while clicking a fader is routine |
| No feedback path | A LoopbackBus Cell exists; accidental routing near it is a **feedback risk** the watchdog then has to catch (playback-composer §3) |

A UI where dragging can silently re-route audio, next to a legal feedback edge, is a
hazard. Bitwig and Reason both — independently, at very different scales — keep placement
mnemonic and routing explicit. Follow them.

**Also rejected: a grid.** GRM has none [PlanTravail, pd-canvas §4.1] and a grid imposes a
meaning the user did not choose. At six objects, a grid solves a problem nobody has.

### 2.3 Alignment guides — the exact, deliberately small, spec

Snapping exists only to make deliberate tidiness *land*, not to organise for you.

- **Trigger:** while dragging, compare the dragged Cell's **left / centre-x / right** and
  **top / centre-y / bottom** against those of every other Cell.
- **Threshold: 6 *screen* pixels**, not plane units. Measured post-scale, so the snap feels
  identical at 40 % and 200 % zoom. (A plane-unit threshold would make snapping violent
  when zoomed out and unreachable when zoomed in.)
- **Feedback:** a 1 px `--line`-coloured guide across the aligned span, drawn only while
  held. It disappears on pointer-up. No persistent guides, no rulers.
- **Override:** hold `⌥` to suppress snapping entirely for that drag.
- **Nothing else.** No distribute, no auto-arrange on drop, no magnetism between edges, no
  collision avoidance. Cells may overlap; overlapping means nothing (§2.2).

```
    ┌───────────┐            ┌───────────┐
    │ Mic       │            │ Spotify   │
    └───────────┘            └───────────┘
    ┊                                                    ← 1px guide, live only
    ┌───────────┐  ←── snapping into left-alignment
    │ Take 3  ⟳ │      within 6 screen px
    └───────────┘
```

### 2.4 Descriptive left-to-right, and one explicit tidy verb

Bitwig's Grid establishes left-to-right as a *convention* — inlets left, outlets right,
*"although there's nothing stopping you patching from right to left"*. Wizard has no ports,
but the convention is still worth **seeding and never enforcing**:

- **Auto-placement bias.** When a Cell is created without a point (migration auto-layout,
  first-run Cell), place by role: **sources left → material centre → loopback/bus taps
  right**. The plane's default state therefore *reads* as flow, and a first-time user
  inherits a sensible arrangement they can immediately violate.
- **`tidy` (the affordance next to `fit`).** A single explicit command that re-lays the
  plane into **columns by output bus**, preserving relative order within each column, with
  one animated move. It is the plane's "show me the routing as a picture" button, and it is
  the only thing that ever moves a Cell without the user dragging it. Pressing it twice is
  idempotent; it is undone by moving anything.

---

## 3. ROUTING VISIBILITY — the hard one

### 3.1 The shape of the problem (and why "cables" is the wrong instinct)

Wizard's graph is not a mesh. Per routing.md §4 and playback-composer §4 it is a **star**:

```
   channel ──┐
   channel ──┼──▶ bus 0 (main)   ──▶ device 1/2
   channel ──┘                        ┊
   channel ─────▶ bus 2         ──▶ device 5/6
   any channel ─┈┈▶ monitor/cue ──▶ device 3/4   (independent boolean, toMonitor)
   busTap Cell ◀┈┈ bus[n] one block behind  ← the ONE legal cycle
```

Every Cell has **exactly one** output-bus edge (`outBus: 0..7`), **plus** an independent
cue boolean (`toMonitor`), **plus** — for a `busTap` Cell only — one inbound loopback edge.
There is no channel-to-channel routing at all, and there won't be before P6 sends.

So a general cable layer would draw *n* lines that all converge on the same handful of
points, off the edge of a boundless plane. That is maximum ink for near-zero information:
it re-renders a **fact each Cell can simply state about itself**. Max/MSP's own users
reach the same conclusion at scale and switch to `send~`/`receive~` — *"signal connections
without patch cords"*, named buses instead of lines — which is precisely the topology
Wizard already has natively.

> **R-ROUTE-1. No general cable layer.** Not on by default, not as an option, not later.
> Wizard's graph is a star; a star is drawn with **labels**, not lines.

### 3.2 The four-layer answer

#### L0 — The bus chip (always visible, on every Cell)

Every Cell's header carries a chip: a **bus colour swatch + short label**, plus the cue
lamp. It is the answer to "where does this go?" at a glance, at every zoom tier (§4).

```
┌ Mic ──────────────────────────── ▊▊▁ ─┐
│ ▸1 main   ◌cue                        │      ▸n = output bus, coloured swatch
│ ─────────────────────────────────────  │      ◌ / ◉ = toMonitor off / on
```

- Chip **colour** is per-bus, from a fixed 8-hue ramp; the **kind** accent
  (`--chan-device` etc., already in `tokens.ts`) moves to a 2 px left edge stripe on the
  Cell so the two vocabularies never fight for the same pixel. *Kind is what it is;
  bus is where it goes.* Those must not be one colour.
- Clicking the chip opens an 8-bus + cue popover. Buses the device cannot carry are shown
  **greyed and labelled `unmapped`** (`deviceInfo.mappableBuses`) — routing.md §4's
  never-silently-fold law, made visible at the moment of choosing rather than discovered
  as silence.
- Default is `main` for everything, so in the common session **every chip says `main` and
  the user never touches one**. That is Reason's lesson: *"everything is automatically
  connected for you in a logical flow, but you're free to break the rules."* The routing UI
  should be invisible until you disagree with it.

#### L1 — Trace (momentary, zero persistent chrome)

Hold **`R`** (or hover any bus chip / bus badge). This is the plane's cable layer,
rented by the second:

```
  ── hold R with bus 3 under the pointer ────────────────────────────┐
  │                                                                  │
  │   ░Mic░ (dim)         ┌ Take 3 ─────┐ ══════╗          ┌ BUSES ┐ │
  │                       │ ▸3          │       ║          │ ▸1  2 │ │
  │   ░Spotify░ (dim)     └─────────────┘       ╠═════════▶│ ▸2  0 │ │
  │                       ┌ Take 5 ─────┐       ║          │ ▸3  2◀│ │
  │                       │ ▸3          │ ══════╝          │ ▸4  – │ │
  │                       └─────────────┘                  │ ◉cue 1│ │
  │                                                        └───────┘ │
  └──────────────────────────────────────────────────────────────────┘
     members bright · non-members dimmed · ONE ribbon converging on the badge
```

This is Bitwig's unified-modulation pattern, verbatim in behaviour: entering routing mode
makes *"all currently assigned destinations become brightly colored, and all potential
destinations shaded"* — cable-free routing visibility that exists only while you ask for
it. Release `R` and the plane is clean again. Nothing is added to the resting UI.

#### L2 — The bus rail (the plane's edge of the world)

A thin, always-visible column of badges at the plane's **right edge**, outside the pan/zoom
transform (it does not move with the plane; signal leaving the plane should not itself be
pannable):

```
┌────────┐
│ ▸1 main│ 3  ▊▊▁      ← swatch · name · member count · live bus meter
│ ▸2     │ 0  ▁        ← empty buses stay listed: the vocabulary is visible
│ ▸3     │ 2  ▊▁
│ ▸4 –   │ –           ← "–" = unmapped on this device (honest, not hidden)
│  ⋮     │
│ ◉ cue  │ 1  ▊▊       ← the monitor bus, same species
│ ↺ loop │ 1           ← loopback taps live here too
└────────┘
```

- **Drag a Cell onto a badge = assign it to that bus.** One gesture, no popover, and it is
  the only drag on the plane with an audio consequence — which is exactly why the target is
  a *fixed badge at the screen edge*, not another Cell and not a region of the plane. You
  cannot hit it by accident; you cannot hit it by nudging. (AudioMulch's drag-onto-target
  connect, aimed at a destination rather than at a peer.)
- Click a badge = latched Trace (L1) for that bus. Click again to release.
- The rail is also the routing **inventory**: it shows buses that exist but are empty, so
  "there are 8 buses" is learnable without documentation.

#### L3 — The ledger: `RoutingMatrix` as a summoned overlay

`web/src/panels/RoutingMatrix.tsx` already renders channels × {out bus, monitor} and
already owns the honest output-map footnote. **Keep it, unchanged in substance**; change
only its host: from a permanently docked collapsible section to an overlay on one key
(`⌘R` / `Routing…`). It is the authoritative table for the pathological case ("I have 14
Cells and something is going somewhere wrong") — the same role Bitwig gives its Inspector,
which *"lets you comfortably view, edit and remove any of the current Modulation
routings"*. Nobody should need it in a six-object session; it must exist for the day
somebody does.

### 3.3 The one real cable: loopback

> **R-ROUTE-2.** The **only** persistent connector drawn on the plane is the loopback edge.

A `busTap` Cell draws a single curved arrow from its source bus badge back into itself,
always visible, labelled with its cost:

```
   ┌ BUSES ┐
   │ ▸1 main│──╮
   └────────┘  │  ╭───────────────────────────╮
               ╰──│ ↺ Loopback (main)         │
                  │ ↺ one block · +10.7 ms    │   ← playback-composer §2, stated not hidden
                  │ ▁▂▃ ▊▊▁      ▸2   ◌cue    │
                  ╰───────────────────────────╯
```

The reasoning is the exception that proves R-ROUTE-1: this edge is the one that is
**genuinely a cycle**, **genuinely surprising**, and **genuinely dangerous** (it is the
path that makes the feedback watchdog necessary). Spending the app's entire cable budget on
the single edge that needs explaining is what makes the absence of every other cable read
as *design* rather than omission. It also arrives muted (per `SourcesBrowser`'s existing
copy), so the drawn arrow is the user's first explanation of why.

### 3.4 Explicitly rejected

| Option | Verdict | Why |
|---|---|---|
| Persistent cables everywhere | **No** | Star topology; maximum ink, zero information (§3.1) |
| Optional cable overlay toggle | **No** | A toggle is a mode you can get stuck in. L1's momentary `R` is strictly better and cheaper |
| Proximity / drop-zone routing | **No** | Discrete, silence-capable, feedback-adjacent consequences from a nudge (§2.2) |
| Bus = background zone the Cell sits in | **No** | Same hazard as proximity, and it fights free placement, which is the whole feature |

---

## 4. ZOOM SEMANTICS — semantic, with a hard identity rule

### 4.1 The rule

> **R-ZOOM-1.** Zoom is **semantic in density, geometric in position.** What a Cell *is*
> never changes with zoom; how much of it is drawn does.
>
> **R-ZOOM-2. The survival set.** Four things are legible at **every** tier:
> **name · meter · bus chip · state glyph.** (Who · how loud · where to · what it's doing.)
>
> **R-ZOOM-3.** Typography and hit targets **clamp**; geometry scales. Below ~10 px
> effective text size, text counter-scales instead of shrinking. Interactive targets never
> fall below **24 screen px**.

R-ZOOM-3 is what turns "zoom out" into a *usable mode* rather than a thumbnail preview —
and pd-canvas.md §4 stakes P4-08 on exactly that: *"strip mode becomes zoom-out, not a
separate layout."* A strip you can read but not click is not a strip mode.

### 4.2 The three tiers

Keyed off `scale`, with **hysteresis** (enter Normal at 0.95 descending, leave at 1.05
ascending; enter Collapsed at 0.45, leave at 0.55) so a slow wheel never flickers.

**DETAIL — `scale ≥ 1.0`** — everything on-Cell per pd-canvas §3.0's left column:

```
┃┌ Take 3 ──────────────────────── ▊▊▊▁ ─┐   ┃ = kind stripe (--chan-deck)
┃│ ▸1 main  ◉cue                    loop │
┃│ ▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▂▁▂▃▅  │   waveform + live playhead (HotSurface)
┃│      └───── loop brace ─────┘          │
┃│ ●  ⟳  ▸  ◼            M  S  C          │   transport + switches
┃│ level ├────────●──┤            0.0 dB  │
┃│ pan   ├────●───────┤              C    │
┃│ speed ├──────●─────┤           1.00×   │
┃└────────────────────────────────────────┘
```

**NORMAL — `0.5 ≤ scale < 1.0`** — the performance subset. Numeric readouts hide (bars
remain); pan and speed drop to the Inspector; the waveform halves in height but keeps the
loop brace and playhead:

```
┃┌ Take 3 ─────────────── ▊▊▊▁ ─┐
┃│ ▸1 main  ◉cue           loop │
┃│ ▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▂▁▂▃  │
┃│ ●  ⟳  ▸  ◼        M  S  C    │
┃│ level ├────────●──┤          │
┃└──────────────────────────────┘
```

**COLLAPSED — `scale < 0.5`** — **this is strip mode** (P4-08, re-scoped):

```
┃ Take 3   ⟳  ▊▊▊▁  ▸1     ← name · state glyph · meter · bus chip. Nothing else.
```

- The **whole tile is one hit target**: click selects, and the Inspector — always visible —
  carries every control. A collapsed plane plus the Inspector is a complete, operable
  instrument, which is what makes zoom-out a *mode* rather than a *view*.
- One exception to collapse: the **transport glyph stays clickable** as a secondary target
  if it can hold 24 px. Stop/loop must never require a zoom-in.

### 4.3 Two supporting rules

- **R-ZOOM-4. The selected Cell never renders below NORMAL.** Zoom out to survey, keep
  working on the one you care about. This is the mechanism that makes "strip mode" livable:
  the plane is a row of tiles and the thing in your hands is still a player.
- **R-ZOOM-5. Zoom never moves a Cell.** `zoomAbout()` in `planeLayout.ts` already holds
  the point under the cursor fixed — that invariant is load-bearing for trust and must
  survive tier switching (a tier change alters the Cell's *drawn height*; anchor the change
  to the Cell's **top-left**, never its centre, so nothing under the pointer jumps).

### 4.4 The existing controls, unchanged in placement

`Plane.tsx` already puts `− · % · + · 1× · fit` bottom-right. Keep the position (GRM's
verified placement [PlanTravail]); keep `fit` (ours, since GRM has no overview aid at all);
add `tidy` (§2.4) beside it. **No minimap** — pd-canvas §4.1 rules it out of the first cut
and n≤12 does not need one.

---

## 5. SELECTION + INSPECTOR

### 5.1 Selection

| Gesture | Meaning |
|---|---|
| Click a Cell | Select it (replaces selection) |
| Click empty plane | Deselect all |
| `Shift`+click a Cell | Add / remove from selection |
| `Shift`+drag on empty plane | **Marquee** (additive) |
| Drag on empty plane | **Pan** — unchanged; the user says this already feels good |
| `Space`+drag anywhere | Pan, including over Cells |
| `Tab` / `Shift-Tab` | Cycle selection in reading order, **panning the plane to keep the selected Cell in view** |
| `Delete` | Remove selected Cells |
| `Escape` | Cancel the current drag / close the spawn puck / deselect |

- **Drag threshold: 4 px.** Below it, pointer-up is a *click*. Without this, every click on
  a fader is a 1 px move and the arrangement rots.
- **Selection reads as a ring, not a colour.** A 2 px `--accent` outline with a 1 px offset
  gap. Colour is already carrying kind (edge stripe) and bus (chip); a third colour meaning
  would collapse all three.
- **Z-order does not change on selection.** The selected Cell is raised via `z-index`
  only — never reordered in the document — so selecting something never shuffles the plane
  under the pointer.
- `Tab`'s pan-to-reveal is doing double duty as a discoverability device: it is how a user
  learns there are Cells off-screen without a minimap.

### 5.2 Multi-select has one job, and it is worth its complexity

Multi-select exists so that **routing four Cells to bus 3 is one action**, not four. That
is its justification; if it did not enable that, it would not be in v1.

- Dragging with a multi-selection moves all of them; **alignment guides evaluate the
  selection's bounding box**, not each member (otherwise six Cells fight over six snaps).
- Dragging a multi-selection onto a bus badge (§3.2 L2) assigns them all.
- The Inspector shows the **intersection**: fields shared by every member are editable;
  differing values display `—`; editing writes to all. Fields that are meaningless for part
  of the selection (loop points, when one member has no material) are hidden, not disabled.

### 5.3 The Inspector

Always visible, right dock, ~260 px, three stacked sections. It is **not a mode** — that is
the whole point of pd-canvas §3.0's split, and it is why GRM's own Inspector is the right
precedent to copy (*"rassembler, éditer les informations sur les objets"*, selection-driven
and permanently on screen).

```
┌ INSPECTOR ─────────────────┐
│ IDENTITY                   │
│  name   [ Take 3        ]  │
│  source  deck 2  [rebind]  │
│  trim    ├──●──┤   0.0 dB  │
│ ─────────────────────────  │
│ ROUTING                    │
│  out bus  [▸1 main    ▾]   │   ← the RoutingMatrix's per-strip choice, relocated
│  cue      [◉ on ]          │
│  device   out 1/2          │   ← honest map; "unmapped" when the device can't
│ ─────────────────────────  │
│ MATERIAL                   │
│  loop in   [   44100 ]     │   ← drag on the Cell is coarse; type here (§3.0)
│  loop out  [  132300 ]     │
│  speed     [   1.000 ]     │
│  align to  [ Take 1   ▾]   │   ← Law C-2: a subtraction, not an edit session
└────────────────────────────┘
```

**The empty-selection state is not blank** — a blank panel is 260 px of dead space
teaching the user that the Inspector is usually useless. With nothing selected it shows the
**plane summary**:

```
┌ INSPECTOR ─────────────────┐
│ PLANE                      │
│  6 cells · 2 with material │
│  buses in use  ▸1 ×4  ▸3 ×2│
│  cue           1 cell      │
│  device  Scarlett 2i2      │
│          48 000 Hz · 512   │
│  monitor unmapped (2 outs) │
│  ─────────────────────────  │
│  [ fit ]  [ tidy ]  [ ⌘R ] │
└────────────────────────────┘
```

That doubles as the "where is everything?" readout that pd-canvas §5 names as the honest
cost of leaving the rack.

---

## 6. DISCOVERABILITY — antidotes that add no chrome

GRM's failure is documented and specific: reviewers *"couldn't even figure out how to make
the sound loop"*, and *"the Tutorial is clearer than the Documentation"* [kvr 500424]. GRM
already has an always-visible Inspector and a "?" tooltip toggle, and still failed — so
**the Inspector alone is not the antidote**, and neither is a help mode. Seven antidotes,
none of which adds resting UI:

1. **It arrives playing (R-CREATE-2).** The number-one antidote. You cannot fail to start
   something that already started. Every subsequent question ("how do I stop it?", "how do
   I make it faster?") is asked *while hearing sound*, which is the condition under which
   people experiment.
2. **First run is not an empty plane.** On a fresh session, auto-create **one** Cell bound
   to the default device input, centred, metering. The user sees a meter move before they
   have done anything. Nothing has to be discovered to receive feedback. (This is GRM's own
   *faire et entendre*, applied to second zero.)
3. **The empty-plane message sits where the gesture goes.** Not a banner across the top: a
   single dimmed line plus a ghost Cell outline **at the centre of the viewport**, reading
   `double-click to bind a source · or drop a file here`. It vanishes permanently once one
   Cell exists, so it costs nothing after minute one.
4. **Consequence-titled controls, everywhere.** `Strip.tsx` already does this for record
   (`"stop — loops instantly (Law C-3)"`). Make it a rule: **every on-Cell control's title
   states what will happen, not what the control is called.** `⟳` is not "loop", it is
   "loop — plays the region between the braces, forever". A name teaches vocabulary; a
   consequence teaches the instrument.
5. **Hold `?` reveals labels in place — momentary, never latched.** GRM's "?" is a *popup
   toggle* (a mode you can leave on, or fail to find). Ours is a held key: labels overlay
   every control and the bus Trace (§3.2 L1) lights up for as long as the key is down.
   A momentary key cannot be got stuck in, cannot be forgotten about, and needs no
   dismissal affordance.
6. **One glyph vocabulary, used everywhere and only there.** `● ⟳ ▸ ◼` for
   record/loop/one-shot/stop, `M S C` for mute/solo/cue, `▸n` for bus, `↺` for loopback.
   The same four transport glyphs appear at all three zoom tiers and in the Inspector.
   One vocabulary learned once beats any amount of labelling.
7. **No right-click-only actions.** Every context-menu item must also be reachable from the
   Inspector or a visible control. Right-click may be a *shortcut*; it may never be the
   *only* path. (This is the specific mechanism by which canvas apps become unlearnable.)

**Explicitly not adopted:** a tutorial overlay, coach marks, a first-run wizard, a tips
panel. Each is chrome that solves discoverability by *deferring* it, and each has to be
dismissed — which means the app's first interaction is a dismissal.

---

## 7. Comparable tools — what was verified, and what transfers

Five surveyed; each row is something checked against a primary or review source, not
recalled.

### 7.1 AudioMulch (Patcher)

**Verified:** Contraptions are boxes on a canvas with inputs on top, outputs on the bottom,
wired by dragging patch cords. v1's pain was explicit — *"every patch cord must be
connected manually, and inserting a contraption in between two existing contraptions often
involves deleting the connecting patch cords and then creating new ones"*. v2 fixed it with
a palette you drag from and **auto-connect on drop**: *"if you drag a new contraption over
an existing one it will auto-connect, inserting it into the signal flow automatically"*;
SOS lists *"Drag-and-drop Contraption creation (drag a new Contraption over an existing
input or output to connect or attach it)"* and *"Reconnectable patch cords (grab them at
either end)"*.

**Transfers:** *dropping onto an object should mean something.* We take the gesture and
point it at the two places it is safe: **drop a file onto a Cell = load material** (§1.2)
and **drag a Cell onto a bus badge = assign** (§3.2). **Doesn't transfer:** the palette as
permanent furniture — that solves a hundred-object problem (§1.4).

### 7.2 Bitwig — The Grid, and the unified modulation system

**Verified (Grid):** *"In ports are always on the left of modules, and out ports are on the
right"*; *"signals flow from left to right by convention... although there's nothing
stopping you patching from right to left or vertically if you don't mind the
disorganisation that results."*

**Verified (modulation — the more valuable half):** routing is created **without cables**.
Clicking a modulator's routing button means *"the button itself begins flashing, all
currently assigned destinations become brightly colored, and all potential destinations are
shaded"*; you then *"click the target parameter and drag its value to set the point of
maximum modulation"*; depth reads as a coloured ring on the target; and the Inspector's
sources tab lists every active routing with an `x` to remove each.

**Transfers:** this is the **direct model for §3.2 L1 (Trace)** — momentary highlight of
members, shading of non-members, no persistent lines — and for L3 (the matrix as the
authoritative list). Also confirms §2.4's descriptive-not-enforced left-to-right.

### 7.3 Reason (the rack)

**Verified:** `Tab` flips between front panel and back panel; the front is controls, the
back is *"where you wire devices together using virtual cables"*; *"everything is
automatically connected for you in a logical top-to-bottom flow, but you're free to break
the rules"*; and cables have a **hidden mode** for *"when you have many connections that
obscure the view."*

**Transfers:** two things, and they are the backbone of §3. First, **defaults so good the
routing UI is never opened** — Wizard's equivalent is `outBus = 0` on every Cell, so every
chip reads `main` until you disagree. Second, **routing lives on a surface you summon** —
Reason flips the rack; we hold `R`. Even the app that *believes* in cables hides them by
default at scale.

### 7.4 Max/MSP & Pd (`send~` / `receive~`)

**Verified:** *"It is possible to make signal connections without patch cords by using the
MSP objects send~ and receive~"*; all `send~` objects sharing a name feed all `receive~`
objects of that name, they need not be in the same patch, the destination is changeable
on the fly with `set`, and multiple senders to one name **sum**. Widely documented as the
remedy for visual clutter in dense patches.

**Transfers:** the strongest single argument for R-ROUTE-1. The most cable-native
environment there is provides a **named, cable-free bus** for exactly the topology Wizard
has, and its users adopt it as patches grow. Wizard's `outBus` *is* `send~ main`; the
correct rendering is therefore a **label**, not a line. (It is also literally the mechanism
behind our own loopback: playback-composer §2 describes it as *"the classic
send~/receive~ one-block delay"*.)

### 7.5 Borderlands Granular (the counter-example, taken seriously)

**Verified:** each waveform is *"constrained to a rectangle and can be selected, moved, and
resized"*; the grain space holds multiple files *"which you can stretch, rotate and
overlap, and where files overlap the grains mix their audio"*; *"by selecting a cloud and
moving it over a rectangle, the sound contained in the rectangle will be sampled at the
relative position of each grain voice as it is triggered"*; clouds are created by
double-tapping empty space; parameters are edited by dragging satellite circles nearer or
further from the cloud; and the design *"emphasises gestural interaction and visual
feedback over knobs and sliders."*

**Transfers:** (a) **double-tap empty space to create** — adopted verbatim as §1.2's
double-click; (b) the proof that a **few large objects with direct manipulation** reads as
an instrument rather than a diagram, which is the target the user actually described.
**Deliberately not transferred:** position-as-routing (§2.2 — it works because its
consequences are continuous, audible and touch-scale; Wizard's are discrete, silence-capable
and pointer-scale).

*(Also consulted: Reaktor Blocks — the relevant note is a user critique that Blocks' panel
density is very low *"because of all the huge graphics"* even before cables, landing it
*"something in the middle"* between a VST UI and a modular. It is the cautionary case for
a plane of few objects: big objects are only worth their area if every pixel is doing
work — which is what §4's tiers and §3.0's on-Cell/Inspector split are for.)*

---

## 8. What this asks of the build (mapping to PD-CANVAS-02..05)

Nothing here changes the engine, the ABI, or the schema beyond what D-WZ-PDCANVAS-01
already signed.

| Increment | Adds from this spec |
|---|---|
| **PD-CANVAS-02** (Plane + Cell) | drag-to-move with 4 px threshold · 6-screen-px alignment guides + `⌥` override · selection ring, marquee on `Shift`+drag, `Tab` cycling · zoom tiers §4.2 with hysteresis + clamped type/targets · kind stripe + bus chip |
| **PD-CANVAS-03** (Inspector) | §5.3 including the **plane-summary empty state** and multi-select intersection editing |
| **PD-CANVAS-04** (create) | spawn puck §1.3 (re-hosting `SourcesBrowser`'s list + actions) · file/Take drop, onto plane vs onto Cell · source dedupe · first-run Cell |
| **PD-CANVAS-05** (retire panels) | bus rail §3.2 L2 · Trace on hold-`R` §3.2 L1 · `RoutingMatrix` → summoned overlay · loopback arrow §3.3 · `tidy` §2.4 · hold-`?` labels |

**Open questions for the user (do not block the build):**

1. **Does a dropped file loop immediately, or land stopped?** This spec says **loop**
   (R-CREATE-2) on the argument that it is the strongest antidote to GRM's failure. It is
   also the one recommendation here that changes what you *hear* rather than what you see,
   so it is worth a yes/no.
2. **Bus colours.** 8 hues means the palette is no longer purely the neutral-grey chrome
   the shared identity specifies. Proposal: low-saturation hues at chip scale only, kind
   accents reduced to a 2 px stripe. Needs a look-and-feel sign-off, not a design decision.
3. **Soft advisory at 12 Cells** — is a thermometer wanted at all, or is silence better?

## Sources

- [AudioMulch — Ways to Connect and Disconnect Contraptions](http://www.audiomulch.com/help/patcher-connecting-contraptions) · [AudioMulch 2 – less pain with patchcords](http://www.audiomulch.com/blog/audiomulch-2-%E2%80%93-less-pain-with-patchcords) — manual patching tedium; palette; auto-connect on drop
- [Sound On Sound — AudioMulch 2.0](https://www.soundonsound.com/reviews/audiomulch-20) — drag-and-drop contraption creation, reconnectable patch cords
- [Bitwig — The Unified Modulation System](https://www.bitwig.com/userguide/latest/the_unified_modulation_system/) — flashing source, brightly-coloured assigned destinations, shaded potential destinations, Inspector routing list
- [Bitwig — Getting Around In The Grid](https://www.bitwig.com/learnings/getting-around-in-the-grid-39/) · [Sound On Sound — Bitwig Studio 3](https://www.soundonsound.com/reviews/bitwig-studio-3) — in-left/out-right, left-to-right by convention only
- [Reason — Working with the Rack](https://docs.reasonstudios.com/reason13/working-with-the-rack) · [Routing Audio and CV](https://docs.reasonstudios.com/reason13/routing-audio-and-cv) — Tab flips the rack; auto-routing; hidden-cable mode
- [Cycling '74 — send~](https://docs.cycling74.com/max8/refpages/send~) · [MSP Basics Tutorial 4: Routing Signals](https://docs.cycling74.com/learn/articles/05_mspbasicchapter04/) — signal connections without patch cords; named buses; senders sum
- [Borderlands: An Audiovisual Interface for Granular Synthesis (NIME 2012)](https://www.nime.org/proceedings/2012/nime2012_152.pdf) · [Sound On Sound — Borderlands Granular](https://www.soundonsound.com/reviews/borderlands-granular) · [Borderlands Granular](http://www.borderlands-granular.com/app/) — sound rectangles, overlap mixes grains, cloud-over-rectangle sampling, double-tap to create, gesture over knobs
- [KVR t=549809 / modwiggler 176035](https://www.kvraudio.com/forum/viewtopic.php?t=549809) — Reaktor Blocks panel-density critique ("something in the middle")
- [KVR t=500424](https://www.kvraudio.com/forum/viewtopic.php?t=500424) — GRM Player discoverability failure (the target we are designing against)
- [GRM Player — Plan de travail](https://sites.inagrm.com/download/grmplayer/documentation/co/PlanTravail.html) · [Inspecteur](https://sites.inagrm.com/download/grmplayer/documentation/co/Inspecteur.html) — boundless plane, no grid/snap, zoom bottom-right, always-visible selection-driven Inspector
