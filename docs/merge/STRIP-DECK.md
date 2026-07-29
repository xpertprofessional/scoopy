# STRIP-DECK — the deck tile (P3-D4-M, the D-SL-MORPH-01 build spec)

*Measured 2026-07-29. The direction is SIGNED (D-4 / D-SL-MORPH-01): a
session-loaded strip expands into a tile hosting the REAL `GridPanel` at DJ
density — the same component that IS the DJ deck view in scoopyloops since
AR-6. This doc records the measurement that decides HOW, and the sketch the
user may still re-proportion. Strips are one-kind-each (grid OR looper), so
there is no grid+tape morph question inside the tile.*

## The verdict: plane-side adapter, zero shell changes

`GridPanel@dj`'s entire READ surface is three topic families + three HotFrame
blocks; its entire WRITE surface terminates in the companion (`BrowserLink`) —
nothing needs the C++ dispatch. Serving the topics from the shell would mean
porting the whole grid document model into C++, i.e. re-creating the Swift
`WebGridBinding` the merge just carved off. `SlDispatch::getUiState` returns
`{}` for every topic BY DESIGN ("UiState stays with the COMPANION" —
engineLink.ts:389).

What `djSource(deck)` needs and who provides it today:

| surface | dj name | publisher today | absent ⇒ |
|---|---|---|---|
| `metaTopic` | `djMeta/<d>` (GridMetaState) | **nobody** | HARD BLOCK — "waiting for pattern state…" forever (GridPanel.tsx:2819) |
| `patternTopic(i)` | `djPattern/<d>/<i>` ×16 | **nobody** | zero rows ("half a track is not a track", :747) |
| `runtimeTopic(i)` | `djRuntime/<d>/<i>` ×16 | **nobody** | same |
| `hotBase/hotPosBase/hotLevelBase` | `djTrackStep/Pos/LevelD<d>T0` | engine zero-fills, never writes | ⚠️ frozen step-0 playhead wash on every row (`?? -1` never fires on a 0.0) — P3-D4-3 or adapter-side `-1` stamping |
| ambient `modulation`/`scenes`/`midiLearn` | — | nobody in merged host | graceful (inert extras) |
| `capabilities` | — | merged dispatch | `returnFx:false` hides the sends row; `pluginHosting:false` hides INST — honest, and saves height |

The store half is ALREADY deck-parameterised end to end: `useCompanion.decks[]`
(MAX_DECKS 3), `applyGridRow(trackIndex, row, deck)`, `gridRuntimeInfos(deck)`,
`gridPeakPaths(deck)`, `publish(state, deck, playing)`, `toggleLaunch/Solo/
LocatorRepeat(…, deck)`. Multi-mount is proven by DjPanel itself (two DeckSlots
in one WebView; per-deck sources, `shadow:false`, `focusScope`, `djFocusBridge`
keyed by deck).

