/**
 * Session envelope + migration (P7-02, docs/specs/sessions.md §3).
 *
 * The version axis is where preserve-don't-drop actually bites. A session
 * written by a NEWER Wizard is refused loudly rather than partially loaded —
 * partially loading it and then re-saving would silently destroy whatever the
 * newer version knew about. An OLDER session migrates through NAMED per-version
 * steps, each independently testable, never a best-effort object spread.
 */
import { PatchSchema, SCHEMA_VERSION, emptyPatch, type Patch } from '../../protocol/schema'
import { DEFAULT_CELL } from '../../protocol/schema'
import { autoLayout } from '../plane/planeLayout'
import { z } from 'zod'

/** The on-disk envelope. Deliberately thin: the Patch is the document. */
export const SessionSchema = z
  .object({
    /** The schema the session was WRITTEN with — drives migration. */
    schemaVersion: z.number().int().positive(),
    /** ISO-8601 UTC, for the user's benefit only; never used for ordering logic. */
    savedAt: z.string(),
    /** What wrote it, for support ("saved by Wizard 0.0.1"). */
    app: z.string(),
    patch: PatchSchema,
  })
  .strict() // unknown key = loud failure (the law)
export type Session = z.infer<typeof SessionSchema>

export type LoadResult =
  | { ok: true; patch: Patch; migratedFrom?: number }
  | { ok: false; reason: 'tooNew' | 'corrupt' | 'unsupported'; message: string }

/**
 * One named function per version step. A migration takes the RAW parsed object
 * of version N and returns the raw object of version N+1 — it must never assume
 * the current schema's shape, because it runs on documents older than it.
 *
 * Adding a schema version means adding an entry here (or asserting the change
 * was purely additive with a safe default, which is the common case).
 */
