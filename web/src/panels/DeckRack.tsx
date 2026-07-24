/**
 * Deck rack v0: one cell per deck — load a file, loop / one-shot / retrigger /
 * stop. State chip mirrors the HotFrame deck block (rare-change mirror);
 * the playhead bar is a HotSurface drawer. The full 1–8 performance rack with
 * waveforms + varispeed lands in P4.
 */
import type { EngineLink } from '../engine/engineLink'
import { usePatchActions } from '../engine/usePatch'
import { useAppStore } from '../store/appStore'
import { VarispeedSlider } from './VarispeedSlider'
import { DeckWaveform } from './DeckWaveform'

const STATE_LABEL = ['idle', 'loop', 'shot', 'rec']
const RECORDING = 3

export function DeckRack({ link }: { link: EngineLink | null }) {
  const decks = useAppStore((s) => s.patch.decks)
  const channelCount = useAppStore((s) => s.patch.channels.length)
  const deckStates = useAppStore((s) => s.deckStates)
  const deckCapReached = useAppStore((s) => s.deckCapReached)
  const deckUnresolved = useAppStore((s) => s.deckUnresolved)
  const deckLoading = useAppStore((s) => s.deckLoading)
  const deckLoadProgress = useAppStore((s) => s.deckLoadProgress)
  const deviceInfo = useAppStore((s) => s.deviceInfo)
  const deckRevisions = useAppStore((s) => s.deckRevisions)
  const takes = useAppStore((s) => s.takes)
  const actions = usePatchActions(link)

  if (decks.length === 0) return null

  return (
    <section className="deck-rack">
      {decks.map((deck) => {
        const state = deckStates[deck.id] ?? 0
        const recording = state === RECORDING
        const capped = deckCapReached[deck.id] ?? false
        const unresolved = deckUnresolved[deck.id] ?? false
        const loading = deckLoading[deck.id] ?? false
        const loadProgress = deckLoadProgress[deck.id] ?? 0
        const fileName = deck.sourcePath.split('/').pop() ?? ''
        // Record the first input channel by default; the source picker gets a
        // per-deck input choice when the unified-cell UI lands (PD-CANVAS).
        const inputName = deviceInfo?.inputs[0]?.name ?? 'input 1'
        return (
          <div className="deck raised" key={deck.id}>
            <div className="deck-head">
              <span className="deck-name">{deck.name}</span>
              <span className={`deck-state deck-state-${state}`}>
                {STATE_LABEL[state] ?? '?'}
              </span>
            </div>
            <DeckWaveform
              link={link}
              deck={deck.id}
              channelCount={channelCount}
              revision={deckRevisions[deck.id] ?? 0}
              frames={
                takes.filter((t) => t.path === deck.sourcePath)[0]?.frames ??
                Math.max(deck.loopEndSample, 1)
              }
              loopStart={deck.loopStartSample}
              loopEnd={deck.loopEndSample}
              onSetLoop={(a, b) => actions.setDeckLoop(deck.id, a, b)}
            />
            <div className="deck-file dim">
              {loading ? 'loading…' : fileName || 'empty'}
            </div>
            {loading && (
              <div
                className="deck-loading"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={1}
                aria-valuenow={loadProgress}
                title="decoding on a background thread — the rest of the app stays live (P1-11)"
              >
                <div className="deck-loading-bar" style={{ width: `${loadProgress * 100}%` }} />
                <span className="deck-loading-label">
                  decoding… {Math.round(loadProgress * 100)}%
                </span>
              </div>
            )}
            {unresolved && (
              <div
                className="deck-unresolved"
                title={`this deck's audio could not be found (${deck.sourcePath}) — the deck is kept and its reference preserved, so restoring the file brings it back`}
              >
                audio missing
              </div>
            )}
            {capped && (
              <div className="deck-cap" title="256 MB deck memory cap reached — recording stopped; the take is on disk and still loops">
                cap
              </div>
            )}
            <VarispeedSlider
              rate={deck.rate}
              onChange={(rate) => actions.setDeckRate(deck.id, rate)}
            />
            <div className="deck-buttons">
              <button
                type="button"
                className={recording ? 'latched-rec' : ''}
                title={
                  recording
                    ? 'stop — the deck loops the take instantly (Law C-3)'
                    : `record ${inputName} into ${deck.name}`
                }
                onClick={() =>
                  recording
                    ? void actions.deckRecordStop(deck.id)
                    : void actions.deckRecordStart(deck.id, 0, -1, inputName)
                }
              >
                {recording ? '■ Stop' : '● Rec'}
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={() => void actions.deckLoadFile(deck.id)}
              >
                Load…
              </button>
              <button type="button" onClick={() => actions.deckTrigger(deck.id, 'loop')}>
                Loop
              </button>
              <button type="button" onClick={() => actions.deckTrigger(deck.id, 'oneShot')}>
                Shot
              </button>
              <button type="button" onClick={() => actions.deckTrigger(deck.id, 'retrigger')}>
                Re
              </button>
              <button type="button" onClick={() => actions.deckTrigger(deck.id, 'stop')}>
                Stop
              </button>
            </div>
          </div>
        )
      })}
    </section>
  )
}
