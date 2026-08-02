import type { ReactNode } from "react";
import { DragBox } from "./DragBox.tsx";
import type { MenuItem } from "./ContextMenu.tsx";
import "./controls.css";
import "./semantic.css";

/**
 * Shared control components — row layout B (inline single-row: label left,
 * control center, value right; DESIGN-SYSTEM.md §7). All styling comes
 * from token CSS vars; no component may hardcode a color/font/dimension.
 *
 * NOTE: GeoRange is the interim slider until the Phase 3 control library
 * lands GeoSlider+DragBox with the focus model (INTERACTION-MODEL.md).
 */

/** Layout-B parameter row: label · geometric bar · value readout. */
export function ParamRow(props: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  /**
   * Present but inert. A row that is meaningless in the current state must be
   * DISABLED, never conditionally rendered: on the plane a strip's rows are its
   * layout, and removing one changes the object's height, which invalidates the
   * saved arrangement of every strip around it (pd-strip-anatomy L2).
   */
  disabled?: boolean;
  /** "center" = bipolar fill, for a signed value like varispeed. */
  origin?: "left" | "center";
}) {
  return (
    <div className={`ds-row${props.disabled ? " ds-row-disabled" : ""}`}>
      <span className="ds-label">{props.label}</span>
      <GeoRange
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        origin={props.origin}
        disabled={props.disabled}
        onChange={props.onChange}
      />
      <span className="ds-value">{props.display}</span>
    </div>
  );
}

/**
 * Layout-B row with the full GeoSlider+DragBox pairing (the app's core
 * control idiom): slider = coarse gesture surface, DragBox = precise
 * drag + display + parameter-focus target arming ö/ä browsing.
 */
export function PairedParamRow(props: {
  id: string;
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  defaultValue?: number;
  onChange: (v: number) => void;
  /** Extra right-click items appended after the box's base menu. */
  menu?: MenuItem[];
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
      />
      <DragBox
        id={props.id}
        value={props.value}
        display={props.display}
        min={props.min}
        max={props.max}
        step={props.step}
        defaultValue={props.defaultValue}
        onChange={props.onChange}
        menu={props.menu}
      />
    </div>
  );
}

/** Layout-B field row: label left, arbitrary control right. */
export function FieldRow(props: { label: string; children: ReactNode }) {
  return (
    <div className="ds-row ds-field">
      <span className="ds-label">{props.label}</span>
      <span className="ds-control">{props.children}</span>
    </div>
  );
}

/**
 * Geometric filled-bar slider (click-to-jump; NO double-click reset).
 * `label`/`display` print INSIDE the bar (native GeoValueSlider /
 * MixerHorizontalFader parity) — preferred over loose label spans, which
 * caused two alignment regressions (P4-08b, P4-08c). Sizing rules target
 * the `.ds-geo` wrapper.
 */
export function GeoRange(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  label?: string;
  display?: string;
  /** "center" = bipolar crossfader/pan fill: empty at midpoint, fills
      toward either edge (native DJCrossfaderBar parity). */
  origin?: "left" | "center";
  /** Heavy-traffic slider: an invisible grab band --hit-slop-y above and below
      the painted bar (controls.css .ds-geo.ds-hot). */
  hot?: boolean;
  /** Present but inert — see ParamRow.disabled. */
  disabled?: boolean;
  /** Reset gesture (double-click), e.g. varispeed back to exactly 1.0. */
  onDoubleClick?: () => void;
  title?: string;
}) {
  const pct =
    ((props.value - props.min) / (props.max - props.min || 1)) * 100;
  const background =
    props.origin === "center"
      ? `linear-gradient(to right, var(--bg-raised) 0 ${Math.min(50, pct)}%, var(--fill) ${Math.min(50, pct)}% ${Math.max(50, pct)}%, var(--bg-raised) ${Math.max(50, pct)}% 100%)`
      : `linear-gradient(to right, var(--fill) ${pct}%, var(--bg-raised) ${pct}%)`;
  return (
    <span className={`ds-geo${props.hot ? " ds-hot" : ""}${props.disabled ? " ds-geo-disabled" : ""}`}>
      <input
        className="ds-range"
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        title={props.title}
        style={{ background }}
        onChange={(e) => props.onChange(Number(e.target.value))}
        onDoubleClick={props.onDoubleClick}
      />
      {props.label !== undefined && (
        <span className="ds-geo-label">{props.label}</span>
      )}
      {props.display !== undefined && (
        <span className="ds-geo-value">{props.display}</span>
      )}
    </span>
  );
}

export function Select(props: {
  value: string | number;
  options: readonly { value: string | number; label: string }[];
  /** Inert: the choice exists but cannot apply right now (say the reason in a title). */
  disabled?: boolean;
  /** ⚠️ THE TITLE THE LINE ABOVE ALREADY ASKED FOR. It said "say the reason in
   *  a title" and there was no prop to say it with, so every disabled Select in
   *  the tree was a dead end — DESIGN.md §6 is explicit that `disabled` with no
   *  `title` is exactly that. Added when S5's output picker needed to explain
   *  "this interface has only one stereo pair". */
  title?: string;
  onChange: (raw: string) => void;
}) {
  return (
    <select
      className="ds-select"
      value={props.value}
      title={props.title}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.target.value)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Button(props: {
  label: string;
  onClick: () => void;
  /** Right-click handler (CM-5) — buttons carry menus too, not just boxes. */
  onContextMenu?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  active?: boolean;
  /**
   * A latch whose `active` state carries extra weight. `"solo"` gives an engaged
   * button the accent glow of a MIX OVERRIDE — louder than an ordinary active
   * latch, because a solo silences every peer and an accidental one must be
   * findable at a glance (grid.css / controls.css `.tone-solo`).
   */
  tone?: "solo";
  /** Heavy-traffic button: claims --hit-slop of invisible clickable ground
      around the painted box (controls.css .ds-hot). */
  hot?: boolean;
  /** Tooltip — the web equivalent of SwiftUI `.help()`. */
  title?: string;
}) {
  return (
    <button
      className={`ds-button${props.active ? " active" : ""}${props.tone ? ` tone-${props.tone}` : ""}${props.hot ? " ds-hot" : ""}`}
      disabled={props.disabled}
      title={props.title}
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
    >
      {props.label}
    </button>
  );
}

export function Checkbox(props: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <input
      className="ds-checkbox"
      type="checkbox"
      checked={props.checked}
      onChange={(e) => props.onChange(e.target.checked)}
    />
  );
}

export function Stepper(props: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(Math.max(v, props.min), props.max);
  return (
    <span className="ds-stepper">
      <button onClick={() => props.onChange(clamp(props.value - 1))}>−</button>
      <span className="ds-value">{props.value}</span>
      <button onClick={() => props.onChange(clamp(props.value + 1))}>+</button>
    </span>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="ds-section">{children}</h2>;
}

export function PanelTitle({ children }: { children: ReactNode }) {
  return <h1 className="ds-display">{children}</h1>;
}

export function Caption({ children }: { children: ReactNode }) {
  return <p className="ds-caption">{children}</p>;
}
