# ScoopyDeck v2 — kickoff brief

**For a fresh session.** Everything below was measured on 2026-08-01 against a
working plugin. The root causes are already found; do not re-derive them. Where
a line number is given it was verified at that time — confirm it still points at
the same thing, but trust the *finding*.

Signed law: **D-SL-DECKPLUGIN-01** and **D-SL-DECKPLUGIN-02** (`docs/DECISIONS.md`).
Plugin lives in `shell/plugin/`. Web face is `web/src/plane/PluginDeckPanel.tsx` +
`web/src/plane/pluginDeckMap.ts`.

## STATUS — updated 2026-08-01

The plugin itself is now **committed** (`e79dc67`); it had been living entirely
in a working tree. The four decisions are **answered and signed** as
D-SL-DECKPLUGIN-02 — read that entry before acting on any item.

| § | State | Commit |
|---|---|---|
| §1 PERF write path | **DONE** | `a63795a` |
| §2 master-BPM box + TEMPO switch | **DONE** | `853bd2f` |
| §3 sends (capability + masterSends) | **DONE** | `35d6790` |
| §6 LCM meter | **DONE** — geometry; the data was never broken here | `9e34d9d` |
| §8 keyboard | **PART** — (i) `djSlotIndex` + (iv) OS focus landed; (ii)/(iii)/(v) held for NAV-SHORTCUTS §7 (R-2, R-4) | `7e4f61f` |
| §4 multi-out | **PART** — five buses, and the sends actually emit; the **Live diagnosis is still owed** | `1804250` |
| §5 window persistence | **DONE**; its PERF-density half was **REVERSED** by user ruling — see §5 | `31007c0` |
| §7 tempo morph plumbing | **open** |
| §9 launch quantize across instances | **DONE** — all four steps; signed as D-SL-DECKPLUGIN-03 | `0230141`·`92bbf3b`·`93c3ee8` |
| §10 host automation (replaces the mod system) | **DONE** — 131 params; signed as D-SL-DECKPLUGIN-04 | `8b65b4d`·`5457b8a` |

### What is left, and where to start

- **§7 tempo morph.** The ramps exist in the core and are unreachable because
  the snapshot tables do not carry them. The work is: add `rateMorphFrames`,
  `patternSwitchGlideFrames`, `patternSwitchCut` to the deck-param table and
  `tpMorphEligible` to the track table, emit them from
  `worldFromSession`/`publish`, and wire `CU`. ⚠️ Those tables are **generated**
  (`slengine/generated/*.inc`), so the edit is to the generator input and the
  `params:check` · `worldmap:check` · `trackparams:check` gates all speak to it —
  budget for that, it is most of the risk. Deck TEMPO ramping is the one piece
  that is genuinely new work, not plumbing, and should go last.
- **§9 launch quantize across instances.** Designed and signed
  (D-SL-DECKPLUGIN-03), not built. It resolves against the HOST's ppq, so it
  needs no registry for the common case; §9 carries the four-step build order.
  Start at step 1 (the `launch_at_frame` ABI seam) — it is self-contained and
  headlessly testable. Note it interacts with §5: `PLUGIN_DECK`/`djSlotIndex`
  are both hard-coded to 0, and D1's five-bus layout has no per-deck stems.
- **The two DAW checks nobody can run headless:** Live's multi-out
  instantiation (§4), and whether the `Space` claim D3 signed actually arrives
  (§8). Both need the host.

**Everything below is the original brief.** Where an item is DONE its section
has been updated in place with what was actually found; the rest is untouched.

---

## 0. Orient

Read in this order, then start:

1. `docs/DECISIONS.md` → **D-SL-DECKPLUGIN-01** (the signed shape of this product).
2. `docs/merge/NAV-SHORTCUTS.md` — **required before touching any key binding.**
   Its ruling: *"The dispatcher's first duty is reconciliation, not addition."*
   16 chord slots already collide; 12 more are live in GridPanel and undeclared.
3. This file.

### What is already true (do not rebuild)
- VST3 + AU + Standalone build; `auval` passes; runs in Logic and Ableton.
- Engine is instance-based and RT-safe; two instances render independently.
- Web UI is **embedded** in the binary as a zip; no source-tree dependency.
- State chunk reopens a project **with sound and no editor**.
- PDC is **mode-scoped** and the measured stretch delay is **7200 frames /
  150 ms @48k** — NOT the ~5120/116 ms the older docs estimate. Read it from
  `sl_deck_stretch_latency_frames()`, never hardcode.
