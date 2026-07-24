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
| 4 | P1 plumbing | **3 of 4 bullets done** — see below |

### P1 plumbing detail

- **CMake target for the vendored core** — done (`ec376d5`). `vendor/CMakeLists.txt`
  is a wizard-owned wrapper around the hash-pinned tree; ten scoopy DSP/ABI
  gates now run under ctest.
- **`sl_engine.h` v3** — done for §1–2 (`48edb7a`): `sl_abi_version`, unified
  create, planar `sl_render`/`sl_render_io`. **§3–8 are NOT declared** (ABI.md:
  declare only what is implemented).
- **Render into `AudioIO`** — done (`ee9a3a1`). `AudioIO` drives a `RenderSink`;
  `SlRenderSink` and `WzRenderSink` are the two adapters.
- **GridPanel + transport live, load/play a `.scoopySession`** — **NOT STARTED.**
  Blocked on the session-snapshot surface; see below.

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

## The next increment, and its real blocker

`.scoopySession` playback needs SL-ABI-V3 §6 — the session snapshot surface:

```
sl_engine_register_sample · sl_snapshot_begin(deck, …) · track_begin/set/
set_array/end · sl_track_param_id · sl_track_array_id · sl_snapshot_commit
```

**The blocker is not design, it is volume.** v2's keyed-param layer (the
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
  real defect: a file drop RELOADS the webview (see `P1-SPIKE-JUCE-WEBVIEW.md`
  §Q3). Drop-navigation must be refused at the webview navigation policy before
  any drop-to-load feature is wired, and file drop belongs in the PAGE
  (`dataTransfer`), not a native `FileDragAndDropTarget`.
- **Nothing is pushed.** `apps/wizard` is 8 commits ahead; `shared/` is 3 ahead
  (the `--lock` flag and two follow-ups). Note `origin` still points at the old
  `wizard.git` while `main` tracks `scoopy` — a bare `git push` may not go where
  intended. Pushes are the user's call (kickoff law 6).
- **Directory rename** (`apps/wizard` → ?) still deferred.
