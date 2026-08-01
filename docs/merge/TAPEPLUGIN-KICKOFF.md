# ScoopyTape — the looper-strip plugin · kickoff brief

**For a fresh session.** Written 2026-08-01 from a full read of the tape tier,
the ScoopyDeck plugin spine and the donor. Line numbers were verified on that
date — confirm they still point at the same thing, but **trust the finding**.

The eight decisions in "The ground" are answered by the user and are the design
law this brief rests on; the still-open ones are in `PARALLEL-PROTOCOL.md` §10d.

Companion documents: `docs/merge/LOOPER-DESIGN.md` (the 2026-07-25 ruling that
the looper IS the tape tier — its settled facts are assumed here, not repeated),
`docs/merge/DECKPLUGIN-V2-KICKOFF.md` (the spine this reuses), `docs/DESIGN.md`
(binding on every control below), and — **read this one, it was missed on the
first pass** — `../scoopyloops/docs/plugins/PLUGIN-DESIGN-SYSTEM.md`, the design
law for the whole Scoopy PLUGIN LINE. See "The plugin line" below.

## STATUS — 2026-08-01

| § | State | Commit |
|---|---|---|
| §1a spine made product-neutral | **DONE** | `6806f6e` |
| §1b the plugin target + gate | **DONE** | `a49a4a6` |
| §1c the `plugintape` web face + walk | **DONE** | `f4650a2` |
| §2–§8 | **open** |

**§1 is closed.** `Scoopy Tape` builds AU + VST3 + Standalone, `auval -v aumf
Tape Scpy` passes clean, and the face does real work: record the DAW input into
a slot, hear it loop in the same block, scrub it, drag the loop brace, ride
level and a signed rate, flip between the 8 tapes. Verified at HEAD: ctest 47/47
· vitest 1828/1828 · both plugin walks green on webkit and chromium · all ten
drift gates green.

### What §1 owes, and what it does NOT claim

- ⚠️ **A real-host check is owed.** The walk boots `?host=browser`, where
  `slTape` reaches `BrowserLink` and answers nothing — so the walk proves the
  BOX, never the sound. Nobody has yet put this plugin on a track in Logic or
  Live, fed it audio and pressed REC. **That is the next thing to do, before
  any §2 work**, and it is exactly the class of gap CLAUDE.md's four rules
  exist for.
- **Nothing persists.** A DAW project saved now gives back an empty plugin
  (§3).
- **Unbuilt verbs are ABSENT from the face, not disabled** — rule 7. The walk
  asserts zero disabled controls on screen so that stays true. The face
  therefore looks smaller than the sketch below; the sketch is the target, §1c
  is what reaches an engine call today.

---

## 0. Orient

1. `docs/merge/LOOPER-DESIGN.md` — why the looper is a tape and not a grid
   track. Its resolution (§"TWO playback engines") is the premise here.
2. `docs/DECISIONS.md` → **D-SL-DECKPLUGIN-01/-02** — the signed shape of the
   *first* plugin. Not binding on this one, but it is the precedent every
   deviation below is deviating *from*.
3. `docs/DESIGN.md` — read before drawing a single control.
4. This file.

### The headline finding

**The looper engine is already built.** `slengine/src/sl_tape.{h,cpp}` is, in
its own header's words, *"the looper, the recorder and the file player — one
object, different fills."* Record, free-or-synced loop, varispeed, Signalsmith
time-stretch, turntable scrub, overdub and crash-safe WAV takes all exist and
are wired C++ → `SlDispatch` → React today.

So this product is **not an engine project.** It is: a plugin wrapper, a face,
and five genuinely-new capabilities (§4 HD waveform · §5 scrub styles · §3
snapshots · §6 the quick multiply gesture · §7 the export verb). Budget
accordingly, and **check whether a thing is present-but-unjoined before building
it** — that is the pattern PARALLEL-PROTOCOL §10c found three times in one run.

---

## What is already true (do not rebuild)

### The tape tier — `slengine/src/sl_tape.{h,cpp}`

| | |
|---|---|
| 8 tapes | `kMaxTapes = 8` (`sl_tape.h:43`) — **this is the 8-snapshot bank, already sized** |
| storage | chunked, `kTapeRecordCapBytes = 256 MB`/tape (`:52`) ≈ 11 min 39 s stereo @48k |
| states | `TapeState { idle, looping, oneShot, recording }` (`:63`) |
| record sources | `RecordSourceKind { deviceInput, mainMix, channelBus }` (`:77`) |
| loop | a **region** (`loopEnabled/loopStart/loopEnd`) under a seqlock, not a second buffer; wrap is gapless with fractional carry |
| record→loop | **Law C-3**: the same chunks become the playback buffer, no copy, no file round-trip, loop starts in the SAME block |
| overdub | SUM / REPLACE in place at the playhead, live input also summed to output ("hear yourself"), each pass drains its own stamped take. INSERT deliberately absent |
| varispeed | signed rate clamped `[1/16, 16]`, 10 ms one-pole (D-WZ-RAMP-01), **bit-exact identity path** reachable by dragging (snap at 1e-6), reverse = negative rate (`sl_tape.cpp:714`) |
| scrub | gap-derived turntable scrub (`sl_tape.cpp:623-638`): control posts only *where the finger is*, render derives `want = clamp(gap/frames, -4, 4)` (`:627`) and one-poles it. Raised-cosine gain ramp on release. Scrubbing a STOPPED tape sounds; scrubbing a RECORDING tape is refused. Release arms a cue (D-WZ-SCRUBCUE-01) |
| stretch | per-tape `NativeBusStretcher` (`sl_tape.h:544`), lazily allocated + **async-warmed** |

