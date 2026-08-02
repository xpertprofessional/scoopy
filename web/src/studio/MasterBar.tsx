/**
 * THE MASTER TEMPO, AND HOW THE SESSION IS STRETCHED TO IT (S3).
 *
 * The user's brief for Studio: *"full transport control + master tempo for
 * applying ts and tp ontop of session bpm"*. Two tempos, and the relationship
 * between them is the whole feature:
 *
 *   SESSION BPM   the tempo the pattern was written at. Lives in the session
 *                 document, per session, and `MasterRow` already edits it.
 *   MASTER TEMPO  the tempo you want to HEAR. App-global, and the number the
 *                 sync ratio is computed against.
 *
 * TS / TP / T is what that ratio costs you, and the three are genuinely
 * different rather than three names for one thing:
 *
 *   TS  timeStretch  follow the master, KEEP the pitch (the stretcher runs)
 *   TP  timePitch    follow the master by varispeed — pitch moves with tempo,
 *                    which is what a turntable does
 *   T   tempoOnly    move the TRIGGER rate only; the samples are untouched
 *
 * ⚠️ NO TEMPO MATH LIVES HERE, and that is a rule rather than a preference.
 * `panels/djMix.ts` is a golden-pinned mirror of the donor's
 * `BeatSequencer.applyDJMasterSync` (33 fixture tests, agreeing to six
 * decimals), `persist/tempo.ts` resolves a strip through it, and `applyTempo`
 * pushes the result. Every control below writes the DOCUMENT and lets that
 * chain run. The plane once computed `masterBpm / deck.bpm` by hand instead,
 * and `persist/tempo.ts`'s header is the account of what that threw away —
 * pulse relations, the tempo mode, and the ceilings.
 *
 * PERSISTED AS A SETTING, not in the session and not in the map. The donor
 * keeps `djMode.masterTempo` in UserDefaults, app-global: the tempo you work at
 * is a property of you, not of the song you happen to have open. Studio's map
 * is never saved (`studioMap.ts`), so a setting is also the only thing here
 * that survives a restart.
 */
import { useEffect } from 'react'

import type { EngineLink } from '../engineLink.ts'
import { DragBox } from '../design/DragBox.tsx'
import { setMasterBpm, useMapStore } from '../state/mapStore.ts'
import { RAMP, glideToMaster, setTempoRamp, stopGlide } from '../state/tempoGlide.ts'
import { updateGridTempo } from '../state/mapStore.ts'
import { deckTempoIntent } from '../persist/tempo.ts'
import { asNumber, useSetting } from '../useSetting.ts'
import { STUDIO_STRIP_KEY, useStudioElement, type StudioTempoMode } from './studioMap.ts'

/** App-global, like the donor's. */
export const MASTER_TEMPO_KEY = 'studio.masterTempo'
/** The ramp length. Its own key, like the donor's
 *  `djMode.masterTempoRampSeconds` — and app-global for the same reason the
 *  tempo is: how quickly your tempo moves is a property of how you work, not
 *  of the song you have open. */
export const RAMP_KEY = 'studio.masterTempoRamp'

/** The donor clamps its master tempo to 0…300 and the sync law carries its own
 *  ceilings; 20 is the floor the session BPM uses (`clampBPM`). A 0 typed here
 *  would park the deck rather than read as "no master", which is why the box
 *  has a floor at all. */
export const MASTER_TEMPO = { def: 120, min: 20, max: 300 } as const

/** The three modes, in the order the donor's switch shows them, with the label
 *  each one wears on the deck rows so the vocabulary is the same everywhere. */
const MODES: ReadonlyArray<{ id: StudioTempoMode; label: string; title: string }> = [
  { id: 'timeStretch', label: 'TS', title: 'TIME STRETCH — follow the master tempo, keep the pitch' },
  { id: 'timePitch', label: 'TP', title: 'TIME PITCH — varispeed: pitch moves with tempo, like a turntable' },
  { id: 'tempoOnly', label: 'T', title: 'TEMPO ONLY — move the trigger rate; the samples are untouched' },
]

