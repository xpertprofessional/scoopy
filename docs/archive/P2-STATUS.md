# P2 status — where the merged strip-suite actually is

*Written 2026-07-26 at the close of the engine+persistence phase, as the brief
for a FRESH SESSION starting step 4 (the plane UI). Companion to `P2-KICKOFF.md`,
which is the original plan plus a running record of what each increment found.
Read this first; read the kickoff for the reasoning behind any single decision.*

## ⚠️ READ THIS FIRST — step 4 as it stands, 2026-07-26

**All six increments are built.** The plane records, plays, scrubs,
varispeeds, routes strip→strip with cycle detection, meters, masters, saves,
reopens, and exports a self-contained package with its audio. Everything that
could be built without a decision from the user is done and proven.

| | |
|---|---|
| wizard `ctest` | **64/64**, incl. `plane_audio_test` |
| scoopy `vitest` | **1295/1295**, 88 files |
| layout gate | `browser_plane_test.mjs`, 44 measured checks |
| typecheck · protocol · shared · engine · hotframe · abi · tape · trackparams · worldmap | green |
| `check:tokens` | **12**, all pre-existing in scoopy — see "the gate that is red" |

### THE ONE THING BLOCKING THE REST

Three features — the grid **creation gesture**, **landing a carve**, and
**multi-deck grid strips** — are blocked by a single cause:

> `store/companionEngine.ts` holds **ONE** session (`session: WorkingSession |
> null`) and `worldFromSession` has **no deck axis**. It was written for the
> browser companion, where one session IS the app. The mission sentence is
> "decks load into strips, each with its own BPM", which needs N.

**The ENGINE is not the blocker** — `plane_audio_test` §10 proves two decks
publishing independently, each keeping its own tempo-sync ratio across the
other's publish, both audible, out-of-range refused rather than aliased onto
deck 0. (`SlWorldApply` carried a stale "deck 0 only today" comment; never true,
now corrected.)

The work is giving `companionEngine` a per-deck session map without breaking the
browser companion. It touches a ~700-line store that host also depends on, and
it is the same species of change as the world sink — the one that, unexamined,
meant nothing worked at all. **Left for the user to scope rather than guessed
at.**

### THE RULE THAT EARNED ITS KEEP

"Tests pass" is not "it works". Increment 1 was handed over with 1225 green TS
tests, 63 green ctest cases and clean gates, and made no sound at all. Two
instruments now close that, and **must stay green**:

- **`shell/tools/plane_audio_test.cpp`** — drives the plane's EXACT command
  sequence through the real dispatcher into a real engine with a real
  `RecordService`, and asserts on rendered SAMPLES and real files on disk.
- **`web/tools/browser_plane_test.mjs`** — drives the BUILT bundle and measures
  bounding boxes against the §4.1 pixel budget.

**Ten defects they caught that no unit test could reach.** Every one returned
`ok` and did the wrong thing:

1. `MergedLink` was an empty subclass — every command in the native app was
   answered by the browser companion; the engine ran, with a device open, being
   asked nothing.
2. A strip recorded SILENCE — it captures its channel bus, and nothing created
   the device-input route that bus needs.
3. A 1px border broke the 196px budget, pushing the `rate` row under
   `overflow: hidden` — the control was simply gone.
4. Every world publish silently UN-SYNCED every deck (`sl_snapshot_begin`
   resets `tempoSyncRatio`).
5. A wrong premise in the routing test itself — grid decks mix into main
   directly, so "only strip 1 reaches main" was false while a deck played.
6. A master fader on the mixer state would have moved only grid decks, because
   strip channels sum in AFTER `core.render`.
7. Clicking a strip's CENTRE selected nothing — selection and dragging had been
   one decision.
8. The ledger's unpatch used the row number, not the engine SLOT id — it would
   have removed a different cable than the one clicked.
9. No file layer existed at all: "mapStore save/open" read like UI work, and
   `chooseDirectory` was the only filesystem method on the wire.
10. Take bytes cannot cross the JSON bridge (256 MB cap → ~350 MB of string), so
    collect-on-export had to be native.

**Three of those ten were PLAN LINES that read like UI work and turned out to be
missing infrastructure** (no record service, no file layer, no byte transport).
That is the pattern worth carrying forward.

### THE GATE THAT IS RED

`check:tokens` reports 12, none from the plane. Two dead `var(--dur-latch,
180ms)` fallbacks were removed (both tokens are defined, so the fallbacks could
never fire — provably a no-op). The rest:

