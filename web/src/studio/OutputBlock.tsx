/**
 * OUTPUT — where the main mix and the four sends physically leave (S5).
 *
 * ⚠️ THE ROUTING HAD NO DOOR. `setDeckOutputChannels` and `setSendOutputChannel`
 * are answered by the shell and routed by `MergedLink`, on top of
 * `host/OutputMap` — and nothing called them, so no user could move an output.
 * That is the fourth of the four rules, and this session has closed the same
 * gap on the transport and on the MIDI clock already.
 *
 * ⚠️ IT ONLY OFFERS PAIRS THE HARDWARE HAS. `slDevices/list` now reports
 * `outputChannelCount`, and the picker is built from it — the donor gates its
 * own on exactly this ("publish only when outputChannelCount > 2"). A picker
 * offering 3/4 on a two-channel interface is a control that reaches nothing,
 * which is the defect class this whole block exists to stop repeating.
 *
 * WHY SENDS ARE SINGLE CHANNELS AND MAIN IS A PAIR. Not a UI choice — the
 * engine's own layout. `sl_engine.cpp` warns that the four send lanes are
 * consecutive MONO lanes and that treating them as stereo pairs is how a
 * reorder routes a channel's right side into the next send. So the send row
 * picks ONE channel and the main row picks TWO, because that is what they are.
 */
import { useEffect, useState } from 'react'

import type { EngineLink } from '../engineLink.ts'
import { Select } from '../design/controls.tsx'

/** Deck A's lanes are the Studio deck's — one engine, one deck (D-SL-STUDIO-01). */
const DECK = 'A' as const

export function OutputBlock({ link, session }: { link: EngineLink | null; session: string | null }) {
  const [channelCount, setChannelCount] = useState(0)
  /** null = Main (the summed program). A number = the FIRST channel of a pair. */
  const [mainPair, setMainPair] = useState<number | null>(null)
  const [sendCh, setSendCh] = useState<[number, number, number, number]>([-1, -1, -1, -1])

  useEffect(() => {
    if (!link) return
    void link
      .command('slDevices', { action: 'list' })
      .then((r) => setChannelCount((r as { outputChannelCount?: number })?.outputChannelCount ?? 0))
      .catch(() => {})
  }, [link])

  /** Every stereo pair the device actually has: 1/2, 3/4, … */
  const pairs = Array.from({ length: Math.floor(channelCount / 2) }, (_v, i) => i * 2)

  const why = !session
    ? 'no session — use “session ▾” to make or open one'
    : channelCount <= 2
      ? 'this output device has only one stereo pair — nothing to route to'
      : null

  const setMain = (first: number | null) => {
    setMainPair(first)
    // NULL is "Main": the deck stays in the summed program and its own lanes go
    // nowhere. Sending both would be the same audio twice.
    void link
      ?.command('setDeckOutputChannels', {
        deck: DECK,
        channels: first === null ? null : [first, first + 1],
      })
      .catch(() => {})
  }

  const setSend = (i: number, ch: number) => {
    setSendCh((prev) => {
      const next = [...prev] as typeof prev
      next[i] = ch
      return next
    })
    void link?.command('setSendOutputChannel', { sendIndex: i + 1, channel: ch }).catch(() => {})
  }

  return (
    <span className="studio-output" role="group" aria-label="output routing">
      <span className="ds-label mono dim">out</span>
      <Select
        value={mainPair === null ? 'main' : String(mainPair)}
        disabled={!!why}
        title={why ?? 'Where the main mix leaves. “Main” keeps it in the summed program.'}
        onChange={(v) => setMain(v === 'main' ? null : Number(v))}
        options={[
          { value: 'main', label: 'MAIN' },
          ...pairs.map((first) => ({
            value: String(first),
            label: `${first + 1}/${first + 2}`,
          })),
        ]}
      />
      {/* The sends, each ONE channel — mono lanes, per the engine's layout. */}
      {[0, 1, 2, 3].map((i) => (
        <Select
          key={i}
          value={String(sendCh[i])}
          disabled={!!why}
          title={why ?? `Send ${i + 1} output — a single channel, or none`}
          onChange={(v) => setSend(i, Number(v))}
          options={[
            { value: '-1', label: `S${i + 1}·–` },
            ...Array.from({ length: channelCount }, (_v, c) => ({
              value: String(c),
              label: `S${i + 1}·${c + 1}`,
            })),
          ]}
        />
      ))}
    </span>
  )
}
