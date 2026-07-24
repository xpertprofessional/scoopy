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
