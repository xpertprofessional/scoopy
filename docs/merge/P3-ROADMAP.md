# P3 — the roadmap, restated against the actual goal

*Written 2026-07-27 after the user asked, correctly, what we are working towards.
This supersedes the framing in `P2-5-KICKOFF.md`, which was not wrong but was
scoped to one surface and never said what the surface was FOR.*

## The goal, in the user's words

> "The plane is the new main view basically and the scoopy decks live inside it,
> but the entire master tempo sync section comes via scoopy and needs to be
> integrated into the plane. Original mission was to **detach scoopy from the
> mixer, FX sends, deck transport and master tempo so this will be controlled
> universally for all elements** (looper, deck, recorder etc). Scoopy is much
> more advanced so we don't want to lose any of its long-worked functionality."

So the merge is not "show scoopy's panels next to wizard's". It is:

**FOUR CONTROL DOMAINS MOVE OUT of scoopy's per-session ownership and become
PLANE-LEVEL controls that work identically for every element type.**

| domain | today, in scoopy | after |
|---|---|---|
| mixer (level · mute) | per-session, per-deck, inside the session document | the strip's channel, for a deck exactly as for a tape |
| FX sends | per-deck sends into the session's returns | the strip's 4 sends, routable, one FX section for everything |
| deck transport | the session's own play/stop/bpm | the strip's transport row, same verbs for every element |
| master tempo & sync | the session's bpm | the plane's master, with per-strip sync — a deck syncs like a loop does |

A looper, a scoopy deck and a recorder must all answer the SAME level, the same
sends, the same transport, the same sync. That is the whole product.

**And nothing of scoopy's may be lost on the way.** Scoopy is the more developed
app; the merge adds a universal surface around it, it does not reduce it.

## Where we actually are — measured, not remembered

### Built, and genuinely foundational

- **`sl_channel_*` — the uniform channel.** One surface, two backings: a tape's
  gain stage lives in the merged tier, a grid deck's PROJECTS onto the core's own
  per-deck controls, so a deck is never double-gained. This is exactly the
  "mixer detached and made universal" mechanism, at the engine tier. ✅
- **`sl_route_*` — the patchbay.** Sends are routable: the channel owns the
  LEVEL, the document owns the DESTINATION. ✅
- **Per-deck sessions (`decks[]`)** and per-deck BPM. Two decks at two tempos,
  each in its own strip. ✅
- **`sl_deck_set_tempo_sync`** + the plane's `masterBpm`. A deck can follow the
  plane's master. ✅
- **The strip, the plane, save/open/export, routing, the split tap.** ✅

### NOT built — and this is the gap you can see

1. **A grid strip has NO TRANSPORT.** `GridControls` offers SYNC/FREE, bpm and
   COMPOSE. The ⟳ ▸ ↻ ◼ buttons call `slTape` and `enabledControls` gates them on
   `element.kind === 'tape'`, so **a scoopy deck cannot be started or stopped
   from the plane at all.** Universal transport is the domain that has not been
   started.
2. **The master section is the plane's own, not scoopy's.** `Master.tsx` carries
   a level, a meter, a watchdog lamp and a master BPM. Scoopy's transport/tempo
   section — the developed one, with its scene scheduling and its clock — has not
   been folded in. The user's sentence is "the entire master tempo sync section
   comes VIA SCOOPY and needs to be integrated into the plane".
3. **FX returns are OFF in the merged host.** `SlDispatch::capabilities` answers
   `returnFx: false`, so the render is dry and the sends row is hidden on
   scoopy's own surfaces. Four sends per strip currently feed a section the
   merged app does not run. ⚠️ THIS IS THE "don't lose scoopy's functionality"
   line being crossed, and it needs verifying properly rather than assuming.
4. **Scoopy's 19 panels have no door.** 18 are compiled into the served bundle
   and unreachable — the shell has no menu, and `openPanelWindow`'s only caller
   was the plane's compose button. Whatever we decide the plane hosts, the
   panels that are NOT hosted still need a way to be opened, or functionality is
   lost by omission.
5. **Two repos, a vendored mirror, and a hand-rebuilt bundle.** The failure this
   already caused is documented below.

## What went wrong with the plan, plainly

P2 and P2-5 were real work — the engine tier for the mixer, the routing, the
per-deck sessions, the split tap — and every one of them is foundation for the
four domains above. But **every increment was inside the plane**, and no step in
either plan was named "give a deck a transport" or "fold scoopy's master section
in". So the visible product did not move, and from outside it looks like circling.

The correction is that P3's steps are named after the DOMAINS, not after the
surface. A step is done when a scoopy deck answers the same control a tape does.

## The repo collapse — decided 2026-07-27

**`scoopy.git` is where everything lives: the wizard shell AND the scoopy app,
in one tree, with `apps/scoopy` on disk holding all the code.**

Why now, before more UI work: the current topology is
`apps/wizard/vendor/scoopy/` — a hash-pinned mirror of `apps/scoopy` that
includes a **built** copy of the web UI. The merged app serves that build. It has
to be rebuilt (`bundle:mac`) and re-vendored (`engine:sync`) by hand, and on
2026-07-27 that step was missed for a whole session: MON, the record-tap menu,
the session-loading gesture and the in-window composer were all built, tested and
**invisible in the running app**, because it was serving the previous day's
bundle. scoopy's own `scripts/check-webdist-fresh.sh` says it outright — *"this
build would silently ship an OLD web UI"* — and nothing ran it.

Collapsing deletes that entire failure class: one tree, one build, no lock file,
no vendored artefact to go stale.

