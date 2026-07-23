import { useEffect, useState } from 'react'
import { HOT_FRAME_SCALARS } from '../../protocol/schema'
import { publishHotFrame } from '../hotsurface/hotSurface'
import { useAppStore } from '../store/appStore'
import { createEngineLink, fetchCapabilities, type EngineLink } from './engineLink'

const ENGINE_TIME_INDEX = HOT_FRAME_SCALARS.indexOf('engineTimeSamples')
const FEEDBACK_INDEX = HOT_FRAME_SCALARS.indexOf('feedbackAlarm')

/**
 * Boots the transport once on mount: runs the capabilities handshake and
 * subscribes to hot frames. Returns the link (or null when no shell is present,
 * e.g. plain browser / dev) so components can issue commands. When absent the
 * status resolves to 'no-engine' rather than pretending to be connected.
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
      })
      .catch(() => {
        if (!cancelled) store.setShellStatus('no-engine')
      })

    const off = created.onHotFrame((frame) => {
      publishHotFrame(frame) // hot surfaces (meters, playheads) read this imperatively
      if (ENGINE_TIME_INDEX >= 0 && frame.length > ENGINE_TIME_INDEX)
        store.setEngineTimeSamples(frame[ENGINE_TIME_INDEX]!)
      // Boolean changes rarely; zustand subscribers only re-render on change.
      if (FEEDBACK_INDEX >= 0 && frame.length > FEEDBACK_INDEX)
        store.setFeedbackAlarm(frame[FEEDBACK_INDEX] === 1)
    })

    return () => {
      cancelled = true
      off()
    }
  }, [])

  return link
}
