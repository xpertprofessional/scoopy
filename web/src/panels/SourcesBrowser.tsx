/**
 * Sources browser v0 (console left rail): the device's active input channels —
 * bind one as a mono strip or a consecutive pair as a stereo strip — plus the
 * deck section (add a deck = a deck + its strip). App taps, system-mix and the
 * virtual device join this panel in P2/P5, capability-gated.
 */
import type { EngineLink } from '../engine/engineLink'
import { usePatchActions } from '../engine/usePatch'
import { useAppStore } from '../store/appStore'

export function SourcesBrowser({ link }: { link: EngineLink | null }) {
  const deviceInfo = useAppStore((s) => s.deviceInfo)
  const deckCount = useAppStore((s) => s.patch.decks.length)
  const actions = usePatchActions(link)

  const inputs = deviceInfo?.inputs ?? []

  return (
    <aside className="sources raised">
      <h2>Sources</h2>
      <h3>{deviceInfo ? deviceInfo.deviceName : 'no device'}</h3>
      <ul>
        {inputs.map((input, i) => {
          const next = inputs[i + 1]
          return (
            <li key={input.index}>
              <button
                type="button"
                onClick={() =>
                  actions.addSourceChannel(input.name, {
                    kind: 'deviceInput',
                    id: String(input.index),
                    name: input.name,
                  })
                }
              >
                + {input.name}
              </button>
              {next && (
                <button
                  type="button"
                  title="bind as stereo pair"
                  onClick={() =>
                    actions.addSourceChannel(`${input.name} / ${next.name}`, {
                      kind: 'deviceInput',
                      id: `${input.index},${next.index}`,
                      name: `${input.name} / ${next.name}`,
                    })
                  }
                >
                  + pair
                </button>
              )}
            </li>
          )
        })}
        {inputs.length === 0 && <li className="dim">no inputs</li>}
      </ul>
      <h3>Decks</h3>
      <button type="button" disabled={deckCount >= 8} onClick={() => actions.addDeckWithStrip()}>
        + add deck ({deckCount}/8)
      </button>
    </aside>
  )
}
