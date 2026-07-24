/**
 * Inspector — the "set precisely" half of the Strip (pd-canvas.md §3.0).
 *
 * The Strip carries what you touch WHILE PLAYING; this carries what you set
 * exactly. That split is what lets a plane of a dozen Strips stay legible: the
 * numbers live in one place instead of on every object.
 *
 * It is part of the MAP surface rather than a fifth one (pd-merge §1 allows no
 * new surface unless one of the four cannot work without it) — it is to the map
 * what the zoom controls and the add-strip menu already are.
 *
 * Its empty state is deliberately not blank: with nothing selected it answers
 * "where is everything?", which is the question leaving the fixed rack cost us.
 */
import type { EngineLink } from '../engine/engineLink'
import { usePatchActions } from '../engine/usePatch'
import { useAppStore } from '../store/appStore'

function timecode(frames: number, rate: number): string {
  if (rate <= 0 || frames <= 0) return '0.000s'
  const s = frames / rate
  if (s < 60) return `${s.toFixed(3)}s`
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, '0')}`
}

export function Inspector({ link }: { link: EngineLink | null }) {
  const channels = useAppStore((s) => s.patch.channels)
  const decks = useAppStore((s) => s.patch.decks)
  const selectedKey = useAppStore((s) => s.selectedKey)
  const deckFrames = useAppStore((s) => s.deckFrames)
  const deviceInfo = useAppStore((s) => s.deviceInfo)
  const setSelected = useAppStore((s) => s.setSelected)
  const actions = usePatchActions(link)

  const index = channels.findIndex((c) => c.key === selectedKey)
  const channel = index >= 0 ? channels[index] : undefined
  const deck = channel?.material ? decks.find((d) => d.id === channel.material!.deckId) : undefined
  const frames = deck ? (deckFrames[deck.id] ?? 0) : 0
  const rate = deviceInfo?.sampleRate ?? 0

  if (!channel) {
    // The plane summary: the answer to "where is everything?" that a boundless
    // plane otherwise owes you.
    const unmapped = channels.filter((c) => c.outBus >= (deviceInfo?.mappableBuses ?? 1)).length
    return (
      <aside className="inspector raised">
        <h2>Inspector</h2>
        <p className="dim">Select a strip to set its exact values.</p>
        <dl className="inspector-facts">
          <dt>strips</dt>
          <dd>{channels.length}</dd>
          <dt>with material</dt>
          <dd>{channels.filter((c) => c.material).length}</dd>
          <dt>device</dt>
          <dd>{deviceInfo?.inputDeviceName || 'none'}</dd>
        </dl>
        {unmapped > 0 && (
          <p className="plane-strip-bus-unmapped">
            {unmapped} strip{unmapped === 1 ? '' : 's'} routed where this device cannot carry —
            not heard
          </p>
        )}
      </aside>
    )
  }

  return (
    <aside className="inspector raised">
      <h2>Inspector</h2>

      <label className="ds-row">
        <span className="ds-label">name</span>
        <input
          className="inspector-text"
          value={channel.name}
          onChange={(ev) => actions.renameStrip(index, ev.target.value)}
        />
      </label>

      <h3>Source</h3>
      <dl className="inspector-facts">
        <dt>kind</dt>
        <dd>{channel.source.kind}</dd>
        <dt>bound to</dt>
        <dd title={channel.source.id}>{channel.source.name || '—'}</dd>
      </dl>

      <h3>Material</h3>
      {!deck && <p className="dim">nothing recorded or loaded yet</p>}
      {deck && (
        <>
          <dl className="inspector-facts">
            <dt>length</dt>
            <dd>{timecode(frames, rate)}</dd>
            <dt>file</dt>
            <dd title={deck.sourcePath}>{deck.sourcePath.split('/').pop() || '—'}</dd>
          </dl>

          {/* Exact loop points. Dragging the wave is deliberately COARSE — a
              380px strip showing minutes of audio is ~0.5 s per pixel — so the
              sample-accurate numbers belong here rather than in a gesture. */}
          <h3>Loop</h3>
          <label className="ds-row">
            <span className="ds-label">in</span>
            <input
              className="inspector-num"
              type="number"
              min={0}
              max={Math.max(0, frames)}
              value={deck.loopStartSample}
              onChange={(ev) =>
                actions.setDeckLoop(deck.id, Number(ev.target.value), deck.loopEndSample)
              }
            />
            <span className="ds-value">{timecode(deck.loopStartSample, rate)}</span>
          </label>
          <label className="ds-row">
            <span className="ds-label">out</span>
            <input
              className="inspector-num"
              type="number"
              min={0}
              max={Math.max(0, frames)}
              value={deck.loopEndSample}
              onChange={(ev) =>
                actions.setDeckLoop(deck.id, deck.loopStartSample, Number(ev.target.value))
              }
            />
            <span className="ds-value">{timecode(deck.loopEndSample, rate)}</span>
          </label>
          <button
            type="button"
            title="loop the whole buffer"
            onClick={() => actions.setDeckLoop(deck.id, 0, frames)}
          >
            whole take
          </button>
        </>
      )}

      <h3>Routing</h3>
      <dl className="inspector-facts">
        <dt>bus</dt>
        <dd>{channel.outBus === 0 ? 'main' : `bus ${channel.outBus + 1}`}</dd>
        <dt>cue</dt>
        <dd>{channel.toMonitor ? 'on' : 'off'}</dd>
      </dl>

      <button type="button" onClick={() => setSelected(null)}>
        deselect
      </button>
    </aside>
  )
}
