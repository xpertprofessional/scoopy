# SL ABI v3 — one C surface for the merged engine

*P0-C of the wizard×scoopy merge (plan: decisions D1–D8). This is the design doc for the
convergence bump that `shared/engine/ABI.md` already schedules under "Known deviations":
the next `sl_` ABI break clears every deviation and absorbs wizard's deck/world surface.
Reviewed against ABI.md's 8 rules; every function below follows keyed-params,
carried-or-waived, and declare-only-what-is-implemented.*

Sources reconciled:
- `apps/scoopy/engine/include/sl_engine.h` — ABI v2 (keyed track params, incremental
  snapshot builder, stereo-only render, split create/configure)
- `apps/wizard/engine/include/wz_engine.h` — ABI v1 (keyed channel params, RCU world
  builder, decks/record/scrub/overdub, source rings, global record, planar duplex render)

The rule of the merge: **wz_ machinery arrives with sl_ names; sl_ semantics win wherever
both define the same thing.** `wz_engine.cpp` is a donor, not a survivor.

---

## 1. Identity & lifecycle (deviations cleared)

```c
int32_t  sl_abi_version(void);            /* was sl_engine_abi_version — ABI.md naming rule */
#define SL_ABI_VERSION 3
#define SL_PARAM_UNKNOWN (-1)

sl_engine* sl_engine_create(double sample_rate,
                            uint32_t max_block_frames,
                            int32_t schema_version);   /* wz shape; kills create/configure split */
void sl_engine_destroy(sl_engine* e);
int  sl_engine_start(sl_engine* e);
void sl_engine_stop(sl_engine* e);

void   sl_engine_set_sample_rate(sl_engine* e, double sample_rate); /* D-WZ-RATE-01 carried over */
double sl_engine_sample_rate(const sl_engine* e);
uint32_t sl_engine_max_block_frames(const sl_engine* e);
```

- `schema_version` echoes in HotFrame slot 0 (wz rule — stale shell/UI pairing is loudly
  detectable at runtime).
- The engine graph runs at the output device rate; a rate change tears down + rebuilds at
  the host layer (D-WZ-RATE-01), never re-clocks silently.

## 2. Render — planar, duplex (deviation cleared)

```c
void sl_render_io(sl_engine* e,
                  const float* const* in_bus, uint32_t in_count,
                  float* const*      bus_out, uint32_t bus_count,
                  uint32_t frames);
void sl_render(sl_engine* e, float* const* bus_out, uint32_t bus_count, uint32_t frames);
```

- Replaces v2's hardcoded `sl_render(L, R, frames)`. Desktop passes the full lane set
  (main / cue / 8 deck pairs / returnWet1–4 / micDry mapped by the host's output map);
  the WASM companion passes `bus_count = 2` and gets main L/R — the v2 stereo behavior
  is now just the narrowest call, not a separate shape.
- Duplex (`in_bus`) is what beat-synced deck recording reads — inputs arrive in the same
  callback on the same clock, zero SRC (D-WZ-RATE-01). Independently clocked sources go
  through source rings (§6).
- Advances ONE monotonic engine sample clock by exactly `frames` — this clock is the
  root of both Law C-2 sample stamps and the musical transport (§7). RT-safe: no locks,
  no allocation, no exceptions crossing the boundary.

## 3. Keyed parameters — two scopes, one discipline

Per ABI.md, scope axes are additive and product-specific. The merged engine has two
param families, both name-resolved at boot, both covered by `checkAbiCoverage`:

```c
/* deck/strip scope (from wz_param_set; deck = strip index 0–7, master-globals ignore it) */
int32_t     sl_param_id_for_name(const char* name);
uint32_t    sl_param_count(void);
const char* sl_param_name(uint32_t id);
void   sl_param_set(sl_engine* e, uint32_t deck, int32_t id, double value);
double sl_param_get(const sl_engine* e, uint32_t deck, int32_t id);

/* track scope inside a deck's session snapshot (v2 surface, unchanged semantics) */
int sl_track_param_id(const char* name);   /* was sl_param_id — renamed to free the deck scope */
int sl_track_array_id(const char* name);   /* was sl_array_param_id */
```

Deck-scope params (initial set, all in `kParamNames[]`): `gain`, `pan`, `mute`, `solo`,
`toCue`, `outBus`, `send1..send4`, `rate` (signed varispeed), `tempoMode`
(0 timePitch · 1 timeStretch · 2 tempoOnly — per-deck now, D3/plan §sync), `slotHq`
(0/1 — HQ Signalsmith bank privilege follows slot assignment), `recordArm`. Master
globals: `mainGain`, `masterBpm` intent goes through the transport (§7), not a param.

## 4. World builder — strip topology (from wz, sl-named)

```c
void     sl_world_begin(sl_engine* e);
int32_t  sl_world_key_for_name(const char* name);
uint32_t sl_world_channel_begin(sl_engine* e, const char* channel_key);
void     sl_world_channel_set(sl_engine* e, int32_t key, double value);
void     sl_world_channel_end(sl_engine* e);
uint64_t sl_world_commit(sl_engine* e);        /* RCU: one atomic pointer swap */
uint32_t sl_world_channel_count(const sl_engine* e);
uint64_t sl_world_revision(const sl_engine* e);
void     sl_world_set_deck_count(sl_engine* e, uint32_t count);  /* 1–8 (D3) */
uint32_t sl_world_deck_count(const sl_engine* e);
```

Channel keys as in wz (`srcKind`, `srcChan0/1`, `toMonitor`, `gain`, `pan`, `mute`,
`solo`, `deckIndex`) plus `materialKind` (0 none · 1 buffer · 2 session). `srcKind`
keeps wizard's full enum (none/deviceInput/deck/appTap/systemMixExcept/
virtualDeviceInput/busTap) — parked kinds stay expressible (D4), unimplemented ones
refuse at commit, they are not dead ABI.

