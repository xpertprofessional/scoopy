import { create } from 'zustand'
import type { Capabilities } from '../../protocol/schema'

// 'disconnected' until the EngineLink handshake (getCapabilities) succeeds;
// 'no-engine' when no JUCE shell is present (plain browser / dev).
export type ShellStatus = 'disconnected' | 'connecting' | 'connected' | 'no-engine'

interface AppState {
  shellStatus: ShellStatus
  capabilities: Capabilities | null
  /** Mirrored from HotFrame slot 1 — the free-running engine sample clock. */
  engineTimeSamples: number
  /** Mirrored from HotFrame 'feedbackAlarm' — the watchdog lamp (P4). */
  feedbackAlarm: boolean
  /** Mirrored from HotFrame main-bus peaks (linear amplitude), L / R. */
  mainPeakL: number
  mainPeakR: number
  setShellStatus: (s: ShellStatus) => void
  setCapabilities: (c: Capabilities) => void
  setEngineTimeSamples: (n: number) => void
  setFeedbackAlarm: (a: boolean) => void
  setMainPeaks: (l: number, r: number) => void
}

// The Patch document (channels, buses, decks, sends, output map, UI mode) is
// added to this store as the mixer slice is built in P1; P0 holds only the
// shell-handshake + live-clock state so the walking skeleton has something real
// to display.
export const useAppStore = create<AppState>((set) => ({
  shellStatus: 'disconnected',
  capabilities: null,
  engineTimeSamples: 0,
  feedbackAlarm: false,
  mainPeakL: 0,
  mainPeakR: 0,
  setShellStatus: (shellStatus) => set({ shellStatus }),
  setCapabilities: (capabilities) => set({ capabilities }),
  setEngineTimeSamples: (engineTimeSamples) => set({ engineTimeSamples }),
  setFeedbackAlarm: (feedbackAlarm) => set({ feedbackAlarm }),
  setMainPeaks: (mainPeakL, mainPeakR) => set({ mainPeakL, mainPeakR }),
}))
