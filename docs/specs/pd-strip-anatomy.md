# PD-STRIP-ANATOMY — the definitive anatomy of the ONE unified player object

*Design spec for `web/src/plane/Strip.tsx`. Downstream of `CONCEPT.md` (Laws C-1/C-2/C-3,
"everything is a channel"), `docs/specs/pd-canvas.md` (§3.0 on-Cell vs Inspector, §4/§4.1
verified GRM mechanics) and `docs/specs/design-notes-grm-player.md` §4. Nothing here needs
engine work; nothing here crosses the ABI; every colour/font/radius named here is a var
`tokens.ts::tokenVars()` already emits (checklist in §6).*

**Naming note.** pd-canvas calls the object a *Cell*; the code calls it a *Strip*
(`plane-strip`, `Strip.tsx`, `CellSchema` is only its geometry). This spec uses **Strip**
for the component and **cell** for its `{x,y,w,h}`. One word for the object — pick Strip
and drop "Cell" from prose, because the schema field it maps to is `Channel`, and
`Channel` is what the user's Patch actually contains.

---

## 0. Thesis, in one sentence

**A Strip is a player whose material may not exist yet** — so it is drawn as a player from
the first frame, not as a mixer strip that grows a player when you record into it.

That single decision resolves the whole spec. The current implementation does the
opposite: it renders a header + faders and *adds* a waveform when a deck appears. That is
why it reads as two species and why it reflows. Everything below follows from inverting it.

---

## 1. The layout-stability law (non-negotiable)

ARCHITECTURE §7 already records this as a *learned* constraint from ScoopyLoops: "Fixed
widths, no resize on state change." On a boundless plane it is stronger than in a rack,
because a rack reflows *within* itself while a plane Strip that changes height silently
invalidates `cell.h` — which `fitToContent()` (`planeLayout.ts`) computes framing against,
and which the session persists. A Strip that grows on record makes every saved arrangement
wrong.

**L1 — The box is authoritative, not the content.** The Strip's root element sets
`width: cell.w` **and `height: cell.h`**, plus `overflow: hidden`. Content is laid out to
fit the box; the box is never laid out to fit the content. *(Current code sets width only —
defect D1.)*

**L2 — Every row always exists.** State changes *fill*, never *presence*. The waveform row
exists on an unbound Strip. The `speed` row exists on a Strip with no material (dimmed and
inert). The status line exists when there is nothing to say (an empty reserved line).
A control that is meaningless in a state is **disabled, not removed**.

**L3 — The status line is one line with a priority ladder.** Never a stack. Exactly one
message renders, chosen by:

```
audio missing  >  cap reached  >  unmapped bus  >  decoding NN%  >
loopback +N ms  >  recording <source> → deck N  >  <take name> · <length>  >  records: <source>
```

*(Current code stacks `deck-unresolved` and `plane-strip-loading` into flow — defect D2.)*

**L4 — No font-size changes on state, ever.** State is carried by colour, by fill, by the
3 px kind bar, and by one word in the head. Never by growing text, never by adding a badge
that consumes a line.

**L5 — Canvas geometry is a pure function of `cell.w` and density.** `DeckWaveform`'s
`width`/`height` and `MeterCanvas`'s `width`/`height` are derived once from the box and do
not vary with state. `DeckWaveform` already rescales its x-axis internally while the buffer
grows (`span = recording ? liveFrames : frames`), so recording changes what is drawn, never
how big it is. Good — keep it that way.

**L6 — Selection uses `outline`, never `border`, never `padding`.** A border would move
every child by 1 px on select. `outline: var(--hairline) solid var(--accent)` draws outside
the box and costs zero layout.

**The test for any future addition:** open the Strip in two states side by side and diff
the bounding box of every child. Any child that moves is a bug.

---

## 2. Every state the Strip must express

Columns: **what changes** (visual delta only) and **what must never move**. "Never move" is
the same for all states by L1/L2 — the box, the row order, the row heights, the canvas
sizes, the type sizes — so the column below names the *specific* thing each state is
tempted to move.

