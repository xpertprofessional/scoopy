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
import type { Strip as StripDoc } from '../persist/mapDocument.ts'

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
  onSelectScene: (scene: SceneLetter, immediate: boolean) => void
  onSetBpm: (bpm: number) => void
  onToggleSync: () => void
  onCompose: () => void
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
  onSelectScene,
}: Pick<GridElementProps, 'strip' | 'scene' | 'queued' | 'onSelectScene'>) {
  if (strip.element.kind !== 'grid') return null
  const pads = SCENE_LETTERS.slice(0, scenePadCount(strip.cell.w))
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
            // gesture does not have to be learned twice.
            onClick={(e) => onSelectScene(s, e.metaKey || e.altKey)}
            title={
              s === scene
                ? `scene ${s} — playing`
                : `scene ${s} — click to schedule at the next cycle, ⌘-click to switch now`
            }
          >
            {s}
          </button>
        ))}
      </div>
    </>
  )
}

/** Sync · tempo · compose — the rate row's slot on a grid strip. */
export function GridControls({
  strip,
  onSetBpm,
  onToggleSync,
  onCompose,
}: Pick<GridElementProps, 'strip' | 'onSetBpm' | 'onToggleSync' | 'onCompose'>) {
  if (strip.element.kind !== 'grid') return null
  const g = strip.element
  return (
    <>
      <div className="ds-row strip-row strip-gridrow" data-no-drag>
        <button
          type="button"
          className={`strip-sync${g.syncToMaster ? ' active' : ''}`}
          onClick={onToggleSync}
          title={
            g.syncToMaster
              ? 'synced — this deck follows the plane’s master tempo'
              : 'free — this deck runs at its own tempo'
          }
        >
          {g.syncToMaster ? 'SYNC' : 'FREE'}
        </button>
        <label className="strip-bpm mono">
          <input
            type="number"
            min={20}
            max={300}
            step={0.1}
            value={g.bpm}
            aria-label="deck tempo"
            // Per-deck BPM isolation is a mission requirement, so this lives on
            // the STRIP and never on the transport: two decks at two tempos is
            // the normal case, not an exception.
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v) && v > 0) onSetBpm(v)
            }}
            title="this deck’s own tempo"
          />
          bpm
        </label>
        <button
          type="button"
          className="strip-compose"
          onClick={onCompose}
          title="open this session in the composer, in its own window"
        >
          COMPOSE ⇱
        </button>
      </div>
    </>
  )
}
