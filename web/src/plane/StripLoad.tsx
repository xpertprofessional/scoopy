/**
 * Load material into a Strip (PD-MERGE, retiring the takes panel).
 *
 * Material belongs to a Strip, so choosing it happens ON the Strip rather than
 * in a separate browser — that is what lets the takes panel go without losing
 * anything. A take recorded anywhere can be loaded into any Strip, which is
 * CONCEPT §3's "one click → any deck", now expressed on the object itself.
 */
import { useState } from 'react'
import type { EngineLink } from '../engine/engineLink'
import { usePatchActions } from '../engine/usePatch'
import { useAppStore } from '../store/appStore'

function seconds(frames: number, rate: number): string {
  if (rate <= 0) return ''
  const s = frames / rate
  return s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${s.toFixed(1)}s`
}

export function StripLoad({ index, link }: { index: number; link: EngineLink | null }) {
  const [open, setOpen] = useState(false)
  const takes = useAppStore((s) => s.takes)
  const actions = usePatchActions(link)

  return (
    <span className="strip-load">
      <button
        type="button"
        className={open ? 'latched-accent' : ''}
        title="load material into this strip"
        onClick={() => {
          // Re-read the take list on open. Nothing else refreshes it once the
          // takes panel is gone, and a take recorded a moment ago must be here.
          if (!open) void actions.refreshTakes()
          setOpen((o) => !o)
        }}
      >
        load
      </button>
      {open && (
        <div className="strip-load-menu raised" role="menu">
          <button
            type="button"
            onClick={() => {
              void actions.loadFileIntoStrip(index)
              setOpen(false)
            }}
          >
            from file…
          </button>
          <h3>Takes</h3>
          {takes.length === 0 && <p className="dim">nothing recorded yet</p>}
          {takes
            .slice()
            .reverse()
            .map((t) => (
              <div className="add-strip-row" key={t.path}>
                <button
                  type="button"
                  title={`replace this strip's material with ${t.sourceDesc || t.path}`}
                  onClick={() => {
                    void actions.loadIntoStrip(index, t.path)
                    setOpen(false)
                  }}
                >
                  {t.path.split('/').pop()} · {seconds(t.frames, t.sampleRate)}
                </button>
                {/* Squeeze it IN at the playhead instead of replacing — the rest
                    of the material shifts later rather than being overwritten. */}
                <button
                  type="button"
                  title="insert at the playhead — the rest shifts later"
                  onClick={() => {
                    void actions.insertIntoStrip(index, t.path)
                    setOpen(false)
                  }}
                >
                  ⤵
                </button>
              </div>
            ))}
        </div>
      )}
    </span>
  )
}