| # | State | Detected from | What changes | What must never move |
|---|---|---|---|---|
| 1 | **empty / unbound** — `source.kind === 'none'`, no material | Patch | Kind bar `--chan-bus`. Head name reads the placeholder name in `--text-dim`. Wave field shows a centre hairline + "drop a source here" in `--text-dim`. All transport disabled. Status: empty. Level/pan live (they are still a channel); speed dimmed. | The wave field is present and full size. Do not collapse the object to a "+ add" tile — an unbound Strip is the drag target and must have the same footprint as its future self. |
| 2 | **bound input, no material** — source resolves, no deck | Patch | Kind bar takes the source's kind colour. Wave field shows the **live input trace** (§5.5) drawn from the channel's HotFrame `peakL/peakR`. Meter live. Transport: **REC enabled**, play verbs disabled. Status: `records: <source name>`. Speed row dimmed. | REC is in the same pixel position it will occupy for the rest of the object's life. This is the state a first-time user meets; the record verb must not migrate later. |
| 3 | **armed** — `recordArm === true`, engine not recording | Patch | REC button gets a slow pulse: `outline` in `--rec-lamp` at `--dur-base`. Head state word `arm` in `--rec-lamp`. Nothing else. | REC does not change size or label. Arm is a *lamp on the same button*, not a second button. |
| 4 | **recording** — deck state `3` | HotFrame | REC becomes `■ STOP` on `--rec-lamp` (existing `.latched-rec`). Kind bar switches to `--rec-lamp`. Head state word `rec` + elapsed `m:ss`. Wave draws live and left-anchored, write head at the right edge in `--rec-lamp` (`DeckWaveform` already does this). Loop brace suppressed. Status: `recording <source> → deck N`. Play verbs disabled. | The wave canvas does not grow, does not scroll the box, does not push the transport down. The elapsed counter is fixed-width (`m:ss`, tabular mono) so it cannot widen the head. |
| 5 | **has-material, idle** — deck state `0`, `sourcePath !== ''` | HotFrame + Patch | Wave drawn from the envelope in `--chan-deck`; loop brace in `--accent`; playhead parked. Head state word `idle` in `--text-dim`. Transport: all five verbs enabled. Speed row live. Status: `<take name> · <m:ss>`. | The wave field is the *same* canvas that was showing the live trace one frame earlier. The transition record→material must be a repaint, not a remount — this is Law C-3 made visible. |
| 6 | **playing — loop** — deck state `1` | HotFrame | Loop verb `⟳` latched in `--signal`. Head state word `loop` in `--signal`. Playhead rides in `--accent`. Loop brace solid. | Nothing. A loop is the resting state of this app; it must be the calmest-looking state, not the loudest. |
| 7 | **playing — one-shot** — deck state `2` | HotFrame | One-shot verb `▸` latched in `--accent`. Head state word `shot`. Playhead rides once; brace drawn dashed to say "not looping". | Same footprint as loop. One-shot is not a "mode", it is a verb you pressed. |
| 8 | **reversed / varispeed ≠ 1** — `deck.rate` | Patch | `speed` row's `GeoRange` fill runs left of centre (already: `origin="center"`). Its value readout switches to `--warn` when `rate < 0` (the precedent is `.varispeed-slider.reversed`). A small `◄` glyph replaces `►` in the fixed-width prefix of the value readout. Playhead travels the other way (engine truth). | The value readout is a fixed 9-char field: `−0.75×` and `+1.00×` occupy the same box. No re-flow at the reverse crossing. |
| 9 | **unresolved (audio missing)** — `deckUnresolved[id]` | runtime | Kind bar `--hot`. Wave field draws the centre hairline only, with `audio missing` centred in `--hot`. Status line (top of ladder): the full path, ellipsised, `title` carries the whole thing. Play verbs disabled; REC **stays enabled** (you may record over a missing reference — that is a repair, not a loss, and the reference is preserved until you do). | The Strip is not removed, not shrunk, not greyed to invisibility. Preserve-don't-drop is a *visual* law here too. |
| 10 | **loading / decoding** — `deckLoading[id]` | runtime | Wave field is replaced *in place* by the determinate bar (`.deck-loading` + `.deck-loading-bar`, reusing `deckLoadProgress`) drawn at the exact wave-field rect. Head state word `load`. All transport disabled. Status: `decoding NN%`. | The bar occupies the wave rect exactly. Do not insert a text line (the current `plane-strip-loading` does — defect D2/D6). |
| 11 | **capped** — `deckCapReached[id]` | runtime | Status line: `cap — 256 MB, take is on disk` on `--warn`. Head state word unchanged (the deck went from `rec` to `loop` by itself; that is the truth to show). Kind bar returns to normal. | The cap is a *status*, not a modal, not an extra row. It is transient information about a take that is fine. |
| 12 | **muted** | Patch | `M` latched `--hot` (`.latched-hot`). The **whole content area** drops to `opacity` at the dim level via a token-driven class — everything except the kind bar, the meter and the status line, which must stay legible so you can see a muted Strip still receiving signal. | Opacity, not display. Nothing is hidden. |
| 13 | **soloed** | Patch | `S` latched `--accent` (`.latched-accent`). Non-soloed Strips elsewhere on the plane dim by the same rule — solo is a *plane-wide* visual, computed once in `Plane.tsx` and passed down as a boolean, not re-derived per Strip. | — |
| 14 | **cued** | Patch | `C` latched `--signal` (`.latched-signal`). | — |
| 15 | **unmapped output bus** — `outBus >= deviceInfo.mappableBuses` | runtime + Patch | Status line: `unmapped — bus N not on this device` on `--warn`. | The console had this (`.strip-unmapped`); the plane dropped it (defect D7). A Strip that is silent for a routing reason must say so *without* being selected — that is why it is on the object and not only in the Inspector. |
| 16 | **loopback cell** — `source.kind === 'busTap'` | Patch | Kind bar `--chan-bus`. Status line: `↺ +N.N ms (one block)`. Wave field: live trace of the bus tap. | The honest price is stated (routing.md §2), on the object, in the reserved line — not in a tooltip. |
| 17 | **source vanished** — bound source no longer enumerable | runtime | Kind bar dims to `--text-dim`; head name gains a trailing `(offline)` in `--text-dim`. Live trace flatlines (it will, naturally). REC disabled. | Distinct from #9: #9 is *material* missing, #17 is *input* missing. Two different repairs; do not merge the message. |
| 18 | **feedback alarm** — global `feedbackAlarm` | HotFrame | Only on Strips whose `outBus` feeds the alarming path: head shows a `--feedback-lamp` dot to the left of the state word, in a slot reserved at all times. | The dot's slot is always reserved (L2), so the alarm cannot shift the state word. |
| 19 | **selected** (Inspector target) | UI | `outline: var(--hairline) solid var(--accent)` (L6). Nothing else — selection must not be a second visual language competing with state. | Zero layout cost. |

