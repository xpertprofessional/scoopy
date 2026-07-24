/**
 * Routing matrix v0 (collapsible, ARCHITECTURE §7.1): channels × buses.
 * P1 buses are main (every strip feeds it — a fixed cell, not an option) and
 * monitor (editable — the same document field as the strip's C switch, one
 * truth). Loopback ↺ cells and user output buses appear in P4; cycle-creating
 * edits are refused at edit time (patchValidation) so the engine never sees
 * one. Below the grid: the output map v0, read-only until the P4 spatial UI.
 */
import { useState } from 'react'
import type { EngineLink } from '../engine/engineLink'
import { usePatchActions } from '../engine/usePatch'
import { useAppStore } from '../store/appStore'

export function RoutingMatrix({ link }: { link: EngineLink | null }) {
  const [open, setOpen] = useState(false)
  const channels = useAppStore((s) => s.patch.channels)
  const deviceInfo = useAppStore((s) => s.deviceInfo)
  const actions = usePatchActions(link)

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
                <th>out bus</th>
                <th>monitor</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((ch, i) => (
                <tr key={ch.key}>
                  <td className="matrix-name">{ch.name}</td>
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
                  <td className="dim" colSpan={3}>
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