**Decided 2026-07-27:** the live ScoopyLoops app **keeps its own repo**, moved to
its own folder; `apps/scoopy` becomes the MERGED tree, and all work happens
there from now on.

### What the investigation found, and it simplifies the move

**`scoopy.git` already holds wizard's history.** `scoopy/main` is an ancestor of
local `main`, which is **13 commits ahead** of it. So the merged repo is not
something to create — it exists, and `apps/wizard` is already its working copy.
The collapse is therefore not "build a new repo"; it is:

1. **Rename on disk.** The live app moves out of `apps/scoopy`; the merged tree
   (today `apps/wizard`) moves in. No history is touched by either move.
2. **Replace the mirror with sources.** `vendor/scoopy/` currently holds a
   hash-pinned copy of scoopy's native core, its `schema.ts`, and a BUILT copy
   of its web UI. Those become first-class sources in the merged tree — scoopy's
   whole `web/` app included — and `engine.lock.json`, `engine:sync` and the
   webdist vendoring go away with them.
3. **Re-point the paths.** `spike/CMakeLists.txt`'s `SCOOPY_WEBDIST_DIR` and the
   lock's `sharedRoot: ../scoopy` are the only two path dependencies on the old
   layout.

Step 2 is the substantive one and the only one carrying risk; steps 1 and 3 are
mechanical and reversible.

Steps 1 and 3 are **DONE** (commit `3d6fa22`); step 2 is below and is now the
gate on everything else.

### ⚠️ Step 2 BLOCKS P3-1 — and this is the folder confusion, exactly

Found 2026-07-27 while starting P3-1. **There are TWO plane implementations, and
the merged tree holds the wrong one.**

| tree | web sources | what it is |
|---|---|---|
| `apps/scoopy` (merged) | `web/src`, **49 files** — `AddStrip.tsx`, `StripLoad.tsx`, `stripSource.test.ts` | wizard's ORIGINAL plane, the one the merge exists to replace |
| `apps/scoopyloops` (shipping) | `web/src`, **220 files** — `Strip.tsx`, `GridElement.tsx`, `Composer.tsx`, `Master.tsx` | THE MERGED PLANE — all of P2, P2-5 and this session |

Two app targets consume them:

- `Wizard` → `WIZARD_WEBDIST_DIR` = `webdist/` — wizard's legacy UI
- `WizardMerged` → `MERGED_WEBDIST_DIR` = `vendor/scoopy/webdist` — a **build**
  of the shipping tree's UI

So **every line of the plane lives in the shipping app's repo** and the merged
tree holds only a compiled copy. Any UI step — P3-1 included — would have to be
edited in `apps/scoopyloops`, the repo just declared untouched, then bundled and
vendored back. That is precisely the pattern the collapse exists to end, and it
is why the folder question was the right question to ask.

**P3-1 therefore waits on step 2.** Doing it first would put another session's
work in the wrong repo.

### Decisions step 2 needs — architectural, not mechanical

1. **Wizard's legacy `web/` and the `Wizard` app target.** Deleted, kept
   building, or archived? The merge's direction is "web UI → scoopy's", which
   implies the legacy plane goes — but `Wizard` is a working app today, and
   deleting an app is not a refactor.
2. **Where scoopy's web lands.** Replacing `web/` outright is cleanest to reason
   about and re-points every path in the build, the gates and CI. A second tree
   (`scoopy-web/`) is safer and leaves two directories that both look like "the
   web UI" — the confusion being removed.
3. **The native core.** `vendor/scoopy/ScoopyLoops/*.{cpp,hpp}` becomes real
   source here, which makes this tree the core's writable home and completes the
   **P3 flip** the dual-home law was holding open. A real architectural
   commitment, not a file move.

⚠️ **Push before going further.** Sixteen commits of merged work exist only on
this machine.

## Sequence

Deliberately not rushed. Each step is verifiable on screen, not only in tests.

**P3-0 · The collapse.** One tree in `scoopy.git`. Wizard's shell, engine and
docs move in beside scoopy's app; `vendor/scoopy` and `engine.lock.json` go away;
the web UI is built from source, not vendored. Ends with: the merged app builds
from one repo and a web change is visible without a vendoring step. Settle the
live-app shipping question first.

**P3-1 · Universal transport.** A grid strip's ⟳ ▸ ↻ ◼ drive the DECK. One
transport vocabulary for every element — the first step where a scoopy deck
obeys the plane. Needs an ABI point for deck play/stop (the world carries
`isPlaying`, so this may be a publish rather than a new call — check the plumbing
first, per the rule this phase keeps re-learning).

**P3-2 · Master tempo, from scoopy.** Fold scoopy's transport/tempo section into
the plane's master: its clock, its scene scheduling, its tempo authority. Every
strip syncs to it — a deck the same way a loop does.

**P3-3 · FX sends and returns, universal.** Turn the return section on in the
merged host and make the strip's four sends reach it, for every element type.
Verify what `returnFx: false` currently costs before changing it.

**P3-4 · Nothing lost.** Every scoopy panel reachable — a menu, a switcher, or
hosted in the plane. Audit against the 19, deliberately, so nothing is dropped
by omission.

## The rules this phase keeps re-learning

1. **"Tests pass" is not "it works", and "it works" is not "it shipped."** The
   third one is new, and it cost a session: verify against the artefact the app
   actually loads.
2. **A line that reads like UI work is often missing infrastructure.** Four times
   in P2-5: no RecordService, no file layer, no byte transport, no session axis.
   Check the plumbing before treating a line as a component.
3. **Name steps after the goal, not the surface.** A step called "increment 3"
   can be finished without anything visible changing.