TS owns the document; builder values ARE the document's values (wz law, unchanged).

## 5. Tapes — wizard's deck surface, sl-named

> **AMENDED 2026-07-25 — SIGNED OFF by the user.** This section originally named
> the transplanted surface `sl_deck_*`. It ships as **`sl_tape_*`**, because §6 had
> already spent `sl_deck_*` on scoopy's GRID decks — sequenced sampler sessions,
> a different index space with a different engine behind it. Two objects called
> "deck" in one ABI is a permanent ambiguity; "tape" is also the word
> `STRIP-MODEL.md` uses for this object. **Tape and grid-deck indices are
> independent**: `sl_tape_count()` (8) tapes coexist with `sl_deck_count()` (3)
> grid decks. Built: `slengine/src/sl_tape.{h,cpp}`, gated by `npm run tape:check`.

Everything from `wz_deck_*` transplants with identical semantics and comments-of-record
(chunked planar storage, seqlock loop spec, scrub mailbox, overdub SUM/REPLACE,
control-thread insert splice, record service pre-allocation, 256 MB cap, parallel drain,
Law C-2 stamps, Law C-3 same-block record→loop handoff):

`sl_tape_load · frames · trigger · seek · scrub_begin/to/end · overdub_start/stop ·
insert · playhead · set_loop · waveform · set_rate · rate · set_record_source ·
record_start · record_stop · record_service · set_record_cap_frames · drain`

All 21 carried, none waived (the ledger is `slengine/tape-not-carried.json`, and the
gate is symmetric — an invented entry point fails it too). Four v3 additions are
declared there with reasons: `sl_tape_count`, `sl_tape_channels`, `sl_tape_state`,
`sl_tape_record_cap_reached`.

### The one place the transplant is NOT 1:1 — the record SOURCE

Wizard's deck could only record **device input channels** (`recSrcChan0/1` indexed the
render's raw `in_bus`). `STRIP-MODEL.md`'s closing argument requires the opposite:
recording is always "capture this bus", identical whether the sound came from a
sequencer, a live input or a file. So the source became a KIND:

```c
/* kind 0 = deviceInput (chan0 = L/mono, chan1 = R or -1) — wizard's behaviour.
 * kind 1 = mainMix — the engine's main L/R after everything ("what left the app").
 * An unknown kind is REFUSED, never silently treated as input 0.
 * `channelBus` joins this list when the strip channel exists (P2 step 2). */
int32_t sl_tape_set_record_source(sl_engine* e, uint32_t tape, uint32_t kind,
                                  int32_t chan0, int32_t chan1);
```

This is why the render is **five phases, not one pass**: a source has to be captured at
the point where it actually exists. Arm + the Law C-3 handoff run at the top of the
block (so a stop-with-loop plays in that same block); device-input capture runs before
anything renders; the mix capture runs *after* the lanes are summed. That last split is
what makes a mix take stamp honestly — this block's mix under this block's stamp, rather
than the previous block's audio beside a current stamp, which is the ~10 ms error
`docs/specs/pd-global-record-as-strip.md` §1 flagged in the loopback approach.

Consequence to know: overdub reads its input during the *playback* pass, which runs
before the mix exists, so a mix-sourced overdub is **refused** rather than silently
layering a stale block.