- **8 are `panels/trackControls.ts`'s named track palette** ("Red" `#ED5252`, …).
  Arguably a FALSE POSITIVE and a gap in the RULE rather than the code: this is
  a user-facing palette a person picks from, not styling. If it came from the
  theme, changing theme would change what "Red" means on a user's track. It
  wants a narrow, commented exemption — which is a decision about the gate, so
  it was not taken unilaterally.
- **4 are real** (`grid.css` inset shadows, a `"#888888"` fallback and a
  `globalAlpha` in `GridPanel.tsx`) but sit in the grid UI, outside the plane's
  scope and not visually verifiable from here.

A red gate protects nothing: until this is settled it cannot fail on a NEW
violation without someone reading the list.

### WHAT ELSE REMAINS

- **`slMap/export` is done**; the `.scoopyMapPkg` UNPACK path is built and
  tested but has no import button yet.
- Carve is half-landed by design — the region maths and the shared-take
  invariant are real and tested; writing the track into a session is blocked
  above. The button refuses that half out loud rather than clearing the tape and
  dropping the region.

## The correction that reset the approach, 2026-07-26

The first hand-off of increment 1 claimed completion on 1225 green TS tests, 63
green ctest cases and clean gates. **It did not make a sound, and three of the
four faults were structural rather than cosmetic.** What the run-pass found:

1. **`MergedLink` was an EMPTY subclass.** It held the JUCE backend and never
   called it, so EVERY command in the merged desktop app was answered by
   scoopy's browser-companion code path — which implements none of the plane's
   methods and threw "not implemented in the browser companion" for each one.
   The native engine was running with a device open, being asked nothing. Its
   HotFrame was synthetic too, so no meter or playhead could ever have moved.
   Fixed: an explicit, commented native/companion split, pinned by
   `src/mergedLink.test.ts` (nothing in the type system can catch this — both
   sides satisfy `EngineLink`).
2. **A strip recorded SILENCE by construction.** A strip captures its own
   CHANNEL BUS, and a channel carries its element plus whatever is ROUTED INTO
   it — so a fresh strip with no input route carries nothing. "A device input is
   just a route into a strip" is what lets an input need no special case; it is
   also what makes an input strip impossible until something creates the route,
   and nothing did. Increment 1's own goal was unreachable. A strip now arrives
   with its input patched (`stripOps.inputRoute`).
3. **The strip's pixel budget did not close.** A 1px `border` ate 2 of 196, so
   the `rate` row was pushed under `overflow: hidden` — the control was simply
   gone. Now an inset box-shadow (zero layout cost, same reasoning as L6).
4. **Errors were self-amplifying.** `main.tsx` prepends a `<pre>` per
   unhandled rejection with no bound; twelve of them pushed the 100vh panel off
   the screen, so one missing method presented as total collapse. Now: no plane
   command fires without a handler (`plane/send.ts`), errors dedupe with a `×N`
   count and cap at 4, and they render in a fixed overlay that cannot displace a
   panel.

**THE LESSON, AND THE NEW RULE.** "Tests pass" had been standing in for "it
works": every test asserted a function returned what it said it would, and none
asserted that pressing REC produced audio. Two instruments now close that gap
and MUST be kept green:

- **`shell/tools/plane_audio_test.cpp`** — drives the EXACT command sequence the
  plane's UI issues, through the real dispatcher, into a real engine with a real
  `RecordService`, and asserts on rendered SAMPLES: input audible → REC → a real
  `.wav` + sidecar on disk with a non-zero Law C-2 stamp → loops back audibly
  with the input unpatched → level attenuates → mute silences → reverse moves
  the playhead → stop silences → the waveform has real data.
- **`web/tools/browser_plane_test.mjs`** — drives the BUILT bundle headlessly
  and measures bounding boxes against the §4.1 budget. It is what caught the
  border.

Nothing is handed over again without both green.

## One paragraph

Engine steps 1–3 and the document half of step 5 are **built, tested and
sanitizer-clean**. Nothing is committed in either repo. What remains is the
**plane UI (step 4)**, which is the collaborative part — it needs a human
run-pass because the agent cannot see the screen — plus two pieces of plumbing
that were deliberately left for a decision rather than guessed at.

## Gates, as of this writing

| | |
|---|---|
| wizard `ctest` | **64/64** (incl. `plane_audio_test`) |
| scoopy `vitest` | **1229/1229**, 82 files |
| typecheck (both) | clean |
| **audio, end to end** | `plane_audio_test` — the plane's own command sequence → rendered samples, a real take file, and a grid deck audible through `sl_engine` |
| **layout, measured** | `browser_plane_test.mjs` — the built bundle against the §4.1 pixel budget |
| web gates | `tape:check` 21/21 · `abi` · `hotframe` (326) · `trackparams` · `worldmap` · `engine` · `protocol` · `shared` green |
| `check:tokens` | 14 violations, **all pre-existing in scoopy**, none from the plane |
| ThreadSanitizer | engine 0 races · host tier 0 races (three-thread harnesses) |
| AddressSanitizer | ~1,000,000 blocks/run against 3,000 record-starts, clean |

