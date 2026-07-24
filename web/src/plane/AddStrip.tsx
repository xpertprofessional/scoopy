/**
 * Add-strip — the ONE creation gesture on the map (PD-MERGE-02, pd-merge §3).
 *
 * There is ONE kind of strip. This menu therefore does not offer "an input" or
 * "a deck" or "a loopback" as different things to create — it creates a strip
 * and lets you pick what it LISTENS TO. An earlier version had three creation
 * paths, which quietly reintroduced the three species PD-CANVAS exists to
 * abolish: you could tell what a strip "was" by which button had made it.
 *
 * A source is a CHOICE, not a species. It can be changed at any time, here or
 * from the routing matrix, and a strip gains material by recording or loading —
 * never by being created as a different type.
 */
import { useState } from 'react'
import type { SourceRef } from '../../protocol/schema'
import type { EngineLink } from '../engine/engineLink'
import { usePatchActions } from '../engine/usePatch'
import { useAppStore } from '../store/appStore'

/** Every source a strip can listen to right now, as ONE flat list. */
export function availableSources(
  inputs: ReadonlyArray<{ name: string; index: number }>,
): Array<{ label: string; hint: string; source: SourceRef }> {
  const out: Array<{ label: string; hint: string; source: SourceRef }> = [
    {
      label: 'nothing yet',
      hint: 'an empty strip — load a file or pick a source later',
      source: { kind: 'none', id: '', name: 'unbound' },
    },
  ]
  inputs.forEach((input, i) => {
    out.push({
      label: input.name,
      hint: 'device input',
      source: { kind: 'deviceInput', id: String(input.index), name: input.name },
    })
    const next = inputs[i + 1]
    if (next)
      out.push({
        label: `${input.name} / ${next.name}`,
        hint: 'stereo pair',
        source: {
          kind: 'deviceInput',
          id: `${input.index},${next.index}`,
          name: `${input.name} / ${next.name}`,
        },
      })
  })
  // Loopback is just another source you can listen to — Wizard's own output,
  // read one block behind so the cycle stays legal. Not a special kind of strip.
  out.push({
    label: '↺ main',
    hint: "Wizard's own main output (one block behind)",
    source: { kind: 'busTap', id: '0', name: 'main bus' },
  })
  out.push({
    label: '↺ cue',
    hint: "Wizard's own cue output (one block behind)",
    source: { kind: 'busTap', id: '1', name: 'cue bus' },
  })
  return out
}

export function AddStrip({
  link,
  spawnAt,
}: {
  link: EngineLink | null
  /** Where on the plane a new Strip should land, in plane coordinates. */
  spawnAt: () => { x: number; y: number }
}) {
  const [open, setOpen] = useState(false)
  const deviceInfo = useAppStore((s) => s.deviceInfo)
  const actions = usePatchActions(link)
  const sources = availableSources(deviceInfo?.inputs ?? [])

  return (
    <div className="add-strip">
      <button
        type="button"
        className={open ? 'latched-accent' : ''}
        title="add a strip to the map"
        onClick={() => setOpen((o) => !o)}
      >
        + strip
      </button>
      {open && (
        <div className="add-strip-menu raised" role="menu">
          <h3>listening to</h3>
          <p className="dim">
            One kind of strip. Pick what it hears — you can change it later, and it becomes
            a player as soon as it records or loads something.
          </p>
          {sources.map((s) => (
            <button
              key={`${s.source.kind}:${s.source.id}`}
              type="button"
              title={s.hint}
              onClick={() => {
                actions.addSourceChannel(s.source.name, s.source, spawnAt())
                setOpen(false)
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
