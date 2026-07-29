/**
 * The GRID element inside a strip (merge P2 step 4, increment 3).
 *
 * A scoopy session, hosted on the plane's uniform channel. What it shows is
 * decided by pd-strip-anatomy §3.1's test — *would you do this one-handed, with
 * sound running, without reading?*:
 *
 *   ON THE STRIP   scene pads · bpm · sync · COMPOSE
 *   NOT ON IT      anything that edits the session's CONTENT
 *
 * ⚠️ NO SESSION PARAMETER IS EXPOSED HERE, DELIBERATELY. With scoopy's SCN latch
 * off, an edit is GLOBAL to the session — so a knob touched from the map would
 * bleed into every other map using that session, silently. P2-STATUS calls that
 * the sharper of the two hazards and says to settle where map-originated
 * session edits land BEFORE exposing any such control. Scoping this element to
 * the PERFORMANCE layer (which scene, how it launches, tempo) closes the hazard
 * by construction rather than by remembering.
 *
 * The scene pads therefore drive `companionEngine.selectScene`, not an engine
 * call: `sl_deck_*` has no scene entry point at all, because a scene is a
 * projection of the DOCUMENT. Selecting one re-projects and republishes the
 * world — which is also why every selection trips the tempo-sync re-apply.
 */
import { SCENE_LETTERS, type SceneLetter } from '../audio/sceneProjection.ts'
import { sceneDisplayLabel } from '../state/scenesStore.ts'
import type { Strip as StripDoc } from '../persist/mapDocument.ts'
import type { DJTempoMode } from '../panels/djMix.ts'
import { deckTempoIntent, formatSyncedBpm } from '../persist/tempo.ts'

export type GridElementProps = {
  strip: StripDoc
  /** The scene actually running, from the session store — not from the map.
      The map REMEMBERS a scene per (strip, session); the engine is what is
      playing one, and those differ the moment anything else selects. */
  scene: SceneLetter
  /** A scene armed for the next cycle boundary, if any. Shown because a pad
      that looks unpressed for two bars after you pressed it reads as a dead
      control. */
  queued: SceneLetter | null
  /** The plane's master, so a synced strip can show what it will ACTUALLY run
      at. Passed in rather than read from the store here: this component is
      rendered per strip and a store read per strip is a subscription per strip
      to a value that is the same for all of them. */
  masterBpm: number
  /** The session's enabled scene row (a prefix of A…H, `enabledScenes(pattern)`).
      The pads render THESE, not a fixed eight: a 3-scene session showing five
      dead pads was the P3-U8 defect. Defaults to all eight for a strip whose
      session has not arrived yet. */
  enabledScenes?: readonly SceneLetter[]
  /** Enable one more scene (`setEnabledSceneCount(count+1)`) — the pad row's
      `+`, matching the app's own add slot. Absent = the affordance is not
      wired (SSR tests, older callers) and the pad renders disabled. */
  onAddScene?: () => void
  onSelectScene: (scene: SceneLetter, immediate: boolean) => void
  onSetBpm: (bpm: number) => void
  onToggleSync: () => void
  onCycleTempoMode: () => void
  onCompose: () => void
}

/** The mode's three-character face. Abbreviated because it sits in an 18 px row
    next to a number box, and because these are the words the panel this came
    from uses: T+P is scoopy's own label for time-and-pitch. */
export const TEMPO_MODE_LABEL: Record<DJTempoMode, string> = {
  timePitch: 'T+P',
  timeStretch: 'STR',
  tempoOnly: 'TMP',
}

const TEMPO_MODE_TITLE: Record<DJTempoMode, string> = {
  timePitch: 'time + pitch — varispeed, like a turntable: tempo and pitch move together',
  timeStretch: 'stretch — follows the master tempo with the pitch left where it is',
  tempoOnly: 'tempo only — the step clock alone; each sample plays exactly as recorded',
}

