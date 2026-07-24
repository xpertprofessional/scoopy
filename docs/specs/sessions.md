# Session spec (P7 domain)

*Governs P7-02..P7-07. Laws: preserve-don't-drop (ARCHITECTURE §7.3), TS owns the
document. Signed inputs: D-WZ-RATE-01 (takes are at the engine rate),
D-WZ-DECKSRC-01, D-WZ-CORE-02. Sibling precedent: ScoopyLoops' STORED-zip package
discipline, Parlante's golden-corpus round-trip gate.*

**The problem this solves is immediate, not theoretical:** today, closing Wizard destroys
the patch. Every strip you bound, every deck you added, every loop region you dragged is
gone. Takes survive (they are files) but nothing knows they belonged together. A user who
hits this once stops trusting the app with real work.

## 1. What a session IS

A **session** is the Patch plus the identity of the audio it references — not the audio
itself, except where the audio has nowhere else to live.

| Thing | In the session? | Why |
|---|---|---|
| Patch (channels, decks, buses, uiMode, geometry) | **yes**, verbatim | it *is* the document |
| Takes (recorded WAV + sidecar) | **by reference**, with an optional embed | they are already durable files (P3-04); copying them by default would duplicate gigabytes |
| Loaded sample files (user's own audio) | **by reference only** | never copy a user's library into our package |
| Device selection | **yes**, as a name + a fallback | a session opened on another machine must degrade, not fail |
| Engine/runtime state (playheads, meters, ASRC) | **no** | derived; restoring it would be theatre |

## 2. Container

Two forms, one schema:

- **`.wizard` package** — a STORED (uncompressed) zip: `session.json` + `Takes/` +
  `Samples/`. STORED because the payload is already-compressed audio and because a
  non-deflated zip is byte-stable, which is what makes the golden-corpus gate meaningful.
- **Autosave** — the same `session.json` written to an app-support path on a debounce.
  This is what actually saves users; the package is what they *share*.

## 3. Preserve-don't-drop (the law, restated for sessions)

`session.json` is parsed with the **strict** schema. Unknown keys are a **loud failure**,
never a silent drop — because a silent drop means a newer Wizard's session, opened in an
older one and re-saved, quietly loses data. Concretely:

- Reading a session with a **newer** `schemaVersion` → refuse with a clear message
  ("saved by a newer Wizard"), do not partially load.
- Reading an **older** version → migrate explicitly, one step per version, each migration
  a named function with a test. Never a best-effort spread.
- A reference that no longer resolves (a take deleted, a sample moved) → the strip/deck is
  **kept, marked unresolved, and silent** — identical to the vanished-source posture the
  whole app already takes (CONCEPT §3). Never dropped from the document.

## 4. Autosave & crash restore

- Debounced write (≈2 s after the last edit) to `session.json` in app support, plus a
  `session.json.bak` rotated on each successful write — so a crash *during* a write
  cannot leave zero readable files.
- Write is **atomic**: write to a temp file, fsync, rename. A half-written session is the
  one failure mode that would make autosave worse than nothing.
- On launch: load autosave if present; if it fails to parse, fall back to `.bak` and say
  so; if both fail, start empty and **keep the corrupt file** (never delete evidence).

## 5. What restoring actually does

Restoring is a **publish**, not a special path: the Patch is loaded into the store and
published to the engine exactly as an edit would be — so there is one code path and no
"restore-only" bugs. Deck buffers are then re-loaded from their take/sample references
(off-thread, D-WZ-DECKSRC-01), and each deck lands `idle` — **never auto-playing**: an app
that starts making sound on launch is hostile.

## 6. Fixtures

1. `session_roundtrip_test` — a fully-populated Patch (all source kinds, 8 decks, buses,
   loop regions, varispeed rates) → save → load → **deep-equal**, and the re-save is
   **byte-identical** (golden corpus).
2. `session_preserve_test` — a session containing an unknown key fails loudly; a newer
   schemaVersion refuses; an older one migrates through named steps.
3. `session_unresolved_test` — a take referenced but missing → the deck survives, marked
   unresolved, silent; re-saving still carries the reference.
4. `session_atomic_test` — a write interrupted (temp file left behind) leaves the previous
   session intact and loadable.

## 7. Order (ledger P7-01..)

spec (this) → schema `Session` envelope + migration scaffold → autosave/restore in the
shell (atomic write, .bak rotation) → package save/load (`.wizard` STORED zip) →
unresolved-reference posture → golden-corpus + atomicity fixtures → P7-AUDIT → gate.

## 8. Interaction with PD-CANVAS (morning decision #1)

If the unified-cell canvas is adopted, Cells gain `x, y, w, h`. That is an **additive**
schema change, so sessions written before it migrate by auto-layout (pd-canvas.md §5) —
which is precisely why migration is a named, tested step per version rather than a
best-effort merge. Building sessions now does not prejudge that decision.