- **One tempo authority**: the web owns `syncRatio` while an editor is open;
  `HostSync::pump` passes `writeRatio=false` then (`ScoopyPluginProcessor.cpp`,
  `webOwnsTempo = getActiveEditor() != nullptr`). Do not add a second writer.
- Layout gate exists: `web/tools/browser_plugindeck_test.mjs`, registered in
  `tools/walks.mjs`. It is negative-tested both ways. **Run it after any layout
  change** — three layout regressions shipped before it existed.

### The recurring trap
The plugin face is built from **plane components that assume a strip's
geometry** (`DeckFace`, `GridScenes`, `.compose-window-body`). Mounted
elsewhere they do not error — they resolve `height:100%` / `flex:1 1 auto`
against whatever ancestor is there. Every new plane component mounted here
needs its box supplied explicitly, and a gate assertion added.

---

## 1. PERF commits nothing  ·  **the write path is missing**

**Symptom:** PERF toggles, the locator drag previews, nothing is committed.

**Root cause — two independent gaps, both after the gesture:**
- `setLocatorRange` / `setLocatorRepeat` are **not** in `VERIFIABLE_TRACK_OPS`
  (`web/src/panels/trackOps.ts:25-38` — it has `adjustLocatorStart` /
  `adjustLocatorLength` but not these), so GridPanel's owner-mode fast path
  never applies them and falls to the "Swift does it" branch.
- `BrowserLink`'s `trackEdit` (`web/src/browserLink.ts:394`) has **no arm** for
  either op; they fall to a bare `return { ok: true }` at `browserLink.ts:448`
  — **silently accepted and discarded**. Host-wide: `trackEdit` is not in
  `MergedLink.NATIVE_METHODS`, and there is no Swift behind it in this app.

The gesture chain above the write is fine and needs no work: `DeckViewRow`
toggle → `setMetaFacts({performActive})` → `GridPanel.tsx:390` → pointerdown
`:1748` → move `:1929` (`panels/performLocator.ts`) → up `:2203`
(`resolvePerformRelease`). The document→engine path already carries the fields
(`store/gridProjection.ts:310-312`, `audio/sceneProjection.ts:62-64`,
`audio/worldFromSession.ts:491-493`). This is why the row's ⌊ ⌉ boxes work and
PERF does not — those ops **are** verifiable.

**Fix (cheapest, host-agnostic):** add `setLocatorRange` + `setLocatorRepeat`
reducers to `applyTrackOp` (`trackOps.ts` ~:869) and add both to
`VERIFIABLE_TRACK_OPS` (`:25`). Owner mode then applies and publishes through
the existing `publishOwned` → `applyGridRow` → document → world path. **No new
handler slot, no ABI change.**

**Verify:** drag a locator window in PERF, confirm the loop audibly changes and
survives a scene switch; add a `trackOps` unit test for both ops.

---

## 2. Internal clock  ·  **the clock already works; there is no master BPM to type**

**This is not a transport bug.** The step clock is fully internal already:
`isPlaying && bpm && masterSpeed` is the whole thing
(`NativeAudioEngineCore.cpp:4365-4368` derives `framesPerStep`, `:7652-7666`
advances it every block from the audio callback). `useCompanion.play(deck)`
(`store/companionEngine.ts:1222`) publishes `isPlaying:true` and the deck
free-runs. Nothing external ticks it.

**The actual gap:** `syncRatio` is always ~1, so TP / TS / T are
indistinguishable — there is nothing to stretch *against*.
- `masterBpm` in the plugin's map is written **only from the host**
  (`pluginDeckMap.ts` `setPluginMasterBpm`, called from the `hostTransport`
  event in `PluginDeckPanel.tsx`). It is a **read-only display**; there is no UI
  anywhere to type one.
- `CLK INT` governs **transport only** (`followTransport`), not tempo. With CLK
  INT the deck still resolves its ratio against the DAW's bpm.

**Fix (no engine change):**
1. Add an **editable master-BPM box** beside the `session … · host …` readout in
   `PluginDeckPanel.tsx`. It calls `setMasterBpm(bpm, link)`
   (`state/mapStore.ts:123-129` — already runs `applyTempo`).
