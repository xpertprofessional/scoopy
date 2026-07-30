# Parallel ledger execution — the conductor/lane contract

**Opened 2026-07-30.** How more than one agent works this ledger at once without
corrupting the tree. `P3-LEDGER.md` stays the work queue and the sole authority
on order; this file is only the *coordination* contract. If the two ever
disagree, the ledger wins.

Read this together with `docs/ARCHITECTURE.md` §11 (the loop protocol) and
`CLAUDE.md`. §11 still describes a single session doing everything; the split
below is how the same contract is honoured by several.

---

## 1. The shape: one conductor, three lanes

**The conductor** is the session holding the ledger. It exclusively owns every
resource that cannot be shared, because sharing it corrupts something:

| Resource | Why it cannot be shared |
|---|---|
| `docs/merge/P3-LEDGER.md` | one markdown table whose cells run to thousands of characters on a single line — git's line-level merge mis-merges two edits **silently** |
| `npm run bundle` / `webdist/` | `--emptyOutDir` wipes the directory; `.buildhash` is a digest of *all* of `web/src` + `web/protocol`, so a bundle run by one agent records the other's half-finished edits too |
| `git add` / commit / push | one ledger item per commit; `P3-PUSH` never pushes a red tree |
| `build/` + `ctest` | one shared ~1 GB CMake tree — concurrent builds race object files and `CMakeCache.txt` |
| `npm run walks` | `browser_plane_test.mjs` binds **4599** and `browser_session_walk_test.mjs` binds **4601** with no `strictPort` escape — a second run dies on `EADDRINUSE` |
| `MergedWalk`, `plane_audio_test`, `plugin_audible_test` | they open real windows and **take the audio device**; two at once fight over the sound card |

**The lanes** are long-lived subagents (`.claude/agents/ledger-lane.md`), resumed
with the next row rather than respawned, so repo knowledge stays warm.

- **Lane A — the main checkout, driven by the conductor itself**, not by a
  subagent. It takes the authority chain and every row needing C++, `ctest`, the
  walks, or the real host, and reuses the existing `build/`. The conductor and a
  Lane A subagent would be two writers in one tree, and the audio device and
  `build/` cannot be split anyway — so the roles are merged rather than raced.
- **Lanes B and C — git worktrees, web-only.** `../scoopy-lane-b` on `lane/b`,
  `../scoopy-lane-c` on `lane/c`. No CMake, no walks, no bundle.

### The rule that makes it safe

**Lanes never bundle and never commit to the shared branch.** A lane runs only
the cheap gates in its own tree — `typecheck`, `npm test`, and the nine drift
checks (pure read-and-compare node scripts, ~2 s for all nine, safe
concurrently). The conductor runs the exclusive gates at integration, one row at
a time, in the main tree:

> merge the lane branch → `ctest` → the walk or real-host proof the row's gate
> line names → `npm run bundle` **LAST** → `git add` explicit paths → commit →
> write the ledger row

Only one process ever bundles, and it bundles after every source edit for that
row — the P3-X4 lesson enforced by structure instead of by memory. Development
runs three-wide; integration stays serial, which is fine because integration is
not the slow part.

### Lanes return text; the conductor writes the ledger

A finishing lane returns its handoff note **as its final text**. It never opens
`P3-LEDGER.md`. That leaves zero merge surface on the one file every agent wants
to edit.

§11's no-orphan rule needs carrying explicitly across this split: *"Every
deferred / ⚠️ / half-built item a handoff note mentions gets its OWN `todo`
ledger row in the same commit."* A lane cannot write rows, so it must **return
its proposed follow-up rows as text** alongside its handoff note, and the
conductor adds them in the same commit. Skip this and parallelism quietly breaks
completeness.

---

## 2. Known-red baseline

Measured at `8d9a963`, 2026-07-30. Lanes compare reds against **this**, not
against assumption:

| Gate | State |
|---|---|
| `params:check` · `shared:check` · `worldmap:check` · `hotframe:check` · `tape:check` · `trackparams:check` · `webdist:check` · `schema:check` · `check:tokens` | **all nine GREEN** |
| `engine:check` (**not** one of the nine) | **RED, pre-existing** — `vendor/scoopy/engine/CMakeLists.txt` edited locally; the drift is recorded in P6-3 |

⚠️ **This corrects the ledger preamble at `P3-LEDGER.md:38-43`,** which says
`params:check` is RED because a concurrent `MergedApp.cpp` split moved
`kParamMap[]`. That was true when written; H5-a repointed the checker and it now
passes. A lane that trusts the preamble will chase a red that is not there.

