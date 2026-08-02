/**
 * STUDIO'S ONE-STRIP MAP — the tempo authority for a mapless face (S3).
 *
 * WHY A MAP AT ALL, when D-SL-STUDIO-01 froze the plane. Because the map
 * document is not the plane SURFACE: it is the document the tempo law reads.
 * `applyTempo` walks the map's grid strips and pushes each one's resolved
 * intent, so a face with no strip reaches the engine with nothing, however
 * correct its arithmetic. `pluginDeckMap.ts` met this first and its header
 * makes the argument this one inherits — the rows already model "a deck
 * following a MASTER tempo", and `transport.masterBpm` IS that master.
 *
 * The alternative is worse and is forbidden by name: `persist/tempo.ts` says
 * *"there is no tempo MATH here and there must not be; the moment there is,
 * there are two laws."* A parallel authority for Studio would be that second
 * law, and it would disagree with the plugin's in exactly the cases that are
 * hard to hear.
 *
 * HOW STUDIO DIFFERS FROM THE PLUGIN. A plugin sits in someone else's
 * arrangement, so the DAW is normally the master and typing a tempo is the
 * exception (`pluginTempoInternal`). Studio has no host: the master is ALWAYS
 * the user's number, so there is no source switch here at all — one axis fewer,
 * because there is genuinely one fewer thing.
 *
 * ⚠️ NEVER SAVED, and that is deliberate rather than unfinished. `attachAutosave`
 * belongs to `PlanePanel`; nothing here writes a `.scoopyMap` into the library.
 * The master tempo persists as a SETTING instead (`MasterBar`), which is also
 * what the donor does — `djMode.masterTempo` is app-global in UserDefaults, not
 * session state. The strip is scaffolding for the law; the tempo is the datum.
 */
import { emptyMap, type PlaneMap, type Strip } from '../persist/mapDocument.ts'
import { getMap, setMap, useMapStore } from '../state/mapStore.ts'

/** One strip, one deck, addressed by name for the same reason the plugin's is:
    it is created once per face and every write finds it again by key. */
export const STUDIO_STRIP_KEY = 'studio-deck'
export const STUDIO_DECK = 0

/** The grid element's tempo-mode vocabulary — resolved into the engine's 0/1/2
    by `persist/tempo.ts`, never here. */
export type StudioTempoMode = 'timePitch' | 'timeStretch' | 'tempoOnly'

export interface StudioDeckSeed {
  sessionId: string
  /** The SESSION's own tempo — the denominator of the sync ratio. */
  bpm: number
  /** The MASTER tempo — what the session is stretched toward. */
  masterBpm: number
  syncToMaster: boolean
  tempoMode: StudioTempoMode
}

/**
 * Build (or rebuild) Studio's one-strip map. Idempotent: called again with a
 * new session it replaces the ELEMENT and keeps the strip, so switching
 * sessions does not reset level, sends or drive under the user.
 */
export function installStudioMap(seed: StudioDeckSeed): void {
  const base: PlaneMap = emptyMap()
  const existing = getMap().strips.find((s) => s.key === STUDIO_STRIP_KEY)

  const strip: Strip = {
    ...(existing ?? {
      key: STUDIO_STRIP_KEY,
      name: 'STUDIO',
      // Studio draws no plane, so this geometry is never rendered — but it is
      // not free to get wrong: `scenePadCount(cell.w)` shows all eight scene
      // pads at >= 300 and only four below, so a token width would silently
      // halve the scenes anywhere a shared component consults it.
      cell: { x: 0, y: 0, w: 340, h: 196 },
      channel: 0,
      level: 1,
      mute: false,
      sends: [0, 0, 0, 0],
      drive: { curve: 0, amount: 1 },
      recordArm: false,
      monitor: false,
      recordTap: null,
      sessionPerf: {},
      element: { kind: 'none' },
    }),
    key: STUDIO_STRIP_KEY,
    element: {
      kind: 'grid',
      deck: STUDIO_DECK,
      sessionId: seed.sessionId,
      bpm: seed.bpm,
      syncToMaster: seed.syncToMaster,
      tempoMode: seed.tempoMode,
      pulseRelation: 'auto',
      pitchMode: false,
      transpose: 0,
      // 'auto' rather than a strip key: there is one strip, so naming it would
      // make this deck wait on its own grid.
      launchRef: 'auto',
    },
  }

  setMap({
    ...base,
    strips: [strip],
    transport: {
      ...base.transport,
      masterBpm: seed.masterBpm > 0 ? seed.masterBpm : seed.bpm,
    },
  })
}

/** Studio's strip, or null before a session is open. Read-only — every write
    goes through `mapStore` so `applyTempo` runs. */
export function studioStrip(): Strip | null {
  return getMap().strips.find((s) => s.key === STUDIO_STRIP_KEY) ?? null
}

/** Subscribe-friendly selector for the one grid element Studio owns. */
export function useStudioElement() {
  return useMapStore((s) => {
    const strip = s.map.strips.find((x) => x.key === STUDIO_STRIP_KEY)
    return strip?.element.kind === 'grid' ? strip.element : null
  })
}
