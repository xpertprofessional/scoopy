/**
 * SCENE SWITCH LAWS — what a pad click does, as arithmetic rather than as a
 * branch buried in a store method.
 *
 * Ported from `BeatSequencer.PatternSceneSwitchMode` (BeatSequencer.swift:1641)
 * and `activatePatternSceneViaSwitchMode`. The donor's three modes, its own
 * short labels, and its own help text — the text is worth keeping verbatim
 * because it is what the mode button's title says, and paraphrasing it would be
 * the kind of quiet divergence PARALLEL-PROTOCOL §0 rule 2 exists to catch.
 */

/** The donor's three modes, in the order its cycler walks them. */
export const SWITCH_MODES = ['scheduled', 'seamless', 'restart'] as const
export type SwitchMode = (typeof SWITCH_MODES)[number]

/**
 * The donor's `shortLabel`, verbatim. Three or five characters, because this
 * rides a dense deck row as a CYCLER — the idiom `strip-tempomode` already uses
 * for a three-way musical choice (one button wearing its current value, rather
 * than three buttons where two are always wrong).
 */
export const SWITCH_MODE_LABEL: Record<SwitchMode, string> = {
  scheduled: 'SCHED',
  seamless: 'RUN',
  restart: 'START',
}

/** The donor's `helpText`, verbatim (BeatSequencer.swift:1656-1665). */
export const SWITCH_MODE_HELP: Record<SwitchMode, string> = {
  scheduled: 'Scene clicks schedule during playback and switch immediately when stopped.',
  seamless: 'Scene clicks switch immediately at the current running pattern position.',
  restart: 'Scene clicks switch immediately and start the pattern from step 0.',
}

export function nextSwitchMode(mode: SwitchMode): SwitchMode {
  return SWITCH_MODES[(SWITCH_MODES.indexOf(mode) + 1) % SWITCH_MODES.length]!
}

/** What a pad click resolves to, once the mode and the transport are known. */
export type SwitchAction = 'schedule' | 'seamless' | 'restart'

/**
 * Resolve a pad click.
 *
 * ⚠️ STOPPED COLLAPSES SCHEDULED INTO IMMEDIATE, and that is the donor's rule,
 * not a shortcut: *"Scene clicks schedule during playback and switch
 * immediately when stopped."* Scheduling against a clock that is not running
 * would arm a boundary that never arrives — the pad would light and nothing
 * would ever happen, which is worse than switching.
 *
 * A stopped deck in `restart` mode still resolves to `restart`: the mode says
 * where the pattern begins, and "from step 0" is meaningful whether or not the
 * transport is already moving.
 */
export function resolveSwitchAction(
  mode: SwitchMode,
  playing: boolean,
  explicitImmediate?: boolean,
): SwitchAction {
  // An explicit immediate (⌘-click, the desktop's R) overrides the mode
  // entirely — it is the gesture that means "not what the mode says, now".
  if (explicitImmediate) return mode === 'restart' ? 'restart' : 'seamless'
  if (mode === 'restart') return 'restart'
  if (mode === 'seamless') return 'seamless'
  return playing ? 'schedule' : 'seamless'
}
