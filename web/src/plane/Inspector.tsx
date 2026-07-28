/**
 * THE INSPECTOR — the "set precisely" half of a strip (merge P2 step 4, inc 5).
 *
 * The other side of pd-strip-anatomy §3's split. The object carries what you
 * touch while playing; this carries what needs a number, a name or a decision:
 *
 *   ON THE OBJECT    level · sends · rate · transport · REC · the loop DRAG
 *   HERE             the loop in/out in FRAMES · rename · the take's identity ·
 *                    what feeds it and where it goes · remove
 *
 * Drag is coarse BY DESIGN — the brace on the wave field is the performance —
 * and this is where you type the number afterwards. That is the whole reason
 * both exist.
 *
 * ⚠️ WITH NOTHING SELECTED IT IS NOT BLANK. `pd-plane-playground` §5.3 is
 * explicit: 260 px of dead space teaches that the Inspector is usually useless.
 * The empty state is the PLANE SUMMARY, which doubles as the "where is
 * everything?" readout — on a boundless plane you can scroll away from your own
 * patch, and this is what says it is still there.
 */
import type { EngineLink } from '../engineLink.ts'
import type { PlaneMap, Strip } from '../persist/mapDocument.ts'
import type { DJPulseRelation, DJTempoMode } from '../panels/djMix.ts'
import { deckTempoIntent, formatSyncedBpm } from '../persist/tempo.ts'
import { chipsOf, feedbackMs } from './cables.ts'
import { channelLabel, useDeviceStore } from './devices.ts'
import { send } from './send.ts'
import { summarise, summaryLines } from './summary.ts'
import { useMapStore, updateGridTempo, updateStrip } from '../state/mapStore.ts'

type GridPulse = DJPulseRelation

export function Inspector({
  link,
  map,
  selectedKey,
  unresolved,
  onRemove,
  onCarve,
}: {
  link: EngineLink | null
  map: PlaneMap
  selectedKey: string | null
  unresolved?: ReadonlySet<string>
  onRemove: (strip: Strip) => void
  onCarve?: (strip: Strip) => void
}) {
  const strip = map.strips.find((s) => s.key === selectedKey) ?? null
  return (
    <aside className="plane-inspector" data-no-drag>
      {strip ? (
        <StripInspector link={link} map={map} strip={strip} onRemove={onRemove} onCarve={onCarve} />
      ) : (
        <PlaneInspector map={map} unresolved={unresolved} />
      )}
    </aside>
  )
}