type RawSession = Record<string, unknown>
const MIGRATIONS: Record<number, { to: number; name: string; run: (s: RawSession) => RawSession }> =
  {
    // Versions 1..11 predate sessions existing on disk: no user can hold one, so
    // there is nothing to migrate FROM. They are listed as a wall rather than
    // silently accepted, so a hand-edited or fabricated file fails honestly.

    // v15 -> v16 (PD-CANVAS-01, D-WZ-PDCANVAS-01): the plane arrives. Every strip
    // gains a `cell` (plane geometry) and the patch gains a `plane` (viewport).
    // A pre-plane session had no geometry, so we AUTO-LAY-OUT the existing
    // channels into a tidy grid — deterministic, nothing invented that could
    // surprise the user, and it matches the console rack's left-to-right order.
    // Runs on the RAW object: it must not assume the current schema's shape.
    15: {
      to: 16,
      name: 'add-cell-plane (PD-CANVAS)',
      run: (s) => addCellAndPlane(s),
    },

    // v16 -> v17: the Strip became HORIZONTAL and player-shaped, so the default
    // cell size changed. Re-run autoLayout to re-place every strip at the new
    // size — otherwise a v16 session renders player-shaped contents inside
    // narrow rack-shaped boxes.
    //
    // Re-laying-out is safe HERE and would not be later: drag-to-move does not
    // exist yet (PD-CANVAS-02b), so no hand-made arrangement can exist to
    // destroy — every cell in the wild was auto-placed by this same function.
    // Once strips can be dragged, a size change must preserve positions instead.
    16: {
      to: 17,
      name: 'relayout-horizontal-strips (PD-CANVAS)',
      run: (s) => relayout(s),
    },

    // v17 -> v18 (P7-08, D-WZ-DEVGONE-01): the session remembers its device.
    // Purely additive with a safe default — an older session simply had no
    // preference, which is exactly what the empty strings mean.
    // v21 -> v22: deckSeek (scrub) was added. It is a COMMAND, not a document
    // field, so the patch is unchanged — but the step must still exist, because
    // migrate() walks version by version and a gap fails the load outright.
    // An explicit identity is the honest way to say "nothing to do here".
    21: { to: 22, name: 'deckSeek added (command-only, patch unchanged)', run: (s) => s },

    // v22 -> v23: deckScrub (tape/turntable) added. A COMMAND, not a document
    // field, so the patch is unchanged — but the step must exist or migrate()
    // hits a gap and refuses the load.
    22: { to: 23, name: 'deckScrub added (command-only, patch unchanged)', run: (s) => s },

    // v23 -> v24: deckOverdub added — a COMMAND, not a document field. The step
    // must exist even though the patch is unchanged, or migrate() hits a gap.
    23: { to: 24, name: 'deckOverdub added (command-only, patch unchanged)', run: (s) => s },

    // v20 -> v21: `uiMode` is DELETED. It named 'console' | 'strip' as document
    // state, but the console no longer exists and "strip mode" is just a
    // zoomed-out plane, which `plane.scale` already carries. Leaving the field
    // would have been a lie in the schema and a second source of truth for the
    // same idea.
    //
    // The key must be REMOVED, not ignored: the parse is strict, so a leftover
    // `uiMode` would be an unknown key and the session would fail to load —
    // the preserve-don't-drop law firing on our own retired field.
    20: {
      to: 21,
      name: 'drop-uiMode (the console is gone)',
      run: (s) => {
        const patch = { ...((s.patch ?? {}) as RawSession) }
        delete patch.uiMode
        return { ...s, patch }
      },
    },

    // v24 -> v25: the Strip grew again (overdub + input-monitor), so the default
    // size grew to hold the full control set without clipping. PRESERVES x/y —
    // strips can be dragged, so an arrangement exists and must survive a size
    // change. Only w/h are updated.
    24: {
      to: 25,
      name: 'grow-strip-for-full-controls (keeps positions)',
      run: (s) => {
        const patch = (s.patch ?? {}) as RawSession
        const channels = Array.isArray(patch.channels) ? patch.channels : []
        return {
          ...s,
          patch: {
            ...patch,
            channels: channels.map((raw) => {
              const ch = raw as RawSession
              const cell = (ch.cell ?? {}) as RawSession
              return { ...ch, cell: { ...cell, w: DEFAULT_CELL.w, h: DEFAULT_CELL.h } }
            }),
          },
        }
      },
    },

    // v25 -> v26: deckOverdub gained a punch MODE — command-only, patch
    // unchanged, but the step must exist or migrate() hits a gap.
    25: { to: 26, name: 'overdub punch mode (command-only, patch unchanged)', run: (s) => s },

    // v26 -> v27: deckInsertTake added — command-only, patch unchanged.
    26: { to: 27, name: 'deckInsertTake added (command-only, patch unchanged)', run: (s) => s },

    // v27 -> v28: the master fader becomes part of the document. Additive with
    // the unity default, which is exactly what an older session was silently
    // getting anyway.
    27: {
      to: 28,
      name: 'persist-master-fader',
      run: (s) => {
        const patch = (s.patch ?? {}) as RawSession
        return { ...s, patch: { ...patch, mainGain: 0.75 } }
      },
    },

    // v28 -> v29: REPAIR a stuck monitor switch. Arming a take opened
    // `monitorSwitch` (D-WZ-MON-01) and the Law C-3 handoff never closed it, so
    // a strip that had recorded published as its INPUT forever and ⟳ did nothing
    // audible. The engine fix cannot reach a session already on disk — the stuck
    // switch is a persisted field — so any strip that HOLDS MATERIAL has it
    // closed here. A strip without material is left alone: there, an open switch
    // is a deliberate "listen to my input", which is still the whole point of
    // the control.
    28: {
      to: 29,
      name: 'close-stuck-monitor-switch',
      run: (s) => {
        const patch = (s.patch ?? {}) as RawSession
        const channels = Array.isArray(patch.channels) ? patch.channels : []
        return {
          ...s,
          patch: {
            ...patch,
            channels: channels.map((c) => {
              const ch = (c ?? {}) as Record<string, unknown>
              return ch.material ? { ...ch, monitorSwitch: false } : ch
            }),
          },
        }
      },
    },

    // v29 -> v30: REPAIR duplicate strip keys. The key counter restarted at 1
    // on every launch, so the first strip added after restoring a session took a
    // `ch-1` the document already had. `validatePatch` refuses a patch with a
    // duplicate key — correctly — so from that moment EVERY publish was refused
    // and the engine held no world: nothing played, nothing recorded, and the
    // only evidence was a console.error inside a WebView.
    //
    // The engine fix (seeding the counter) cannot help a document that is
    // already broken, so duplicates are renamed here. The FIRST occurrence keeps
    // its key — anything else would renumber strips that were fine.
    29: {
      to: 30,
      name: 'dedupe-strip-keys',
      run: (s) => {
        const patch = (s.patch ?? {}) as RawSession
        const channels = Array.isArray(patch.channels) ? patch.channels : []
        const seen = new Set<string>()
        let next = 1
        return {
          ...s,
          patch: {
            ...patch,
            channels: channels.map((c) => {
              const ch = (c ?? {}) as Record<string, unknown>
              const key = typeof ch.key === 'string' ? ch.key : ''
              if (key !== '' && !seen.has(key)) {
                seen.add(key)
                return ch
              }
              let fresh = `ch-r${next++}`
              while (seen.has(fresh)) fresh = `ch-r${next++}`
              seen.add(fresh)
              return { ...ch, key: fresh }
            }),
          },
        }
      },
    },

    // v19 -> v20: the Strip regained the controls the retired console carried
    // (editable bus, remove, the loopback's stated price, the material name) and
    // its transport is now always present, so the default height grew.
    //
    // Unlike the v16->v17 relayout, this migration PRESERVES x/y. Strips can be
    // dragged now, so a hand-made arrangement exists and re-laying it out would
    // destroy the user's work — exactly the caveat v16->v17 recorded for
    // whoever changed a default size next. Only the height is updated.
    19: {
      to: 20,
      name: 'grow-strip-height (keeps positions)',
      run: (s) => {
        const patch = (s.patch ?? {}) as RawSession
        const channels = Array.isArray(patch.channels) ? patch.channels : []
        return {
          ...s,
          patch: {
            ...patch,
            channels: channels.map((raw) => {
              const ch = raw as RawSession
              const cell = (ch.cell ?? {}) as RawSession
              return { ...ch, cell: { ...cell, h: DEFAULT_CELL.h } }
            }),
          },
        }
      },
    },

    // v18 -> v19 (PD-CANVAS-06): a Strip's MATERIAL splits from its SOURCE.
    // A pre-split deck strip encoded both in `source` (kind 'deck', id = the
    // deck index), so material is derived from exactly that and `source` is
    // left ALONE — the engine still renders from it, so rewriting it here would
    // silence every existing deck strip. Non-deck strips get null: they have no
    // material, which is the honest answer, not a guess.
    18: {
      to: 19,
      name: 'split-material-from-source (PD-CANVAS-06)',
      run: (s) => {
        const patch = (s.patch ?? {}) as RawSession
        const channels = Array.isArray(patch.channels) ? patch.channels : []
        return {
          ...s,
          patch: {
            ...patch,
            channels: channels.map((raw) => {
              const ch = raw as RawSession
              const src = (ch.source ?? {}) as RawSession
              const id = Number.parseInt(String(src.id ?? ''), 10)
              const isDeck = src.kind === 'deck' && Number.isInteger(id) && id >= 0 && id <= 7
              return { ...ch, material: isDeck ? { deckId: id } : null }
            }),
          },
        }
      },
    },

    17: {
      to: 18,
      name: 'add-session-device (P7-08)',
      run: (s) => {
        const patch = (s.patch ?? {}) as RawSession
        return { ...s, patch: { ...patch, device: { input: '', output: '' } } }
      },
    },
  }

