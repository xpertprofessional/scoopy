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

## Compatibility rules

- `.scoopySession` (PatternFile v32+) remains byte-compatible with shipping scoopy until
  P8 cutover — embedded sessions round-trip out of a map unchanged (gate: round-trip
  corpus both directions).
- Unknown keys are a loud failure, newer schemaVersion is refused, migrations are named
  per-version steps, each testable (wizard `session.ts` discipline, verbatim).
- Nothing in this schema may require X·MIX (removed, D3) or the parked capture backends;
  their fields are expressible but their implementations refuse at world-commit.
