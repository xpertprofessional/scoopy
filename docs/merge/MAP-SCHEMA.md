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

### ⚠️ The sharper hazard: unpinned edits bleed across maps — **SETTLED 2026-07-29 (D-SL-MAPPERF-01), see the amendment below**

With the latch OFF, an edit is **global to the session** — so a tweak made while
performing from one map propagates to every other map using that session. This is
the two-homes problem arriving by a different road: not two copies of a session,
but one session quietly reshaped by last night's set.

The channel is safe (it is the strip's). But any map control that writes SESSION
parameters must be explicit about where the value lands. "The map is playing" is
arguably a context where the latch should default ON, or where such edits should
be refused outright and sent to compose. **Settle this before the plane UI exposes
any session-parameter control.**

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

### ⚠️ The hazard to design in, not discover — **SETTLED 2026-07-29 (D-SL-MAPPERF-01), see the amendment below**

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

## Compatibility rules

- `.scoopySession` (PatternFile v32+) remains byte-compatible with shipping scoopy until
  P8 cutover — embedded sessions round-trip out of a map unchanged (gate: round-trip
  corpus both directions).
- Unknown keys are a loud failure, newer schemaVersion is refused, migrations are named
  per-version steps, each testable (wizard `session.ts` discipline, verbatim).
- Nothing in this schema may require X·MIX (removed, D3) or the parked capture backends;
  their fields are expressible but their implementations refuse at world-commit.