**The actual blocker is `BrowserLink`:** ONE `GridBackend` per link with
hard-coded compose topic strings (gridBackend.ts:102-121), six single-slot
handlers (last mount wins — mount two Composers today and deck 0's edits land
in deck 1's document), one `gridPeakPaths`, and `publishTrackPattern` /
`getSamplePeaks` / `gridEdit selectTrack` / `getUiState` all DISCARD the
`p.deck` the schema already carries (schema.ts:1082).

## P3-D4-1's work list (the adapter)

1. `GridBackend` gains a topic-prefix/deck constructor (strings live in 5
   places) — or three instances behind a deck router in `BrowserLink`.
   Publishes `djMeta/<d>` + `djPattern/<d>/<i>` + `djRuntime/<d>/<i>` from the
   companion's per-deck sessions (the same projection compose uses).
2. Deck-route the four deck-dropping commands; per-deck handler maps replacing
   the six single slots; per-deck peak paths.
3. `GridMetaState` honest values (the gridBackend.ts:123-152 list):
   `ownerPatterns: true` (MANDATORY — false = every control inert),
   `deckIndex: <d>`, `masterSends: []`, `keyboardActive` ARBITRATED (exactly
   one deck true, else every mounted panel answers every arrow key),
   `syncedBpm` from the plane's law, bpm/vol/drive from the document.
4. HotFrame: stamp `-1` into the `djTrack*` blocks adapter-side until P3-D4-3
   lands real per-deck values.
5. ~~MasterRow's BPM/VOL/DRV `paramWrite`s are refused by `MergedMain::handleParam`
   → reroute BPM / hide the row~~ **RESOLVED BY USER DECISION + P3-D4-1a
   (2026-07-29): the tile keeps scoopy's FULL row, all three controls REAL.**
   The user chose neither offered option — "work from the real scoopy
   perspective; the design adapts to the real version". Built: the session
   document's masterVolume + clipper block ride the world into the core's
   per-deck master render (8 keyed snapshot-deck names); the row's writes are
   document edits via the BrowserLink sessionParam seam → `setBpm` /
   `setMasterVolume` / `setMasterDrive`. syncedBpm (the sync/nudge resolved-
   tempo display the user called out) lands with the adapter meta in D4-1/D4-2.
6. Shared-singleton hazards inherited from DJ mode, accepted and noted:
   `undoStore` keyed by track only (three decks share one ⌘Z timeline).

## The tile (the sketch — proportions reviewable, direction signed)

Measured floor for one dj deck column: **~480-500 px wide** (the DSP row's five
88px min-width boxes clip rather than wrap) × **~136 px per track** (cell row 40
+ measured band ~92) + MasterRow (~30). Four tracks ≈ 500×600.

`DEFAULT_CELL` is 340×196; planeLayout already frames document-valued cells, so:

- **Expanded deck tile = 2×3 cells** (~688 × ~604 with gaps) — fits 4 tracks
  fully, 6+ scroll inside the GridPanel region (its own overflow, never the
  plane's).
- **Collapsed = today's 340×196 strip, exactly** (scene pads 1-8, transport,
  level, sends, grid row). Nothing built is lost; expand is a reveal, not a
  mode.

```
┌──────────────────────────────────────────────────────┐
│ ⋯ UNTITLED     ▶ REV BR·¼ SYNC │ SAVE ⏏      ▸main  │  header + deck verbs
│ [1][2][3][4][5][6][7][8]                     ▮meter  │  scene pads (P3-U8)
│ ┌──────────────────────────────────────────────────┐ │
│ │  REAL GridPanel · variant dj · cellsHidden off   │ │
│ │  cell rows w/ waveforms · TrimBar · M/S · rate   │ │  scrolls beyond 4
│ │  GAIN ROOT GATE PITCH PAN VOLUME …               │ │
│ └──────────────────────────────────────────────────┘ │
│ ▓▓▓▓▓▓▓▓░░░░░ LCM                                    │  needs P3-D4-3
│ 120.0 bpm · SYNC · T+P    ● REC   ⟳ ▸ ↻ ◼   lvl ━━  │  channel row
└──────────────────────────────────────────────────────┘
```

Header verbs (from the TransportPanel DeckBlock, merged-engine-backed only):
- **▶** play/stop (companion play/stop — the strip transport's verbs, promoted)
- **REV** (P3-M-1b's `setReverse`, deck scope)
- **BR + fused scale** (P3-M-1b's verbs, deck scope)
- **SYNC** (the grid row's control, promoted)
- **SAVE** (`saveSession(deck d's session)`) · **⏏ EJECT** (closeDeck + unbind,
  today's menu item promoted)
- **NUDGE** rides P3-D4-2 via `nudgeBpmDelta` (hold-to-bend, snap-back)

~~Deliberately NOT folded, reasons named: **OPEN** (the library owns it, P3-L1) ·
**DBL** (a document op with no merged verb — future row if wanted) · **WIN/TR**
(beat-repeat variants beyond the fused scale — revisit with per-deck playhead) ·
**C / GRID / select** (multi-deck-view concepts; the plane's selection is the
strip itself).~~ **SUPERSEDED — see the amendment below.**

## AMENDMENT 2026-07-29 — the tile IS the whole deck (D-SL-DECKFULL-01)

*The user, on seeing the tile in the real host: the scoopy strip window (deck)
"will be pretty much exactly the scoopy loops dj deck view WITH its deck
transport … this way we can be sure our advanced scoopy system functions
correctly ongoing". The sketch above stands; the "deliberately NOT folded" list
above does not.*

**Every deferred item folds in**, and the header verbs migrate DOWN into the
classic rows — one control, one home, which also closes P3-D4-2's recorded SYNC
deviation. The tile carries all four classic rows (P7-T1..T4):

| row | contents | note |
|---|---|---|
| toolbar | OPEN · ■ · ▶ · » · REV · NUDGE · DBL · EJECT · SAVE | OPEN folds back as a library popover ADDRESSED to this strip (P3-L1 owns the library, not the door); DBL needs a new companion pattern-double verb |
| sync | SYNC ‹pulse› · TR ‹±n› · WIN · BR ‹›  | WIN/TR return — the per-deck playhead they were waiting for landed in P3-D4-3 |
| scene | pads 1–8 · S · R · CU · SCN · MUTE · GRID/PERF | GRID/PERF ride `GridMetaState`'s `gridHidden`/`performOn`; SCN is the pin latch |
| master | BPM · VOL · DRV · S1–S4 | BPM/VOL/DRV real since P3-D4-1a; S1–S4 become real in P7-T4 (`masterSends` was `[]`; the lanes exist since P6-3) |

**Rebuild, never mount.** `TransportPanel.tsx::DeckBlock` speaks `deckSection` /
`transportDeck` / `menuTransport` / `djSetting` and reads the `toolbar` + `dj`
UiState topics — none of which the merged dispatch answers. That coupling is the
P3-M-1 measurement and the reason P3-P1 retired those doors. DeckBlock is the
SOURCE LIST for what each row must do; the rows themselves are rebuilt on
companion lanes exactly as P3-D4-2 rebuilt the header verbs.

### Full-viewport mode

The user: "strips should be full viewport on command and then be able to tab
through the individual strips in full size." Two laws:

1. **It is a VIEW state, never a document edit.** The two-size tile (340×196 ⇄
   `DECK_CELL` 692×612) IS document cell geometry, deliberately — full-viewport
   is not a third cell size. It must leave `strip.cell` untouched so a map saved
   while a strip is maximized reopens with its plane geometry intact. The
   mechanism (plane transform vs. an overlay mount) is measured in P7-K0.
2. **Tab cycles strips at full size**, on the same single-focused-strip model the
   keymap uses (D-SL-NAV-01, P7-N1/N2), and one key drops back to the map.
   Compose stays reachable from the full-viewport face. Looper strips maximize
   too — they simply show the channel face, no grid.

This retires the "no cross-tile arrow ring" limit noted in P3-D4-1 by replacing
its premise: there are no fixed `djSlotIndex` slots, but there IS now a focus
ring, which is what the arrow/Tab vocabulary binds to.

## Row sizing

- **P3-D4-3** (~180 LOC C++): per-deck `djTrackStep/Pos/Level` HotFrame blocks
  + `-1` semantics; unblocks the playhead + LCM bar. Decision-free, first.
- **P3-D4-1** (~450 LOC web): backend deck-parameterisation + BrowserLink
  routing + `planeDjSource` meta publisher + the expanded face (`DeckFace.tsx`,
  planeLayout expand op).
- **P3-D4-2** (~300 LOC web): the header verbs + nudge.
