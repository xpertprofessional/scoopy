/**
 * The `.scoopyMap` document — the merged app's top-level setup on the plane.
 *
 * Design of record: `docs/merge/MAP-SCHEMA.md` in the merged repo, including its
 * 2026-07-25 routing amendment. Envelope discipline is wizard's
 * (`web/src/persist/session.ts`): SCHEMA_VERSION, named per-version migrations,
 * strict Zod, preserve-don't-drop, and a NEWER document refused loudly rather
 * than partially loaded — partially loading and then re-saving would silently
 * destroy whatever the newer version knew about.
 *
 * SCOPE. This models what the engine can actually do today (SL-ABI-V3 §4/§5 and
 * the strip channel): strips with elements and channel state, the routing graph,
 * and the master tempo. Deliberately NOT here yet: FX plugin slots, the output
 * map, remembered devices, and embedded sessions-by-copy. They are in
 * MAP-SCHEMA's draft and they will land with the surfaces that implement them —
 * a persisted field with nothing behind it is the document equivalent of dead
 * ABI, and it invites a loader to promise state it cannot restore.
 */
import { z } from 'zod'

/** Bump when the shape changes; add a named migration in MIGRATIONS below. */
export const MAP_SCHEMA_VERSION = 10

/* ── the lane budget (decision 6, 2026-07-25) ──────────────────────────────
 *
 * The mixer's content budget is 8 MONO LANES. A grid deck is inherently stereo
 * and costs 2; a tape may be mono (1) or stereo (2). So a map holds 4 stereo
 * decks, or 3 stereo grids + 2 mono tapes, or any other combination that fits.
 *
 * FX returns sit OUTSIDE this budget — they are fixed infrastructure, the
 * mixer's four stereo aux returns — because a budget that let adding an effect
 * silently cost you a deck would punish using the effects. Main and cue are the
 * output section, likewise outside.
 *
 * Enforced HERE, at the document, rather than in engine array sizes: the engine
 * keeps capacity for 8 tapes regardless, so this stays a rule we can tune by
 * editing one number instead of rebuilding. */
export const LANE_BUDGET = 8

