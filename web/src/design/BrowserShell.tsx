import type { DragEvent, MouseEvent, ReactNode } from "react";
import "./browser.css";

/**
 * The browser chrome, shared by BOTH browsers (BR-4).
 *
 * ScoopyLoops has two of them — the compose SAMPLE browser (`FileBrowserPanel`)
 * and the DJ SESSION browser (`DjPanel`'s `SessionBrowser`) — and natively they
 * were literally one SwiftUI view with a `BrowserMode` enum. Keeping that as two
 * hand-styled rails in the web would let them drift apart for no reason, so the
 * fold rail, header, list frame and footer slot live here exactly once
 * (`one-control-one-home`, applied to chrome rather than to a control).
 *
 * What differs between the two is only what they put IN the slots:
 *
 *              compose                      DJ
 *   rows       folders + audio files        .scoopySession bundles (flat)
 *   trailing   —                            A / B / C deck buttons
 *   footer     audition: wave · ▶ · meter   preload progress
 *   header     sort · auto-play             refresh
 */
export function BrowserShell(props: {
  /** Rail label when collapsed, and the header title when open. */
  title: string;
  expanded: boolean;
  onExpandedChange: (v: boolean) => void;
  /** Header controls, right of the title (folder picker, sort, …). */
  actions?: ReactNode;
  /** Between the header and the list — breadcrumb, progress bar, notices. */
  banner?: ReactNode;
  /** The scrolling body. */
  children: ReactNode;
  /** Pinned below the list — the preview/preload area. */
  footer?: ReactNode;
  /** Collapsed-rail hint, e.g. the shortcut that opens it. */
  railTitle?: string;
  /**
   * The shell IS the page (the compose browser is its own WKWebView), so it
   * fills the frame instead of setting a width the host would disagree with.
   * Default false: a fixed rail inside a flex row, which is how the DJ page
   * mounts it beside the deck columns.
   */
  fill?: boolean;
}) {
  const { title, expanded, onExpandedChange } = props;

  if (!expanded) {
    return (
      <button
        className="br-rail mono"
        onClick={() => onExpandedChange(true)}
        title={props.railTitle ?? `Open ${title.toLowerCase()}`}
      >
        ‹ {title}
      </button>
    );
  }

  return (
    <aside className={`br${props.fill ? " fill" : ""}`} aria-label={title}>
      <header className="br-head">
        <button
          className="br-fold mono"
          onClick={() => onExpandedChange(false)}
          title="Collapse"
          aria-label="Collapse"
        >
          ›
        </button>
        <span className="br-title mono">{title}</span>
        <span className="br-actions">{props.actions}</span>
      </header>
      {props.banner}
      <div className="br-body">{props.children}</div>
      {props.footer && <div className="br-foot">{props.footer}</div>}
    </aside>
  );
}

/**
 * One row. `icon` is a single glyph rather than an icon font — the panel is a
 * dense list where a folder must be distinguishable from a file at a glance and
 * nothing more, and the design language is monochrome text (DESIGN-SYSTEM §2).
 */
export function BrowserRow(props: {
  name: string;
  icon: string;
  selected?: boolean;
  dim?: boolean;
  title?: string;
  onClick?: () => void;
  /** Gets the event: ⌥ on a double-click means "load as stretch". */
  onDoubleClick?: (e: MouseEvent) => void;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  /** Deck buttons (DJ), badges, … */
  trailing?: ReactNode;
}) {
  return (
    <li
      className={`br-row${props.selected ? " sel" : ""}${props.dim ? " dim" : ""}`}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      draggable={props.draggable}
      onDragStart={props.onDragStart}
      title={props.title ?? props.name}
    >
      <span className="br-icon mono" aria-hidden="true">
        {props.icon}
      </span>
      <span className="br-name mono">{props.name}</span>
      {props.trailing && <span className="br-trailing">{props.trailing}</span>}
    </li>
  );
}