**States 15–19 are additions to the brief's list.** 15, 16 and 17 are regressions the plane
currently has against the console and must be recovered; 18 and 19 are required by
PD-CANVAS-03 (an always-visible Inspector needs a visible selection) and P4's watchdog.

---

## 3. On the object vs. in the Inspector

### 3.1 The test

pd-canvas §3.0 states the split as "what you touch while playing" vs "what you set
precisely". That is a good principle and a bad test — everything feels touchable. The
operational test is:

> **Would you do this with one hand, with sound running, without reading?**
> If yes → on the object. If it requires a decision, a name, or a number → Inspector.

A second, sharper test that catches the ambiguous cases:

> **Is it a *state you must see* even when the Strip is not selected?**
> If yes → on the object, even if it is not a control. (Warnings, meters, the state word.)

### 3.2 The split

**ON THE OBJECT** — always visible, direct manipulation:

| Element | Why it passes the test |
|---|---|
| kind bar + name (read-only) | Identity. Scanning a plane of twelve is the primary act. |
| state word + elapsed/length | The answer to "is it running?" must never require selection. |
| meter | Continuous, live, unselectable. |
| **wave field** — envelope, loop brace (drag), playhead, live trace | The GRM lesson (design-notes §2 ADAPT): act on the thing itself. Dragging a loop *is* the performance. |
| transport: **REC** · loop · one-shot · retrigger · stop | Five one-handed verbs. `retrigger` is missing today and must return (D8). |
| level, pan, speed | Continuous, heard immediately, no decision. |
| M / S / C | One-handed, latched, heard immediately. |
| status line | Test 2: you must see "unmapped"/"audio missing"/"cap" without selecting. |

**IN THE INSPECTOR** — selection-driven, precise:

| Element | Why it fails the test |
|---|---|
| exact loop in/out in samples | A number. Drag is coarse *by design*; type here. |
| output-bus picker | A decision from 8; and it is topology (republish), not a live move. |
| cue routing detail, `monitorSwitch` | A decision, and D-WZ-MON-01 already automates the common case at the C-3 handoff. |
| **source rebind + record-input channel pick** | A decision from a device list. See §7 — this is the one that today is *hardcoded* and must not stay hidden. |
| rename | Typing. |
| per-Strip gain trim | A number set once, distinct from the fader you ride. |
| take identity, **align-to-take (Law C-2)** | Choosing a reference take is a decision. The *result* is heard, but the choice is a picker. |
| `loopEnabled` | Almost always on; C-3 depends on it. A checkbox on the object would be twelve checkboxes on the plane, all in the same position. |
| remove strip | Destructive → never one-handed near a REC button. |
| (later) inserts, sends, A/B/C/D snapshots | PD-CANVAS-3 / P6. |

### 3.3 Where I deviate from §3.0, and why

§3.0's on-object column lists "the '?' that labels everything in place". **Move it off the
object.** Twelve Strips each carrying a `?` is twelve pieces of chrome for one global mode.
The `?` belongs once, next to the zoom controls in `.plane-controls` (bottom-right, where
the hand already is per §4.1), and it toggles a plane-wide `data-labels="on"` that reveals
in-place labels on *every* Strip. Same benefit, one twelfth of the clutter, and it makes
labelling a state of the workspace rather than a per-object affordance.

§3.0 also puts the output-bus picker purely in the Inspector. **Keep the picker there, but
keep the failure on the object** (state 15). The Inspector holds the choice; the object
holds the consequence. Same for loopback's block cost (state 16).

---

## 4. Geometry

### 4.1 The pixel budget — 340 × 196 holds exactly

`DEFAULT_CELL` is already `{w: 340, h: 196}`. That is not a placeholder to be revised; it
is a budget that closes to the pixel with the anatomy below, so **no schema change is
needed**. Existing CSS (`.plane-strip { padding: 8px; gap: 5px }`) already matches.

```
pad-top                              8
head row                            16
gap                                  5
WAVE FIELD                          48      ← the centre of gravity
gap                                  5
transport row                       22      ← the tallest interactive row
gap                                  5
status line                         12      ← reserved, always present (L2/L3)
gap                                  5
param: level                        18
gap                                   4
param: pan                          18
gap                                   4
param: speed                        18
pad-bottom                           8
                                   ───
                                   196  ✓
```

Horizontal, at `cell.w = 340`, `padding: 8`:

```
content width                      324
  kind bar                           3   (absolute, full height, left edge, outside padding)
  wave canvas          324 − 10 − 6 = 308
  gap                                 6
  meter (MeterCanvas 10 × 48)        10
```

`.ds-row`'s existing `min-height: 18px` matches the param rows exactly; `.ds-label`'s
`width: 34%` = 110 px at this size, which is generous for `level`/`pan`/`speed` — override
to a fixed `flex: 0 0 46px` inside `.plane-strip` so the bar gets 200+ px and the readout
its 6ch. The bar is the value; give it the room.

