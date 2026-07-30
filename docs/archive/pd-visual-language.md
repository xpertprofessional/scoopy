# PD — visual language for the Wizard player object

*Fourth research pass (2026-07-24). The first three passes
(`design-notes-grm-player.md`) established GRM Player's **mechanisms**; `pd-canvas.md`
turned them into a plan. Neither could describe how any of it **looks** — pass 1 says so
explicitly ("I could not load actual screenshots"). This pass fixes that: it works from
**first-party screenshots pulled out of the GRM manual's own `res/` directory**, decoded
and colour-sampled pixel by pixel, and from the **actual source** of the two sibling apps.
It ends in a buildable visual spec constrained to the tokens `web/src/design/tokens.ts`
really emits.*

**Verification status — read this before trusting any number below.**

| Claim class | Status |
|---|---|
| GRM slate anatomy, element order, glyphs | **VERIFIED** — read off `Slate151_1.png`, `Slate151_2.png`, `SlateCursor02-a.jpg`, `Slate151Vol.png`, `SlateCursor03.png`, `Lecteur-Multi-lecteur_1.png`, `Selection-sequence.png`, `DupliquerLecteur3_1.jpg`, `rajoutLecteur4_1.jpg` |
| GRM proportions (px, ratios) | **MEASURED** off those images. They are doc screenshots at unknown scale/DPI, so treat the **ratios** as solid and the **absolute px** as indicative |
| GRM colours (hex) | **SAMPLED** by decoding the PNGs directly. PNG samples are exact; JPEG samples carry compression noise (±4/channel) |
| GRM French terminology | **VERBATIM** from the manual HTML |
| Third-party GRM screenshots (reviews, YouTube stills, KVR) | **NOT FOUND / NOT VERIFIED.** Searches surfaced only forum text and the official pages. Nothing below rests on a review image. |
| Sibling-app grammar | **VERIFIED** — read from source in `parlante-next/web/src` and `scoopy/web/src/design` |
| Wizard token inventory | **VERIFIED** — enumerated from `tokenVars()` in `web/src/design/tokens.ts` |

---

## 1. GRM Player's visual anatomy, verified

### 1.1 The plane is a *field*, not a void

Sampled from `WorkArea_1.png` and `rajoutLecteur4_1.jpg`:

- **Workspace ground: `#383668`** — a saturated indigo, ruled with a fine lighter grid.
- **Slate body (unselected): `#141416`** — near-black, effectively neutral.
- **Slate sub-row bands: `#171719`**; the ruler strip is darker still, `#101012`.
- **Slate body (selected): `#0C2560`** — the whole panel takes a blue tint. Selection is a
  *body* change, not a border change.

So GRM inverts the figure/ground most DAWs use: the *plane* is the bright coloured field
and the *objects* are the dark holes punched in it. The value gap is large (indigo `#383668`
vs near-black `#141416`), which is why a dozen slates read as a **layout** at a glance
rather than as a wall of panels.

Verbatim: *"Le plan de travail est un simple espace géométrique en deux dimensions, un plan
sans limite apparente dans lequel on peut disposer deux types d'ardoises : des **Séquences**
et des **Lecteurs**"* [PlanTravail]. And: *"Les ardoises Séquences portent les fichiers
sonores répartis sur une à plusieurs pistes. Les ardoises lecteurs s'attachent aux Séquences
pour générer des transformations sonores."*

**The word is `ardoise` — slate.** It is GRM's own noun for the object, used throughout.

### 1.2 The slate, measured

From `Selection-sequence.png` (607×375 screenshot; the slate occupies **435 × 132 px**,
≈ **3.3 : 1**), a sequence carrying **one** player:

```
 ┌ 435 px ──────────────────────────────────────────────────────────┐
 │ Bienvenue                                                    ⤡   │  12 px  sequence name
 │ ▼ Track 1                                                        │  12 px  track disclosure
 │ ▏  ▁▃▅█▇▅▃▁  ▁▂▅█▇▆▃▁  ▃▅█▇▅▃▁▂  ▁▃▅▇█▅▃▂▁  ▂▅█▇▅▃▁   ▕      │  42 px  WAVEFORM (32 %)
 │ ▏      (filled, mirrored about centre, periwinkle on black)  ▕   │         ▏▕ = region grips
 │ :00      0:00:02     0:00:04     0:00:06    0:00:08   0:00:10    │  13 px  time ruler
 │ ●Player  ⊕   |◀ ◀◀ (▶) ▶▶ ▶|    ▶ − + x 1.000   +0dB MUTE SOLO  │  38 px  PLAYER ROW (29 %)
 │              ←  0:00:00.000  →   ├────◆────┤     ├─────●───┤     │
 └──────────────────────────────────────────────────────────────────┘
```

Element-by-element, all confirmed against the manual's own callout crops:

| Region | Contents (verbatim label) | Notes |
|---|---|---|
| Head | sequence name; `▼ Track 1` | plain white sans, left-aligned, ~12 px band each |
| Waveform | — | **filled, mirrored about the centre axis, no outline, no separate RMS core**, periwinkle (`#556DC8` peak in the selected shot, `#7B78A3` in the unselected one) on the near-black body. `▏ … ▕` grip marks at both ends = region endpoints |
| Ruler | `0:00:02 …` | tiny dim mono, ticks, full width. **The only ruler in the app** — it belongs to the slate, not to the window |
| Player row | *Nom du lecteur* · *Mode Suivi* · *Commandes de navigation* · *Vitesse* · *Dynamique* | one horizontal band per reader |

