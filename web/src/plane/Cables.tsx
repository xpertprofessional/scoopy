/**
 * The cable layer (merge P2 step 4, increment 4).
 *
 * An SVG sheet INSIDE the plane's transform, so cables pan and zoom with the
 * strips they connect rather than being re-projected every frame. It sits
 * BEHIND the strips (`z-index` below them, `pointer-events: none` except on the
 * paths themselves) so a cable can never intercept a click meant for a fader —
 * the plane is an instrument first and a diagram second.
 *
 * Only graph edges are drawn; terminal routes are chips on the strip. See
 * `cables.ts` for why that split, and why it differs from the earlier
 * no-cables-at-all decision.
 */
import { cablePath, cablesOf, inPoint, outPoint, feedbackMs, type Cable } from './cables.ts'
import type { PlaneMap } from '../persist/mapDocument.ts'
import { semanticColor } from '../design/tokens.ts'

export function Cables({
  map,
  onRemove,
}: {
  map: PlaneMap
  /** Click a cable to unpatch it. The engine ramps the gain out and drops the
      slot only once it reaches zero, so unpatching a live cable is a crossfade
      rather than a click. */
  onRemove?: (cable: Cable) => void
}) {
  const cables = cablesOf(map)
  if (cables.length === 0) return null

  const byKey = new Map(map.strips.map((s) => [s.key, s]))

  return (
    // A very large fixed viewport rather than a measured one: the plane is
    // boundless and strips may sit at negative coordinates, so an SVG sized to
    // its content would need re-measuring on every drag. Overflow is visible,
    // so nothing is clipped at the edges.
    <svg className="plane-cables" width="1" height="1" overflow="visible" aria-hidden>
      {cables.map((c, i) => {
        const from = byKey.get(c.fromKey)
        const to = byKey.get(c.toKey)
        if (!from || !to) return null
        const a = outPoint(from.cell, c.send)
        const b = inPoint(to.cell)
        // The cable wears its SOURCE strip's identity colour, so following one
        // back to where it came from is a glance rather than a trace. A send
        // cable wears the SEND's colour instead — the same one that send's
        // micro-fader and its FX return wear, which is what makes "send 3"
        // one object across three surfaces.
        const colour =
          c.send === null ? semanticColor('deck', from.channel) : semanticColor('send', c.send)
        return (
          <g key={i} className={`plane-cable${c.feedback ? ' feedback' : ''}`}>
            {/* A wide invisible stroke under the visible one: a 2 px line is
                almost impossible to hit, and a cable you cannot click is a
                cable you cannot remove. */}
            <path
              d={cablePath(a, b)}
              className="plane-cable-hit"
              onClick={() => onRemove?.(c)}
            >
              <title>
                {c.send === null
                  ? `${from.name} → ${to.name}`
                  : `${from.name} send ${c.send + 1} → ${to.name}`}
                {c.feedback
                  ? ` · feedback, +${feedbackMs().toFixed(1)} ms (one block)`
                  : ' · zero added latency'}
                {' · click to unpatch'}
              </title>
            </path>
            <path d={cablePath(a, b)} className="plane-cable-line" style={{ stroke: colour }} />
          </g>
        )
      })}
    </svg>
  )
}