2. Gate `setPluginMasterBpm` on an internal-master flag so the `hostTransport`
   event stops overwriting a typed value.
3. Decide whether the tempo source switch is the same control as `CLK`
   (transport) or a second one — **see Decision D2.**

That single number makes `deckTempoIntent` produce a ratio ≠ 1 and TP/TS/T
become audibly different immediately.

**Verify:** session 120, master 140, toggle TP vs TS — pitch must move on TP and
not on TS; `sl_deck_stretch_ready` must read 1 before judging (a cold stretcher
is on its dry path and both modes sound identical).

---

## 3. Sends invisible  ·  **a capability rule written before this host existed**

**Per-track S1–S4** (`panels/trackRowControls.tsx:2780-2806`) are gated on
`caps.returnFx`. `returnFx` is derived from `pluginHosting`, which is true
**exactly when a plugin scanner is present** (`shell/src/SlDispatch.cpp:87-104`).
ScoopyDeck deliberately has **no scanner** (D-SL-DECKPLUGIN-01: no
plugin-in-plugin), so it reports `returnFx:false` → the row vanishes **and**
`worldFromSession.ts:262` zeroes the send values.

The justifying comment says *"a return is either external or a hosted plugin."*
In this host a return is **external via multi-out** — Return 1–4 routed to DAW
tracks and processed by Ableton. That is the architecture we chose, and the
capability model cannot express it.

**Fix:** decouple the two. Either add a `returnFx` that is true when the engine
has return buses regardless of hosting, or give `HostServices` a `hostKind` and
let the plugin answer `pluginHosting:false, returnFx:true`. Then confirm
`worldFromSession` stops zeroing.

**Master sends** are a separate, simpler gap: `MasterRow.tsx:141-160` renders
them, and `MasterRow` **is** mounted by DeckFace's GridPanel — but
`store/gridBackend.ts:325` hard-codes **`masterSends: []`**. There is no
plumbing for deck master-send values into meta at all. Wire it via
`setMetaFacts({masterSends})` from the deck binding.

**Verify:** send levels visible, movable, and audible on the Return buses in the
DAW; `browser_plugindeck_test` gains an assertion that the S-row exists.

---

## 4. Multi-output fails in Ableton  ·  **and 11 buses is too many**

**Ranked hypotheses (untested — diagnose first, in Live):**
1. **The plugin is `IS_SYNTH` with a stereo MAIN INPUT bus enabled by default**
   (`ScoopyPluginProcessor.cpp:25`, `withInput("Record In", stereo, true)`).
   Live is notably strict about instruments carrying a main input. The
   conventional shape is a **sidechain** bus, disabled by default.
2. The ten aux buses are declared **`enabledByDefault = false`** (only bus 0 is
   true). Some hosts only surface buses that start enabled.
3. Live's VST3 multi-out enumeration may reject the mixed layout; try the AU in
   Logic as a control — `auval` already passes, so a Live-only failure points at
   1 or 2.

**Bus count — SETTLED AND DONE.** Now **five: Main + Send 1–4**.

D1 first read "Main + Return 1–4", but the engine says otherwise and the code
won: the **Return lanes carry the wet output of the engine's INTERNAL return
processors**, and this host has none — the legacy internal delay was retired in
P6-3 and hosted plugins are forbidden by D-SL-DECKPLUGIN-01. Four buses of
guaranteed silence. What actually leaves the building is **Send 1–4**; the DAW
track you route one into *is* the return. Re-confirmed with the user 2026-08-01.
Deck (silent unless `djMode && dedicatedOutput`, which **splits the deck out of
Main**) and Cue (a duplicate of Main) are cut.

⚠️ **The bus cut alone was not enough, and this is the part that would have
shipped silent.** The core defaults every return to **host-plugin mode**, where
the send is handed to a hosted effect and its wet summed into main — so in a
host that can never load one, all four sends were consumed by an empty slot.
`setReturnMode` had **no caller anywhere in this tree**. There is now an ABI
door (`sl_return_set_external`) and the processor flips all four returns to
external at engine create, beside the watchdog line. Pinned by
`plugin_processor_test`: with send 1 up, bus "Send 1" peaks 0.354 while 2–4 stay
at 0 — which also proves the lane map is not smearing one send across four.