export const ElementSchema = z.discriminatedUnion('kind', [
  /** A fresh strip. Not an error — a strip starts empty and grows elements on
      demand, which is the whole "channel + composable elements" model. */
  z.object({ kind: z.literal('none') }).strict(),
  /** A wizard tape: continuous audio, record/scrub/loop. A FILE PLAYER IS THIS
      — same element, different fill — which is why there is no separate kind. */
  z
    .object({
      kind: z.literal('tape'),
      /** Engine tape index. */
      index: z.number().int().min(0).max(7),
      /** The take this tape's material came from, if any. One take underlies a
          scrubbable tape AND any grid track carved from it — both reference
          this same id, so carving never duplicates audio. */
      takeRef: z.string().nullable(),
      stereo: z.boolean(),
      loop: z
        .object({
          enabled: z.boolean(),
          start: z.number().int().min(0),
          end: z.number().int().min(0),
        })
        .strict(),
      /** Signed varispeed; negative is reverse. */
      rate: z.number(),
      /** THE TAPE'S OWN TEMPO (P3-2b-1) — the missing input of the sync law.
          `null` = unknown: a tape knows frames, not beats, so the value comes
          from the take's `bpmAtStart` stamp (with a loop-length inference,
          D-2) or the user's own hand in the Inspector. A null-bpm tape cannot
          sync and says so, rather than guessing. */
      bpm: z.number().positive().nullable(),
      /** Locked to the plane's master tempo? Same intent field the grid
          element carries — one sync vocabulary for every element. */
      syncToMaster: z.boolean(),
      /** HOW this tape follows the master. `timePitch` is varispeed — zero
          latency, pitch moves with rate, honest tape behaviour and the D-3
          default. `timeStretch` will engage the stretcher (P3-2b-5) and
          accepts its group delay. `tempoOnly` is deliberately ABSENT: it is a
          step-clock concept and a tape has no steps to re-clock. */
      tempoMode: z.enum(['timePitch', 'timeStretch']),
      /** Musical relation to the master — same vocabulary as the grid. */
      pulseRelation: z.enum(['auto', '1:3', '1:2', '2:3', '1:1', '3:2', '2:1', '3:1']),
      /** LAUNCH REFERENCE (D-SL-QUANTUM-01) — whose grid this strip waits on
          when it launches quantized. `'auto'` resolves by a stated order
          (sync-master → lowest-numbered playing strip → nothing, launch now);
          any other value names a strip's key.

          On BOTH element kinds on purpose: a looper launches too, and one
          spawned mid-set must land on the beat without being configured first.
          A reference naming a strip that is gone or stopped falls through to
          auto rather than freezing the launch — see `audio/launchQuantum.ts`. */
      launchRef: z.string(),
    })
    .strict(),
  /** A scoopy session — sequenced sampler tracks. Always stereo. */
  z
    .object({
      kind: z.literal('grid'),
      /** Engine GRID DECK index — a different index space from tapes, and
          smaller (the pinned core holds 3). */
      deck: z.number().int().min(0).max(2),
      sessionId: z.string(),
      /** This deck's own tempo. Per-deck BPM isolation is a mission
          requirement, so it lives on the strip, never on the transport. */
      bpm: z.number().positive(),
      /** Locked to the plane's master tempo? The engine takes a RATIO
          (master/deck); the document stores the intent. */
      syncToMaster: z.boolean(),
      /** HOW this deck follows the master, which is a per-ELEMENT choice
          because it is a musical one: a drum deck usually wants `timeStretch`
          (tempo moves, pitch does not) while a bassline being pitched up on
          purpose wants `timePitch`. The master sets the tempo; the strip says
          what following it costs. Resolved into the engine's `tempoMode` param
          (0/1/2) by `plane/tempo.ts`. */
      tempoMode: z.enum(['timePitch', 'timeStretch', 'tempoOnly']),
      /** The musical relation to the master, not just a number: '1:2' half-times
          a deck against the plane, '3:2' puts it in three against two. `auto`
          picks the nearest musical ratio in log-tempo distance, which is what
          makes syncing a 90 BPM session to a 128 master land somewhere musical
          instead of at 1.42×. Scoopy's `resolvePulseRelation` owns the choice. */
      pulseRelation: z.enum(['auto', '1:3', '1:2', '2:3', '1:1', '3:2', '2:1', '3:1']),
      /** Semitones on this deck's stretch bus, independent of tempo. The "pitch"
          half of tempo-and-pitch: it is what lets a synced deck sit in the key
          of the set rather than the key it was sampled in. */
      transpose: z.number().min(-24).max(24),
      /** TP MODE — when true, SYNC and TRANSPOSE are mutually exclusive on this
          strip: engaging one drops the other (`applyPitchModeExclusion` in
          `audio/deckTransport.ts`).

          Ported from the donor's `DJModeManager.pitchModeEnabled`, which is a
          GLOBAL preference there — but D-SL-MORPH-01 retired the fixed deck
          slots that global belonged to, so the closest honest successor is
          per-strip (ruled by the user 2026-07-31, replicating the exclusivity
          rather than inventing a permissive model).

          Defaults false, which is the DONOR'S OWN DEFAULT and the permissive
          one: both may be on at once, exactly as every map written before v9
          behaved. */
      pitchMode: z.boolean(),
      /** LAUNCH REFERENCE (D-SL-QUANTUM-01) — whose grid this strip waits on
          when it launches quantized. `'auto'` resolves by a stated order
          (sync-master → lowest-numbered playing strip → nothing, launch now);
          any other value names a strip's key.

          On BOTH element kinds on purpose: a looper launches too, and one
          spawned mid-set must land on the beat without being configured first.
          A reference naming a strip that is gone or stopped falls through to
          auto rather than freezing the launch — see `audio/launchQuantum.ts`. */
      launchRef: z.string(),
    })
    .strict(),
])
export type Element = z.infer<typeof ElementSchema>

/**
 * THE PERFORMANCE LAYER — what a MAP may recall about a session without
 * touching the composition.
 *
 * Deliberately tiny, and narrower than the first draft, because scoopy already
 * has a performance/composition split of its own: the PIN mechanism (CM-3). A
 * session parameter is global across scenes until you PIN it, which makes it
 * scene-local, and the SCN latch decides where an edit lands. Per-track mutes,
 * volumes, pans and FX state are therefore already covered INSIDE the session —
 * duplicating them here would give two ways to mute a track with different
 * persistence, and a performer would discover which one they used only when it
 * failed to come back.
 *
 * So this holds only what genuinely DIFFERS between two maps using the same
 * session: which scene is running, and how scenes launch.
 */
