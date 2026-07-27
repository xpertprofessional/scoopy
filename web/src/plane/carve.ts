/**
 * CARVE — the one-way bridge from a tape to a grid track (merge P2, inc 6).
 *
 * STRIP-MODEL names this and nothing implemented it:
 *
 *   "Carving a region into a grid track FREES the tape element (clears it for
 *    the next capture) — carving is a commitment to the grid, and keeping both
 *    playing would double the same audio. NOTHING IS LOST: everything is one
 *    persisted crash-safe take; the carved region becomes the grid track's
 *    sample and the FULL take stays in the take library, reloadable into a tape
 *    later. Freeing = clearing the layer, not destroying the audio."
 *
 * THE INVARIANT THAT MAKES IT SAFE, and the one `takeLibrary` already tests: a
 * scrubbable tape and a grid track carved from it reference the SAME take id.
 * A carve therefore copies no audio and a session never duplicates any — the
 * carve is a REGION (a trim on the shared take), never a new file. Getting that
 * wrong would make every carve grow the session by the length of the take, and
 * it would take a full disk to notice.
 *
 * Pure and separate from any store, so the region maths and the
 * "what survives" rules are testable without a session, an engine or a DOM.
 */
import type { Strip } from '../persist/mapDocument.ts'

/** What a carve produces for the grid: a track pointing at the SAME take, with
    the region expressed as the trim the pattern document already understands
    (`sampleStartMs` / `sampleEndMs`). */
export type CarvedTrack = {
  /** The shared take. Never a copy — see the invariant above. */
  takeRef: string
  sampleStartMs: number
  sampleEndMs: number
  /** A name the user will recognise in the grid: the take's file name plus the
      region, because "take_0003" alone is indistinguishable from four other
      carves of the same take. */
  name: string
}

export type CarveResult =
  | { ok: true; track: CarvedTrack; strip: Strip }
  | { ok: false; reason: string }

/**
 * Carve this strip's loop region into a grid track.
 *
 * REFUSED rather than guessed at when there is nothing to carve. Each refusal
 * is a case where proceeding would produce a track that renders silence, which
 * looks like a broken grid rather than a mistaken gesture:
 *
 *  - no tape, or no take behind it → there is no audio to point a track at;
 *  - an empty or inverted region → a zero-length track;
 *  - loop disabled → the region on screen is not what would be carved, and
 *    carving something the user cannot see is worse than declining.
 */
export function carve(strip: Strip, sampleRate: number): CarveResult {
  if (strip.element.kind !== 'tape') return { ok: false, reason: 'this strip has no tape' }
  const tape = strip.element
  if (tape.takeRef === null)
    return { ok: false, reason: 'nothing recorded yet — carve needs a take to point at' }
  if (!tape.loop.enabled)
    return { ok: false, reason: 'turn the loop on first — carve takes the loop region' }
  if (tape.loop.end <= tape.loop.start)
    return { ok: false, reason: 'the loop region is empty' }
  if (!(sampleRate > 0)) return { ok: false, reason: 'unknown sample rate' }

  const toMs = (frames: number) => (frames / sampleRate) * 1000
  const file = tape.takeRef.split('/').pop() ?? tape.takeRef

  return {
    ok: true,
    track: {
      takeRef: tape.takeRef,
      sampleStartMs: toMs(tape.loop.start),
      sampleEndMs: toMs(tape.loop.end),
      // The region in the name, because four carves of one take are otherwise
      // four tracks with the same label.
      name: `${file} ${fmt(toMs(tape.loop.start))}–${fmt(toMs(tape.loop.end))}`,
    },
    // THE TAPE LAYER IS CLEARED, THE AUDIO IS NOT. The element goes back to
    // `none` and the strip keeps its key, name, cell, level, mute and sends —
    // so the object you were looking at is still there, ready for the next
    // capture, rather than vanishing and reappearing. The take stays in the
    // library and can be loaded into a tape again.
    strip: { ...strip, element: { kind: 'none' } },
  }
}

/** Seconds to one decimal, for a track name. */
function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * Is this take still referenced anywhere after a carve?
 *
 * Used to decide what `unreferencedTakes` may offer to reclaim. A carved take
 * is unreferenced BY THE PLANE by design — the tape layer was cleared — but it
 * is now referenced by the SESSION, so reporting it as reclaimable would offer
 * to delete audio a grid track is playing.
 */
export function stillReferenced(
  takeRef: string,
  strips: readonly Strip[],
  carvedTrackRefs: readonly string[],
): boolean {
  return (
    carvedTrackRefs.includes(takeRef) ||
    strips.some((s) => s.element.kind === 'tape' && s.element.takeRef === takeRef)
  )
}