Build: `cmake -B build && cmake --build build && ctest --test-dir build`
(from `apps/wizard`). Scoopy: `npx vitest run` from `apps/scoopy/web`.

## What exists now

**Engine (`apps/wizard/slengine/`)**
- `sl_tape_*` — wizard's deck transplanted (SL-ABI-V3 §5), 8 tapes, an index
  space independent of the 3 grid decks. Record/scrub/varispeed/loop/overdub,
  256 MB cap, Law C-2 stamps, the Law C-3 same-block record→loop handoff.
  Record sources: `deviceInput`, `mainMix`, `channelBus`.
- `sl_channel_*` — the uniform strip channel: level, 4 sends, mute, record tap.
  **A projection, not a second mixer**: tape channels are mixed here, grid-deck
  channels forward onto the core's own per-deck controls.
- `sl_route_*` — the patchbay. Typed `{kind,index,sub}` endpoints; forward routes
  render in dependency order at ZERO added latency; a cycle is refused unless the
  caller consents to a one-block `feedback` edge. Every gain ramped. Full
  introspection for save/load.
- `sl_watchdog_*` — RMS limiter on main, plus a numerical ceiling at the channel
  output where feedback loops actually close.
- The monotonic sample clock (`sl_engine_time_samples`) that Law C-2 roots in.

**Host (`apps/wizard/host/`)**
- `RecordService` is engine-agnostic behind `TakeDrainSource`; `TakeScan`
  enumerates takes from previous sessions.

**Document (`apps/scoopy/web/src/persist/`)**
- `mapDocument` — the `.scoopyMap` envelope: strips, elements, routes (with the
  load-bearing `feedback` flag), master BPM, the lane budget, the performance
  layer, strict zod + named migrations + refuse-newer.
- `mapApply` — `planApply(map)` returns an ORDERED op list (a planner, not a
  caller) and `captureRoutes` reads the live graph back.
- `takeLibrary` — sidecar parsing, **Law C-2 alignment**, resolution that
  preserves unresolved refs, the carve invariant.

## The decisions a fresh session must not re-litigate

Full reasoning lives in `P2-KICKOFF.md`, `MAP-SCHEMA.md`, `ROUTING-MATRIX.md`
and memory `p2-decisions`. The short list:

1. **Routing is ordered + explicit feedback edges** — not "everything one block
   late", which would accumulate latency and comb-filter parallel paths.
2. **`sl_tape_*`, not `sl_deck_*`** — §6 already spends `sl_deck_*` on grid decks.
   Signed off.
3. **3 grid decks** (pinned core) + 8 tapes; the mixer budget is **8 mono lanes**,
   FX returns outside it.
4. **Sends are routable** — the channel owns the LEVEL, the document owns the
   DESTINATION.
5. **Sessions are REFERENCED, not embedded**, and the map owns a narrow
   **performance layer** (`{currentScene, switchMode, queuedScenes, queueLoop}`
   per strip+session). scoopy's PIN mechanism already handles per-track state;
   the map must not duplicate it.
6. **DRV stays where it is** — already per-deck in the core.

## Step 4 — the plane UI, and what to know before starting

The plan's step 4 is unchanged (`P2-KICKOFF.md` §4). Additions from what was
learned building the engine:

**It is a panel.** scoopy's web UI is multi-panel (`PanelRoute` on `__slPanel`,
one window per panel) and `MergedMain.cpp` already spawns extra windows for the
instrument/FX/routing panels. The plane is a new route, not new machinery — and
that is also how **compose-beside-the-map** works, which the user wants.

**~~The engine surface is ready but NOT ON THE WIRE.~~ DONE 2026-07-26** —
`SCHEMA_VERSION` 87 carries `slChannel` · `slTape` · `slRoute` · `slRouteList` ·
`slRecord` · `slTakes` · `slWorld` · `openPanelWindow`, plus 42 appended
HotFrame scalars. Note `schema.ts` is hash-pinned into the merged repo via
`engine.lock.json`, so any further edit breaks `engine:check` until
`npm run engine:sync`, and the documented flow puts the scoopy commit first.

**`planApply` is already the applier.** When the wire lands, applying a map is a
`for` loop over its op list. Do not write a second applier.

**Two hazards to design in, not discover:**
- A compose republish can STOMP live performance overrides (the core's epoch gate
  hands control back to the snapshot). The map must re-apply its performance
  layer after any republish of that deck.