⚠️ `pubScrubRate` (`sl_tape.h:132`) is published for the UI and **nothing reads
it yet** — §4's display wants it.

### The stretcher — `ScoopyLoops/NativeBusStretcher.hpp`

Standalone (includes only its own header), RT-safe, channel count is a
`configure()` argument. It knows nothing about decks or grids, which is why it
drops into a tape unchanged.

- **Texture bank**: 6 nodes, windows `{25, 60, 120, 240, 480, 960} ms`
  (`kBusTextureBlockMs`, `:43`), `setTexture(0..1)` (`:102`) morphs with an
  equal-power crossfade. **Small windows are grainy/robotic; 480/960 ms is
  Paulstretch territory.** This is the nearest existing thing to a "grain"
  character and §5 should reach for it before inventing DSP.
- Ratio bounds: `kBusStretchMinRatio = 0.25` (`:23`, 4× speed-up — sized for
  scratch), `kBusBrowseMaxRatio = 4096.0` (`:31`, effectively **freeze**).
- Creative layer already present: `setTranspose`, `setWarp`, `setWarpFocus`,
  `setPhaseChaos`, `setSpectralBlur`, `setAir`, `setFormant`, `setTilt`,
  `setGestureTarget/Shape`, `setCrossMod`, `setModExternal` (host-LFO input,
  **plugin-only** — nothing in the app feeds it).

### The wire — `shell/src/SlDispatch.cpp`

`slTape` already answers: `setSource` (`:340`) · `setLevel` · `setMute` ·
`setMonitor` · `setSend` · `setDrive` · `trigger` (`:392`) · `seek` · `setLoop`
(`:400`) · `setRate` (`:406`) · `setTempoMode` (`:410`) · **`scrubBegin` /
`scrubTo` / `scrubEnd`** (`:418-423`) · `overdubStart` (`:424`) / `overdubStop`
(`:449`) · `info` (`:460`) · `waveform` (`:469`). `slRecord` start (`:585`) /
stop (`:618`); `slTakes` list/delete/reveal.

HotFrame already carries `slTapePlayhead0..7`, `slTapeState0..7`,
`slTapeCap0..7` (`web/protocol/schema.ts`) — **the display's fast lane exists.**

### The document — `web/src/persist/mapDocument.ts:48`

A `kind:'tape'` strip element already persists `{index 0..7, takeRef, stereo,
loop{enabled,start,end}, rate (signed), bpm, syncToMaster, tempoMode,
pulseRelation, launchRef}` — including the **8-value pulse relation**
(`:81`: `auto·1:3·1:2·2:3·1:1·3:2·2:1·3:1`).

### The tempo law — web tier, not the engine

The engine has **no master tempo**; it speaks ratios and frames only. The law
lives in `web/src/persist/tempo.ts`: `inferTapeBpm` (`:149` — snaps a raw beat
count to the nearest power of two in log space and returns **null** if >20% off
any, the honesty guard), `tapeEffectiveRate` (`:184` — sync owns the
*magnitude*, the hand keeps the *sign*, so reverse survives sync),
`mapTapeRateOps` (`:201`). Pulse relations are golden-pinned against the donor
in `web/src/panels/djMix.ts`.

### The plugin spine — `shell/plugin/`

Reusable as-is: `EmbeddedWeb` (webdist zipped into the binary; a zip and not
loose BinaryData because vite content-hashes filenames), `HostSync` (RT capture
into relaxed atomics + a **40 Hz timer on the PROCESSOR** so it survives a closed
editor; `masterBpm == 0` follows the host, `> 0` is an internal master), the
state-chunk journal (gzip: `"SCDK"` magic + JSON header + raw float32 PCM),
`PluginBackend` (per-face settings, **shared** takes library at
`WizardMerged/Takes` — an isolated library is what made `session ▾` list
nothing), and the five-lane bridge (`slCommand` · `slParam` · `slHotFrame` ·
`slEvent` · `slUiState`).

⚠️ **`withRenderDetached()` is still caller-less.** Declared
`ScoopyPluginProcessor.h:188`, defined `.cpp:304`, Dekker half at `.cpp:193`. It
was written because `sl_tape_load`/`sl_tape_insert` **allocate and replace
render-visible storage**. Every snapshot load in §3 is its first real user — use
it, do not invent a second guard.

### The export machinery — `host/src/`

`wizard::wav::Writer` (`WavWriter.h:37`) is **JUCE-free and platform-free on
purpose** (so a future WASM build can reuse it verbatim): provisional header,
size fields rewritten every ~0.5 s flush quantum, exact patch on clean close, so
a SIGKILL leaves a parseable file. RF64 past 4 GB. BWF `bext` carries the Law
C-2 engine-sample stamp; a `.wav.json` sidecar carries `bpmAtStart`.
`RecordService` drains on a background thread behind `TakeDrainSource`.

⚠️ **There is no offline/faster-than-realtime bounce anywhere in this tree.**
Everything on disk today is a realtime drain of a live capture. §7 is the first
non-realtime write.

---

## The ground — decisions answered by the user, 2026-08-01

These are the answers to the eight questions posed at kickoff. **They are the
premise of every section below.** Where one contradicts ScoopyDeck's precedent
it is deliberate and the reason is given.

**A1 — A NEW effect plugin, not a second face of ScoopyDeck.**
Its own CMake target (working name "Scoopy Tape"), `IS_SYNTH FALSE`, stereo
in → stereo out, new `PLUGIN_CODE` and `BUNDLE_ID`, sharing the `shell/plugin`
spine. *Why not a second face:* ScoopyDeck is `IS_SYNTH TRUE` with a five-bus
map and a `"Record In"` input bus that Live is already suspected of disliking
(DECKPLUGIN §4 hypothesis 1); changing a shipped plugin's buses changes its ID
and breaks saved projects. A looper is an insert effect and should say so.