export const GridPerfSchema = z
  .object({
    /** Scene letter "A".."H" (SceneUiState.current). */
    currentScene: z.string().min(1),
    /** How a scene change fires. A per-set choice — tight scheduled switching
        for one map, restart-immediate for another — so it should come back
        exactly as it was left. */
    switchMode: z.enum(['scheduled', 'seamlessImmediate', 'restartImmediate']),
    queuedScenes: z.array(z.string()),
    queueLoop: z.boolean(),
  })
  .strict()
export type GridPerf = z.infer<typeof GridPerfSchema>

export function defaultGridPerf(): GridPerf {
  return { currentScene: 'A', switchMode: 'scheduled', queuedScenes: [], queueLoop: false }
}

export const StripSchema = z
  .object({
    /** Stable identity across edits — the plane keys React off this, so a
        strip that gains material must not remount. */
    key: z.string().min(1),
    name: z.string(),
    /** Plane geometry. NEVER crosses the ABI (wizard's law): the engine has no
        opinion about where a strip sits. */
    cell: z
      .object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
      })
      .strict(),
    /** Which engine channel carries this strip. */
    channel: z.number().int().min(0).max(7),
    element: ElementSchema,
    /** Channel state. `level` is linear gain, not a fader position. */
    level: z.number().min(0),
    mute: z.boolean(),
    /** The four send LEVELS. Where each send GOES is a route (decision 5): the
        channel owns the level, the routing document owns the destination. */
    sends: z.tuple([z.number().min(0), z.number().min(0), z.number().min(0), z.number().min(0)]),
    /** Per-strip DRV (P3-X2) — STRIP-MODEL's "master DSP reaches every strip".
        Curve 0 soft · 1 tanh · 2 hard · 3 fold (the core's MasterDriveCurve);
        amount [1, 32] with 1 = off, applied post-element PRE-level so character
        stays constant while fading.

        ⚠️ TAPE/INPUT STRIPS ONLY: a grid strip's DRV lives in its SESSION
        document (masterClipperDrive/Curve — the core's per-deck stage is
        document-fed), so for a grid strip this field stays at its default and
        the Inspector's DRV control writes the session instead. One surface,
        two backings — the same projection rule as level/sends, at the
        document tier. */
    drive: z
      .object({
        curve: z.number().int().min(0).max(3),
        amount: z.number().min(1).max(32),
      })
      .strict(),
    recordArm: z.boolean(),
    /** THE MONITOR SWITCH — does this strip's device input reach its channel?
        Distinct from `mute`, which is the channel's OUTPUT: mute silences the
        strip and everything routed from it (a playing tape included), while
        this gates only the input's path in, and never the record path.

        Saved because it is a performance decision about a set — which strips
        are live inputs you want to hear — and losing it on reopen would restore
        a map into either silence or feedback.

        ⚠️ It is the DOCUMENT'S INTENT, not necessarily what the engine is doing
        this second: the engine opens the switch at record-start and closes it at
        the Law C-3 handoff (D-WZ-MON-01/02). The strip DISPLAYS the engine's
        state (HotFrame `slChanMonitorMask`) and writes it back here when it
        changes, so what gets saved is what was true. */
    monitor: z.boolean(),
    /** WHAT REC CAPTURES, when the strip is told rather than left to the rule.
        null = the default: a strip with a live input records that INPUT, and a
        strip without one records its own channel bus.

        The override exists because the rule alone silently deletes a
        capability. Routing strip A → strip B and pressing REC on B used to
        capture A (the bus carries whatever is patched in); under the rule
        alone, a B that also has an input would capture only the input, and
        nothing anywhere would say why the chain went missing from the take. */
    recordTap: z.enum(['input', 'bus', 'mainMix']).nullable(),
    /** The performance layer, keyed BY SESSION rather than by strip.
        A strip is a slot, not a container: it can swap sessions and swap back,
        and the tweaks must return. Keying per pairing costs a few hundred bytes
        and stops a swap inheriting scene state that means nothing in the new
        session. Lives on the STRIP, not the element, so it survives the element
        being replaced entirely. */
    sessionPerf: z.record(z.string(), GridPerfSchema),
  })
  .strict()
export type Strip = z.infer<typeof StripSchema>

/* ── the routing graph ──────────────────────────────────────────────────── */