**Verify:** load in Live, confirm the multi-out variant instantiates and each
declared bus appears as a routable source; keep `auval` green.

---

## 5. Window sizing + the PERF deck view

**Today:** the editor is resizable (`setResizable(true,true)`,
`setResizeLimits(720,480,3000,2000)`) but the size is **never persisted**, and
PERF does not change it.

**Wanted:** resizing reflows; PERF shrinks the window into a classic DJ deck
view with a **reduced** control set.

**The reduction mechanism already exists.** `trackRowControls.tsx:1908`
(`const dj = variant === "dj"`) already hides the cell-tools cluster (`:2154`),
randomize/clear (`:2280`), the compose H row (`:2328`) and choke/voice/stereo
(`:2652`). What is still full-fat at dj density: the DSP band (`:2443`), the mod
slots (`:2762`) and the S1–S4 row (`:2780`).

**PARTLY REVERSED — read this before touching PERF.**

The window half stands (below). The DENSITY half was built and then **removed by
user ruling, 2026-08-01**: *"the PERF button was abused for some view changes we
did not request."*

⚠️ **PERF is a POINTER MODE, not a view.** It arms performative locator dragging
— a drag on a track sets its ⌊ start · length ⌉ window live instead of selecting
cells — and it must change **nothing** about what is on screen. This brief's own
§5 proposed deriving a reduced density from `meta.performActive`; that shipped,
hid the DSP band / mod slots / S1–S4 the moment PERF was armed, and was rejected
on sight in the real host. Do not re-propose it.

What replaced it:
- **The view axis is its own control.** `viewDensity` — the plugin's COMPOSE /
  DECK switch — is the only thing that changes row density, and you pick it
  deliberately. `Density` is back to two levels.
- **PERF MOVED ROWS.** It was beside `GRID` on the view row, and that adjacency
  is part of why hanging a view change on it looked reasonable. It now sits on
  the **sync row beside BR and REV** — the other live gestures that change what
  *plays* without editing the document. The view row is `GRID` alone.
- **The window no longer follows PERF.** There were briefly two persisted sizes
  swapped on the PERF edge, which meant arming a locator drag resized your
  window. One size now.

**Window persistence (unchanged and still wanted):** the editor was resizable
and its size was never written down, so every reopen threw away the arrangement
— in a DAW, where a plugin window is furniture. The size lives on the processor
and rides the state chunk, because a reopened project must give it back and the
web tier is not running when the DAW restores one. Zero means "never set" and
falls back to the built-in default rather than collapsing the window.

**Verified:** the walk asserts PERF is on the sync row, that the view row is
`GRID` alone, and that arming PERF changes the control count by **nothing**
(136 = 136) — the assertion that would catch the coupling coming back. The
locator commit itself is still pinned (§1).

## 6. LCM meter missing  ·  **frozen sentinel + an 8 px box**

`LcmBar` **is** mounted (`plane/deckTile.tsx:312-344`, rendered by DeckFace).
Two causes stack:

1. **Data — NOT A BUG IN THE PLUGIN. Confirmed 2026-08-01, don't re-chase it.**
   `BrowserLink` does stamp those lanes to −1 and never writes them again, but
   **the plugin never runs that pump**: its link is `MergedLink`, whose
   `onHotFrame` (`engineLink.ts:396`) delegates to the NATIVE frame and only
   overlays the two preview lanes. The plugin editor broadcasts real frames at
   30 Hz (`ScoopyPluginEditor.cpp:96,145-152`) and `sl_engine.cpp:1538-1540`
   fills `SL_HF_playheadStepDeck0..2` from `core.deckPlayheadStep`. So the bar
   has live data in the plugin; it was **geometry alone** that made it look
   missing.
   ⚠️ It IS still dead on the **browser companion** (`?host=browser`, which is
   what the walk boots) — the WASM tier publishes no per-deck playhead. That is
   a companion-telemetry gap, not this product's, and it is why the walk asserts
   the bar's BOX rather than its fill.
2. **Geometry — FIXED.** `.strip-lcm` was `flex: 0 0 8px; height: 8px;
   overflow: hidden` with the "LCM" label at `top:-1px` inside it. Measured: the
   label's box ran 700…708 against a padding box of 701…707, so it lost a pixel
   top and bottom, and an 8 px outline reads as nothing anyway. The label is
   centred now, and `.plugin-deck-pane .strip-lcm` is 14 px — scoped to the
   plugin so the plane's saved `cell.h` arithmetic is untouched.

