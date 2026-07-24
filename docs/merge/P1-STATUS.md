# P1 status — where the merge actually is

*Companion to `P1-KICKOFF.md` (the brief, written at the close of P0 and left
unedited as the historical record). This file is the CURRENT state. Updated
2026-07-24.*

## Queue

| # | Item | State |
|---|---|---|
| 1 | P0-B remainder — CI | **done** (`5f7e796`) |
| 2 | P0-B remainder — engine vendoring lock | **done** (`8e04212`) |
| 3 | P1 spike — JUCE WebView | **done, no disqualifier; all 4 questions answered** (`900a7a7`) — verdicts in `P1-SPIKE-JUCE-WEBVIEW.md` |
| 4 | P1 plumbing | **engine side done; UI wiring remains** — see below |

### P1 plumbing detail

- **CMake target for the vendored core** — done (`ec376d5`). `vendor/CMakeLists.txt`
  is a wizard-owned wrapper around the hash-pinned tree; ten scoopy DSP/ABI
  gates now run under ctest.
- **`sl_engine.h` v3** — done for §1–2 (`48edb7a`): `sl_abi_version`, unified
  create, planar `sl_render`/`sl_render_io`. **§3–8 are NOT declared** (ABI.md:
  declare only what is implemented).
- **Render into `AudioIO`** — done (`ee9a3a1`). `AudioIO` drives a `RenderSink`;
  `SlRenderSink` and `WzRenderSink` are the two adapters.
- **`sl_engine.h` v3 §6 session snapshots** — done (`f460385`, this increment).
  The 112-entry keyed track-param mapping is GENERATED from the pinned v2 ABI,
  not hand-ported, with a CI gate proven to bite. `sl_snapshot_test` shows a
  committed world with a registered sample rendering non-silence — the engine
  half of `.scoopySession` playback works.
- **slCommand boot handshake** — done (`13c24ff`). `SlDispatch` answers
  `getCapabilities` (the merged host's REAL caps, schema v86) + the settings
  quartet + `getUiState`, GUI-free and headless-tested (`sl_dispatch_test`).
  Replaces the spike's fake dispatcher. Not yet wired into the live window.
- **GridPanel + transport live / `.scoopySession` plays** — **in progress.**
  The remaining path to "scoopy landed" is three increments (below).

### Remaining path to "scoopy landed here" (in order)

1. **Play path — ✅ NATIVE HALF DONE (Option B, chosen by the user 2026-07-24).**
   Why Option B: scoopy's document → engine is a 505-line load-bearing
   translation (`worldFromSession.ts`: `sectionA…sectionH` scene projection,
   kit-held sample identity, ~90 fields, enum orders where wrong = low-pass
   renders as notch) that already exists twice (Swift + TS). Rather than fork a
   third C++ copy, the heavy translation stays in TS; the merged host's web layer
   publishes the flat `World` **keyed by engine name** and the native side is a
   generic applier.
   - `0016e4e` — `SlWorldApply` (`registerSample` + `applyWorld`): a generic,
     name-driven applier with NO field mapping in C++ to drift. `sl_world_apply_test`:
     a name-keyed World renders peak 0.36; unknown param ignored; empty-tracks
     stops sound; holey worlds / deck>0 / null engine refused with a reason.
   - `1566034` — wired into `SlDispatch`: `worldPublish` routes to `applyWorld`.
     Contract: this host's `worldPublish` carries a flat `world` OBJECT (engine-
     name-keyed), not scoopy's stock `json` PatternFile string, which is refused.
   **Still needed for the play path to run end-to-end:** the `apps/scoopy` web
   change — the merged host runs `worldFromSession` and publishes `World` (renamed
   to `SL_T_*` via its worklet table) to native over `worldPublish`. Touches the
   writable home; small and additive. Sample sourcing (kit bytes → `registerSample`)
   is the other half — likely native decode of kit files, not JSON floats.
2. **HotFrame emitter.** Produce scoopy's 284-slot frame at 30 Hz from v3 engine
   state, so meters/playheads/carve go live. Indices from scoopy's schema
   (`HOT_FRAME_SCALARS`), never hand-counted.
3. **Live window + self-contained hosting.** Wire `SlDispatch` + the play path +
   HotFrame into a real `WebBrowserComponent` window serving scoopy's UI, and
   vendor scoopy's `webdist` hash-pinned (runtime bytes ~2.3 MB; the 3.5 MB of
   sourcemaps can be excluded) so the merged repo hosts scoopy without the
   sibling checkout. This is the increment that makes "scoopy lands here"
   literally true.

## Decisions taken during P1 (and why)

1. **v3 and v2 can never share a link line.** v3 reuses v2's spellings with
   different signatures. `slengine/` links the vendored *core* (`scoopy_engine`)
   and NOT the vendored v2 ABI (`sl_engine`), which also keeps v2's include dir
   off the search path so `"sl_engine.h"` there unambiguously means v3. Wiring
   both in fails the link on duplicate C symbols — the correct loud failure.
