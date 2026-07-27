/**
 * The plane summary — what the Inspector shows with NOTHING selected.
 *
 * `pd-plane-playground` §5.3 is explicit that the empty state must not be
 * blank: 260 px of dead space teaches the user that the Inspector is usually
 * useless. It doubles as the "where is everything?" readout that pd-canvas §5
 * names as the honest cost of leaving a rack — on a boundless plane you can
 * scroll away from your own patch, and the summary is what says it is still
 * there.
 *
 * Pure, so every count can be checked without a DOM.
 */
import { LANE_BUDGET, lanesUsed, type PlaneMap } from '../persist/mapDocument.ts'
import { cablesOf } from './cables.ts'

export type PlaneSummary = {
  strips: number
  /** Strips that actually have material — a plane of eight empty strips and a
      plane of eight loaded ones look identical in a count of strips. */
  withMaterial: number
  tapes: number
  grids: number
  /** Mixer lanes spent of the budget. The unit of account decision 6 settled. */
  lanes: number
  laneBudget: number
  /** Cables you MADE — graph edges. The 40 boot routes are terminal and are
      deliberately not counted: reporting 41 cables on a fresh plane would make
      the number useless for the question it answers. */
  cables: number
  feedbackCables: number
  /** Strips whose output reaches nothing — silent for a routing reason, and
      the single most valuable thing this panel can say. */
  silent: number
  /** Strips referencing a take, and how many of those the library cannot
      find. Unresolved refs are PRESERVED rather than dropped, so the plane can
      carry them silently — which is exactly why the count belongs here. */
  takeRefs: number
  unresolvedRefs: number
}

export function summarise(map: PlaneMap, unresolved: ReadonlySet<string> = new Set()): PlaneSummary {
  const cables = cablesOf(map)
  let withMaterial = 0
  let tapes = 0
  let grids = 0
  let takeRefs = 0
  let unresolvedRefs = 0
  for (const s of map.strips) {
    if (s.element.kind === 'tape') {
      tapes += 1
      if (s.element.takeRef !== null) {
        takeRefs += 1
        if (unresolved.has(s.element.takeRef)) unresolvedRefs += 1
        else withMaterial += 1
      }
    } else if (s.element.kind === 'grid') {
      grids += 1
      withMaterial += 1
    }
  }

  // A strip is silent-for-routing when nothing carries its output anywhere:
  // not to main, not into another strip, not into a send bus.
  const silent = map.strips.filter((s) => {
    return !map.routes.some(
      (r) =>
        (r.src.kind === 'channelOut' || r.src.kind === 'channelSend') &&
        r.src.index === s.channel,
    )
  }).length

  return {
    strips: map.strips.length,
    withMaterial,
    tapes,
    grids,
    lanes: lanesUsed(map),
    laneBudget: LANE_BUDGET,
    cables: cables.length,
    feedbackCables: cables.filter((c) => c.feedback).length,
    silent,
    takeRefs,
    unresolvedRefs,
  }
}

/** One line per fact, in the order a person would ask them. Returned as data
    rather than markup so the ordering is testable and the panel stays a
    rendering of it. */
export function summaryLines(s: PlaneSummary): Array<{ label: string; value: string; warn?: boolean }> {
  return [
    { label: 'strips', value: `${s.strips} · ${s.withMaterial} with material` },
    { label: 'elements', value: `${s.tapes} tape · ${s.grids} grid` },
    {
      label: 'lanes',
      value: `${s.lanes} of ${s.laneBudget}`,
      // At the budget you cannot add another stereo element, and finding that
      // out from a refused click is worse than seeing it coming.
      warn: s.lanes >= s.laneBudget,
    },
    {
      label: 'cables',
      value:
        s.cables === 0
          ? 'none beyond the defaults'
          : `${s.cables}${s.feedbackCables > 0 ? ` · ${s.feedbackCables} feedback` : ''}`,
    },
    ...(s.unresolvedRefs > 0
      ? [
          {
            label: 'missing',
            value: `${s.unresolvedRefs} of ${s.takeRefs} takes not found`,
            warn: true,
          },
        ]
      : []),
    ...(s.silent > 0
      ? [{ label: 'silent', value: `${s.silent} strip${s.silent === 1 ? '' : 's'} go nowhere`, warn: true }]
      : []),
  ]
}
