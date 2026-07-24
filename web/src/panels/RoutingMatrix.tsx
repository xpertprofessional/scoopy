/**
 * Routing matrix (collapsible, ARCHITECTURE §7.1): channels × sources × buses.
 *
 * The IN column is the global place where inputs are flipped in real time: every
 * strip on one screen, each with the whole source list — device inputs, nothing,
 * and the loopback taps of Wizard's own buses. Loopback is a SOURCE YOU SELECT,
 * not a kind of strip, so it appears here beside the mics rather than as a thing
 * you had to create differently. Re-pointing does not disturb material: a strip
 * looping a take keeps looping while you change what it listens to.
 *
 * P1 buses are main (every strip feeds it — a fixed cell, not an option) and
 * monitor (editable — the same document field as the strip's C switch, one
 * truth). Loopback ↺ cells and user output buses appear in P4; cycle-creating
 * edits are refused at edit time (patchValidation) so the engine never sees
 * one. Below the grid: the output map v0, read-only until the P4 spatial UI.
 */
import { useState } from 'react'
import type { EngineLink } from '../engine/engineLink'
import { usePatchActions } from '../engine/usePatch'
import { availableSources } from '../plane/AddStrip'
import { useAppStore } from '../store/appStore'

export function RoutingMatrix({ link }: { link: EngineLink | null }) {
  const [open, setOpen] = useState(false)
  const channels = useAppStore((s) => s.patch.channels)
  const deviceInfo = useAppStore((s) => s.deviceInfo)
  const actions = usePatchActions(link)
  const sources = availableSources(deviceInfo?.inputs ?? [])

  return (
    <section className="matrix raised">
      <button type="button" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Routing matrix
      </button>
      {open && (
        <>
          <table>
            <thead>
              <tr>
                <th />
                <th>in</th>
                <th>out bus</th>
                <th>monitor</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((ch, i) => (
                <tr key={ch.key}>
                  <td className="matrix-name">{ch.name}</td>
                  <td>
                    <select
                      title="what this strip listens to — changeable live"
                      value={`${ch.source.kind}:${ch.source.id}`}
                      onChange={(ev) => {
                        const picked = sources.find(
                          (s) => `${s.source.kind}:${s.source.id}` === ev.target.value,
                        )
                        if (picked) actions.setStripSource(i, picked.source)
                      }}
                    >
                      {/* The strip's CURRENT source stays listed even if the
                          device that provided it is gone — otherwise the select
                          would silently show something the strip is not on. */}
                      {!sources.some(
                        (s) => `${s.source.kind}:${s.source.id}` === `${ch.source.kind}:${ch.source.id}`,
                      ) && (
                        <option value={`${ch.source.kind}:${ch.source.id}`}>
                          {ch.source.name || ch.source.kind} (gone)
                        </option>
                      )}
                      {sources.map((s) => (
                        <option key={`${s.source.kind}:${s.source.id}`} value={`${s.source.kind}:${s.source.id}`}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="matrix-fixed" title="output bus (bus 1 = main)">
                    {ch.outBus === 0 ? 'main' : `bus ${ch.outBus + 1}`}
                  </td>
                  <td>
                    <button
                      type="button"
                      className={ch.toMonitor ? 'latched-signal' : ''}
                      onClick={() => actions.setToMonitor(i, !ch.toMonitor)}
                    >
                      {ch.toMonitor ? '●' : '○'}
                    </button>
                  </td>
                </tr>
              ))}
              {channels.length === 0 && (
                <tr>
                  <td className="dim" colSpan={4}>
                    no channels
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="value">
            output map: main → out 1/2 ·{' '}
            {deviceInfo?.monitorAvailable
              ? 'monitor → out 3/4'
              : 'monitor unmapped (device has <4 outputs)'}
            {' · '}
            bus 2+ → out 5/6, 7/8, … ·{' '}
            {`this device carries ${deviceInfo?.mappableBuses ?? 1} of 8 buses`}
          </p>
        </>
      )}
    </section>
  )
}