Two stale statements in §11 that lanes must not follow:

- §11.1 says orient on `/MIGRATION.md`. `CLAUDE.md` overrides: that file is
  wizard's pre-merge record, **historical**. Orient on `P3-LEDGER.md`.
- §11.3 names `npm run protocol:check`. **There is no such script.**
  `web/package.json` is the authority; the gate count is **nine**.

---

## 3. Dispatch rules

A row may go to a parallel lane only if **all** hold:

1. It is at the head of the authority order (`P3-LEDGER.md:230-236`), **or** it
   is a `spec`/audit row producing no source change, **or** it is a P11 row —
   P11 is not sequenced in the authority block and rides off-chain, the same
   licence the H section took ("*not a phase — a cross-cutting cleanup*").
2. Its cited file set is disjoint from every in-flight claim in §5.
3. Its status is not `blocked(...)`, `awaiting-decision`, `awaiting-user`, or
   otherwise user-gated.
4. Rows whose notes warn **PREMISE FALSIFIED / ~⅔ FALSE / re-measure before
   building** — P7-T4, P7-N1, P7-K1, P7-T3, P3-SES-2 — are dispatched as
   *measure* rows first, never as build rows.

Human-gated rows (`P3-G1`, `P7-G1`, `P8-G1`, `P9-G1`, `P11-G1`, `P3.5-E9b`, and
the real-host walks pending on E7/E8a/E9a) are never dispatched. The conductor
collects them and posts "awaiting sign-off on: …" per §11.4.

### Couplings only the conductor may rule on

- **P3.5-E8b and P11-1 decide the same thing** — where the file browser lives,
  when P11-1 retires `≡ panels` entirely. The ledger says decide the home
  **ONCE** for both rows. They are therefore pinned to the **same lane, in
  sequence**, never concurrent.

  **RULED 2026-07-30 (conductor), adopting E8b's own standing recommendation:
  the file browser's home is a drawer inside the COMPOSE WINDOW** — "compose is
  where a person reaches for a sample." It does **not** go into
  `PANEL_MENU_SURFACES`. That is what makes the ruling survive P11-1: a door
  that never lived in `≡ panels` cannot be orphaned when `≡ panels` is retired,
  so E8b needs no rework and P11-1 inherits no obligation to rehome it.
- **P11-1's FX 1–4** wait on P7-MIX-0, so until then they need a named interim
  home "or the row is a REGRESSION in reachability." Naming it is a conductor
  call.
- **P11-1 SHIPS SCOPED, and `≡ panels` stays.** Same reasoning as the FX 1–4
  ruling, and Lane B found the wider case: `≡ panels` is the **only** door to all
  five `PANEL_MENU_SURFACES` — spectral · paintmode · midi · perf · capture —
  because `openPanelWindow` has exactly four call sites, all in `PlanePanel.tsx`.
  D-SL-TOPROW-01 names a new home only for *settings*. Retiring the button as the
  row is written orphans five surfaces, which is rule four. So P11-1 builds the
  re-zoning — the whole substance of the decision — and defers only the one
  retirement that has nowhere to go. `compose` may still leave the bar: every
  grid strip already draws `COMPOSE ⇱`, so it orphans nothing (P11-1-b).
- **P6-6c must carry its own live block-size source.** The ledger allows it to
  either follow P9-3(c) or do this; P9-3 is phases away, so the answer is fixed
  now and goes in Lane A's brief.

---

## 4. Creating a lane worktree

```
git worktree add ../scoopy-lane-b -b lane/b host-hygiene
cp -Rc web/node_modules ../scoopy-lane-b/web/node_modules   # -c = APFS clone, ~0 disk
cp -c  web/src/audio/scoopy-engine.js ../scoopy-lane-b/web/src/audio/
```

No `npm ci` (minutes, 125 MB) and no CMake configure — lanes never build C++.
The tracked tree is only ~115 MB and the `node_modules` clone is copy-on-write,
so a lane costs almost nothing on disk.

⚠️ **The third line is not optional.** `web/src/audio/scoopy-engine.js` is the
gitignored Emscripten output, so a fresh worktree does not have it — but
`webdistFresh.ts` walks all of `src/` when computing the hash (it skips only
dotfiles, `*.test.ts` and `*.bak`). Without the copy, `webdist:check` is RED in
the worktree from the very first minute even though the stored `.buildhash` is
byte-identical to main's. That costs a lane its most useful signal: with the
baseline green, a RED `webdist:check` means *"I changed something under
`web/src`"* and nothing else.

