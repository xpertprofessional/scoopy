# Design rules — the ones that bind

**Read this before adding any control.** These are not taste; they are what the
CSS, the tokens and `check:tokens` already enforce, plus the vocabulary the app
has been speaking since before the merge. Written 2026-07-31 after a deck row
shipped with a bare range input, hand-set heights and a second transport
dialect — every one of which the rules below already answered.

The fuller study is `docs/archive/pd-visual-language.md` (wizard-era, archived).
It is history for its *speculative* half only: §2.4 (control sizing) and §2.5
(the row idiom) describe what this tree actually does, and are restated here so
nobody has to read an archive to find them.

---

## 1. Use the control vocabulary. Do not invent one.

| Need | Use | Never |
|---|---|---|
| a parameter with a value | `GeoRange` (`design/controls.tsx`) — label · bar · value | a bare `<input type="range">` |
| a numeric you drag / nudge / learn / pin | `DragBox` (`design/DragBox.tsx`) | a number input |
| a verb | `Button`, or a row-local `.dr`/`.sdv`-style button | an anchor, a div with onClick |
| a choice | `Select` · `Checkbox` · `Stepper` | a hand-rolled dropdown |
| a menu | `useContextMenu().openMenu(items, x, y)` | a floating div |

**Why the bar and not a raw range.** `GeoRange` paints an inline gradient so the
value reads as a *shape* rather than a thumb position, gives `origin="center"`
for bipolar parameters (pan, signed varispeed), carries the label/value slots,
and sizes from `--control-h`. And a raw range has a real trap, recorded at
`panels/trackRowControls.tsx:308`: a mousedown on the track jumps the thumb and
fires `change` **before `click` exists**, so anything trying to intercept the
click loses.

## 2. One control height, from one token.

```
--cell        4px    the spacing atom — gaps are var(--cell), calc(--cell * 2)…
--control-h  18px    THE control height: bars, boxes and buttons alike
--control-h-hot      --slider-bar-h × 1.25, for heavy-traffic surfaces
```

Everything takes `height: var(--control-h)` so a box in front of a bar lines up.
`.strip-row` already establishes the row (`height: 18px`, `gap: 6px`) — a new
block inside one **adds what is new and redeclares nothing**. The archive's own
warning, verbatim: *"that is how the drag box and the slider drifted apart when
the Appearance panel's bar height was changed."*

Value read-outs are sized in **`ch`, never px** — the width scales with the
value font, not with an assumption about it.

## 3. The transport vocabulary is four glyphs.

**⟳ play** (a pattern loops by nature) · **▸ one-shot** (one LCM cycle, then
stop) · **↻ retrigger** (back to step 0 without leaving the transport) ·
**◼ stop**.

One vocabulary, every scope: a tape, a grid strip, the deck tile, the master
bar. `■`/`▶` are a second dialect and do not belong here. If a surface shows
three of the four, that is a missing verb, not a smaller vocabulary.

## 4. Colour, type, radius, duration and z come from tokens.

`check:tokens` refuses a hex literal, an `rgb()`/`hsl()` literal, a px
`font-size`, a radius literal, a raw `z-index`, a raw duration, and a dangling
`var()`. **Geometry is exempt** — the strip's pixel budget lives in `plane.css`
where it can be found, not in a token file where it cannot.

Identity colour is `semanticColor(kind, index)` → `--sem-color`, worn via
`.sem-fill` / `.sem-edge`. Two controls far apart read as connected because they
share the variable, not because someone matched a hex by eye.

## 5. The strip's layout laws (L1–L6)

Stated in full at the top of `plane/Strip.tsx`, pinned mechanically by
`Strip.test.tsx`. The two that catch people:

- **L1 — the box is authoritative.** Content is laid out to fit the box; the box
  is never laid out to fit the content. A row too narrow for its controls
  **scrolls**; it never wraps, because wrapping changes the tile's height with
  state and every saved arrangement's `cell.h` becomes wrong.
- **L2 — every row always exists.** State changes *fill*, never *presence*. A
  control that is meaningless right now is **disabled and says why in its
  title**, not removed. A control that vanishes moves everything beside it.

## 6. A disabled control teaches.

`disabled` with no `title` is a dead end. Say the precondition: *"latch BR first
— then this walks the window"*, *"nudge bends the SYNCED tempo — turn SYNC on
first"*. This is the UI half of the four rules — a door you cannot reach is the
same defect as a door that does not exist, and a door that will not say why is
worse than both.

## 7. Never ship a control that reaches nothing.

If the verb behind it is unanswered, do not draw it. Say the gap on screen
instead — the deck view row does exactly this for the scene controls waiting on
B2. Five dead buttons look identical to five working ones until someone needs
them mid-set.