/** Re-place every channel with the CURRENT default cell size. */
function relayout(s: RawSession): RawSession {
  const patch = (s.patch ?? {}) as RawSession
  const channels = Array.isArray(patch.channels) ? patch.channels : []
  const cells = autoLayout(channels.length)
  return {
    ...s,
    patch: {
      ...patch,
      channels: channels.map((ch, i) => ({ ...(ch as RawSession), cell: cells[i] })),
    },
  }
}

/** The v15->v16 migration body. Kept as a named function so it is unit-testable
    in isolation and reads as documentation of the layout it produces. The grid
    itself comes from autoLayout — the SAME function the live plane uses to place
    cells — so a migrated session and a freshly-arranged one never diverge. */
function addCellAndPlane(s: RawSession): RawSession {
  const patch = (s.patch ?? {}) as RawSession
  const channels = Array.isArray(patch.channels) ? patch.channels : []
  const cells = autoLayout(channels.length)
  const laidOut = channels.map((ch, i) => ({ ...(ch as RawSession), cell: cells[i] }))
  return {
    ...s,
    patch: { ...patch, channels: laidOut, plane: { scale: 1, panX: 0, panY: 0 } },
  }
}

/** Apply migrations from `from` up to SCHEMA_VERSION. */
function migrate(raw: RawSession, from: number): { raw: RawSession } | { error: string } {
  let cur = from
  let doc = raw
  const applied: string[] = []
  while (cur < SCHEMA_VERSION) {
    const step = MIGRATIONS[cur]
    if (!step) {
      return {
        error:
          `no migration from schema v${cur} (this session predates saved sessions, ` +
          `or was written by a build that is not a released version)`,
      }
    }
    doc = step.run(doc)
    applied.push(step.name)
    cur = step.to
  }
  return { raw: doc }
}

