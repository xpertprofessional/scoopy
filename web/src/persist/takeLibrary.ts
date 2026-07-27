/**
 * The TAKE LIBRARY — every recording the app has made, and the Law C-2 maths
 * that makes them line up.
 *
 * STRIP-MODEL names this: "everything is one persisted crash-safe take; the
 * carved region becomes the grid track's sample and the FULL take stays in the
 * take library, reloadable into a tape later." So the library is what makes
 * "carve frees the tape" non-destructive — the tape layer is cleared, the audio
 * is not.
 *
 * ONE TAKE, MANY REFERENCES. A scrubbable tape and any grid track carved from
 * it point at the SAME take id. That is the invariant that keeps a session from
 * bloating: recording never duplicates audio, and a carve is a reference plus a
 * region, not a copy.
 *
 * ⚠️ THE SIDECAR SHAPE IS A HAND-MIRRORED BOUNDARY. The `.wav.json` files are
 * written by a hand-rolled printf in `host/src/WavWriter.cpp::writeSidecar`
 * (the merged repo), which has no schema this can be generated from. The
 * codebase's standing law is "never hand-mirror a mapping", and this is the one
 * place it cannot be honoured — so instead `takeLibrary.test.ts` pins a byte
 * sample copied verbatim from that printf's format string. If the C++ side
 * changes a field name, that test fails rather than this parser silently
 * returning nothing for every take.
 */
import { z } from 'zod'

/** Exactly the fields `wav::writeSidecar` emits — see the warning above. */
export const TakeSidecarSchema = z
  .object({
    /** The engine slot that recorded it (wizard deck / merged tape index). */
    deckId: z.number().int().min(0),
    /** LAW C-2: the engine-sample the recording began at. The whole point of
        the take system — realigning two takes is a subtraction, not a guess. */
    startEngineSample: z.number().int().min(0),
    /** ISO-8601 UTC. For the user's benefit only; never used for ordering,
        because wall clock can jump and the engine clock cannot. */
    wallClock: z.string(),
    /** What was being recorded, in human words ("Built-in Mic 1"). This is the
        only provenance a take carries once its strip has moved on. */
    sourceDesc: z.string(),
    sampleRate: z.number().positive(),
    channels: z.number().int().min(1),
    frames: z.number().int().min(0),
  })
  .strict()
export type TakeSidecar = z.infer<typeof TakeSidecarSchema>

export type Take = TakeSidecar & {
  /** Stable id used by `Element.takeRef` in the map document. */
  id: string
  /** Path of the .wav (the sidecar is this + ".json"). */
  path: string
}

export type ParseResult =
  | { ok: true; sidecar: TakeSidecar }
  | { ok: false; reason: string }

/**
 * Parse one sidecar. A take whose sidecar is unreadable is NOT silently
 * skipped: the caller is told why, so a corrupt sidecar surfaces as a broken
 * take rather than a take that quietly ceased to exist.
 */
export function parseSidecar(raw: unknown): ParseResult {
  const parsed = TakeSidecarSchema.safeParse(raw)
  if (!parsed.success)
    return { ok: false, reason: parsed.error.issues[0]?.message ?? 'invalid sidecar' }
  return { ok: true, sidecar: parsed.data }
}

/** Duration in seconds. Guards a zero rate rather than returning Infinity. */
export function takeSeconds(t: Pick<Take, 'frames' | 'sampleRate'>): number {
  return t.sampleRate > 0 ? t.frames / t.sampleRate : 0
}

/**
 * LAW C-2, the payoff. How far `take` starts AFTER `origin`, in samples.
 *
 * This is the whole reason the engine keeps ONE monotonic sample clock that
 * advances regardless of transport: drop every take at 0:00 in a DAW, offset
 * each by this, and the session reproduces exactly. Negative means the take
 * started BEFORE the origin, which is legitimate — the origin is whichever take
 * the user chose to align against, not necessarily the earliest.
 */
export function alignmentSamples(
  take: Pick<Take, 'startEngineSample'>,
  origin: Pick<Take, 'startEngineSample'>,
): number {
  return take.startEngineSample - origin.startEngineSample
}

/** The same offset in seconds, at the take's own rate. */
export function alignmentSeconds(
  take: Pick<Take, 'startEngineSample' | 'sampleRate'>,
  origin: Pick<Take, 'startEngineSample'>,
): number {
  return take.sampleRate > 0 ? alignmentSamples(take, origin) / take.sampleRate : 0
}

/**
 * The library: takes indexed by id.
 *
 * Deliberately a plain value rather than a class with IO in it — enumerating a
 * directory is the host's job and differs per shell (native FS, OPFS in the
 * browser companion), so the library is BUILT from whatever the host found. It
 * keeps this testable without a filesystem, which is the same reason mapApply
 * is a planner rather than a caller.
 */
export type TakeLibrary = { byId: ReadonlyMap<string, Take> }

export function buildLibrary(takes: readonly Take[]): TakeLibrary {
  const byId = new Map<string, Take>()
  for (const t of takes) byId.set(t.id, t)
  return { byId }
}

export type Resolution =
  | { ok: true; take: Take }
  /** The document references a take the library does not have. NOT an error to
      swallow: pd-strip-anatomy's "audio missing" state keeps the strip, keeps
      the reference, and keeps REC enabled — recording over a dead reference is
      a repair. Dropping the reference would destroy the only record of what the
      strip was supposed to be playing. */
  | { ok: false; ref: string }

export function resolveTake(lib: TakeLibrary, ref: string): Resolution {
  const take = lib.byId.get(ref)
  return take !== undefined ? { ok: true, take } : { ok: false, ref }
}

/**
 * Which takes a map still refers to. Used to decide what a package must carry,
 * and — the more important direction — what it must NOT drop.
 *
 * Takes the strips as a bare shape rather than importing the map document, so
 * the library stays usable from anywhere and the two modules do not become
 * circular.
 */
export function referencedTakeIds(
  strips: readonly { element: { kind: string; takeRef?: string | null } }[],
): Set<string> {
  const out = new Set<string>()
  for (const s of strips)
    if (s.element.kind === 'tape' && typeof s.element.takeRef === 'string')
      out.add(s.element.takeRef)
  return out
}

/**
 * Takes in the library that no strip references any more.
 *
 * NOTE what this is for: showing the user what is reclaimable, never for
 * deleting anything behind their back. A carve frees the tape LAYER while the
 * full take stays in the library on purpose (STRIP-MODEL), so "unreferenced"
 * means "not currently loaded", not "unwanted" — the take may be exactly what
 * the user wants to reload next.
 */
export function unreferencedTakes(lib: TakeLibrary, referenced: ReadonlySet<string>): Take[] {
  const out: Take[] = []
  for (const [id, take] of lib.byId) if (!referenced.has(id)) out.push(take)
  return out
}
