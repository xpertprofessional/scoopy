/**
 * TR-FT-12 band traversal: each track's control band is a horizontal stop
 * between two tracks' cell rows (vertical/spatial topology — ↓ from the
 * cells enters the band, ↓ again reaches the next track's cells). Traversal
 * ORDER comes from the DOM (document order == visual order): conditional
 * controls (chop tool, stretch quality, mod slots) mount and unmount freely,
 * so the focus registry's mount order can never be trusted for position.
 */

export interface BandControl {
  id: string;
  centerX: number;
  centerY: number;
}

/**
 * Focusable controls of one track's band, in visual order.
 *
 * NAV-11: `root` scopes the DOM query. The DJ page mounts TWO grids and both
 * render `.trk-strip[data-track-index="N"]` — a document-wide query always
 * returned the FIRST (left deck's) strip, so the right deck's ↑/↓ traversed
 * the wrong deck's geometry (and scrolled it). The caller passes its own panel
 * element so each deck reads only its own band. Falls back to `document` for
 * the compose grid / tests, where there is exactly one strip per index.
 */
export function bandControls(trackIndex: number, root: ParentNode | null = document): BandControl[] {
  const strip = (root ?? document).querySelector(`.trk-strip[data-track-index="${trackIndex}"]`);
  if (!strip) return [];
  const out: BandControl[] = [];
  strip.querySelectorAll<HTMLElement>("[data-focus-id]").forEach((el) => {
    const id = el.getAttribute("data-focus-id");
    if (!id) return;
    const r = el.getBoundingClientRect();
    out.push({ id, centerX: r.left + r.width / 2, centerY: r.top + r.height / 2 });
  });
  return out;
}

/**
 * Group the band's controls into VISUAL rows by rendered center-y (TR-FT-12
 * follow-up, user-approved): ↑/↓ hop these rows before exiting to the
 * neighbouring cell rows. Grouping by geometry (not `.trk-ctrl-row`
 * containers) means a flex-WRAPPED long row hops line by line too. Rows come
 * back top→bottom, each row's items left→right. `tolerance` absorbs the few
 * px of center jitter between mixed control heights on one line.
 */
export function groupRows(ctrls: BandControl[], tolerance = 6): BandControl[][] {
  const rows: { y: number; items: BandControl[] }[] = [];
  for (const c of ctrls) {
    const row = rows.find((r) => Math.abs(r.y - c.centerY) <= tolerance);
    if (row) row.items.push(c);
    else rows.push({ y: c.centerY, items: [c] });
  }
  rows.sort((a, b) => a.y - b.y);
  for (const r of rows) r.items.sort((a, b) => a.centerX - b.centerX);
  return rows.map((r) => r.items);
}

/** Index whose centerX is nearest to x (ties resolve to the left one). */
export function nearestIndexByX(centers: number[], x: number): number {
  let best = 0;
  let bestDist = Infinity;
  centers.forEach((c, k) => {
    const d = Math.abs(c - x);
    if (d < bestDist) {
      bestDist = d;
      best = k;
    }
  });
  return best;
}

/** Next index for ←/→ inside the band — clamped, no wrap (grid ←/→ parity).
 *  cur === -1 (focused id vanished, e.g. a conditional control) re-enters at
 *  the travel edge instead of stranding. */
export function stepIndex(cur: number, dir: -1 | 1, len: number): number {
  if (len <= 0) return -1;
  if (cur < 0) return dir === 1 ? 0 : len - 1;
  return Math.max(0, Math.min(len - 1, cur + dir));
}
