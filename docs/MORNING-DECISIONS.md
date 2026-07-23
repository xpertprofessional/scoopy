# Morning decisions — for the user, 2026-07-24

*Queue built by the autonomous loop overnight. Nothing here blocks the loop: it parks each
item and keeps building elsewhere. Each entry states the question, the options with
trade-offs, and my recommendation. Signing one moves it to `docs/DECISIONS.md`.*

## 1. ⭐ THE BIG ONE — UI vision: one unified item, freely arranged

**Your words (2026-07-24):** *"free arrangable players / decks / input in a field, only
one item, no separated input and deck channels — our vision needs improvement."*

This is a **product-shape change**, not a tweak, so it wants your sign-off before it
touches built code. Today's console is a fixed console: a sources rail, a horizontal
channel rack, a deck rack, a monitor section. Your direction collapses that into **one
object type on a freely-arrangeable canvas** — closer to GRM Player's workspace of
"readers", and honestly closer to what Wizard *is* (CONCEPT's own law says *everything is
a channel*; the current UI violates that by splitting inputs from decks).

**What it would mean concretely**
- **One item** ("Cell"? "Player"? — naming is part of the decision): binds a Source
  (input · app tap · file · deck · another cell's output), and *optionally* records/loops.
  An "input strip" is just a cell with no recording; a "deck" is a cell that has recorded.
  The schema already supports this — `Channel.source.kind` already includes `deck`; the
  split is purely a UI artifact.
- **Free placement**: x/y position + size per cell in the Patch (`uiMode` becomes a
  layout, not a mode). Spatial arrangement carries meaning (group by role, by song part).
- **What we'd lose/keep**: the fixed-width rack's scannability, and the strip-mode
  collapse (CONCEPT §6) would need rethinking as "zoom out" rather than "different
  layout".

**Cost:** P1-08's console panels are ~600 lines of UI; the engine/schema underneath is
unaffected (this is why building engine-first was right). Realistically a PD-phase
rewrite of the *panels*, not the app.

**My recommendation:** yes, but as its own phase (**PD-CANVAS**) after P3's recorder
lands — because a recorder is exactly what makes a cell interesting, and designing the
canvas around cells that *can't record yet* would mean designing it twice. I'll do the
GRM-manual deep research meanwhile (see §4) so the design is informed, not invented.

**Decide:** (a) adopt as PD-CANVAS after P3 · (b) adopt NOW, pause P3 · (c) refine the
vision further before committing.

## 2. Take naming + storage layout (needed by P3-05/07, soon)

When a deck stops recording, the file needs a name and a home.
- (a) `Takes/deck1_2026-07-24_14-32-05.wav` in the session package (Scoopy's STORED-zip
  discipline; P7 formalizes the package) — **recommended**, self-describing, sorts by time.
- (b) Content-hash names (dedupe-friendly, unreadable to humans).
- (c) User-prompted name at stop — kills the flow of a looper.

## 3. Monitor-while-recording default (P3-03, soon)

CONCEPT says per-deck monitoring is "optional/switchable". Default?
- (a) **ON** — you hear what you're capturing; the looper expectation. **Recommended.**
- (b) OFF — avoids doubling when the source is already audible through its own strip
  (which it *is*, in Wizard — the deck records a strip that's already in the mix).

Sub-question this exposes: when a deck records a strip that's already audible, do we
mute the source strip during recording (like a channel-to-tape console), or accept the
doubling? My instinct: **accept it** (no hidden state changes), and let the user mute.

## 4. GRM Player manual — deep research (queued work, no decision needed)

You asked for a deep read of the GRM Player manual to inform the above. Status: the
public web pages are a JS shell and the interface PDF is behind Scribd; the first-pass
research (`docs/specs/design-notes-grm-player.md`) got the anatomy (Workspace →
Sequences → Readers → Plug-ins) and the core gesture (N readers over one sound) from
official copy + forum accounts. **Next step needs you:** the in-app documentation
(`Help → online documentation`, French) or a downloaded manual PDF would let me do the
real deep read. If you can point me at a PDF path or install GRM Player, I'll mine it
properly for the canvas design.

---

*Loop status when this was written: P3-02 done (record buffer + drain + stamps), P3-03
(the Law C-3 gapless handoff) next. Parked: P2-05/06/07 (your machine + TCC runbook +
Linux). CI: blocked on GitHub Actions billing.*
