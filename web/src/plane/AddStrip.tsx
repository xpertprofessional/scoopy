/**
 * Add-strip — the ONE creation gesture on the map (PD-MERGE-02, pd-merge §3).
 *
 * Replaces the sources rail. Everything that could put a Strip on the map lives
 * here: a device input (mono or as a stereo pair), a loopback of a bus, or an
 * empty deck to record into. One affordance, one list — deliberately not the
 * spawn puck / dedupe / force-duplicate machinery the review proposed, per the
 * phase rule (pd-merge §2).
 *
 * `spawnAt` is supplied by the Plane: new Strips land where you are LOOKING,
 * not at the plane origin, or every one of them would stack on top of the first.
 */
import { useState } from 'react'
import type { EngineLink } from '../engine/engineLink'
import { usePatchActions } from '../engine/usePatch'
import { useAppStore } from '../store/appStore'

export function AddStrip({
  link,
  spawnAt,
}: {
  link: EngineLink | null
  /** Where on the plane a new Strip should land, in plane coordinates. */
  spawnAt: () => { x: number; y: number }
}) {
  const [open, setOpen] = useState(false)
  const deviceInfo = useAppStore((s) => s.deviceInfo)
  const deckCount = useAppStore((s) => s.patch.decks.length)
  const actions = usePatchActions(link)
  const inputs = deviceInfo?.inputs ?? []

  // Close after any creation: the list is a means, not a place to live.
  const create = (fn: (at: { x: number; y: number }) => void) => {
    fn(spawnAt())
    setOpen(false)
  }

  return (
    <div className="add-strip">
      <button
        type="button"
        className={open ? 'latched-accent' : ''}
        title="add a strip to the map"
        onClick={() => setOpen((o) => !o)}
      >
        + strip
      </button>
      {open && (
        <div className="add-strip-menu raised" role="menu">
          <h3>{deviceInfo ? deviceInfo.inputDeviceName || 'no input device' : 'no device'}</h3>
          {inputs.length === 0 && <p className="dim">no inputs</p>}
          {inputs.map((input, i) => {
            const next = inputs[i + 1]
            return (
              <div className="add-strip-row" key={input.index}>
                <button
                  type="button"
                  onClick={() =>
                    create((at) =>
                      actions.addSourceChannel(
                        input.name,
                        { kind: 'deviceInput', id: String(input.index), name: input.name },
                        at,
                      ),
                    )
                  }
                >
                  {input.name}
                </button>
                {next && (
                  <button
                    type="button"
                    title="bind as a stereo pair"
                    onClick={() =>
                      create((at) =>
                        actions.addSourceChannel(
                          `${input.name} / ${next.name}`,
                          {
                            kind: 'deviceInput',
                            id: `${input.index},${next.index}`,
                            name: `${input.name} / ${next.name}`,
                          },
                          at,
                        ),
                      )
                    }
                  >
                    pair
                  </button>
                )}
              </div>
            )
          })}

          <h3>Deck</h3>
          <button
            type="button"
            disabled={deckCount >= 8}
            onClick={() => create((at) => actions.addDeckWithStrip(at))}
          >
            empty deck ({deckCount}/8)
          </button>

          <h3>Loopback ↺</h3>
          <p className="dim">
            records Wizard&rsquo;s own output — reads the bus one block behind, so the cycle
            is legal. Arrives muted.
          </p>
          <div className="add-strip-row">
            <button type="button" onClick={() => create((at) => actions.addLoopbackStrip(0, at))}>
              ↺ main
            </button>
            <button type="button" onClick={() => create((at) => actions.addLoopbackStrip(1, at))}>
              ↺ cue
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
