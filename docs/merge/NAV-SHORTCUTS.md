# NAV-SHORTCUTS — the keyboard, audited against HEAD

**P7-K0. Opened 2026-07-30 (Lane C). Spec row: this document IS the row; no
source changed.**

Four things are settled here, in the order P7 needs them:

1. **§2 — the chord representation.** The ledger calls this "P7-K0's real first
   job": `ShortcutEntry.keys` is a display string, so nothing downstream can
   match on it.
2. **§3 — the context map**, `dj` → focused strip, and the context set the
   dispatcher resolves against.
3. **§4 — the digit allocation.** The one open detail inside signed decision
   **D-8 / D-SL-NAV-01**. Settled **provisionally**; a user veto re-tunes it.
4. **§5 — the full-viewport mechanism**, which P7-V1 defers here.

**§6 is the audit itself**: all 99 keymap rows, each ending in a merged-verb
target or a written reason it is parked. §7 collects the defects the audit found
as proposed ledger rows — this doc fixes nothing.

Everything below was measured at HEAD on `lane/c`, not read out of the ledger.
Several P7 rows carry citations the 2026-07-30 audit falsified; §1 records which
of those the measurement confirms, and adds three the ledger does not have.

---

## 1. The measurement — what actually answers a keystroke in WizardMerged

### 1.1 There is no native keyboard at all

`shell/` and `host/` contain **no `MenuBarModel`, no `setMacMainMenu`, no
`PopupMenu`, no `KeyPress`, and no `forwardKey` handler** — the greps return
empty. `publishMenuTree` is in the shell's explicitly-unimplemented list, and
`shell/tools/sl_dispatch_test.cpp:153-158` asserts it refuses by name.

So in WizardMerged there is no menu bar, no key equivalent, and no HotkeyManager.
**Every keystroke lands in the WKWebView and is answered only by JavaScript, or
not at all.** The TS dispatcher P7-K1 builds is therefore not an optimisation of
an existing path — it is the *only* possible delivery mechanism for ~90 of the
99 rows.

### 1.2 The relay the ledger says is unmounted — confirmed, with the mechanism

`web/src/App.tsx:129-131`:

```ts
const browserHosted = link instanceof BrowserLink ? link : null;
useNativeKeyForwarding(browserHosted ? null : link);
useBrowserKeymap(browserHosted);
```

`MergedLink extends BrowserLink` (`web/src/engineLink.ts:269`) and
`createEngineLink` returns it first (`:444-455`). So in the merged host
`browserHosted` is truthy: `useNativeKeyForwarding` is given `null` and never
mounts, and `useBrowserKeymap` is the live root listener. **P7-K1's premise is
confirmed** — but note the consequence the row does not draw: the lane K1 wants
to "retire" is already gone, so K1 has nothing to retire and everything to
build.

### 1.3 The live keyboard surface, exhaustively

| Surface | Chords it answers | Scope |
|---|---|---|
| `browserKeymap.ts:77-93` | `⌘Z` · `⇧⌘Z` · `Space` · `1`–`8` — **11 chords** | window, always |
| `GridPanel.tsx:2306-2812` `handleKey` | `⌘C` `⌘V` `Tab` `Esc` `ö` `ä` `k` `l` `[` `]` `Ö` `Ä` `j` `a` `g` `f` `F` `.` `,` `⌥.` `⌥⇧.` `Enter` and the arrow family (bare · `⇧` · `⌥`) | only while that grid holds `keyboardActive` |
| `focusModel.ts:167-204` | `ö` `ä` `Enter` `.` | only while a controls-lane DragBox holds the ring |
| `ContextMenu.tsx:134` | `Esc`, arrows | only while a context menu is open |
| `FileBrowserPanel.tsx:178-220` (element-level) | `↑ ↓ ← →` `Enter` `Space` | only while the browser list has DOM focus |
| `DjPanel.tsx:65-81` | `⌘B` | a retired `≡` panel (D-4) — unreachable |

That is the whole of it. **Nothing else in the merged app answers a key.**

### 1.4 Three facts the ledger does not carry

**(a) `KEYMAP` and `GridPanel.handleKey` are two undeclared halves of one
keyboard.** `KEYMAP`'s 90 native-owned rows are declared against a HotkeyManager
that does not exist here. `GridPanel.handleKey` meanwhile implements about
twenty-five chords — **16 chord slots across 12 `KEYMAP` rows** match it exactly,
and the rest (`k` `l` `[` `]` `Ö` `Ä` `f` `F` `,` `j` `a` `g`) are live in the
merged host and **not declared in `KEYMAP` at all**.
The dispatcher's first duty is therefore **reconciliation, not addition**: bind
`ö` in a new dispatcher without noticing `GridPanel` already owns it and the key
fires twice. §6 marks every such row `DECLARED-LIVE`.

**(b) `GridPanel`'s "release to native" branches are now silent drops.**
`GridPanel.tsx:2812` is `if (handleKey(e) !== "forward") claimKey(e)` — claim by
default, release where it declines. Six `return "forward"` sites
(`:2334 :2339 :2375 :2387 :2434 :2640`) exist to hand a key to the root relay. **The root relay is unmounted (§1.2)**, so every one of
them now yields to `browserKeymap`'s 11 chords and, missing those, to nothing.
The comment at `:2640` still promises "the full shortcut library
(transport/record/undo/mute-all/zoom…) stays live under the web grid". It does
not.

**(c) `scenesStore.ts` is a complete, dead scene-verb module — and it is the
trap a K-series builder will fall into.** It exports `sendSceneClick`,
`sendSceneToggleLatch`, `sendSceneToggleMute`, `sendSceneCopyPattern`,
`sendScenePastePattern` … and its own comment at `:65` says the senders are
"1:1 with `PdSceneCell.handleClick` **+ hotkeys 9/0**". Every one of them issues
`link.command("patternScene", …)`. **`patternScene` is answered nowhere**: it is
absent from `BrowserLink`'s 15-case switch (`browserLink.ts:273-419`) and absent
from `MergedLink.NATIVE_METHODS` (`engineLink.ts:280-337`), so it falls through
to the companion's "not implemented" and is swallowed by the senders' own
`.catch(() => {})`. Its only consumers are `ScenePads.tsx` and
`TransportPanel.tsx` — both retired `≡` doors.