The player row itself, left to right (`Lecteur-Multi-lecteur_1.png`, and the five callout
crops `Slate151_*`):

1. **Name pill** — an outlined capsule containing a **filled colour dot** + the name
   (`● Player`). Verbatim: *"Nom du lecteur - Prise de l'objet"*, *"(Tap long). Prise de
   l'objet pour un déplacement"* — **the name pill is also the drag handle.**
2. **Mode Suivi** — a target glyph. `-|-` when off, `⊕` when on. Verbatim: *"L'icône du
   lecteur suivi **passe au vert** et recentre le défilement de la forme d'onde autour du
   lecteur."*
3. **Transport** — five **circular** buttons: *Retour au début · Retour rapide · Lecture
   (on/off) · Avance rapide · Aller à la fin*. **The play button is ~35 % larger than the
   other four** (measured 71 px vs 54–56 px in `Slate151_2_*`). Directly beneath, the
   *Temps courant* readout `0:00:07.338`, centred, flanked by two small handles.
4. **Vitesse** — *Sens de lecture* (a `▶` that **flips to `◀`** at negative rate), *Vitesses*
   (`− +`, described as *"en n et 1/n"*), *Vitesse courante* (`x 1.000`, the largest number
   in the row), and beneath them a full-width slider with a **diamond ◆ thumb** at centre.
5. **Dynamique** — `+0dB`, `MUTE`, `SOLO`, and a full-width slider with a **round ● thumb**.
   Then *Rotation de l'ardoise* and *Dimensionnement du lecteur* handles at the right edge.

**The thumb shape is the parameter's semantics.** Diamond = bipolar/centre-detented
(speed, where centre is 1.00×); round = unipolar (volume). Two shapes, no labels needed.

### 1.3 The proportion law: the source is a strip, the readings are the body

This is the single most important measurement in this document.

| Slate | Waveform band | Player rows | Waveform share |
|---|---|---|---|
| 1 player (`Selection-sequence.png`, 435×132) | 42 px | 38 px | **32 %** |
| 3 players + cluster (`DupliquerLecteur3_1.jpg`, ~622×370) | 75 px | 3 × 57 + 50 cluster = 221 px | **20 %** |

The waveform **never grows**. Every added reader adds ~57 px of control, so the picture of
the sound shrinks proportionally while the acts of reading take over the object. That is
*"Les transformations sonores seront principalement réalisées par de multiples opérations de
lecture"* [02_Lire_et_repeter] made literal in pixels: **playback is the instrument, so the
transport outweighs the waveform 2:1 and rising.**

This flatly contradicts the DAW instinct (waveform dominates, transport is a toolbar) and it
is the posture Wizard should copy.

### 1.4 How N readers on one sound are distinguished

Two devices, both verified in `DupliquerLecteur3_1.jpg` (three players on one sequence):

1. **A colour dot on each name pill.** Player 1 red, Player 3 green (sampled `#C0353C`-ish
   and `#326632`-ish through JPEG noise). The Inspector confirms this is a **first-class
   user-set property**: `Insp02_Player.png` has a field labelled **`Color Label` → `Red`**,
   a dropdown from a named palette.
2. **A matching coloured playhead drawn on the shared waveform.** The single waveform strip
   carries three vertical cursors at once — green at x≈14, green at x≈275, **red at x≈438**
   — each in its owning player's colour. Playhead green sampled `#5B9D55`.

So the shared waveform is a **map**, and every reader is a coloured pin on it that answers
"which of these rows is that line?" without a legend.

Third device, secondary: verbatim *"Un lecteur simple **(rouge)** et un multi-lecteur
**(vert)** qui regroupe 3 sous-lecteurs simples"* [Lecteurs] — the *species* also has a
default colour. A group's header reads `▼ Player x 3` / `▼ Cluster x 3` — a disclosure
triangle, the name, and **the member count**, in green.

### 1.5 The multi-lecteur, and the "map"

Verbatim: *"Un Multi-Lecteur confine un à plusieurs lecteurs dans un **empan** de lecture
(une fenêtre, une boucle) qui peut elle même se déplacer."* Its extra controls are two
inverse-video numeric fields plus a lock:

```
 ┌──────────────────────┐
 │ Span   ▐0.100s▌   ⊗  │   Span = "Taille de la boucle de lecture en millisecondes"
 │ Subx   ▐1.000 ▌      │   Subx = Démultiplicateur de vitesses
 └──────────────────────┘   ⊗    = Verrouillage — "Rapport Vitesses/Empan"
```

The `▐ ▌` is literal: an **editable numeric field is drawn inverse (light fill, dark
glyphs)** while every read-only value is light-on-dark. That is a zero-cost way to say
"this number is typeable".

`Lecteur-Multi-lecteur_1.png` also shows the **carte des multi-lecteurs** — a fine
rectangular grid panel spanning the sub-player rows, sitting *where the waveform would be*.
Preferences gates it: *"Affiche la carte des multi-lecteurs (Le multi-lecteurs doit contenir
au moins 3 sous-lecteurs.)"* It is a scatter/grid, **not** a waveform. Noted, not adopted —
Wizard has no equivalent object yet (that is PD-CANVAS-2).

### 1.6 Memories: greyed until filled

Verbatim: *"Dès que deux lecteurs sont regroupés dans une ardoise quatre boutons de mémoires
(A,B,C,D) apparaissent **en grisé** sous la forme d'onde. Ils mémorisent tous les réglages
contenus dans l'ardoise."* Plus *"Temps et curseur d'interpolation"* below them.

