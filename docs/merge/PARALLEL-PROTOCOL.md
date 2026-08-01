# Parallel ledger execution — the conductor/lane contract

**Opened 2026-07-30.** How more than one agent works this ledger at once without
corrupting the tree. `P3-LEDGER.md` stays the work queue and the sole authority
on order; this file is only the *coordination* contract. If the two ever
disagree, the ledger wins.

Read this together with `docs/ARCHITECTURE.md` §11 (the loop protocol) and
`CLAUDE.md`.

> **STATUS 2026-08-02: SUPERSEDED. The lanes are gone, not parked.**
> `D-SL-STUDIO-01` pivots the product to Scoopy Studio, and S0 of that plan
> **removed the three lane worktrees** — `scoopy-lane-b` · `-c` · `-d` are no
> longer on disk. The branches survive (`lane/b` holds 3 commits, `lane/c` holds
> 1; `lane/d` held only uncommitted work, archived at
> `docs/archive/lane-d-plane-shortcuts/`), so nothing is lost, but §1–§8 below
> describe machinery that no longer exists. **§8's revival recipe now starts by
> re-creating the worktrees**, which it does not say.
>
> **What is still load-bearing here is §0** — work by donor binding, not by
> phase. That ruling outlived the lanes and the Studio plan inherits it: its
> steps S1–S11 are binding-sized bundles under a different name.
>
> Everything else is history. Do not orient on it.
>
> *(Prior status, 2026-07-30: lanes PARKED, worktrees still seeded on disk.)*

---

## 0. The standing ruling: work by DONOR BINDING, not by phase (2026-07-30, user)

*Hoisted from §9 — this is the ruling that decides what a unit of work is; read
it before the queue.*

The 2026-07-30 audit classified the open queue: **51 PORT · 31 NEW · 1 UNKNOWN**
across 83 rows, every PORT naming a file and a line in `../scoopyloops`. P7 alone
is 21 PORT of 29. **The queue is largely a rewrite backlog**, and the thing being
rewritten has a shape the ledger's phase blocks do not follow.

The donor's protocol answerer is **15 `Web*Binding.swift` files, 6,954 lines**,
sitting on a document layer of ~33k. The merged host answers the same protocol in
`SlDispatch.cpp` plus `BrowserLink`. **What did not come across is the
bindings.** So a binding is the natural unit of work: it has a boundary, one
reference file, and it closes several ledger rows at once. The ledger's
**BUNDLES section** (B1–B8) is this ruling made into a queue.

**Dispatch by binding, not by phase.** Example: `WebSceneBinding.swift` answers
`patternScene` and `sceneOverride` — porting it closes P7-K7, revives
`scenesStore`, un-swallows P8-2's scene ops and unblocks the launch quantum. Four
rows, one reference, one coherent change.

**What this costs, stated plainly:** it cuts across the ledger's authority order
(the `## The queue` preamble) — P7, P8 and P9 rows progress together rather than
in sequence. That order exists to stop work being built on falsified premises, so
the **dependency warnings on individual rows still bind**: a row saying
*re-measure before building* is still a measure row. What is relaxed is phase
sequencing, not row dependencies.

**Every brief/bundle for PORT work must carry:**

1. **The reference — file and line.** Not "see the donor": `patternScene →
   WebSceneBinding.swift:119`.
2. **The instruction to read it BEFORE designing**, and to report where it
   diverged and why. A divergence the user did not ask for is a regression
   wearing a redesign's clothes.
3. ⚠️ **Only `ScoopyLoops/*.swift` and `ScoopyLoopsTests/` are evidence.**
   `../scoopyloops/web/**` is this project's own web tier frozen at 2026-07-27 —
   citing it is circular.
4. **What the user has ruled**, where it differs from the donor. The donor is the
   reference, not the authority: `trackGain` unity over the donor's 0.80 is the
   precedent.

**The index:** `WebEngineLink.swift:365-559` — an exhaustive dispatch `switch`.
⚠️ `SLPMethod` there has 84 cases but only **72** are handled — the other 12
(`slChannel slTape slRoute … openPanelWindow`) are *successor* additions leaked
into `Generated/SLPProtocol.swift` by the merge commits. **The donor's real
capability index is the 72 handled cases.**

---

