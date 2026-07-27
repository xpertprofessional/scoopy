# P2 step 4b — making the plane actually work

*Written 2026-07-27, closing the step-4 build session and opening the next.
Read `P2-STATUS.md` first for what exists; this is what is WRONG and what to do
about it. Three decisions were taken with the user before this was written and
are recorded below as settled.*

## Start here: read before building

This phase's first job is a **deep review**, not a keystroke. Step 4 was built
fast and three of its plan lines turned out to be missing infrastructure rather
than UI work. Before touching anything:

1. **`P2-STATUS.md`** — opens with the full status, the ten defects the harnesses
   caught, and the single blocker. Every claim there is testable; check the ones
   you are about to build on.
2. **`STRIP-MODEL.md`** and **`pd-strip-anatomy.md`** — the object and its laws.
   The strip's layout is a pixel budget that closes exactly; `browser_plane_test`
   measures it.
3. **`ROUTING-MATRIX.md`** and **`pd-plane-playground.md`** — but read the
   playground's §3 knowing it was written against a STAR topology and has since
   been partly reversed (cables for graph edges, chips for terminal facts). A
   spec that predates the merge is evidence, not instruction.
4. **memory `p2-decisions`** — six signed items not to re-litigate.
5. **The two gates**, and run them: `plane_audio_test` and
   `browser_plane_test.mjs`. They are the definition of done.

**Then verify the review against reality.** The last session's most expensive
mistakes were all cases where a document said something that had stopped being
true. `SlWorldApply` claimed "deck 0 only today" — never true. `pd-strip-anatomy`
§6 promised "zero token additions" — those were wizard's tokens, not scoopy's.

## What is broken, in the user's words

> "still no scoopy grid or session integration into a strip, no audio routing —
> i can not even toggle off an input channel for a strip so we have non stop
> input and feedback"

Both are correct. The second is a bug introduced by the last session.

### 1. THE FEEDBACK BUG — fix this first

A strip arrives with a device-input route permanently patched in (added so REC
would capture something), and **there is no way to turn it off**. Worse: `M`
calls `sl_channel_set_mute`, which mutes the whole CHANNEL — so the only control
that silences the input also silences the tape. With a mic on the input that is
a feedback loop you cannot break without deleting the strip.

It exposed a real collision in the design, not just a missing button:

> The record tap IS the channel bus (STRIP-MODEL: "recording is always capture
> this strip's channel bus — one tap, one code path, every source"). So
> monitoring and recording share one path: silence the input to stop feedback
> and REC captures silence. **Record-without-hearing is impossible by
> construction.**

**DECISION (user, 2026-07-27): SPLIT THE TAP.**

```
now:    input ──▶ channel bus ──┬─▶ main      (always audible)
                                └─▶ REC
        silence the input → REC records silence
        M mutes the channel → kills tape playback too

after:  input ──┬─▶ REC                        (always captured)
                └─▶ [MON] ─▶ channel ─▶ main
        MON off → silent, still recordable
        M still mutes the strip's OUTPUT only
```

The strip gains a **MONITOR switch** controlling whether its input reaches the
channel. The record source becomes `deviceInput` when a strip has a live input
and `channelBus` otherwise — which costs the purity of "one tap" for input
strips specifically, and buys the normal studio case plus a way to kill feedback
that does not kill the take.

Get this right in the ENGINE first (`plane_audio_test`): input audible with MON
on, silent with MON off, and a take recorded in both states containing the same
audio. That last assertion is the whole point and it is the one that will fail
if the split is wrong.

Also worth settling while here: **MON should probably default OFF**, with REC
turning it on — wizard's D-WZ-MON-01 precedent. A strip that arrives listening
is a strip that arrives feeding back.

### 2. NO GRID IN A STRIP — the single blocker

`store/companionEngine.ts` holds **ONE** session (`session: WorkingSession |
null`) and `worldFromSession` has **no deck axis**. It was written for the
browser companion, where one session IS the app. The mission needs N.

This one cause blocks THREE things: the grid creation gesture, landing a carve,
and multi-deck grid strips.

**The ENGINE is not the blocker.** `plane_audio_test` §10 proves two decks
publishing independently, each keeping its own tempo-sync ratio across the
other's publish, both audible, out-of-range refused rather than aliased onto
deck 0.

**DECISION (user, 2026-07-27): FULL PER-DECK SESSION MAP.**

```
companionEngine today:
  session: WorkingSession | null           ← ONE
  publish() ──▶ worldFromSession(pattern, kit)   ← no deck

after:
  sessions: Map<deck, WorkingSession>
  publish(deck) ──▶ worldFromSession(…, { deck })
  the browser companion keeps using deck 0 only
```

It touches a ~700-line store the browser companion also depends on, so the
companion's own gates (`browser_grid_test.mjs`, the vitest suite) are part of
done here, not an afterthought. This is the same species of change as the world
sink — the one that, unexamined, meant nothing worked at all.

Once it lands: the grid strip's creation gesture (pick a session for a strip),
and carve's session half, both become buildable.

### 3. THE COMPOSER WINDOW OPENS EMPTY — found at planning, 2026-07-27

Not in the user's list because nothing has been able to reach it yet. Found by
reading rather than by running, and it is the phase's THIRD missing-infrastructure
line — the shape P2-STATUS says to check for before treating a plan line as UI
work.

`compose ⇱` sends `openPanelWindow {panel: 'grid', arg: deck}`. Two things go
wrong on the way:

- **The arg is dropped.** `MergedMain.cpp:191` calls `openPanelFn(panel)` and
  nothing else; the spawned window gets `window.__slPanel` and never
  `window.__slPanelArg`. `InstrumentPanel` and `FxSlotPanel` read that global;
  `GridPanel` does not read it at all. So the window cannot be told which deck it
  is for.
- **Nothing loads a session into it.** `App.tsx:155` renders `<GridPanel>` bare.
  The composer is served by `BrowserLink`'s `GridBackend`, and the ONLY caller of
  `gridBackend.load()` is `CompanionPanel.tsx:85`. On the desktop this was
  Swift's job (`WebGridBinding` served `gridMeta` / `gridPattern/<i>` /
  `gridRuntime/<i>`), and Swift is carved off.

