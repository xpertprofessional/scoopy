/**
 * Device picker (P1-10): choose the input and output device the duplex engine
 * opens. Switching re-opens at the current engine rate (D-WZ-RATE-01 refuses a
 * rate the device can't run) and refreshes the sources list. The full
 * rate-change engine rebuild + deck auto-reload is P0-11a; until then a switch
 * to a different-rate device warns that loaded decks need reloading.
 */
import { useEffect, useState } from 'react'
import type { EngineLink } from '../engine/engineLink'
import { useAppStore } from '../store/appStore'

interface DeviceList {
  inputs: string[]
  outputs: string[]
  currentInput: string
  currentOutput: string
}

export function DevicePicker({ link }: { link: EngineLink | null }) {
  const [list, setList] = useState<DeviceList | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const setDeviceInfo = useAppStore((s) => s.setDeviceInfo)
  const rememberDevice = useAppStore((s) => s.setSessionDevice)
  const hasDecks = useAppStore((s) => s.patch.decks.length > 0)

  const refresh = () => {
    void link?.command('listDevices', {}).then(setList)
  }
  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link])

  const switchTo = async (input: string, output: string) => {
    if (!link) return
    setBusy(true)
    setError('')
    const r = await link.command('setDevice', { input, output })
    if (!r.ok) setError(r.error || 'device switch failed')
    // Re-read both the picker's current selection and the sources list.
    const info = await link.command('getDeviceInfo', {})
    setDeviceInfo(info)
    // Remember the choice IN THE SESSION (P7-08): a device you picked on
    // purpose should survive a quit. Only on success — recording a device the
    // switch refused would make the session ask for it again next launch.
    if (r.ok) rememberDevice(input, output)
    refresh()
    setBusy(false)
  }

  if (!list) return null

  return (
    <div className="device-picker">
      <label>
        in
        <select
          value={list.currentInput}
          disabled={busy}
          onChange={(e) => void switchTo(e.target.value, '')}
        >
          {!list.inputs.includes(list.currentInput) && (
            <option value={list.currentInput}>{list.currentInput || '(none)'}</option>
          )}
          {list.inputs.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      <label>
        out
        <select
          value={list.currentOutput}
          disabled={busy}
          onChange={(e) => void switchTo('', e.target.value)}
        >
          {!list.outputs.includes(list.currentOutput) && (
            <option value={list.currentOutput}>{list.currentOutput || '(none)'}</option>
          )}
          {list.outputs.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </label>
      {error !== '' && <p className="dim">{error}</p>}
      {hasDecks && (
        <p className="dim">note: reload decks if the new device runs a different rate</p>
      )}
    </div>
  )
}