## 1. The shape: one conductor, four lanes (PARKED — see §0 status note)

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
- **Lanes B, C and D — git worktrees, web-only.** `../scoopy-lane-b` on `lane/b`,
  `../scoopy-lane-c` on `lane/c`, `../scoopy-lane-d` on `lane/d`. No CMake, no
  walks, no bundle.

**On lane count.** Three was chosen because one `npm test` already forks workers
across all cores. A fourth is fine in practice because lanes spend most of their
time reading, not running the suite — but note the real ceiling is **not CPU, it
is the conductor**: integration is serial (merge → ctest → walk → bundle → commit
→ ledger row), so past about four lanes the queue backs up on one process and the
lanes wait on integration rather than the other way round.

### The rule that makes it safe

**Lanes never bundle and never commit to the shared branch.** A lane runs only
the cheap gates in its own tree — `typecheck`, `npm test`, and the ten drift
checks (pure read-and-compare node scripts, ~2 s for all ten, safe
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

Measured at `6694d4b`, 2026-07-30 end of session (per §10: typecheck green ·
vitest 1670/1670 · ctest 44/44 · bundle fresh). Lanes compare reds against
**this**, not against assumption — and re-measure it on resume (§8):

| Gate | State |
|---|---|
| `params:check` · `shared:check` · `worldmap:check` · `hotframe:check` · `tape:check` · `trackparams:check` · `webdist:check` · `schema:check` · `check:tokens` · `nativemethods:check` | **all TEN GREEN** |
| `engine:check` (**not** one of the ten) | **RED, pre-existing** — `vendor/scoopy/engine/CMakeLists.txt` edited locally; the drift is recorded in P6-3 |

(`params:check` was RED for one day in an older preamble; H5-a repointed the
checker and it passes — do not chase that red.)

`docs/ARCHITECTURE.md` §11 was **rewritten 2026-07-30** for the merge; the two
stale claims it used to carry (orient on `/MIGRATION.md`; a `protocol:check`
script) are fixed at source. `web/package.json` is the authority on gate names;
the count is **ten**.

---

## 3. Dispatch rules

A row may go to a parallel lane only if **all** hold:

1. It is at the head of the authority order (the ledger's `## The queue`
   preamble — line numbers drift, the section name does not), **or** it
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
plus the ten gates must match §2 exactly.

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
| A | main checkout (conductor) | — | — | idle |
| B | `../scoopy-lane-b` (`lane/b`) | — | — | idle |
| C | `../scoopy-lane-c` (`lane/c`) | — | — | idle |
| D | `../scoopy-lane-d` (`lane/d`) | — | — | idle |

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

⚠️ **The "Queued" list below is a PLAN, not a work authorisation.** A lane
starts a row **only** when the conductor names it in a message to that lane.
Finishing a row means hand back and wait — even when an obvious next row exists,
and even when the lane can see it queued here. Learned 2026-07-30: the conductor
told the user all dispatch was held pending three decisions, and a lane read this
list as a queue to continue through and shipped the next row anyway. The work was
good; the authorisation was not there. If a lane thinks the next row is urgent it
says so in its handoff and lets the conductor dispatch it.

**The rule, in one line: dispatch is a MESSAGE TO THE LANE, not a document.**
It still stands — but ⚠️ **the incident that produced it was misdiagnosed, and
the correction matters more than the rule.**

The conductor concluded that Lane B had self-continued to P11-2 by reading the
queue as authorisation, and wrote that here. **It had not.** The user was
messaging the lane *directly* — five messages the conductor never saw, including
`continue` twice. The lane was following live user direction, correctly. Both
the conductor's diagnosis and the lane's acceptance of blame were wrong, because
neither could see the other's channel.

**The real lesson is about the CHANNEL, not the lane.** In this harness a user
can message a running subagent directly, and the conductor sees none of it — it
sees only the lane's final handoff. So:

- **A lane that seems to act without orders may be under orders you cannot see.**
  Ask before attributing it to a misread contract.
- **A conductor holding all dispatch is not holding anything** if the user is
  steering lanes directly. State plainly which channel you are on.
- Direction sent to a lane does not reach the ledger, the claim table, or any
  ruling — so it is invisible to the next session. **Anything decided in a lane
  channel has to be repeated to the conductor to survive.**

**Queued (plan only):** A: E10a → P11-3a → P6-6a/b/c → P6-AUDIT → P3.5-E4.
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

---

## 8. Resuming this in a fresh session

**Lane agents do not survive a restart** — their conversations live in the
session that spawned them. That is fine, and the contract is built for it: every
lane returns its handoff as *text*, the conductor writes it into `P3-LEDGER.md`,
and the reasoning goes into the commit message. **Nothing load-bearing is ever
left in an agent's head.** A cold session loses warm context, not knowledge.

### What is already on disk

| | |
|---|---|
| `.claude/agents/ledger-lane.md` | the lane contract, committed — so `ledger-lane` is a **registered agent type** from session start (this session had to bind it onto `general-purpose` by hand, because the registry loads before the file existed; that workaround is no longer needed) |
| this file | the shape, the dispatch rules, the **conductor rulings**, the measured gate baseline, the claim table, and the lessons — including the ones that cost a cycle to learn |
| `docs/merge/P3-LEDGER.md` | every row, every handoff note, every follow-up |
| the git log | the *why* behind each row, at length |
| `../scoopy-lane-b`, `../scoopy-lane-c` | the worktrees, still seeded with `node_modules` and the gitignored `scoopy-engine.js` — no setup to redo |

### Startup sequence

1. **Take the conductor role explicitly** and say so, so the user knows which
   channel they are on (§7 — direction sent to a lane never reaches the ledger).
2. Read `P3-LEDGER.md`'s authority order, then this file's §2 baseline, §3
   dispatch rules and rulings, and §6's claim table.
3. **Re-measure the baseline** — do not trust §2. It is dated, and the whole
   reason it exists is that two documents were stale about it.
4. Check the lane worktrees exist and their branches are behind `host-hygiene`
   (they will be — each lane resets itself at the start of its next row).
5. Dispatch by **messaging a lane**, naming one row. Never treat §6's queue as
   authorisation.

### What a FRESH lane needs that a warm one did not

A lane resumed across rows in one session carried its own history — it knew what
it had already measured and why. A cold lane knows nothing. Its first brief must
carry more than a row number:

- the row's **falsified premises**, spelled out. Several rows in this ledger
  carry citations the 2026-07-30 audit disproved, and a cold lane will believe
  them.
- any **conductor ruling** that constrains the row (§3), stated as decided.
- the **known-red baseline**, or the lane will chase `engine:check`.
- what the row's **gate line** actually requires, and that the lane cannot run
  the real host — so it must say what the conductor should click.

### The habits that produced the good rows

Worth restating, because they are what made the lanes useful rather than fast:

- **Measure before building.** Three rows in a row inverted their own premise
  once measured — P11-5, P8-1 and P3.5-E8g-a each found the ledger wrong about
  what existed.
- **Report refuted theories.** E8g's value was two theories killed, not a fix.
- **State what a gate cannot see.** "The pins cannot see a repaint" is worth more
  than a fixture that tests something easier.
- **A fake thin enough to pass either way is a green gate that cannot see the
  defect** (E8g-c) — the web-tier form of P3.5-E10's lesson.

---

## 9. Working by DONOR BINDING — moved to §0

This ruling decides what a unit of work *is*, so it was hoisted to the top of
this file on 2026-07-31 (it had been buried at line 356 of 471, in the fourth
document of the orientation order, and the session it was written for ended
without acting on it). **See §0.**

The ledger's **BUNDLES** section is that ruling turned into a queue: B1–B8, each
naming its donor binding, the rows it consumes, and its door.

---

## 10d. ScoopyTape (the looper-strip plugin) — planning, 2026-08-01

A kickoff brief exists at `docs/merge/TAPEPLUGIN-KICKOFF.md`. **§1 is half
built**: `Scoopy Tape` loads in a DAW as an effect (`aumf Tape Scpy`, auval
clean, 47/47 ctest — `6806f6e`, `a49a4a6`), and the `plugintape` web face it
points at does not exist yet. Eleven design questions were answered by the user
on 2026-08-01 and live in that file's "The ground" section.

Two findings dominate and neither is in the ledger yet:

1. **The looper engine already exists.** `slengine`'s `sl_tape_*` tier is
   record / free-or-synced loop / varispeed / Signalsmith stretch / turntable
   scrub / overdub / crash-safe takes, wired C++ → SlDispatch → React. This is
   not an engine project.
2. ⚠️ **There is a Scoopy PLUGIN LINE and this project did not know about it.**
   `~/xpert/plugins/scoopy-pulsar` is a shipping sibling; `Scoopy Spectral FX`
   and `Scoopy Trombone` are two more; and
   `../scoopyloops/docs/plugins/PLUGIN-DESIGN-SYSTEM.md` is the design law for
   all of them — including a `PLUGIN_CODE` registry and an 8-slot
   snapshot+morph system it calls **"the Scoopy plugin signature"**. Several
   things this brief was about to invent are already conventions there. The
   kickoff's "The plugin line" section is the reconciliation. **Anyone
   designing a Scoopy plugin should read that file first.**

### Awaiting the user (added 2026-08-01)

1. ~~**The product name and its 4-char `PLUGIN_CODE` / bundle id.**~~ **SETTLED
   2026-08-01: "Scoopy Tape", `PLUGIN_CODE Tape`,
   `com.scoopyloops.scoopytape`** — the code claimed from the plugin line's
   registry rather than invented (the codes are mnemonics of the thing: `SpFx`
   `Trmb` `Puls`). ⚠️ **One part is OWED and cannot be done from here:** that
   registry lives at `../scoopyloops/docs/plugins/PLUGIN-DESIGN-SYSTEM.md` §7,
   which says "claim the next here", and CLAUDE.md forbids writing to that
   repo. Someone with it open needs to add `` `Tape` = Scoopy Tape ``. Until
   then the claim exists only in this tree.
2. **The parameter ID list must be signed before ANY build leaves the machine.**
   A7 chose a broad automatable surface; param IDs freeze at first ship and a
   rename silently breaks every saved automation lane. The proposed list is
   TAPEPLUGIN-KICKOFF §8. This is the one item that is genuinely blocking —
   everything else can proceed and be revised.
3. **Snapshot-flip quantization**: free, or on the launch quantum? And does
   reloading a snapshot mid-playback crossfade or cut? ⚠️ Interacts with item 1
   of §10c below — **the launch quantum ruling (P11-3c) is itself still open**,
   so do not settle it sideways here. Now also interacts with the line's
   **morph** (PLUGIN-DESIGN-SYSTEM §5): morph can interpolate a slot's params
   but not its audio, so "flip" and "morph" are two different verbs on one
   control and the UI has to say which is which.
4. **The A6 embed cap** — the byte/second threshold above which a snapshot is
   stored as a take *reference* instead of embedded PCM. Proposal: 60 s total
   gzipped. (8 snapshots × 30 s stereo float32 ≈ 180 MB raw is why "always
   embed" was rejected.)
5. **Overdub default** — does the record verb on an already-filled snapshot mean
   SUM or REPLACE? Both exist in the engine; INSERT is deliberately absent.
   D-WZ-OVERDUB-01 signed destructive mix-into-buffer for the wizard deck, which
   argues SUM, but a looper's "record" button meaning "overdub" surprises people.

---

## 10c. Handoff — state at 2026-07-31, end of the autonomous run

**B1 and B2 are both done** bar what only the user can settle. Eleven commits,
tree green at every one.

| | |
|---|---|
| **B1** deck transport | engine seam (`sl_deck_skip_step`, deck param `texture`) · companion verbs (one-shot, BR shift, the instant double) · four deck rows on the tile · `menuTransport` answered, so **Space starts a deck** for the first time · the rows rebuilt to `docs/DESIGN.md` after a first cut that broke three of its rules |
| **B2** scenes | switch modes SCHED/RUN/START + CU + SCN · scene overrides (pin/unpin/push-to-all) with a drift guard · the pin MENU repointed off a topic nobody publishes · MUTE group, membership included · `P11-3a-b` per-deck position · `P11-3b` the quantized-launch ABI |

**Verified at HEAD:** ctest 44/44 · vitest 1757/1757 · ten drift gates green ·
walks 7×2 green · bundle fresh.

### ⚠️ THE PATTERN THIS RUN FOUND, and it matters more than any single row

**Three features had complete UI, complete wire, complete store, and no join.**

- **Space** sent `menuTransport`; nothing had ever answered it.
- **The scene-pin menu** was built, wired onto every DragBox and passed a key by
  `MasterRow` — and fed by a `scenes` topic nothing publishes, so it rendered as
  `[]`. Structurally invisible, not broken.
- **The mute group** was severed in three places at once: the meta flag
  hardcoded false, the op unhandled, the membership field never passed.

None of these is a bug a test would catch, because nothing is *wrong* — the
pieces simply are not connected. **That is what "the bindings never came across"
means in practice, and it means the 48-unanswered-commands count UNDERSTATES the
gap.** When picking up a feature that looks missing, check whether it is
actually present and unjoined before building it.

### Awaiting the user — the loop stopped here because everything left needs you

1. **The launch quantum ruling (P11-3c).** The donor uses ONE global quantum
   with an auto-chosen reference deck (`LaunchQuantize`, `DJModeView.swift:96`,
   persisted as `djMode.globalLaunchQuantize`); `quantize.md` replaces a shipped
   answer. The ABI beneath it is done and callerless until this is settled.
2. **P6-AUDIT's gate** — load a plugin on FX1, hear a strip's send through it,
   tweak it, save the map, reopen. **B3 (mixer/FX sends) is blocked behind it**:
   P7-MIX-0 is `blocked(P6-AUDIT not signed)`, and P3.5-E4 is hoisted to run
   after it.
3. **Real-host walks owed.** B1's rows (expand a grid strip: ▸ one-shot, »
   skip, TP+SYNC/TR exclusion, WIN, DBL) · B2's scene row · **P11-3a-b's
   specifically: queue a pad on strip B with strip A STOPPED — it must switch on
   B's own cycle.**
4. **`B1-RETIRE`** — deliberately not run autonomously. It deletes
   `TransportPanel`/`DjPanel` and needs four test files rehomed first; deleting
   coverage while nobody is watching is how a green suite quietly loses it.
5. **~45 commits unpushed.** `P3-PUSH` has never run. Confirm the remote and
   your intent.

---

## 10b. Handoff — state at 2026-07-31

**B1 (deck transport) landed**, five commits, tree green at each: the engine seam
(`sl_deck_skip_step` + deck param `texture`), the companion verbs (one-shot, BR
shift, the instant double), the three deck rows, and a real answerer for
`menuTransport` so Space starts a deck.

**Measured, and it reframes the queue:** `schema.ts` declares 86 commands and
**48 are answered by nobody**. That number, not the row count, is the distance
to the original — see the ledger's BUNDLES section.

**Verified:** ctest 44/44 · vitest 1710/1710 · ten drift gates green · walks
7×2 green · bundle fresh. `sl_perf_test`'s binary was simply absent from the
build tree and is now built.

### Awaiting the user (added 2026-07-31)
- **The real-host walk for B1.** Open WizardMerged → expand a grid strip (⤢) →
  the three deck rows appear above the grid. Worth pressing: **▸¹** (one cycle
  then silence), **»** (playhead nudges one step), **TP** then SYNC/TR (they
  exclude each other), **WIN** (grain moves), **DBL** (asks which strip).
- **Space** should now start the focused deck in both the compose window and a
  deck tile. It never has before.

### Next
**B2 — scenes.** It is the biggest single unblock left: `patternScene` and
`sceneOverride` are unanswered, `scenesStore` is an orphaned module that looks
live (P7-K7), P7-T3's five scene controls are waiting on it, and
`requestQuantizedLaunch` is compiled into the engine with zero callers. Donor
reference `WebSceneBinding.swift` (201 L) + `BeatSequencer.swift` §§1628-1946 ·
11677-12548, with nine scene tests in `ScoopyLoopsTests.swift:310-516`.

⚠️ **Still not pushed** — the unpushed count keeps growing (~35 commits).
Confirm the remote and the user's intent.

---

## 10. Handoff — state at 2026-07-30 end of session

> ⚠️ **Superseded in part by the 2026-07-31 session.** Lanes are parked; work
> runs as single-session BUNDLES (§0, and the ledger's BUNDLES section). What
> stays live here is the **"Awaiting the user"** list at the end of this section
> — that, not `docs/archive/MORNING-DECISIONS-2.md`, is the real decision
> backlog. Four of its items were ruled on 2026-07-31 and are struck below.

**Tree clean at `6694d4b` on `host-hygiene`.** typecheck green · vitest
**1670/1670** · ctest **44/44** · **ten** drift gates green · bundle fresh.
All four lanes idle, all four worktrees clean, nothing uncommitted anywhere.

⚠️ **Not pushed.** `P3-PUSH` is a recurring row ("push after each green commit")
and this session never pushed. Confirm the remote and the user's intent before
pushing ~30 commits at once.

### Start here

1. `P3-LEDGER.md` for the queue — its **BUNDLES** section first — then **§0
   above**: work by donor binding, not by phase. That is the ruling that changes
   everything about how to proceed.
2. **Re-measure the §2 baseline.** It is dated, and the reason it exists is that
   two documents were stale about it.
3. The lane worktrees are seeded and ready; `ledger-lane` is now a **registered
   agent type**, so no hand-binding onto `general-purpose`.

### The one thing that made this session productive

`../scoopyloops/ScoopyLoops/*.swift` is the donor, and for most of the session
**nobody knew it existed** — `CLAUDE.md` scoped searches in-repo only. Once lanes
read it, three rows in a row inverted their own premise. **51 of 83 open rows are
ports with a known file and line.** Do not let a lane re-derive what it can read.

### Dispatched but NOT delivered — re-dispatch these

The agent infrastructure degraded at end of session (four startup stalls plus a
classifier outage). These were briefed and produced nothing; **the briefs were
good and are worth reusing**:

- **The scene binding port plan** (Lane C) — `docs/specs/scenes-port.md`, from
  `WebSceneBinding.swift:119` + `BeatSequencer.swift`. This is the **first unit
  of the binding-oriented plan** and the user picked it. It must also settle
  whether the scene port carries `P11-3a-b` or that lands first.
- **`P7-K4`** (Lane D) — the shortcut list door, reference `ShortcutListView.swift`
  + `ShortcutsWindowController.swift`. ⚠️ The donor showed only live shortcuts;
  **ours has 57 parked rows of 99** and must not present them as working.

### Awaiting the user

**Ruled 2026-07-31** (struck from the list below; recorded in `DECISIONS.md`):
the **pd-\* specs** are archived (D-SL-ARCHIVE-01, settling D-4's 2026-07-28
question) · **lanes park**, work runs as single-session bundles · **B1 deck
transport is the first bundle** · **P7-P1 is unblocked** (the looper is a keeper
and evolves) · plus B1's four donor-deviation rulings: `playOnce` **ports**, TR
**replicates** the donor's sync⊕transpose exclusivity, `gridHidden` is
session-lifetime for now, BR stays armable while stopped.

- **Real-host walks** pending on: `P3.5-E8g-h` (new-track), `P11-1` (three
  zones), `P11-2` (CLOCK/TAP), `P11-5` (DSP readout), `P11-3a` (scene queue —
  **test strip A**; B/C fire on A's clock until `P11-3a-b`), `P9-5c` (device
  error), `P9-5a` (input hint).
- **`P7-K0b`** — half-answered: the donor's `⌘S` saves the SESSION; what saves
  the map is open.
- **`P7-N2` vs `P7-K0`'s digit ruling** — in the donor Tab/⇧Tab are already
  taken (⇧Tab is Compose↔DJ) and the deck-cycle chord is bare `-`. K0's ruling
  was provisional; it needs re-ruling.
- **Three deliberate divergences** to rule: `P9-5g` (donor stores the CoreAudio
  `deviceUID`, not a name), `P11-4` (donor's crossfader also assigns FX returns
  and the input, and persists **globally** — bears on the planned MAP bump),
  `P11-3c` (donor uses one global quantum with an auto-chosen reference deck;
  `quantize.md` replaces a shipped answer).

### Landed this session

The `-O0` build fix (12× on the stretcher — the multi-deck collapse), the
performance gate, `nativemethods:check` (which caught `fxSlot` and
`getFxSlotState` shipping unreachable), the file browser's home, the compose
load door, the health readout's door, the keyboard audit, the overlay spec, the
virtual-device path, a device switch that no longer costs all audio, the bar
re-zoning, CLOCK/TAP, the scene-queue fan-out, new-track creation, and the
ledger compaction (214 KB → 159 KB, 70 rows archived byte-identical).
