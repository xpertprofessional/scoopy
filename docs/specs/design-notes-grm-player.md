# Design notes — INA GRM "GRM Player" (layout inspiration)

*Research for Wizard's deck rack / console / strip layout (user request, 2026-07-23).
Feeds the PD design phase and the P4 deck rack. **Honesty caveat:** this is built from
textual descriptions (official blurb, the interface-anatomy doc, forum impressions) — I
could not load actual screenshots, so anatomy is reliable but pixel-level styling is
inferred and flagged where so. Every claim is cited.*

## 1. What GRM Player is

A touchscreen "sound studio" / "digital tape recorder laboratory" from INA GRM, built on
the studio's founding idea of **"doing and hearing"** (*faire et entendre*) — a
performance instrument for fixed-sound (acousmatic) music, explicitly *not* a DAW
timeline. Plays ~30+ audio formats, hosts AU/VST, records its output on the fly, and is
remote-controllable via MIDI/OSC/JavaScript (→ Max). [inagrm 372, kvr 608599]

**Interface anatomy** (the named regions, from the interface doc): **Workspace / Espace de
travail** → **Sequences / Séquences** → **Readers·Players / Lecteurs** → **Plug-ins**. A
"Work Area" hosts the players; a big **"?" popup → Show Tooltips** in its upper-right
teaches the app's vocabulary. [scribd 547781658, kvr 608599]

**The differentiator — multiple readers on one sound.** You spawn *several* players
("readers") over the *same* loaded sound, each with its own playhead (fixed or moving),
speed, and loop length. Many short simultaneous loops → **granulation**; a spread of
speeds/lengths → evolving atmospheres. On-the-fly resampling tracks playback speed, so
extreme slow-down (1/100, 1/1000) still sounds clean. [inagrm 372, kvr 608599]

**Feel.** GPU-rendered for smooth animation; horizontal touchscreen, multi-user (several
performers on one screen, or remote); non-destructive "aliases" in RAM; **infinite
undo/redo and cut/copy/paste/duplicate without interrupting audio.** [kvr 608599]

**Honest weakness (adopt as a warning):** users found it *unintuitive* — "couldn't even
figure out how to make the sound loop" without the manual; praised only that "the Tutorial
is clearer than the Documentation." A powerful model with a discoverability tax. [kvr 500424]

## 2. Steal / Adapt / Avoid — for Wizard

**STEAL**
- **N readers over one source.** GRM's core gesture — many players over one sound — is
  *exactly* Wizard's decks over a Take/file, and validates the 1–8 deck rack as a
  performance surface, not a track list. A Wizard deck ≈ a GRM reader.
- **Speed-tracking resample = varispeed done right.** Confirms D-WZ-DECKSRC-01 / P4
  varispeed: quality must hold at extreme slow rates. GRM's "slower → more accurately
  resampled" is the bar for the P4 streaming SRC.
- **Edit-without-stopping-audio.** Matches Wizard's RCU/seqlock discipline — reinforces
  that *every* deck/loop edit must be gapless. Good pressure-test for P3/P4.
- **"Doing and hearing" immediacy.** Load → hear → bend, no dialog gauntlet. Wizard's
  drag-source-to-strip + instant deck loop is the same posture; keep it.
- **Tooltip-first onboarding.** A single "?" that reveals the vocabulary in place — cheap
  antidote to the very discoverability tax GRM suffers. Cheap PD win.

**ADAPT**
- **Sequences.** GRM groups readers into "sequences." Wizard has no timeline (Law C-1),
  so *don't* import sequences as arrangement. But the idea maps to a **deck group / scene**
  (a saved set of deck states) — park as a post-P4 idea, not now.
- **Touch-first, multi-user.** Wizard is pointer-first, single-user. Borrow the *large
  hit targets* and **direct-on-object* controls (drag the waveform, not a far-off knob),
  but not the multi-user screen-sharing model.
- **GPU canvas.** Wizard already draws meters/playheads on a rAF canvas outside React
  (HotSurface). GRM's GPU rationale ("frees the CPU, smooth animation") is the same
  argument — hold the ≤2 ms/frame budget as decks scale to 8.

**AVOID**
- **The timeline/arrangement half.** No horizontal transport ruler across the app
  (Law C-1). Decks are self-contained cells.
- **The discoverability tax.** GRM's power hides behind a manual. Wizard's console must
  read at a glance — kind-accent colors + fixed strip anatomy already push this way; don't
  trade legibility for density.
- **Skeuomorphic tape/studio styling.** Wizard's identity is neutral-grey instrument
  chrome, mono type, sharp corners — keep it. Take GRM's *interaction* model, not its look.

## 3. Layout sketches (Wizard's own idiom)

**Console mode — deck rack as a row of "reader" cells** (each cell = a deck; the GRM
"many readers over one sound" gesture becomes "load a Take, spawn deck loops"):

```
┌ DECK RACK (1–8, add/remove) ─────────────────────────────────────────────┐
│ ┌ Deck 1 ─────────┐ ┌ Deck 2 ─────────┐ ┌ Deck 3 ─────────┐   [+ add deck]│
│ │ take_03.wav  ▸◼ │ │ vocal_lp    ⟳   │ │ (empty)         │              │
│ │ ▁▂▃▅▇▅▃▂▁ waveform│ │ ▇▅▃▂▁▂▃▅▇        │ │  Load…          │              │
│ │ └──loop brace──┘ │ │ └loop┘          │ │                 │              │
│ │ ◀ ●rec ⟳ 1shot Re│ │ ◀ ●rec ⟳ 1shot  │ │                 │              │
│ │ speed ├───●──┤ ⤺ │ │ speed ├●────┤ ⤺  │ │                 │              │
│ └─────────────────┘ └─────────────────┘ └─────────────────┘              │
└──────────────────────────────────────────────────────────────────────────┘
   waveform + loop brace + signed-speed thumb (⤺ = reverse zone) per cell —
   the GRM "reader" controls, in Wizard chrome. Playhead = HotSurface drawer.
```