`presets.png` and `DupliquerLecteur3_1.jpg` show **six** lettered circles `A B C D E F`, not
four — the screenshots are newer than the prose. **Correction to design-notes §4.3, which
records four.** Both show them ghosted at ~35 % opacity when empty, with the interpolation
time (`2.00s`, `5.34s`) to their left over a round-thumb slider.

Save/recall verbatim: *"Pour enregistrer une mémoire : Shift + clic. Pour rappeler une
mémoire : Clic."* And from the shortcut summary: sliders take *"Valeur par défaut:
Double-Click"* and *"Contrôle fin: Cmd-Click-Drag"*.

### 1.7 Size *is* the disclosure control

Verbatim, the opening line of the Lecteurs page:

> *"Les ardoises séquences / lecteurs peuvent **s'étendre pour dévoiler des contrôles
> supplémentaires ou se contracter** selon les besoins."*

and the resize handle's own description:

> *"**Dimensionnement du lecteur** — Permet d'ajuster la taille du lecteur et **afficher des
> commandes complémentaires**."*

This is the most transferable idea in the whole manual and neither prior pass records it.
GRM has **no expand/collapse mode and no "advanced" toggle** — you drag the corner, and the
object shows more. Progressive disclosure keyed to *area*, so the amount of control on
screen is a direct consequence of how much room the user gave the object.

### 1.8 Display preferences — the visual levers GRM actually exposes

From `Preferences.html`, verbatim:

- *"Affiche la grille de fond"* — background grid
- *"Aimante les ardoises sur la grille"* — **snap slates to grid**
- *"Affiche la carte des multi-lecteurs"*
- *"affiche les aides contextuelles"*
- *"Affiche la forme d'onde en **haute définition**"* — an HD waveform quality toggle
- *"Affiche les identifiants des objets"* — show object IDs
- *"Qualité de rendu"*, *"Images par secondes"*, *"Affiche les indicateurs"* (CPU + FPS)

And from `Menus.html`: temporal selections are *"colorisées en bleu"*, zoom is discrete
(*Zoom avant / Zoom arrière / Réinitialisation Zoom*), plus *"Affiche séquence plein écran"*.

### 1.9 Corrections to the earlier passes

1. **`pd-canvas.md` §4.1 is wrong about the grid.** It states *"GRM has NO grid and NO
   snapping — placement is entirely free [PlanTravail]"*. PlanTravail is silent on it;
   **Preferences ships both as toggles** (*Affiche la grille de fond*, *Aimante les ardoises
   sur la grille*). So Wizard's proposed light snapping is *not* an invention — GRM has the
   real thing, defaultable. The rest of §4.1's reasoning (placement is meaning; keep snapping
   light) still stands, but it should stop citing GRM as the counter-example.
2. **`design-notes` §4.3 says four memory slots.** The current UI shows **six (A–F)**; the
   prose says four. Version drift, flagged.
3. **The slate has no per-player waveform.** Neither prior doc says so and it is easy to
   assume otherwise: **one waveform per *sequence*, shared by every reader attached to it.**
   Readers are rows of controls plus a coloured pin on that shared picture. This is a
   structural fact that changes what "N readers per Cell" (PD-CANVAS-2) has to draw.
4. **The transport is circular and size-graded**, and the primary verb is physically bigger.
   Wizard should take the *hierarchy* and reject the *circles* (§4.4).

---

## 2. The suite's visual grammar, read from sibling source

### 2.1 Waveform — Parlante `WaveformView.tsx` / `Minimap.tsx`

- **Filled envelope mirrored about the lane centre**, `amplitudeToY(a,h) = (h/2)(1 − a)`
  (`waveformGeometry.ts`). Clipping clamps to the lane edge. Split-lane stereo via
  `laneBounds()`; mono fills the lane.
- **Three layers, always in this order** (`WaveformView.tsx` L338-353): a peak envelope
  filled with a vertical gradient (`rgba(96,156,224,.92)` edge → `rgba(58,120,205,.96)` mid
  → edge), a **denser RMS core** on top (`rgba(34,84,164,.92)`), then a **crisp silhouette
  stroke** at `lineWidth = max(1, dpr*0.6)` in `rgba(24,64,132,.9)`.
- Lane divider: 1 device px, `rgba(127,127,127,.25)`.
- **Three zoom regimes**: envelope → connected sample line → per-sample dots
  (`SAMPLE_MODE_MAX_SPP = 2`, `SAMPLE_DOTS_MAX_SPP = 1/3`), sample dots at radius `2.5*dpr`.
- Minimap: **40 px tall**, same fill palette, centre axis at `rgba(127,127,127,.35)`,
  viewport window = `rgba(255,255,255,.14)` fill + `rgba(255,255,255,.6)` 1 px border.
- Overlay (hot surface): selection = `rgba(74,163,255,.18)` **fill**; loop = `#3ddc84`
  **2 px edge brackets only** — commented *"green edge brackets so it reads apart from the
  selection fill even when they coincide"*; playhead = `#ff5a36`, 1 px, `x + 0.5`.

Scoopy's `waveformStyle.ts` states the same discipline as doctrine — worth quoting because
it is the suite's constitution on this subject:

> *"ONE FORM: the traditional peak/RMS waveform, drawn at ONE DEVICE PIXEL per column. No
> lobes, no smoothing, no glow, no motion (all tried and cut) … Amplitude is linear …
> **a peak's height IS its level.**"*

and

> *"ONLY for CHROME: gridlines, group shading, step numbers, hover ghosts, affordance marks.
> **NEVER for SIGNAL — a waveform, a meter, a live playhead.** … the chrome is the paper,
> the signal is the ink that matters."* (`inkAlpha`, tokens.ts L560-570)