### 4.2 Hierarchy — what dominates

1. **The wave field (48 px, 25 % of the height, 90 % of the width).** It is the only large
   element and the only one that moves. A player's identity is its waveform.
2. **REC (56 × 22, labelled, lamp-coloured).** The one verb that changes what the object
   *is*. Everything else in the transport is 26 × 22 and glyph-only.
3. **The head (name + state).** Read at a distance, read while zoomed out.
4. Everything else is flat: three identical param rows, three identical switches, one thin
   status line. Flatness here is the point — it is what lets 1–3 dominate.

The current implementation has no step between (2) and (4): all seven buttons are the same
size, so nothing dominates and the object reads as a form.

### 4.3 Size variants: **width is free, height is quantised, density is a view**

Three separate axes, and conflating them is what makes canvas UIs rot.

- **Width** — user-resizable, `240 ≤ cell.w ≤ 720`, persisted. Only the wave canvas and the
  `GeoRange` bars absorb it; nothing else changes. Below 240 the transport can't hold five
  verbs at a 22 px hit target, so 240 is a hard floor enforced on resize.
- **Height** — **not user-resizable.** `cell.h` is written by the app from the density
  ladder. A Strip with a taller box would just be a Strip with more empty space; there is
  nothing to reveal (everything else is in the Inspector). Keeping `h` app-owned keeps
  `fitToContent` and the persisted arrangement honest.
- **Density** — derived from the plane's `scale`, **not stored per Strip**, and rendered at
  **counter-scale** so type stays at its token size:

| Density | Plane scale | Rows rendered | `cell.h` | Notes |
|---|---|---|---|---|
| `player` | ≥ 0.6 | all (§4.1) | 196 | the default |
| `compact` | 0.35 – 0.6 | head · wave · transport · status | 196 (box unchanged) | params drop — they are in the Inspector anyway. Content is drawn at `transform: scale(1/planeScale)` inside the same box so 11 px mono stays 11 px on screen. |
| `token` | < 0.35 | kind bar · name · state word · meter · REC | 196 (box unchanged) | one line, counter-scaled. **This is strip mode.** |

**This resolves P4-08.** "Strip mode" is not a second layout and not a schema mode: it is
`plane.scale` set into the `token` band with a one-row auto-layout. `Patch.uiMode: 'strip'`
becomes exactly what pd-canvas §7 said — a saved viewport, not a fork.

The counter-scale is the non-obvious part and the reason a plain CSS `scale()` LOD fails:
without it, zooming out to see your whole patch makes every label 2 px tall and the plane
becomes a set of coloured rectangles. With it, zooming out *changes what is shown* rather
than shrinking it — which is what "strip mode is zoom-out" has to mean to be usable.

### 4.4 Mockups

Interior = 56 chars ≈ 340 px. `▌` = the 3 px kind bar. `▚` = meter (idle), `█` = meter hot.

**A — bound input, no material (state 2).** The object is already a player; it simply has
nothing to play. Note REC sits exactly where it will sit forever.

```
┌────────────────────────────────────────────────────────┐
│▌ MIC — BUILT-IN                                   idle │
│▌ ┌────────────────────────────────────────┐ ┌──┐       │
│▌ │·····∿∿·∿∿∿∿·····∿∿∿∿·∿∿···∿∿∿∿∿·∿∿∿···│ │▚▚│       │
│▌ └────────────────────────────────────────┘ └──┘       │
│▌ [ ● REC ] ⟳  ▸  ↻  ◼                      [M] [S] [C] │
│▌ records: Built-in Mic 1                               │
│▌ level  ████████████░░░░░░░░░░░░░░░░░░░░░░     −4.5    │
│▌ pan    ░░░░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░░       C    │
│▌ speed  ░░░░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░░    1.00×   │  ← dimmed, inert
└────────────────────────────────────────────────────────┘
```

**B — recording (state 4).** Identical geometry. The wave draws itself; the write head is
the right edge; the loop brace is suppressed; the play verbs go inert.

```
┌────────────────────────────────────────────────────────┐
│▌ MIC — BUILT-IN                            ● rec  0:07 │
│▌ ┌────────────────────────────────────────┐ ┌──┐       │
│▌ │▁▂▃▅▇▅▃▂▁▂▄▆█▆▄▂▁▃▅▇▅▃▂▁▂▄▆█▆▄▂▁▃▅▇▅▃▂▐│ │██│       │
│▌ └────────────────────────────────────────┘ └──┘       │
│▌ [ ■ STOP] ⟳  ▸  ↻  ◼                      [M] [S] [C] │
│▌ recording Built-in Mic 1 → deck 2                     │
│▌ level  ████████████░░░░░░░░░░░░░░░░░░░░░░     −4.5    │
│▌ pan    ░░░░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░░       C    │
│▌ speed  ░░░░░░░░░░░░░░░░░░│░░░░░░░░░░░░░░░░    1.00×   │
└────────────────────────────────────────────────────────┘
```

**C — has material, looping, reversed at −0.75× (states 5+6+8).** The loop brace `⌐…¬` is a
drag result. Nothing has moved since B; only fills changed. This is Law C-3 seen as a
picture: B and C are the same object one block apart.