export const RouteSourceSchema = z
  .object({
    /** ⚠️ `deckOut`'s index is a GRID DECK, not a channel (P3.5-E3) — the two
        spaces are different sizes, and a reader that assumed "index means
        channel" would draw this cable from the wrong strip. It exists because a
        grid deck's channel is a PROJECTION whose bus is empty by construction
        (the core owns that deck's gain stage), so "record the deck" has to name
        the deck rather than its strip. */
    kind: z.enum(['channelOut', 'channelSend', 'deviceInput', 'fxReturn', 'deckOut']),
    index: z.number().int().min(0),
    /** Send 0–3 for `channelSend`; the right-hand input channel for
        `deviceInput`; absent otherwise. */
    sub: z.number().int().min(0).nullable(),
  })
  .strict()

export const RouteDestSchema = z
  .object({
    kind: z.enum(['channelIn', 'sendBus', 'main']),
    index: z.number().int().min(0),
  })
  .strict()

export const RouteSchema = z
  .object({
    src: RouteSourceSchema,
    dst: RouteDestSchema,
    gain: z.number().min(0),
    /** THE LOAD-BEARING FLAG.
        false — tap-by-order: rendered in dependency order at ZERO added
          latency, and refused at edit time if it would close a cycle.
        true  — tap-by-delay: reads the previous block, costs exactly one block
          (~10.7 ms at 512/48k), and is the only edge allowed to close a loop.
        See ROUTING-MATRIX.md for why this is not "every route is a block late":
        with strip→strip chaining that would accumulate latency and comb-filter
        parallel paths, silently. */
    feedback: z.boolean(),
  })
  .strict()
export type Route = z.infer<typeof RouteSchema>

/** One FX return's plugin, as a map stores it (P6-5b). Both fields null = an
    empty return, which is a FACT the document records rather than a key it
    omits — an absent key would read as "unknown" and a restore could not tell
    "nothing was loaded" from "this map predates the field". */
export const FxSlotDocSchema = z
  .object({
    identifier: z.string().nullable(),
    state: z.string().nullable(),
  })
  .strict()
export type FxSlotDoc = z.infer<typeof FxSlotDocSchema>

/** Four empty returns — a fresh map, and what every pre-v8 map is migrated to. */
export function emptyFxSlots(): PlaneMap['fx'] {
  return [
    { identifier: null, state: null },
    { identifier: null, state: null },
    { identifier: null, state: null },
    { identifier: null, state: null },
  ]
}

export const MapSchema = z
  .object({
    /** Viewport only; pure UI state. */
    plane: z.object({ scale: z.number().positive(), panX: z.number(), panY: z.number() }).strict(),
    strips: z.array(StripSchema).max(8),
    /** EVERY cable, including the boot defaults (channel → main, send n → FX
        n). They are ordinary routes, not hidden special cases, so they are
        saved like any other — and a loader MUST clear the engine's routes
        before installing these, or the saved patch layers on top of the boot
        wiring and the session gains phantom cables every time it is opened. */
    routes: z.array(RouteSchema).max(128),
    /** Plane-owned master tempo and front-of-house LEVEL. Per-deck BPM lives on
        the strip; masterBpm is what a synced deck's ratio is computed against.

        `masterLevel` is the PLANE's, deliberately not the session's: a session
        carries its own master volume, and letting that move this one would mean
        loading a session changes your front-of-house level — the last thing
        that should happen mid-set. */
    transport: z
      .object({
        masterBpm: z.number().positive(),
        masterLevel: z.number().min(0),
        /** The launch quantum, map-wide — the donor's `globalLaunchQuantize`,
            default `cycle`. The SCALE is global (one musical grid size for the
            set); WHICH grid it counts against is per strip. */
        launchQuantum: z.enum(['off', '1', '2', '4', '8', '16', 'cycle']),
        /** The strip wearing the sync-master badge, or null. Step 2 of the
            reference order: a whole-map answer that every `auto` strip follows
            without naming it. */
        syncMasterKey: z.string().nullable(),
      })
      .strict(),
    /** THE FX RETURNS' PLUGINS (P6-5b) — the user's own requirement, verbatim:
        "so we can also restore these settings (like a plugin loaded) within a
        map". Exactly four, one per return, index 0 = FX 1.

        `identifier` is JUCE's `createIdentifierString`, NOT the display name: a
        name is for people and collides across formats and vendors, so a map
        keyed on it would reload a DIFFERENT plugin on a machine that has both.
        `state` is the plugin's own opaque blob (base64) — null when the plugin
        saves nothing, which is normal and still restores fine from the
        identifier alone.

        ⚠️ NOT SAVED HERE: mode / hardware output / pre-post. Nothing in the
        merged host can set them yet (the `fxSlot` ops for those are refused by
        name until P7-MIX-0) and no apply path reads them, so a field for them
        would be fiction the document swore to. They arrive with their controls.

        ⚠️ CAPTURED FROM THE ENGINE AT SAVE, like the routing graph and for the
        same reason: the plugin's state lives in the plugin, and a save that
        recorded what we last asked for rather than what is true would persist a
        blob from before the user touched a knob. See `captureMap`. */
    fx: z
      .tuple([FxSlotDocSchema, FxSlotDocSchema, FxSlotDocSchema, FxSlotDocSchema]),
  })
  .strict()