### 2.2 Meter — Parlante `Meters.tsx`, Scoopy `OutputMeter.tsx`

Both are **horizontal**, both use the same logic:

| | Parlante | Scoopy |
|---|---|---|
| Form | 2 stacked lanes, 28 px total | 1 bar, `--slider-bar-h` = **18 px**, `widthPx` 160 |
| Trough | transparent | `--bg-raised` |
| Fill | `#3ddc84`, → `#ff5a36` above **−3 dBFS** | `--signal`, → `--hot` above 0.999 |
| Peak hold | **2 px tick**, `#cfd8dc`, decays **1 dB/frame** | 2 px tick, `--text` |
| Clip | latched, text turns `#ff5a36` + bold | latched box, `--hot` |
| Scale | −60…0 dBFS | linear amp |

Wizard's `MeterCanvas.tsx` already matches the colour logic (`--signal` → `--hot` at ≥ 1,
`--bg-raised` trough) but is **vertical, default 14 × 96**.

### 2.3 Ruler — Parlante `TimeRuler.tsx`

**22 px tall.** Ticks 6 px from the bottom, `rgba(127,127,127,.5)`; labels 10 px system-ui at
`rgba(180,180,180,.9)` offset +3 px from the tick; a baseline hairline at
`rgba(127,127,127,.3)`. Drawn **off** the hot loop — ticks don't move per frame.

### 2.4 Spacing rhythm and control sizing — Scoopy `tokens.ts`

The suite's density numbers, verbatim from `DEFAULT` (L390, L397):

```
density: { cellPx: 4, rowHeightPx: 26 }
slider:  { barHeightPx: 18, fillMixPct: 55, markerWidthPx: 2 }
```

So: **4 px is the spacing atom** (gaps are `--cell`, `calc(--cell * 1.5)`, `calc(--cell * 2)`),
**26 px is a row**, **18 px is *the* control height** — sliders, drag boxes and buttons all
take `height: var(--control-h)` so a box in front of a bar lines up. Scoopy's comment:

> *"all take `height: var(--control-h)` — one token, so a box in front of a bar [aligns];
> that is how the drag box and the slider drifted apart when the Appearance panel's bar
> height was changed."*

Value readouts get `min-width: 7ch` / `9ch` — *"scales with the value font, not a px
assumption"*. Wizard's `.ds-value` already uses `6ch`.

### 2.5 Layout B — the row idiom Wizard already has

`controls.tsx` in both Scoopy and Wizard: **label left · geometric bar centre · value right.**
The bar is a native `range` painted with an inline gradient so the value reads as a **shape**,
and `origin="center"` gives the bipolar fill for pan and signed varispeed. Wizard's `.ds-row`
is `min-height: 18px`, gap 6, label `width: 34%`, bar `.ds-range` 10 px tall with a **3 × 14
px sharp-cornered thumb** in `--text`.

Note the convergence: **GRM's diamond-vs-round thumb and Layout B's `origin="center"`
bipolar fill say the same thing** — "this parameter is detented at the middle". Wizard
already has the better version, because the *fill* carries it, not just the thumb.

### 2.6 Semantic identity — Scoopy `semantic.css`

> *"Chrome says what KIND of thing a control is. A semantic color says WHICH ONE of a
> numbered set it belongs to, so two controls far apart on screen read as connected."*