- With the SCN latch OFF, an edit is GLOBAL to the session — so a tweak made from
  the map bleeds into every other map using it. Settle where map-originated
  session edits land BEFORE exposing any session-parameter control on the plane.

**Read `docs/specs/pd-strip-anatomy.md` before drawing a strip.** It is a
detailed, still-current spec for the object — the layout-stability laws (fixed
box, fill-not-presence, REC never moves), all 19 states, and a critique of the
existing `Strip.tsx` with 14 numbered defects. It will save a redesign.

## What remains in step 5 (small, and not blocking step 4)

- `mapPackage` — the `.scoopyMap` zip. `persist/sessionPackage.ts` is the direct
  template (same job for `.scoopySession`, and there is already a zip test).
- `mapStore` — save/open/list/delete + autosave. `store/sessionStore.ts` is the
  template, `Autosaver` included.
- **Collect-on-export** — the deliberate step that makes a map self-contained for
  travel, per the session-embedding decision.

## Known limitation, written down rather than hidden

`Tape::reset()` publishes `chunkCount = 0` and RETIRES chunk storage rather than
freeing it, and the render null-checks — so the window is survivable. It is not
absent: the chunk vector is still structurally modified while the render indexes
it. Closing it properly means the render ADOPTING new storage via an atomic
pointer rather than the control thread mutating shared storage. That is a design
change and was not done unattended.

## Step 4 increment 1 — BUILT 2026-07-26, awaiting the run-pass

The vertical slice landed: the wire, the merged host's recorder, the map store,
the plane and the strip. Gates after it: wizard **ctest 63/63**, scoopy
**vitest 1221/1221** (81 files), typecheck clean both sides, every web gate
green. `check:tokens` reports 14 violations, **all of them pre-existing in
scoopy** (`GridPanel.tsx`, `grid.css`, `deckmixer.css`, `trackControls.ts`) and
**zero from the plane** — verified by stashing the work and re-running.

**The wire is on** (`SCHEMA_VERSION` 86 → 87). Six verb-bundled methods —
`slChannel` · `slTape` · `slRoute` · `slRouteList` · `slRecord` · `slTakes` —
plus `openPanelWindow`, and 42 **appended** HotFrame scalars (per-channel
peaks, tape playhead/state/cap, the watchdog lamp; length 284 → 326). Answered
by `WizardMerged` only. Both hand-mirrored version constants moved with it
(`MergedMain.cpp` `kScoopySchemaVersion`, `SlDispatch.cpp::capabilities`).

**Four things found while building that were not in the plan:**

1. **The merged Backend had no `RecordService`** — only the legacy shell did. So
   `sl_tape_record_start` filled a drain ring nobody emptied and allocated no
   chunks ahead: REC would have written no file and, past the pre-seeded
   capacity, captured no further audio. Now wired via `SlTakeDrainSource` +
   `record::Service`, reached through a `HostServices` seam so the headless
   dispatch test still runs with none and proves the honest refusal.
2. **`sl_channel_*` had no peak getter**, so the strip meters had no source.
   Added `sl_channel_peak_l/r`, consume-and-reset, published once per block by
   a CAS fetch-max (a plain store would let a render resurrect a peak the UI had
   already consumed — a meter that latches high and never falls). ⚠️ **A
   grid-deck channel reads 0** and always will at this tier: the core already
   summed that deck and the channel is a projection, not a second mixer. A grid
   strip's meter must come from the core's per-deck telemetry. Pinned by a test
   so it stays a known property.
3. **`pd-strip-anatomy` §6's "zero token additions" does not survive the move.**
   `--rec-lamp`, `--chan-deck`, `--chan-bus` and `--feedback-lamp` are WIZARD's
   tokens; scoopy emits none of them, and `check:tokens`' dangling-var rule
   caught it. Remapped onto scoopy's own vocabulary (`--hot`, `--signal`,
   `--text-dim`, `--warn`, plus `semanticColor()` for kind identity) rather than
   adding four tokens to satisfy a checklist written against another system.
   The mapping is recorded at the top of `plane.css`.
4. **A fresh map would have made NO SOUND.** `planApply` opens with
   `routeClearAll` — correct, so a saved patch never layers on the boot wiring —
   but an empty map then installs nothing, wiping the 40 default routes and
   leaving a plane that looks entirely normal and is silent. `bootMap()` fixes
   it: a never-saved map boots into the engine's defaults and **captures them**,
   so from that moment the document carries every cable as an ordinary route.
   Tested both ways.