export type PlaneMap = z.infer<typeof MapSchema>

/** The on-disk envelope. Deliberately thin: the map is the document. */
export const MapDocumentSchema = z
  .object({
    schemaVersion: z.number().int().positive(),
    /** ISO-8601 UTC, for the user's benefit only; never used for ordering. */
    savedAt: z.string(),
    app: z.string(),
    map: MapSchema,
  })
  .strict() // unknown key = loud failure (the law)
export type MapDocument = z.infer<typeof MapDocumentSchema>

export type MapLoadResult =
  | { ok: true; map: PlaneMap; migratedFrom?: number }
  | { ok: false; reason: 'tooNew' | 'corrupt' | 'laneBudget'; message: string }

/**
 * One named function per version step, run on the RAW parsed object. A
 * migration must never assume the current schema's shape, because it runs on
 * documents older than itself.
 */
type RawMap = Record<string, unknown>
const MIGRATIONS: Record<number, { to: number; name: string; run: (m: RawMap) => RawMap }> = {
  // v1 is the first shipped shape; nothing predates it on disk.
  1: {
    to: 2,
    name: 'transport gains masterLevel',
    run: (m) => {
      // Unity, because that is what a v1 map SOUNDED like: there was no master
      // fader, so the output was unattenuated. Defaulting to anything else
      // would change how an existing map plays the first time it is opened.
      const map = (m.map ?? {}) as RawMap
      const transport = (map.transport ?? {}) as RawMap
      return {
        ...m,
        map: { ...map, transport: { ...transport, masterLevel: 1 } },
      }
    },
  },
  2: {
    to: 3,
    name: 'strips gain monitor + recordTap (the split tap)',
    run: (m) => {
      const map = (m.map ?? {}) as RawMap
      const strips = Array.isArray(map.strips) ? (map.strips as RawMap[]) : []
      return {
        ...m,
        map: {
          ...map,
          strips: strips.map((s) => ({
            ...s,
            // CLOSED, and this one deliberately does NOT preserve how a v2 map
            // sounded — unlike the masterLevel migration above, which had to.
            //
            // A v2 map sounded like every input strip monitoring permanently,
            // with no way to stop it: that is the bug this version exists to
            // fix, and faithfully restoring it would reopen every saved map
            // straight back into the feedback loop. Opening a monitor is one
            // click and is audible immediately; a feedback loop you cannot
            // switch off is not recoverable from without deleting the strip.
            monitor: false,
            // null = the rule decides, which reproduces v2 behaviour for a
            // strip with no input (it still records its channel bus) and gives
            // the input case the split tap.
            recordTap: null,
          })),
        },
      }
    },
  },
  3: {
    to: 4,
    name: 'a grid strip carries its tempo intent',
    run: (m) => {
      const map = (m.map ?? {}) as RawMap
      const strips = Array.isArray(map.strips) ? (map.strips as RawMap[]) : []
      return {
        ...m,
        map: {
          ...map,
          strips: strips.map((s) => {
            const element = (s.element ?? {}) as RawMap
            if (element.kind !== 'grid') return s
            return {
              ...s,
              element: {
                ...element,
                // CHOSEN SO A v3 MAP SOUNDS UNCHANGED, the same rule the
                // masterLevel migration followed. v3 had one sync mechanism —
                // the bus stretcher, at a plain master/deck ratio — so the
                // faithful restatement is timeStretch at 1:1 with no transpose.
                // `auto` would be the better DEFAULT for a new strip and the
                // wrong migration: it can resolve to 1:2 and would silently
                // half-time a deck the next time an old map was opened.
                tempoMode: 'timeStretch',
                pulseRelation: '1:1',
                transpose: 0,
              },
            }
          }),
        },
      }
    },
  },
  4: {
    to: 5,
    name: 'a tape strip carries its tempo intent (P3-2b-1)',
    run: (m) => {
      const map = (m.map ?? {}) as RawMap
      const strips = Array.isArray(map.strips) ? (map.strips as RawMap[]) : []
      return {
        ...m,
        map: {
          ...map,
          strips: strips.map((s) => {
            const element = (s.element ?? {}) as RawMap
            if (element.kind !== 'tape') return s
            return {
              ...s,
              element: {
                ...element,
                // CHOSEN SO A v4 MAP SOUNDS UNCHANGED (the house migration
                // rule): v4 tapes had no sync at all, so the faithful
                // restatement is sync OFF with an UNKNOWN bpm — never an
                // inferred one, which could differ between builds and change
                // how a saved set plays. timePitch is the D-3 default (zero
                // latency); it is inert while sync is off.
                bpm: null,
                syncToMaster: false,
                tempoMode: 'timePitch',
                pulseRelation: 'auto',
              },
            }
          }),
        },
      }
    },
  },
  5: {
    to: 6,
    name: 'strips gain the DRV stage (P3-X2)',
    run: (m) => {
      const map = (m.map ?? {}) as RawMap
      const strips = Array.isArray(map.strips) ? (map.strips as RawMap[]) : []
      return {
        ...m,
        map: {
          ...map,
          strips: strips.map((s) => ({
            ...s,
            // OFF, because that is what a v5 map SOUNDED like: there was no
            // per-strip drive stage, and amount 1 is a bypass BRANCH in the
            // engine (bit-exact, not a unity multiply), so an old map plays
            // back identically. The house migration rule.
            drive: { curve: 0, amount: 1 },
          })),
        },
      }
    },
  },
  6: {
    to: 7,
    name: 'routes may name a deck output (P3.5-E3)',
    // NOTHING TO CHANGE, and the version still earns its keep. v6 documents are
    // valid v7 documents: `deckOut` widens the source enum, so no existing field
    // moves. What the bump records is the WRITE side — a v7 build can save a
    // deckOut cable, and a v6 build must refuse that file rather than parse it
    // strictly-and-fail with a confusing per-field error. Two shapes sharing one
    // version number is exactly what the version exists to prevent, so an
    // identity migration is the honest entry, not a skipped one.
    run: (m) => m,
  },
  7: {
    to: 8,
    name: 'the map remembers its FX plugins (P6-5b)',
    run: (m) => {
      const map = (m.map ?? {}) as RawMap
      return {
        ...m,
        // FOUR EMPTY RETURNS, because that is what a v7 map SOUNDED like: there
        // was nowhere to store a plugin, so reopening one always came up with
        // bare returns. The house migration rule — an old map plays back exactly
        // as it did. Note this is not the same as omitting the field: an explicit
        // "nothing loaded" is what lets the restore path tell an empty return
        // from a map that never knew about returns.
        map: { ...map, fx: emptyFxSlots() },
      }
    },
  },
  9: {
    to: 10,
    name: 'strips name what they launch against (D-SL-QUANTUM-01)',
    run: (m) => {
      const map = (m.map ?? {}) as RawMap
      const strips = Array.isArray(map.strips) ? (map.strips as RawMap[]) : []
      const transport = (map.transport ?? {}) as RawMap
      return {
        ...m,
        map: {
          ...map,
          // AUTO on every strip, and NO sync master. That is what a v9 map
          // behaved like: there was no quantized launch reachable at all, so
          // every launch fired immediately — which is exactly what `auto`
          // resolves to when nothing is playing, and what it resolves to
          // sensibly when something is. Naming a master here would invent a
          // relationship the saved set never had.
          strips: strips.map((st) => {
            const element = (st.element ?? {}) as RawMap
            if (element.kind !== 'grid' && element.kind !== 'tape') return st
            return { ...st, element: { ...element, launchRef: 'auto' } }
          }),
          transport: {
            ...transport,
            // The donor's own default (`globalLaunchQuantize = .cycle`).
            launchQuantum: 'cycle',
            syncMasterKey: null,
          },
        },
      }
    },
  },
  8: {
    to: 9,
    name: 'a grid strip carries its TP mode (B1/P7-T2)',
    run: (m) => {
      const map = (m.map ?? {}) as RawMap
      const strips = Array.isArray(map.strips) ? (map.strips as RawMap[]) : []
      return {
        ...m,
        map: {
          ...map,
          strips: strips.map((s) => {
            const element = (s.element ?? {}) as RawMap
            if (element.kind !== 'grid') return s
            // FALSE, because that is what a v8 map BEHAVED like: there was no
            // exclusion, so sync and transpose could both be on and often were.
            // It is also the donor's own default (`pitchModeEnabled` starts
            // off), so this migration and a fresh strip agree — the house rule
            // twice over.
            return { ...s, element: { ...element, pitchMode: false } }
          }),
        },
      }
    },
  },
}

