/**
 * Shared control idiom — Layout B: label left · geometric bar centre · value
 * right (the suite's DESIGN-SYSTEM row). Adapted from ScoopyLoops'
 * `design/controls.tsx` to Wizard's token set, which is what D-WZ-DESIGN-01
 * deferred to the PD phase: P0 vendored the TOKEN core only and left the
 * interaction primitives app-local until the identity pass — this is that pass.
 *
 * Deliberately the row idiom only. Scoopy's DragBox + focus model + context
 * menus depend on machinery Wizard has no equivalent for yet; adopting the row
 * shape now gets the visual identity right without importing that surface.
 * Full DragBox parity is a later row.
 *
 * No component hardcodes a colour or a font — everything reads a token var.
 */

/**
 * The geometric bar: a range input painted with a gradient fill so the value is
 * legible as a SHAPE, not just a thumb position.
 * `origin="center"` gives the bipolar fill (empty at the midpoint, filling
 * toward either edge) that pan and signed varispeed want.
 */
export function GeoRange(props: {
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  onDoubleClick?: (() => void) | undefined
  title?: string | undefined
  /** 'center' = bipolar fill from the midpoint (pan, signed rate). */
  origin?: 'left' | 'center' | undefined
}) {
  const span = props.max - props.min || 1
  const pct = ((props.value - props.min) / span) * 100
  const lo = Math.min(50, pct)
  const hi = Math.max(50, pct)
  const background =
    props.origin === 'center'
      ? `linear-gradient(to right, var(--bg-raised) 0 ${lo}%, var(--accent) ${lo}% ${hi}%, var(--bg-raised) ${hi}% 100%)`
      : `linear-gradient(to right, var(--accent) ${pct}%, var(--bg-raised) ${pct}%)`
  return (
    <span className="ds-geo">
      <input
        className="ds-range"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        style={{ background }}
        title={props.title}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onDoubleClick={props.onDoubleClick}
      />
    </span>
  )
}

/** Layout-B parameter row: label · geometric bar · value readout. */
export function ParamRow(props: {
  label: string
  value: number
  display: string
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  onDoubleClick?: (() => void) | undefined
  title?: string | undefined
  origin?: 'left' | 'center' | undefined
}) {
  return (
    <div className="ds-row">
      <span className="ds-label">{props.label}</span>
      <GeoRange
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        onChange={props.onChange}
        onDoubleClick={props.onDoubleClick}
        title={props.title}
        origin={props.origin}
      />
      <span className="ds-value">{props.display}</span>
    </div>
  )
}