Its mechanism is worth naming because it is **exactly GRM's `Color Label`**: an identity
colour is set as `--sem-color` on a container, and one class picks how it is *worn* —
`.sem-fill` (tint the fill), `.sem-edge` (the border carries it, *"what makes the code
readable on a control whose fill is near-empty"*), `.sem-solid` (a badge that IS the thing),
`.sem-ink` (a label naming its channel), `.sem-ring` (membership halo, box-shadow **never**
outline, so it can coexist with the focus ring).

---

## 3. The Wizard visual spec

### 3.0 Token reality check — what is actually available

`tokenVars()` emits exactly these, and `check:tokens` rejects any `var(--x)` it does not
define, plus any hardcoded hex / `rgb()` / font / `border-radius` / `px` font-size outside
`web/src/design/`:

```
colour   --bg #141414  --bg-raised #1e1e1e  --line #2e2e2e
         --text #d8d8d8  --text-dim #7f7f7f
         --accent #ef8b9a  --signal #57c07a  --warn #d9a13f  --hot #d95c5c
kinds    --chan-device #6f8fd9  --chan-app-tap #5ab6c9  --chan-deck #57c07a
         --chan-virtual #ef8b9a  --chan-bus #7f7f7f
lamps    --rec-lamp #d95c5c  --feedback-lamp #d9a13f
shape    --radius 0  --radius-sm calc(*0.5)  --radius-lg calc(*2)  --hairline 1px
motion   --motion-scale  --dur-fast 90ms*s  --dur-base 120ms*s  --ease
type     --font-mono  --font-ui
         --type-{display,title,label,value,caption}-{size,weight,tracking,family,transform}
```

**Three hard consequences, all of which constrain the design below.**

**(a) There is no spacing scale and no control-height token.** No `--cell`, no `--row-height`,
no `--control-h`. Every gap in `console.css` is a literal px (`gap: 8px`, `6px`, `4px`,
`3px`, `2px`) — legal only because the file lives in `design/`. **Wizard's spacing is
currently un-tokenised and drifting** (8/6/5/4/3/2 all appear). Recommendation: add
`density: { cellPx: 4, rowHeightPx: 26 }` and `control: { heightPx: 18 }` to `DesignTokens`
and emit `--cell` / `--row-height` / `--control-h`, matching Scoopy byte-for-byte. Until
then, **snap every literal to a multiple of 4** (4 / 8 / 12 / 16), with 22 px for a
transport button and 18 px for a control.

**(b) Four token names are aliases of other tokens.** `recLamp === hot === #d95c5c`;
`feedbackLamp === warn === #d9a13f`; `channelKind.deck === signal === #57c07a`;
`channelKind.virtualDevice === accent === #ef8b9a`. The palette therefore has **seven
distinguishable hues**, not eleven. Any scheme that tries to show "deck kind" and "live
signal" as different things, or "recording" as different from "hot", is drawing a
distinction the tokens cannot render. **This is the single biggest constraint on the state
colour map**, and it produces a real collision (§3.3).

**(c) The type scale is 16 / 11 / 11 / 11 / 10.** Four of five steps sit within 1 px of each
other. **A size-driven hierarchy is not buildable.** Hierarchy inside a Cell must come from
CASE + TRACKING (title/label are uppercase, tracking .08/.02em), COLOUR (`--text` vs
`--text-dim`), and POSITION. Stated plainly so nobody tries to solve a layout problem by
reaching for a bigger step that does not exist.

### 3.1 Proportions — the standard Cell

`DEFAULT_CELL` is **340 × 196** (`web/protocol/schema.ts:190`) — ratio **1.73 : 1**, versus
GRM's 3.3 : 1 for a one-reader slate. Wizard's is squarer because it stacks three Layout-B
rows where GRM puts speed and volume side by side in one band. That is the right trade for a
pointer-driven app with an 11 px type scale; **keep 340 × 196.**

The height budget, on a 4 px grid, summing to 196:

```
 pad-top          8
 head row        20        name · state · time · meter
 gap              4
 WAVEFORM        52        26.5 % of the cell    ← the GRM proportion law
 gap              4
 transport row   22
 gap              4
 3 × ParamRow    54        (3 × 18)
 row gaps         8        (2 × 4)
 gap              4
 footer/badges   12        (unmapped / missing / loading — collapses to 0 when clean)
 pad-bottom       8
 ─────────────────
                196
```

**Waveform at 52 px = 26.5 % of the Cell, against transport + params at 44 %.** That
deliberately reproduces GRM's ratio (20–32 %, falling as readings are added) and it is
close to what `Strip.tsx` already passes (`height={44}`, 22 %). Going to 52 buys legibility
without breaking the law; **do not go past 64** (33 %), where the object starts reading as a
waveform display with buttons under it instead of an instrument.

Waveform width is `cell.w − 16` = **324 px**, so the wave block is **324 × 52 ≈ 6.2 : 1**
(GRM's is ~8.3 : 1; Parlante's minimap is 40 px tall at full window width). In family.

```
┌ 340 ────────────────────────────────────────────────────────────────┐
│ ▪ TAKE_03            loop  0:00:07.338            ▮▮▮▮▮▮▮░░░  ▮▮░░░ │ 20  head
│                                                                      │
│ ▏▁▂▃▅█▇▅▃▂▁ ▁▃▅▇█▆▃▁ ▂▄▆█▇▅▃▁▂ ▁▃▅▇█▅▃▂ ▁▂▄▆█▇▄▂▁ ▁▃▅▇▅▂▁▕        │ 52  WAVEFORM
│ ▏          ┃          ⟦ loop ⟧                              ▕        │     ┃ = playhead
│                                                                      │
│  ●  ⟳  ▸  ◼                                        M   S   C        │ 22  transport
│                                                                      │
│ LEVEL   ▐███████████▌────────────────┤          −6.0                │ 18  ParamRow
│ PAN     ├────────────◆────────────────┤            C                │ 18  (bipolar fill)
│ SPEED   ├──────────◆──────────────────┤         1.00×               │ 18  (bipolar fill)
└──────────────────────────────────────────────────────────────────────┘
  ▪ = 6 px kind swatch      ▮ = meter segment      ⟦ ⟧ = loop brackets
```

### 3.2 Waveform treatment

**Form** — mirrored about the centre axis, **filled, no outline gradient tricks**, one
device pixel per column. This is the suite's ONE FORM and Wizard's `DeckWaveform.tsx`
already draws it correctly (`(1−hi)/2*h` … `(1−lo)/2*h`, `fillRect` per column).

**Layers to add**, in Parlante's order:

1. **Centre axis** first, 1 device px, `--line`. Currently only drawn in the *empty* case;
   draw it always, under the fill, so a near-silent take still reads as a take.
2. **Peak envelope**, filled, in the Cell's **kind accent** (`--chan-deck` for a deck,
   `--chan-device` for a live input, etc). Already correct.
3. **RMS core** — *deferred, and here is the honest reason*: `deckWaveform` returns
   `{min, max, frames}` only (`protocol/schema.ts:565-578`). There is no RMS envelope to
   draw. Adding one is an **engine change**, not a UI change. Until it exists, Wizard's
   waveform is a two-layer version of the suite's three-layer one. **Flagged, not faked** —
   do not simulate an RMS core from min/max, because that violates the truth contract
   (*"no resolution is claimed that the data doesn't have"*).
4. **Silhouette stroke** — skip. Without the RMS core there is no core/edge distinction for
   it to clarify, and at 52 px tall on a 340 px Cell it only muddies.

**Playhead — and the collision it exposes.**