New in v3 (the merge's own additions):

```c
/* Beat-quantized record start/stop: capture begins/ends at the next boundary of
 * `division` (1 = bar, 4 = beat, …) on the master transport (§7). With the transport
 * stopped it degrades to the immediate wz behavior. Loops recorded this way are
 * bar-exact by construction (plan §sync).
 * NOT BUILT — deferred with §7 (P2 decision, 2026-07-25). P2 ships immediate
 * capture, which is wizard's proven behaviour; this arrives with the transport. */
void sl_tape_record_start_quantized(sl_engine* e, uint32_t tape, uint32_t division);

/* Deck material = a SESSION (scoopy sequencer world) instead of a buffer. The deck's
 * snapshot is built with the v2 builder targeted at the deck (§6); trigger/playhead/
 * loop semantics then follow the session's pattern clock, phase-locked to the master
 * transport. A deck with buffer material behaves exactly as in wizard. */
```

A HotFrame `freeTime` flag per take-in-progress marks recording that crossed a tempo
ramp (D5): the take is kept, but carries no bar-exact guarantee and the UI warns.

## 6. Session snapshots per deck (v2 surface, deck-targeted)

v2's incremental builder survives unchanged except `sl_snapshot_begin` gains the deck
axis — compose mode targets the deck being edited; up to 8 session worlds coexist:

```c
void sl_snapshot_begin(sl_engine* e, uint32_t deck, double bpm, int is_playing, int32_t start_step);
/* track_begin / track_set / track_set_array / track_end / commit — unchanged from v2 */
```

`sl_engine_register_sample` is unchanged (copies; sample dedupe across decks is an
engine-internal concern, plan §8-deck resource budget).

Source rings (`sl_source_ring_open/write/close/fill/overruns/underruns`) and global
record (`sl_global_record_start/stop/start_sample/active/overruns/drain`) transplant
from wz verbatim under sl names.

## 7. Master transport (new — the engine-side clock)

Replaces Swift's `MasterTransportManager` + `DJModeManager` tempo authority. Beats and
sample stamps derive from the same monotonic clock (§2), which is what lets wizard's
Law C-2/C-3 and scoopy's step grid compose.

```c
void   sl_transport_play(sl_engine* e);
void   sl_transport_stop(sl_engine* e);
void   sl_transport_set_bpm(sl_engine* e, double bpm, double ramp_seconds); /* 0 = jump */
double sl_transport_bpm(const sl_engine* e);        /* the LIVE (ramping) value */
void   sl_transport_relock(sl_engine* e);           /* realign playing decks at next shared
                                                       boundary (Return-key semantics) */
```

Step/bar position, per-deck phase, LCM cycle state, and ramp-in-progress publish via
HotFrame — state streams, never a reply (wz law). Tempo-law MATH (busStretchRatio,
deckVarispeedRatio, …) stays TS-owned (`djMix.ts`, golden-pinned); TS computes ratios
and writes deck params. The engine transport owns time, not the laws.

## 8. HotFrame — superset layout

`sl_hotframe_length` / `sl_hotframe` (wz shape: refuse-short-buffer, never truncate).
Frame = scalars (incl. schemaVersion echo, transport block) + one block per strip +
one block per deck + per-deck-track blocks for the session decks. **Every stride and
index is emitted by the protocol codegen** (`SLProtocol.h` / generated TS) — hand-computed
indices are the defect class the coverage gate exists for.

## 9. What stays outside this header

- `sl_host.h` (device/MIDI host management) remains per `docs/migration/XP-6B-HOST-ABI.md`,
  but in the merged app the host tier is C++ — most of it becomes internal host API; the
  C surface is kept only where the WASM/capability boundary needs it.
- Plugin hosting, EXT send routing, output-map application: host tier (JUCE), not engine
  ABI. The engine exposes lanes; the host maps them.
- The plugin-insert render callback (wizard's P6 seam) stays UNDECLARED until inserts are
  implemented (blocked on D-WZ-PDC-01) — no dead ABI.

## 10. Compatibility & migration

- v3 is a clean break; the JS worklet asserts on `sl_abi_version()` and ships in the same
  commit as the engine bump (webdist freshness gate makes a skew unbuildable).
- The WASM companion (composing only, D8) uses the narrow slice: create → register_sample
  → snapshot on deck 0 → `sl_render(bus_out, 2, frames)`. Nothing else is exported to JS.
- Shipping scoopy stays on v2 until the P3 ownership flip; v3 lands in the merged repo
  first. The v2→v3 rename map (`sl_engine_abi_version`→`sl_abi_version`,
  `sl_param_id`→`sl_track_param_id`, `sl_render` widening, create/configure fusion) is
  mechanical and grep-gated: zero v2 spellings may survive in the merged tree.
- `abi-not-carried.json` is seeded in the same commit as each surface lands; the
  coverage gate (`checkAbiCoverage`) runs from P1 on.
