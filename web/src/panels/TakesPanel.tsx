/**
 * TAKES panel (P3-09, CONCEPT §3): the session's recorded artifacts. One click
 * loads a take into any deck.
 *
 * The align column is Law C-2 made visible: pick a take as the reference, and
 * every other take shows its stamp DELTA — the exact offset that would line
 * them up. No timeline is drawn (Law C-1); the numbers ARE the multitrack
 * relationship. Takes captured simultaneously are marked, since that is the
 * case C-2 exists to make reconstructible.
 */
import { useEffect } from 'react'
import type { EngineLink } from '../engine/engineLink'
import { alignOffsetSamples, formatOffset, takesOverlap } from '../engine/takeAlign'
import { usePatchActions } from '../engine/usePatch'
import { useAppStore } from '../store/appStore'

function shortName(path: string): string {
  return path.split('/').pop() ?? path
}

export function TakesPanel({ link }: { link: EngineLink | null }) {
  const takes = useAppStore((s) => s.takes)
  const decks = useAppStore((s) => s.patch.decks)
  const referencePath = useAppStore((s) => s.alignReferencePath)
  const setAlignReference = useAppStore((s) => s.setAlignReference)
  const actions = usePatchActions(link)

  // Pull the existing take list once the engine is up (takes survive a UI
  // reload; the service owns them).
  useEffect(() => {
    if (link) void actions.refreshTakes()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link])

  if (takes.length === 0) return null
  const reference = takes.find((t) => t.path === referencePath) ?? null

  return (
    <section className="takes raised">
      <h2>Takes</h2>
      <table>
        <thead>
          <tr>
            <th>take</th>
            <th>len</th>
            <th>align</th>
            <th>load into</th>
          </tr>
        </thead>
        <tbody>
          {takes.map((t) => {
            const isRef = t.path === referencePath
            const offset = reference ? alignOffsetSamples(t, reference) : 0
            const overlaps = reference && !isRef && takesOverlap(t, reference)
            return (
              <tr key={t.path}>
                <td className="take-name" title={`${t.sourceDesc} · ${t.path}`}>
                  {shortName(t.path)}
                </td>
                <td className="value">
                  {t.sampleRate > 0 ? `${(t.frames / t.sampleRate).toFixed(2)}s` : '—'}
                </td>
                <td>
                  <button
                    type="button"
                    className={isRef ? 'latched-accent' : ''}
                    title={
                      isRef
                        ? 'reference take — others show their offset from this one'
                        : 'make this the align reference (Law C-2)'
                    }
                    onClick={() => setAlignReference(isRef ? null : t.path)}
                  >
                    {isRef ? 'ref' : reference ? formatOffset(offset, t.sampleRate) : 'set ref'}
                  </button>
                  {overlaps && (
                    <span className="value" title="captured while the reference was recording">
                      {' '}
                      ⧉
                    </span>
                  )}
                </td>
                <td className="take-load">
                  {decks.map((d) => (
                    <button
                      key={d.id}
                      type="button"
                      title={`load into ${d.name}`}
                      onClick={() => void actions.deckLoadTake(d.id, t.path)}
                    >
                      {d.id + 1}
                    </button>
                  ))}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}
