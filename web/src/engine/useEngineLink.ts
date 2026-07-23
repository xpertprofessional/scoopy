import { useEffect, useState } from 'react'
import { DECK_BLOCK_FIELDS, HOT_FRAME_SCALARS, deckFieldIndex } from '../../protocol/schema'
import { publishHotFrame } from '../hotsurface/hotSurface'
import { useAppStore } from '../store/appStore'
import { createEngineLink, fetchCapabilities, type EngineLink } from './engineLink'

const ENGINE_TIME_INDEX = HOT_FRAME_SCALARS.indexOf('engineTimeSamples')
const FEEDBACK_INDEX = HOT_FRAME_SCALARS.indexOf('feedbackAlarm')

/**
 * Boots the transport once on mount: runs the capabilities + device handshake
 * and subscribes to hot frames. Returns the link (or null when no shell is
 * present, e.g. plain browser / dev) so components can issue commands. When
 * absent the status resolves to 'no-engine' rather than pretending.
 *
 * HotFrame policy (P1-metering): meters and playheads go to the HotSurface
 * registry ONLY — never through React state. The store mirrors just the
 * rare-change values (engine clock display, feedbackAlarm, deck states).
 */
export function useEngineLink(): EngineLink | null {
  const [link, setLink] = useState<EngineLink | null>(null)

  useEffect(() => {
    const store = useAppStore.getState()
    const created = createEngineLink()
    setLink(created)
    if (!created) {
      store.setShellStatus('no-engine')
      return
    }

    let cancelled = false
    store.setShellStatus('connecting')

    fetchCapabilities(created)
      .then((caps) => {
        if (cancelled) return
        store.setCapabilities(caps)
        store.setShellStatus('connected')
        return created.command('getDeviceInfo', {})
      })
      .then((info) => {
        if (!cancelled && info) store.setDeviceInfo(info)
      })
      .catch(() => {
        if (!cancelled) store.setShellStatus('no-engine')
      })

    let lastDeckStates = ''
    const off = created.onHotFrame((frame) => {
      publishHotFrame(frame) // hot surfaces (meters, playheads) read this imperatively
      const s = useAppStore.getState()
      if (ENGINE_TIME_INDEX >= 0 && frame.length > ENGINE_TIME_INDEX)
        s.setEngineTimeSamples(frame[ENGINE_TIME_INDEX]!)
      // Booleans/enums change rarely; guarded so zustand only updates on change.
      if (FEEDBACK_INDEX >= 0 && frame.length > FEEDBACK_INDEX)
        s.setFeedbackAlarm(frame[FEEDBACK_INDEX] === 1)
      const { channels, decks } = s.patch
      if (decks.length > 0) {
        const states: number[] = []
        for (let d = 0; d < decks.length; d++) {
          const idx = deckFieldIndex(channels.length, d, DECK_BLOCK_FIELDS[0]!)
          states.push(frame.length > idx ? frame[idx]! : 0)
        }
        const key = states.join(',')
        if (key !== lastDeckStates) {
          lastDeckStates = key
          s.setDeckStates(states)
        }
      }
    })

    return () => {
      cancelled = true
      off()
    }
  }, [])

  return link
}
