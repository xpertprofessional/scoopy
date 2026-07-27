/**
 * Cross-deck focus bridge for the DJ view's two GridPanels.
 *
 * The DJ view mounts TWO independent <GridPanel> instances side by side (one per
 * slot), each with its OWN cell-focus cursor and its OWN `window` keydown
 * listener. Before this, every deck seeded and painted its own always-on ring
 * ("both sides look focused"), only the deck Swift marked `keyboardActive`
 * actually acted, and arrow nav clamped at each deck's own step boundary — so
 * there was no way to walk the focus across from the left deck to the right one.
 *
 * This bridge lets a deck sitting at its step edge hand the ring to the deck in
 * the neighbouring SLOT. It carries only enough to place the cursor at the entry
 * edge; the keyboard hand-off itself is the neighbour's own `selectTrack`
 * (→ Swift `activeSequencer`), fired from its `enter` handler.
 *
 * Slot index — NOT deck index — decides left/right: deck C projects into slot A
 * or B, so a deck's column position is its slot, not its number.
 */

type Edge = "left" | "right";

interface DeckFocusReg {
  /** 0 = left column, 1 = right column. */
  slotIndex: number;
  /** Place this deck's ring at the entry edge, carrying the origin track row. */
  enter: (edge: Edge, fromTrackIndex: number) => void;
}

const regs = new Map<number, DeckFocusReg>();

/** Register a DJ deck's focus handler. Returns an unregister thunk. */
export function registerDjFocus(
  deck: number,
  slotIndex: number,
  enter: (edge: Edge, fromTrackIndex: number) => void,
): () => void {
  const reg: DeckFocusReg = { slotIndex, enter };
  regs.set(deck, reg);
  return () => {
    // Only clear if we still own the slot — a remount may have replaced us.
    if (regs.get(deck) === reg) regs.delete(deck);
  };
}

/** The deck immediately to the `dir` of `fromDeck`, or null at the far edge. */
export function djNeighbor(fromDeck: number, dir: Edge): number | null {
  const from = regs.get(fromDeck);
  if (!from) return null;
  const wantSlot = from.slotIndex + (dir === "right" ? 1 : -1);
  for (const [deck, reg] of regs) {
    if (deck !== fromDeck && reg.slotIndex === wantSlot) return deck;
  }
  return null;
}

/**
 * NAV-12: what a deck should do with the focus store when the KEYBOARD arrives
 * without a gesture of its own — i.e. Swift's `-` deck switch, which moves
 * `activeSequencer` only. The two decks share ONE focus store and tell each
 * other apart by scope prefix alone (`s0/` · `s1/`), so a control ring left in
 * the other deck's scope leaves the newly-active deck unable to act: its arrow
 * handler resolves the focused id to "not one of my bands" and swallows the key,
 * while ö/ä keeps driving the deck you just left. Clicking a box was the only
 * thing that re-scoped the store — hence "navigation is stuck in deck A".
 *
 *   "keep"    — the ring is already ours (or the grid lane owns the keys, where
 *               each deck reads its OWN cell cursor and nav works untouched).
 *   "control" — a foreign deck's box holds the ring: take it, preferring our
 *               TWIN of that control (`-` off deck A's pitch box lands on deck
 *               B's pitch box), then that track's first band control.
 *   "grid"    — nothing worth mirroring: fall back to our own cell cursor.
 */
export type DeckFocusAdoption =
  | { kind: "keep" }
  | { kind: "grid" }
  | { kind: "control"; mirrorId: string; trackPrefix: string | null };

export function planDeckFocusAdoption(args: {
  lane: "controls" | "grid";
  focusedId?: string | null;
  /** This deck's focus scope, e.g. "s1/". */
  scope: string;
}): DeckFocusAdoption {
  const { lane, focusedId, scope } = args;
  // Grid lane: nav already follows the active deck (each grid paints its own
  // seeded cursor and gates on keyboardActive). This covers the remote-controls
  // case too — a box in ANOTHER webview (the mixer) holds the ring, arrows still
  // navigate this grid, so `-` has no reason to steal it.
  if (lane !== "controls" || !focusedId) return { kind: "keep" };
  if (scope && focusedId.startsWith(scope)) return { kind: "keep" };
  const bare = focusedId.replace(/^s\d+\//, "");
  const track = /^track\/(\d+)\//.exec(bare);
  return {
    kind: "control",
    mirrorId: scope + bare,
    trackPrefix: track ? `${scope}track/${track[1]}/` : null,
  };
}

/**
 * Move the ring off `fromDeck`'s edge into the neighbouring deck. Entering the
 * deck to the RIGHT lands on its LEFT edge (and vice versa), so the cursor keeps
 * travelling in the same direction. Returns the neighbour deck (which has taken
 * the keyboard) or null when there is no deck that way — the caller then clamps.
 */
export function crossDjFocus(fromDeck: number, dir: Edge, fromTrackIndex: number): number | null {
  const neighbor = djNeighbor(fromDeck, dir);
  if (neighbor === null) return null;
  regs.get(neighbor)!.enter(dir === "right" ? "left" : "right", fromTrackIndex);
  return neighbor;
}