Not a bug: with no session `lcm = 0` and the effect returns before subscribing,
but `lcm` **is** a dep, so it re-subscribes the moment a session arrives.

---

## 7. Tempo morph  ·  **the ramp exists in the core and is unreachable**

This is mostly a **plumbing** job, not new DSP.

| Want | Core support | Status |
|---|---|---|
| per-track multiply glide | `rateMorphFrames` (`NativeAudioEngineCore.hpp:517-522`), `tpMorphEligible` (`:244-248`), exponential ramp `morphFactor = pow(cur/m1, 1/total)` (`.cpp:4468-4520`) | **fully implemented, never set** |
| pattern/scene switch glide | `patternSwitchGlideFrames`, `patternSwitchCut` (`hpp:508-517`) → `sceneGlideFramesRemaining`, `sceneCutAtStep` | **implemented, never set** |
| master/deck tempo ramp | — | **no core mechanism at all** |

Why unreachable: the deck-scope snapshot param table is exactly six names
(`slengine/src/sl_engine.cpp:1408-1416`) and carries none of these; the track
table has no `tpMorphEligible`. So `rateMorphFrames == 0` ⇒ every multiply
change takes the instant path.

`cleanCut` is **dead web state**: `companionEngine.ts:241-249` / `:1402-1405`
and the `CU` toggle (`deckRows.tsx:573`) exist, and **nothing reads it into a
published world** (`WorldOptions` has no such field). What actually governs a
scene switch today is the phase-continuous republish at
`companionEngine.ts:1664-1710`.

**Fix:** add `rateMorphFrames`, `patternSwitchGlideFrames`, `patternSwitchCut`
to the snapshot deck-param table + `tpMorphEligible` to the track table, then
emit them from `worldFromSession`/`publish` and wire `CU`. **Deck tempo ramping
is the one that needs new work** — either a message-thread ratio ramp in
`HostSync`/`applyTempo`, or a smoother around `applyDeckParams`
(`sl_engine.cpp:1108-1123`). Prior design note: `docs/archive/P2-KICKOFF.md:571`.

---

## 8. Keyboard + focus  ·  **one missing prop explains most of it**

**Read `docs/merge/NAV-SHORTCUTS.md` first. Reconcile before adding.**

**Root cause of "focus doesn't stick":** `DeckFace` mounts `<GridPanel>` with
**no `djSlotIndex`** (`deckTile.tsx:293`). Three consequences, all at HEAD:
- `GridPanel.tsx:481` — `keyboardActiveRef` initialises **true** when
  `djSlotIndex === undefined`, so every deck tile answers every key in the
  launch transient (the "NAV-11 disease" its own comment warns about).
- `GridPanel.tsx:663` — the focus **adoption** (bring the ring with the claim)
  is **disabled** for `djSlotIndex === undefined`. The claim moves, the ring
  does not. **This is the reported symptom.**
- `GridPanel.tsx:695` — the cross-deck focus bridge never registers.

**Other confirmed collisions:**
- `ö / ä / Enter / .` are owned by **both** `design/focusModel.ts:174` and
  `GridPanel.handleKey`; they overlap in the `lane==="controls" && adjust &&
  !press` case and both run.
- `Space` and `1–8` act unconditionally on **deck 0** in
  `commands/browserKeymap.ts:112-134`, while each tile has its own
  `setTransportHandler`. (Coincidentally correct in the plugin, since
  `PLUGIN_DECK = 0` — do not rely on it.)
- No **keyup lane**: `browserKeymap.ts:155` registers `keydown` only, so hold
  gestures can never release (NAV-SHORTCUTS §7 R-2).
- `useDeckTileBinding`'s handler registrations have **no cleanup** (§5.4 / R-4):
  two mounts of one deck silently kill the first's edits.

**Plugin-specific — the WebView never takes OS keyboard focus.**
`ScoopyPluginEditor.{h,cpp}` has **no** `setWantsKeyboardFocus`, no
`grabKeyboardFocus`, no `keyPressed`. The DAW keeps first responder until the
user clicks inside the webview, and any host click takes it back with nothing
reclaiming it. `PluginDeckPanel`'s `claimKeyboard(PLUGIN_DECK)` sets only the
*web-internal* claim — it cannot grant OS focus.