/** This strip's remembered performance state for `sessionId`, or the defaults.
    Never returns undefined: a session this strip has not hosted before starts
    at scene A, scheduled, empty queue — which is what a fresh load looks like. */
export function perfFor(strip: Strip, sessionId: string): GridPerf {
  return strip.sessionPerf[sessionId] ?? defaultGridPerf()
}

/** Remember `perf` for `sessionId`, returning a new strip (the store is
    immutable-update shaped, like the rest of the document). */
export function rememberPerf(strip: Strip, sessionId: string, perf: GridPerf): Strip {
  return { ...strip, sessionPerf: { ...strip.sessionPerf, [sessionId]: perf } }
}

/** Lanes an element occupies — the lane budget's unit of account. */
export function elementLanes(element: Element): number {
  switch (element.kind) {
    case 'none':
      return 0
    case 'grid':
      return 2 // a scoopy session is inherently stereo
    case 'tape':
      return element.stereo ? 2 : 1
  }
}

export function lanesUsed(map: PlaneMap): number {
  return map.strips.reduce((n, s) => n + elementLanes(s.element), 0)
}

export function emptyMap(): PlaneMap {
  return {
    plane: { scale: 1, panX: 0, panY: 0 },
    strips: [],
    routes: [],
    transport: {
      masterBpm: 120,
      masterLevel: 1,
      // The donor's own default (`globalLaunchQuantize = .cycle`), and no
      // master nominated — `auto` needs none with two decks running.
      launchQuantum: 'cycle',
      syncMasterKey: null,
    },
    fx: emptyFxSlots(),
  }
}