The **live** scene verb is `useCompanion.selectScene(letter, { immediate, deck })`
(`companionEngine.ts:809`), reached today from the strip's own pads
(`Plane.tsx:626-627`). Every scene chord in §6 targets that, never `scenesStore`.

### 1.5 Two ledger claims this audit confirms verbatim

- `Generated/ShortcutList.swift` **is not in this tree** (`find` returns
  nothing), yet `keymap.ts:16-18` still documents it and names `protocol:check`
  as its gate. There is no `protocol:check` in `web/package.json`. Both lines of
  that header comment are stale.
- `KEYMAP`'s only consumer in the tree is `keymap.test.ts`. Grep for `KEYMAP`,
  `ShortcutEntry`, `KeyContext` outside `commands/` returns nothing. **The
  shortcut list has no door**: no Help window, no overlay, no panel renders it.

---

## 2. RULING — the chord representation

**The problem, precisely.** `ShortcutEntry.keys` (`keymap.ts:38-39`) is
documented as a *display* chord: `"⌘⇧S"`, `"ö / ä"`, `"⌃1–8"`, `"Q W E R T Z U I"`,
`"O (hold, recording)"`, `"⇧Drag"`. `keymap.test.ts:6-9` already admits the cost:
compound rows are "opaque tokens", so the collision test catches exact-string
double-claims only. A dispatcher cannot match a `KeyboardEvent` against any of
those strings, and **must not parse them** — `"⇧8 (*)"` and `"Tab or -"` are
prose.

**The ruling: keep `keys` as display, add a parallel machine field. Never
derive one from the other.**

```ts
/** One matchable chord. Same shape and same physical-key convention as
 *  registry.ts:29-35 KeyEquivalent — deliberately identical so a registry
 *  shortcut and a keymap chord are the same value, matched by the same
 *  function (browserKeymap.ts:41 matchesShortcut, EXACT modifier equality). */
export type Chord = KeyEquivalent;

export interface ShortcutEntry {
  keys: string;            // UNCHANGED — human display, the Help list's text
  chords: readonly Chord[]; // NEW — what the dispatcher matches. May be empty.
  label: string;
  context: KeyContext;
  owner: "registry" | "native";
  commandId?: CommandId;
  /** Non-null ⇒ this row is PARKED and dispatches nothing. The reason is
   *  required so a dead chord can never be silent (P7-K3's gate reads it). */
  parked?: string;
}
```

Five consequences, each load-bearing:

1. **A range row expands to its members.** `"⌃1–8"` becomes eight `Chord`s
   (`Digit1…Digit8`, `ctrl: true`). The 99 display rows expand to **216 chord
   slots** — 214 keyboard chords plus 2 pointer gestures that carry none. The
   collision test then compares *chords*, not tokens, and gains the whole class
   `keymap.test.ts:6-9` says it cannot see today.
2. **`chords: []` is legal and means parked.** Paired with a required `parked`
   reason, this is what makes "every entry ends with a target or a written
   reason" mechanically checkable — which is exactly the fixture P7-K3 is.
3. **Registry rows derive `chords` from the `Command`,** the same way `reg()`
   already derives `keys` (`keymap.ts:82-91`). One declaration, still.
4. **`code`, never `key`.** The convention is already fixed twice
   (`registry.ts:26-28`, `browserKeymap.ts:8-9`) and the tree has been bitten by
   it: `keyForward.ts:104-108` notes that on a QWERTZ the `KeyY` slot types `z`.
   The **three exceptions** are the German-layout rows `ö` `ä` `ü`, which have no
   stable `code` across layouts — `GridPanel.tsx:2469` and `focusModel.ts:176-178`
   both already match those by `e.key` and say so. Model them as
   `{ key: "ö" }` and let `matchesShortcut` accept either discriminant.
   Do not invent a fourth convention.
5. **Reservation becomes host-scoped.** `isReservedShortcut`
   (`browserKeymap.ts:51-55`) refuses `⌘W`/`⌘T`/`⌘Q`/`F11` for every
   `BrowserLink` — and `MergedLink` *is* a `BrowserLink`, so it would refuse
   chords in a JUCE window that has no tabs to switch and no browser to quit.
   Ruling: **add `hostKind(link): "desktop" | "merged" | "browser"` to
   `engineLink.ts`** (a one-line class discriminator; `MergedLink` already
   exists as a distinct class, it is merely unexported) and give
   `isReservedShortcut(chord, host)` a second argument. **No schema change** — a
   version bump must move all three hosts `schema:check` compares, and this
   needs none. The browser list additionally must gain `⌘N` and `⌘⇧N`, which
   Chromium takes before `preventDefault` can run.

---

## 3. RULING — the context map (`dj` → the focused strip)

### 3.1 The context set

`KeyContext` today (`keymap.ts:29-35`) is
`global · compose · grid · dj · browserFocus · noteKeyboard`. It describes
scoopyloops' window layout. The merged app's surfaces are the plane, a strip on
it, an expanded deck tile, and a compose window. The ruling:

| Context | Live when | Fate |
|---|---|---|
| `global` | always | **kept** |
| `plane` | the plane surface has focus and no tile owns the keyboard | **NEW** |
| `strip` | a strip is focused (`mapStore.selectedKey !== null`) | **NEW** — the name P7-K2 already uses |
| `grid` | a `GridPanel` holds `keyboardActive` (an expanded tile, or the compose window's grid) | **kept**, re-scoped from "compose grid lane" to "whichever grid holds the claim" |
| `compose` | `ComposeWindow` is the active surface (P7-L1) | **kept** |
| `browserFocus` | the file browser list has DOM focus | **kept** — already live (`FileBrowserPanel.tsx:178-220`) |
| `noteKeyboard` | musical-keyboard mode is on | **kept** — `setNoteKeyboardActive` (`keyForward.ts:95-101`) is the live flag |
| `dj` | — | **RETIRED.** Its 13 rows repoint per §3.2. |

`plane` and `strip` are nested, not exclusive: a `strip` chord is offered first
and falls through to `plane`. Resolution order is
`noteKeyboard → browserFocus → grid → strip → plane → compose → global`, and the
first context with a matching chord wins. `noteKeyboard` first is not a
preference — `GridPanel.tsx:2374-2376` already yields *all* bare printables in
that mode and explains why: the piano layout wants `a·f·g·j·k·l·ö·ä` and the
grid claims every one of them.

### 3.2 `dj` → focused strip, row by row

The DJ view had two fixed decks with a hardware-style split hand: `Q/W/E` on the
left deck, `A/S/D` on the right. The plane has up to `MAX_DECKS = 3`
(`companionEngine.ts:170`) grid strips **and no fixed left/right**. D-8's answer
is one chord set aimed at whichever strip is focused.

The focus anchor is `useMapStore.selectedKey` (`mapStore.ts:52`, set by
`setSelected` `:91-93`), already drawn by `.plane-strip.selected`
(`plane.css:277`, wired at `Plane.tsx:108,548`). The deck a chord acts on is
`strips.find(s => s.key === selectedKey)?.element.deck`, `-1` for a tape strip —
the exact expression `Plane.tsx:637` already guards with `if (deck < 0) return`.

| `dj` row | collapses to | merged verb |
|---|---|---|
| `Q / W / E` (deck A) **and** `A / S / D` (deck B) | **`Q / W / E`** on the focused strip | `W` → `Plane.tsx:636-644 onGridTransport('play')`; `E` → `'restart'` (stop+play, `:640-643`); `Q` → `setReverse(deck, true)` + play (`companionEngine.ts:729`, the door is `Strip.tsx:784`) |
| `R / F` (hold-to-play A/B) | **`R`** on the focused strip | `play` on keydown, `stop` on keyup — needs the dispatcher's keyup lane (§7 R-2) |
| `U / J` (tape-reverse hold A/B) | **`U`** on the focused strip | `setReverse(deck, on)` on down/up, `companionEngine.ts:729` |
| `T Y / G H` (nudge A/B) | **`T` / `Y`** on the focused strip | `setNudge(link, deck, ±delta)` on down, `0` on up — `nudgeStore.ts:37`, the door is `Strip.tsx:838-841` |
| `1–4 / 5–8` (scene on A/B) | **`1–8`** on the focused strip | `selectScene(letter, { deck })` — see §4 |
| `-` (switch active deck) | **`Tab`** | `setSelected(nextKey)` — P7-N2 |
| `⌘⌥D` (double active deck) | unchanged, retargeted | PARKED — no merged double-deck verb (§6) |
| `⌥Space` (all decks) | unchanged | `play`/`stop` over every deck with a session |
| `⌥9 / ⌥0` (sync BPM ±1) | unchanged, retargeted | `setBpm(bpm ± 1, deck)` — `companionEngine.ts:749` |
| `⌥⌘\`` (focus playlist) | — | PARKED — no playlist in the merged tree |

**Eight chords are freed** by the collapse (`A S D F J G H` and the second digit
bank). They are **not** reassigned by this document. Freed is not spare: a user
with the old hand will press `S` and must get nothing rather than something
else. P7-K2 parks them explicitly with this sentence as the reason.

---

## 4. RULING — digit allocation · **PROVISIONAL (D-8 / D-SL-NAV-01)**

`MORNING-DECISIONS-2.md:41-44` records that this is the single open detail inside
a signed decision, that NAV-SHORTCUTS.md settles it provisionally, and that a
veto re-tunes it. **This section is that provisional settlement. It is the only
thing in this document offered for veto.**

The ledger's provisional was "digits = scenes on the focused strip, ⌘/⌥-digits =
focus jump, Tab/⇧Tab = cycle". The measurement keeps the first and third, and
**picks `⌥` out of the row's `⌘/⌥`**, with the reason written down.

| Chord | Meaning | Context | Merged verb |
|---|---|---|---|
| `1`–`8` | launch scene 1–8 on the **focused strip** | `strip` | `selectScene(SCENE_LETTERS[n-1], { deck })` — `companionEngine.ts:809` |
| `⇧1`–`⇧8` | *(parked)* queue the scene | `strip` | no queue verb exists — §6 row 11 |
| `⌥1`–`⌥8` | **jump focus to strip 1–8** in geometry order | `plane` · `strip` | `setSelected(key)` — `mapStore.ts:91-93` |
| `⌥⇧1`–`⌥⇧8` | immediate scene switch on the focused strip | `strip` | `selectScene(letter, { immediate: true, deck })` |
| `9` · `0` | *(reserved, unbound)* | `strip` | see below |
| `⌥9` · `⌥0` | sync BPM −1 / +1 on the focused strip | `strip` | `setBpm(bpm ± 1, deck)` — `companionEngine.ts:749` |
| `Tab` · `⇧Tab` | cycle focus forward / back through every strip | `plane` · `strip` | P7-N2 |
| `⌘1`–`⌘9` | **never bound** | — | — |

### Why `⌥` and not `⌘` for the focus jump

1. **`⌘1`–`⌘9` is unavailable on both walk hosts.** Chromium and WebKit both
   take it for tab selection before the page sees it, and H4 fixed the walk
   matrix as webkit+chromium. A `⌘`-digit binding could never be proven by a
   walk — it would be a chord that only "works" where nobody can test it. The
   four rules are explicit that a green gate is not the bar; an *untestable*
   binding is below even that.
2. **`⌘⇧1/2/3` already means "send session to Deck A/B/C"** (keymap row 78) and
   `⌘⌥3` means "enable Deck C" (row 79). Putting focus-jump on `⌘`-digits would
   put three different meanings on the digit row's `⌘` family.
3. **`⌥`-digits collide only across contexts, which is legal.** `⌥1–8` means
   "immediate scene switch" in `compose` (row 12). Focus-jump is `plane`/`strip`.
   The dispatcher resolves by context and the collision test is already
   context-scoped (`keymap.test.ts:34-35`), so both survive. That is the
   context model doing its job, not a fudge.
4. **`⌥9`/`⌥0` = sync BPM (row 89) sits directly beside it.** `⌥1–8` for the
   eight strips and `⌥9`/`⌥0` for tempo is one continuous, already-half-existing
   hand.
5. **`⌃`-digits were considered and rejected**: `⌃1–8` is beat repeat (row 43)
   and `⌃⌥1–8` its upper bank (row 44) — the busiest digit family in the map.

### Why bare digits stay scenes

They already are. `browserKeymap.ts:85-91` binds bare `Digit1`–`Digit8` to
`{ kind: "scene", index: n-1 }` and `:126-132` resolves it through
`enabledScenes` — the one place the keymap is *already* live in the merged host.
The change D-8 asks for is one line of aim: `companionDeck()` defaults to deck 0
(`:118,:128`), and must become the focused strip's deck. Moving digits off scenes
would break the only working shortcut on the plane to gain nothing.

### The consequences, stated plainly

- **More than eight strips**: `⌥1–8` reaches the first eight in geometry order
  (sort by `cell.y`, then `cell.x`, then `key` — stable under any pan or zoom
  because it reads the document, not the screen). `Tab` reaches all of them. A
  ninth strip is not addressable by digit, and that is accepted.
- **`9` and `0` stay unbound in `strip`.** In compose they are the scene-edit
  latch and the master mute group (rows 14–15). Both verbs are dead on the wire
  (§1.4c), so binding them on the plane would ship two silent keys. They are
  **reserved** — named here so a later row claims them deliberately rather than
  finding them apparently free.
- **A tape strip has no deck.** Every digit is a no-op there, guarded exactly as
  `Plane.tsx:637` guards it. A no-op, never a fallback to deck 0 — silently
  acting on a strip the user is not looking at is the defect class this whole
  section exists to avoid.

---

## 5. RULING — the full-viewport mechanism (P7-V1)

P7-V1 defers the mechanism here and fixes one constraint in advance:
full-viewport is **"a VIEW state, NEVER a document cell edit."**

### 5.1 Why that constraint rules out today's expand

Today's expand *is* a document cell edit. `Strip.tsx:741-760` calls
`updateStrip(strip.key, s => ({ ...s, cell: { …DECK_CELL } }))`, and `updateStrip`
(`mapStore.ts:97+`) sets `dirty`. `expanded` is then *derived from the geometry*
— `isDeckCell(strip.cell)` (`Strip.tsx:239`, `planeLayout.ts:50-52`) — and
`planeLayout.ts:49` states the design intent: "expansion is a size, not a mode
flag, so this predicate is the one definition". That is a good rule for expand
and exactly the wrong rule for full-viewport, which must leave the saved
document untouched.

### 5.2 Why the plane transform is also ruled out

Two independent reasons:

1. **It writes the document too.** The transform is
   `scale(view.scale) translate(view.panX, view.panY)` (`Plane.tsx:526`), and
   `commit` calls `updatePlaneView` (`Plane.tsx:130-133`), which writes
   `map.plane` (`mapStore.ts:107-112`). It deliberately does not set `dirty`
   ("panning and zooming are looking, not editing") — but `plane` is a persisted
   field of the document (`mapDocument.ts:301`), so the next save records the
   full-viewport framing. P7-V1's own gate is *"the saved map's plane geometry is
   untouched afterwards"*, and a transform-based mechanism fails it.
2. **It magnifies; the row asks for room.** P7-V1's restated purpose is that
   the extra width goes to the **strip**, because five TrackBand rows at `0.85em`
   inside 692×612 is "hard to control its UI". A CSS `scale()` enlarges those
   five rows without giving them a single extra pixel of *layout* width — the
   same cramped layout, bigger. The row says full-viewport "gives the existing
   ones their room back", and only real width does that.

### 5.3 The ruling: overlay mount, from React state, with the tile's face moved

**Full-viewport is a `position: fixed` overlay mounted from component state,
sibling to `.plane-body`, rendering the focused strip's `DeckFace` at viewport
size. It writes neither `strip.cell` nor `map.plane`.**

The precedent is in the same file. `PlanePanel.tsx:1105-1108` already mounts two
full-surface overlays from plain `useState` — `{matrix && <Matrix …/>}` and
`{composing !== null && <Composer …/>}` — and `plane.css:1192` gives
`.plane-composer` `position: fixed` with the reason written next to it:
"anything prepended to `<body>` must overlay it rather than push it off screen".
Full-viewport is the third instance of a pattern the file already has twice.

Consequences, all satisfied by construction:

- The document is untouched, so exit restores the plane exactly. Nothing to
  undo, nothing to save, no dirty flag.
- `DeckFace` re-lays-out at real viewport width, so the five rows get room
  rather than magnification.
- Enter/leave is a state flip, so P7-V2's "Tab cycles strips at full size" is
  swapping which key the overlay renders — not a re-layout of the plane.
- The compose door stays reachable: `Composer` is already an overlay, so the two
  compose in the ordinary way.

### 5.4 The one hazard this mechanism must dodge — and it is a live bug

**The overlay must REPLACE the tile's `DeckFace` mount for that deck, never sit
on top of it.** `useDeckTileBinding` registers this deck's handler slots —
`setGridEditHandler`, `setLaunchToggleHandler`, `setSoloToggleHandler`,
`setLocatorRepeatHandler`, `registerSampleDoors` — in a `useEffect` keyed
`[browserLink, deck]` **with no cleanup function** (`deckTile.tsx:84-103`). The
slots are per-deck and last-writer-wins. So:

> mount a second `DeckFace` for the same deck → the overlay's registrations
> overwrite the tile's → unmount the overlay → the deps have not changed, the
> effect does not re-run, **and the tile's grid edits are dead** with no visible
> symptom.

`deckTile.tsx:10-11` claims "the 'last mount wins' defect D4-M measured cannot
exist here" — true for *different* decks, false for two mounts of the *same*
deck, which is precisely what a naive full-viewport overlay creates. Rule:
while full-viewport is on, the plane tile for that strip renders its collapsed
face (or nothing), and exactly one `DeckFace` per deck exists at any instant.
§7 R-4 proposes hardening the registration so the rule is enforced rather than
remembered.

---

## 6. THE AUDIT — 99 rows, every one with a target or a reason

Read against `web/src/commands/keymap.ts:105-306`, in its own section order, so
this table diffs line-by-line against the file.

**Status codes**

- **`LIVE`** — already works in WizardMerged today.
- **`RETARGET`** — works, but aims at the wrong thing (deck 0 instead of the
  focused strip). A change of aim, not a build.
- **`BIND`** — the merged verb exists and is reachable; the dispatcher has only
  to call it.
- **`DECLARED-LIVE`** — `GridPanel.handleKey` already implements this chord. The
  keymap row is a *duplicate declaration*, not a dead chord. The dispatcher must
  **not** bind it; K1 reconciles the declaration to the implementation.
- **`PARK-A`** — parked: **no merged feature or verb exists to aim at.**
- **`PARK-B`** — parked: **the verb exists but is dead on the wire** (§1.4c).
- **`PARK-C`** — parked: **not a keyboard chord** (pointer gesture).
- **`PARK-D`** — parked on one host: **host-reserved chord.**
- **`PARK-E`** — parked: **superseded by a merged decision**, the meaning now
  lives on another chord.

### Transport

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 1 | `Space` | global → `strip` | **RETARGET** | `Plane.tsx:636-644 onGridTransport('play'\|'stop')`. Live at `browserKeymap.ts:115-123` but hardcoded to `companionDeck()` = deck 0 |
| 2 | `⌘.` | global → `strip` | **BIND** | `stopDeck(deck)` `companionEngine.ts:743`. Registry-declared (`transport.stop`) but has no `REGISTRY_ACTIONS` entry (`browserKeymap.ts:71-74`), so it binds nothing today |
| 3 | `Return` | global → `strip` | **BIND** | `onGridTransport('restart')` = stop+play, `Plane.tsx:640-643`. Yields to `browserFocus` (Enter = load, `FileBrowserPanel.tsx:211-213`) by context order |

### Session

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 4 | `⌘N` | global → `plane` | **BIND** after P7-L1 · **PARK-D** in browser | `createSession()` `sessionStore.ts:129`. The door is P7-L1's ComposeWindow session UI. Chromium takes `⌘N` before `preventDefault` — bind on `merged` only (§2.5) |
| 5 | `⌘S` | global → `strip` | **BIND** after P7-L1 | `saveSession(session)` `sessionStore.ts:88` for the focused strip's session. ⚠️ **needs a ruling on which document `⌘S` saves** — §7 R-3 |
| 6 | `⇧⌘S` | global → `strip` | **BIND** after P7-L1 | `saveSession` under a new name; P7-L1 owns the name prompt |
| 7 | `⌘O` | global → `plane` | **BIND** after P7-L1 | `openSession(name)` `sessionStore.ts:104` through the plane's `library ▾` popover |

### Undo / Redo

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 8 | `⌘Z` | global | **LIVE** | `browserKeymap.ts:110-113` → `link.emitEvent({type:"undo"})`. Keep unchanged |
| 9 | `⇧⌘Z` | global | **LIVE** | same, `redo` |

### Pattern Scenes

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 10 | `1–8` | compose → `strip` | **RETARGET** | `selectScene(letter, { deck })` `companionEngine.ts:809`. Live for deck 0 at `browserKeymap.ts:126-132`; §4 aims it at the focused strip |
| 11 | `⇧1–8` | compose → `strip` | **PARK-A** | queue-a-scene has no merged verb: `selectScene` carries `immediate` only. `scenesStore`'s `queue` flag rides the dead `patternScene` wire (§1.4c) |
| 12 | `⌥1–8` | compose | **BIND** | `selectScene(letter, { immediate: true, deck })`. **Note:** in `plane`/`strip` this chord is focus-jump per §4; different contexts, both legal |
| 13 | `⌥⇧1–8` | compose → `strip` | **BIND** as plain immediate | "immediate **from start**" has no merged flag; the honest merged meaning is immediate. Reduced deliberately, not silently — the "from start" nuance is PARK-A |
| 14 | `9` | compose | **PARK-B** | scene-edit latch → `sendSceneToggleLatch` `scenesStore.ts:113` → `patternScene` → **unanswered**. Reserved in `strip` per §4 |
| 15 | `0` | compose | **PARK-B** | master mute group → `sendSceneToggleMute` `scenesStore.ts:117` → same dead wire. Reserved in `strip` per §4 |
| 16 | `⌘⇧C` | compose | **PARK-B** | `sendSceneCopyPattern` `scenesStore.ts:138` → dead wire. The `copyPattern` gridEdit op exists in the vocabulary but has no merged handler |
| 17 | `⌘⇧V` | compose | **PARK-B** | `sendScenePastePattern` `scenesStore.ts:143` → dead wire |

### Track Selection & Preview

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 18 | `↑ / ↓` | grid | **DECLARED-LIVE** | `GridPanel.handleKey` arrow lane (`GridPanel.tsx:2721-2805`) |
| 19 | `⇧↑ / ⇧↓` | grid | **DECLARED-LIVE** | `extendTrackSelection` → `gridEdit op:"addTrackToSelection"` (`GridPanel.tsx:2307-2318`) |
| 20 | `Q W E R T Z U I` | compose | **PARK-A** | finger-drum preview has no merged verb. `store/preview.ts` is the file-browser *audition* player and deliberately bypasses the engine (`preview.ts:8-11`) — it cannot trigger a track. ⚠️ also collides with §3.2's `Q/W/E` in `strip`; different contexts, but K2 must keep them apart |

### Track Management

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 21 | `+ or =` | compose | **BIND** after P7-L1 | add audio track — registry `track.add` runs `CommandState.addTrack`, supplied by the host page (`GridPanel.tsx:1412` attaches the bridge). Needs a `REGISTRY_ACTIONS` entry |
| 22 | `⌘T` | global | **BIND** on `merged` · **PARK-D** in browser | same verb as 21. `isReservedShortcut` refuses `⌘T` on every `BrowserLink` today — the false refusal §2.5 fixes |
| 23 | `⌘⇧T` | global | **PARK-A** | MIDI tracks: no merged create-MIDI-track verb |
| 24 | `⌘+` | compose | **PARK-A** | same as 23 |
| 25 | `Delete` | grid | **PARK-A** | `deleteTrack` is in the gridEdit op vocabulary but the merged grid is owner-mode and has no track-topology path (`browserLink.ts:315-322`: only `selectTrack` lands) |
| 26 | `⌘D` | grid | **PARK-A** | `duplicateTrack` — same reason as 25 |
| 27 | `⌥↑ / ⌥↓` | global → grid | **PARK-A** | `moveTrackUp/Down` — same reason as 25 |
| 28 | `⌘⇧O` | compose | **BIND** | open sample dialog → `registerSampleDoors` is live per-deck (`deckTile.tsx:102`, P3.5-E8a); the door exists, the chord does not |

### Grid Navigation

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 29 | `Tab or -` | compose | **PARK-E** | the lane toggle is **gone**: `GridPanel.tsx:2377-2381` says so explicitly — "the old lane toggle (grid↔controls) is gone", `Tab` is next-track. And `-` is claimed by §3.2 (deck switch → `Tab`). The row is stale twice; rewrite its label |
| 30 | `⇧Tab` | global | **PARK-E** → rebind | compose/DJ view toggle. There are no "views" in the merged app — there is a plane and a compose window. §4 gives `⇧Tab` to reverse focus-cycle (P7-N2). `GridPanel.tsx:2387` still forwards `⇧Tab` for the old meaning and now drops it |
| 31 | `← / →` | grid | **DECLARED-LIVE** | `GridPanel.handleKey` cell cursor (`:2776-2798`) |
| 32 | `⇧← / ⇧→` | grid | **DECLARED-LIVE** | same, `setSelectionRange` (`:2799-2806`) |

### Cell Editing

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 33 | `.` | grid | **DECLARED-LIVE** | `GridPanel.tsx:2551-2566` → `gridEdit op:"toggleStep"` over selection or focus |
| 34 | `O` | grid | **PARK-A** | clear-all-parameters: `clearCellParameter` is in the op vocabulary but the merged owner-mode grid implements no clear-all path |
| 35 | `⌥← / ⌥→` | grid | **PARK-E** | cell duration moved to `,` — `GridPanel.tsx:2568-2574` states it: "replaces native option+←/→ on the web surface (arrows are pure navigation here)". Row 35's meaning is live on a different chord |
| 36 | `⌥⇧← / ⌥⇧→` | grid | **PARK-A** | `setPlaybackDirection` exists as an op; no keyboard path and no merged handler |
| 37 | `⌘A` | grid | **PARK-A** | select-all-cells: no merged selection verb spans a track |
| 38 | `⌘C` | grid | **DECLARED-LIVE** | `GridPanel.tsx:2340-2348` → `gridEdit op:"copyCells"` |
| 39 | `⌘V` | grid | **DECLARED-LIVE** | `GridPanel.tsx:2350-2358` → `gridEdit op:"pasteCells"` |
| 40 | `⌘B` | grid | **PARK-A** | duplicate cells — no merged op. ⚠️ **`⌘B` is also live and undeclared** as the DJ browser fold (`DjPanel.tsx:65-81`), on a retired panel. Two claims, one of them invisible to the collision test because the second is not in `KEYMAP` at all |
| 41 | `⌘E` | grid | **PARK-A** | make-owner: `cyclePlaybackMode` reaches owner mode via the track band, not this chord; no merged handler for the chord's op |
| 42 | `⌘R` | grid | **PARK-A** | reverse selected steps — merged `setReverse` (op) is per-owner-cell and is bound to `j` (row: `GridPanel.tsx:2490-2508`); no range-reverse verb |

### Beat Repeat

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 43 | `⌃1–8` | compose → `strip` | **BIND** | `setBeatRepeat(deck, { startStep, length, subdivision })` `companionEngine.ts:722`; the door is `Strip.tsx:797,818` |
| 44 | `⌃⌥1–8` | compose → `strip` | **BIND** | same verb, upper bank of the fused scale (`BR_SCALE`, `Strip.tsx`) |
| 45 | `⌃← / ⌃→` | compose → `strip` | **BIND** | same verb, length scale. `keyForward.ts:60-71` documents Ctrl+arrow as beat repeat's and `GridPanel.tsx:2640` still releases it for a native lane that is gone |

### Pitch, Accent & Step Parameters

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 46 | `ö` | grid | **DECLARED-LIVE** ×2 | `GridPanel.tsx:2440-2465` (grid lane) **and** `focusModel.ts:176-185` (controls lane). Two live handlers, one chord, arbitrated by lane — model as one entry with a lane note, never two rows |
| 47 | `ä` | grid | **DECLARED-LIVE** ×2 | same |
| 48 | `ü` | grid | **PARK-E** | accent cycle is live on **`a`** (`GridPanel.tsx:2490,2515` → `gridEdit op:"cycleAccent"`). `ü` is the stale scoopyloops chord |

### Speed Multipliers

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 49 | `⇧8 (*)` | grid | **PARK-A** | `setSpeedMultiplier`/`setSpeedMode` are in the op vocabulary and driven from the track band; no merged cycle verb and no keyboard path |
| 50 | `⌥*` | grid | **PARK-A** | same |
| 51 | `⇧-` | grid | **PARK-A** | same |
| 52 | `⌥/` | grid | **PARK-A** | same |
| 53 | `⌥+ / ⌥-` | grid | **PARK-A** | `setStepCount` exists as an op, driven from the band; no keyboard path |
| 54 | `⌥⇧+ / ⌥⇧-` | grid | **PARK-A** | same |

### Pattern Shift

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 55 | `⌘[` | global | **PARK-A** | shift-all-tracks: `registry.ts:19-20` records Shift Pattern as waiting on "its deferred reducer increment (MB-1b2)" — never built |
| 56 | `⌘⇧[` | global | **PARK-A** | same |
| 57 | `⌘]` | global | **PARK-A** | same |
| 58 | `⌘⇧]` | global | **PARK-A** | same |

### Paint Mode

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 59 | `⇧Drag` | grid | **PARK-C** | a pointer gesture, not a chord — carries no `Chord` and can never be dispatched. Stays in the map as documentation |
| 60 | `⌥⇧Drag` | grid | **PARK-C** | same |
| 61 | `⌥.` | grid | **DECLARED-LIVE** | `GridPanel.tsx:2599-2624` → `gridEdit op:"paintCell"` over the selection |
| 62 | `⌥⇧.` | grid | **DECLARED-LIVE** | same branch, `ascending: e.shiftKey` |
| 63 | `⌘1–4` | compose | **PARK-A** | pitch interval preset banks have no merged store. ⚠️ also `⌘`-digits are host-reserved (§4) — parked twice over |

### Recording

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 64 | `P` | compose | **PARK-A** | live pattern recording (arm/disarm) has no merged verb |
| 65 | `O (hold, recording)` | compose | **PARK-A** | depends on 64. Note the display string encodes a *mode*, which no `Chord` can carry — the parked reason and the mode both belong in `label` |
| 66 | `Y` | compose | **PARK-A** | the toolbar recorder/take window is not in the merged tree. (The plane's looper `slRecord` is a **different** feature with its own door, `Strip.tsx` REC — do not conflate) |

### Track Quick Actions

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 67 | `⌥A` | grid | **BIND** | mute: `gridEdit op:"toggleMute"` is in the live vocabulary, driven from the track band |
| 68 | `⌥S` | grid | **BIND** | solo: `toggleSoloTrack(trackIndex, deck)` `companionEngine.ts:894`, already wired per-deck at `deckTile.tsx:91-94` |
| 69 | `#` | grid | **BIND** | launch: `toggleLaunch(trackIndex, deck)` `companionEngine.ts:883`, wired at `deckTile.tsx:87-90`. ⚠️ `#` has no stable `code` on a German layout — declare it `{ key: "#" }` per §2.4 |
| 70 | `V` | compose → `strip` | **PARK-E** | "reverse transport" is the deck verb `setReverse` (`companionEngine.ts:729`), which §3.2 puts on `Q`. `V` also collides with rows 97/98 |

### View & Panels

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 71 | `⌘M` | global | **PARK-A** | the Modifiers section fold is a compose-panel affordance with no merged toggle. (`⌘M` also minimises the window on macOS) |
| 72 | `⌘⌥M` | global | **PARK-A** | the modulation system is not in the merged tree |
| 73 | `⌘I` | compose | **PARK-A** | the Master FX sheet is not in the merged tree (P6-2's FX returns are a different surface, and `returnFx` is false in the browser host) |
| 74 | `⌘⇧M` | global | **PARK-A** | same as 73 |
| 75 | `F1–F4` | global | **PARK-A** | FX slot editors — P11-1's "FX 1–4" rows are the ledger's own record that these have no home yet |
| 76 | `⌘= / ⌘-` | compose → `plane` | **BIND** | plane zoom exists: `zoomAtCentre(factor)` `Plane.tsx:508-511` (buttons `:705,711`), and `commit({scale:1,panX:0,panY:0})` `:714` is the reset. A view verb, no document dirty (`mapStore.ts:107-112`) |
| 77 | `Esc` | global | **DECLARED-LIVE** | `ContextMenu.tsx:134` closes menus; `GridPanel.tsx:2416-2434` clears selection then track-selection then declines. Both live; the dispatcher must add the *plane's* Esc (leave full-viewport, §5) at the end of that chain, not the front |

### DJ Mode → focused strip (see §3.2)

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 78 | `⌘⇧1 / 2 / 3` | global | **PARK-A** | "send session to Deck A/B/C" is scoopyloops' deck-load gesture. The merged equivalent is the strip's own `library ▾` / drop (`Plane.tsx:646`) — a strip *is* the deck. No global send verb exists |
| 79 | `⌘⌥3` | global | **PARK-E** | "enable Deck C": in the merged app a deck exists because a strip exists. Superseded by strip creation |
| 80 | `Q / W / E` | dj → `strip` | **BIND** | `Q` `setReverse`+play · `W` `onGridTransport('play')` · `E` `'restart'` — `Plane.tsx:636-644`, `companionEngine.ts:729` |
| 81 | `A / S / D` | dj | **PARK-E** | the deck-B half of the pair; collapsed into row 80 by D-8. `A S D` are **freed, not reassigned** (§3.2) |
| 82 | `R / F` | dj → `strip` | **BIND** as `R` only | hold-to-play; `F` is the freed deck-B half. Needs the keyup lane (§7 R-2) |
| 83 | `U / J` | dj → `strip` | **BIND** as `U` only | tape-reverse hold → `setReverse(deck, on)` on down/up. `J` freed — and `J` is already live in `grid` as the in-cell reverse mark (`GridPanel.tsx:2490-2508`) |
| 84 | `T Y / G H` | dj → `strip` | **BIND** as `T` / `Y` | `setNudge(link, deck, ±d)` on down, `0` on up — `nudgeStore.ts:37`, door `Strip.tsx:838-841`. `G H` freed. ⚠️ `GridPanel.tsx:2339` still yields all four via `isDjNudgeKey` to a lane that no longer exists |
| 85 | `1–4 / 5–8` | dj → `strip` | **RETARGET** | one bank of eight on the focused strip — §4 |
| 86 | `⌘⌥D` | dj | **PARK-A** | "double active deck to the other deck" has no merged verb; with N strips and no A/B there is no "other deck" to mean |
| 87 | `-` | dj | **PARK-E** | switch active deck → `Tab` cycles focus (§4). `-` is freed |
| 88 | `⌥Space` | dj → `plane` | **BIND** | play/stop every deck with a session — a loop over `useCompanion.decks` (`companionEngine.ts:418-419` already walks exactly this set to publish) |
| 89 | `⌥9 / ⌥0` | dj → `strip` | **BIND** | `setBpm(bpm ∓ 1, deck)` `companionEngine.ts:749` |
| 90 | `⌥⌘\`` | dj | **PARK-A** | no playlist exists in the merged tree |

### File Browser (while focused)

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 91 | `↑ ↓ ← →` | browserFocus | **LIVE** | `FileBrowserPanel.tsx:194-210`. Element-level, so it needs no dispatcher — it must only be *left alone* by it (`isTypingTarget` is not enough; the list is a `<ul tabIndex=0>`, `:315`) |
| 92 | `⌥← / ⌥→` | browserFocus | **PARK-E** | "load selected session to Deck A / B" — in the merged app a session loads into a **strip**, via drop or the strip's `library ▾` (`Plane.tsx:646`). No A/B destination exists. ⚠️ §4 gives `⌥`-digits to focus-jump; `⌥`-arrows stay free |

### Musical Keyboard Mode

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 93 | `⌘K` | global | **PARK-A** | `setNoteKeyboardActive` (`keyForward.ts:95-98`) is the flag and **nothing calls it** in the merged tree — the mode can be read but never entered. Un-parks the moment a caller exists |
| 94 | `A W S E D F T G Y H U J K O L P ; '` | noteKeyboard | **PARK-A** | 18 chords, all depending on 93. The mode is unreachable, so every one is unreachable |
| 95 | `Z` | noteKeyboard | **PARK-A** | octave down — depends on 93 |
| 96 | `X` | noteKeyboard | **PARK-A** | octave up — depends on 93 |
| 97 | `C / V` | noteKeyboard | **PARK-A** | velocity — depends on 93 |

### Sample Pads & Chops

| # | keys | ctx → | status | target / reason |
|---|---|---|---|---|
| 98 | `Z / X / C / V` | compose | **PARK-A** | FX pads 1–4 have no merged verb. P11-1's "FX 1–4 need a named interim home" is the same gap seen from the panel side |
| 99 | `⌥Q…⌥I` | compose | **PARK-A** | chop-slot preview: `setChopPoint`/`setChopCount`/`resetChopPoint` exist as ops from the track band; there is no *preview a slot* verb |

### Tally

| | rows | chord slots |
|---|---|---|
| `LIVE` | 3 | 6 |
| `RETARGET` | 3 | 17 |
| `BIND` | 24 | 63 |
| `DECLARED-LIVE` | 12 | 16 |
| `PARK-A` | 42 | 96 |
| `PARK-B` | 4 | 4 |
| `PARK-C` | 2 | 0 (pointer) |
| `PARK-E` | 9 | 14 |
| **total** | **99** | **216** |

`PARK-D` is host-scoped and never a row's only status: rows 4 (`⌘N`) and 22
(`⌘T`) are `BIND` on `merged` and `PARK-D` in the browser companion. They are
counted once, under `BIND`.

**42 of 99 rows have a live or reachable merged verb (6 + 17 + 63 + 16 = 102 of
216 chord slots). 57 rows are parked, every one with its reason above.** That ratio is the honest size of P7-K1/K2/K3: the
dispatcher is a modest amount of code aimed at a keymap that is mostly a record
of a different application.

---

## 7. Proposed follow-up rows

This document changed no source. Everything it found is a row, per §11's
no-orphan rule.

| id | type | item | status | note |
|---|---|---|---|---|
| **R-1** | build | `keymap.ts`: add `chords: readonly Chord[]` + `parked?: string` to `ShortcutEntry` per NAV-SHORTCUTS §2; expand every range row; extend `keymap.test.ts` to collide on *chords* rather than display tokens | todo | the mechanical half of P7-K0 — **P7-K1 is blocked on it**, and it is a pure data edit with no dispatcher attached. `keys` stays untouched so the Help list (when it gets a door) is unaffected |
| **R-2** | build | The dispatcher needs a **keyup lane**: `R`/`U`/`T`/`Y` (hold-to-play, tape-reverse, nudge) are hold gestures whose release must fire. `browserKeymap.ts:155` registers `keydown` only | todo | `keyForward.ts:222-248` documents why the release must travel the same channel as the press (the nudge that stayed bent off-grid). Same hazard, new lane. Belongs in **P7-K1** |
| **R-3** | decide | **What does `⌘S` save on the plane** — the focused strip's session, the `.scoopyMap`, or both? Two documents, one chord | todo | `saveSession` (`sessionStore.ts:88`) and `saveMapAs`/`attachAutosave` (`mapFiles.ts:38,146`) are both live. P7-L1 will surface session save; this must be answered before then or `⌘S` ships ambiguous. A conductor/user call, not a lane's |
| **R-4** | build | `deckTile.tsx:84-103` registers five per-deck handler slots in a `useEffect` **with no cleanup**. A second mount of the same deck (which P7-V1's overlay would create) silently kills the first's grid edits on unmount | todo | found by P7-K0 §5.4. Fix: return a cleanup that clears the slots it set, or gate registration on a mount token. **P7-V1 depends on this** or must guarantee single-mount by construction |
| **R-5** | cleanup | `GridPanel.tsx` has **seven `return "forward"` sites** that hand keys to a root relay unmounted since P8-8 (`App.tsx:129-131`). `:2640`'s comment still promises the native shortcut library stays live | todo | not a behaviour change on its own — the keys are already dropped. It is the comment and the dead branch that mislead the next reader, and K1 will read exactly these lines |
| **R-6** | cleanup | `keymap.ts:16-18` documents `Generated/ShortcutList.swift` (not in this tree) and `npm run protocol:check` (does not exist); `:20-22` names P8-8 as the future dispatcher, which shipped as something else | todo | the header is the first thing a K-series session reads and three of its claims are false. Correct it in the same commit as R-1 |
| **R-7** | build | **The shortcut list still has no door.** `KEYMAP`'s only consumer is its own test — nothing renders it | todo | the ledger names this inside P7-K1; hoisting it as its own row so it cannot be lost when K1 is scoped down. Cheapest honest door: a Help overlay on the plane bar rendering `KEYMAP` with parked rows dimmed and their reason as the title attribute |
| **R-8** | cleanup | `scenesStore.ts` is a complete scene-verb module whose every sender rides `patternScene`, a method no host answers (§1.4c). Its consumers are the retired `≡` panels | todo | either route it to `useCompanion` or mark the module dead at the top. As it stands it is a working-looking API — with a comment naming "hotkeys 9/0" — that a K-series builder will reach for first and ship silence |
| **R-9** | cleanup | `MAX_DECKS = 3` is declared twice: `companionEngine.ts:170` and `stripOps.ts:22`. They agree today | todo | low priority; a divergence would be silent and would mis-size the digit allocation |

---

## 8. What this document does NOT settle

- **Which chords the eight freed deck-B keys (`A S D F G H J` + the second digit
  bank) take on.** They are freed, not spare (§3.2). P7-K2 parks them.
- **P7-N1's live defect.** Clicking into an expanded tile kills `Space` and
  `1–8` plane-wide, because `GridPanel.tsx:2812` claims by default and
  `deckTile.tsx:51-55`'s claim never releases to `null` except on unmount, while
  `browserKeymap.ts:102` drops any claimed event. The mechanism is confirmed
  here; the fix is N1's row and is not restated as a proposal.
- **The `⌘S` document question** — R-3, a user/conductor decision.
- **P7-T3's `gridHidden`/`performOn` citation.** Incidentally measured while
  auditing: both names **do exist**, on the `dj` UiState via
  `TransportPanel.tsx:202,233-235` and `DjPanel.tsx:136,199`, not on
  `GridMetaState`. T3's warning is half right — the fields are real, the type it
  names is wrong. Recorded here so T3 re-measures rather than re-searching.
