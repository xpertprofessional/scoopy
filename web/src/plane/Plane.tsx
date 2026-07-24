/**
 * Plane — the boundless workspace (PD-CANVAS-02, pd-canvas.md §4).
 *
 * Strips are placed by their `cell` geometry and the Plane applies one pan/zoom
 * transform over all of them. This first cut is "positioned + pan/zoom/fit": you
 * can move around and frame the whole patch, but strips don't drag yet (that is
 * the next step). GRM has no overview aid, so fit-to-content is ours (§4.1);
 * zoom controls sit bottom-right, matching GRM's placement, with a Default (1×)
 * reset. No grid — placement is the user's.
 *
 * Screen = (planeCoord + pan) · scale, so the CSS transform is
 * `scale(s) translate(pan)` with a top-left origin — the exact convention
 * fitToContent() computes against.
 */
import { useLayoutEffect, useRef, useState } from 'react'
import type { EngineLink } from '../engine/engineLink'
import { useAppStore } from '../store/appStore'
import { fitToContent, zoomAbout, type Viewport } from './planeLayout'
import { Strip } from './Strip'
import { AddStrip } from './AddStrip'

const MIN_SCALE = 0.2
const MAX_SCALE = 2.5

export function Plane({ link }: { link: EngineLink | null }) {
  const channels = useAppStore((s) => s.patch.channels)
  const savedPlane = useAppStore((s) => s.patch.plane)

  const surfaceRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(savedPlane.scale)
  const [pan, setPan] = useState({ x: savedPlane.panX, y: savedPlane.panY })
  const drag = useRef<{ px: number; py: number; panX: number; panY: number } | null>(null)

  const viewport = (): Viewport => {
    const el = surfaceRef.current
    return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 }
  }

  /**
   * Where a newly-created Strip should land: the centre of what you are looking
   * at, converted from screen to plane coordinates (plane = screen/scale − pan),
   * nudged by a small cascade so successive additions do not stack exactly.
   */
  const spawnAt = () => {
    const v = viewport()
    const n = channels.length
    const cascade = (n % 6) * 24
    return {
      x: Math.round(v.width / 2 / scale - pan.x - 170 + cascade),
      y: Math.round(v.height / 2 / scale - pan.y - 98 + cascade),
    }
  }

  const fit = () => {
    const p = fitToContent(
      channels.map((c) => c.cell),
      viewport(),
    )
    setScale(p.scale)
    setPan({ x: p.panX, y: p.panY })
  }

  // Frame the patch once on first mount so an opened session lands looking at
  // its strips rather than at an arbitrary corner.
  const framed = useRef(false)
  useLayoutEffect(() => {
    if (framed.current || channels.length === 0) return
    framed.current = true
    fit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels.length])

  // --- pan: drag the empty background, never a strip -----------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.plane-strip')) return // a control, not the canvas
    drag.current = { px: e.clientX, py: e.clientY, panX: pan.x, panY: pan.y }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    // Screen delta → plane delta is a division by scale (d_screen = d_pan·scale).
    setPan({ x: d.panX + (e.clientX - d.px) / scale, y: d.panY + (e.clientY - d.py) / scale })
  }
  const endDrag = (e: React.PointerEvent) => {
    drag.current = null
    ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
  }

  const applyZoom = (factor: number, screenX: number, screenY: number) => {
    const z = zoomAbout({ scale, panX: pan.x, panY: pan.y }, factor, screenX, screenY, MIN_SCALE, MAX_SCALE)
    setScale(z.scale)
    setPan({ x: z.panX, y: z.panY })
  }

  // --- zoom: wheel keeps the point under the cursor fixed ------------------
  const onWheel = (e: React.WheelEvent) => {
    const el = surfaceRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    applyZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - rect.left, e.clientY - rect.top)
  }

  const zoomAtCentre = (factor: number) => {
    const v = viewport()
    applyZoom(factor, v.width / 2, v.height / 2)
  }

  return (
    <div
      className="plane"
      ref={surfaceRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onWheel={onWheel}
    >
      <div
        className="plane-layer"
        style={{ transform: `scale(${scale}) translate(${pan.x}px, ${pan.y}px)` }}
      >
        {channels.map((ch, i) => (
          <Strip key={ch.key} channel={ch} index={i} link={link} scale={scale} />
        ))}
      </div>

      {channels.length === 0 && (
        <p className="plane-empty dim">No strips yet — add one with “+ strip”, bottom right.</p>
      )}

      <div className="plane-controls">
        <AddStrip link={link} spawnAt={spawnAt} />
        <button type="button" title="zoom out" onClick={() => zoomAtCentre(1 / 1.2)}>
          −
        </button>
        <span className="value" title="zoom">
          {Math.round(scale * 100)}%
        </span>
        <button type="button" title="zoom in" onClick={() => zoomAtCentre(1.2)}>
          +
        </button>
        <button
          type="button"
          title="reset to 100%"
          onClick={() => {
            setScale(1)
            setPan({ x: 0, y: 0 })
          }}
        >
          1×
        </button>
        <button type="button" title="fit all strips" onClick={fit}>
          fit
        </button>
      </div>
    </div>
  )
}
