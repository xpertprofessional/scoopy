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
import { usePatchActions } from '../engine/usePatch'
import { alignOffsetSamples, formatOffset, takesOverlap } from '../engine/takeAlign'

const nowIso = () => new Date().toISOString()

export function Settings({ link }: { link: EngineLink | null }) {
  const [open, setOpen] = useState(false)
  const deviceInfo = useAppStore((s) => s.deviceInfo)
  const takes = useAppStore((s) => s.takes)
  const referencePath = useAppStore((s) => s.alignReferencePath)
  const setAlignReference = useAppStore((s) => s.setAlignReference)
  const actions = usePatchActions(link)
  const reference = takes.find((t) => t.path === referencePath) ?? null

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

          {/* TAKES + the Law C-2 align reference. This is session-level — which
              take you measure others against is a property of the session, not
              of any one Strip — so it lives here rather than on the map. Loading
              a take into a Strip then ALSO aligns it (usePatch.loadIntoStrip). */}
          <h3>Takes ({takes.length})</h3>
          <div className="settings-actions">
            <button type="button" onClick={() => void actions.refreshTakes()} disabled={!link}>
              refresh
            </button>
            {reference && (
              <button type="button" onClick={() => setAlignReference(null)}>
                clear reference
              </button>
            )}
          </div>
          {takes.length === 0 && <p className="dim">nothing recorded yet</p>}
          {takes.length > 0 && (
            <p className="dim">
              Pick a reference; every other take then shows its offset from it. Loading a take
              into a strip aligns it to that reference (Law C-2 — a subtraction, not an edit).
            </p>
          )}
          <ul className="settings-takes">
            {takes
              .slice()
              .reverse()
              .map((t) => {
                const isRef = t.path === referencePath
                const offset = reference ? alignOffsetSamples(t, reference) : 0
                const overlaps = reference && !isRef && takesOverlap(t, reference)
                return (
                  <li key={t.path}>
                    <button
                      type="button"
                      className={isRef ? 'latched-accent' : ''}
                      title={
                        isRef
                          ? 'reference take — others show their offset from this one'
                          : 'make this the align reference (Law C-2)'
                      }
                      onClick={() => setAlignReference(isRef ? null : t.path)}
                    >
                      {isRef ? 'ref' : reference ? formatOffset(offset, t.sampleRate) : 'set ref'}
                    </button>
                    <span className="take-name" title={`${t.sourceDesc} · ${t.path}`}>
                      {t.path.split('/').pop()}
                      {overlaps ? ' ⧉' : ''}
                    </span>
                    <button type="button" title="reveal in Finder" onClick={() => void actions.revealTake(t.path)}>
                      ⤴
                    </button>
                    <button type="button" title="discard to Trash (recoverable)" onClick={() => void actions.deleteTake(t.path)}>
                      ×
                    </button>
                  </li>
                )
              })}
          </ul>
        </div>
      )}
    </section>
  )
}
