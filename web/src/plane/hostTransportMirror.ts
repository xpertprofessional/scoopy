/**
 * THE DAW'S TRANSPORT, ADOPTED BY THE DECK'S OWN STATE (real-host report,
 * 2026-08-02).
 *
 * ScoopyDeck's processor starts the deck on the host's play edge, and until now
 * that was all it did: `hostPlaying` in the panel was a lamp. The STORE's
 * `playing` stayed false while the deck was audibly running, and everything
 * that reads it was wrong in the same direction — the deck row showed ◼ over a
 * playing deck, a scene launch took the "stopped" branch and cut instantly
 * instead of waiting for the boundary, ⟳ refused to arm, and every world
 * publish carried `isPlaying: false` (which is what actually stopped the music,
 * and is fixed on the native side by `hostOwnsTransport`).
 *
 * The rule is three lines of decision and four ways to get it wrong, which is
 * why it is a function rather than a condition inside an effect:
 *
 *   · EDGES ONLY. The user may press ◼ on a deck the DAW is still rolling — a
 *     stated stop, honoured natively — and a re-render must not put it back.
 *     `mirrored` is what the last adoption saw, not what the host is doing.
 *   · NOT WITHOUT A SESSION. A window opened mid-playback boots asynchronously;
 *     the edge must survive until there is something to start, so it is NOT
 *     recorded while the deck is empty.
 *   · CLK INT FORGETS. Switching back to HOST adopts the transport the DAW is
 *     in right now, not the one it was in when the user left.
 *   · ALREADY AGREEING IS A NO-OP, so a host play edge on a deck the user
 *     already started does not restart it.
 */
export interface HostTransportState {
  /** CLK — is the DAW's transport driving this deck at all? */
  followTransport: boolean;
  /** What the DAW's playhead is doing (`hostTransport`, or the boot read). */
  hostPlaying: boolean;
  /** What the last adoption saw. `null` = nothing adopted yet, or CLK INT. */
  mirrored: boolean | null;
  /** Is there a document on this deck to start? */
  hasSession: boolean;
  /** What the store currently believes this deck's transport is. */
  deckPlaying: boolean;
}

export interface HostTransportAdoption {
  /** The store action to take, if any. */
  act: "play" | "stop" | null;
  /** What to remember as seen — assign it back to the ref every time. */
  mirrored: boolean | null;
}

export function adoptHostTransport(s: HostTransportState): HostTransportAdoption {
  // CLK INT: the page owns the transport again, and remembers nothing.
  if (!s.followTransport) return { act: null, mirrored: null };
  // Nothing to start yet — leave the edge unclaimed so it is adopted once a
  // session opens.
  if (!s.hasSession) return { act: null, mirrored: s.mirrored };
  if (s.mirrored === s.hostPlaying) return { act: null, mirrored: s.mirrored };
  // The edge is CONSUMED whether or not it changes anything: a host play edge
  // on a deck the user already started must not be re-adopted later.
  if (s.hostPlaying === s.deckPlaying) return { act: null, mirrored: s.hostPlaying };
  return { act: s.hostPlaying ? "play" : "stop", mirrored: s.hostPlaying };
}