Underneath both: **every panel window is a separate WebView with its own
`companionEngine` store.** So even once the arg arrives, two windows holding the
same deck would each publish their own world for it, and the stale one wins
whenever it publishes last.

**DECISION (user, 2026-07-27): COMPOSE LIVES INSIDE THE PLANE WINDOW** — a route
or overlay beside the map, not a separate OS window. One store owns all N
sessions and is the only publisher. This DELETES the cross-window document-relay
problem rather than solving it, and it is what makes the per-deck session map
sufficient on its own. `GridPanel` is still reused unmodified; what it needs is
the `load` / `setPlaying` / `updateRuntime` wiring `CompanionPanel.tsx:69-95`
already does, lifted so both panels share it instead of copying it.

## Three more decisions, taken at planning 2026-07-27

The three above were taken closing the build session. These were taken opening
this one, after reading the code the brief describes. Settled, not proposals.

**RECORD SOURCE = the rule PLUS an explicit override.** Splitting the tap makes
a strip with a live input record `deviceInput`, and the strict form of that rule
silently deletes a capability: today, routing strip A → strip B and pressing REC
on B captures A. So the rule is the DEFAULT (input present → `deviceInput`, else
`channelBus`) and the strip's EXISTING right-click source menu gains a "record
from" section — *input · this strip's bus · main mix* — persisted on the strip.
The status line already names the tap, so the choice is visible on the object
rather than inferred from whether a cable happens to exist.

**MON DEFAULTS OFF, AND THE AUTOMATION IS ENGINE-EXACT.** REC opens it; the Law
C-3 record→loop handoff closes it in the SAME RENDER BLOCK; overdub keeps it
open. That is D-WZ-MON-01 and D-WZ-MON-02 honoured rather than reinterpreted —
neither anticipated a strip that *arrives* listening, which is the whole of the
feedback bug. Doing the auto-close in TS off the record-stop reply would land a
frame or two late and flam input over the loop at the one moment the ear is
listening for the loop, so it belongs in the render. Costs new ABI
(`sl_channel_set_monitor` / `sl_channel_monitor`) and one appended HotFrame
scalar so the strip can show what is TRUE rather than what it last asked for —
the same reason `sl_deck_tempo_sync` exists. Schema 87 → 88.

**THE TOKEN GATE GOES GREEN THIS PHASE.** The narrow, commented exemption for
`panels/trackControls.ts`'s named track palette is taken: a track a user called
"Red" must not change meaning when the theme does, so this is a gap in the RULE
and not in the code. The four real grid-UI violations get fixed. A red gate
protects nothing, and this phase adds a schema bump and an ABI — it needs the
gate to be able to fail.