/** The cycle order the button walks. STRETCH first because it is the default
    and the one most material wants; TMP last because it is the specialist. */
const TEMPO_MODE_CYCLE: DJTempoMode[] = ['timeStretch', 'timePitch', 'tempoOnly']

export function nextTempoMode(mode: DJTempoMode): DJTempoMode {
  const i = TEMPO_MODE_CYCLE.indexOf(mode)
  return TEMPO_MODE_CYCLE[(i + 1) % TEMPO_MODE_CYCLE.length]!
}

/** How many scene pads fit the strip's width without the row reflowing. All
    eight at 340 px; the count is a pure function of the box, like every other
    piece of strip geometry (layout law L5). */
export function scenePadCount(cellW: number): number {
  return cellW >= 300 ? SCENE_LETTERS.length : 4
}

/**
 * The scene pads, occupying the WAVE FIELD's rect.
 *
 * Split from the row below so each lands in the slot the pixel budget reserved
 * for it: the pads take the wave field's 48 px, the controls take the rate
 * row's 18. Returning both from one component put them both in the wave row and
 * pushed the box over its 196 — which `browser_plane_test` would have caught,
 * and did.
 */
export function GridScenes({
  strip,
  scene,
  queued,
  enabledScenes: enabled = SCENE_LETTERS,
  onAddScene,
  onSelectScene,
}: Pick<
  GridElementProps,
  'strip' | 'scene' | 'queued' | 'enabledScenes' | 'onAddScene' | 'onSelectScene'
>) {
  if (strip.element.kind !== 'grid') return null
  // The row's width cap is geometry (L5); the SESSION decides the count within
  // it. Letters remain the storage/type identity end to end — only the FACE is
  // 1-based, exactly the app's own rule (native displayLabel, ScenePads).
  const cap = scenePadCount(strip.cell.w)
  const pads = enabled.slice(0, cap)
  // Room in the row ⇒ the set is not full (cap ≤ 8), so an add pad shown is an
  // add pad that works; at 8-of-8 the row is full of real pads and the slot is
  // simply occupied — the honest full state.
  const room = pads.length < cap
  return (
    <>
      {/* The scene row occupies the WAVE FIELD's rect — same box, same height,
          different fill. A grid strip and a tape strip are the same object with
          different material, which is the whole "one species" claim; a grid
          strip that was a different SIZE would break it on sight. */}
      <div className="strip-scenes" role="group" aria-label="scenes" data-no-drag>
        {pads.map((s) => (
          <button
            key={s}
            type="button"
            className={`strip-pad${s === scene ? ' active' : ''}${s === queued ? ' queued' : ''}`}
            // ⌘-click launches NOW; a plain click schedules at the next cycle
            // boundary. The modifier is the same one the desktop uses, so the
            // gesture does not have to be learned twice. (The desktop's ⇧=queue
            // is deliberately NOT mapped: here a plain click already IS the
            // queued switch — a second modifier saying the same thing would be
            // a fake distinction.)
            onClick={(e) => onSelectScene(s, e.metaKey || e.altKey)}
            title={
              s === scene
                ? `scene ${sceneDisplayLabel(s)} — playing`
                : `scene ${sceneDisplayLabel(s)} — click to schedule at the next cycle, ⌘-click to switch now`
            }
          >
            {sceneDisplayLabel(s)}
          </button>
        ))}
        {/* The add slot, the app's own gesture (ScenePads): labeled with the
            number it would become. Rendered whenever the row has room — fill,
            not presence (L2) — and disabled when the affordance is not wired. */}
        {room && (
          <button
            type="button"
            className="strip-pad strip-pad-add"
            disabled={!onAddScene}
            onClick={() => onAddScene?.()}
            title={`enable scene ${enabled.length + 1} — a new empty snapshot of this pattern`}
          >
            {`+${enabled.length + 1}`}
          </button>
        )}
      </div>
    </>
  )
}