export function saveMap(map: PlaneMap, app = 'scoopy'): MapDocument {
  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    app,
    map,
  }
}

/**
 * Parse and migrate. Refuses rather than guesses:
 *  - a NEWER document is refused loudly (preserve-don't-drop);
 *  - an unknown key or bad shape is `corrupt`, never silently coerced;
 *  - a map that overspends the lane budget is refused with the count, because
 *    loading it would leave the engine unable to render what the document
 *    claims and the user staring at a strip that makes no sound.
 */
export function loadMap(raw: unknown): MapLoadResult {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false, reason: 'corrupt', message: 'not an object' }

  const versionField = (raw as RawMap).schemaVersion
  if (typeof versionField !== 'number' || !Number.isInteger(versionField) || versionField < 1)
    return { ok: false, reason: 'corrupt', message: 'missing or invalid schemaVersion' }

  if (versionField > MAP_SCHEMA_VERSION)
    return {
      ok: false,
      reason: 'tooNew',
      message: `saved by a newer version (schema ${versionField}, this build reads ${MAP_SCHEMA_VERSION}). Refusing rather than dropping what it knows.`,
    }

  let working = raw as RawMap
  const from = versionField
  let v = versionField
  while (v < MAP_SCHEMA_VERSION) {
    const step = MIGRATIONS[v]
    if (!step)
      return {
        ok: false,
        reason: 'corrupt',
        message: `no migration from schema ${v} — this document predates any shipped format`,
      }
    working = { ...step.run(working), schemaVersion: step.to }
    v = step.to
  }

  const parsed = MapDocumentSchema.safeParse(working)
  if (!parsed.success)
    return { ok: false, reason: 'corrupt', message: parsed.error.issues[0]?.message ?? 'invalid' }

  const used = lanesUsed(parsed.data.map)
  if (used > LANE_BUDGET)
    return {
      ok: false,
      reason: 'laneBudget',
      message: `map uses ${used} lanes, budget is ${LANE_BUDGET}`,
    }

  return from === MAP_SCHEMA_VERSION
    ? { ok: true, map: parsed.data.map }
    : { ok: true, map: parsed.data.map, migratedFrom: from }
}
