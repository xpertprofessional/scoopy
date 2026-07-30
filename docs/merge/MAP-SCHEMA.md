# MAP-SCHEMA — the `.scoopyMap` document (draft, P0-C)

*P0-C of the wizard×scoopy merge. Fields only — no code lands with this doc. The map is
the merged app's top-level document: a whole setup on the plane. It follows wizard's
envelope discipline (`web/src/persist/session.ts`: SCHEMA_VERSION + named per-version
migrations, strict Zod, preserve-don't-drop) and scoopy's package law (self-contained,
portable formats). PD-MERGE's four-surfaces rule holds: a strip has no kind — only a
source and (maybe) material; a scoopy session is just another material.*

## Package layout (STORED zip, like `.wizard` / `.scoopySession`)

```
Setname.scoopyMap/
  map.json          — the document below
  Sessions/<id>/    — embedded .scoopySession packages, BY COPY (D7)
  Takes/            — raw BWF takes (Law C-2 TimeReference) + baked derivatives
  Samples/          — loose deck material not owned by an embedded session
```

Embed-by-copy is the law (D7): a map survives moved/deleted originals. "Export session"
extracts an embedded session back to a standalone `.scoopySession`. Sessions inside a
map are edited in place (compose mode edits the embedded copy).

## map.json (envelope + document)

```
{ schemaVersion, savedAt, app: "scoopy", map: { … } }   — wizard SessionSchema shape
```

### map

| Field | Notes |
|---|---|
| `plane` | `{scale, panX, panY}` — wizard `PlaneSchema`, UI-only |
| `strips[≤8]` | the 8 deck-strips (D3), see below |
| `slots` | `{left: stripKey\|null, right: stripKey\|null}` — the two performance slots (D2); drives shortcuts + HQ privilege |
| `transport` | `{masterBpm, playing}` — live ramp state is runtime, not persisted |
| `sends[4]` | FX send slots, see below |
| `outputMap` | bus → device-channel pairs (wizard `OutputMapSchema`; deck pairs + main + cue) |
| `recorderPreset` | ONE global vintage-import preset for the record→bake path (D6); same shape as scoopy's `VintageImportSnapshot` (PatternFile v25) |
| `device` | remembered audio device (wizard `SessionDeviceSchema` pattern) |

### strip (one object, wizard `ChannelSchema` extended)

| Field | Notes |
|---|---|
| `key`, `name`, `cell {x,y,w,h}` | identity + plane geometry |
| `source` | wizard `SourceRef` — full `SourceKind` enum kept; `appTap`/`systemMixExcept`/`virtualDeviceInput` stay expressible-but-parked (D4); a strip listening to a bus arrives muted (PD-MERGE law) |
| `material` | `null` \| `{kind:"take", ref, freeTime?}` \| `{kind:"file", ref}` \| `{kind:"session", sessionId}` — the session case is what makes a deck "a scoopy session on the map" |
| `gain, pan, mute, solo, toCue, outBus` | mix state (deck-scope params, ABI §3) |
| `tempoMode` | `timePitch \| timeStretch \| tempoOnly` — per deck (plan §sync) |
| `rate` | signed varispeed (buffer material; session material derives rate from tempo laws) |
| `sends[4]` | deck-master send levels (8×4 total; session-internal per-track sends sum into the same four lanes) |
| `loop` | `{enabled, start, end}` (buffer material) |
| `recordArm`, `recordSource` | capture channels (engine-input indices) |

`freeTime: true` marks a take recorded across a tempo ramp (D5) — no bar-exact loop
guarantee; UI shows the flag and offers manual alignment (wizard `takeAlign` semantics).

Takes carry dual stamps: `startEngineSample` (Law C-2) **and** `{bar, beat, bpmAtStart}`.

### send slot (×4)

| Field | Notes |
|---|---|
| `kind` | `plugin \| ext \| empty` |
| `pluginRef` | portable from day one: `{manufacturer, name, version, formatHints: {vst3?, au?, lv2?}}` — the CROSS-PLATFORM §3.3 fix; unresolvable = inert + preserved, never dropped |
| `stateBase64` | opaque per-format plugin state |
| `extRouting` | `{outChans: [l,r], inChans: [l,r], trimSamples}` — EXT hardware round-trip with measured/user offset |
| `returnGain, returnPan, returnMute` | return-channel mix |

## AMENDMENT 2026-07-25 — sessions are REFERENCED, and the map owns a
## PERFORMANCE LAYER (supersedes D7's embed-by-copy)

*Decided with the user. D7 said embedded sessions travel BY COPY and "sessions
inside a map are edited in place (compose mode edits the embedded copy)". That
is withdrawn.*

### The reframing

The embedding question was two different kinds of edit wearing one name:

- a **performance edit** (level, mute, sends, sync, which scene is running,
  track mutes) is about THIS PERFORMANCE — it belongs to the map, changes
  constantly, and is meaningless outside it;
- a **composition edit** (samples, patterns, chops, sound design) is about THE
  SESSION — it belongs to the library and must propagate everywhere that session
  is used.

Split them and the dilemma dissolves. What has to survive save/restore is not
the session, it is YOUR TWEAKS — and those live in the map. The session stays a
reference, so **swapping a strip's session is cheap**, which embed-by-copy made
expensive for no benefit (the user's point: a strip is a slot, not a container).

### Why this is cheap rather than new machinery

Two precedents already exist:

1. **Tempo already works this way.** `element.grid` holds the session's OWN
   `bpm` (composition) and `syncToMaster` (performance intent); `planApply`
   derives the ratio. This generalises that, it does not invent it.
2. **The engine already has the override lane.** scoopy's core carries "live
   per-track control overrides (analog-desk immediacy)": a fader move is honored
   until a world republish carries the same value, with an epoch gate handing
   control back seamlessly. That IS a performance layer over a composition
   snapshot, already shipping. The document only has to PERSIST what the engine
   already applies.

### Scope — NARROWED after reading scoopy's scene model

*First cut said "mix + transport + scene incl. per-track mute/solo". Reading
`SceneUiState` showed that would have DUPLICATED machinery that already exists.*

**scoopy already has a performance/composition split: the PIN mechanism (CM-3).**
"A parameter is normally global across scenes; pinning it makes it scene-local",
with a `latched` mode (SCN, hotkey 9) deciding whether an edit lands in the scene
or globally, and `pinnableMasterKeys` / `pinnableTrackFields` declaring what is
eligible (sends deliberately absent). A session therefore already has two layers:
global params, and scene-pinned overrides.

So the map's layer is a THIRD, and it is justified ONLY for what differs between
two maps using the same session. Applying that test:

| Field | Owner | Why |
|---|---|---|
| channel level · mute · sends | **map** (already the strip's) | outside the session entirely |
| deck `bpm` + `syncToMaster` | **map** (already the element's) | per-strip tempo intent |
| `currentScene` | **map** | map A plays scene C while map B plays scene A |
| `switchMode` · `queuedScenes` · `queueLoop` | **map** | how you launch is a per-set choice; it should come back as you left it |
| `cleanCut` | app | already a global preference, persisted natively |
| per-track mute / solo | **session** | PINNABLE — two ways to mute with different persistence is a trap |
| per-track volume/pan/tone | **session** | global or scene-pinned; the pin mechanism is the answer |
| FX / macro state | **session** | a scene carries its own pinned DSP; the map points at the scene |

Net: for a grid strip the layer is roughly *"which scene, and how it switches"*.
Everything richer was considered and rejected — the wider the layer, the more the
map becomes a second composition surface, which is the two-homes problem
relocated rather than solved.

```
strip.element.grid.perfBySession: Record<sessionId, {
  currentScene: string          // "A".."H"
  switchMode: "scheduled" | "seamlessImmediate" | "restartImmediate"
  queuedScenes: string[]
  queueLoop: boolean
}>
```

### ⚠️ The sharper hazard: unpinned edits bleed across maps — **RESOLVED BY DECISION**

*Settled in principle 2026-07-29 (D-SL-MAPPERF-01). Made concrete, and made
checkable, by the **2026-07-30 P8-1 amendment, §2 below**: every plane door that
writes a session parameter today is named there — five of them, not the three the
ledger carried — and each is given a routing target. Nothing about this hazard is
left to a later reader's judgement.*

With the latch OFF, an edit is **global to the session** — so a tweak made while
performing from one map propagates to every other map using that session. This is
the two-homes problem arriving by a different road: not two copies of a session,
but one session quietly reshaped by last night's set.

The channel is safe (it is the strip's). But any map control that writes SESSION
parameters must be explicit about where the value lands. "The map is playing" is
arguably a context where the latch should default ON, or where such edits should
be refused outright and sent to compose. **Settle this before the plane UI exposes
any session-parameter control.**

*That line was crossed by P3-D4-1a and has stayed crossed. §2 states where each
value lands; §2's last paragraph states the one case that deliberately keeps
writing the session, and why that is a decision rather than a leak.*

### Keyed by (strip, sessionId), not by strip

A strip can swap sessions and swap back, and the tweaks must return. Storing the
performance state per PAIRING costs a few hundred bytes each and means swapping
to a different session does not inherit track mutes that mean nothing there.

```
strip.element.grid.perfBySession: Record<sessionId, {
  scene, trackMutes[], trackSolos[], loop{...}|null, launchQuantize
}>
```

### Portability: reference by default, COLLECT on export

Working maps reference the session library; a session that cannot be resolved is
an **unresolved strip**, handled exactly as an unresolved take already is (the
strip, its reference and its record button all survive — see `takeLibrary.ts`).
An explicit "collect" produces a self-contained map for travel. Collecting is
then something the user DID, not something they have to trust happened.

### ⚠️ The hazard to design in, not discover — **RESOLVED BY DECISION**

*Settled in principle 2026-07-29 (D-SL-MAPPERF-01). Made concrete by the
**2026-07-30 P8-1 amendment, §3 below**: four named re-apply triggers, one named
hook each, and a **fifth trigger that is explicitly REFUSED** (the compose window
must never be overlaid). §3 also corrects this paragraph's own proposed fix —
"the same code on a different trigger" is wrong, and believing it is how the
stomp fix would have re-opened the bleed hazard. See §3's "one mechanism, two
hazards".*

A compose edit republishes that deck's world, and the core's epoch gate hands
control back to the snapshot when a republish carries different values — so a
republish CAN STOMP a live performance override. **The map must re-apply its
performance layer after any republish of that deck.** It already does exactly
this at load (`planApply`), so it is the same code on a different trigger. Left
undesigned, the symptom is "I set a level in the map, someone saved in compose,
and my tweak vanished mid-set."

### Compose alongside the map

Architecturally already supported: scoopy's web UI is multi-panel (`PanelRoute`
on `__slPanel`, one window per panel) and `MergedMain.cpp` already spawns extra
windows for the instrument/FX/routing panels. Compose-beside-the-map is a new
route, not new machinery, and per-deck worlds mean an edit republishes only that
deck.

## AMENDMENT 2026-07-25 — the routing graph

*This document is the P0-C draft and predates the routing work. The engine that
now exists (SL-ABI-V3 §4, `sl_route_*`) makes two of the fields above
incomplete. The original text is kept as the record; these are the deltas.*

### `map.routes[]` — new, and it is where the patchbay lives

The matrix is any-source → any-destination, so a cable can no longer be
expressed as a field on the strip it leaves. Each entry:

| Field | Notes |
|---|---|
| `src` | `{kind, index, sub?}` — kind `channelOut \| channelSend \| deviceInput \| fxReturn`. `sub` is the send 0–3 for `channelSend`, or the right-hand input channel for `deviceInput` |
| `dst` | `{kind, index}` — kind `channelIn \| sendBus \| main` |
| `gain` | ramped on apply; a re-patch is a crossfade, never a switch |
| `feedback` | **the load-bearing flag.** 0 = tap-by-order, rendered in dependency order at ZERO added latency, and REFUSED if it would close a cycle. 1 = tap-by-delay, reads the previous block, one block (~10.7 ms at 512/48k), and is the only edge allowed to close a loop. See ROUTING-MATRIX.md for why this is not "everything is one block late" |

### `strip.outBus` is superseded

A strip's output is now a route (`channelOut → main`, or anywhere else), so
`outBus` cannot express what the engine can do — a strip may feed several
destinations, or none. Keep reading `outBus` in the v-bump migration and
translate it into one `channelOut → main` route; do not keep writing it.

### `strip.sends[4]` keeps the LEVELS and loses the destinations

Decision 5 (2026-07-25): **the channel owns the send's level, the routing
document owns its destination.** So `sends[4]` stays exactly as it is — four
per-strip levels — and where each one goes is a `channelSend` route. The
default is send *n* → FX bus *n*, which is what makes the common case invisible;
re-pointing send 3 at another strip's input is then just an edit to that route,
and riding the send fader still works because the level never left the channel.

### The boot wiring is real routes, so saving must be deliberate

A fresh engine installs 40 default routes (every channel → main, every send →
its FX bus) so a new strip is audible without ceremony. They are ordinary
routes: visible in the matrix, removable, re-pointable, and flagged
`isDefault`. **A document load must therefore `sl_route_clear_all` before
installing its own**, or the saved patch is layered on top of the defaults and
a session gains phantom cables every time it is opened.

### Round-trip is a gate, not a hope

`sl_route_test` proves the contract at engine level without a file: enumerate
the whole graph, wipe it, rebuild from what was read, and assert the rendered
audio is identical (43 routes, main 2.7692 → 2.7692). The map's own save/load
gate should mirror that shape — a save/load that quietly drops one cable is the
failure that only shows up on stage.

## AMENDMENT 2026-07-29 — the performance overlay (D-SL-MAPPERF-01)

*The user: "a map should basically hold all settings saved, but be flexible on
devices and hardware routings of course. anything that is worth storing so it can
be restored easily for a performance." This amendment answers that AND both ⚠️
hazards above, which are marked settled where they stand. Build record: the P8
queue in `P3-LEDGER.md`.*

### The overlay generalizes `perfBySession`

`strip.sessionPerf` today holds four fields per (strip, sessionId) — currentScene,
switchMode, queuedScenes, queueLoop — deliberately narrow because scoopy's PIN
mechanism (CM-3) owns per-track mute/volume/FX. It **generalizes into a
performance overlay** carrying every session-level setting worth restoring for a
performance, on the same (strip, sessionId) key for the same reason: a strip can
swap sessions and swap back, and the tweaks must return. Field shape and the
migration from the four-field form are P8-1's deliverable.

### The write-routing law (this is what settles the bleed hazard)

> **Plane-surface edits to session parameters land in the OVERLAY. Compose edits
> land in the SESSION.**

The session file stays canonical and shared; nothing a performance does reshapes
it, so last night's set cannot leak into every other map that references it. The
hazard section above demanded this be settled *before the plane UI exposes any
session-parameter control* — that line was crossed by P3-D4-1a, when the deck
tile's MasterRow BPM/VOL/DRV became real document writes at the user's direction
("work from the real scoopy perspective"). D-SL-MAPPERF-01 legalizes it
retroactively and row **P8-4** moves where the value lands. The control's
behaviour does not change; only its persistence target does.

### Re-apply is law, not a hope (this is what settles the stomp hazard)

The overlay is re-applied **at map load AND after any compose republish of that
deck**. That is the fix the hazard section proposed itself — "it already does
exactly this at load (`planApply`), so it is the same code on a different
trigger" — now signed and built as row **P8-3**, hanging off P3-C2's republish /
`handlePanelClosed` lane.

### What the map must also restore

- **FX-slot state** — plugin identifier + opaque state blob + mode/output per
  return, the shape already drafted in the send-slot table above. Unchanged, and
  already queued as **P6-5**; P8-6's round-trip gate needs it.
- **Tape audio** — `tapeLoadTake` is a documented no-op (`mapStore.ts:220`), so a
  reopened map's tape comes back as a reference with no sound behind it. Row
  **P8-5** builds the ABI path. Until then "the map remembers" has a hole in it.
- **Sync information** — already complete, recorded here so nobody re-queues it:
  per element `bpm` (nullable on tapes, the D-2 honesty guard), `syncToMaster`,
  `tempoMode`, `pulseRelation`, `transpose`, `rate`, `loop`, `takeRef`, plus
  `transport.masterBpm`.

### Deliberately still NOT persisted

- **Devices and hardware routings** — the user's own carve-out ("flexible on
  devices and hardware routings of course"). A map that pinned an interface would
  be a map that only opens in one room.
- **MIDI mappings** — blocked, not deferred by taste: the merged shell publishes
  no `midiLearn` topic (`attachMidiLearn` subscribes to nothing; `midiHardware:
  false`), so there is nothing to save. Row **P8-P1**, `blocked`, opens when the
  shell grows the topic. A persisted field with nothing behind it is the document
  equivalent of dead ABI.

## AMENDMENT 2026-07-30 — the overlay made concrete (P8-1)

*The 2026-07-29 amendment above signed the overlay in principle and deferred four
things to this row: **the field shape, the write-routing law, the re-apply
triggers, and the migration**. They are §1–§4 here. Everything below was measured
against HEAD rather than read from the ledger, and the measurement moved three of
the four answers.*

### What the measurement found, before any of it is designed

**Three of the overlay's four existing fields are backed by nothing.**
`GridPerfSchema` (`web/src/persist/mapDocument.ts:136-152`) holds `currentScene ·
switchMode · queuedScenes · queueLoop`. Against HEAD:

| field | live counterpart | verdict |
|---|---|---|
| `currentScene` | `DeckState.scene`, written by `selectScene` (`companionEngine.ts:191,809`) | **real** |
| `switchMode` | only `SceneUiState.switchMode`, pushed on the `scenes/<deck>` topic **no merged host publishes**, and settable only via `sendSceneSwitchMode` → `link.command('patternScene', …)` (`scenesStore.ts:99-104`) — a verb in neither `BrowserLink`'s switch nor `MergedLink.NATIVE_METHODS` (P7-K0). The companion store has no `switchMode` at all; its analogue is the per-gesture `immediate` boolean | **fiction** |
| `queuedScenes: string[]` | the store holds `scheduledScene: SceneLetter \| null` — ONE armed scene, not a list (`companionEngine.ts:193`) | **fiction** |
| `queueLoop` | **zero occurrences** anywhere outside `mapDocument.ts`, `mapApply.ts` and their tests | **fiction** |

So P8-1 is not "generalize four fields". It is **replace three unbacked fields
with the ones a running deck actually holds.** And the reason the fiction survived
is structural, not careless: `planApply` emits `sceneSelect`/`sceneSetSwitch`
(`mapApply.ts:47-54,170-181`) and `mapStore.ts:265-272` drops both on the floor,
so the read path could look complete while the values it read were never issued
and two of them named state the app does not have.

**The derivation rule this amendment uses**, so the next field is decided the same
way rather than argued from taste:

> A field belongs in the overlay iff **(a)** it is state a LIVE DECK holds that its
> `.scoopySession` file does not, or a session-document parameter a PLANE gesture
> writes; **and (b)** something in the tree can both READ it at capture time and
> WRITE it at re-apply time *today*. A field failing (b) is named, parked, and
> given the row that unblocks it — never carried as a schema field with nothing
> behind it. That is `mapDocument.ts:14-17`'s own law ("a persisted field with
> nothing behind it is the document equivalent of dead ABI") applied to itself.

`DeckState` (`companionEngine.ts:187-214`) is the complete inventory of what a
deck holds beyond its file, so test (a) runs down it exactly once:

| `DeckState` field | overlay? | why |
|---|---|---|
| `session` | no | it IS the reference — `element.grid.sessionId` |
| `playing` | no | `map.transport` deliberately carries only `masterBpm`/`masterLevel` (`mapDocument.ts:316-318`). A map that reopened PLAYING makes noise before anyone is ready |
| `scene` | **yes** | the one field that already worked at the document tier |
| `scheduledScene` + `switchBoundaryStep` | no | an armed switch is a gesture in flight, pinned to a master step that will not exist next boot. Restoring it fires a scene change seconds after the map opens, from nothing the user touched |
| `stoppedTracks` | **yes** | see the ruling below — this is the biggest real gap |
| `soloedTracks` | no | see the ruling below |
| `missingSamples`, `decodeFailures` | no | diagnostics about THIS machine's resolution, re-derived on every open. Persisting them would carry another rig's failures into yours |
| `beatRepeat`, `reverse` | no | "a hand gesture" (`companionEngine.ts:208-213`). A latched repeat restored at load is an effect nobody asked for and no visible control explains |

**RULING — `stoppedTracks` joins the overlay; `soloedTracks` does not.** These look
symmetrical and are not. The launch gate is already a THREE-layer stack: the
session's per-track `isStopped`, read once by `seedStopped` at open
(`companionEngine.ts:424-428`), then a runtime set that `toggleLaunch` flips and
that **never persists anywhere** (`:883-893`, "No autosave — the document's
isStopped fields stay untouched"). On the plane, which tracks are running IS the
performance — "this set runs without the hats" — so the overlay is the *first*
home this control has ever had, not a second one. That does **not** contradict the
2026-07-25 ruling that per-track mute/solo belongs to the session: that ruling was
about the session's PINNABLE mute (CM-3), and the launch gate is not it — nothing
pins it and nothing writes it. `soloedTracks` is refused because solo is a
momentary *monitoring* gesture on both hosts (`:894-905`, "solo is never persisted,
on either host"): reopening a set with seven strips inaudible, and nothing at map
level saying why, is worse than losing it. It also has no document counterpart at
all, so unlike the launch gate there is no seed to fall back to.

### §1 — the field shape

`strip.sessionPerf: Record<sessionId, GridPerf>` becomes:

```
strip.overlay: Record<sessionId, SessionOverlay>          // v9, see §4

SessionOverlay = {
  // WHAT IS RUNNING — runtime state with no session counterpart, so a plain value.
  scene:            string                 // "A".."H"        (was `currentScene`)

  // WHAT THIS MAP OVERRODE — null means "this map has no opinion; the session's
  // own value plays". A number standing in for "untouched" would be a lie the
  // document could not later distinguish from a deliberate setting.
  stoppedTracks:    number[] | null        // null = seed from the file's isStopped
  masterVolume:     number | null          // pattern.masterVolume
  masterDrive:      number | null          // pattern.masterClipperDrive  [1,32]
  masterDriveCurve: number | null          // pattern.masterClipperCurve  0..3
}
```

Five fields. Three rulings are load-bearing:

- **`null` is a third state, not a missing value**, and it is the same distinction
  P6-5b drew for FX slots (`mapDocument.ts:276-286`): an explicit "nothing" is what
  lets a restore tell "this map chose the session's value" from "this map predates
  the field". It is also what makes the migration in §4 sound-preserving for free.
- **There is NO `bpm` field, deliberately.** The map already carries a per-strip
  tempo at `element.grid.bpm`, and `updateGridTempo` (`mapStore.ts:435-459`) already
  routes the plane's bpm box through `setTempoOverride` (`companionEngine.ts:1010`)
  — an in-memory per-deck override that wins on every publish
  (`resolveWorldBpm`, `:351`) and **never reaches the Autosaver**. Adding
  `overlay.bpm` would give one deck two map-side tempi that could disagree. This
  path is not a workaround to be replaced; **it is the working precedent the other
  three parameters must copy**, and it already carries the exact rationale in its
  own comment (`companionEngine.ts:335-347`).
- **`switchMode` / `queuedScenes` / `queueLoop` are PARKED, with their reason and
  their unblocking row** (§5). They return when the app grows a scene-switch-mode
  control that something answers.

⚠️ **The apply mechanism is an OVERRIDE LANE, not a document write.** `publish()`
re-seeds `masterVolume` and the clipper block from `d.session.pattern` on every
call (`companionEngine.ts:365-420`), so an overlay value that was applied by
writing the session would (a) be stomped by the next republish anyway and (b) be
the bleed hazard through the back door. `tempoOverrideBpm` + `resolveWorldBpm` is
the shape; VOL/DRV/DRV-curve need siblings, and `stoppedTracks` needs the seed at
`open()` to consult the overlay before the file. That is P8-2's real work.

### §2 — the write-routing law (this is what resolves the BLEED hazard)

The 2026-07-29 law reads *"plane-surface edits to session parameters land in the
OVERLAY; compose edits land in the SESSION."* Read literally it is wrong in both
directions, because the deck tile mounts the real `GridPanel` on the plane
(`deckTile.tsx:1-30`) and cell editing is a plane-surface edit. Sharpened:

> **Parameters overlay; contents do not.** A gesture routes to the OVERLAY iff it
> changes a value the session already HAS. A gesture that changes what the session
> IS — its cells, tracks, kit, or how many scenes exist — is a composition edit that
> happens to have been made on a plane surface, and it lands in the SESSION,
> autosave included. The surface is not the discriminator; the *object of the edit*
> is.

**The five plane doors that write a session parameter at HEAD**, each with its
target. The ledger's P8-4 names three of them; the audit found five:

| # | door | path today | target |
|---|---|---|---|
| 1 | MasterRow **BPM** | `MasterRow.tsx:92` → `paramWrite("sessionBpm")` → `browserLink.ts:59-64` → `App.tsx:59-72` → `useCompanion.setBpm` → session + `autosaver.schedule` (`companionEngine.ts:749-763`) | **`updateGridTempo(strip.key, link, {bpm})`** — the EXISTING plane path. Not a new overlay field |
| 2 | MasterRow **VOL** | same chain → `setMasterVolume` (`:765-779`) | `overlay.masterVolume` |
| 3 | MasterRow **DRV** | same chain → `setMasterDrive` (`:781-792`) | `overlay.masterDrive` |
| 4 | **Inspector DRV curve + amount**, for a grid strip | `Inspector.tsx:417,421` → `setMasterDriveCurve` / `setMasterDrive` (`:794-807`) | `overlay.masterDriveCurve` / `overlay.masterDrive` |
| 5 | plane **add-scene** pad | `Plane.tsx:611-616` → `setEnabledSceneCount` → session + autosave (`:851-881`) | **stays a SESSION write** — see below |

⚠️ **Door 4 is not in any ledger row.** `Inspector.tsx:409-412` says outright "one
value, two doors" — and *both* doors bleed. A P8-4 that reroutes only MasterRow
leaves the Inspector writing the library session for the same two values, which
would read as an intermittent bug ("sometimes my DRV follows me between maps").

⚠️ **Door 5 deliberately keeps writing the session, and that is the decision this
hazard demanded — not an exception to it.** A map cannot own a scene that does not
exist: a scene added into the overlay would be invisible to the compose window,
unopenable anywhere else, and would vanish the moment the strip swapped sessions.
Adding a pad changes what the session IS. The hazard section asked for map controls
that write session parameters to be *explicit about where the value lands*; this is
explicit, and the answer is "the session, on purpose".

**Everything else the plane touches is already correct and stays put**, recorded so
nobody re-routes it: `selectScene` (`Plane.tsx:625-628`; runtime, no autosave —
`companionEngine.ts:846`), `toggleLaunch` / `toggleSoloTrack`
(`deckTile.tsx:88,92`), `setReverse` / `setBeatRepeat` (`Strip.tsx:784,797,818`),
and `applyGridRow` cell edits through the tile's `setGridEditHandler`
(`deckTile.tsx:85`) — the last of these is a CONTENTS edit and must keep reaching
the session document.

**CAPTURE — the overlay is written at the gesture, not at save.** Every routed
gesture calls one function, `rememberOverlay(stripKey, sessionId, patch)` — the
generalization of `rememberPerf` (`mapDocument.ts:545`, which has **no production
caller at HEAD**; every one of its callers is a test). It goes through
`updateStrip` (`mapStore.ts:97-105`) so `dirty` cannot be forgotten at a call site
and the 4 s autosave (`mapFiles.ts:attachAutosave`) carries it. This is what P8-2's
rewritten gate means by "the round trip must START from a UI gesture".

⚠️ **Deck → strip resolution belongs to the MAP layer, never to the companion
store.** Every routed setter knows a *deck*; the overlay is keyed by *(strip,
session)*. The map resolves it — `map.strips.find(s => s.element.kind === 'grid' &&
s.element.deck === deck)` — and the resolution is unique because `freeDeck`
(`stripOps.ts:60-66`) gives at most one strip per deck. Teaching `companionEngine`
about strips would put the plane's document model inside the session tier and break
the layering that `worldFromSession` is explicitly built to protect.

### §3 — the re-apply triggers (this is what resolves the STOMP hazard)

Every trigger is the same event wearing four hats: **a session just landed in a
deck.** So there is ONE entry point, `applyOverlay(deck, overlay)`, and four
callers that `await useCompanion.open(...)` first:

| | trigger | hook | note |
|---|---|---|---|
| T1 | **map load** | `mapFiles.ts:83-88`, between `setMap` and `applyMap`, after P8-0's blocking `useCompanion.open(sessionId, deck)` per grid strip | the ordering D-SL-MAPOPEN-01 signed |
| T2 | **compose return** | `PlanePanel.tsx:146-149`, the `reopen` callback `handlePanelClosed` drives (`composeOwnership.ts:16-32`) | ⚠️ chain off the promise `open()` returns, **not** the `setTimeout(…, 500)` — a timer that fires while the read is still in flight re-applies onto the old world |
| T3 | **strip swaps session** | `PlanePanel.tsx:786`, `await useCompanion.open(sessionId, deck)` | the trigger nobody had listed, and it is the *entire* justification for keying by (strip, sessionId): swap away and back, and the tweaks must return |
| T4 | **engine (re)start** | `PlanePanel.tsx:388-395`'s `autoStartEngine`, and any path that republishes a deck from its file | a world published before the engine was up is re-published when it comes up, from the session — so the overlay must ride that too |

**T5 — REFUSED, and the refusal is part of the design.** The compose window
(`ComposeWindow.tsx:55-56`) opens the same session into the same deck and must show
it **exactly as the file has it**. Overlaying there means composing against values
you cannot see and cannot edit — you would turn a knob to a number the file does
not contain, save, and have written something else. The compose window is the
session's surface; the plane is the map's. This is the same boundary the
write-routing law draws, on the read side.

⚠️ **One mechanism, two hazards — and this corrects the stomp paragraph's own
proposed fix.** That paragraph says the re-apply is "the same code on a different
trigger" because "it already does exactly this at load (`planApply`)". It is not.
`planApply` returns `EngineOp`s — "one engine call, named for the ABI entry point
it becomes" (`mapApply.ts:23`) — and the overlay has no ABI entry point and never
will (`mapStore.ts:265-272` says so in the tree). Re-applying the overlay through
document writes would fix the stomp by *causing the bleed*. So:

> **RULING: `sceneSelect` and `sceneSetSwitch` leave `EngineOp` entirely.** The
> overlay's apply path is companion verbs and override lanes, in its own function,
> called after `open()` resolves — not a case in `issue()`. Two tiers in one
> ordered op list is what forced one ordering on two different clocks, and it is
> why a "complete and tested" read path issued nothing for the whole of P8's life.

*(This sharpens the ledger's P8-2 part (b), which puts the call at
`mapStore.ts:265`. Same verb, different home — see the proposed row correction.)*

### §4 — the migration: MAP v8 → v9, `sessionPerf` → `overlay`

Named `the performance layer becomes the overlay (P8-1)`, and written the way
every migration in `mapDocument.ts:367-534` is written — **choose whatever makes a
v8 map sound unchanged**:

- `currentScene` → `scene`, carried **verbatim**. It is the one field that was real.
- `stoppedTracks`, `masterVolume`, `masterDrive`, `masterDriveCurve` → **`null`**,
  not a constant. `null` resolves to "the session's own value plays", which is
  precisely what a v8 map sounded like: it had no overlay for them. A fixed default
  would silently overlay every reopened map with a value nobody chose.
- `switchMode`, `queuedScenes`, `queueLoop` → **DROPPED.**

⚠️ **That drop is the first in this document's history and it needs its carve-out
written down, because the house law is `preserve-don't-drop`** (see Compatibility
rules below). The carve-out: *preserve-don't-drop protects information a reader
might act on.* These three are values **no reader ever could** — nothing consumes
them (`mapStore.ts:265-272` returns early), nothing could have produced a non-default
one (`rememberPerf` has no production caller), and two of them name state the app
does not have. Carrying them forward would freeze fiction into v9 where a later
reader would believe them. A field that was never writable and never readable is
not information; it is a comment with a schema entry.

**v9 is a MAP-document bump and touches nothing on the wire.** `MAP_SCHEMA_VERSION`
(`mapDocument.ts:22`) is not `web/protocol/schema.ts::SCHEMA_VERSION`. `schema:check`
compares the protocol version across exactly three C++ sites — `SlDispatch.cpp`'s
`getCapabilities().schemaVersion`, `MergedApp.h`'s `kScoopySchemaVersion`, and the
assertions in `shell/tools/sl_dispatch_test.cpp` (`web/scripts/checkSchemaVersion.ts`)
— and **no gate compares `MAP_SCHEMA_VERSION` to anything.** Nothing in this
amendment needs a protocol bump either: every verb it uses (`selectScene`,
`toggleLaunch`, the override lanes) is in-process TS. P8-2 moves ONE number and adds
ONE migration. If a future overlay field ever does need the wire, it moves all three
sites or `schema:check` goes red — which is the gate working.

### §5 — parked, with the row that unblocks each

- **`switchMode`** — needs a control the app answers. Today the only setter rides
  the dead `patternScene` verb (`scenesStore.ts:99-104`) and the only state lives on
  a topic no merged host publishes. Unblocked by the K-series' reconciliation of
  `scenesStore` (P7-K0's finding); until then a map cannot capture it or issue it.
- **`queuedScenes` / `queueLoop`** — need a scene QUEUE. The store has one armed
  scene (`scheduledScene`), not a list, and no loop concept anywhere.
- **`soloedTracks`** — refused by ruling above, not by capability. Recorded so it is
  not re-proposed as an oversight.
- **Per-track volume/pan/tone, FX, macros** — unchanged from 2026-07-25: the PIN
  mechanism (CM-3) owns them. Two ways to set one value with different persistence
  remains the trap.

### §6 — what P7-T4 must do (it was told to name its persistence target here)

**P7-T4's master sends persist in `strip.sends[4]` — the map document field that
already exists — and NOT in the overlay.** A send LEVEL is the CHANNEL's, by
decision 5 (2026-07-25, above): "the channel owns the send's level, the routing
document owns its destination". The overlay holds *session*-scope values only, and
a strip's send is strip scope. The field is already schema'd (`mapDocument.ts:176-178`)
and already applied — `planApply` emits `channelSetSend` for all four
(`mapApply.ts:203-205`) — so T4 adds **no** persistence code and P8-4 will not
rewrite it.

⚠️ Two traps for whoever builds T4. The session document *does* carry a
`deckMasterSendRow` (`patternFile.ts:689-691`), a legacy Swift field with **zero
consumers in `web/src`** — persisting there would write a value nothing reads.
And `MasterRow.tsx:156` writes `deckMasterSend` via `paramWrite`, which is a LIVE
control param, not one of the three `SESSION_PARAMS` (`browserLink.ts:59-64`) — so
it neither bleeds nor persists today. T4's remaining question is therefore the
one-owner ruling its own note demands (which control writes the lane), not where the
value lands. That is now decided.

## Compatibility rules

- `.scoopySession` (PatternFile v32+) remains byte-compatible with shipping scoopy until
  P8 cutover — embedded sessions round-trip out of a map unchanged (gate: round-trip
  corpus both directions).
- Unknown keys are a loud failure, newer schemaVersion is refused, migrations are named
  per-version steps, each testable (wizard `session.ts` discipline, verbatim).
  ⚠️ `preserve-don't-drop` has exactly ONE written carve-out — the v8→v9 drop of
  `switchMode`/`queuedScenes`/`queueLoop`, argued in the 2026-07-30 amendment §4.
  A field that was never writable and never readable is not information. Any future
  drop needs the same argument made in the same place, or it is a data loss.
- Nothing in this schema may require X·MIX (removed, D3) or the parked capture backends;
  their fields are expressible but their implementations refuse at world-commit.
