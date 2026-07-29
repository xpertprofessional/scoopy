# Scoopy (merged wizard + scoopyloops tree) — agent orientation

## Orient here, in this order
1. `docs/merge/P3-LEDGER.md` — the ACTIVE work queue. Done rows carry one-line
   summaries; their full handoff notes live in `docs/merge/P3-LEDGER-ARCHIVE.md` —
   dig there only when a specific done row's detail matters. (`/MIGRATION.md` is
   wizard's pre-merge record — historical, do not orient on it.)
2. `docs/ARCHITECTURE.md` §11 — the loop protocol every session follows.
3. `docs/merge/MORNING-DECISIONS-2.md` — open user decisions; rows marked
   `awaiting-decision` are skipped, `provisional(D-n)` may build the recommendation.

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
- Web (in `web/`): `npm run typecheck && npm test && npm run protocol:check`
- Bundle + `webdist/` freshness and the Chromium walk gates per the ledger row's gate
  line. Never commit a red tree; one ledger item per commit.