```
┌────────────────────────────────────────────────────────┐
│▌ TAKE 3 ← Built-in Mic                       ⟳ loop    │
│▌ ┌────────────────────────────────────────┐ ┌──┐       │
│▌ │▁▂▃▅⌐▔▔▔▇▅▃▂▁▂▄▆█▐▆▄▂▁▃▅▇▔▔▔¬▃▂▁▂▄▆█▆▄▂│ │▚▚│       │
│▌ └────────────────────────────────────────┘ └──┘       │
│▌ [ ● REC ] ⟳* ▸  ↻  ◼                      [M] [S] [C] │
│▌ take_0003.wav · 0:12.480                              │
│▌ level  ██████████████░░░░░░░░░░░░░░░░░░░░     −2.0    │
│▌ pan    ░░░░░░░░░░░████│░░░░░░░░░░░░░░░░░░      L34    │
│▌ speed  ░░░░░░░░████████│░░░░░░░░░░░░░░░░░   ◄ 0.75×   │  ← readout in --warn
└────────────────────────────────────────────────────────┘
```

**D — unresolved + muted + also unmapped (states 9+12+15).** The ladder (L3) picks
`audio missing`; `unmapped` waits its turn. Content dims; kind bar, meter and status line
stay at full contrast. REC stays live — recording over a dead reference is the repair.

```
┌────────────────────────────────────────────────────────┐
│▌ TAKE 3 ← Built-in Mic                            ---- │
│▌ ┌────────────────────────────────────────┐ ┌──┐       │
│▌ │              audio missing             │ │▚▚│       │
│▌ └────────────────────────────────────────┘ └──┘       │
│▌ [ ● REC ] ⟳  ▸  ↻  ◼                      [M] [S] [C] │
│▌ audio missing — …/Takes/take_0003.wav                 │  ← --hot
│▌ level  ██████████████░░░░░░░░░░░░░░░░░░░░     −2.0    │
│▌ pan    ░░░░░░░░░░░████│░░░░░░░░░░░░░░░░░░      L34    │
│▌ speed  ░░░░░░░░████████│░░░░░░░░░░░░░░░░░   ◄ 0.75×   │
└────────────────────────────────────────────────────────┘
                                              M latched --hot
```

**E — the density ladder, same three Strips.** The box never changes; what is drawn inside
it does, at counter-scale.

```
player   (scale ≥ 0.6)      compact (0.35–0.6)         token (< 0.35) = STRIP MODE
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│▌ MIC        loop │        │▌ MIC        loop │        │▌ MIC ⟳ ▚▚  [●]   │
│▌ ┌──────────┐ ▚▚ │        │▌ ┌──────────┐ ▚▚ │        └──────────────────┘
│▌ │▁▃▇▅▂▄█▆▂▃│    │        │▌ │▁▃▇▅▂▄█▆▂▃│    │
│▌ └──────────┘    │        │▌ └──────────┘    │        ┌──────────────────┐
│▌ [●REC] ⟳ ▸ ↻ ◼  │        │▌ [●REC] ⟳ ▸ ↻ ◼  │        │▌ TK3 ⟳ ▚▚  [●]   │
│▌ take_0003.wav   │        │▌ take_0003.wav   │        └──────────────────┘
│▌ level  ████░░░  │        └──────────────────┘
│▌ pan    ░░░│░░░  │                                    ┌──────────────────┐
│▌ speed  ░░░│░░░  │        params → Inspector          │▌ SPO · ▚▚  [●]   │
└──────────────────┘                                    └──────────────────┘
```

---

## 5. Component reuse (no new engine work, no new ABI)

### 5.1 `MeterCanvas` — must be given explicit geometry

It defaults to `14 × 96` (a channel-rack fader-height meter). Mounted with no props inside
a 196 px Strip's header, it single-handedly makes the header ~96 px tall — **the single
worst visual defect in the current file** (D3). Mount it as `width={10} height={48}` in the
wave row's right gutter, where it reads as a level column beside the wave, which is exactly
how a player presents it. No change to `MeterCanvas` itself.

### 5.2 `DeckWaveform` — reuse unchanged, but only when a deck exists

It already does everything states 4/5/6/7/8 need: envelope fetch on `revision`, ~8 Hz
re-fetch while `recording`, live-length x-axis rescale, brace drag, playhead from HotFrame,
and it draws a bare centre line when `frames === 0`. Pass `width={308} height={48}`.

It requires a real `deck` id. For states 1/2/17 (no deck) do **not** fake one — render a
sibling `.plane-strip-wavefield` element at the identical rect. Row stability (L2) is
preserved without issuing bogus `deckWaveform` commands for deck −1.

### 5.3 `ParamRow` / `GeoRange` — reuse unchanged

`origin="center"` already gives the bipolar fill pan and signed varispeed want. `speed`
already uses the exported `rateToPosition` / `positionToRate` / `snapUnity` / `formatRate`
from `VarispeedSlider` — that is the right call (it keeps the bit-exact 1.0 identity path
reachable by dragging) and `VarispeedSlider` itself stays a console-only component until
PD-CANVAS-05 retires it.

Add one prop: `disabled?: boolean`, so the `speed` row can be present-but-inert (L2)
instead of conditionally rendered. This is a two-line change to `controls.tsx` and is the
only edit any shared component needs.

### 5.4 `.deck-loading` / `.deck-unresolved` / `.deck-cap` — reuse the CSS, relocate