`tokens.core.ts` documents `signal` as *"Meters, playhead, live activity"*. But
`channelKind.deck` **is the same hex** (`#57c07a`). A green playhead on a green waveform is
invisible. `DeckWaveform.tsx` currently sidesteps this by drawing the playhead in `--accent`
(pink) — which collides with the **loop brace**, also `--accent`, so on a looping deck the
playhead and the brace are the same colour.

**Decision (buildable today, no token change):**

| Mark | Colour | Weight |
|---|---|---|
| Waveform fill | kind accent (`--chan-*`) | fill |
| Centre axis | `--line` | 1 device px |
| **Playhead** | **`--text`** (`#d8d8d8`) | **2 device px** |
| **Record write-head** | **`--rec-lamp`** | 2 device px |
| **Loop region** | **`--accent` edge brackets**, 2 px, + `--accent` at `globalAlpha 0.14` between | Parlante's exact grammar |

`--text` reads against every one of the five kind accents *and* against `--bg-raised`, it is
the only colour in the palette that does, and it frees `--accent` to mean one thing (the
loop / the selection). The record head changing to `--rec-lamp` is then a genuine state
change rather than a second red among reds.

**Alternative, if a token change is acceptable:** move `accents.channelKind.deck` off
`#57c07a` (e.g. to a teal distinct from `--chan-app-tap`) and give the playhead `--signal`
as the token comment intends. Cleaner semantically; costs a `tokens.core.test.ts`-adjacent
pin update and a sibling conversation. **Recorded as a decision to take, not taken here.**

**Multi-reader (PD-CANVAS-2 preview).** When a Cell eventually holds N readers, follow GRM
exactly: **one shared waveform, N coloured pins.** With only five kind accents available,
N > 5 readers cannot be hue-coded — so index them `1..N` with a small numeral above each pin
and reserve hue for *kind*. Honest constraint, stated now so PD-CANVAS-2 does not discover
it late.

### 3.3 Meter

**Current state is a bug worth naming.** `Strip.tsx` renders `<MeterCanvas levels={…} />`
with no size props, so it takes the defaults **14 × 96** — a 96 px vertical meter inside a
header row of a 196 px Cell. Half the Cell's height is meter, and the head row is 96 px tall.

