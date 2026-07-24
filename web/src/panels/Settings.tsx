/**
 * Settings — one of the four surfaces (PD-MERGE, §1).
 *
 * Summoned, not resident: it mirrors RoutingMatrix's collapsible idiom rather
 * than inventing new machinery, because the whole point of this phase is to
 * shrink the surface count, not to grow a shell.
 *
 * It holds what is about the MACHINE and the SESSION — the audio device, and
 * saving/opening a package — as opposed to the map, which is about the patch.
 * The device picker moved here out of the sources rail; the package buttons
 * moved here out of the top bar.
 */
import { useState } from 'react'
import type { EngineLink } from '../engine/engineLink'
import { publishPatch } from '../engine/usePatch'
import { openPackage, savePackage } from '../persist/packageIo'
import { useAppStore } from '../store/appStore'
import { DevicePicker } from './DevicePicker'

const nowIso = () => new Date().toISOString()

export function Settings({ link }: { link: EngineLink | null }) {
  const [open, setOpen] = useState(false)
  const deviceInfo = useAppStore((s) => s.deviceInfo)

  const onSave = async () => {
    if (!link) return
    const store = useAppStore.getState()
    const r = await savePackage(link, store.patch, nowIso())
    if (r.notice !== '') store.setSessionNotice(r.notice)
  }

  const onOpen = async () => {
    if (!link) return
    const store = useAppStore.getState()
    const r = await openPackage(
      link,
      (p) => {
        store.setPatch(p)
        publishPatch(link, p) // opening IS a publish, same path as any edit
      },
      store.setDeckUnresolved,
      store.bumpDeckRevision,
    )
    if (r.notice !== '') useAppStore.getState().setSessionNotice(r.notice)
  }

  return (
    <section className="settings raised">
      <button type="button" onClick={() => setOpen((o) => !o)}>
        {open ? '▾' : '▸'} Settings
      </button>
      {open && (
        <div className="settings-body">
          <h3>Audio device</h3>
          {deviceInfo && deviceInfo.error !== '' && (
            <p className="dim">device: {deviceInfo.error}</p>
          )}
          <DevicePicker link={link} />
          <p className="dim">
            in: {deviceInfo?.inputDeviceName || 'none'} · out: {deviceInfo?.deviceName || 'none'}
            {deviceInfo && deviceInfo.sampleRate > 0
              ? ` · ${Math.round(deviceInfo.sampleRate)} Hz`
              : ''}
          </p>

          <h3>Session</h3>
          <div className="settings-actions">
            <button type="button" onClick={() => void onOpen()} disabled={!link}>
              Open package…
            </button>
            <button type="button" onClick={() => void onSave()} disabled={!link}>
              Save package…
            </button>
          </div>
          <p className="dim">
            Your patch autosaves. A package additionally carries the takes it references, so
            it opens on another machine.
          </p>
        </div>
      )}
    </section>
  )
}
