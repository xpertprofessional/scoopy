/**
 * THE MIDI CLOCK'S DOOR — what actually starts it (S9).
 *
 * ⚠️ THE LANE SHIPPED WITH NO CALLER, and this closes that. `host/MidiClockOut`
 * and the `midiClock` command were built, tested and reachable by protocol, and
 * nothing invoked them — so a user could not start the clock at all. That is
 * the fourth of the four rules failing (`tests pass ≠ it works ≠ it shipped ≠
 * you can reach it`), and it is recorded against S9-MIDI in the ledger because
 * a commit message of mine claimed the app "can now drive an external
 * sequencer" while this was missing.
 *
 * A HOOK THAT WATCHES STATE, not two calls bolted onto the buttons. `Transport`
 * has four verbs and `MasterBar` writes the tempo; wiring the clock into each
 * would be five call sites that must agree forever, and the first one somebody
 * forgets is a clock that keeps ticking after the deck stops. Watching
 * `playing` and `masterBpm` instead means the clock cannot disagree with the
 * transport, because it is derived from it.
 *
 * IT DOES NOT ASK WHETHER MIDI IS SET UP, deliberately. The shell already knows:
 * with no `clockOutput` role selected, `midiClock` opens nothing, `start()`
 * returns early and the reply says `open: false`. Duplicating that decision here
 * would mean two places deciding when the clock may run, and they would drift.
 * The web says what the transport did; the shell decides whether there is
 * anywhere to send it.
 */
import { useEffect, useRef } from 'react'

import type { EngineLink } from '../engineLink.ts'
import { useCompanion } from '../store/companionEngine.ts'
import { useMapStore } from '../state/mapStore.ts'

export function useMidiClock(link: EngineLink | null, deck: number) {
  const playing = useCompanion((c) => c.decks[deck]?.playing ?? false)
  /** THE STORE'S master tempo, not the persisted setting — this is the number
   *  `applyTempo` resolves against, so the clock and the engine are stretching
   *  to the same one. The setting is where it is REMEMBERED; the store is what
   *  is currently true, and those differ for as long as a write is in flight. */
  const masterBpm = useMapStore((s) => s.map.transport.masterBpm)
  /** What the clock was last told, so a re-render cannot re-send it. */
  const sent = useRef<{ playing: boolean; bpm: number } | null>(null)

  useEffect(() => {
    if (!link) return
    const last = sent.current
    // FIRST RUN WITH THE TRANSPORT STOPPED SENDS NOTHING. A `stop` on mount
    // would be a command issued because a window opened, which is not a thing
    // the user did — and on a second Studio window it would stop the clock the
    // first one is running.
    if (last === null && !playing) {
      sent.current = { playing, bpm: masterBpm }
      return
    }

    if (last === null || last.playing !== playing) {
      // `start` rather than `continue`: the deck restarts at step 0 (the store's
      // `play()` says so), so the phrase begins again and the receiving
      // sequencer must too. CONTINUE would leave it a bar into a pattern that
      // just went back to the top.
      void link
        .command('midiClock' as never, playing ? { op: 'start', bpm: masterBpm } : { op: 'stop' })
        .catch(() => {})
    } else if (playing && last.bpm !== masterBpm) {
      // Tempo only matters to a RUNNING clock — the lane treats it as inert
      // when stopped, on purpose, because a tempo edit is a preference and not
      // a transport command.
      void link.command('midiClock' as never, { op: 'tempo', bpm: masterBpm }).catch(() => {})
    }
    sent.current = { playing, bpm: masterBpm }
  }, [link, playing, masterBpm])

  // NOTHING KEEPS TICKING AFTER THE WINDOW GOES. Closing Studio with the clock
  // running would leave an external sequencer playing to a device nobody is
  // driving any more — the transport equivalent of the hanging note
  // `MidiNoteOut` guards against.
  useEffect(() => {
    if (!link) return
    return () => {
      if (sent.current?.playing) void link.command('midiClock' as never, { op: 'stop' }).catch(() => {})
    }
  }, [link])
}