## Definition of done — a usable set, verified twice

**DECISION (user, 2026-07-27).** Nothing is called finished until this runs, in
`plane_audio_test` where it can be asserted and by the USER's own run-pass where
it cannot:

```
· add a grid strip, load a session, hear it
· second grid strip, different session, its own BPM
· sync one to master — hear it lock
· tape strip: record the input, loop it
· MON off → feedback stops, take still records
· route tape → grid strip, hear the chain
· save · quit · reopen · identical
```

## The rule that earned its keep

**"Tests pass" is not "it works."** Increment 1 shipped with 1225 green TS tests,
63 green ctest cases and every gate clean, and made no sound. Keep both gates
green and extend them with each piece:

- **`shell/tools/plane_audio_test.cpp`** — the plane's exact command sequence,
  real engine, real RecordService, asserts on SAMPLES and files on disk.
- **`web/tools/browser_plane_test.mjs`** — the built bundle, measured layout.

Two failure shapes to watch for, both seen repeatedly last session:

- **A command returns `ok` and does nothing.** Every one of the ten defects had
  this shape. Assert on the OUTCOME (a sample, a file, a bounding box), never on
  the reply.
- **A plan line that reads like UI work is missing infrastructure.** Three of the
  ten were this. Before treating a line as a component, check the plumbing
  exists — no RecordService, no file layer and no byte transport were each
  discovered mid-build.

## Known gaps, carried forward

- **`check:tokens` is RED at 12**, none from the plane. 8 are
  `panels/trackControls.ts`'s named track palette — arguably a FALSE POSITIVE
  and a gap in the RULE rather than the code (a user-facing palette should not
  move when the theme does). It wants a narrow, commented exemption, which is a
  decision about the gate. The other 4 are real but in the grid UI. **A red gate
  cannot fail on a new violation** — settle this early or it protects nothing.
- **`.scoopyMapPkg` unpack** is built and tested with no import button.
- **Carve** is half-landed by design — region maths and the shared-take
  invariant are real; the session half is blocked above. The button refuses that
  half out loud rather than clearing the tape and dropping the region.
- **`Tape::reset()`** still retires rather than frees chunk storage; the render
  null-checks, so the window is survivable but not absent. A design change, not
  done unattended.
- The strip's **`recordArm`** field has no engine call behind it.

## Baseline, measured 2026-07-27 before a line was changed

Run first, so nothing later has to argue about whether it was already broken.

| gate | result |
|---|---|
| wizard `ctest` | **64/64** |
| scoopy `vitest` | **1295/1295**, 88 files |
| scoopy `typecheck` | clean |
| `browser_plane_test.mjs` | **OK** — tape and grid strips both close to 340 × 196 |
| `check:tokens` | **RED at 12**, exactly the documented split (8 palette + 4 real) |
| `browser_grid_test.mjs` | **RED — pre-existing, and NOT a code fault** |
| `browser_companion_audio_test.mjs` | **RED — same cause** |

**The two red browser gates are one cause, and it is a stale local build
artifact.** Both fail inside the WASM worklet with `Aborted(Assertion failed:
shell environment detected but not enabled at build time)`.
`web/src/audio/scoopy-engine.js` is **gitignored** (`web/src/audio/.gitignore`) —
a build product, not source — and the copy in this checkout is from **2026-07-24**,
older than everything P2 has done to the ABI. `engine/CMakeLists.txt:248` builds
it with `-sENVIRONMENT=web,worker,node`, which does not cover an
`AudioWorkletGlobalScope`. `emsdk` is present at `~/emsdk` but not on `PATH`.

Scope note: this is the BROWSER companion's own WASM audio path. The merged
desktop app does not use it — it publishes through `NativeWorldSink` into the
real engine — so it does not block any increment below. It does mean the
companion's regression gate for increment 2 is `vitest` + `typecheck`, and that
`browser_grid_test` cannot be the proof it was meant to be until the artifact is
rebuilt. **Rebuilding it is a decision, not a step taken unattended.**

## Repo state

Both repos are **committed and clean** as of 2026-07-27:

- `apps/scoopy` — `fdae657` (the plane UI), branch `phase3-native-carve-down`
- `apps/wizard` — `88478bb` (engine surface, host services, the audio gate),
  branch `main`, and `engine.lock.json` records `sharedCommit fdae657…`, which
  DOES contain the schema it pins.

Neither is pushed. `apps/wizard` pushes to the **scoopy** remote, never `origin`.
