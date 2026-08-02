/**
 * THE FOUR FX RETURNS — what is loaded on each, and how to reach its editor (S4).
 *
 * Studio had the SEND side all along — per-track sends in the track rows, the
 * deck's master sends on `MasterRow` — and nothing saying what those sends fed.
 * Four faders into four unnamed destinations.
 *
 * ⚠️ THE FIRST CUT OF THIS DID NOT WORK, and the reason is worth keeping: it
 * called `listPlugins` and drew whatever came back — but NOTHING IN THIS APP
 * EVER SCANS. `rescanPlugins` exists and must be asked for; the app does not
 * scan at boot (a first sweep runs out-of-process per plugin and takes
 * minutes, so doing it uninvited at every launch would be worse). With no
 * scan the list is empty, so every picker sat disabled saying "no plugins
 * found" — a rack that looked broken because the door it needed was one I had
 * not drawn. The donor's FX panel has had a RESCAN row all along.
 *
 * ⚠️ AND IT SHOWED THE WRONG THING FOR A LOADED PLUGIN. `getFxSlotState`
 * answered identifier + state, which is enough to REMEMBER a plugin and not
 * enough to SHOW one: the identifier is a format-encoded string
 * (`AudioUnit-Massive-1a2b`), not a name. It now also reports the display name,
 * the latency the return adds, and whether the plugin HAS an editor — every one
 * of them from an ABI call that already existed.
 *
 * WHAT IS STILL DELIBERATELY ABSENT: `fxSlot`'s mode / host-output / post-fader
 * ops refuse by name ("arrives with P7-MIX-0"), and return level / mute / solo
 * have no answered path in this host yet. Drawing them would put controls in
 * front of nothing, which is the defect this rack exists to stop repeating.
 * The donor's slot carries all of them; this is honestly a subset, and says so
 * on screen rather than implying completeness.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import type { EngineLink } from '../engineLink.ts'
import { Button, Select } from '../design/controls.tsx'

type Slot = {
  returnIndex: number
  identifier: string | null
  name: string | null
  latencyMs: number
  editorAvailable: boolean
  editorVisible: boolean
}
type Plugin = { identifier: string; name: string }

const RETURNS = [1, 2, 3, 4] as const

export function SendRack({ link, session }: { link: EngineLink | null; session: string | null }) {
  const [slots, setSlots] = useState<Slot[]>([])
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [scanning, setScanning] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const poll = useRef<ReturnType<typeof setInterval> | null>(null)

  const readSlots = useCallback(() => {
    if (!link) return
    void link
      .command('getFxSlotState', {})
      .then((r) => setSlots(((r as { slots?: Slot[] })?.slots ?? []) as Slot[]))
      .catch(() => {})
  }, [link])

  const readPlugins = useCallback(() => {
    if (!link) return
    void link
      .command('listPlugins', {})
      .then((r) => {
        const res = r as { plugins?: Plugin[]; scanning?: boolean }
        setPlugins((res?.plugins ?? []) as Plugin[])
        setScanning(Boolean(res?.scanning))
      })
      .catch(() => {
        setPlugins([])
        setScanning(false)
      })
  }, [link])

  useEffect(() => {
    readSlots()
    readPlugins()
  }, [readSlots, readPlugins])

  // WHILE SCANNING, POLL. The shell's own comment says the poll IS the progress
  // UI — there is no event lane, on purpose, because a first sweep can take
  // minutes and a fire-and-forget scan with no feedback looks identical to a
  // scan that never started.
  useEffect(() => {
    if (!scanning) {
      if (poll.current) clearInterval(poll.current)
      poll.current = null
      return
    }
    poll.current = setInterval(readPlugins, 1000)
    return () => {
      if (poll.current) clearInterval(poll.current)
      poll.current = null
    }
  }, [scanning, readPlugins])

  const slotOf = (i: number) => slots.find((s) => s.returnIndex === i)

  const why = !session ? 'no session — use “session ▾” to make or open one' : null
  /** Separate from `why`: with no plugins the PICKERS are inert but RESCAN is
   *  the one control that must stay live, since it is how you get some. */
  const noPlugins = plugins.length === 0

  const pick = (returnIndex: number, identifier: string) => {
    // No `state`: that restores a REMEMBERED plugin, and a fresh pick has
    // nothing to restore — an empty blob asks a plugin to adopt something it
    // never wrote.
    void link
      ?.command('selectFxPlugin', { returnIndex, identifier })
      .then(() => {
        setNote(`FX${returnIndex} loading…`)
        // `sl_fx_plugin_select` returns "accepted", not "loaded" — the shell's
        // own header says to poll the name. One re-read now and one shortly
        // after covers the async load without a second polling loop.
        readSlots()
        setTimeout(readSlots, 1200)
      })
      .catch((e: Error) => setNote(`FX${returnIndex}: ${e.message}`))
  }

  return (
    <span className="studio-sends" role="group" aria-label="FX returns">
      <span className="ds-label mono dim">fx</span>
      {RETURNS.map((i) => {
        const s = slotOf(i)
        const loaded = s?.identifier != null
        return (
          <span key={i} className="studio-send-slot">
            <Select
              value={s?.identifier ?? ''}
              disabled={!!why || noPlugins}
              title={
                why ??
                (noPlugins
                  ? 'no plugins yet — press RESCAN'
                  : loaded
                    ? `FX${i}: ${s?.name ?? s?.identifier} · +${(s?.latencyMs ?? 0).toFixed(1)} ms`
                    : `FX${i} — choose the plugin this send feeds`)
              }
              onChange={(v) => v && pick(i, v)}
              options={[
                { value: '', label: `${i}·${s?.name ?? (loaded ? '…' : '—')}` },
                ...plugins.map((p) => ({ value: p.identifier, label: p.name })),
              ]}
            />
            {/* EDIT only where there IS an editor. `editorAvailable` is read
                from the engine, so a plugin that opens no window shows no
                button rather than a button that does nothing. */}
            {s?.editorAvailable && (
              <Button
                label="EDIT"
                active={s.editorVisible}
                title={`${s.editorVisible ? 'Hide' : 'Open'} FX${i}'s plugin editor`}
                onClick={() => {
                  void link
                    ?.command('fxSlot', { returnIndex: i, op: 'toggleEditor' })
                    .then(() => setTimeout(readSlots, 300)) // the window is marshalled
                    .catch((e: Error) => setNote(`FX${i}: ${e.message}`))
                }}
              />
            )}
          </span>
        )
      })}
      {/* THE DOOR THE FIRST CUT LACKED. Always live — it is how an empty list
          stops being empty, so gating it on having plugins would be a deadlock. */}
      <Button
        label={scanning ? 'SCANNING…' : 'RESCAN'}
        disabled={scanning}
        title={
          scanning
            ? 'Scanning for plugins — a first sweep runs out-of-process and can take minutes'
            : 'Scan for AU/VST3 plugins. Nothing scans at launch, so this is how the list gets filled.'
        }
        onClick={() => {
          setNote(null)
          void link
            ?.command('rescanPlugins', {})
            .then(() => {
              setScanning(true)
              readPlugins()
            })
            .catch((e: Error) => setNote(e.message))
        }}
      />
      {note && <span className="dim mono">{` · ${note}`}</span>}
    </span>
  )
}
