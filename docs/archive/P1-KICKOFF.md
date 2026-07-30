# P1 Kickoff — loop-session brief

Written 2026-07-24 at the close of P0. This is the working brief for the long
engineering session that starts P0-B's remainder and P1. Read alongside
`~/.claude/plans/clever-stargazing-floyd.md` (the approved merge plan),
`SL-ABI-V3.md` and `MAP-SCHEMA.md` (P0-C), and `shared/ROLLOUT.md`.

## State of the world (verified today)

- **P0-A done** (scoopy repo, branch `phase3-native-carve-down`, commits
  `3c2eff7` MOD-12+tokens, `cbae0f1` P0-A — both UNPUSHED; pushing is the
  user's call). Scoopy speaks the shared envelope: schema v86, replies
  `{id, ok, result?, error?}`, every object `.strict()` (walker test
  enforces), shared `envelope/types/juceLink/codegen` vendored (lock
  `e0069f5`). A **dormant `JuceLink`** subclass sits in
  `web/src/engineLink.ts` waiting for a JUCE backend.
- **P0-C done**: `SL-ABI-V3.md` + `MAP-SCHEMA.md` in this directory.
- **P0-B partial**: this repo's `main` tracks remote `scoopy`
  (github.com/xpertprofessional/scoopy.git; `origin` still points at the old
  wizard.git — rename was permission-blocked). Wizard is synced to shared
  `e0069f5` (commit `f6a72ee`), tests 131/19 green, webdist fresh.
  **Remaining: CI + engine vendoring lock** (below). Directory rename
  (`apps/wizard` → ?) deferred to the user.
- Parlante: untouched, clean, shared copies warn-tier stale — out of scope.

## Work queue (in order)

### 1. P0-B remainder — CI for this repo
GitHub Actions (remote `scoopy`), mac + Linux:
- web: `npm test`, `tsc --noEmit`, `protocol:check`, `shared:check`,
  `webdist:check`, `abi:check`
- native: CMake build + wizard killtests green on both platforms
  (`deck_handoff_test`, `deck_stamp_test`, `wav_killtest`, `asrc_drift_test`
  — the P2 gate suite must already run in CI so P2 can't regress it)
- denormals=0 assertion stays in the test binaries.

### 2. P0-B remainder — engine vendoring lock
Vendor scoopy's portable core into this repo **hash-pinned** via the
`sharedSync.ts` mechanism (a second lock or an extended one): the
`Native*.{hpp,cpp}` set + `engine/` C-ABI tier from `apps/scoopy`.
**Dual-home law: `apps/scoopy` is the ONLY writable home of the core until
the P3 flip.** The lock exists so drift is detected, not prevented. CI runs
the check.

### 3. P1 spike — JUCE WebView hosts scoopy's real UI (DO THIS BEFORE P1 PLUMBING)
Host scoopy's committed `webdist/` in a JUCE `WebBrowserComponent` inside
this repo's shell and wire `CommandDispatch` to the dormant JuceLink contract:
- `slCommand` — JUCE native function; reply object `{ok, result?, error?}`
  (promise resolution carries it; the web side checks `ok !== true`).
- `slHotFrame` — event carrying the Float64 frame array.
- `slEvent` — engine events (`{type, ...}` per scoopy's EngineEvent union).
- `slUiState` — `{topic, state}` payloads.
- `slParam` — `{p, deck?, track?, v}` coalesced writes.
A stub dispatcher that answers `getCapabilities` and pushes a fake HotFrame
is enough to light the UI up. Spike QUESTIONS (each needs a written verdict):
key-event fidelity (Serato layout: key-repeat suppression, `event.code`,
held keys), multi-window (`DocumentWindow` × WebView for F1–F4/FX editors),
drag-in of files, OPFS availability. **Decision gate**: multi-window vs
one-window panel docking (fallback — scoopy panels are independent React
roots). If something disqualifies JUCE WebView entirely, STOP and report —
that is a D1-level finding, not yours to decide.

### 4. P1 plumbing (after the spike verdict)
- CMake native target for the vendored core (the Emscripten build already
  proves it compiles outside Xcode; `engine/build-wasm` recipe in scoopy).
- `sl_engine.h` v3 per `SL-ABI-V3.md`: `sl_abi_version`, unified create,
  planar `sl_render(e, float* const* bus_out, bus_count, frames)`.
- Render into wizard's `AudioIO`; GridPanel + transport live; load/play a
  `.scoopySession`.
- Gates to stand up in CI as they land: scoopy null test (−153 dB),
  `abi_fidelity_test` (−999 dB), abi-coverage carried-or-waived.

## Laws (do not bend)

1. Shipping scoopy ships from `apps/scoopy` untouched until P8 — only
   protocol convergence (done) and back-ported core fixes go there.
2. One writable engine home (`apps/scoopy`) until P3; merged repo consumes
   hash-pinned copies.
3. Never modify `Native*.cpp` in a UI increment (scoopy CLAUDE.md law).
4. Wizard killtests are ported, never rewritten.
5. Agents cannot see the UI: anything visual ends with "unverified on
   screen" until the user confirms — the spike's key/drag/window verdicts
   need a human pass; prepare exact repro steps for it.
6. Commit per completed increment with gates green; pushes are the user's
   call.

## Suggested kickoff prompt for the new window

> Read apps/wizard/docs/merge/P1-KICKOFF.md and work the queue in order:
> CI, engine vendoring lock, JUCE WebView spike, then P1 plumbing. Commit
> per green increment. Stop and report on any spike disqualifier or any
> gate that stays red after two distinct fix attempts.
