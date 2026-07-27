/**
 * THE ROUTING MATRIX — the ledger, summoned (merge P2 step 4, increment 4).
 *
 * The plane answers "where does this go?" at a glance: cables for graph edges,
 * chips for terminal facts. This is the other question — *"I have twelve strips
 * and something is going somewhere wrong"* — and it wants a table, not a
 * picture.
 *
 * SUMMONED, NEVER DOCKED (`pd-plane-playground` §3.2 L3). Nobody should need it
 * in a six-strip set; it must exist for the day somebody does. Bitwig gives its
 * routing list the same role, and Reason — the app that BELIEVES in cables —
 * still hides them by default at scale.
 *
 * It reads the LIVE engine graph, not the document. Those two drift the moment
 * anything patches outside the document's view, and the whole point of a ledger
 * is to be the thing you check when you no longer trust your own picture.
 */
import { useEffect, useState } from 'react'
import type { EngineLink } from '../engineLink.ts'
import type { PlaneMap } from '../persist/mapDocument.ts'
import { ask, send } from './send.ts'
import { feedbackMs } from './cables.ts'

/** One route slot as the engine reports it (mapApply's LiveRoute, plus the
    engine-only default flag). */
type LiveRoute = {
  active: boolean
  srcKind: number
  srcIndex: number
  srcSub: number
  dstKind: number
  dstIndex: number
  gain: number
  feedback: boolean
  isDefault: boolean
}

/** A live route WITH its engine slot id.
    ⚠️ The id is the slot's position in the engine's full 128-entry array, NOT
    its position in any filtered list. `slRoute/remove` takes that slot id, so
    filtering to active routes and then using the array index would unpatch a
    different cable than the one clicked — and the further down the list, the
    more wrong it gets. Captured at read time, once. */
type Slot = LiveRoute & { id: number }

const NO_INDEX = 0xffffffff
/** A route's endpoints in words. Strip NAMES rather than channel numbers where
    a strip exists: the ledger is for finding a mistake, and "channel 5" is not
    what anyone called it. */
function describe(
  r: LiveRoute,
  nameOf: (channel: number) => string,
): { from: string; to: string } {
  const from =
    r.srcKind === 0
      ? nameOf(r.srcIndex)
      : r.srcKind === 1
        ? `${nameOf(r.srcIndex)} · send ${r.srcSub + 1}`
        : r.srcKind === 2
          ? `input ${r.srcIndex + 1}${r.srcSub !== NO_INDEX ? `+${r.srcSub + 1}` : ''}`
          : `FX ${r.srcIndex + 1} return`
  const to =
    r.dstKind === 0
      ? nameOf(r.dstIndex)
      : r.dstKind === 1
        ? `FX bus ${r.dstIndex + 1}`
        : 'main'
  return { from, to }
}

export function Matrix({
  link,
  map,
  onClose,
}: {
  link: EngineLink | null
  map: PlaneMap
  onClose: () => void
}) {
  const [routes, setRoutes] = useState<Slot[] | null>(null)
  const [order, setOrder] = useState<number[]>([])
  const [showDefaults, setShowDefaults] = useState(false)

  const refresh = async () => {
    const r = await ask<{ routes?: LiveRoute[]; renderOrder?: number[] }>(link, 'slRouteList', {})
    setRoutes(
      (r?.routes ?? [])
        .map((x, id) => ({ ...x, id })) // the slot id, before any filtering
        .filter((x) => x.active),
    )
    setOrder(r?.renderOrder ?? [])
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const nameOf = (channel: number) =>
    map.strips.find((s) => s.channel === channel)?.name ?? `channel ${channel + 1}`

  // The boot wiring is 40 of the 128 slots and is ordinary routes, not hidden
  // special cases — so it is hideable rather than absent. Hidden by DEFAULT
  // because the question this table answers is "what did I do that I did not
  // mean to", and 40 rows of correct default wiring buries the answer.
  const shown = (routes ?? []).filter((r) => showDefaults || !r.isDefault)

  return (
    <div className="plane-matrix-scrim" onPointerDown={onClose}>
      <div
        className="plane-matrix"
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="routing matrix"
      >
        <header className="plane-matrix-head">
          <span className="mono">ROUTING</span>
          <span className="mono dim">
            {shown.length} of {routes?.length ?? 0} cables
          </span>
          <span className="plane-spacer" />
          <label className="mono dim">
            <input
              type="checkbox"
              checked={showDefaults}
              onChange={(e) => setShowDefaults(e.target.checked)}
            />
            show default wiring
          </label>
          <button type="button" onClick={() => void refresh()} title="re-read the engine">
            ↻
          </button>
          <button type="button" onClick={onClose} title="close (Esc)">
            ✕
          </button>
        </header>

        {routes === null ? (
          <p className="mono dim plane-matrix-empty">reading the engine…</p>
        ) : shown.length === 0 ? (
          <p className="mono dim plane-matrix-empty">
            {showDefaults ? 'nothing is patched' : 'no cables beyond the default wiring'}
          </p>
        ) : (
          <table className="plane-matrix-table mono">
            <thead>
              <tr>
                <th>from</th>
                <th>to</th>
                <th>gain</th>
                <th>timing</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => {
                const d = describe(r, nameOf)
                return (
                  <tr key={i} className={r.isDefault ? 'is-default' : ''}>
                    <td>{d.from}</td>
                    <td>{d.to}</td>
                    <td className="num">{r.gain.toFixed(2)}</td>
                    <td className={r.feedback ? 'warn' : 'dim'}>
                      {/* THE LOAD-BEARING COLUMN. Two routes differing only in
                          this bit differ by a whole block, and that difference
                          is inaudible as a number and obvious as a hollow
                          sound — so the table states it rather than leaving it
                          to be inferred. */}
                      {r.feedback ? `+${feedbackMs().toFixed(1)} ms` : 'in order'}
                    </td>
                    <td>
                      <button
                        type="button"
                        title="unpatch"
                        onClick={() => {
                          send(link, 'slRoute', { action: 'remove', id: r.id })
                          void refresh()
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}

        {/* THE RENDER ORDER, which is the thing nothing else can show. A chain
            A→B→C is zero-latency only because the engine visits them in
            dependency order; when someone asks why a cable "sounds a block
            late", this is the answer. */}
        {order.length > 0 && (
          <p className="mono dim plane-matrix-order">
            render order: {order.map((c) => nameOf(c)).join(' → ')}
          </p>
        )}
      </div>
    </div>
  )
}