All three classes already exist and are token-correct. `.deck-loading` moves into the wave
rect (state 10); the other two become status-line messages (states 9, 11) rather than
inserted blocks.

### 5.5 `InputTrace` — the one recommended new component (~40 lines, UI only)

To satisfy "a miniature waveform that draws LIVE" for a Strip that has *no deck yet*
(state 2, the first state a user meets), the Strip needs a trace before there is a buffer.
The data already exists: `CHANNEL_BLOCK_FIELDS` publishes `peakL`/`peakR` every HotFrame.
A sibling of `MeterCanvas` keeps a UI-side ring of the last N peaks and draws them as a
scrolling mini-envelope on the shared `registerHotDrawer` loop.

- No engine work, no ABI change, no new HotFrame field.
- No React state (the ring lives in the drawer closure, like `MeterCanvas`'s peak hold).
- Same canvas rect as `DeckWaveform`, so the record→material transition is a swap of
  drawers inside one box.

This is what makes an input Strip look like a player rather than an empty player. If it is
cut for time, state 2 falls back to the centre hairline + hint text and the anatomy is
unaffected — but the object loses the thing that most sells "one species".

---

## 6. Token checklist — nothing new is needed

Every value in this spec maps onto a var `tokenVars()` already emits, so `check:tokens`
passes with **zero token additions**:

| Use | Var |
|---|---|
| kind bar (5 kinds) | `--chan-device` `--chan-app-tap` `--chan-deck` `--chan-virtual` `--chan-bus` |
| recording, mute latch, audio-missing | `--rec-lamp`, `--hot` |
| looping, cue latch, meter | `--signal` |
| selection outline, loop brace, playhead, solo latch, one-shot latch | `--accent` |
| cap, unmapped, reverse readout | `--warn` |
| feedback dot | `--feedback-lamp` |
| surfaces / lines / dim text | `--bg` `--bg-raised` `--line` `--text` `--text-dim` |
| corners, hairline | `--radius` `--radius-sm` `--hairline` |
| REC pulse, latch transitions | `--dur-fast` `--dur-base` `--ease` `--motion-scale` |
| name, labels, values, status | `--type-label-*` `--type-value-*` `--type-caption-*` |

Pixel *layout* constants (48, 22, 12, 10, 3) are not gated by `check:tokens` — it rejects
hardcoded colour / font / font-size / border-radius only. Geometry in `console.css` is
legitimate and stays there.

**One collision to record:** `accents.channelKind.deck` and `chrome.signal` are both
`#57c07a`. So a deck's kind bar and "is playing" are the same green. Acceptable for now
because they never occupy the same pixel (bar vs. state word), and it becomes moot under
§7's recommendation — once `material` is separate from `source`, the `deck` *kind*
disappears from the plane entirely and `--chan-deck` survives only as the waveform colour.

---

## 7. Critique of the current `Strip.tsx`

Honest, specific, in severity order. Line references are to the file as read.

**D1 — the Strip has no height.** `style={{ left, top, width: cell.w }}` (L84). `cell.h`
is never applied. Height is therefore content-driven, and content changes in *five* states
(wave appears, `audio missing` appears, `loading…` appears, `speed` row appears, deck
transport appears). Every one of those resizes the box. This breaks the learned constraint
(ARCHITECTURE §7), and it silently corrupts `fitToContent()` — which frames against
`cell.h = 196` for a Strip that may be rendering at 120 or 240. **Fix:** add
`height: cell.h`, `overflow: hidden`, and build the interior to §4.1's budget.

**D2 — status is rendered as inserted blocks.** `{unresolved && …}` (L125) and
`{deckLoading && …}` (L133) are conditional siblings in a flex column. Each pushes
everything below it down. **Fix:** one reserved 12 px status line with L3's ladder.

**D3 — the meter is 96 px tall inside a 196 px object.** `<MeterCanvas levels={…} />`
(L97) takes the default `14 × 96`. Inside `.plane-strip-head { align-items: center }` it
makes the *header* the tallest element in the Strip — taller than the waveform. The
header, which should be a 16 px line of text, is 6× the height of the transport row.
**Fix:** `width={10} height={48}`, moved to the wave row's right gutter (§5.1).

**D4 — the object is not a player until it has a deck.** `showWave` (L78) requires
`deck !== undefined`. An input Strip therefore renders header + transport + two param rows
and *no waveform at all*. Two visually distinct species, which is precisely what
PD-CANVAS exists to abolish. **Fix:** the wave field is unconditional (§5.2, §5.5).

**D5 — you cannot record into a source Strip.** The whole transport block is
`{deck && (…)}` (L136). A Strip bound to a mic has **no record button**. So pd-canvas §3's
claim — "recording is just the verb that gives a Cell material" — is false in the
implementation: recording is only available on Strips that already have material. This is
the deepest defect, and §8 is about it.

**D6 — three console features were dropped on the way to the plane.**
`deckCapReached` (state 11) is not read at all — the 256 MB cap now stops a recording with
no indication anywhere on the plane. `deckLoadProgress` is not read — the determinate bar
regressed to the string `loading…` (L133). `retrigger` (in `DeckRack` L130, and a core
performance verb) is absent from the transport. **Fix:** all three return, per §2 and §4.2.

**D7 — the routing warnings were dropped too.** `.strip-unmapped` (state 15) and the
loopback block-cost note (state 16) exist in `ChannelRack` and have no plane equivalent.
A Strip on an unmapped bus is now silently silent. **Fix:** status line, per L3.

**D8 — flat hierarchy: seven identical buttons.** `●  ⟳  ▸  ◼  M  S  C` are all
default-sized glyphs in one row at `gap: 3px`. Record — the verb that changes what the
object *is* — is the same weight as `pan`'s neighbours. Two different vocabularies
(transport verbs, mix switches) share one row with only `margin-left: auto` between them.
**Fix:** REC at 56 × 22 with a text label and a lamp; verbs at 26 × 22 glyph-only; switches
at 22 × 22 in a right group with a real gap; the record→verbs→switches rhythm is the row's
only structure.

**D9 — kind is carried by the name's text colour.** `style={{ color: KIND_VAR[...] }}`
(L88) tints 11 px uppercase mono. Small coloured text is the weakest possible carrier of a
categorical signal *and* it costs contrast on the one string you read while scanning.
**Fix:** the name is `--text`; kind moves to a 3 px full-height bar on the left edge — high
saturation, large area, zero legibility cost, and it still reads at `token` density where
the name is the only other thing left.

**D10 — `Number(channel.source.id)` (L62) resolves `''` to deck 0.** A channel with
`kind: 'deck'` and an empty id silently binds to deck 0's material — it will draw another
Strip's waveform and its REC will record into another Strip's buffer. **Fix:** parse
strictly and treat a non-integer as unresolved (state 9), not as deck 0.

**D11 — no selection, no focus, no keyboard.** PD-CANVAS-03's Inspector is
selection-driven and there is no selected state, no click-to-select, no `outline`, no
`tabIndex`. `Plane.onPointerDown` (Plane L59) only *excludes* `.plane-strip` from panning.
**Fix:** state 19; `outline` per L6; the Strip is a focusable region.

**D12 — no density/zoom awareness.** At `scale = 0.2` (MIN_SCALE) the 11 px mono name is
2.2 px. The plane is legible at exactly one zoom level, which defeats both fit-to-content
and strip-mode-as-zoom-out. **Fix:** §4.3's counter-scaled ladder.

**D13 — `title` is the only labelling.** Native tooltips have a ~1 s delay, do not appear
on touch, and are the exact discoverability tax GRM was criticised for (design-notes §1).
**Fix:** the plane-wide `?` toggle (§3.3). Keep the `title` strings — they are well written
and carry real reasoning ("stop — loops instantly (Law C-3)") — but stop relying on them.

**D14 — `waveWidth = Math.max(80, cell.w - 16)` (L79)** does not account for the meter
gutter and recomputes on every render, re-keying `DeckWaveform`'s envelope-fetch effect
(`[link, deck, revision, frames, width]`). **Fix:** derive it once from `cell.w` in a
`useMemo`/module function with the gutter subtracted.

**What the file gets right, and must keep:** the header comment states the design intent
precisely; the `speed` row correctly uses `snapUnity` so the engine's bit-exact identity
path is reachable by dragging; `DeckWaveform` is reused unchanged with `recording` wired
through, which is the live-drawing behaviour the user asked for; the double-click-to-unity
and double-click-to-centre gestures are right; the `title` strings carry the *why*.

---

## 8. The hard question — one type for a live input AND a recorded player

### 8.1 Where the model leaks

pd-canvas §7 rests on: *"`Channel` is already the one strip type; `decks[]` is material
storage; a Cell with material is a Channel whose source resolves to a deck."* The first two
clauses are true. **The third is where it leaks**, and the leak is structural, not cosmetic:

> `Channel.source` is doing two jobs — *where signal comes from* and *where material
> lives* — and they are not the same axis.

Concretely, in today's schema and code:

- A Strip bound to a mic (`source.kind = 'deviceInput'`) has no deck, so it **cannot
  record** (D5). The verb that is supposed to give it material is not available on it.
- To record, you add a *different* Channel whose `source.kind = 'deck'`. That Channel's
  source is the **deck**, not the mic. It has no idea what it is capturing.
- What it actually captures comes from `deckRecordStart(deck, 0, -1, inputName)` where
  `inputName = deviceInfo?.inputs[0]?.name ?? 'input 1'` — **hardcoded to the first
  hardware input**, in both `DeckRack` (L43) and `Strip` (L75). The record input is not in
  the document at all.

So on the plane the user sees two objects for one intent: a *Mic* Strip that cannot record,
and a *Deck* Strip that records something the UI guessed. The "one species" claim is
currently a rendering convention over a two-object reality, and the seam is visible the
first time someone presses REC.

There are two further leaks worth naming:

- **Nothing forbids two Channels pointing at the same deck id.** Two Strips would draw the
  same waveform and both could record into it. In GRM that is the *feature* (N readers over
  one material) — but only because GRM keeps reader and material as separate objects. We
  conflate them, so it reads as an accidental duplicate rather than a second reader. This
  is exactly the boundary where PD-CANVAS-2 has to arrive; until it does, the UI should
  treat a duplicate `source.id` as a bug and say so.
- **Recording destroys provenance.** After a take, the Strip's source is a deck; the mic
  that made it survives only in `Take.sourceDesc` in a sidecar. The object cannot answer
  "what am I listening to?" — which is the one question a patchbay must always answer.

### 8.2 How ONE type stays legible anyway — the answer

**Because the anatomy is constant and the *fill* is what varies.** Concretely, §2 and §4
are the mechanism:

1. **The wave field is unconditional.** A live input shows its trace; a take shows its
   envelope. Same rect, same colour family, same drag target. The object is always a
   player; only its material's tense differs (present vs. past).
2. **REC is unconditional and never moves.** It is the hinge between the two lives of the
   object, so it must be in the same place in both. When there is nothing to play, REC is
   the *only* enabled verb — which teaches the whole model without a manual, and is our
   direct answer to the KVR critique ("couldn't figure out how to make the sound loop").
3. **The head names the *source*, not the storage.** `TAKE 3 ← Built-in Mic`. The Strip
   states its provenance in every state, so it never becomes an anonymous buffer.
4. **The status line answers "what will REC capture?"** before you press it
   (`records: Built-in Mic 1`) and "what is it capturing?" during
   (`recording Built-in Mic 1 → deck 2`).
5. **Nothing appears or disappears** (L2) — so "getting material" is not a transformation
   into a different-looking thing. It is the same object, with a wave in it.

### 8.3 The fix — a two-step, and be honest about which one we are on

**Step A (now, zero schema change). Make REC work on any Strip.**
Pressing REC on a Strip with no material:
1. allocates a deck (`addDeck` already exists; ≤ 8),
2. calls `deckRecordStart(deck, chan0, chan1, sourceDesc)` with the channel's **own**
   resolved source rather than `inputs[0]`,
3. on stop, rebinds *this same Channel's* `source` to the new deck while **keeping `key`,
   `name`, `cell`, `gain`, `pan`, `mute`, `solo`, `toMonitor`, `outBus`**.

Because `Channel.key` is stable, the Strip does not move, does not lose its mix state, and
does not re-mount — the box you were watching starts looping. That makes Law C-3 literally
true *on the object*, which is the whole point of the plan. It also deletes the second
species from the plane: you never add a "deck strip" again.

Its honest cost: after the take, the Strip's `source` is the deck, so the mic binding is
gone from the document. Re-recording the same input requires re-binding via the Inspector,
and the head's `← Built-in Mic` has to be reconstructed from `Take.sourceDesc` (available;
`addTake` already stores it). Acceptable for a first cut. Not acceptable permanently.

