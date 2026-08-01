/**
 * THE PLUGIN'S ONE-STRIP MAP (D-SL-DECKPLUGIN-01).
 *
 * The deck rows — SYNC · pulse · TR · TP · WIN · BR · the transport glyphs —
 * are written against a `Strip` and they WRITE BACK through `mapStore`
 * (`updateGridTempo` → `updateStrip`). So mounting them needs a real map, not
 * a hand-rolled object that looks like one: a fake would render and then throw
 * the first time anyone touched a control, which is worse than not mounting.
 *
 * A plugin has no plane and shows no map UI, so this is an implementation
 * detail — ONE strip, on deck 0, never saved. `attachAutosave` is the plane's
 * alone (PlanePanel), so nothing here writes a `.scoopyMap` to the user's
 * library.
 *
 * WHY A MAP IS THE RIGHT SHAPE ANYWAY, rather than a shortcut worth apologising
 * for: the rows already model "a deck following a MASTER tempo", and the map's
 * `transport.masterBpm` is that master. A plugin is the same arrangement with
 * the DAW in the master's chair — so substituting the host tempo there makes
 * every existing sync path work unchanged, including `deckTempoIntent`'s
 * `syncedBpm` (the effective tempo the deck actually runs at, which is the
 * second BPM value the desktop shows beside the session's own).
 */
import { emptyMap, type PlaneMap, type Strip } from '../persist/mapDocument.ts'
import { getMap, setMap, updateStrip, useMapStore } from '../state/mapStore.ts'

/** The plugin's single strip has a FIXED key: it is created once per editor
    and every write addresses it by name, so a generated id would only be a way
    to lose track of it. */
export const PLUGIN_STRIP_KEY = 'plugin-deck'
export const PLUGIN_DECK = 0

/** The grid element's own tempo-mode vocabulary — TP / TS / T on the sync row,
    resolved into the engine's 0/1/2 by `persist/tempo.ts`. */
export type PluginTempoMode = 'timePitch' | 'timeStretch' | 'tempoOnly'

export interface PluginDeckSeed {
  sessionId: string
  /** The session's own tempo — the denominator of the sync ratio. */
  bpm: number
  syncToMaster: boolean
  tempoMode: PluginTempoMode
  hostBpm: number
}

/** Build (or rebuild) the one-strip map. Idempotent: called again with a new
    session it replaces the element without disturbing the rest. */
export function installPluginDeckMap(seed: PluginDeckSeed): void {
  const base: PlaneMap = emptyMap()
  const existing = getMap().strips.find((s) => s.key === PLUGIN_STRIP_KEY)

  const strip: Strip = {
    ...(existing ?? {
      key: PLUGIN_STRIP_KEY,
      name: 'DECK',
      // ⚠️ THE WIDTH IS LOAD-BEARING, even though the plugin draws no plane.
      // `scenePadCount(cell.w)` renders all EIGHT scene pads at >= 300 and only
      // FOUR below it (GridElement.tsx) — a 1-wide cell would silently hide
      // half the scenes. 340 is the width the plane uses for a full pad row.
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
    key: PLUGIN_STRIP_KEY,
    element: {
      kind: 'grid',
      deck: PLUGIN_DECK,
      sessionId: seed.sessionId,
      bpm: seed.bpm,
      syncToMaster: seed.syncToMaster,
      tempoMode: seed.tempoMode,
      // Defaults that match a fresh deck; the rows own them from here.
      pulseRelation: 'auto',
      pitchMode: false,
      transpose: 0,
      // 'auto' rather than a strip key: there is only ever ONE strip here, so
      // naming it would make this deck wait on its own grid.
      launchRef: 'auto',
    },
  }

  setMap({
    ...base,
    strips: [strip],
    transport: { ...base.transport, masterBpm: seed.hostBpm > 0 ? seed.hostBpm : seed.bpm },
  })
}

/** THE HOST IS THE MASTER. Called whenever the DAW's tempo changes, so a
    synced deck's ratio is recomputed against it by the ordinary path. */
export function setPluginMasterBpm(hostBpm: number): void {
  if (!(hostBpm > 0)) return
  const map = getMap()
  if (Math.abs(map.transport.masterBpm - hostBpm) < 1e-6) return
  useMapStore.setState({
    map: { ...map, transport: { ...map.transport, masterBpm: hostBpm } },
  })
}

/** The strip the rows render, or null before the map is installed. */
export function pluginStrip(): Strip | null {
  return getMap().strips.find((s) => s.key === PLUGIN_STRIP_KEY) ?? null
}

/** Keep the strip's session id pointed at whatever is actually open. */
export function setPluginSession(sessionId: string, bpm: number): void {
  updateStrip(PLUGIN_STRIP_KEY, (s) =>
    s.element.kind === 'grid'
      ? { ...s, element: { ...s.element, sessionId, bpm } }
      : s,
  )
}