2. **The device layer is engine-agnostic** (`RenderSink`). P1 runs both engines
   side by side; the P3 ownership flip becomes a change of which sink the shell
   constructs. Not a template — one virtual call per chunk, not per sample.
3. **`setSampleRate` belongs to the sink.** SL v3 refuses a rate change on a
   running engine (it reallocates the buffers the callback reads), so
   `SlRenderSink` performs the stop → set → start rebuild. That is
   D-WZ-RATE-01's "tears down and rebuilds at the host layer", and the sink is
   that layer.
4. **Adapters are one-per-header.** A combined header made the shell drag
   scoopy's whole core onto its link line to name a type it does not use.
5. **The ctest registration for vendored gates lives in `vendor/CMakeLists.txt`**,
   not in the pinned tree — editing the pinned copy would fail `engine:check`.

## The next increment

**Resolved: the §6 blocker below is done** — the mapping was generated rather
than hand-ported, exactly as this section recommended (route 1). Kept for the
reasoning, which still governs any future re-derivation.

What remains for the kickoff's last bullet is UI-side: the shell's
`CommandDispatch` answering scoopy's command surface (`getUiState`, `gridEdit`,
`publishTrackPattern`, transport) against a real v3 engine instead of the
spike's stub. The spike proved the transport; nothing about it is unknown.

**⚠️ Known limitation to carry forward:** `sl_snapshot_begin` declares the deck
axis but REFUSES any deck > 0 — the vendored core holds one sequencer world, and
giving it more is a CORE change that belongs in `apps/scoopy`, the only writable
home until the P3 flip. Multi-deck sessions need that change first.

### Historical: why the mapping is generated

**The blocker was not design, it was volume.** v2's keyed-param layer (the
`SL_T_*` / `SL_TA_*` enums plus the switch that maps ~60 keys onto
`NativeTrackSnapshot` fields) lives in `vendor/scoopy/engine/src/sl_engine.cpp`,
which v3 cannot link. So v3 needs its own mapping, and that mapping is ~250
lines of exactly the "hand-mirrored table" this codebase has been bitten by
before (see the warning on `sl_param_id` in the vendored v2 header: a
mis-mapped field is written into the WRONG parameter, which is worse than not
being carried at all).

**Do not hand-write it in one sitting.** Options, in the order they should be
considered:

1. **Generate it.** The enum → field mapping is derivable from the vendored v2
   source. A codegen step that reads the pinned `sl_engine.cpp` and emits v3's
   mapping keeps ONE authority and makes drift a build failure — consistent
   with how this repo already treats protocol/HotFrame indices.
2. **Name-only surface.** v3 exposes `sl_track_param_id(name)` and nothing
   enum-shaped, so no C enum is duplicated. Still needs the switch internally.
3. **Hand-port with a coverage gate first.** If ported by hand, the
   abi-coverage gate for the track params must land in the SAME increment, not
   after — that gate is the only thing that would catch a mis-mapped field.

Whichever route: `abi-coverage carried-or-waived` (kickoff §4) should stand up
with this surface. It cannot stand up before — v3 has no params or HotFrame
yet, so today it would be nothing but waivers.

## Gates

- native `ctest`: **43/43** (31 wizard + 10 vendored scoopy + `sl_abi_v3_test` +
  `render_sink_test`)
- web: **131 tests / 19 files**, six gates green (`protocol:check`,
  `shared:check`, `engine:check`, `abi:check`, `check:tokens`, `webdist:check`)
- CI runs all of the above on macOS + Linux.

Of the kickoff §4 gate list: `abi_fidelity_test` is standing (as
`scoopy_abi_fidelity_test`). The **scoopy null test is NOT standing** — 
`scoopy_render_null` is a dump tool whose verdict comes from differencing two
platforms' dumps (`tools/null_test.py`), so it needs a CI job that builds on
both and compares, not a ctest case. That job does not exist yet.

## Outstanding, not mine to close

- ~~Human pass on spike Q1/Q3~~ — **DONE 2026-07-24, both PASS.** It found a
  real defect: an apparent "file drop reloads the webview" defect (`P1-SPIKE-JUCE-WEBVIEW.md` §Q3).
  **RETRACTED** — a clean drop-only run (2 drops, 0 keystrokes) showed 0 reloads
  and no navigation attempt. The reload came from the run with 187 keystrokes
  (stray ⌘R), not the drop. A navigation guard WAS added to the shell anyway
  (`c1176db`) and is kept on its own merit — the shipping shell had no
  navigation policy at all — but it is defence in depth, not a drop fix, and
  would not have stopped a ⌘R reload. File drop belongs in the PAGE
  (`dataTransfer`, which carries filename and MIME), not a native
  `FileDragAndDropTarget`.
- **Nothing is pushed.** `apps/wizard` is 8 commits ahead; `shared/` is 3 ahead
  (the `--lock` flag and two follow-ups). Note `origin` still points at the old
  `wizard.git` while `main` tracks `scoopy` — a bare `git push` may not go where
  intended. Pushes are the user's call (kickoff law 6).
- **Directory rename** (`apps/wizard` → ?) still deferred.