**What increment 1 does NOT do**, deliberately and visibly rather than faked:
`tapeLoadTake` is a no-op (loading a take means decoding a file into a tape —
host work with no ABI entry point taking a path), and the grid ops
(`deckSetTempoSync`/`sceneSelect`/`sceneSetSwitch`) are skipped because
`sl_deck_*` exposes only count/clear/set_tempo_sync and **there is no scene API
in the ABI at all**. Both are commented at the skip.

### THE WORLD SINK — CONNECTED 2026-07-26, and why it was not a UI task

**Done.** The grid now renders through `sl_engine`, proven by `plane_audio_test`
§9: register a sample → publish a flat World → the sequencer is audible on the
SAME main bus a tape strip uses, with the tape stopped and the input unpatched.
One engine, one clock, one master.

What it took, and it was never a component:

- **`slWorld`** (`registerSample` · `publish`) — a new wire method.
  `SlWorldApply` had been built and tested since P1 with **zero callers**
  because there was no method to reach it. Deliberately NOT an overload of
  `worldPublish`, whose params are `{json: PatternFile}` (scoopy/Swift's path):
  one method whose payload means two different things depending on host is a
  hand-mirror with no gate on it.
- **`audio/nativeAudio.ts::NativeWorldSink`** — the sink, against a narrow
  `WorldSink` interface `ScoopyAudio` already satisfies structurally.
  `companionEngine` now picks by host and never learns which one it has.
- **`sampleStore.registerKit`** widened from the concrete `ScoopyAudio` to the
  one method it uses. A kit-loader has no business knowing which engine it fills.

Two things fixed on the way, both latent fragilities rather than new bugs:
`engineLink.ts` read `window` at MODULE SCOPE, so merely importing it required a
DOM (it broke two node tests the moment anything new imported it); and
`companionEngine` called `juceBackend()` at module scope for the same reason.

**Known gaps in the sink, stated rather than hidden.** `setMainGain` is a no-op:
the native master is the core's own stage, reached through the world snapshot,
and a second gain here would double a gain the engine already applied — the same
trap `sl_channel`'s projection design exists to avoid. A live master fader
belongs to the plane's master section (increment 5) and needs its own ABI point.
`position()` reports `step` only, from the HotFrame; the sub-step fields are 0
rather than estimated, because a made-up `stepFrame` would drive the scene
scheduler to fire at the wrong moment.

### What is still ahead

**Grid strips can now be built** — the blocker is gone. Remaining from the plan:

- **increment 2 — DONE 2026-07-26.** `slDevices` (list · setInput) reaches the
  device layer through `HostServices.audio`; `plane/devices.ts` turns route
  indices into names; the strip's head carries a right-click source menu (a
  DECISION FROM A LIST fails pd-strip-anatomy §3.1's one-handed test, so it is a
  menu — but the RESULT stays on the object, in the status line, which now names
  the actual input instead of "this strip's input"). Re-pointing removes and
  re-adds the cable, read from the LIVE graph rather than the document so a
  cable added outside the document's view is also cleared — otherwise two inputs
  would sum into one strip invisibly.
  Proven by `plane_audio_test` §3b with DIFFERENT signals on the two inputs:
  pointing the strip at the silent one makes it quiet, pointing it at the hot
  one makes it loud, nothing else changed. Identical signals would have passed
  whether the repatch worked or not.
  Also handled: a route pointing at a channel the device no longer has (switch
  8-in → 2-in) reports "not on this device" rather than claiming an input that
  is gone.