export function MasterBar({ link, session }: { link: EngineLink | null; session: string | null }) {
  // A glide must not outlive the surface that started it: a timer still pushing
  // tempo after the face is gone would be writing to an engine nobody is
  // driving, the same shape as the clock's unmount stop.
  useEffect(() => stopGlide, [])
  const masterBpm = useMapStore((s) => s.map.transport.masterBpm)
  const element = useStudioElement()
  const [, setStored] = useSetting(link, MASTER_TEMPO_KEY, MASTER_TEMPO.def, asNumber)
  const [rampSec, setRampSec] = useSetting(link, RAMP_KEY, RAMP.def, asNumber)

  // ⚠️ THE GLIDE MODULE HELD THIS VALUE AND NOTHING EVER SET IT. `setTempoRamp`
  // shipped exported and uncalled, so the ramp was permanently the default and
  // the setting below could not have been honoured even if it existed — a verb
  // with no door, which is the same defect as a door with no verb (DESIGN.md
  // §7) and the one this session keeps finding. The stored value is pushed in
  // whenever it loads or changes, including on first mount.
  useEffect(() => setTempoRamp(rampSec), [rampSec])

  /** The precondition every control here shares — the same shape `Transport`
   *  uses, so an empty studio explains itself the same way twice. */
  const why = session ? null : 'no session — use “session ▾” to make or open one'

  /** What the deck ACTUALLY runs at once the law has resolved the master
   *  against the session's own tempo and the pulse relation. This is the second
   *  number the donor shows beside the session's, and it is the only honest
   *  answer to "is it working" — a master tempo that moves while this does not
   *  means the deck is not synced, which is a state rather than a bug. */
  const synced = element ? deckTempoIntent(element, masterBpm).syncedBpm : null

  const write = (bpm: number) => {
    const v = Math.round(Math.min(MASTER_TEMPO.max, Math.max(MASTER_TEMPO.min, bpm)))
    // THE TARGET goes in immediately — the box reads what you asked for, not
    // where the ramp has got to. `setMasterBpm` also pushes, which covers the
    // no-ramp case; the glide then rides from the OLD value toward the new one
    // and pushes on each tick (S3, the donor's motorised platter).
    const from = masterBpm
    setMasterBpm(v, link)
    setStored(v)
    glideToMaster(link, from)
  }

  return (
    <span className="studio-master" role="group" aria-label="master tempo">
      <DragBox
        id="studio/masterTempo"
        value={masterBpm}
        display={`${Math.round(masterBpm)}`}
        min={MASTER_TEMPO.min}
        max={MASTER_TEMPO.max}
        step={1}
        defaultValue={MASTER_TEMPO.def}
        disabled={!!why}
        title={why ?? 'MASTER — the tempo you want to hear; the session is stretched to it'}
        onChange={write}
      />
      <span className="ds-label mono dim">master</span>
      {/* RAMP — how long the tempo takes to arrive. 0 snaps (the behaviour
          before the glide existed), 5 s is a long tape stop. Seconds, because
          that is the unit the gesture is felt in. */}
      <DragBox
        id="studio/masterRamp"
        value={rampSec}
        display={rampSec <= 0.001 ? 'off' : `${rampSec.toFixed(2)}s`}
        min={RAMP.min}
        max={RAMP.max}
        step={0.05}
        defaultValue={RAMP.def}
        disabled={!!why}
        title={
          why ??
          'RAMP — how long the master tempo takes to arrive. 0 = snap; higher rides like a tape stop'
        }
        onChange={(v) => setRampSec(Math.round(v * 100) / 100)}
      />
      <span className="ds-label mono dim">ramp</span>
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className={element?.tempoMode === m.id ? 'studio-mode is-on mono' : 'studio-mode mono'}
          aria-pressed={element?.tempoMode === m.id}
          disabled={!!why}
          title={why ?? m.title}
          onClick={() => updateGridTempo(STUDIO_STRIP_KEY, link, { tempoMode: m.id })}
        >
          {m.label}
        </button>
      ))}
      {/* The resolved tempo, dim and last: something you GLANCE at to confirm,
          never something you reach for — the same role the plane's master gives
          its own synced readout. */}
      {synced !== null && (
        <span className="studio-synced mono dim" title="what the deck actually runs at">
          {`→ ${synced.toFixed(1)}`}
        </span>
      )}
    </span>
  )
}