**Spec:** horizontal, **72 × 10**, right-aligned in the head row, two 4 px lanes with a 2 px
gap. `--bg-raised` trough, `--signal` fill, `--hot` at full scale, **2 px `--text`
peak-hold tick decaying 1 dB/frame** (Parlante's constant). Scale −60…0 dBFS via the
existing `ampToBar`. This is Scoopy's `OutputMeter` at Cell scale and Parlante's colour
logic, and it makes the head row 20 px as budgeted.

```
head row, 20 px:
 ▪ TAKE_03              loop   0:00:07.338      ▮▮▮▮▮▮▮▮░░░░░░
 └6┘└──── label ────┘  caption   value mono     └── 72 × 10 ──┘
```

### 3.4 Transport iconography

**Take GRM's hierarchy; reject GRM's circles.** `--radius` is 0 — the instrument default,
*"Sharp + hairline"* — so circular buttons are off-identity for the whole suite. And GRM
grades by *size*, which breaks a row's baseline; grade by *fill* instead, which is what
Scoopy's `.ds-button.active` / latch already does.

**Spec:** four square **22 × 22** hairline buttons at 4 px gaps, glyph centred in
`--type-label`, sharp corners, `border: var(--hairline) solid var(--line)`, hover →
`border-color: var(--accent)`.

| Verb | Glyph | Idle | Active |
|---|---|---|---|
| record | `●` → `■` while recording | `--text` on `--bg-raised` | **filled `--rec-lamp`, glyph `--bg`** |
| loop | `⟳` | `--text` | filled `--signal`, glyph `--bg` |
| one-shot | `▸` | `--text` | filled `--accent`, glyph `--bg` |
| stop | `◼` | `--text` | momentary, no latch |

The switch cluster `M / S / C` sits **right** in the same row (`margin-left: auto` — already
in `console.css`), latching `--hot` / `--accent` / `--signal` respectively (already correct).

**Direction glyph.** Borrow GRM's one genuinely clever piece of iconography: at negative
rate the speed row's leading glyph **flips `▶` → `◀`**. Wizard's `.varispeed-slider.reversed`
currently re-tints the accent to `--warn`, which spends a semantic colour on a direction.
Replace with the glyph flip and keep the accent; `formatRate` already prints the sign.

**Time readout** goes in the head row, not under the transport (GRM's position costs a whole
extra band). `--type-value` mono, `font-variant-numeric: tabular-nums`, `m:ss.mmm`, `--text-dim`
when stopped and `--text` while playing — the cheapest possible "is this thing running".

### 3.5 Type hierarchy in a Cell

| Step | Size/weight/tracking | Used for | Colour |
|---|---|---|---|
| display | 16 / 500 / .12em UI UPPER | app title bar **only** — never inside a Cell | `--text` |
| title | 11 / 600 / .08em mono UPPER | drawer + Inspector headings (`SOURCES`, `TAKES`) | `--text-dim` |
| label | 11 / 500 / .02em mono UPPER | **Cell name**, ParamRow labels, button glyphs | name `--text`; labels `--text-dim` |
| value | 11 / 500 / 0 mono | every number: dB, ×, time, `m:ss.mmm` | `--text` |
| caption | 10 / 400 / 0 UI | state word (`idle`/`loop`/`shot`/`rec`), file name, badges | `--text-dim` or state colour |

The Cell name is `label` (uppercase mono, tracked) and the state is `caption` (lowercase UI,
10 px). **Those two are 1 px apart in size and read as clearly different because one is
tracked uppercase mono and the other is untracked lowercase UI.** That is the whole
mechanism; use it everywhere.

**One change to current code:** `.plane-strip-name` sets `color: KIND_VAR[kind]`, so a bus
Cell's name renders `#7f7f7f` on `#1e1e1e` — a contrast ratio around 2.4:1, below any
legibility bar. **Move the identity off the text and onto a swatch** (§3.6). The name goes
back to `--text`.

### 3.6 Identity and state colour

**Identity (which Cell is this) — a swatch, GRM's `Color Label` in Wizard's idiom.**
A **6 × 6** square (sharp, `--radius` is 0) in the kind accent, first thing in the head row,
4 px before the name. Six pixels of colour is enough to sort a plane of Cells at a glance
and it survives zoom-out to strip mode where an 11 px name does not. Scoopy's
`.sem-edge` grammar gives the second wearer: the **selected** Cell's border takes `--accent`.

**State (what is this Cell doing) — the buildable map.**

| State | Where it shows | Token |
|---|---|---|
| idle | state caption | `--text-dim` |
| loop | state caption + loop button fill | `--signal` |
| one-shot | state caption + shot button fill | `--accent` |
| recording | state caption + record button fill + write-head | `--rec-lamp` |
| selected | Cell border, 1 px | `--accent` |
| muted | name → `--text-dim`, `M` filled | `--hot` |
| soloed | `S` filled | `--accent` |
| cued | `C` filled | `--signal` |
| unmapped output | badge strip, full width | `--warn` on `--bg` |
| audio missing | badge strip, full width | `--hot` on `--bg` |
| feedback alarm | master lamp | `--feedback-lamp` |
| decoding | determinate bar | `--accent` |

Nine of these already exist in `console.css` (`.deck-state-1/2/3`, `.latched-*`,
`.strip-unmapped`, `.deck-unresolved`, `.deck-loading`) and are correct. The additions are
the swatch, the border-as-selection, and the mute/name dimming.

**Note the alias collisions this map has to live with** (§3.0b): `loop` and `cued` are both
`#57c07a`; `recording` and `muted` are both `#d95c5c`; `one-shot`, `soloed` and `selected`
are all `#ef8b9a`. They never collide *in the same place* — a caption, a switch and a border
are different organs — but that is the reason it works, not an accident. Adding a tenth
state means adding a hue.

### 3.7 Size *is* the disclosure control — three tiers from one `cell.h`

GRM's best idea (§1.7), and Wizard already stores `cell.{w,h}` in the Patch, so this is a
render branch and nothing else. It also **subsumes strip mode**: pd-canvas §4 says *"strip
mode becomes zoom-out, not a separate layout"*, and this is the mechanism that makes that
true.

```
MINI     h ≤ 72          ┌─────────────────────────────┐
                         │ ▪ TAKE_03  ⟳  ▁▃▅▇▅▃▁  ▮▮░░ │  one row: swatch · state ·
                         └─────────────────────────────┘  8 px sparkline · meter
                         (this IS the docked strip, at zoom < ~0.45)

STANDARD 72 < h < 240    the 340 × 196 spec of §3.1

EXPANDED h ≥ 240         adds, in order, below the ParamRows:
                         · loop in/out as two editable value fields   (GRM's inverse-video
                           numeric field: light fill, dark glyphs = "typeable")
                         · output bus assign
                         · cue routing
                         · take name + duration + sample rate (caption)
```

Two rules that keep it honest: **no tier hides a verb** (record/loop/shot/stop and M/S/C are
present at STANDARD and above, and record + state are present at MINI), and **the Inspector
still carries the precise settings** for whatever tier you are in — expanding a Cell is a
convenience, never the only path to a control (design-notes §4.1).

### 3.8 The plane as a field

GRM's indigo-on-black gives huge figure/ground separation. Wizard cannot borrow the hue —
neutral-grey chrome is the identity — but it can borrow the *structure*: **the plane must
read as a surface, not as absence.** With emitted tokens only:

```css
.plane {
  background-color: var(--bg);                                   /* #141414 */
  background-image: radial-gradient(var(--line) 1px, transparent 0);
  background-size: 24px 24px;   /* × plane scale, set inline */
}
```

`--line` (#2e2e2e) dots on `--bg` at a 24 px pitch — visible enough to make pan and zoom
legible, far too quiet to compete with a Cell. Cells stay `.raised` (`--bg-raised` +
hairline `--line`), so Wizard's figure/ground is GRM's **inverted**: light objects on a dark
field rather than dark objects on a light field. That is correct for this palette; what
matters is that the gap exists at all.

Scale the pitch with the plane transform (`background-size: calc(24px * <scale>)`, inline)
so the field zooms with its contents — otherwise the grid reads as a fixed overlay and the
plane stops feeling like a place.

**Zoom controls stay bottom-right** (GRM's placement, already implemented in
`.plane-controls`) with `−` `+` `Default` `Fit`.

---

## 4. Delta list — what to change, in order

Each item is small, and none needs an engine change except where marked.

1. **`Strip.tsx`** — pass explicit meter size: `<MeterCanvas levels={…} width={72} height={10} />`.
   Fixes the 96 px header. *(one line)*
2. **`MeterCanvas.tsx`** — add the horizontal orientation (two 4 px lanes, 2 px gap) and the
   2 px `--text` peak-hold tick with 1 dB/frame decay.
3. **`DeckWaveform.tsx`** — playhead `--accent` → `--text` at 2 device px; always draw the
   `--line` centre axis; loop brace becomes 2 px `--accent` **edge brackets** + a
   `globalAlpha 0.14` `--accent` wash, not a full `strokeRect`.
4. **`Strip.tsx` + `console.css`** — 6 px kind swatch in the head row; `.plane-strip-name`
   back to `--text`; selected Cell border → `--accent`.
5. **`Strip.tsx`** — waveform `height={44}` → `52`; move the time readout into the head row.
6. **`console.css`** — transport buttons to a fixed 22 × 22; snap every literal gap to a
   multiple of 4.
7. **`VarispeedSlider.tsx`** — direction glyph flips `▶`/`◀`; drop the `--warn` re-tint.
8. **`.plane`** — the dot field, scaled inline by the plane transform.
9. **Tiering** — MINI / STANDARD / EXPANDED branch on `cell.h` in `Strip.tsx`; retires
   the separate strip-mode work item (P4-08).
10. **Tokens (decision needed)** — add `--cell` / `--row-height` / `--control-h` matching
    Scoopy's `4 / 26 / 18`, and resolve the `chan-deck === signal` collision. Both are
    cross-app conversations, not unilateral edits.
11. **Engine (optional, later)** — add an RMS envelope to `deckWaveform`'s result so the
    waveform can be the suite's full three-layer form.

---

## 5. Sources

**First-party GRM manual pages** (all under `https://sites.inagrm.com/download/grmplayer/documentation/co/`):
[GRMPLAYER_guide.html](https://sites.inagrm.com/download/grmplayer/documentation/co/GRMPLAYER_guide.html) ·
[GRMPLAYER_guide_1.html (sitemap)](https://sites.inagrm.com/download/grmplayer/documentation/co/GRMPLAYER_guide_1.html) ·
[GrmPLayer.html](https://sites.inagrm.com/download/grmplayer/documentation/co/GrmPLayer.html) ·
[02_Lire_et_repeter.html](https://sites.inagrm.com/download/grmplayer/documentation/co/02_Lire_et_repeter.html) ·
[03-Interface.html](https://sites.inagrm.com/download/grmplayer/documentation/co/03-Interface.html) ·
[PlanTravail.html](https://sites.inagrm.com/download/grmplayer/documentation/co/PlanTravail.html) ·
[Lecteurs.html](https://sites.inagrm.com/download/grmplayer/documentation/co/Lecteurs.html) ·
[Menus.html](https://sites.inagrm.com/download/grmplayer/documentation/co/Menus.html) ·
[Inspecteur.html](https://sites.inagrm.com/download/grmplayer/documentation/co/Inspecteur.html) ·
[Preferences.html](https://sites.inagrm.com/download/grmplayer/documentation/co/Preferences.html) ·
[04_Tutoriels.html](https://sites.inagrm.com/download/grmplayer/documentation/co/04_Tutoriels.html) ·
[Charger_un_son.html](https://sites.inagrm.com/download/grmplayer/documentation/co/Charger_un_son.html) ·
[Rajouter_un_lecteur.html](https://sites.inagrm.com/download/grmplayer/documentation/co/Rajouter_un_lecteur.html) ·
[Dupliquer_Lecteur.html](https://sites.inagrm.com/download/grmplayer/documentation/co/Dupliquer_Lecteur.html) ·
[Positionner_lecteur.html](https://sites.inagrm.com/download/grmplayer/documentation/co/Positionner_lecteur.html) ·
[Manipulation-objets.html](https://sites.inagrm.com/download/grmplayer/documentation/co/Manipulation-objets.html) ·
[05_Fonctionalites_avancees.html](https://sites.inagrm.com/download/grmplayer/documentation/co/05_Fonctionalites_avancees.html)

**First-party screenshots** (fetched from `…/documentation/res/`, decoded and sampled):
`Slate151_1.png` · `Slate151_2.png` · `Slate151Vol.png` · `SlateCursor02-a.jpg` ·
`SlateCursor03.png` · `Lecteur-Multi-lecteur_1.png` · `Selection-sequence.png` ·
`WorkArea_1.png` · `rajoutLecteur4_1.jpg` · `DupliquerLecteur3_1.jpg` · `presets.png` ·
`Insp02_Player.png` · `Insp01_Sequence.png`

**Not found:** no third-party GRM Player interface screenshots (reviews, YouTube stills, KVR
image posts) could be verified. [modwiggler t=208029](https://modwiggler.com/forum/viewtopic.php?t=208029),
[kvr t=608599](https://www.kvraudio.com/forum/viewtopic.php?t=608599) and
[kvr t=500424](https://www.kvraudio.com/forum/viewtopic.php?t=500424) are text only.
[inagrm.com/en/showcase/news/372](https://inagrm.com/en/showcase/news/372/grm-player) is the
official overview. **Nothing in this document rests on an unverified image.**

**Sibling source read:**
`parlante-next/web/src/waveform/{WaveformView,Minimap,TimeRuler,waveformGeometry}.tsx|ts` ·
`parlante-next/web/src/{Meters,TimeReadout}.tsx` ·
`scoopy/web/src/design/{waveformStyle.ts,tokens.ts,controls.css,semantic.css,looks.ts,OutputMeter.tsx}`

**Wizard source read:**
`web/src/design/{tokens.ts,tokens.core.ts,base.css,console.css,controls.tsx}` ·
`web/src/plane/{Strip.tsx,planeLayout.ts}` · `web/src/panels/DeckWaveform.tsx` ·
`web/src/hotsurface/MeterCanvas.tsx` · `web/protocol/schema.ts` · `web/scripts/check-tokens.ts`