**Fix, in order:** (i) pass a real `djSlotIndex` from `DeckFace` — this alone
fixes the double-fire and the ring; (ii) route `browserKeymap`'s
`playPause`/scene verbs through the **claimed** deck; (iii) release the claim on
pointerdown outside any tile (§8 plane-wide swallow); (iv) add
`setWantsKeyboardFocus(true)` + `grabKeyboardFocus()` on `visibilityChanged` /
`mouseDown` in `ScoopyPluginEditor`; (v) add the keyup lane.

**(i) and (iv) are DONE (2026-08-01).** `DeckFace` takes an optional
`djSlotIndex`; ScoopyDeck passes **0** (one deck = the first slot, unambiguously)
and the plane keeps `undefined` deliberately — it has no fixed columns, so there
is no arrow ring to register with. That re-enables focus ADOPTION
(`GridPanel.tsx:663`), which is the reported symptom. The launch-transient
default at `:481` is unchanged: `undefined` and `0` both start active, which is
what a single-deck host wants. `ScoopyPluginEditor` now sets
`setWantsKeyboardFocus(true)` and reclaims on both `mouseDown` (the user came
back) and `visibilityChanged` (the window just opened — requiring a click first
is itself the "shortcuts don't work" report). D3 makes this a **prerequisite**,
not a nicety: without OS focus the `Space` claim it signed cannot fire at all.

**(ii), (iii) and (v) are still open, and they are not a plugin job.** Each one
changes chords that the **plane** also uses, so NAV-SHORTCUTS §7's reconciliation
comes first — (v) is already filed there as **R-2**, and the no-cleanup hazard
behind the double-registration is **R-4**. Doing them from inside this brief
would be exactly the "addition before reconciliation" its own ruling forbids.