**Step B (next schema step; propose as `PD-CANVAS-06`). Split material from source.**

```ts
// ChannelSchema, additive, .strict()-safe
material: z.object({
  deckId: z.number().int().min(0).max(7).nullable(),  // which buffer this Strip reads
}).strict(),
```

- `source` = where live signal comes from (mic, app tap, bus tap, none).
- `material` = which deck buffer this Strip plays.
- Both, either, or neither. A Strip with both is a player that can re-record its own input
  — the object the user actually described.
- `source.kind === 'deck'` becomes the *legacy* case "material only, no live input" (a
  loaded file), and the `deck` kind can eventually leave the plane's vocabulary entirely.

Cost: one `SCHEMA_VERSION` bump, one named migration (`source.kind === 'deck'` →
`material.deckId = Number(source.id)`, `source = {kind:'none', id:'', name: <take's
sourceDesc>}`), and no engine change whatsoever — `deckRecordStart`/`deckTrigger`/
`deckSetRate` already take a deck id as a parameter, and `WorldPublish` already carries
channel sources. Same "additive, no array merge, geometry never crosses the ABI" posture
as PD-CANVAS-01. It also unblocks PD-CANVAS-2 cleanly: N readers on one material is
*N Channels sharing a `material.deckId`* — which stops being a bug and becomes the feature,
with a visible "reader 2 of 3" marker in the head.

