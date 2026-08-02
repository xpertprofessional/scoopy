/**
 * THE FOUR FX RETURNS — what is loaded on each, and how to reach its editor (S4).
 *
 * Studio had no return surface at all. The SEND side has existed for a while —
 * per-track sends in the track rows, the deck's master sends on `MasterRow` —
 * but nothing said what those sends were being sent INTO, or offered a way to
 * put a plugin there. Four faders into four unnamed destinations.
 *
 * ⚠️ IT USES ONLY COMMANDS THE SHELL ALREADY ANSWERS, and that bound is the
 * design rather than a limitation to apologise for. `listPlugins`,
 * `selectFxPlugin`, `getFxSlotState` and `fxSlot/toggleEditor` are live;
 * `fxSlot`'s other ops (mode, host-output, post-fader) still refuse by name
 * with "arrives with P7-MIX-0". So this draws what works and NOTHING for what
 * does not — DESIGN.md §7, and the rule this session keeps finding the wrong
 * side of. A pre/post button that reported success and changed nothing would be
 * worse than its absence.
 *
 * LOAD FIRST, THEN THE MODE FLIPS — the donor's ordering, which the shell
 * already implements inside `selectFxPlugin`: it loads the plugin and only
 * switches the return into host mode on success, so there is never a window
 * where the send is live into a slot that has nothing in it. The UI simply must
 * not second-guess that by flipping anything itself.
 */
import { useCallback, useEffect, useState } from 'react'

import type { EngineLink } from '../engineLink.ts'
import { Button, Select } from '../design/controls.tsx'

type Slot = { returnIndex: number; identifier: string | null }
type Plugin = { identifier: string; name: string }

const RETURNS = [1, 2, 3, 4] as const

export function SendRack({ link, session }: { link: EngineLink | null; session: string | null }) {
  const [slots, setSlots] = useState<Slot[]>([])
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(() => {
    if (!link) return
    void link
      .command('getFxSlotState', {})
      .then((r) => setSlots(((r as { slots?: Slot[] })?.slots ?? []) as Slot[]))
      .catch(() => {})
  }, [link])

  useEffect(() => {
    refresh()
    if (!link) return
    // The scan is the SLOW one and it is the host's, so it is asked for once
    // rather than per return. A host with no plugin support answers a refusal,
    // which leaves the list empty and every picker honestly inert.
    void link
      .command('listPlugins', {})
      .then((r) => setPlugins(((r as { plugins?: Plugin[] })?.plugins ?? []) as Plugin[]))
      .catch(() => setPlugins([]))
  }, [link, refresh])

  const idOf = (i: number) => slots.find((s) => s.returnIndex === i)?.identifier ?? null
  const nameOf = (id: string | null) =>
    id === null ? '—' : (plugins.find((p) => p.identifier === id)?.name ?? id.slice(0, 18))

  /** The one precondition, said the same way every other Studio block says it. */
  const why = !session
    ? 'no session — use “session ▾” to make or open one'
    : plugins.length === 0
      ? 'no plugins found — this build has no plugin host, or the scan found nothing'
      : null

  const pick = (returnIndex: number, identifier: string) => {
    // No `state` argument: that is for RESTORING a remembered plugin, and a
    // fresh pick has nothing to restore. Passing an empty string would ask the
    // plugin to adopt a blob it never wrote.
    void link
      ?.command('selectFxPlugin', { returnIndex, identifier })
      .then(() => {
        setNote(`FX${returnIndex} loaded`)
        refresh() // read the ENGINE back rather than assuming the pick took
      })
      .catch((e: Error) => setNote(`FX${returnIndex}: ${e.message}`))
  }

  return (
    <span className="studio-sends" role="group" aria-label="FX returns">
      <span className="ds-label mono dim">fx</span>
      {RETURNS.map((i) => (
        <span key={i} className="studio-send-slot">
          <Select
            value={idOf(i) ?? ''}
            disabled={!!why}
            title={why ?? `FX${i} — choose the plugin this send feeds`}
            onChange={(v) => v && pick(i, v)}
            options={[
              { value: '', label: `${i}·${nameOf(idOf(i))}` },
              ...plugins.map((p) => ({ value: p.identifier, label: p.name })),
            ]}
          />
          {/* EDIT only exists once something is loaded — an editor button over an
              empty slot opens nothing, and the shell refuses it anyway when the
              plugin has no editor. */}
          {idOf(i) !== null && (
            <Button
              label="EDIT"
              title={`Open FX${i}'s plugin editor`}
              onClick={() => {
                void link?.command('fxSlot', { returnIndex: i, op: 'toggleEditor' }).catch(
                  (e: Error) => setNote(`FX${i}: ${e.message}`),
                )
              }}
            />
          )}
        </span>
      ))}
      {note && <span className="dim mono">{` · ${note}`}</span>}
    </span>
  )
}
