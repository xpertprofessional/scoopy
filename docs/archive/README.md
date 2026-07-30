# docs/archive — history, never a spec

Everything in here is a **write-once historical record**: pre-merge plans, superseded
designs, and decision drafts whose every question has since been signed into
`docs/DECISIONS.md`. Nothing here is authority for what the app should do.

- Orient on `docs/merge/P3-LEDGER.md`; law lives in `docs/DECISIONS.md`.
- The `pd-*.md` files are the wizard-era plane design studies (pre-merge design
  intent). Archived per D-SL-ARCHIVE-01, settling the question D-4 left open.
  Where they conflict with signed decisions (D-SL-MORPH-01, D-SL-DECKFULL-01, …),
  the decisions win.
  ⚠️ **`pd-visual-language.md` was not purely speculative, and archiving it hid
  live rules** — §2.4 (one control-height token) and §2.5 (the label · bar ·
  value row idiom) describe what this tree actually does and what
  `check:tokens` enforces. Found out the hard way on 2026-07-31, when a deck row
  shipped with a bare range input and hand-set heights. Those rules now live in
  **`docs/DESIGN.md`**, which is where to look; this file keeps the fuller
  study and the reasoning behind them.
- `MIGRATION.md` is wizard's pre-merge ledger. `STRIP-MODEL.md` was superseded by
  D-SL-MORPH-01. The `P1-*`/`P2-*` files are pre-merge phase plans/status.
- Source comments still cite these documents by name (e.g. STRIP-MODEL's channel
  laws) — those citations are to the *ideas as recorded here*, which is exactly
  what an archive is for. Do not edit these files; do not cite them as open intent.
