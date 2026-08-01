/**
 * THE PLUGIN'S ONE-STRIP MAP must be a REAL map.
 *
 * The deck rows write through `mapStore`, so a strip that merely looks right
 * would render fine and then throw the first time somebody pressed SYNC. The
 * only cheap way to know it is genuinely well-formed — without a browser, and
 * without eyes on the plugin — is to validate it against the same schema the
 * loader uses.
 *
 * It also pins the tempo pair, which is the thing the user actually asked for:
 * a session BPM and the effective BPM it runs at once the host's tempo is the
 * master.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { SCENE_LETTERS } from '../audio/sceneProjection.ts'
import { MapSchema } from '../persist/mapDocument.ts'
import { scenePadCount } from './GridElement.tsx'
import { deckTempoIntent } from '../persist/tempo.ts'
import { getMap, useMapStore } from '../state/mapStore.ts'
import {
  PLUGIN_STRIP_KEY,
  installPluginDeckMap,
  pluginStrip,
  pluginTempoInternal,
  setPluginMasterBpm,
  setPluginSession,
  setPluginTempoInternal,
  setPluginTypedMasterBpm,
} from './pluginDeckMap.ts'

const seed = {
  sessionId: 'Untitled',
  bpm: 120,
  syncToMaster: true,
  tempoMode: 'timeStretch' as const,
  hostBpm: 0,
}

describe('the plugin deck map', () => {
  it('installs a map the real schema accepts', () => {
    installPluginDeckMap(seed)
    // ⚠️ THE POINT. `.strict()` all the way down, so a missing `launchRef` or
    // a `pitchMode` of the wrong type fails HERE rather than under someone's
    // finger in Logic.
    expect(MapSchema.safeParse(getMap()).success).toBe(true)
    expect(getMap().strips).toHaveLength(1)
    expect(pluginStrip()?.key).toBe(PLUGIN_STRIP_KEY)
  })

  it('seeds the master tempo from the session until the host reports one', () => {
    installPluginDeckMap(seed)
    // hostBpm 0 = the DAW has not told us yet. Falling back to the session's
    // own tempo keeps the ratio at 1.0; seeding 0 would divide by zero in the
    // sync law and park the deck.
    expect(getMap().transport.masterBpm).toBe(120)
  })

  it('makes the HOST the master tempo', () => {
    installPluginDeckMap(seed)
    setPluginMasterBpm(140)
    expect(getMap().transport.masterBpm).toBe(140)

    const el = pluginStrip()?.element
    expect(el?.kind).toBe('grid')
    if (el?.kind !== 'grid') return

    // THE SECOND BPM VALUE. A 120 BPM session synced to a 140 BPM host runs at
    // 140 — that is what the header shows beside the session's own tempo, and
    // the ratio the engine is handed.
    const intent = deckTempoIntent(el, getMap().transport.masterBpm, 0)
    expect(intent.syncedBpm).toBeCloseTo(140, 3)
    expect(intent.syncRatio).toBeCloseTo(140 / 120, 5)
  })

  it('leaves a FREE deck at its own tempo whatever the host does', () => {
    installPluginDeckMap({ ...seed, syncToMaster: false })
    setPluginMasterBpm(140)
    const el = pluginStrip()?.element
    if (el?.kind !== 'grid') throw new Error('expected a grid element')
    // The law returns 1 for an unsynced deck — SENT, not omitted, so a deck
    // that was synced a moment ago does not keep carrying the old ratio.
    expect(deckTempoIntent(el, 140, 0).syncRatio).toBeCloseTo(1, 5)
  })

  it('reinstalls without losing the strip identity', () => {
    installPluginDeckMap(seed)
    const before = pluginStrip()
    installPluginDeckMap({ ...seed, sessionId: 'Another', bpm: 90 })
    const after = pluginStrip()
    // Same key: React keys off it, and a remount mid-set would drop the deck's
    // view state (and its cells) for a session change.
    expect(after?.key).toBe(before?.key)
    expect(after?.element.kind === 'grid' && after.element.bpm).toBe(90)
    expect(MapSchema.safeParse(getMap()).success).toBe(true)
  })

  it('repoints the session without disturbing the tempo axis', () => {
    installPluginDeckMap(seed)
    setPluginMasterBpm(150)
    setPluginSession('Third', 100)
    const el = pluginStrip()?.element
    if (el?.kind !== 'grid') throw new Error('expected a grid element')
    expect(el.sessionId).toBe('Third')
    expect(el.bpm).toBe(100)
    expect(el.syncToMaster).toBe(true) // survived
    expect(getMap().transport.masterBpm).toBe(150) // survived
  })

  it('is wide enough for ALL EIGHT scene pads', () => {
    installPluginDeckMap(seed)
    const strip = pluginStrip()
    if (!strip) throw new Error('expected a strip')
    // ⚠️ SILENT HALF-LOSS. `scenePadCount` returns 8 only at cell.w >= 300 and
    // 4 below it, so the plugin — which draws no plane and has no natural
    // width — would have shown scenes 1-4 and simply omitted 5-8, with nothing
    // on screen to say a pad was missing.
    expect(scenePadCount(strip.cell.w)).toBe(8)
    expect(SCENE_LETTERS).toHaveLength(8)
  })

  it('ignores a nonsense host tempo rather than parking the deck', () => {
    installPluginDeckMap(seed)
    setPluginMasterBpm(140)
    setPluginMasterBpm(0) // a DAW between states
    setPluginMasterBpm(-1)
    expect(getMap().transport.masterBpm).toBe(140)
  })
})

/**
 * THE MASTER TEMPO SOURCE (D-SL-DECKPLUGIN-02 · D2).
 *
 * Two switches, not one: `CLK HOST/INT` is the TRANSPORT axis and stays where it
 * was; this is the TEMPO axis. The gap it closes is that `masterBpm` was written
 * ONLY from the host, with no UI anywhere to type one — so `syncRatio` was
 * always ~1 and TP / TS / T were indistinguishable because there was nothing to
 * stretch against.
 */