**Strip mode — GRM readers collapsed to granular cells** (dock beside a full-screen DAW):

```
┌ Wizard (strip) ──────────────────────────────────────────────────────────┐
│ mic▕▊  Spotify▕▆  ▕D1 ⟳▂▃▅▂ ●▏ ▕D2 ▸▇▅▃ ●▏ ▕D3 ·· ●▏  cue◉  main▕▇▇  [FB] │
└──────────────────────────────────────────────────────────────────────────┘
   channels → mini-fader+meter; each deck → rec/loop/1shot + mini-waveform +
   speed thumb; monitor → lamp + cue toggle. Matrix/sources open as overlays.
```

## 4. Second pass — read from the manual itself (2026-07-24)

The first pass worked from the marketing page and forum reports. This pass reads the
official manual, which contradicts nothing above but adds three mechanisms worth naming.

### 4.1 The Inspector — the answer to "inline everything vs. clutter"

*"L'inspecteur permet de rassembler, d'éditer les informations sur les objets et de
paramétrer plus précisément certaines commandes"* [Inspecteur]. It is a **contextual
property panel** with three faces — Séquence, Pistes, Lecteur — that follow the current
selection. Clicking an object populates it.

This matters because our own PD-CANVAS plan asserts "every Cell shows its controls inline
(no hidden modes)" as the antidote to GRM's discoverability tax. Taken literally that is
unbuildable: a plane of twelve Cells each showing loop points, bus routing, cue and
plugin state is *less* legible, not more. GRM already solved this and we mis-read it:
**the slate carries what you touch while playing; the Inspector carries what you set
precisely.** That is not a hidden mode — the panel is always visible and always reflects
the selection.

### 4.2 Two player species, and what "multi" actually means

- **Lecteur simple** — one cursor over the sound, with direction and speed.
- **Multi-lecteur** — *groups sub-players inside a reading span* ("un empan, une fenêtre,
  une boucle") **that can itself move**. The span is a parameter in milliseconds, with
  speed multiply/divide and a **verrouillage** (lock).

So the granular claim is precise: it is not a separate synthesis engine, it is *N cursors
sharing one moving window*. Shrink the window and repetition becomes grain. Our engine
reaches this with the parts it already has — a deck is a cursor over a buffer — which is
what makes PD-CANVAS-2 (N readers per Cell) a UI-and-scheduling problem rather than a DSP
one.

### 4.3 Memory slots A/B/C/D with an interpolation time

Two or more grouped players expose **four preset slots** storing *"all settings contained
in the slate"*, plus an **interpolation time** between them. This is a performance
instrument, not a preset browser: you set two states and *morph* between them over a
chosen duration.

Wizard has no equivalent and should eventually: per-Cell snapshots with a glide time is
exactly the "instrument, not a mixer" posture (CONCEPT §2). Parked as **PD-CANVAS-3**, not
proposed for a first cut.

### 4.4 The philosophy, in their words

*"Les transformations sonores seront principalement réalisées par de multiples opérations
de lecture"* — the transformations are achieved by **multiple acts of reading**
[02_Lire_et_repeter]. Playback *is* the instrument. This is the same claim as our Law C-3
(stop → loop, instantly) arrived at from the other direction, and it is worth keeping the
sentence: it argues that Wizard's value is not the recorder but what you do to a sound
once it is loopable.

### 4.5 Correction to §2

§2 filed "Sequences" under ADAPT, reading them as arrangement. The manual shows a sequence
is **material** (sound on one or more tracks), not a timeline — the arrangement worry was
misplaced. What we must still avoid is the *temporal selection + cut/copy/scale* editing
surface the Inspector exposes over tracks: that is an editor, and Parlante is the editor
of this suite.

## Sources

- [inagrm.com/en/showcase/news/372/grm-player](https://inagrm.com/en/showcase/news/372/grm-player) — official overview ("doing and hearing", multiple players, simultaneous loops → granulation, formats, AU/VST, MIDI/OSC/JS)
- [scribd 547781658 — GRM Player interface doc](https://www.scribd.com/document/547781658/GRM-Player) — named regions: Workspace, Sequences, Readers, Plug-ins
- [Interface](https://sites.inagrm.com/download/grmplayer/documentation/co/03-Interface.html) — named regions + the manual's own page map
- [Lecteurs](https://sites.inagrm.com/download/grmplayer/documentation/co/Lecteurs.html) — lecteur simple vs multi-lecteur; empan/verrouillage; A/B/C/D memories + interpolation time
- [Inspecteur](https://sites.inagrm.com/download/grmplayer/documentation/co/Inspecteur.html) — "rassembler, éditer les informations sur les objets"; three faces; selection-driven
- [Lire et répéter en mouvement](https://sites.inagrm.com/download/grmplayer/documentation/co/02_Lire_et_repeter.html) — "de multiples opérations de lecture"
- [kvraudio forum t=608599](https://www.kvraudio.com/forum/viewtopic.php?t=608599) — readers over one sound, speed-tracking resample, GPU/touch/multi-user, aliases, infinite undo, edit-without-stopping, "?" tooltips
- [kvraudio forum t=500424](https://www.kvraudio.com/forum/viewtopic.php?t=500424) — discoverability critique; "Tutorial clearer than the Documentation"
