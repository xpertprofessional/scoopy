# P3 merge ledger — rows for the loop

> **Compacted 2026-07-29:** `done` rows carry one-line summaries; their full
> handoff notes live VERBATIM in `P3-LEDGER-ARCHIVE.md`. Open/user-gated rows
> are untouched — orient on statuses here, dig in the archive.

> Created 2026-07-28 (Fable 5 review session). The merge phases (P3-0..P3-4) were
> tracked as prose in `P3-ROADMAP.md`; this file gives them the row form the loop
> protocol (`docs/ARCHITECTURE.md` §11) orients on. **Orient HERE for merge work**,
> not on `/MIGRATION.md` (wizard's pre-merge ledger, kept for the record).
>
> Statuses: `todo` / `in-progress` / `done` / `blocked(<reason>)` /
> `awaiting-decision` / `awaiting-user` / `awaiting-signoff`.
>
> **The four rules** (P3-ROADMAP + memory `verify-in-the-real-host`):
> tests pass ≠ it works ≠ it shipped ≠ **you can get to it**. Every UI row's
> handoff note must say what the visible door is and how a person reaches it in
> the JUCE WKWebView app — synthetic events and Chromium-only checks do not count
> as reachability evidence.
>
> **Decision protocol for this stretch (user, 2026-07-28):** the user is away;
> decisions queue in `MORNING-DECISIONS-2.md` with options + recommendation and
> DO NOT block the loop. Rows marked `awaiting-decision` are skipped; rows marked
> `provisional(D-n)` may build the recommended option, logged, re-tunable on
> sign-off.
>
> **⚠️ Gate-suite note (2026-07-29): CLAUDE.md's `npm run protocol:check` does not
> exist** — `web/package.json` has no such script. The real drift gates are
> `params:check` · `shared:check` · `worldmap:check` · `hotframe:check` ·
> `tape:check` · `trackparams:check` · `webdist:check` · `check:tokens` (plus
> `engine:check`, whose drift is pre-existing and recorded in P6-3). Running all of
> them found **two RED at HEAD: `webdist:check` and `check:tokens`** → rows P3-X4
> (now `done` — the bundle was behaviourally current; the committed hash was
> written from a stale tree) and P3-X5 (still `todo`).
>
> **Phases in this file (2026-07-29):** P3 (close-out: P3-X2, gate P3-G1) ·
> **P3.5** the strip becomes the deck (E-rows open — **E3 is a hoisted defect, take
> it first**) · **P6** plugins on the returns · **P7** the deck, whole · **P8** the
> map holds the performance · **P9** broad routing · **P10** the virtual interface
> (earmarked, no rows). Cross-phase order: P3-X2 → P3.5-E3 → P6-4..AUDIT → P7 →
> P8 → P9 → (P10); P3.5-E1 is user-fed in parallel.

## Done before this ledger existed (for the record)

| id | item | where recorded |
|---|---|---|
| P3-0 | The collapse — one tree in scoopy.git, sources not vendored | P3-ROADMAP "Sequence", commits 3d6fa22 · 765aa24 |
| P3-1 | Universal transport — a grid strip's ⟳ ▸ ↻ ◼ drives the deck | c589211 |
| P3-2 | Master tempo from scoopy — deck params, three tempo modes, djSyncLaw as authority, four defects fixed | P3-ROADMAP "P3-2 — DONE", dad8341 · 62b5fbd · ee56aef |
| — | Strip menu (visible door replacing right-click), session-open failure surfaced, OPFS writeFile atomic-ish | 8b0e9dc · 502bc1d · 0cccde4 |

## The queue

**Loop order** (why: broken-build first per §11, then the two rows that make the
product USABLE at all — audio in the plane, sessions that save — then the honesty
fixes, then the phase's named domains):
P3-F1 → P3-U1 → P3-SES-1 → P3-SES-2 → P3-U2 · U4 · U5 · U6 → P3-2b-1..6 →
P3-U3 → P3-U7 → P3-3-1..2 → P3-4-1..2 → P3-M-1 → P3-F2 → P3-AUDIT.
Push (P3-PUSH) after every green commit.

| id | type | item | status | handoff note |
|---|---|---|---|---|
| P3-F1 | fixture | `recorder_drain_test` intermittent SEGFAULT under the full suite | done | TSan first run: `wz::Deck::ensureCapacity`'s `push_back` reallocated the chunk vector under the render — ported sl_tape.h's reserve/retire discipline + atomic `chunkCount` readers (both engines). TSan 0×8, 120 stress runs green. Reset-while-render window stays documented, not this row's scope |
| P3-F2 | fixture | `browser_prod_test` / `browser_grid_test` failures — WASM worklet env detection | done | Regenerated glue detected "worker" by a symbol AudioWorkletGlobalScope lacks → engine aborted in EVERY browser since 2026-07-27. One source-level shim atop `scoopy-worklet.js` covers dev+prod. Ship gate + grid gate passed |
| P3-U1 | build | The plane never started the engine sink | done | `plane/bootEngine.ts` `autoStartEngine` from PlanePanel's boot effect, NATIVE host only (browser keeps the companion's click — autoplay). Failures land on the plane note line. Door: grid transport reaches a RUNNING sink at boot; hearing it = P3-G1 |
| P3-SES-1 | build | Native session store — THE FLIP | done (provisional D-1) | Built one tier lower as **`slFiles`** — a contained library filesystem routed through `opfs.ts`'s adapter (`nativeFiles.ts`), flipping sessions/samples/browser in one move; browser path byte-identical. Atomic writes, segment-wise traversal refusal, trash-first remove. Full gate list in archive |
| P3-SES-2 | build | Session content into strips end-to-end in the REAL host: New → edit → save → reopen → load into strip, through the visible strip menu | machine-half done / awaiting-user | `tools/browser_session_walk_test.mjs`: drives the BUILT bundle in Chromium against a fake JUCE backend whose slFiles is a server-side library with SlDispatch's exact semantics — New in the companion → `pattern.json` lands non-empty on the native route → the strip menu lists it → click → the strip renders scene pads + the grid row → the library survives a reload. Green first run. What it deliberately is NOT: the real JUCE bridge/WKWebView — **user check remaining: open WizardMerged, sessions ⇱ → New, then ⋯ on a strip → load it; expect scene pads and (after P3-G1's ear check) sound** |
| P3-2b-1 | schema | Tape tempo identity, document side | done | Map v5 (sync off, bpm null-honest, 4 fixtures); tape `tempoMode` timePitch/timeStretch only; sidecar `bpmAtStart` OMITTED when unknown, SCHEMA_VERSION 89, both parse directions pinned |
| P3-2b-2 | build | Tape beat length inference + Inspector override | done (provisional D-2) | `inferTapeBpm` (persist/tempo.ts): loop×stamp → snap to power-of-two bars in LOG space; >±20% off every power → null (honesty guard). Auto-fill only a null bpm; loaded-file tapes manual only |
| P3-2b-3 | build | Tape sync v1 — timePitch varispeed, zero new DSP | done | `tapeEffectiveRate` through THE LAW (sync owns magnitude, the hand keeps the sign — reverse survives; pulse relations land 1:2 not chipmunk). `applyTempo` pushes every tape each pass; SYNC/FREE on the tape row; rate slider disabled while synced. Ear check = P3-G1 |
| P3-2b-4 | spec | Tape stretch spec | done | `docs/merge/TAPE-STRETCH.md`: one reader two modes (stretcher only restores pitch); tape-tier declick (one-block primed engage + equal-power crossfade, no history ring); C-3 always closes DRY; lazy per-tape stretcher; ABI = `sl_tape_set_tempo_mode` + existing rate setter |
| P3-2b-5 | build | Tape stretch build (timeStretch to master, no pitch change) | done (provisional D-3) | Lazy per-tape `NativeBusStretcher` (asyncWarmup, render dry until warm), engage/disengage crossfades via a dry leg, LOOPING only so C-3 closes dry by construction. `sl_tape_stretch_test` green first run (pitch held ~440 vs varispeed ~880). SCHEMA v90 |
| P3-2b-6 | fixture | `tape_sync_test` coverage | done | Split across `sl_tape_stretch_test` (duration/pitch/disengage) + `plane_audio_test` (rate AND tempoMode survive a session publish; ratio measured AT the reader after re-trigger). Law arithmetic = tempo.test.ts |
| P3-U2 | build | Loaded grid strip never shows its session | done | `nameAfterSessionLoad` (stripOps): default/previous-session names follow the load, a user's rename is sacred. REC label + Inspector read `<session> · deck N` |
| P3-U3 | build | Scrub + overdub UI on tape strips | done | **Scrub ships**: unmodified wave-drag scrubs (turntable law, cue armed on release), loop brace moves to ⇧-drag. **Overdub ships**: OVR punch in/out (⌥ = replace), `overdubStart` sets the source + brackets a take, SCHEMA v91; enabled only with input patched + looping tape. plane_audio_test pins replace-with-silence-is-quieter + own-take landing |
| P3-U4 | build | Dead status plumbing | done | Take index from `slTakes list` (null-while-unknown), unresolvedRef/takeName/takeSeconds wired; `noOutput` via new `cables.hasOutput` (whole-graph). `decoding` deliberately unwired — nothing produces it. Known staleness: cross-window take deletion shows after next refresh |
| P3-U5 | build | Master bar fixes (±1 bpm honesty; empty-deck transport) | done | Steppers are honest DOCUMENT steps (comment matches code; real transient nudge queued to D-4 → later shipped as D4-2's nudge); ⟳↻◼ disable at deckCount 0 with next-step titles |
| P3-U6 | build | Error surface for dispatcher refusals | done | `send.ts` `onRefusal` seam → PlanePanel writes `<method> refused — <msg>` to the note line; console damping kept. Browser-host gaps now honestly visible |
| P3-U7 | build | Carve lands | done | Copyless by design: `slFiles` gains a read-only `/takes` mount (SCHEMA v92) — kit samples point at the recorder's WAV. `carveIntoSession` lands the region on the first EMPTY track; `doCarve` FREES the tape layer. Refusals name the next move |
| P3-3-1 | build | FX returns ON in the merged host: `returnFx: true` in `SlDispatch::capabilities`, verify what that unhides on scoopy's surfaces and what the render now does; strip sends 1–4 audibly reach the return section for BOTH element kinds | **unblocked (D-WZ-PDC-01 SIGNED 2026-07-29) — rides the P6 queue below as P6-3** | **The measurement the roadmap asked for (2026-07-28):** the TRANSPORT is fully built — strip sends render into the core's send lanes (`DestEndpoint::sendBus` → `map.send[di]`, mono per the core), the core's return WET lanes come back as routable sources (`SourceEndpoint::fxReturn` → `map.returnWet`), and grid tracks' send1..4Level travel in the world (zeroed only by `disableReturnFx`). What is MISSING is the CONFIG path: the merged host has no `fxSlot` dispatch and no return params in `kParamMap`, so the return processors would run at hard C++ defaults (delay 250 ms / fb 0.4 — "a wrong-sounding echo", the schema comment's own words for why the capability is false). Flipping today would be the dishonest state. **Second measurement (2026-07-28, after the fxslot door landed): the core retired its internal return delay — "a return is either external or a hosted plugin" (NativeAudioEngineCore.hpp:1205). So the config path IS plugin hosting, which is P6, PARKED behind the signed-decision gate D-WZ-PDC-01. This row leaves the decision-free queue: it unblocks when P6 opens.** The fxslot door (P3-4-2) already works for its mode/output controls; the plugin picker stays honestly inert behind `pluginHosting: false` |
| P3-3-2 | fixture | Extend `plane_audio_test`: send level up on a tape strip and a grid strip → return bus energy appears; send at 0 → silence on the return | **unblocked (D-WZ-PDC-01 SIGNED) — rides P6-3** | follows P3-3-1 wherever it goes |
| P3-4-1 | spec | Panel audit, the list | done | `docs/merge/PANEL-AUDIT.md` — 19 panels tabled: 3 reachable, 14 mechanical menu doors (fxslot FIRST), instrument PARKED behind `pluginHosting: false`. Taste calls named for D-5 |
| P3-4-2 | build | Doors for every mechanical panel | done | `≡ panels` on the plane bar (FX 1–4 addressed per slot, surfaces, settings); shell `openPanelFn(panel, arg)` → `__slPanelArg` injected (sanitised). Door: the ≡ button itself |
| P3-M-1 | spec | Master fold-in — THE MEASUREMENT (2026-07-28): the transport panel is DESKTOP-SHELL-COUPLED — it waits on pushed UiState topics the merged shell deliberately never publishes, and speaks `menuTransport`/`menuSession`/`djSetting`/`toggleDjMode`, none of which the merged dispatch answers. So the ≡ door opens it (P3-4-2) but most of its surface is inert here; folding its VERBS means reimplementing them against the merged engine, verb group by verb group. THE LEVER for the signature verb: beat repeat lives in the core's `DeckWorld` (`beatRepeatStartStep/Length/Subdivision`, NativeAudioEngineCore.hpp:531-544) — fields the sl snapshot API cannot set (begin takes bpm/playing/startStep; track_set is track-scope). | measured → split | Split into: **P3-M-1a** (ABI: deck-scope snapshot fields — beatRepeat trio + `reverseActive` — via a `sl_snapshot_deck_set` keyed like track_set; SlWorldApply carries them from the world; worldFromSession emits them from companion state) · **P3-M-1b** (Master bar verbs: BR toggle + length cycler + REV, driving the companion state that publishes — the same store→publish lane scenes use; playful arrangement stays D-4) |
| P3-M-1a | build | Deck-scope snapshot fields (BR trio + reverse) | done | `sl_snapshot_deck_param_id/_set`, 6 keyed names, subdivision validated to 2/4/8/16/32; SlWorldApply forwards, absent = defaults. Fixture is AUDIBLE by necessity (the master step advances under a repeat by design) |
| P3-M-1b | build | Master bar verbs: BR + scale cycler + REV | done | Companion runtime state per deck (never the document), republished on change, cleared at closeDeck; fanned over every loaded deck; startStep 0 uniform-honest (per-deck playheads arrived later via D4-3). P3-M-1's functional baseline complete |
| P3-PUSH | gate | Push `main` to the `scoopy` remote after each green commit (repo private; roadmap: "sixteen commits exist only on this machine" — 6 unpushed as of 2026-07-28 session start) | recurring | never push a red tree |
| P3-AUDIT | spec | Phase audit before P3-G1 | done | Four domains audited ✅ (mixer / transport / tempo+sync / FX-send transport; RETURNS blocked → P6, measured twice). Gaps materialized as P3-X1 (later retired by D-4), P3-X2, P3-X3 |
| P3-X1 | build | **Grid + tape COEXIST in one strip** (STRIP-MODEL's own sentence: "a scoopy deck with a looper recording the deck's own output") — today `element` is a one-of union, so REC on a grid strip captures the deck's output correctly but REPLACES the grid element in the document. The data-model half (a strip holding both, lanes = sum) is buildable; HOW the two render in one 340×196 box is exactly the morph question | **retired-by-decision (D-4 SIGNED 2026-07-29, D-SL-MORPH-01)** | the user chose ONE KIND PER STRIP — no composite element, no migration. The use case survives as two routed strips: P3-R3 (REC on a grid strip spawns its looper strip) fixes this row's REPLACES defect the signed way |
| P3-X2 | build | DRV (master DSP) per strip — STRIP-MODEL: "reaches every strip, not just full decks"; deferred in P2 (the core has per-deck DRV; tapes have none) and still open | todo (measured) | **Measured 2026-07-28, the next loop's opening row:** the core's `NativeMasterDrive` is ALREADY per-deck (`deckMasterDrive_[kMaxDecks]`, four curves incl. the legacy-exact soft knee, decoupled drive mode) and self-contained — the tape-tier build is a per-channel instance in `sl_channel` at the STRIP-MODEL tap point (post-element, pre-level), grid channels PROJECTING onto the core's own deck drive (the no-double-gain rule), curve+amount as channel params, Inspector UI, audible fixture. The stretcher's reuse pattern, one tier over. Decision-free; sized like P3-2b-5 |
| P3-X3 | build | Strip presets — one-click looper | done | `+ looper` beside `+ strip`: channel + tape bound, named LOOPER N, input patched, REC one press away. Recording deliberately NOT auto-started. Honest refusals when resources run out |
| P3-X4 | build | **`webdist:check` was RED at HEAD** (found 2026-07-29 running the full gate suite for the plan-adjustment commit) — the gate that exists because "the JUCE shell ships the committed `webdist/` bundle and never builds the web UI itself, so a stale bundle means the app runs old UI against new engine/protocol code" | done | **The alarm was real, the danger was not — and the difference is worth writing down.** Regenerating changed exactly two files: `.buildhash` and one `.js.map`. Every emitted bundle kept its content-hashed filename (`index-Ch43PeDP.js`, `index-CfYhyTm2.css`, …), i.e. the shipped code was byte-identical, so **no pending real-host walk was ever looking at old UI.** Cause: `git diff f25f26e -- web/src web/protocol web/index.html web/vite.config.ts web/tsconfig.json web/package.json` is EMPTY — no source has changed since the last bundling commit — yet the `.buildhash` committed by that commit (P6-3) disagreed with its own source. So the hash was written from an earlier state during that commit and shipped stale. A bookkeeping failure, not a shipping one. Lesson for the gate line: `npm run bundle` must be the LAST step before `git add`, or the hash records a tree that no longer exists |
| P3-X5 | build | **`check:tokens` is RED at HEAD — 12 violations, all in `plane/plane.css`** (same discovery): 7 hardcoded font-sizes (9/7/11/11/11/10/10 px), 2 hardcoded z-indexes (39, 40), 2 hardcoded colors (a popover box-shadow, `.plane-library-verb.arm`), and one dangling `var(--bg-hover)` that is used but never defined. Mostly the P3-L1 library-popover era. The dangling var is the load-bearing one — a hover state that silently resolves to nothing | todo | decision-free; token names already exist (`--type-*-size`, `--z-*`), so this is a substitution pass plus defining or removing `--bg-hover` |
| P3-G1 | gate | **Phase gate (human):** on the user's machine — a grid deck and a tape in strips, both answering level/sends/transport/sync identically; sessions save and reopen; nothing of scoopy's unreachable | awaiting-user | offered only after P3-AUDIT |

## Decisions queued (do not block)

See `docs/merge/MORNING-DECISIONS-2.md`: D-1 session store flip (veto window),
D-2 tape beat inference, D-3 tape stretch latency policy, D-4 the playful strip
morph / visual direction, D-5 panel hosting taste calls from the audit.

# P3.5 — the strip becomes the deck (queued 2026-07-29, D-4 signed)

> D-4 SIGNED live 2026-07-29 (D-SL-MORPH-01): the strip's expanded face hosts the
> REAL `GridPanel` at DJ density; strips are one-kind-each (grid OR looper — P3-X1
> retired); dead panel doors retire; compose opens in a real separate window.
> Plan file: `~/.claude/plans/lets-continue-the-merge-shimmying-treasure.md`.
> Same loop protocol, same four rules. **Loop order:**
> P3-U8 → P3-L1 → P3-D4-M → P3-C1 → P3-C2 → P3-D4-3 → P3-D4-1 → P3-D4-2 →
> P3-R1 → P3-R2 → P3-R3 → P3-P1 → P3.5-AUDIT. Push after every green commit.

| id | type | item | status | handoff note |
|---|---|---|---|---|
| P3-U8 | build | Scene pads tell the truth | done | 1-based labels via `sceneDisplayLabel` (letters stay storage identity); pads = `enabledScenes(pattern)` prefix; `+` add-pad via new `setEnabledSceneCount` (clamp 1..8; shrink falls back to A). ⇧=queue deliberately unmapped — a plain click already queues. Door: the pad row on a loaded grid strip |
| P3-L1 | build | The library lives on the plane | done | `plane/Library.tsx` popover (list/New/rename/delete/import) over sessionStore/slFiles; `createSession` (create-not-load) + `renameSession` (open→save-as→delete, loaded-session gate); companion door DELETED (browser-only shell). Walk test rewritten through the plane. ⚠️ WKWebView `<input type=file>` import picker unverified — walk at P3.5-AUDIT |
| P3-C1 | build | Compose in a separate window | done | `composeArg.ts` unpadded base64url `{deck, session}` through the EXISTING `__slPanelArg` sanitizer; `useComposeBinding` extracted (one implementation, two faces); `ComposeWindow` boots sink-then-open + pagehide autosave flush; shell `slPanelClosed` broadcast. Single-publisher rule = C2 |
| P3-C2 | build | The single-publisher rule | done | `composingDecks` lock: strip wears COMP face (channel tier stays live), master fans over `activeDecks`, session swap/drop + double-open refused; `handlePanelClosed` releases with a 500 ms grace for the closing window's flush. KNOWN LIMIT: a crashed window leaves the lock until the session drops. Machine walk green first run |
| P3-D4-M | spec | Measure + sketch the deck tile | done | `docs/merge/STRIP-DECK.md`. Verdict: **plane-side adapter, ZERO shell changes** (GridPanel@dj reads `djMeta/djPattern/djRuntime` topics + 3 HotFrame blocks; writes terminate in the companion). Real blocker: BrowserLink's single-slot handlers. Expanded tile 2×3 cells (~688×604), collapsed 340×196 exactly |
| P3-D4-3 | build | Per-deck/per-track HotFrame telemetry | done | All 144 `djTrackStep/Pos/Level` slots were zero-filled and never written (permanent step-0 wash) — `sl_hotframe` now writes them: step folded through the deck BR window + reverse mirror, pos −1-honest, level un-gated (ringing is the point). Fixture pins step ADVANCES across a boundary. engine:check drift pre-existing, recorded |
| P3-D4-1a | build | The MasterRow becomes REAL (BPM·VOL·DRV wired) | done | 8 keyed deck-scope snapshot names (masterVolume + clipper, validated); `sessionParam` seam in BrowserLink routes the row's writes to DOCUMENT verbs (`setMasterVolume/setMasterDrive`, clamped, autosaved); `GridBackend.meta` serves document truth. Audible fixture: vol 0.5 halves the peak; decoupled drive 16 audibly hotter |
| P3-D4-1 | build | The deck tile renders the REAL GridPanel | done | Plane-side per D4-M: `GridTopicNames` + `djGridTopics(deck)`, BrowserLink per-scope handler MAPS (last-mount-wins structurally impossible), `useDeckTileBinding`/`DeckFace` (pointerdown claims the keyboard), ⤢/⤡ = document cell geometry (692×612 ↔ 340×196 to the pixel). Walk: expand → real `.track-strips.density-dj` + MasterRow. Door: ⤢ on any loaded strip |
| P3-D4-2 | build | Deck verbs into the strip header | done | Expanded tile only: ▶ · REV · BR + fused-scale cycler (one BR_SCALE table shared with the master) · ‹› NUDGE (REAL: transient `nudgeStore` folded through THE LAW — engine hears 124/120, displays follow live, never the document) · SAVE (flush) · ⏏. BR/REV state moved INTO DeckState; LCM bar computed web-side. Nudge feel provisional (±4) — rides P3.5-AUDIT |
| P3-R1 | fixture | Chain→record is audibly TRUE | done | §11b: routed tone → bus-tap REC → the tape plays it back with the input dead; unpatch → silent. The engine needed NO fix — the fixture's one find was its own missing `setSource` (the trap R3 remembers) |
| P3-R2 | build | One gesture "loop that strip" | done | ⋯ `record from` lists every other strip: sets the tap AND patches through the plane's own consent flow (wouldCycle reused, duplicate cables avoided). Status line names what REC will capture. Real-host walk rides P3.5-AUDIT |
| P3-R3 | build | REC on a grid strip spawns its looper (P3-X1's defect, the signed way) | done | `Strip.onRecord` grid branch → `recordIntoLooper`: `linkedLooperFor` (cable is the link, tap is the intent) or spawn `LOOP · <src>` patched from the SOURCE'S BUS (no cycle possible), channel bound to tape. The grid element NEVER moves. STRIP-MODEL amended |
| P3-P1 | build | Retire the dead doors (djmode/transport/deckmixer) | done | `PANEL_MENU_SURFACES` exported + pinned by `panelMenu.test.ts` — the trio cannot quietly return; panels stay routed (no door ≠ deleted). ≡ menu recorded as interim scaffolding |
| P3.5-AUDIT | spec | Diff this section + STRIP-DECK.md against built rows; materialize gaps; then offer the USER GATE: library walk (no companion window), compose-window walk (edit heard, no stale world), deck-tile walk (real DJ rows in a strip), looper-routing walk, pads 1–8 | done (2026-07-29) | **Every P3.5 row built** (U8 L1 D4-M C1 C2 D4-3 D4-1a D4-1 D4-2 R1 R2 R3 P1); STRIP-DECK's sketch fully realized (tile = header verbs + pads + real GridPanel + LCM bar + channel row; SYNC not duplicated into the header — one control one home, recorded deviation). **User real-host confirmations so far: the deck tile's grid IS visible in WizardMerged (2026-07-29) — the first P3.5 feature real-host-verified; first ergonomic finding "hard to control its UI" → wheel-inside-tile was zooming the PLANE (fixed: the deckface stops wheel propagation, its rows scroll).** Gaps materialized: **P3.5-E1** (tile ergonomics pass beyond the wheel fix — pointer precision under plane scale, dj band sizing in a 692px tile — feeds on the user's walk notes) · known limits carried: C2 crashed-window lock, no cross-tile arrow ring, shared ⌘Z timeline, L1's WKWebView import-picker unverified, D4-2 nudge feel provisional (±4 hold-bend). **USER GATE (the remaining walks): library · compose window · looper routing (two strips) · pads 1–8 · tile MasterRow audible (VOL halves, DRV drives) · nudge bend-and-snap — on the user's machine, at their pace; findings land as E-rows.** ⚠️ **2026-07-29: the looper-routing walk should WAIT for P3.5-E3** — a grid strip's bus is silent today (D-SL-DECKOUT-01), so that walk would "pass" visually while the take holds nothing. Walk it after E3, or expect the silence and read it as the known defect |
| P3.5-E1 | build | Tile ergonomics from the real-host walk: wheel fixed (this commit); remaining — dj band control sizing/precision at plane scale, tile-vs-plane gesture arbitration beyond wheel, whatever the walk surfaces | todo (user-fed) | opened by the user's "hard to control its UI" — collects walk findings |
| P3.5-E2 | build | Session refused to reopen after a flam edit (sparse arrays → JSON nulls) | done | Two seams: `applyGridPattern` writes per-step arrays DENSE (`dense(a, fill)` with native neutrals — `.map` alone preserves holes); `migrateTrack` heals null entries back to neutrals so locked-out sessions open again (rescue, not tolerance — nulls elsewhere still throw). Fix rides the webdist |
| P3.5-E3 | build | **A grid strip's channel bus is SILENT** (D-SL-DECKOUT-01) — `ChannelBank::mixInto` sets `elemL/elemR` for `ChannelSourceKind::tape` only (`sl_channel.cpp:598-604`; `sl_channel.h:186-197` says a gridDeck channel's meter reads 0 because "this bank deliberately mixes nothing for it"). So P3-R3's signed gesture spawns a looper that records SILENCE, and `channelBus` capture of a grid strip does the same. Measure the fix in-row: deck-out lane read inside `mixInto` vs a new `SourceEndpoint::deckOut` naming the core's existing `AudioLane::deckA/B/C_L/R` | todo (HOISTED ahead of P7 — a defect against shipped P3-R3, not a feature) | gate: audible ctest in the `sl_route_test`/`plane_audio_test` shape — a grid strip's bus carries its deck, and chained into a looper strip the take has energy, not silence |

# P6 — plugins on the returns (opened 2026-07-29, D-WZ-PDC-01 signed)

> The user's direction, verbatim intent: "we still need a strip mixer to control each
> volume and the fx send channel for plugin load, this can almost be as in scoopy —
> just needs to be fitted into the map system so we can also restore these settings
> (like a plugin loaded) within a map." Route: REUSE scoopyloops' own JUCE-based
> `NativePluginHost` (header already vendored; the core's per-return `NativePluginSlot`
> render machinery already in the vendored core behind `SCOOPY_PLUGIN_HOST=0`).
> The comparison audit (2026-07-29) confirmed the mixer/fx UI surfaces
> (DeckMixerPanel · FxSlotPanel · InstrumentPanel) are byte-identical in this tree —
> nothing to rebuild web-side; the work is host plumbing + map persistence.
> **Loop order:** P6-1 → P6-2 → P6-3 → P6-4 → P6-5 → P6-6 → P6-AUDIT. Same loop
> protocol, same four rules, push after green.
>
> **USER DECISION (2026-07-29, asked directly): the deck MIXER UI waits for the
> plumbing.** Run this queue as written — audible → editors → map → PDC — and
> then design the strip-integrated mixer (deck volume + FX send channels with
> plugin load + transport, per the recorded vision) as its OWN phase (P7), with
> everything underneath it already proven. DeckMixerPanel stays doorless until
> then; per-strip LEV/SEND faders on the plane remain the mixing surface.
>
> **AMENDED 2026-07-29 (D-6 … D-12 signed, same day, later):** P7 is RE-SCOPED as
> *"the deck, whole"* — the full deck-transport tile, full-viewport navigation,
> the live keymap and the launch chooser open NOW, because none of them need
> plugins. The strip-integrated mixer above survives as P7's TAIL (row P7-MIX-0),
> still blocked on P6-AUDIT exactly as this decision required. **P8** opens for
> the map performance overlay (D-SL-MAPPERF-01), **P9** for broad routing
> (D-SL-RECFROM-01), and **P10** is earmarked for the virtual interface
> (D-WZ-VDEV-02). One defect is hoisted ahead of all of it: **P3.5-E3**.

| id | type | item | status | handoff note |
|---|---|---|---|---|
| P6-1 | build | The host compiles IN (`NativePluginHost.mm`, flag, scan worker) | done | `.mm` at `ScoopyLoops/NativePluginHost.mm` (2 documented adaptations); `SCOOPY_PLUGIN_HOST_ENABLED` = one option two implementations — app compiles it real (JUCE AU/VST3 + CoreAudioKit), `scoopy_plugin_host_stub` serves JUCE-less gate tools via lazy-archive dispatch. Flag-ON≡OFF verified region-by-region, then ctest 65/65. Smoke: scanned Apple's AUDelay out-of-process, XML printed |
| P6-2 | build | The scanner reaches the UI (fxSlot dispatch, picker live) | done | `HostServices.pluginScanner` (headless dispatcher refuses by name — same code path IS the honesty proof); ABI v3 `sl_fx_select/name/latency_ms/teardown`; `toolbarState()` pushed ~2 Hz → FxSlotPanel leaves WaitingForState. Contract PINNED by exact key-set tests + C++-built JSON parsed by the real zod schema. Real-host walk (≡ FX 1 → RESCAN → pick) rides P6-AUDIT; AUDIBLE is P6-3 |
| P6-3 | build | A plugin is AUDIBLE on a return (= old P3-3-1/3-2): instantiate per-return `NativePluginSlot`, `returnFx: true`, strip sends 1–4 → return → plugin → wet lane audible for BOTH element kinds; plane_audio_test fixture (send up → return energy; send 0 → silence) | done | **PROVEN WITH A REAL AU**: new ctest gate `plugin_audible_test` (Apple-only, links the real `.mm`, SKIP 77 without AUDelay) — tape strip: tone → send → AUDelay → **tail 0.37 on MAIN after the input dies**, unfakeable; grid strip: deck world + strip send fader → **gridTail 0.28 after the world stops**; unload → tail gone. Three measured laws en route: (1) the channel mixer adds strip sends AFTER `core.render` and render() REBUILDS the send lanes every block, so tape-strip sends reach a plugin only via the core's new `hostSendFeed` buffers (seam writes last block's strip-send diff — one block late, P6-6's territory; grid sends are core-internal, same-block); (2) host-mode returns CONSUME the send bus and zero the lane on the way out — by design ("wet returns to main"), so §16's grid half pins the command chain, not the lane; (3) returns 1/2's wet stage was snapshot-gated (`ret1 != nullptr`) — a worldless host now takes the same imperative path as returns 3/4 (no-snapshot fallback, flag-guarded). Plus: lock-free `isLoadedLockFree` (audio-thread probe; `hasPlugin()` takes the slot mutex), `returnHostActive`, `returnFx` capability rides the scanner (companionEngine's hardcoded `disableReturnFx: true` now reads the capability — sends travel in the merged host, stay zeroed in the browser). `send` is 0-BASED at the ABI (§11's convention, two fixtures corrected). OPEN measurement: per-track grid send dials (world `send1Level` → lane) unproven — the strip-fader path is; dials ride P6-AUDIT. ctest 66/66 · vitest 1452 · plane+walk · bundle fresh · app boots. **Real-host: FX 1 → pick a plugin → raise a strip's SEND → wet in the mix** |
| P6-4 | build | Plugin EDITOR windows, JUCE-hosted (the job FxSlotWindowController.swift did on the desktop): open/close per return through the existing openPanelWindow lane; editor visibility state per F1–F4 | todo | |
| P6-5 | build | THE MAP REMEMBERS (the user's sentence made literal): `.scoopyMap` gains per-return fx-slot state — plugin `identifier` (createIdentifierString, designed for persistence) + opaque state blob + mode/output; restored on map open, honest refusal when a plugin is missing on this machine | todo | |
| P6-6 | build | PDC per the signed policy: parallel-path compensation only, per-channel latency exposed in the UI, insert latency subtracted from record-path stamps | todo | |
| P6-AUDIT | spec | Diff this section against built rows; then the user gate: load a plugin on FX1, hear a strip's send through it, tweak it in its editor, save the map, reopen — the plugin and its settings come back | todo | offered after all rows |

# P7 — the deck, whole (opened 2026-07-29; D-SL-DECKFULL-01 · D-SL-LAUNCH-01 · D-SL-NAV-01 signed)

> The user's redirection, verbatim intent: "a strip will not hold ALL items at once …
> the scoopy strip window (deck) will be pretty much exactly the scoopy loops dj deck
> view WITH its deck transport … this way we can be sure our advanced scoopy system
> functions correctly ongoing, we can switch to composing mode from here." Plus: a
> launch prompt for PLANE or COMPOSE, and "the list is long and should work fully, so
> we need to be able to high decks and strip to use our navigation system — strips
> should be full viewport on command and then be able to tab through the individual
> strips in full size."
>
> **What this phase is NOT:** a new deck UI. Every classic component is already ported
> (`TransportPanel.tsx::DeckBlock` + `DjMasterBox` + `LcmBar`, `ScenePads.tsx`,
> `NudgeBox.tsx`, `MasterRow.tsx`, `trackRowControls.tsx`). But `DeckBlock` speaks
> `deckSection` / `transportDeck` / `menuTransport` / `djSetting` and reads the
> `toolbar` + `dj` UiState topics — none of which the merged dispatch answers (the
> P3-M-1 measurement; the reason P3-P1 retired those doors). So the rows below
> **REBUILD each row on companion lanes, the P3-D4-2 pattern**, using DeckBlock as the
> source list. Same for shortcuts: ~90 of ~100 keymap entries are `owner:"native"`,
> dispatched by a Swift `HotkeyManager` that does not exist here, through a `forwardKey`
> command `shell/` never handles — the keymap's own header already names the TS
> dispatcher as the plan, and P7-K1 finally builds it.
>
> **Loop order:** P7-K0 → P7-L1 → P7-L2 → P7-L3 → P7-N1 → P7-N2 → P7-K1 → P7-K2 →
> P7-K3 → P7-T1 → P7-T2 → P7-T3 → P7-T4 → P7-T5 → P7-V1 → P7-V2 → P7-V3 →
> P7-MIX-0 (when P6-AUDIT signs) → P7-AUDIT → P7-G1. Same loop protocol, same four
> rules, push after green.
>
> **Global order across phases:** P3-X2 (P3 close-out, §11 priority) → **P3.5-E3**
> (hoisted defect) → P6-4 → P6-5 → P6-6 → P6-AUDIT → P7 → P8 → P9 → (P10). P3.5-E1
> stays user-fed in parallel.
>
> **Verify, every row:** `ctest --test-dir build --output-on-failure` +
> `npm run typecheck && npm test && npm run protocol:check`; UI rows add a Chromium
> walk against the BUILT bundle. Real-host reachability in WizardMerged is proven at
> P7-AUDIT/P7-G1 — tests pass ≠ it works ≠ it shipped ≠ you can reach it.

| id | type | item | status | handoff note |
|---|---|---|---|---|
| P7-K0 | spec | `docs/merge/NAV-SHORTCUTS.md`: audit all ~100 keymap entries — a merged-verb target per entry, the `dj`→focused-strip context map, the digit-allocation ruling (provisional: digits = scenes on the focused strip, ⌘/⌥-digits = focus jump, Tab/⇧Tab = cycle), and every dead entry parked WITH its reason. Also picks the full-viewport mechanism (plane transform vs overlay mount) | todo | the doc IS the row; every entry ends with a target or a written reason |
| P7-L1 | build | ComposeWindow gains session open / new / save UI (surface `sessionStore`'s existing verbs; reuse the plane's `library ▾` popover shape) — and works with NO plane or map alive | todo | gate: Chromium walk — new → edit → save → reopen inside a lone compose window |
| P7-L2 | build | Launch chooser in the shell: boot prompts PLANE / COMPOSE; the compose path opens ComposeWindow on deck 0 and creates NO map (D-SL-LAUNCH-01). Today `MergedMain.cpp:334` is an unconditional `openPanel("plane", "", isMain)` | todo | gate: ctest green; both doors reachable at boot — real-host proof rides P7-G1 |
| P7-L3 | fixture | Boot-path walk: chooser → compose (mapless session round-trip) and chooser → plane (today's boot, unchanged) | todo | gate: walk green on the built bundle |
| P7-N1 | build | Strip focus model: exactly ONE focused strip (store + a visible identity ring), claimed by click/expand; `deckTile.tsx::claimKeyboard`'s module-state arbitration folds into it | todo | gate: walk — the ring follows clicks; arrows still land in the expanded tile |
| P7-N2 | build | Focus traversal: Tab/⇧Tab cycles strips in stable geometry order; digit scheme per K0's ruling | todo | gate: walk — the ring visits every strip and wraps |
| P7-K1 | build | **The JS dispatch layer** (the keymap's own deferred "TS dispatcher"): plane-window keydown → keymap lookup by context → command. Retires the `forwardKey`/`useNativeKeyForwarding` lane; registry-owned entries (⌘Z etc.) keep their path. Keep `Generated/ShortcutList.swift` honest or retire it in the same commit — `protocol:check` gates its drift | todo | gate: web green INCLUDING protocol:check; the collision test extends per-context |
| P7-K2 | build | Focused-strip semantics: deck-A/B pair entries (Q/W/E vs A/S/D, `-` switch deck, ⌘⇧1/2/3 send-to-deck) collapse to one chord set targeting the focused strip — a keymap edit plus a dispatcher `strip` context | todo | gate: unit — every former A/B pair resolves against focus; walk — Q/W/E drive the focused strip |
| P7-K3 | fixture | Coverage gate: every keymap entry either dispatches to a live handler or is explicitly parked. No silent dead chords | todo | the fixture IS the gate; red on any orphan entry |
| P7-T1 | build | Classic **toolbar row** in the expanded tile: OPEN (library popover addressed to this strip) · ■ · ▶ · » (companion transport + skipStep) · DBL (a new companion pattern-double verb). D4-2's header verbs (REV · NUDGE · SAVE · ⏏) migrate DOWN into this row — one control, one home | todo | gate: walk — the row renders and every verb round-trips; ctest untouched-green |
| P7-T2 | build | **SYNC/pulse + TR · WIN · BR row**: the beat-repeat variants beyond the fused scale (per-deck playhead has existed since D4-3); SYNC promoted out of the grid row | todo | gate: an audible fixture for one TR/WIN variant (the D4-3 shape) + walk |
| P7-T3 | build | **Scene row parity**: pads 1–8 (P3-U8's pads rehomed) + S · R · CU · SCN · MUTE + GRID/PERF toggles (`GridMetaState`'s `gridHidden`/`performOn`; SCN is the pin latch) | todo | gate: walk — each toggle flips real state; vitest pins the SCN latch routing |
| P7-T4 | build | **Master row completes**: BPM/VOL/DRV are real since D4-1a; S1–S4 master sends become real (`masterSends` meta was `[]`; the lanes exist since P6-3) | todo | gate: audible fixture — master send up → return energy (extends plane_audio_test). NOT provable in Chromium: `returnFx` is false in the browser host |
| P7-T5 | fixture | Tile walk: the expanded tile shows all four classic rows, compared against the scoopy deck view reference | todo | gate: Chromium walk green; real-host confirmation rides P7-G1 |
| P7-V1 | build | **Full-viewport mode**: the focused strip fills the viewport on command (mechanism per K0's ruling — a VIEW state, NEVER a document cell edit), one key drops back to the map | todo | gate: walk — enter/leave; the saved map's plane geometry is untouched afterwards |
| P7-V2 | build | Tab cycles strips AT full size (reuses N2's ring); the compose door stays reachable from the full-viewport face | todo | gate: walk — a Tab ride through 3 strips at full size, compose opens from there |
| P7-V3 | fixture | Viewport walk including looper strips at full size (channel face — no grid) and keyboard reachability of every verb | todo | gate: walk green |
| P7-MIX-0 | spec | The strip-integrated mixer (deck volume + FX send channels with plugin load) designed on proven plumbing — the 2026-07-29 earmark, unchanged | blocked(P6-AUDIT not signed) | its own rows materialize when P6 closes |
| P7-P1 | build | Looper transport parity: deck-like transport on tape strips — the user's own example was "rate slider with fixed values" | blocked(user-deferred 2026-07-29 — "later on") | opens on the user's call; scope sketch rides the STRIP-MODEL amendment |
| P7-AUDIT | spec | Diff this section against NAV-SHORTCUTS.md + STRIP-DECK.md; materialize every gap as a row; then offer the gate | todo | audit before gate, per §11 |
| P7-G1 | gate | **Human, real host:** the launch chooser's both doors · the expanded tile IS the classic deck with live verbs · a full-viewport Tab ride · the shortcut list worked by hand | awaiting-user (after P7-AUDIT) | the four rules, on the user's machine |

# P8 — the map holds the performance (opened 2026-07-29, D-SL-MAPPERF-01 signed)

> The user: "a map should basically hold all settings saved, but be flexible on devices
> and hardware routings of course. anything that is worth storing so it can be restored
> easily for a performance." Sync information ALREADY persists in full (per element:
> `bpm`, `syncToMaster`, `tempoMode`, `pulseRelation`, `transpose`, `rate`, `loop`,
> `takeRef`, plus `transport.masterBpm`) — this phase adds the layer that does not.
>
> The overlay is also the answer to MAP-SCHEMA.md's two ⚠️ hazards, which is why they
> are marked settled there: **plane-surface session-parameter edits land in the
> OVERLAY, compose edits land in the SESSION**, and the overlay is re-applied after any
> republish. P3-D4-1a crossed the "settle this first" line when MasterRow's BPM/VOL/DRV
> became real document writes; D-SL-MAPPERF-01 legalizes that retroactively and P8-4
> moves where the value lands (the control does not change).
>
> The fx-slot half of "the map remembers" stays in P6 as **P6-5** — P8-6's gate needs it.
>
> **Loop order:** P8-1 → P8-2 → P8-3 → P8-4 → P8-5 → P8-6 → P8-AUDIT → P8-G1.

| id | type | item | status | handoff note |
|---|---|---|---|---|
| P8-1 | spec | MAP-SCHEMA amendment made concrete: the overlay field shape (generalizing `sessionPerf`/`perfBySession`), the write-routing law, the re-apply triggers, and the migration from today's four-field shape | todo | gate: the doc lands and both ⚠️ hazards read resolved-by-decision |
| P8-2 | build | Overlay store + re-apply at map load (extends `planApply`; `MAP_SCHEMA_VERSION` bump + a named migration, per the strict-Zod discipline) | todo | gate: vitest — a fixture map round-trips the overlay; both parse directions pinned |
| P8-3 | build | Re-apply after a compose republish: P3-C2's republish / `handlePanelClosed` lane triggers an overlay re-apply for that deck — the stomp hazard closed in code | todo | gate: fixture — republish with different values, the overlay's value wins after re-apply |
| P8-4 | build | Plane session-parameter writes land in the overlay (the MasterRow BPM/VOL/DRV reroute — same control, different persistence target; amends where D4-1a's writes settle) | todo | gate: fixture — a tweak in map A is invisible in map B using the same session |
| P8-5 | build | `tapeLoadTake` becomes REAL: an ABI path to load a take/file into a tape (today a documented no-op at `mapStore.ts:220`, so a reopened map's tape audio never comes back). Sized like P3-2b-5 | todo | gate: ctest — save a map with a looper take, reopen, hear it play |
| P8-6 | fixture | **The map round-trip GATE** (MAP-SCHEMA's "a gate, not a hope"): a grid strip with a scene + an overlay tweak, a looper with a take, and an fx plugin (needs P6-5) → save → reopen → everything back | todo | one fixture, mirroring `sl_route_test`'s wipe-rebuild-compare shape |
| P8-P1 | build | MIDI mapping persistence | blocked(the merged shell publishes no `midiLearn` topic — `attachMidiLearn` subscribes to nothing, `midiHardware: false`) | a recorded dependency, not a promise; opens when the shell grows the topic |
| P8-AUDIT | spec | Diff this section against the MAP-SCHEMA amendment; materialize gaps | todo | before the gate |
| P8-G1 | gate | **Human:** build a set, tweak levels/scenes on the plane, save the map, edit that session in compose, reopen — every tweak is back and NOTHING bled into the library session | awaiting-user | on the user's machine |

# P9 — broad routing (opened 2026-07-29; D-SL-RECFROM-01 · D-WZ-VDEV-02 signed)

> Opened by the user's question — "we need to map out the new routing matrix as well,
> how good is the backend for this already? … we should find intuitive ways to choose
> audio inputs for looper (via fx send from a deck e.g. or the virtual interface that
> would allow other app audio right in the session)". Governing design:
> `docs/merge/ROUTING-MATRIX.md`.
>
> **The backend answer, measured 2026-07-29: strong, and the gaps are UI.** `sl_route_*`
> carries 128 ramped routes; sources `channelOut` · `channelSend` · `deviceInput` ·
> `fxReturn`; destinations `channelIn` · `sendBus` · `main`; Kahn-ordered zero-latency
> chains with edit-time cycle refusal and consented one-block feedback edges; the whole
> graph enumerates and rebuilds to bit-identical audio. `slengine/tools/sl_route_test.cpp`
> proves all of it, including **send tap → another strip's input** — the exact path the
> user asked for, engine-proven, with NO UI able to author one (`patchDrag` is always
> built with `send: null`). So this phase is authoring surfaces, missing kinds, and the
> hygiene debt the measurement surfaced — not engine work.
>
> **Not queued here, recorded as designed-not-built:** the cue bus and per-deck outs
> (lanes the core already produces that `sl_route_*` cannot name), multiple hardware
> output pairs, and the per-hardware-output limiter (guard G1 — the watchdog is
> main-bus-only). They open on the user's call.
>
> **Loop order:** P9-1 → P9-2 → P9-3 → P9-4 → P9-5 → P9-AUDIT → P9-G1.

| id | type | item | status | handoff note |
|---|---|---|---|---|
| P9-1 | build | `record from ▸` grows every source kind (D-SL-RECFROM-01): other strips' **send taps** S1–S4 and **FX returns** (the record-the-wet path STRIP-MODEL names), alongside today's bus + device inputs. Reuses the existing consent flow (`wouldCycle`) and duplicate-cable guard | todo | gate: walk — a deck's send into a looper's record tap, heard back; fixture pins the `channelSend` route the gesture authors |
| P9-2 | build | The Matrix grows AUTHORING: the sources × destinations grid editor (ROUTING-MATRIX's second view — today `Matrix.tsx` is a read-only ledger with one ✕ per row), plus route-gain editing (`slRoute/setGain` is dispatch-live with zero web callers) and the feedback toggle | todo | gate: walk — add, re-gain and remove a cable from the grid; the ledger and the plane cables agree |
| P9-3 | build | Routing hygiene, all three measured 2026-07-29: the duplicate-cable guard moves into `patch()` proper (today only `onRecordFromStrip` checks, so a repeated shift-drag silently doubles gain); feedback edges are **created muted** (ROUTING-MATRIX's own standing precedent, not honoured — `commitPatch` sends gain 1); `feedbackMs()` reads the LIVE block size and sample rate instead of hardcoding 512/48000, so the price shown on every cable and in the consent menu is true | todo | gate: vitest per fix + a walk for the muted-feedback path |
| P9-4 | build | Accumulated path latency (guard G4 from `pd-modular-routing.md`, half-built): a per-PATH total on the cable/strip, not just the per-cable `+10.7 ms`. Feeds P6-6's PDC surface — and has a live customer already, the tape-strip `hostSendFeed` seam that puts a tape's send one block behind a grid's into the same plugin | todo | gate: vitest on the accumulation math + the number visible in the walk |
| P9-5 | spec | The interim other-app-audio path documented (D-WZ-VDEV-02): a third-party virtual device (BlackHole/Loopback) selected through `slDevices/setInput`, then an ordinary `deviceInput` route — plus a hint in the input picker. No engine code | todo | gate: the doc + the hint reachable in the real host |
| P9-AUDIT | spec | Diff this section against ROUTING-MATRIX.md; materialize gaps; the cue bus, per-deck outs, multi-output and G1 stay recorded-not-queued unless the user calls them | todo | before the gate |
| P9-G1 | gate | **Human, real host:** a deck's send tap into a looper records the send · an FX return routed into a strip records the wet · another app's audio arrives through a third-party virtual device | awaiting-user | on the user's machine |

# P10 — the virtual interface (EARMARKED 2026-07-29, D-WZ-VDEV-02; no rows yet)

> Unparks D-WZ-VDEV-01's native **Wizard Out** device — 16 channels / 8 stereo pairs,
> app-agnostic and Loopback-style, so any running app's audio lands in the session
> without a per-app bridge. Opens after P9-AUDIT; P9-5 carries the interim path
> meanwhile, so nothing in P9 waits on this.
>
> What already exists: the capture ABI (`host/include/wz_capture.h` — `WZ_SRC_PROCESS`,
> `WZ_SRC_SYSTEM_MIX_EXCEPT`, `WZ_SRC_VIRTUAL_INPUT`, topology generation, timestamped
> delivery) and the full macOS design (ARCHITECTURE.md §"capture" — process-tap via
> `CATapDescription` → private aggregate device; the virtual device as a standalone
> AudioServerPlugIn loopback driver read back as a normal CoreAudio input; macOS 14.4
> floor; PipeWire null-sink on Linux). What does NOT: any real backend (only
> `host/src/CaptureFake.cpp`), and any `sl_route_*` `virtualDeviceInput` SOURCE KIND —
> the capture machinery belongs to the legacy `wz_engine` world and does not reach the
> current engine at all. MIGRATION.md's P2-05/06/07 rows are unparked by this decision
> and point here. Rows materialize when the phase opens.