> **CONFIRMED AND SETTLED 2026-08-01**, re-asked once `~/xpert/plugins/` came to
> light, because that raised a third option this question never offered: its own
> repo on the Pulsar template. Ruling: **it stays in `apps/scoopy`** — see "The
> plugin line" for the reasoning and the two other deliberate divergences.
> Name and code are settled: **"Scoopy Tape", `PLUGIN_CODE Tape`**, claimed from
> the line registry (entry owed there), `BUNDLE_ID com.scoopyloops.scoopytape`.

**A2 — "Pulsar" meant the design system, not the grain engine.**
The binding rule is `docs/DESIGN.md` + `plane.css` tokens. The DSP core's
pulsar/grain mode (`NativeAudioEngineCore`) is **not** thereby in scope; it
stays in "Later qualities" as an option.

**A3 — Two capture-length modes, both in scope.**
(i) **Free + quantized stop**: free length when sync is off or the host
transport is stopped; when synced and the host is running, record-stop **rounds
to the nearest beat/bar** so the loop is in time immediately.
(ii) **Pre-armed fixed length**: the length is set up front **using scoopy's
typical step-counter idiom** (the `Stepper` vocabulary / step counts, as the
grid states lengths) and recording auto-stops on the boundary.
Retroactive "grab the last N bars" was **not** chosen — it stays a later
quality.

**A4 — An 8-snapshot system, and presets hold all eight.**
One display; flip between 8 snapshot slots to record into a fresh one or reload
a previous one. This maps 1:1 onto `TapeBank`'s existing 8 tapes. **A preset
system is therefore in scope** — a preset stores all 8 snapshots, not just DAW
project state.