/**
 * Sync · mode · tempo · compose — the rate row's slot on a grid strip.
 *
 * THE MODE BUTTON IS THE PER-ELEMENT HALF OF THE TEMPO DOMAIN. The master sets
 * the tempo; this says what following it COSTS — pitch or nothing. It is on the
 * object rather than in the Inspector because it passes §3.1's test: you change
 * it one-handed, with sound running, and you hear the answer immediately.
 *
 * The pulse relation and the transpose do NOT pass that test — they are set
 * once and then lived with — so they are in the Inspector, where there is room
 * to label them.
 */
export function GridControls({
  strip,
  locked = false,
  masterBpm,
  nudgeBpm = 0,
  onSetBpm,
  onToggleSync,
  onCycleTempoMode,
  onCompose,
}: Pick<
  GridElementProps,
  'strip' | 'masterBpm' | 'onSetBpm' | 'onToggleSync' | 'onCycleTempoMode' | 'onCompose'
> & {
  /** P3-C2: a compose window owns this deck — tempo/sync/compose lock with the
      reason in the title until it closes (one publisher at a time). */
  locked?: boolean
  /** P3-D4-2: the TRANSIENT hold-to-bend delta — folded into the law so the
      synced readout shows what the deck is running at UNDER the hand. */
  nudgeBpm?: number
}) {
  if (strip.element.kind !== 'grid') return null
  const g = strip.element
  const intent = deckTempoIntent(g, masterBpm, nudgeBpm)
  const LOCKED_TITLE = 'editing in the compose window ⇱ — close it to change this here'
  return (
    <>
      <div className="ds-row strip-row strip-gridrow" data-no-drag>
        <button
          type="button"
          className={`strip-sync${g.syncToMaster ? ' active' : ''}`}
          disabled={locked}
          onClick={onToggleSync}
          title={
            locked
              ? LOCKED_TITLE
              : g.syncToMaster
                ? // WHAT IT WILL ACTUALLY RUN AT, not what was asked for. `auto`
                  // can resolve a 70 BPM deck under a 140 master to 1:2, and a
                  // sync control that does not say so is one you have to test by
                  // ear before you trust it.
                  `synced at ${intent.pulse} — this deck runs at ${formatSyncedBpm(intent)} BPM against the plane’s master`
                : 'free — this deck runs at its own tempo'
          }
        >
          {g.syncToMaster ? 'SYNC' : 'FREE'}
        </button>
        <button
          type="button"
          className={`strip-tempomode${g.syncToMaster ? ' active' : ''}`}
          disabled={locked}
          onClick={onCycleTempoMode}
          aria-label="tempo mode"
          title={locked ? LOCKED_TITLE : TEMPO_MODE_TITLE[g.tempoMode]}
        >
          {TEMPO_MODE_LABEL[g.tempoMode]}
        </button>
        <label className="strip-bpm mono">
          <input
            type="number"
            min={20}
            max={300}
            step={0.1}
            value={g.bpm}
            aria-label="deck tempo"
            disabled={locked}
            // Per-deck BPM isolation is a mission requirement, so this lives on
            // the STRIP and never on the transport: two decks at two tempos is
            // the normal case, not an exception.
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v) && v > 0) onSetBpm(v)
            }}
            // Its OWN tempo, which stays the truth while synced — sync stretches
            // the deck, it does not rewrite the session.
            title={
              locked
                ? LOCKED_TITLE
                : g.syncToMaster
                  ? `this deck’s own tempo — synced, it runs at ${formatSyncedBpm(intent)}`
                  : 'this deck’s own tempo'
            }
          />
          bpm
        </label>
        <button
          type="button"
          className="strip-compose"
          onClick={onCompose}
          title={
            locked
              ? 'its compose window is already open — close it to hand the deck back'
              : 'open this session in the composer, in its own window'
          }
        >
          COMPOSE ⇱
        </button>
      </div>
    </>
  )
}