- **increment 3 — GRID STRIP DONE 2026-07-26** (creation gesture still to come).
  Scene pads in the wave rect, sync · tempo · COMPOSE in the rate row's slot —
  the SAME 340 × 196 box, measured: `browser_plane_test` now drives a grid strip
  too and asserts it keeps every row a tape strip has. A grid strip that were a
  different size would break the one-species claim on sight.

  **Two real findings, both caught by the harnesses rather than by reading:**

  1. **`deckSetTempoSync` HAD an ABI point all along** and I had lumped it with
     the scene ops as "no ABI", so `mapStore` skipped it — a synced deck would
     have loaded carrying whatever ratio the previous map left. Now `slDeck`
     (setTempoSync · clear). Scene selection is still deliberately NOT there:
     `sl_deck_*` has no scene entry point because a scene is a projection of the
     DOCUMENT, so it travels inside the published world.
  2. **⚠️ EVERY WORLD PUBLISH SILENTLY UN-SYNCS EVERY DECK.**
     `sl_snapshot_begin` sets `tempoSyncRatio = 1.0`, and every publish commits
     a snapshot — so editing anything in the grid drops the deck off master
     tempo with nothing saying why. Same shape as the performance-layer hazard
     the map already carries, but it applies to TEMPO SYNC, which the plane owns
     rather than the session. Pinned by `plane_audio_test` (set 2.0 → publish →
     it is 1.0 again) and closed by `mapStore.reapplyAfterPublish`, fired from
     the native sink after every publish. `sl_deck_tempo_sync` was added so the
     UI can show what is TRUE rather than what it last asked for.

  Also: **no session parameter is exposed on a grid strip, deliberately.** With
  the SCN latch off an edit is GLOBAL to the session, so a knob touched from the
  map bleeds into every other map using it. Scoping the element to the
  PERFORMANCE layer closes that hazard by construction rather than by memory.

  ⚠️ **STILL BLOCKED, AND THE PLAN MIS-SCOPES IT: the creation gesture.** A
  strip cannot yet BE made a grid strip from the UI, and it is not a missing
  button. `store/companionEngine.ts` holds **one** session (`session:
  WorkingSession | null`) and `worldFromSession` has **no deck axis** — it was
  written for the browser companion, which is one session by definition. The
  mission sentence is "decks load into strips, each with its own BPM", which
  needs N.

  **The ENGINE is not the blocker** — `plane_audio_test` §10 now proves two
  decks publishing independently, each keeping its own tempo-sync ratio across
  the other's publish, both audible, with out-of-range refused rather than
  aliased onto deck 0. (`SlWorldApply` carried a stale comment claiming "deck 0
  only today"; that was never true of the ABI and is now corrected.) The work is
  giving `companionEngine` a per-deck session map without breaking the browser
  companion, which is the same species of change as the world sink and deserves
  its own pass rather than being squeezed in.
- **increment 4 — ROUTING DONE 2026-07-26**, cables · chips · ledger.
  An SVG cable sheet INSIDE the plane transform, behind the strips and
  click-through except on the paths — the plane is an instrument first and a
  diagram second, so a cable must never intercept a click meant for a fader.
  Shift-drag strip→strip patches; clicking a cable unpatches. A feedback edge is
  dashed and carries its price.

  **The drawing rule, and why it reverses a signed decision.**
  `pd-plane-playground.md` §3 argued for NO cables at all (R-ROUTE-1), on the
  grounds that wizard's graph was a STAR — every channel had one output-bus
  edge, so n lines converging on one point was maximum ink for zero information.
  That was right then and does not survive the merge: `sl_route_*` made routing
  genuinely strip→strip, and a chain A→B→C cannot be read from labels. So the
  star half keeps its CHIPS and the graph half gets its LINES — the same
  principle applied to a topology that changed underneath it. The payoff is that
  the 40 boot routes are all terminal, so **a fresh plane draws zero cables and
  every cable you see is one you made** — and that falls out of the rule rather
  than needing an is-default flag the document does not carry.

  Proven in `plane_audio_test` §11, all audible: strip→strip carries signal
  (strip 0 has no path to main, so anything heard travelled the chain); a cycle
  is REFUSED and `wouldCycle` says so BEFORE the attempt, which is what lets the
  UI offer a feedback edge instead of showing a button that does nothing; a
  consented loop at round-trip gain 0.5 stays finite over 400 blocks; a send tap
  routes to a strip; and unpatching a live cable is a CROSSFADE — measured as no
  sample step above the ramp bound. `browser_plane_test` adds six checks for the
  layer's stacking and click-through.

  **The chips half**, which the strip had been missing: an OUT chip in the head
  (`▸main` / `▸—`, fixed width so it cannot reflow the head) and a new status
  rung — **"no output — this strip goes nowhere"**, ranked just under "audio
  missing". That is pd-strip-anatomy state 15: the console said it, the plane
  had dropped it (defect D7), and a strip inaudible for a routing reason with
  nothing on the object explaining it is the hardest fault there is to guess at.

  **The ledger** (`Matrix.tsx`, ⌘R or the button — no action may be
  shortcut-only). Reads the LIVE engine graph, not the document, because those
  drift the moment anything patches outside the document's view and the point of
  a ledger is to be what you check when you stop trusting your own picture.
  Hides the 40 boot cables by default; states the RENDER ORDER, which nothing
  else can show and which is the answer when someone asks why a cable "sounds a
  block late".

  ⚠️ **Two hazards avoided.** The cycle offer uses the app's own context menu,
  NOT `window.confirm` — a JS modal blocks the entire WebView and in the JUCE
  host would freeze the page and take the audio UI with it. And the ledger's
  unpatch carries the ENGINE SLOT ID, not the row number: the list is one entry
  per slot over the whole 128-entry capacity, so filtering to active cables and
  using the array index would unpatch a *different* cable than the one clicked,
  silently and more wrongly the further down the list. Pinned by
  `plane_audio_test` §12, which checks every active row against the engine's own
  getters and proves removal by reported id frees exactly that slot.
- **increment 5 — DONE 2026-07-26**, master section + Inspector.
  Level, output meter, watchdog lamp and master tempo, in the plane's BAR
  rather than as a strip. `pd-master-as-strip.md` proposed the opposite; what
  changed is that the plane got a bar, so the master has a home that is always
  on screen and never in the way — and a strip is something you PLACE, while
  there is exactly one master, it is never routed anywhere and it has no
  element. Document gains `transport.masterLevel` at **schema v2**, with a
  migration defaulting old maps to UNITY because that is what a v1 map SOUNDED
  like; a migration that alters the sound is not a migration.

  **⚠️ A MASTER FADER ON THE MIXER STATE WOULD HAVE MOVED HALF THE MIXER.**
  `MixerState::mainGain` is applied INSIDE `core.render`, and the strip channels
  sum in AFTER it (render phase 5) — so a master routed through the mixer state
  moves the grid decks and leaves every tape, input and routed strip untouched.
  That is the same finding the WATCHDOG produced ("the strip channels sum in
  after core.render, so scoopy's master clipper is already behind them"), and it
  applies to level for exactly the same reason. `plane_audio_test` §13 caught it
  on the first run: the fader returned ok and the output did not move.

  So `sl_master_set_level` applies the gain in the RENDER, on the summed main
  pair, before the watchdog — the guard still protects what leaves, and the
  `mainMix` record source stays literally "what left the app". Ramped on the one
  10 ms constant and snapped at the target, so a master at unity multiplies by
  exactly 1.0 and the bit-exact tape fixtures survive it (64/64 still green).

  **A second trap avoided on the way:** `submitMixerState` publishes through
  `buildWorld()`, the SINGLE-DECK path, which sets `djMode = false` — so even
  writing the mixer state would have wiped every grid deck the moment anyone
  touched the fader. The final implementation touches no world at all, and §13
  proves a deck keeps playing AND keeps its sync ratio across a master move.

  The watchdog lamp is not decoration: the limiter HOLDS the output rather than
  muting it, so a session being limited otherwise just sounds quiet and squashed
  with nothing saying why. It shows the gain reduction too, because "engaged"
  alone does not separate a graze from a runaway.

  **The Inspector** (`Inspector.tsx`) — the "set precisely" half of
  pd-strip-anatomy §3's split. Loop points in FRAMES, rename, the take's
  identity, what feeds the strip and where it goes, and remove. Drag is coarse
  BY DESIGN (the brace on the wave field is the performance); this is where you
  type the number afterwards, which is the whole reason both exist. Removing a
  strip drops its cables from the document AND the engine, read from the LIVE
  graph — otherwise the audio keeps flowing through a strip nobody can see, and
  the next strip to take that channel silently inherits the wiring.

  **Its empty state is the PLANE SUMMARY, never blank** (`summary.ts`, 8 tests):
  strips vs strips WITH MATERIAL, lanes against the budget (warned at the
  ceiling — finding out you are full from a refused click is worse than seeing
  it coming), cables you MADE (the 40 boot routes are excluded; "41 cables" on a
  fresh plane would make the number useless), unresolved takes, and **strips
  that go nowhere**, which is the most valuable thing the panel can say.

  ⚠️ **A UX bug the layout gate caught: clicking a strip's CENTRE selected
  nothing.** Selection and dragging had been one decision — the wave field and
  transport row are `data-no-drag` (a fader drag must never also move the
  strip), so a single early return meant most of a strip's area was unclickable
  for selection. They are now separate: a click anywhere in a strip selects it,
  and only the DRAG is suppressed over a control.
- **increment 6 — SAVE/OPEN DONE 2026-07-26**; carve and the zip package remain.

  ⚠️ **NOTHING COULD SAVE A MAP.** The wire carried no file read or write at
  all — `chooseDirectory` was the only filesystem method, and
  `capabilities.fileSystem: true` means "this host owns native dialogs", not
  "the web layer can write files". The browser companion persists through OPFS,
  which is browser storage and exactly wrong for a native document. So a whole
  plane could be built and lost, and the plan's "mapStore save/open" line had
  assumed a file layer that did not exist.

  `slMap` (save · open · list · delete) writes `.scoopyMap` files beside the
  takes — a map and its audio travelling together is what will make
  collect-on-export a copy rather than a hunt. The shell moves BYTES and parses
  nothing; the document layer keeps the format. Three properties pinned by
  `plane_audio_test` §14: the save is ATOMIC (temp + replace, so a crash mid-
  write leaves the previous map intact rather than a truncated one that looks
  openable and refuses when you need it); a name is a FILE NAME, never a path,
  so `../` cannot write outside the maps directory; and delete goes to the
  TRASH, never unlink.

  `state/mapFiles.ts` + 8 tests: a save CAPTURES the routing graph from the
  engine rather than the store (they drift the moment anything patches outside
  the document's view, and the difference stays invisible until the reload);
  `dirty` clears only on SUCCESS, because a failed save that cleared it would
  tell the user their work was safe when it was not; a newer document is refused
  rather than partially loaded; a lane-overspent map is refused with the count.
  Autosave is DEBOUNCED and only once a map has a name — a performance edits the
  map continuously, so a timer would write mid-gesture, and autosaving an
  unnamed map would scatter documents nobody asked for.

  ⚠️ **`window.prompt` avoided**, same as `window.confirm` before it: a JS modal
  blocks the whole WebView. The map's name is an inline field in the bar, which
  is not a dialog at all and doubles as the "what is this called" display.

  **CARVE — half-landed, and said so rather than faked** (`carve.ts`, 12 tests).
  The carve itself is real: the region maths, the SHARED-TAKE invariant (a
  carve copies no audio — the track points at the same take with a trim, so a
  session never duplicates and a carve that copied would grow the session by
  the take's length every time, which it would take a full disk to notice), and
  freeing the tape LAYER while the strip keeps its key, name, cell, level, mute
  and sends — "freeing = clearing the layer, not destroying the audio", so the
  object you were looking at is still there ready for the next capture.
  It REFUSES rather than producing a silent track: no tape, no take, loop off
  (carving something you cannot see is worse than declining), empty or inverted
  region.

  What is NOT landable: writing the track into a SESSION. Same blocker as the
  grid creation gesture — `companionEngine` holds one session with no deck axis.
  So the button performs the half it can and refuses the half it cannot, out
  loud, keeping the region in the note. Clearing the tape while silently
  dropping the track would destroy the user's region, which is the one outcome
  STRIP-MODEL's "nothing is lost" forbids.

  **`mapPackage` — the FORMAT and the UNPACK path, done** (`mapPackage.ts`, 10
  tests). Collect-on-export copies every referenced take beside the document AND
  REWRITES the refs to point inside — without the rewrite the document still
  names the old absolute paths and the collected audio is dead weight, bigger
  AND still broken. A take two strips share is collected once (one take
  underlies a scrubbable tape and any grid track carved from it). A take that
  cannot be read is REPORTED, never silently omitted, and the pack still
  succeeds: an incomplete package beats none, and the strip says "audio missing"
  honestly. Unpacking tolerates a Finder-zipped folder and its `__MACOSX` tree —
  the one workflow a user without an export button actually has — and REFUSES a
  package carrying a newer map, so a package cannot become a way around the
  version discipline.

  **EXPORT — DONE, natively** (`slMap/export`), and the split is the interesting
  part. `packMap` needs take BYTES, and handing those to the web layer would
  mean base64 over the JSON bridge for files capped at **256 MB** — ~350 MB of
  string per take, which is not slow but fatal. Equally, the shell cannot decide
  WHICH takes to collect without parsing the document, which it must never do.

  So: **TS decides what, the shell moves bytes.** `planPackage(map)` returns the
  already-rewritten document plus the file list by path; `slMap/export` copies
  those files and writes the archive. Neither side learns the other's job and no
  audio crosses the bridge. Building a second zip WRITER in TS to route around
  it would have been wrong twice over — a hand-mirrored format, and megabytes
  moved for nothing.

  Proven in `plane_audio_test` §14: a REAL zip a real reader opens, with the
  take actually inside, the document byte-identical to what TS handed over, a
  missing take NAMED rather than silently dropped, and no staging temporary
  left behind.

### Honest scope

Step 4 is roughly **15%** done — measured by what is usable, not by code
written. Increment 1 (tape strip, audible, save/load) is real and now proven.
Increments 2–6 — input source picker, grid strips, routing cables and the
matrix, the master section, the Inspector, carve, mapPackage — are not built.

Next: **the run-pass is yours** (kickoff law 5 — the agent cannot see the
screen). `WizardMerged` opens the plane as its main window, and a strip now
arrives with its input patched, so REC captures immediately. `compose ⇱` opens
the real grid composer in its own window.

## Nothing is committed

Both repos are dirty with this work. Commits and pushes are the user's call
(kickoff law 6). `apps/wizard` pushes to the **scoopy** remote, never `origin`.
The wire touches both repos, so the documented flow puts the scoopy commit
(`schema.ts` + `protocol:generate`) **before** wizard's `engine:sync`, or
`engine.lock.json` records a `sharedCommit` that does not contain the schema it
is pinning.