describe('the master tempo source', () => {
  it('follows the host by default', () => {
    installPluginDeckMap(seed)
    expect(pluginTempoInternal()).toBe(false)
    setPluginMasterBpm(140)
    expect(getMap().transport.masterBpm).toBe(140)
  })

  it('REFUSES the host once the master is internal', () => {
    installPluginDeckMap(seed)
    setPluginMasterBpm(140)
    setPluginTempoInternal(true)
    setPluginTypedMasterBpm(96, null)
    expect(getMap().transport.masterBpm).toBe(96)

    // ⚠️ THE WHOLE POINT. `hostTransport` arrives at 40 Hz; without the gate it
    // would overwrite the typed value within one frame and the box would look
    // like it rejected everything the user entered.
    setPluginMasterBpm(140)
    setPluginMasterBpm(155)
    expect(getMap().transport.masterBpm).toBe(96)
  })

  it('hands the tempo back to the host when switched off', () => {
    installPluginDeckMap(seed)
    setPluginTempoInternal(true)
    setPluginTypedMasterBpm(96, null)
    setPluginTempoInternal(false)
    setPluginMasterBpm(140)
    expect(getMap().transport.masterBpm).toBe(140)
  })

  it('makes TP and TS distinguishable — the ratio finally leaves 1', () => {
    // A 120 BPM session under a 120 BPM host: ratio 1, and nothing to hear.
    installPluginDeckMap(seed)
    setPluginMasterBpm(120)
    const flat = pluginStrip()?.element
    if (flat?.kind !== 'grid') throw new Error('expected a grid element')
    expect(deckTempoIntent(flat, getMap().transport.masterBpm, 0).syncRatio).toBeCloseTo(1, 5)

    // Type 140 and the same session runs at 7/6 — now TP re-pitches and TS does not.
    setPluginTempoInternal(true)
    setPluginTypedMasterBpm(140, null)
    const el = pluginStrip()?.element
    if (el?.kind !== 'grid') throw new Error('expected a grid element')
    const intent = deckTempoIntent(el, getMap().transport.masterBpm, 0)
    expect(intent.syncRatio).toBeCloseTo(140 / 120, 5)
    expect(intent.syncedBpm).toBeCloseTo(140, 3)
  })

  it('clamps a typed tempo to a musical range instead of parking the deck', () => {
    installPluginDeckMap(seed)
    setPluginTempoInternal(true)
    setPluginTypedMasterBpm(0, null) // dividing by this is how a deck stops
    expect(getMap().transport.masterBpm).toBe(20)
    setPluginTypedMasterBpm(100000, null)
    expect(getMap().transport.masterBpm).toBe(400)
    setPluginTypedMasterBpm(Number.NaN, null) // an empty box mid-type
    expect(getMap().transport.masterBpm).toBe(400)
  })

  it('a fresh install follows the host again', () => {
    installPluginDeckMap(seed)
    setPluginTempoInternal(true)
    installPluginDeckMap(seed)
    // Otherwise a second editor would open with a stale internal master armed
    // and silently ignore the DAW.
    expect(pluginTempoInternal()).toBe(false)
  })
})

// Leave the store as the other suites expect to find it.
afterEach(() => {
  useMapStore.setState({ selectedKey: null, dirty: false })
})