**Recommendation: build Step A inside PD-CANVAS-02 (it is UI-only and it is what makes the
one-object claim true), and schedule Step B before PD-CANVAS-05 retires the console** —
because once `ChannelRack`/`DeckRack` are gone there is no other surface where the
source/material distinction can be repaired.

---

## 9. Build order

1. **`Strip` geometry pass** — L1–L6, §4.1's budget, `MeterCanvas 10×48` in the wave
   gutter, `.plane-strip-wavefield`, the reserved status line + L3 ladder. Fixes
   D1–D4, D6, D7, D9, D14. No new components, no schema.
2. **Transport pass** — REC dominant + always present + Step A wiring, `retrigger` back,
   switches grouped. Fixes D5, D8, and makes §8.2 true.
3. **`ParamRow` gains `disabled`** — two lines in `controls.tsx`; `speed` becomes
   present-but-inert. Closes L2.
4. **Selection + focus** — state 19, `outline`, `tabIndex`; the handshake PD-CANVAS-03
   needs. Fixes D11.
5. **`InputTrace`** (§5.5) — the live pre-record wave. Optional but it is the thing that
   sells one species.
6. **Density ladder** (§4.3) — counter-scaled `compact`/`token`. Fixes D12 and closes
   P4-08 as "strip mode is zoom-out".
7. **The plane-wide `?`** (§3.3). Fixes D13.
8. **PD-CANVAS-06** (§8.3 Step B) — `Channel.material`, before PD-CANVAS-05.

Steps 1–4 are the minimum for the object to be honest. Steps 5–7 are what make it a
playground.