Verify a new worktree before dispatching to it — `npm run typecheck && npm test`
plus the nine gates must match §2 exactly.

## 5. Other sessions

More than one agent has always worked this tree. While lanes are live, **only
the conductor commits to `host-hygiene`**. A session that is not the conductor
and not a lane should either take the conductor role or stay read-only —
otherwise `webdist/.buildhash` and the ledger will disagree with the tree.

---

## 6. Claim table — conductor writes, lanes read

One row per lane. A lane's claim covers every file it may edit; overlapping
dispatch is refused.

| Lane | Tree | Row | Claimed paths | State |
|---|---|---|---|---|
| A | main checkout (conductor) | **P11-3a** — the scene queue that never fires in the real host | `web/src/audio/nativeAudio.ts` | next |
| B | `../scoopy-lane-b` (`lane/b`) | — | — | idle |
| C | `../scoopy-lane-c` (`lane/c`) | — | — | idle |

⚠️ **Keep this table honest or it lies to the next session.** It went stale for
a full cycle: it still read "B · P11-1 · in-progress" after B had been pulled off
P11-1 and onto E8g, while the Queued line below omitted P11-1 entirely and
Integrated listed neither E8g nor E8g-c. **Lane B caught it, not the conductor.**
Update this table at every dispatch and every integration, not at the end of a
cycle.

**Integrated, 2026-07-30:** P3.5-E10 · P3.5-E10b · P9-5b · the quantize spec
(conductor) · P3.5-E8b · P11-5 · P3.5-E8g · P3.5-E8g-c (Lane B) · P7-K0 ·
P8-1 · P9-5 (Lane C). Plus P3.5-E8f and P3.5-E9b **resolved by the user's walk**.
**Forty-odd follow-up rows** written from those handoffs.

**Queued:** A: E10a → P11-3a → P6-6a/b/c → P6-AUDIT → P3.5-E4.
B: P11-2 → P11-3c → P11-6 → P11-4 (last — the only MAP schema bump).
C: P11-AUDIT → P8-1's downstream specs.

**Not dispatchable, waiting on the user:**
- **P3.5-E8g's walk** — the compose header line now names the seam; it decides
  whether E8g-a is a C++ row or a decode row (E8g-b).
- **P11-1-a** — where spectral · paintmode · midi · perf · capture live once
  `≡ panels` retires. They have no other door.
- **P7-K0b** — what `⌘S` saves on the plane.
- P11-5's real-host reachability · the walks pending on E7/E8a/E9a · every
  `*-G1` gate.

### Conductor rulings, so they are not re-litigated

- **File browser home** — a drawer in the compose window, never
  `PANEL_MENU_SURFACES` (P3.5-E8b · P11-1).
- **FX 1–4 stay on the bar** until P7-MIX-0 rehomes them into the strip mixer.
  P11-1 must not invent an interim home: a door that works today is not worth
  trading for a tidier bar, and a temporary home means building the same door
  twice with a gap in between — which is exactly what P3.5-E8 was.
- **`HealthReadout` moves into P11-1's status zone beside LIM**, and
  `uiOwnership.test.ts`'s pin gets **repointed, never deleted** (P11-5b).
- **P6-6c carries its own live block-size source** — P9-3(c) is phases away.

## 7. Two lessons from the first cycle

**Integrate a lane's row BEFORE dispatching its next one.** Lane B was given
P11-5 while E8b was still uncommitted upstream, so E8b had to be cherry-picked
out from under in-flight work instead of merged cleanly. Cheap this time; it
will not always be.

**The LANE resets itself; the conductor never resets a lane branch.** A lane's
integrated commit is already upstream, so merging `host-hygiene` back re-applies
the same patch from two directions and eventually conflicts — the branch must be
reset rather than merged. But the reset belongs at the **start of the lane's next
row**, run by the lane, as the first line of its brief:

```
git reset --hard host-hygiene      # in the lane's own worktree, before new work
```

⚠️ **Learned the hard way, 2026-07-30.** The conductor reset `lane/b` after
Lane B's handoff arrived — and the lane was still working. It had an uncommitted
edit live at that moment; it survived only because the reset happened to leave
the working tree alone, and a `git reset --hard` would have discarded it
silently. **A handoff arriving is not proof the lane is idle**: a lane that has
returned one row may still be finishing follow-up work, and the conductor cannot
see its working tree. Moving the reset into the lane removes the race entirely,
because the only process that resets the branch is the one that knows whether it
is done.
