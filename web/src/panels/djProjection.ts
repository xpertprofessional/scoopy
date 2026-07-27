/**
 * Deck-C PROJECTION (djmode.md §8 Q3 — keep the native model).
 *
 * There are only ever TWO deck columns. Deck C does not get a third one: it
 * takes OVER slot A or B, and the slot it displaces is hidden while it does.
 * This is a deliberate UX (a DJ reads two decks, not three).
 *
 * OWNER, revised 2026-07-14: DJModeManager.deckCProjectedSlot (pushed on the
 * `dj` topic, written via `djSetting {op:"deckCProjection"}`). It was view-
 * local in DjPanel — mirroring native's @State — until the C flip button moved
 * into the TRANSPORT strip, a different WKWebView from the deck windows it
 * flips. Native's own @State stays (TR-NODELETE; one surface mounts at a
 * time). `deckInSlot` maps the shared value in both webviews;
 * `projectionAfterDeckCToggle`'s invariant now ALSO lives owner-side
 * (DJModeManager.isDeckCEnabled.didSet), where it is enforced for real.
 *
 * The rules are small but easy to get subtly wrong in JSX, and getting them
 * wrong means playing the wrong deck on stage — so they live here, pure.
 */

export type Slot = "a" | "b";

/** Which deck (0=A, 1=B, 2=C) renders in a slot. */
export function deckInSlot(
  slot: Slot,
  projection: Slot | null,
  deckCEnabled: boolean,
): number {
  // Deck C only projects while it is ENABLED. Disabling C stops its transport
  // (handleDeckCEnabledChange), so a projected-but-disabled C would leave a
  // silent, dead deck occupying a slot.
  if (projection === slot && deckCEnabled) return 2;
  return slot === "a" ? 0 : 1;
}

/**
 * Next projection state when the user toggles slot `slot`'s C button:
 * projecting into a slot that already shows C un-projects it (the button is a
 * toggle), and projecting into the other slot MOVES C rather than duplicating
 * it — C can never occupy both slots.
 */
export function toggleProjection(current: Slot | null, slot: Slot): Slot | null {
  return current === slot ? null : slot;
}

/** Projection to apply after deck C's enabled flag changes. */
export function projectionAfterDeckCToggle(
  current: Slot | null,
  deckCEnabled: boolean,
): Slot | null {
  return deckCEnabled ? current : null;
}
