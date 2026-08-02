/**
 * ScoopyTape's FACE — the looper strip as a DAW insert.
 * `window.__slPanel = "plugintape"`, injected by ScoopyTapeEditor.
 * Brief: docs/merge/TAPEPLUGIN-KICKOFF.md.
 *
 * ⚠️ THIS FILE USED TO BE THE WHOLE LOOPER, AND THAT WAS THE DEFECT.
 * D-SL-STUDIO-01 L1: a face is a layout, a block is a component, and a face
 * never rebuilds a block. This one mounted no block at all, so the looper
 * existed in exactly one product plus the frozen plane's 48 px lane, and every
 * addition to it deepened that. The tree moved to `blocks/TapeRow.tsx`
 * unchanged; what stayed here is the only thing that is genuinely ScoopyTape's:
 *
 *   THE BOX. A plugin window root has nothing above it to supply a height, so
 *   `.plugin-tape-pane` owns `height: 100vh` and hands the block the whole
 *   thing. Studio hands the same block a short collapsible strip instead. That
 *   difference is layout, which is what a face is for — and it is why `TapeRow`
 *   has no `collapsible` prop to argue about.
 *
 * THE DISPLAY IS THE PRODUCT, and that survives the carve because it is a
 * property of this box: every row in the block is `flex: none` at the one
 * control height and the wave field is the only flexible child, so the field
 * takes the entire remainder of whatever it is given. Here that remainder is
 * the window, which is the whole reason this plugin is not just a strip on the
 * plane.
 */
import type { EngineLink } from '../engineLink.ts'
import { TapeRow } from '../blocks/TapeRow.tsx'
import './plane.css'

export function PluginTapePanel({ link }: { link: EngineLink | null }) {
  return (
    <div className="plugin-tape-pane">
      <TapeRow link={link} />
    </div>
  )
}