/** The empty state — never blank. */
function PlaneInspector({
  map,
  unresolved,
}: {
  map: PlaneMap
  unresolved?: ReadonlySet<string>
}) {
  const lines = summaryLines(summarise(map, unresolved))
  return (
    <>
      <h2 className="mono ins-title">PLANE</h2>
      <dl className="ins-rows mono">
        {lines.map((l) => (
          <div key={l.label} className={`ins-row${l.warn ? ' warn' : ''}`}>
            <dt>{l.label}</dt>
            <dd>{l.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mono dim ins-hint">
        select a strip to edit it precisely · shift-drag between strips to patch ·
        ⌘R for the routing ledger
      </p>
    </>
  )
}

function StripInspector({
  link,
  map,
  strip,
  onRemove,
  onCarve,
}: {
  link: EngineLink | null
  map: PlaneMap
  strip: Strip
  onRemove: (strip: Strip) => void
  onCarve?: (strip: Strip) => void
}) {
  const channels = useDeviceStore((d) => d.channels)
  const chips = chipsOf(map, strip)
  const tape = strip.element.kind === 'tape' ? strip.element : null
  const grid = strip.element.kind === 'grid' ? strip.element : null
  const input = map.routes.find(
    (r) => r.src.kind === 'deviceInput' && r.dst.kind === 'channelIn' && r.dst.index === strip.channel,
  )
  const feeds = map.routes.filter(
    (r) =>
      (r.src.kind === 'channelOut' || r.src.kind === 'channelSend') &&
      r.dst.kind === 'channelIn' &&
      r.dst.index === strip.channel,
  )
  const nameOf = (channel: number) =>
    map.strips.find((s) => s.channel === channel)?.name ?? `channel ${channel + 1}`

  return (
    <>
      <h2 className="mono ins-title">STRIP</h2>

      <section className="ins-section">
        <h3 className="mono dim">identity</h3>
        <label className="ins-field mono">
          name
          {/* TYPING, which is exactly why it is here and not on the object. */}
          <input
            type="text"
            value={strip.name}
            onChange={(e) => updateStrip(strip.key, (s) => ({ ...s, name: e.target.value }))}
          />
        </label>
        <div className="ins-row mono">
          <dt>element</dt>
          <dd>
            {strip.element.kind === 'none'
              ? 'empty — press REC to give it material'
              : strip.element.kind === 'tape'
                ? `tape ${strip.element.index}${strip.element.stereo ? ' · stereo' : ' · mono'}`
                : `${strip.element.sessionId} · grid deck ${strip.element.deck}`}
          </dd>
        </div>
        <div className="ins-row mono">
          <dt>channel</dt>
          <dd>{strip.channel + 1} of 8</dd>
        </div>
      </section>

      <section className="ins-section">
        <h3 className="mono dim">routing</h3>
        <div className="ins-row mono">
          <dt>in</dt>
          <dd>
            {input
              ? channelLabel(channels, input.src.index, input.src.sub)
              : feeds.length > 0
                ? feeds
                    .map((f) =>
                      f.src.kind === 'channelSend'
                        ? `${nameOf(f.src.index)} send ${(f.src.sub ?? 0) + 1}`
                        : nameOf(f.src.index),
                    )
                    .join(', ')
                : 'nothing'}
          </dd>
        </div>
        <div className={`ins-row mono${chips.toMain ? '' : ' warn'}`}>
          <dt>out</dt>
          {/* The CONSEQUENCE stays on the object (the chip and the status
              line); the Inspector states it too, because this is where you come
              when the object's one line was not enough. */}
          <dd>{chips.toMain ? 'main' : 'nothing — this strip is inaudible'}</dd>
        </div>
        {feeds.some((f) => f.feedback) && (
          <div className="ins-row mono warn">
            <dt>feedback</dt>
            <dd>+{feedbackMs().toFixed(1)} ms (one block)</dd>
          </div>
        )}
      </section>

      {/* TEMPO — a grid strip only, for the same reason `material` is a tape
          only: a pulse relation on a strip with no deck is meaningless, not
          disabled. This is the half of the tempo domain that does NOT belong
          on the object: you set a pulse relation once and then live with it,
          where the mode is something you flip mid-set and hear immediately. */}
      {grid && (
        <section className="ins-section">
          <h3 className="mono dim">tempo</h3>
          <div className="ins-row mono">
            <dt>runs at</dt>
            {/* WHAT IT WILL ACTUALLY PLAY, resolved through scoopy's law. This
                is the number the strip's own bpm box does not show: a synced
                deck keeps its session tempo and is stretched to the master, so
                its own bpm and its running bpm are different facts. */}
            <dd>
              {grid.syncToMaster
                ? `${formatSyncedBpm(deckTempoIntent(grid, map.transport.masterBpm))} BPM · ${
                    deckTempoIntent(grid, map.transport.masterBpm).pulse
                  } of master ${map.transport.masterBpm}`
                : `${grid.bpm} BPM · free`}
            </dd>
          </div>
          <label className="ins-field mono">
            mode
            <select
              value={grid.tempoMode}
              onChange={(e) =>
                updateGridTempo(strip.key, link, { tempoMode: e.target.value as DJTempoMode })
              }
            >
              <option value="timeStretch">stretch — tempo moves, pitch stays</option>
              <option value="timePitch">time + pitch — varispeed, like a turntable</option>
              <option value="tempoOnly">tempo only — the step clock alone</option>
            </select>
          </label>
          <label className="ins-field mono">
            pulse
            <select
              value={grid.pulseRelation}
              onChange={(e) =>
                updateGridTempo(strip.key, link, {
                  pulseRelation: e.target.value as GridPulse,
                })
              }
            >
              {/* `auto` first because it is right most of the time: it picks the
                  nearest MUSICAL relation in log-tempo distance, which is what
                  keeps a 90 BPM session under a 128 master from landing on a
                  meaningless 1.42×. The explicit ones are for when you want the
                  deck deliberately in half-time or in three-against-two. */}
              {(['auto', '1:3', '1:2', '2:3', '1:1', '3:2', '2:1', '3:1'] as const).map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="ins-field mono">
            transpose
            {/* Semitones, independent of tempo — the other half of "tempo and
                pitch". It is what lets a synced deck sit in the key of the set
                rather than the key it was sampled in. */}
            <input
              type="number"
              min={-24}
              max={24}
              step={1}
              value={grid.transpose}
              onChange={(e) => {
                const transpose = Number(e.target.value)
                if (!Number.isFinite(transpose)) return
                updateGridTempo(strip.key, link, { transpose })
              }}
            />
          </label>
        </section>
      )}

      {/* MATERIAL — present only for a tape, because loop points on a strip
          with no material are not "disabled", they are meaningless. That is a
          different call from the OBJECT's layout law, where every row must
          exist: the object has a fixed box to protect and this panel does not. */}
      {tape && (
        <section className="ins-section">
          <h3 className="mono dim">material</h3>
          <label className="ins-field mono">
            loop in
            <input
              type="number"
              min={0}
              step={1}
              value={tape.loop.start}
              onChange={(e) => setLoop(strip, link, Number(e.target.value), tape.loop.end)}
            />
          </label>
          <label className="ins-field mono">
            loop out
            <input
              type="number"
              min={0}
              step={1}
              value={tape.loop.end}
              onChange={(e) => setLoop(strip, link, tape.loop.start, Number(e.target.value))}
            />
          </label>
          <label className="ins-field mono">
            rate
            <input
              type="number"
              min={-2}
              max={2}
              step={0.01}
              value={tape.rate}
              onChange={(e) => {
                const rate = Number(e.target.value)
                if (!Number.isFinite(rate)) return
                updateStrip(strip.key, (s) =>
                  s.element.kind === 'tape' ? { ...s, element: { ...s.element, rate } } : s,
                )
                send(link, 'slTape', { action: 'setRate', tape: tape.index, rate })
              }}
            />
          </label>
          <label className="ins-field mono">
            bpm
            {/* THE TAPE'S OWN TEMPO (P3-2b-2) — the sync law's `originalBpm`.
                Auto-filled from the take's record-time stamp when it can be
                inferred honestly; ALWAYS editable, and the hand always wins
                (the auto-fill only ever writes a null). Empty = unknown: a
                tape that cannot state its tempo cannot sync, and says so
                rather than guessing. */}
            <input
              type="number"
              min={1}
              max={600}
              step={0.01}
              value={tape.bpm ?? ''}
              placeholder="unknown"
              onChange={(e) => {
                const raw = e.target.value
                const bpm = raw === '' ? null : Number(raw)
                if (bpm !== null && (!Number.isFinite(bpm) || bpm <= 0)) return
                updateStrip(strip.key, (s) =>
                  s.element.kind === 'tape' ? { ...s, element: { ...s.element, bpm } } : s,
                )
              }}
            />
          </label>
          <div className="ins-row mono">
            <dt>take</dt>
            {/* The provenance. Once a strip's element is a tape, this reference
                is the ONLY record of what the material was — a strip that
                cannot answer "what am I playing?" is an anonymous buffer. */}
            <dd title={tape.takeRef ?? undefined}>
              {tape.takeRef ? tape.takeRef.split('/').pop() : 'nothing recorded yet'}
            </dd>
          </div>
        </section>
      )}

      {tape && tape.takeRef && (
        <section className="ins-section">
          <h3 className="mono dim">carve</h3>
          <p className="mono dim ins-hint">
            send the loop region to the grid as a track. The tape layer is
            freed for the next capture; the take stays in the library.
          </p>
          {/* A COMMITMENT, not a performance gesture — "done performing this
              live; make it a composition element" — so it is in the Inspector
              rather than on the object, next to the numbers that define the
              region it will take. */}
          <button
            type="button"
            className="ins-carve mono"
            onClick={() => onCarve?.(strip)}
            disabled={!tape.loop.enabled || tape.loop.end <= tape.loop.start}
            title={
              tape.loop.enabled && tape.loop.end > tape.loop.start
                ? 'carve the loop region into a grid track'
                : 'set a loop region first — carve takes what the brace covers'
            }
          >
            carve loop → grid track
          </button>
        </section>
      )}

      <section className="ins-section">
        {/* DESTRUCTIVE, so it is here and never one-handed near a REC button. */}
        <button type="button" className="ins-remove mono" onClick={() => onRemove(strip)}>
          remove strip
        </button>
      </section>
    </>
  )
}

/** Loop points, clamped so out is never before in — an inverted region is not a
    loop and the engine would read it as an empty one. */
function setLoop(strip: Strip, link: EngineLink | null, start: number, end: number) {
  if (strip.element.kind !== 'tape') return
  const s = Math.max(0, Math.floor(start))
  const e = Math.max(s, Math.floor(end))
  updateStrip(strip.key, (x) =>
    x.element.kind === 'tape'
      ? { ...x, element: { ...x.element, loop: { ...x.element.loop, start: s, end: e } } }
      : x,
  )
  send(link, 'slTape', {
    action: 'setLoop',
    tape: strip.element.index,
    enabled: strip.element.loop.enabled,
    start: s,
    end: e,
  })
}

/** Re-exported so the panel can mount it without importing the store twice. */
export const useSelectedKey = () => useMapStore((s) => s.selectedKey)