> **AMENDED 2026-08-01, once the plugin line was found.** This is not a new
> idea: 8 slots is **the Scoopy plugin signature** (PLUGIN-DESIGN-SYSTEM §5),
> already shipping in Spectral FX, Trombone and Pulsar. §3 therefore CLONES the
> established shape — `ValueTree "SNAPSHOTS"` with `SLOT_0..7`, a `filled` flag,
> a shared bank per plugin at
> `~/Library/Application Support/ScoopyLoops/Scoopy Tape/snapshots.xml` loaded
> at construction and **merged bank-wins** on restore — rather than inventing
> one.
>
> **What it extends** (user ruling): in the line's plugins a slot holds
> normalised PARAMETER values. Here **a slot holds the recorded AUDIO plus its
> params** — rate, loop points, pulse relation, texture. That is what flipping
> slots means in a looper, and it is the one place the signature does not reach.
> Consequences to design in §3 rather than discover:
> - **Morph** is the signature's other half and it can only interpolate params.
>   Audio does not morph; a slot flip is a cut or a crossfade (open, §10d). Say
>   that in the UI rather than offering a morph slider that half-works.
> - The line stores snapshots as XML inside the state tree. Audio cannot go
>   there — which is exactly what A6's embed-under-cap rule is for. `filled`
>   generalises to "has audio / has params / has both".
> - **Performance params are excluded from a snapshot** per the line ("snapshot
>   what the sound *is*, not how it's played"). For a looper that excludes scrub
>   position and transport state; it does not exclude rate or loop points.

**A5 — An explicit scrub-style selector**, a `Stepper`/`Select` at the display
edge. The style is a mode, not a modifier: the gesture is still decided once at
pointerdown and owns the whole drag (the existing gesture law, and what makes
the style MIDI-mappable and automatable).

**A6 — Persistence embeds under a cap.**
The DAW project chunk and preset files embed snapshot PCM up to a size cap;
above it, snapshots **reference** their drained take files in the shared
`WizardMerged/Takes` library. Self-contained in the common case, never explodes.
(8 snapshots × 30 s stereo float32 ≈ 180 MB raw is why "always embed" was not
taken.) The cap value is open — see §10d.

**A7 — A BROAD host-automatable parameter surface.**
Real `juce::AudioProcessorParameter`s: rate/varispeed, texture, level, the
pulse-ratio detent, snapshot select, **and** scrub position plus the
grain/warp creative layer. ⚠️ **This is the sharpest deviation from ScoopyDeck**,
which ships zero parameters and routes everything over the bridge. Two
consequences are first-class design work, not afterthoughts:
- **(a) Param IDs freeze at first ship.** They are part of the plugin contract;
  a renamed or reordered ID silently breaks every saved automation lane. The
  full list must be **enumerated and signed before any build leaves this
  machine** — see §8 and §10d.
- **(b) Scrub-position automation must coexist with the gesture engine.** The
  engine's scrub is *gap-derived*: the control thread posts a target frame and
  the render infers rate from the gap. An automation lane writing that same
  `scrubTarget` is a second writer. It needs an explicit ownership rule
  (proposal in §5), the same discipline as DECKPLUGIN's "one tempo authority".

**A8 — Export is a button.**
An EXPORT verb writes the loop region (or all snapshots) through
`wizard::wav::Writer` into the shared Takes library with the bpm sidecar, then
reveals. Drag-out of the plugin window is a later quality — it needs new
WKWebView file-drag machinery and should not gate v1.

---

## The plugin line — the layer this brief originally MISSED

⚠️ **Read this before designing anything.** The first draft of this document was
written without knowing that `~/xpert/plugins/` exists. It does, and it changes
what "a Scoopy plugin" means. `~/xpert/plugins/scoopy-pulsar` is a shipping
sibling (`aumu Puls Scpy`), and `../scoopyloops/docs/plugins/PLUGIN-DESIGN-SYSTEM.md`
is the design law for the line. `Scoopy Spectral FX` and `Scoopy Trombone` are
two more. Confirmed 2026-08-01 by `auval -a`.

**The user's "use scoopy plugin token/appearance guides (like pulsar)" meant
THIS**, not the pulsar grain mode in `NativeAudioEngineCore` — that reading was
wrong and the question it produced was badly premised.

What the line establishes, and how ScoopyTape relates to each:

| Convention | Where | ScoopyTape |
|---|---|---|
| `Scoopy <Thing>` · `Scpy` · a 4-char code claimed in the §7 registry | PLUGIN-DESIGN-SYSTEM §7 | **`Tape`** — claimed, ⚠️ entry still OWED, see below |
| `AU VST3 Standalone`, `COPY_PLUGIN_AFTER_BUILD` | pulsar `plugin/CMakeLists.txt:8-35` | done; `VST3_CATEGORIES Fx` added |
| **8-slot snapshots + morph — "the Scoopy plugin signature"** | PLUGIN-DESIGN-SYSTEM §5 | **A4 extends it** — see the amendment below |
| State root `"SCOOPY<NAME>"` ValueTree; shared bank at `~/Library/Application Support/ScoopyLoops/<Name>/snapshots.xml`, merged-bank-wins | §5 | §3 adopts |
| Host params from ONE X-macro `.def` → generated APVTS layout + relay specs; "do not hand-add a parameter" | pulsar `engine/include/pg_params.def`, `plugin/Source/ParamLayout.h:18` | **§8 adopts** — see below |
| Scalars ride **parameter relays with gesture bracketing**; fire-and-forget param writes are banned because they break host automation recording and undo | pulsar `docs/ARCHITECTURE.md` | §8 adopts |
| `shared/design/tokens.core.ts` vendored + hash-pinned, **never restated, never reformatted** | `~/xpert/shared/design` | already vendored here (`shared.lock.json`) — `shared:check` is one of our ten gates |
| One accent `#ef8b9a`, `#57c07a` for anything live, 18px bars in 26px rows on a 4px cell, mono-dominant 11px uppercase labels, radius 0 | tokens.core + PLUGIN-DESIGN-SYSTEM §4 | **agrees with our `--control-h: 18px` / `--cell: 4px` already** |
| **Failure is visible, never blank**; a null backend is a real state rendered as such, never faked | pulsar `docs/ARCHITECTURE.md` | the same rule as our DESIGN.md rule 7, stated harder |
| Canvas over SVG for dense redraw, one DPR recipe: size in CSS, backing store at `clientWidth × dpr`, `setTransform(dpr,…)`, draw in CSS px — "a blurry ruler reads as a broken one" | pulsar `TrainRuler.tsx:33-46` | **§4 should reuse this verbatim** |

**Where ScoopyTape deliberately DIVERGES from the line, and why** (user, 2026-08-01):

- **It lives in `apps/scoopy`, not in its own `~/xpert/plugins/scoopy-tape`.**
  Pulsar's template assumes a self-contained JUCE-free `engine/`. This product's
  entire value is `slengine`'s tape tier plus `SlDispatch` plus the takes
  library — a separate repo would have to vendor all three to arrive back where
  it already is. The conventions are adopted in place instead.
- **`AU_MAIN_TYPE kAudioUnitType_MusicEffect` (aumf), not `kAudioUnitType_Effect`.**
  The line's effect convention is aufx, but auval refuses that combination once
  MIDI in is declared, and the MIDI port is declared on purpose (see §1).
- **No `AU_SANDBOX_SAFE`.** Pulsar can assert it because it makes zero external
  file reads. This plugin reads settings and writes the shared takes library, so
  asserting it would be a false claim.

### ⚠️ OWED: the registry entry

`PLUGIN-DESIGN-SYSTEM.md` §7 says "claim the next here", and **this project may
not write to `../scoopyloops`** (CLAUDE.md: never write to that repo). So the
claim is recorded here and the registry line is owed:

> `` `Tape` = Scoopy Tape ``

Until someone adds it there, the code is claimed only by this document and by
`shell/plugin/CMakeLists.txt`. Nothing has shipped, so a collision is still
cheap to fix; after a ship it is not.

## The recurring traps (all three have already cost this project time)

1. **Plane components assume a strip's geometry.** `DeckFace`, `GridScenes`,
   `.compose-window-body` resolve `height:100%` / `flex:1 1 auto` against
   whatever ancestor exists — mounted in a plugin they do not error, they just
   size wrong. ScoopyDeck needed three plugin-scoped rules in `plane.css`
   (`.plugin-deck-pane`, `.plugin-deck-scenes`, `.plugin-deck-pane .strip-lcm`)
   before its face was correct. **Every plane component mounted here needs its
   box supplied explicitly and a walk assertion added.**
2. **A native method missing from `MergedLink.NATIVE_METHODS` is silently
   unreachable in the real host only** — it falls through to `BrowserLink` and
   throws into a swallowed promise. That defect shipped twice (`fxSlot`,
   `getFxSlotState`); `nativemethods:check` exists because of it. Every new
   command in §2–§7 must be added there.
3. **Green in Chromium ≠ reachable in the host.** The walk boots
   `?host=browser`, where capabilities differ honestly (the deck's LCM bar is
   live in the plugin and dead in the walk). Assert the **box** when the data
   cannot exist there, and owe a real-host check.

---

## The face — layout, within DESIGN.md law

The brief is *"the UI needs to be centered around the display so we have enough
ground to do more precise scrubbing."* That resolves to: **the display is the
only flexible region; everything else is a fixed 18 px row.**

```
┌──────────────────────────────────────────────────────────────┐
│ ⟳ ▸ ↻ ◼   ● REC   SRC ▾   CLK ▾  SYNC   TP│TS   LEN [ 16 ]   │  .strip-row (18px, flex:none)
├──────────────────────────────────────────────────────────────┤
│                                                              │
│                  HD  WAVEFORM  DISPLAY                       │  flex: 1 1 auto
│         loop brace · playhead · cue · scrub rate             │  (the ONLY flexible box)
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ SCRUB ▾   ×│÷  [ 1:1 ]   LEVEL ▰▰▰▱  TEXTURE ▰▰▱▱   EXPORT   │  .strip-row (18px, flex:none)
├──────────────────────────────────────────────────────────────┤
│  1  2  3  4  5  6  7  8                          PRESET ▾    │  snapshot band (flex:none)
└──────────────────────────────────────────────────────────────┘
```

Binding rules this obeys, each from `docs/DESIGN.md`:
- **Transport is the four glyphs** ⟳ ▸ ↻ ◼ and only those. `■`/`▶` are a second
  dialect and are banned. If a verb is missing, that is a missing verb — not a
  smaller vocabulary. (Pinned mechanically in `Strip.test.tsx`.)
- **`LEVEL` and `TEXTURE` are `GeoRange`**, never a bare `<input type=range>` —
  the inline gradient makes the value read as a shape, and a raw range has the
  mousedown-fires-change-before-click trap recorded at
  `panels/trackRowControls.tsx:308`.
- **The pulse ratio is a `DragBox`** (drag / nudge / MIDI-learn / pin), with
  `× ÷` as row-local buttons beside it — see §6.
- **`SRC`, `CLK`, `SCRUB`, `LEN` are `Select`/`Stepper`.** `LEN` specifically
  uses the step-counter idiom per A3(ii).
- **One height, one token.** Every control is `var(--control-h)`; the rows
  redeclare nothing that `.strip-row` (18 px, gap 6) already establishes. Value
  readouts are sized in `ch`, never px.
- **L1 — the box is authoritative.** A row too narrow **scrolls; it never
  wraps.** The display takes the remainder and has a `min-height` so it cannot
  be squeezed to nothing.
- **L2 — every row always exists.** State changes *fill*, never *presence*. TS
  controls with a cold stretcher are **disabled with a `title` that says why**,
  not removed (rule 6: a disabled control teaches).
- **Rule 7 — never ship a control that reaches nothing.** Anything whose verb is
  unbuilt says the gap on screen instead of drawing a dead button.

The whole face needs its own `plane.css` block with explicit boxes (trap 1), and
a `browser_plugintape_test.mjs` walk asserting the display is the flexible
region and the rows are 18 px (trap 3).

---

## §1 · The plugin target, the face, the door

The prerequisite for every other section — nothing below is *reachable* without
it, and per the four rules an unreachable feature is the same defect as an
absent one.

- **New `juce_add_plugin` target** beside `ScoopyDeck` in
  `shell/plugin/CMakeLists.txt`: `IS_SYNTH FALSE`, `FORMATS AU VST3 Standalone`,
  `AU_MAIN_TYPE kAudioUnitType_Effect`, stereo in → stereo out, a fresh
  `PLUGIN_CODE` and `BUNDLE_ID` (name + code are open — §10d).
- ⚠️ **`shell/plugin/` is not structured for two plugins today**: one
  `CMakeLists.txt`, one `src/`, sources named `ScoopyPlugin*`, namespace
  `wizard::plugin`. Expect a modest reshuffle — shared spine (`EmbeddedWeb`,
  `HostSync`, `PluginBackend`) into something both link, per-product processor
  and editor beside it.
- ⚠️ **`EmbeddedWeb.cpp` hardcodes the deck's binary-data symbols**:
  `#include "ScoopyDeckWebDist.h"` (`:3`) and
  `getNamedResource("webdist_zip")` from namespace `ScoopyDeckWebDist` (`:10`).
  A second `juce_add_binary_data` over the same `webdist/` zip needs a different
  target name and `NAMESPACE`, so **`EmbeddedWeb` must be parameterised** rather
  than copied. The extension-less `webdist_zip` filename is load-bearing (it is
  the symbol name).
- **The face**: `window.__slPanel = "plugintape"` via `.withUserScript`, a case
  in `App.tsx` (`:180` is the deck's), and a new
  `web/src/plane/PluginTapePanel.tsx`. Follow `PluginDeckPanel`'s **sink-first**
  ordering — ensure a session/strip exists *before* rendering, because the
  earlier `compose` route sat on "waiting for pattern state…" forever when a
  freshly-inserted plugin had no address.
- **The walk**: `web/tools/browser_plugintape_test.mjs`, registered in
  `web/tools/walks.mjs:28` (`browser_plugindeck_test` at `:41` is the model).
  Negative-test it both ways — the deck's walk exists because three layout
  regressions shipped invisibly.

**Door:** the plugin loads in Logic/Live as an **audio effect**, shows the face,
and passes audio through.

---

## §2 · Record, loop, and the two capture-length modes (A3)

The engine half is done — this is the capture-policy layer above it.

- **Source**: `RecordSourceKind::deviceInput` with the plugin's input bus as
  the tap. (`mainMix`/`channelBus` are the app's cases; an insert effect
  records what the DAW feeds it.)
- **Free + quantized stop.** Free length when sync is off or the host is
  stopped. When synced and running, the stop rounds to the nearest beat/bar.
  The inputs exist — `HostSync` carries bpm/ppq, `inferTapeBpm`
  (`tempo.ts:149`) infers a loop's bpm with its honesty guard — but **the
  rounding rule itself is new**. Decide where it lives: rounding the *stop
  frame* in the engine is sample-accurate; rounding the *loop region* after the
  fact in the web tier is cheaper and reversible. Prefer the latter first
  (Law C-3 already hands the buffer over intact, and a region is editable).
- **Pre-armed fixed length**, stated in steps via the `LEN` Stepper (A3(ii)),
  auto-stopping on the boundary. This one wants the engine: a
  `record_cap`-style boundary the render honours, so the stop is sample-exact.
  Note `sl_tape_set_record_cap_frames` already exists in the ABI as a *safety*
  cap — check whether it can carry this meaning before adding a second.
- **Overdub** is already SUM/REPLACE; the open question is which one the record
  verb means on an already-filled snapshot (§10d).
- **Monitoring**: the engine already couples the monitor to record via
  `sl_channel_set_monitor` — expose off / while-record / always rather than
  leaving it implicit.
- **PDC honesty**: copy the deck's mode-scoped `updateLatency()` — report
  `setLatencySamples` only in timeStretch mode, and read it from the engine,
  never hardcode. (The deck's measured value was 7200 frames / 150 ms @48k, not
  the ~5120 older docs estimate.)

**Door:** arm, play audio into the plugin, hit REC, get a loop that plays in
time. Both modes, with the host running and stopped.

---

## §3 · The 8-snapshot system and presets (A4, A6)

- **Slots are tapes.** `kMaxTapes = 8` already; a snapshot *is* tape index 0–7.
  No new storage tier.
- **The flip** loads a snapshot into the display and transport. Loading
  reallocates render-visible storage, so **this is `withRenderDetached()`'s
  first real caller** (`ScoopyPluginProcessor.h:188`) — do not invent a second
  guard.
- **Quantization of the flip** (free vs on the launch quantum) and whether a
  mid-playback reload crossfades are **open** (§10d). Note the launch-quantum
  ruling P11-3c is itself still awaiting the user — do not accidentally settle
  it here.
- **Presets store all eight** — a new persistence object above the DAW chunk,
  living beside the per-face settings in `PluginBackend`'s
  `ScoopyTape/` directory, with audio governed by A6's cap.
- **Persistence (A6)**: extend the deck's chunk format rather than inventing
  one — gzip, magic, version, JSON header + float32 PCM in header order,
  parse-into-locals-and-commit-only-on-success, 64-bit bounds arithmetic. Add
  the rule that a snapshot over the cap serialises a **take reference** instead
  of PCM. ⚠️ Both paths need a test: a project that reopens **with sound and no
  editor** is the deck's standard and it is the right one.

**Door:** record into slot 1, flip to 3, record, flip back — both there. Save the
DAW project, reopen, both still there. Save a preset, load it into a fresh
instance.

---

## §4 · The HD waveform display

The current tape wave is the weakest link relative to the brief.

**What's there:** `web/src/plane/TapeWave.tsx` — `WAVE_H = 48` (`:21`),
`columns = Math.max(1, Math.round(width))` (`:100`), i.e. **one column per CSS
pixel**, re-fetched at 8 Hz while recording (`REC_REFETCH_MS = 125`, `:26`). The
canvas is DPR-aware but the *data* is not, so on a retina display the wave is
upsampled. Engine-side, `slTape waveform` (`SlDispatch.cpp:469`) is an
**uncached brute-force min/max scan** per column, returned as JSON `min[]/max[]`
arrays.

**The four things HD needs:**
1. **DPR-aware column counts** — ask for device pixels, not CSS pixels. Adopt
   `web/src/design/waveformStyle.ts`'s truth contract, which the grid renderer
   already honours: *1 drawn column = 1 device pixel, amplitude linear.*
   The line has one canvas recipe used by all five of Pulsar's canvases
   (`TrainRuler.tsx:33-46` and its four siblings) — size in CSS, backing store
   at `round(clientWidth × dpr)`, `ctx.setTransform(dpr,0,0,dpr,0,0)`, then draw
   in CSS px, with `Math.round(x) + 0.5` offsets for crisp hairlines. Its
   comment is the whole argument for this section: *"Backing store at device
   resolution; a blurry ruler reads as a broken one."* Reuse it verbatim rather
   than deriving a second one. Canvas over SVG is also settled there: *"2048
   points redrawn at 30 Hz is exactly the case SVG handles badly."*
2. **An engine-side peak cache / mip pyramid.** The donor's
   `../scoopyloops/ScoopyLoops/WaveformCache.swift` is the model — LRU by id,
   resolutions clamped `[8, 8192]`, per-channel min/max, lazy RMS, lazy FFT
   brightness. A brute-force rescan per zoom level will not survive HD.
3. **A cheaper transport.** JSON number arrays get expensive fast at thousands
   of columns; a binary lane is likely.
4. **RMS + spectral-centroid columns** if the tape is to look like the grid's
   waveform (`panels/waveRender.ts` — note its explicit perf bans: no
   `shadowBlur`, no `filter`, no gradients).

Also: **read `pubScrubRate`** (`sl_tape.h:132`, published and unread) so the
display can show scrub rate/direction — the feedback that makes precise
scrubbing precise.

Keep the existing structure: paint on `requestAnimationFrame` from refs the
HotFrame writes; React state holds only the fetched envelope.

**Door:** a visibly sharper waveform on a retina display, still smooth at 60 fps
while recording, and legible enough to place a loop point by eye.

---

## §5 · Scrub styles (A5)

**Turntable exists** and is good (`sl_tape.cpp:623-638`). The work is to make it
one of several named styles behind the `SCRUB ▾` selector.

Read first: `docs/archive/pd-scrub-engine.md` and
`docs/archive/pd-scrub-interaction.md`. **§1.2 of the interaction doc, "Two
scrub flavours", is the precedent** — it already distinguishes *discrete*
(schedule a fixed ~0.1 s snippet at natural pitch per drag update) from
*turntable* (rate-driven cursor). The engine doc's §1.5 is a warning: **no
inertia, no fling** — what looks like inertia there is a 40 ms input-hold
timeout. Its reference tuning is stated verbatim and should be the starting
point, not re-derived.

Candidate styles:
- **Scratch** (built) — gap-derived rate, pitch moves with speed. The turntable.
- **Tape shuttle** — rate-driven with detents and a hold, so a parked finger
  holds a constant speed instead of returning to the target. A variant of the
  same reader, not new DSP.
- **Grain** — route the scrub through `NativeBusStretcher` at the **small
  texture nodes** (25/60 ms, `kBusTextureBlockMs`): pitch stays put, position
  moves, and the character is grainy by construction. Reuse before inventing.
  Freeze (`kBusBrowseMaxRatio`) is the same mechanism at the other extreme.

⚠️ **A7(b) lands here.** If scrub position is automatable, the host and the hand
are two writers on one `scrubTarget`. Proposal: **the hand wins while a gesture
is live** (pointerdown→up owns it outright, matching the existing gesture law),
the automation lane owns it otherwise, and the handover rides the existing
raised-cosine `scrubGain` ramp so it cannot click. Whatever is chosen, write it
down as explicitly as DECKPLUGIN wrote "one tempo authority" — this is the same
class of bug.

**Door:** each style audibly distinct on the same loop, switchable mid-set, and
no click on style change or on release.

---

## §6 · The quick multiply/divide pulse gesture

**The donor has this and it was never ported.** `Track.swift:116-117`:

```swift
static let multiplyCycle: [Double] = [threeToTwo, 2.0, 3.0, 4.0, 1.0]
static let divideCycle:   [Double] = [twoToThree, 0.5, 1.0/3.0, 0.25, 1.0]
```

driven by `BeatSequencer.nextCycleMultiplier(...)`. **It is a one-key cycle
through five states, not a slider** — that is what makes it fast enough to use
mid-performance, and it is precisely the "change the multiply pulse ratio
quickly" in the brief.

What to reuse rather than rebuild:
- `RATIO_TABLE` (`web/src/panels/trackControls.ts:191`) — 17 detents,
  `1:4 … 16:1`.
- `stepSpeedRatio(rate, dir)` (`:258`) — walks detents **by index**, because the
  log spacing makes value-stepping useless.
- The unified rate model: **effective speed = `speedMultiplier` × `freeRate`**;
  plain drag locks to detents, ⌥-drag goes continuous.
- `pulseRelation` already persists on the tape element
  (`mapDocument.ts:81`) and already feeds `tapeEffectiveRate`.
- **Glide**: the donor's `rateMorphFrames` ("rate morph / multiply glide")
  exists in the core and is gated in CI as `scoopy_rate_morph_test`. ⚠️ It is
  unreachable for the same reason DECKPLUGIN §7 is stuck — the snapshot param
  tables do not carry it, and those tables are **generated**
  (`slengine/generated/*.inc`), so `params:check` · `worldmap:check` ·
  `trackparams:check` all speak to that edit. If §6 wants glide, it inherits
  that cost; instant-switch first is the cheap path.

Pair it with a **loop-cycle readout** — the `.strip-lcm` idiom applied to a
tape, showing loop length against host bars and the active relation, so the
ratio change is visible as well as audible.

**Door:** `×` and `÷` step the ratio mid-playback, in time, with the readout
agreeing and the loop staying in sync.

---

## §7 · Export (A8)

- **The verb**: export the current loop region (and an all-snapshots variant)
  through `wizard::wav::Writer` (`WavWriter.h:37`) into the shared
  `WizardMerged/Takes` library, with the `.wav.json` sidecar carrying
  `bpmAtStart` so the file re-imports tempo-aware anywhere in scoopy. Then
  reveal in Finder (`slTakes` already has a reveal arm).
- ⚠️ **This is the tree's first non-realtime write.** Everything today is a
  realtime drain. The read is a control-thread pass over the tape's chunks —
  which is exactly the storage `withRenderDetached()` guards. Do not read
  render-visible storage from the message thread without it.
- The writer is already crash-safe and RF64-capable; do not reimplement.
- New command → **`MergedLink.NATIVE_METHODS`** (trap 2).

**Door:** EXPORT writes a file that opens in another DAW at the right length and
tempo, and re-imports into scoopy tempo-aware.

---

## §8 · The parameter surface (A7) — enumerate and sign BEFORE building

Deliberately last to build, **first to decide.** Param IDs freeze at first ship;
a renamed or reordered ID silently breaks every saved automation lane in every
user project. ScoopyDeck avoided this entirely by shipping zero parameters —
this plugin is taking the opposite bet and must pay for it up front.

**The line already solved the mechanics — clone them, do not invent** (see "The
plugin line"). Pulsar generates everything from ONE X-macro file
(`engine/include/pg_params.def`): the APVTS layout, the host-facing labels, the
id list and the relay specs all expand from it, and `ParamLayout.h:18` says
flatly *"Do not hand-add a parameter here. Add it to the .def."* A `--check`
gate fails the build when a generated file is stale. That is the same
generated-contract discipline this repo already runs for `params:check` /
`worldmap:check` / `hotframe:check`, so it costs a pattern we know rather than a
new one.

Two rules from the line that are load-bearing here:
- **IDs are dotted lowercase-camel** (`global.amp`, `group1.formantRatio`), and
  the same string is the host param ID, the engine key and the relay name.
- **Scalars ride parameter relays with gesture bracketing.** Pulsar's
  ARCHITECTURE is explicit that a fire-and-forget param write is a defect:
  *"without `beginChangeGesture`/`endChangeGesture` the host records no
  automation and undo is broken, and without feedback the on-screen control does
  not move when the host automates."* ⚠️ ScoopyDeck's `slParam` lane is exactly
  that fire-and-forget shape — do not copy it here.

Proposed surface, **to be signed as a decision before any build leaves this
machine**: `tape.rate` (signed, bipolar) · `tape.texture` · `tape.level` ·
`tape.pulseRatio` (detented) · `tape.snapshot` (1–8) · `scrub.position` ·
`loop.start` · `loop.end` · plus the creative layer (`warp.*`, `flux.*`,
`air`, `formant`, `tilt`, `transpose`).

Design notes:
- Every parameter needs a **defined relationship to the web control that also
  writes it** — the relay pattern above is that relationship, and it is why the
  deck's two-name `slParam` map does not scale to this surface.
- `scrubPosition` carries §5's ownership rule.
- `pulseRatio` should quantize to `RATIO_TABLE` indices, not expose a raw float.
- `setModExternal` on the stretcher is **plugin-only** and unused by the app —
  a host-LFO input is a natural fit here and costs nothing new in the DSP.

---

## Later qualities — brainstormed, not scoped

Ordered by leverage-per-effort given what exists:

- **Retroactive capture** — record into a ring while armed, "grab the last N
  bars" instead of punch-in. Explicitly deferred at A3; the chunk store and the
  service-thread pre-allocation pattern would support it.
- **Overdub feedback/decay** — SUM overdub exists; a per-pass feedback < 1 gives
  Frippertronics-style evaporating layers for one multiply in the render.
- **Cue pads** — scrub-release already arms exactly one cue
  (D-WZ-SCRUBCUE-01); generalise to N pads with quantized retrigger.
- **Grain/pulsar playback mode** — not just a scrub style: the loop as a
  grain-train instrument, scan position driven by the display. The core's
  `NativeGrainScheduler` (16 grains/track) is built; A2 kept it out of v1.
- **Freeze + granular browse** — `kBusBrowseMaxRatio = 4096` is already freeze;
  the donor's `setBusGranularParams(browseEnabled, browseSpeed, …)` is the
  "hold this moment and move through it" gesture.
- **Host-phase lock** — restart the loop on the DAW downbeat; the tape analogue
  of the deck's `hostAlignedStartStep()`. Also: follow a host cycle jump.
- **MIDI control** — DAW MIDI already reaches the web tier in the deck plugin
  via a 256-entry SPSC ring; map notes/CC to record, overdub, retrigger,
  snapshot select, `×`/`÷`.
- **Drag-out to the DAW timeline** — the strongest export workflow, deferred at
  A8 for the WKWebView file-drag machinery it needs.
- **The carve door** — promote a loop into a scoopy session track via the
  existing `web/src/plane/carve.ts` and the shared takes library. **This is the
  bridge between the two plugins** and probably the most interesting item on
  this list.
- **Per-snapshot channel** — LOOPER-DESIGN's strip channel (level · 4 sends ·
  DRV) already exists per tape in `slTape`; exposing sends would need extra
  output buses and re-opens the bus-layout question A1 just closed. Not v1.

---

## Suggested order

§1 (the door) → §2 (record/loop) → §3 (snapshots + persistence) → §4 (HD
display) → §5 (scrub styles) → §6 (multiply gesture) → §7 (export) → §8
(parameters, **whose ID list is signed before §1 ships anywhere**).

Each § is one or more green commits; the bundle closes on the last. One coherent
step per commit.

---

## Gates for every step

- `ctest --test-dir build --output-on-failure`
- `cd web && npm run typecheck && npm test`
- **The ten drift gates, every session**: `params:check` · `shared:check` ·
  `worldmap:check` · `hotframe:check` · `tape:check` · `trackparams:check` ·
  `webdist:check` · `check:tokens` · `schema:check` · `nativemethods:check`.
  ⚠️ `tape:check` and `nativemethods:check` are the two this product will
  actually trip. There is **no `protocol:check`** — `web/package.json` is the
  authority.
- `node tools/browser_plugintape_test.mjs` (new, §1) and the existing walks.
- **`auval -v aumf Tape Scpy`** — `aumf` (MusicEffect), not the deck's `aumu`
  and not `aufx`: auval itself refuses aufx once a MIDI in port is declared
  ("AU implements MusicDeviceMIDIEvent but is of type 'aufx'"). ⚠️ After a
  `PLUGIN_CODE` or type change the AU registry caches the old entry — run
  `killall -9 AudioComponentRegistrar` or auval reports "didn't find the
  component" on a plugin that is installed and fine. ⚠️ `pluginval` is **not
  installed**; install it or state that it is unrun.
- `npm run bundle` **LAST** before `git add`, or `.buildhash` records a tree
  that no longer exists (the P3-X4 lesson).
- ⚠️ `engine:check` drift is pre-existing (recorded in P6-3) — not yours.
- ⚠️ Other agents edit this tree concurrently: **`git add` explicit paths, never
  `git add -A`.**
- **Real-host checks nobody can run headless**: does it instantiate as an effect
  in Live and Logic; does automation of `scrubPosition` behave; does a reopened
  project give back its snapshots with sound and no editor.
