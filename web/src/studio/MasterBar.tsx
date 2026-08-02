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
import type { EngineLink } from '../engineLink.ts'
import { DragBox } from '../design/DragBox.tsx'
import { setMasterBpm, useMapStore } from '../state/mapStore.ts'
import { updateGridTempo } from '../state/mapStore.ts'
import { deckTempoIntent } from '../persist/tempo.ts'
import { asNumber, useSetting } from '../useSetting.ts'
import { STUDIO_STRIP_KEY, useStudioElement, type StudioTempoMode } from './studioMap.ts'

/** App-global, like the donor's. */
export const MASTER_TEMPO_KEY = 'studio.masterTempo'

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
  const masterBpm = useMapStore((s) => s.map.transport.masterBpm)
  const element = useStudioElement()
  const [, setStored] = useSetting(link, MASTER_TEMPO_KEY, MASTER_TEMPO.def, asNumber)

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
    // The store first (it runs applyTempo, which is what reaches the engine),
    // then the setting. A setting that saved without pushing would be a tempo
    // that is remembered and never heard.
    setMasterBpm(v, link)
    setStored(v)
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