**How to review shortcuts for a plugin** (the user's question): there is no way
to enumerate them from the host — a DAW claims keys before the plugin sees them
(Live and Logic both take `Space`). So the review has to be: the
NAV-SHORTCUTS table as the declared surface, plus a **decision about which
chords ScoopyDeck deliberately does NOT claim** and lets fall through to the
DAW. **See Decision D3.**

---

## 9. Launch quantize ACROSS INSTANCES  ·  **on the host's clock**

**Rewritten 2026-08-01, signed as D-SL-DECKPLUGIN-03.** The original section
proposed a shared registry; D4 rejected it and rescoped this to multi-deck in one
instance. The user then asked for cross-instance quantize anyway — and the honest
answer is that joint launching never needed a registry. It needed a shared
CLOCK, and a DAW already is one.

### Why this works with no IPC

Every instance, every format, receives the **same `ppqPosition`**, sampled by the
same audio thread on the same block boundaries. Two instances that independently
resolve *"launch at ppq X"* land on the same sample. Nothing is shared, nothing
races, Bitwig's sandbox is irrelevant. `hostAlignedStartStep()`
(`ScoopyPluginProcessor.cpp`) already does half of it — it derives the deck's
entry step purely from ppq.

⚠️ This does **not** contradict D4, and the distinction is load-bearing: D4
rejected instances *observing each other's state*. This is instances
*independently agreeing on an external clock*.

### The quantum model

FIXED (beats · 1/2/4/8 bars) and MY CYCLE (the deck's LCM length) resolve
identically — the boundary is the next multiple of that length **on the host
grid**. Anchoring the cycle to the host rather than to when you pressed play is
what makes two decks of equal cycle length phase-lock for free.

### The one case that needs shared state (amends D4)

Naming *another instance's* cycle. B must know A's cycle length and phase anchor;
the host clock cannot supply that. A process-wide lock-free record carries
exactly `cycleLengthPpq · anchorPpq · playing · name` — four fields for one
question, not a general mirror.
⚠️ **PER PROCESS.** Bitwig sandboxes each plugin, and a VST3 will not see an AU.
A named reference that is not in this process must **fall back to the host grid
and say so on screen** — never wait forever for a deck that cannot appear.

### Precision: it resolves in processBlock, not the pump

The 40 Hz pump lands up to **25 ms** late, which flams a downbeat. The core
already shows the correct shape and it is worth copying exactly:

> `requestQuantizedLaunch` (`NativeAudioEngineCore.hpp:1589`) does the expensive
> part AHEAD on the message thread — the deck is republished `active +
> launchArmed` with `snapshot.startStep` set — then arms with a **single
> atomic**, and the boundary is resolved **inside `render()`**. Nothing
> allocates on the audio thread and there is no UI-thread polling jitter.

A host-grid launch is that same door with a boundary the processor computes from
ppq, so it needs a seam that takes an absolute engine **frame** rather than a
reference deck.

### Build order — ALL FOUR DONE (2026-08-01)

1. ✅ **`sl_deck_request_launch_at_frame`** + `requestLaunchWithLeadIn` in the
   core (`0230141`). ⚠️ The resolver's PLACEMENT is the whole feature: it first
   landed after the master-gain stage, i.e. after `core.render`, and every launch
   fired exactly 512 frames late — the block-accurate behaviour that was
   rejected at design time. It must run immediately before `core.render`.
2. ✅ **`armHostQuantizedLaunch(quantumBeats)`** (`92bbf3b`). It runs on the
   MESSAGE thread, which is only sound because `capture()` stores ppq and the
   engine frame as one anchored PAIR — so a boundary computed from a stale
   snapshot is still exact. That pair is now under a **seqlock**; as two relaxed
   atomics a torn read put the launch a block off.
   ⚠️ It reads `sl_engine_sample_rate`, not `getSampleRate()` — the latter is set
   by JUCE's format wrapper, so it is 0 in every headless context.
3. ✅ **`Q` in the header beside CLK and TEMPO** (`93c3ee8`), default `cycle`
   (the donor's own), persisted per instance in the chunk. ⟳ takes an OVERRIDE
   rather than a behaviour change, because the deck rows are shared with the
   plane. The scale is reused whole from `audio/launchQuantum.ts` — its numbers
   are STEPS (16ths), so "16" is a bar of 4/4.
4. ✅ **`PeerRegistry`** — four fields, one question. `auto` on the `cycle`
   quantum resolves to the lowest-slot PLAYING peer (D-SL-QUANTUM-01's order,
   applied across instances), and falls back to this deck's own host grid when
   there is none.

**Verified headlessly, both claims:** `sl_host_launch_test` arms at frame 5000
(deliberately not a block multiple) and the first audible frame is 5000 — two
engines sharing no state, armed at 7777, fire at 7777 with a spread of 0 frames.
`plugin_processor_test` §1d runs two processors against one fake playhead and
checks B waits on A's cycle to the frame.

### What is left

- **The per-process limit is real and permanent**, not a rough edge: Bitwig
  sandboxes each plugin, and a VST3 cannot see an AU. Both degrade to the host
  grid and the header says which — that is the design, not a gap.
- **In a DAW, none of it bites without a running playhead.** Everything resolves
  against host ppq, so a stopped transport means "no grid to wait on" and the
  deck plays now. Correct, and worth knowing before testing.
- **Untested in a real host.** Every claim above is headless.

## Decisions — ANSWERED 2026-08-01 · signed as **D-SL-DECKPLUGIN-02**

All four are law now; read the full entry in `docs/DECISIONS.md` before acting on
the item it governs. Summary:

- **D1 — Five buses: Main + Return 1–4.** Deck and Cue are **cut** (Cue duplicated
  Main; Deck read silent and enabling it *removed* the deck from Main). The 4 mono
  **send** buses stay. Amends DECKPLUGIN-01's bus line. §4 keeps only the Live
  diagnosis.
- **D2 — Two switches.** `CLK HOST/INT` governs **transport only**, unchanged. A
  **second** control picks the master-BPM source (host vs the typed box). §2 builds
  both.
- **D3 — ScoopyDeck claims `Space`** while the WebView holds OS focus; click-out
  releases. Accepted cost: best-effort only — hosts that eat `Space` first win, so
  it must never be the only way to stop audio. Makes §8's `grabKeyboardFocus` work
  a **prerequisite**, not a nicety.
- **D4 — One instance, N decks.** No cross-instance registry. §9 is rescoped to a
  multi-deck UI/routing job on top of `sl_deck_request_quantized_launch`. **Bitwig
  no longer matters** — its sandbox only broke the registry.

## 10. Host automation  ·  **DONE 2026-08-01** — the DAW is the modulation system

Signed as **D-SL-DECKPLUGIN-04**; read that entry before touching any of it.

**The question this answered:** the donor's M1–M4 modulation bank never came
across (`modChannel` is one of the 48 unanswered commands; parked as
NAV-SHORTCUTS PARK-A). Rather than port four channel types, a 28-op protocol
command and an arm-to-map routing UX, ScoopyDeck exposes the mod TARGETS as host
parameters and lets the DAW's LFOs and automation lanes be the sources.

**What shipped:** 131 parameters — 16 tracks × 8 targets (pitch, volume, pan,
tone, sends 1–4) + deck transpose/texture + master level. `auval` reports "131
Global Scope Parameters". All are ADDITIVE OFFSETS, neutral at 0: the web UI
keeps owning base values, the host owns only its contribution, so there is no
two-writer problem and an idle lane is bit-identical to no lane.

**The seam, and why it is not where you would look.** Do NOT inject at the
donor's five old LFO application sites. The core's per-track **base-ramp
composition** (`renderSequencerFrames`, `NativeAudioEngineCore.cpp` ~4870) was
already doing the hard parts — composes once per block, glides over 4 ms so
nothing zippers, and every downstream consumer (varispeed voices, RubberBand
voices, the send taps) already tracks a moved lane, so an offset reaches RINGING
voices. A host offset is **one added term** in that target. Deck transpose was
likewise already an additive sum in `pushSpectralParams`.

**The new ABI family** — `sl_track_mod_*`, `sl_deck_mod_*`, `sl_master_set_mod`
— is **the one parameter family an audio thread may write** (plain relaxed
atomics, no republish). `processBlock`'s thread law in
`ScoopyPluginProcessor.h` is amended to permit exactly it, and the push is per
BLOCK on purpose: a 6 Hz LFO resampled at the 40 Hz pump arrives as a staircase.

⚠️ **Idle must stay bit-identical**, and this is not a performance nicety — the
DSP characterization gates assert exact sample values through that same
composition loop. A per-deck nonzero-lane counter skips the mechanism whole;
`sl_track_mod_test` renders two engines and compares every sample to prove it,
including after an offset has been set and returned to zero.

⚠️ **The core is editable** and older comments say otherwise. `engine.lock.json`
pins only `vendor/scoopy/engine/*` + ThirdParty; its `_doc` says ScoopyLoops/
moved in-tree at the P3-0 flip and "this tree is their writable home". Keep core
edits ADDITIVE so the pinned v2 wrapper still compiles. The stale "forbidden to
edit" banner atop `slengine/src/sl_engine.cpp` is corrected.

**State chunk is v3** (sparse map of non-default offsets). The bump is
deliberate: an older build handed a v3 chunk refuses it, rather than loading the
project with every offset silently dropped and overwriting the user's file on the
next save.

**What host automation cannot replace** (in the decision entry, and not
regressions to chase): grid/LCM-locked LFO phase, step-triggered MSEG envelopes,
audio-rate `freeRate` FM, and four sources summing into one target. Those need an
in-plugin modulator, which is a different feature.

**Still owed — the real-host pass nobody can run headless:** draw an LFO on
`T01 Pitch` in Live or Logic and confirm it sweeps, and that an idle lane changes
nothing.

## Suggested order

1. §1 PERF write path — small, self-contained, unblocks the feature you can see.
2. §2 master-BPM box — no engine change, unblocks **testing TP/TS at all**.
3. §3 sends (capability decouple + masterSends plumbing).
4. §6 LCM meter (data + geometry).
5. §8 keyboard — start with the `djSlotIndex` prop; reconcile per NAV-SHORTCUTS.
6. §4 multi-out diagnosis in Live (needs D1).
7. §5 PERF deck view + window persistence.
8. §7 tempo morph plumbing (ramp already exists); deck-tempo ramp last.
9. §9 cross-instance (needs D4).

## Gates for every step

`ctest --test-dir build` · `cd web && npm run typecheck && npm test` ·
`node tools/browser_plugindeck_test.mjs` · the drift gates
(`webdist:check schema:check nativemethods:check params:check check:tokens`) ·
`auval -v aumu ScDk Scpy` · `npm run bundle` **last** before `git add`.
⚠️ `engine:check` fails on a vendored file nobody here touched — pre-existing.
⚠️ `pluginval` is **not installed**; install it or state that it is unrun.
