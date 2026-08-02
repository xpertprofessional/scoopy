# Scoopy (merged wizard + scoopyloops tree) — agent orientation

## Work moves in BUNDLES, not rows

**The unit of work is a donor binding, not a ledger row** (user ruling
2026-07-30, hoisted to `PARALLEL-PROTOCOL.md` §0). The donor's protocol answerer
is 15 `Web*Binding.swift` files / ~7k lines; **what never came across is the
bindings**, which is why 48 of 86 protocol commands are answered by *nobody* in
the merged host and whole features (deck transport, scenes, audio devices, MIDI)
are dead or doorless. A bundle = one binding's worth of shell/engine seam + web
UI + a **visible door reachable in the real host** + tests. No LOC cap; several
commits, each green. The ledger's **BUNDLES** section (B1–B8) is the queue.

## Orient here, in this order
1. `docs/merge/P3-LEDGER.md` — the ACTIVE work queue: **BUNDLES section first**,
   then the phase blocks for unclaimed rows. Done rows carry one-line summaries;
   their full handoff notes live in `docs/merge/P3-LEDGER-ARCHIVE.md` — dig there
   only when a specific done row's detail matters.
2. `docs/ARCHITECTURE.md` §11 — the loop protocol every session follows
   (rewritten 2026-07-31 for the merge; §1–§10 and §12 are wizard-era frozen
   reference, and §3 is self-marked historical).
3. `docs/DECISIONS.md` — the signed law, append-only. The **live decision
   backlog** is `docs/merge/PARALLEL-PROTOCOL.md` §10 "Awaiting the user".
   (`docs/archive/MORNING-DECISIONS-2.md` is history: every decision in it is
   signed. Do not orient on it.)
4. `docs/DESIGN.md` — **read before adding any UI control.** The control
   vocabulary (`GeoRange` / `DragBox` / `Button`, never a bare range input), the
   one control-height token, the four transport glyphs ⟳ ▸ ↻ ◼, and the rule
   that a disabled control must say why. Short, and every rule in it is one the
   CSS or `check:tokens` already enforces.
5. `docs/merge/PARALLEL-PROTOCOL.md` — **§0 is the donor-binding ruling**; read
   it. The rest is the conductor/lane contract, currently **PARKED** — bundles
   run single-session by user ruling. Its §8 is the recipe for reviving lanes
   (the worktrees and the `ledger-lane` agent type are still on disk) when two
   bundles are genuinely disjoint.

`docs/archive/` is history — never a spec, never an orientation target.

## The original app is one directory over — READ IT

`../scoopyloops` (i.e. `/Users/tobiasjansen/xpert/apps/scoopyloops`) is the
**shipping ScoopyLoops app this project is migrating from**: ~98 Swift files
under `ScoopyLoops/`, plus `ScoopyLoopsTests/`. It builds and the user can run
it. **It is the behaviour reference, and it is the answer to most "what should
this do?" questions.**

⚠️ **Do not confuse it with `ScoopyLoops/` inside THIS repo**, which is only the
27-file vendored C++ DSP core (`NativeAudioEngineCore` and friends). The two are
different things and the name collision has already cost this project real time.

**Before designing a behaviour from scratch, check whether the original already
answered it** — gestures, defaults, edge cases, what a door does when it cannot
do the thing. The merged app inherited the DSP intact but **none of the Swift UI
or document layer came across**, so a row that reads like a design question is
usually a port whose reference is sitting right there. Ask the user to run it
when reading is ambiguous; they can compare directly.

⚠️ **Only the SWIFT is the donor.** `../scoopyloops/web/**` is **this project's
own web tier, frozen at 2026-07-27** — that repo took four merge commits
(`P0-A` · `P1` · `P2-4` · `P2-5`) before the P3-0 collapse moved everything here,
so citing its TypeScript as "what the original did" is circular. Its 370-commit
history also shows the app was pure SwiftUI first and was *itself* mid-migration
to a web UI ("Migration P0-04: web workspace scaffold"), so for anything older
than that migration the SwiftUI views are the reference.

Search it scoped and read-only:
- `../scoopyloops/ScoopyLoops/*.swift` — **the donor**, ~100 files / 64k LOC.
  `WebEngineLink.swift:365-559` is the index: an exhaustive dispatch `switch`
  over all 84 protocol methods, which Swift enforces has no `default`.
- `../scoopyloops/ScoopyLoopsTests/` — pinned behaviour, often the fastest answer.
- `attic/` — retired code: history, never a spec.

**Never write to that repo, never commit in it, never run its build.**

**The four rules:** tests pass ≠ it works ≠ it shipped ≠ you can reach it. Green gates
in Chromium repeatedly missed features unreachable in the real app — every UI claim
needs a visible door reachable in the JUCE WKWebView host (WizardMerged), not a
synthetic event.

## NEVER read, grep, or fan agents into these
They are vendored, generated, or build output — and the reason naive searches here
take forever (15k files on disk, >1GB of it build trees):

