/**
 * Session device resolution (P7-08, D-WZ-DEVGONE-01).
 *
 * A session remembers which audio device it was built on. When that device is
 * absent — a different machine, or the interface simply unplugged — Wizard
 * FALLS BACK to whatever is current AND SAYS SO, loudly and non-blockingly.
 *
 * That is the same posture the app takes everywhere else (a vanished capture
 * source, an unresolved deck): keep working, keep the reference, and say what
 * changed. Silently falling back would let you record the wrong input without
 * noticing — the exact failure Wizard exists to prevent. Opening with no device
 * would teach you to distrust an instrument that boots silent.
 *
 * Pure: no store, no link. The caller applies the result.
 */

/** What a session remembers. Empty string = "no preference, use the default". */
export interface SessionDevice {
  input: string
  output: string
}

export interface DeviceAvailability {
  inputs: string[]
  outputs: string[]
  currentInput: string
  currentOutput: string
}

export interface DeviceResolution {
  /** Device to select, or '' to leave that side alone (setDevice's own idiom). */
  applyInput: string
  applyOutput: string
  /** Non-empty when the session wanted something it did not get. */
  notice: string
}

/** Resolve one side. Returns the device to apply ('' = leave) and, when the
    wanted device is missing, the phrase describing the substitution. */
function resolveSide(
  wanted: string,
  available: readonly string[],
  current: string,
  label: string,
): { apply: string; missing: string } {
  if (wanted === '') return { apply: '', missing: '' } // no preference recorded
  if (available.includes(wanted)) {
    // Already on it? Then there is nothing to switch.
    return { apply: wanted === current ? '' : wanted, missing: '' }
  }
  // Wanted but absent: do NOT switch, and report wanted-vs-got by name so the
  // substitution is debuggable rather than mysterious.
  return {
    apply: '',
    missing: `${label} "${wanted}" is not available — using "${current || 'the default'}"`,
  }
}

export function resolveSessionDevice(
  saved: SessionDevice,
  available: DeviceAvailability,
): DeviceResolution {
  const out = resolveSide(saved.output, available.outputs, available.currentOutput, 'output device')
  const inp = resolveSide(saved.input, available.inputs, available.currentInput, 'input device')
  const parts = [out.missing, inp.missing].filter((m) => m !== '')
  return {
    applyInput: inp.apply,
    applyOutput: out.apply,
    notice: parts.join('; '),
  }
}
