# ScoopyDeck v2 — kickoff brief

**For a fresh session.** Everything below was measured on 2026-08-01 against a
working plugin. The root causes are already found; do not re-derive them. Where
a line number is given it was verified at that time — confirm it still points at
the same thing, but trust the *finding*.

Signed law: **D-SL-DECKPLUGIN-01** (`docs/DECISIONS.md`). Plugin lives in
`shell/plugin/`. Web face is `web/src/plane/PluginDeckPanel.tsx` +
`web/src/plane/pluginDeckMap.ts`.

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

**Bus count.** 11 was mapping the engine's useful lanes, not a product
decision: Main, Deck, Cue, Send 1–4, Return 1–4. Two are known-questionable —
**Deck reads silent by design** (per-deck lanes fill only when
`djMode && dedicatedOutput`, and enabling that **splits the deck out of Main**),
and **Cue currently duplicates Main**. **See Decision D1.** Recommendation:
Main + Return 1–4 (+ Deck once its semantics are settled) = 5–6.

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

**Fix:** extend the variant into a **third level** — `"compose" | "dj" |
"perform"` on `GridSource.density` (`GridPanel.tsx:285`), add `METRICS.perform`
(`:289`), and gate `:2443` / `:2762` / `:2780`. Drive it off `meta.performActive`
so **PERF *is* the reduced view** rather than a separate switch (it is currently
read only at `:390` for pointer routing and never influences what renders).
Then have the editor `setSize()` on the PERF edge and persist width/height in
the state chunk.

**Verify:** `browser_plugindeck_test` at two viewport sizes plus a PERF toggle,
asserting the control count drops and nothing overflows.

---

## 6. LCM meter missing  ·  **frozen sentinel + an 8 px box**

`LcmBar` **is** mounted (`plane/deckTile.tsx:312-344`, rendered by DeckFace).
Two causes stack:

1. **Data.** It reads `HotFrameLayout["playheadStepDeck" + deck]`.
   `BrowserLink` stamps those lanes to **−1** in its constructor
   (`browserLink.ts:141-149`) and its rAF pump (`:611-627`) never writes them
   again — so `frac` is 0 forever. The native emitter *does* fill
   `SL_HF_playheadStepDeck0..2`; in the plugin, confirm whether BrowserLink's
   pump is overwriting the native frame. Options: write the lanes in
   `browserLink.ts:617`, or point `LcmBar` at the per-deck DJ telemetry
   (`djTrackStepD<d>T0`) the deck grid already reads.
2. **Geometry.** `.strip-lcm` is `flex: 0 0 8px; height: 8px; overflow: hidden`
   (`plane/plane.css:544-552`), and the "LCM" label is absolutely positioned at
   `top:-1px` inside it — **clipped**. An 8 px empty outline reads as "missing".
   Raise to ~12–14 px for the plugin, or drop `overflow:hidden` for the label.

Also: with no session, `lcm = 0` and the effect **returns before subscribing**
permanently (`lcm` is a dep) — only bites the empty-deck case.

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

**How to review shortcuts for a plugin** (the user's question): there is no way
to enumerate them from the host — a DAW claims keys before the plugin sees them
(Live and Logic both take `Space`). So the review has to be: the
NAV-SHORTCUTS table as the declared surface, plus a **decision about which
chords ScoopyDeck deliberately does NOT claim** and lets fall through to the
DAW. **See Decision D3.**

---

## 9. Cross-instance communication

All instances of one binary live in **one process** (proved: two processors
render independently in `plugin_processor_test`). So this is a **shared
registry**, not IPC.

**Shape:** a process-wide lock-free table, one slot per instance, single
producer per slot:
`instanceId · engineTimeSamples · playheadStep · lcmSteps · bpm · syncRatio ·
playing · currentScene · queuedScene`.
`engineTimeSamples` is the monotonic anchor that makes "where is deck B in its
cycle *now*" answerable. **LCM is a web-tier concept** (`lcmForScene`), so the
web pushes `lcmSteps` on session/scene change and native fills the fast fields.

**Limits to state up front:** per-binary (a VST3 and an AU instance will not see
each other); **Bitwig sandboxes each plugin into its own process**, which breaks
a shared registry entirely and would need real shared memory.

**The fork — Decision D4.** A registry gets *information* across instances but
**never sample-accurate joint launching**: instance B cannot schedule inside
instance A's audio callback. The engine already supports **3 decks in one
engine** with `sl_deck_request_quantized_launch(deck, refDeck, steps)` resolved
*inside* the audio callback, sample-accurately, and multi-out already gives each
deck its own bus. If the goal is "launch B exactly on A's cycle boundary", one
instance with N decks delivers that today; N instances never quite will.

---

## Decisions needed (blocking their items)

- **D1 — Output buses.** Keep 11, or cut to Main + Return 1–4 (+Deck)? And what
  should the **Deck** bus carry, given enabling `dedicatedOutput` **removes the
  deck from Main**? (§4)
- **D2 — Tempo source vs transport source.** Is `CLK HOST/INT` one switch
  governing both, or two (tempo master ≠ transport master)? All four
  combinations are musically real. (§2)
- **D3 — Key claiming.** Which chords does ScoopyDeck claim, and which fall
  through to the DAW? `Space` is the sharp case. (§8)
- **D4 — Multi-deck shape.** Registry across instances, or one instance driving
  N decks? Decides whether §9 is a registry or a multi-deck refactor. Does
  **Bitwig** matter? (§9)

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