- `ThirdParty/` — vendored JUCE, ~3,900 files (deliberately committed; do not touch)
- `engine/ThirdParty/` — libsamplerate, incl. a 9MB coefficient header
- `vendor/`, `build/`, `build-*/`, `web/node_modules/`, `web/dist/`
- `webdist/` — COMMITTED built bundles + multi-MB sourcemaps; regenerate, never edit
- `web/src/audio/scoopy-engine.js` — gitignored Emscripten `-sSINGLE_FILE` output
  (WASM embedded as base64 — it is supposed to look like binary garbage). Regenerate:
  `cd engine && emcmake cmake -B build-wasm && cmake --build build-wasm`
- `web/fixtures/**` — many 500KB+ JSONs; open only the specific fixture a test names

Scope searches to the hand-written source: `web/src`, `web/protocol`, `shell/`,
`slengine/`, `ScoopyLoops/`, `engine/src`, `host/`, `docs/` (`spike/` is gone — H1).

## Known non-bugs — do not "fix"
- `web/src/plane/` uses single-quote imports vs double quotes elsewhere — two
  authorship eras, harmless.
- `SAMPLE_DRAG_TEXT_TAG` in `web/src/panels/FileBrowserPanel.tsx` deliberately uses
  `\u0001` sentinel characters — keep them escaped, never as raw bytes.

## Verify (the gate for every commit in a bundle)
- C++: `ctest --test-dir build --output-on-failure`
- Web (in `web/`): `npm run typecheck && npm test`
- **Drift gates — run all ELEVEN every session, not only when a row names one**
  (2026-07-29: two were RED at HEAD and one uncovered two real UI defects):
  `params:check` · `shared:check` · `worldmap:check` · `hotframe:check` ·
  `tape:check` · `trackparams:check` · `webdist:check` · `check:tokens` ·
  `schema:check` · `nativemethods:check` · `faces:check`.
  `faces:check` is the newest (2026-08-02, D-SL-STUDIO-01 L1): a FACE composes
  blocks and never rebuilds one, because six products share one bundle and
  differ only in which blocks they mount, what `getCapabilities` answers, and
  `viewDensity`. It exists because that had failed twice — `PluginDeckPanel`'s
  hand-wired first cut left PERF doing nothing, and `CompanionPanel`'s
  hand-written save lifecycle had silently lost half its job. ⚠️ It deliberately
  does NOT try to detect a rebuilt transport by its glyphs: measured, those
  appear legitimately in tooltips, in prose and as the tape's own transport, and
  a gate needing an allowlist on day one is not a gate.
  `schema:check` (H5-a, 2026-07-30) was added because three
  hosts were reporting three different protocol versions — schema.ts 96,
  `getCapabilities` 92, `kScoopySchemaVersion` 88 — while `sl_dispatch_test`
  **asserted the stale 92**, so ctest defended the drift for four bumps.
  Older docs and ledger rows say "eight"; this list is the count.
  `nativemethods:check` (2026-07-30) exists because the same
  defect shipped TWICE: a method the shell implements but `MergedLink.NATIVE_METHODS`
  omits falls through to `BrowserLink` and throws, and callers swallow it — so the
  feature is silently unreachable **in the real host only**. It caught `fxSlot`
  (v95's headline) and `getFxSlotState` (v96) already shipped broken.
  `engine:check` drift is pre-existing and recorded in P6-3.
  ⚠️ **There is no `protocol:check` script** — older docs and ledger gate lines
  name it; `web/package.json` is the authority.
- `npm run bundle` must be the LAST step before `git add`, or `.buildhash`
  records a tree that no longer exists (the P3-X4 lesson).
- ⚠️ **ANY WEB CHANGE STALES THE PLUGINS — the heading below says "plugin work"
  and that is too narrow.** The plugins embed the WHOLE bundle, so a commit that
  touches a face nowhere near them still leaves their binaries serving an older
  UI. Measured 2026-08-02: four web commits in a row, each green on its own
  gates, and `plugin:check` was RED the whole time because nothing rebuilt the
  targets in between. Treat the rebuild as part of bundling, not part of plugin
  work, and **run `plugin:check` in the same sweep as the other gates.**
- ⚠️ **PLUGIN WORK: bundling is not enough, and the failure is silent.** The app
  serves `webdist/` off disk; a PLUGIN links it *into the binary* (a plugin is
  copied to machines that never saw this tree). So a DAW runs the UI frozen at
  the last `cmake --build`, and a web fix tested there looks exactly like a fix
  that did not work. This cost two full round-trips on 2026-08-01 — a playhead
  fix verified by pixels was reported dead twice because it was never in the
  binary. After bundling, for anything a DAW will load:
  `cmake --build build --target ScoopyDeck_All ScoopyTape_All`, then **reload the
  plugin in the host** (DAWs cache the binary in-process). `npm run plugin:check`
  is the gate — it fails when the built plugin embeds an older bundle than
  `webdist/`.
- Bundle + `webdist/` freshness and the Chromium walk gates per the ledger row's gate
  line. **Never commit a red tree.** One coherent step per commit — a bundle spans
  several; the ledger row closes on the last one.
- ⚠️ Other agents edit this tree concurrently: `git add` **explicit paths**, never
  `git add -A`.
