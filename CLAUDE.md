# Scoopy (merged wizard + scoopyloops tree) — agent orientation

## Orient here, in this order
1. `docs/merge/P3-LEDGER.md` — the ACTIVE work queue. Done rows carry one-line
   summaries; their full handoff notes live in `docs/merge/P3-LEDGER-ARCHIVE.md` —
   dig there only when a specific done row's detail matters. (`/MIGRATION.md` is
   wizard's pre-merge record — historical, do not orient on it.)
2. `docs/ARCHITECTURE.md` §11 — the loop protocol every session follows.
3. `docs/merge/MORNING-DECISIONS-2.md` — open user decisions; rows marked
   `awaiting-decision` are skipped, `provisional(D-n)` may build the recommendation.
4. `docs/merge/PARALLEL-PROTOCOL.md` — read this if more than one agent is working
   the ledger. It names who may bundle, commit, run `ctest` and run the walks, and
   carries the measured known-red baseline. **While lanes are live, only the
   conductor commits to `host-hygiene`.** Its §2 also corrects two stale claims
   this file and §11 still make (see the gate list below).
   **To pick the multi-agent loop back up in a fresh session, start at its §8** —
   the lane worktrees, the `ledger-lane` agent type and every ruling are already
   on disk; only the agents' warm context is lost.

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

Scope searches to the hand-written source: `web/src`, `shell/`, `slengine/`,
`ScoopyLoops/`, `engine/src`, `host/`, `spike/`, `docs/`.

## Known non-bugs — do not "fix"
- `web/src/plane/` uses single-quote imports vs double quotes elsewhere — two
  authorship eras, harmless.
- `SAMPLE_DRAG_TEXT_TAG` in `web/src/panels/FileBrowserPanel.tsx` deliberately uses
  `\u0001` sentinel characters — keep them escaped, never as raw bytes.

## Verify (the gate for every increment)
- C++: `ctest --test-dir build --output-on-failure`
- Web (in `web/`): `npm run typecheck && npm test`
- **Drift gates — run all NINE every session, not only when a row names one**
  (2026-07-29: two were RED at HEAD and one uncovered two real UI defects):
  `params:check` · `shared:check` · `worldmap:check` · `hotframe:check` ·
  `tape:check` · `trackparams:check` · `webdist:check` · `check:tokens` ·
  `schema:check`.
  `schema:check` is the newest (H5-a, 2026-07-30) and was added because three
  hosts were reporting three different protocol versions — schema.ts 96,
  `getCapabilities` 92, `kScoopySchemaVersion` 88 — while `sl_dispatch_test`
  **asserted the stale 92**, so ctest defended the drift for four bumps.
  Older docs and ledger rows say "eight"; this list is the count.
  `engine:check` drift is pre-existing and recorded in P6-3.
  ⚠️ **There is no `protocol:check` script** — older docs and ledger gate lines
  name it; `web/package.json` is the authority.
- `npm run bundle` must be the LAST step before `git add`, or `.buildhash`
  records a tree that no longer exists (the P3-X4 lesson).
- Bundle + `webdist/` freshness and the Chromium walk gates per the ledger row's gate
  line. Never commit a red tree; one ledger item per commit.