/** Build an envelope around the current Patch. */
export function makeSession(patch: Patch, nowIso: string, app = 'Wizard 0.0.1'): Session {
  return { schemaVersion: SCHEMA_VERSION, savedAt: nowIso, app, patch }
}

export function serializeSession(session: Session): string {
  // Pretty-printed with stable key order (JSON.stringify preserves insertion
  // order, and our objects are built in a fixed order) — a byte-stable re-save
  // is what makes the golden-corpus gate meaningful (spec §6).
  return JSON.stringify(session, null, 2) + '\n'
}

/**
 * Parse + migrate a session document. Never throws: every failure is a typed
 * result the caller can show, because "the app silently started empty" is the
 * outcome this whole file exists to prevent.
 */
export function loadSession(text: string): LoadResult {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    return { ok: false, reason: 'corrupt', message: `not valid JSON: ${String(e)}` }
  }
  if (typeof raw !== 'object' || raw === null)
    return { ok: false, reason: 'corrupt', message: 'session is not an object' }

  const version = (raw as RawSession).schemaVersion
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1)
    return { ok: false, reason: 'corrupt', message: 'session has no usable schemaVersion' }

  if (version > SCHEMA_VERSION) {
    // REFUSE. Loading what we can understand and re-saving would quietly delete
    // everything the newer version knew about.
    return {
      ok: false,
      reason: 'tooNew',
      message:
        `this session was saved by a newer Wizard (schema v${version}; this build ` +
        `understands v${SCHEMA_VERSION}). Update Wizard to open it — opening it here ` +
        `would discard what the newer version saved.`,
    }
  }

  let doc = raw as RawSession
  let migratedFrom: number | undefined
  if (version < SCHEMA_VERSION) {
    const result = migrate(doc, version)
    if ('error' in result) return { ok: false, reason: 'unsupported', message: result.error }
    doc = result.raw
    migratedFrom = version
    doc.schemaVersion = SCHEMA_VERSION
  }

  const parsed = SessionSchema.safeParse(doc)
  if (!parsed.success) {
    // A strict-schema failure here is the preserve-don't-drop law firing: an
    // unknown or malformed key is loud, never quietly discarded.
    return {
      ok: false,
      reason: 'corrupt',
      message: `session does not match the schema: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    }
  }
  return migratedFrom === undefined
    ? { ok: true, patch: parsed.data.patch }
    : { ok: true, patch: parsed.data.patch, migratedFrom }
}

/** A fresh, valid session — used when there is nothing to restore. */
export function emptySession(nowIso: string): Session {
  return makeSession(emptyPatch(), nowIso)
}
