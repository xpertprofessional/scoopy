import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "./controls.css";

/**
 * Secondary-click (right-click) menus — the app-wide home (CM-1).
 *
 * Mirrors the native menu system: `DraggableNumberBox` builds a BASE menu
 * ("Enter value…", MIDI learn, scene overrides) and appends a caller-supplied
 * `extraContextMenu` closure (DraggableNumberBox.swift:520). Web does the same
 * — DragBox owns the base, panels pass extras — so no panel needs menu
 * machinery of its own.
 *
 * Lives at App root rather than inside each control: a menu rendered deep in a
 * transformed/scrolled subtree can be clipped even at `position: fixed`, and
 * every panel is its own WKWebView (the menu cannot escape it — hence the
 * clamping below).
 */

/** One entry in a control's right-click menu. */
export type MenuItem =
  | {
      kind: "item";
      label: string;
      checked?: boolean;
      /** Optional colour chip (`#RRGGBB`) shown before the label — turns a plain
       *  item list into a swatch picker (the track colour menu). */
      swatch?: string;
      /** Rendered dimmed and inert (native `.disabled(…)`). */
      disabled?: boolean;
      onSelect: () => void;
    }
  /** Non-interactive readout (a status line, not an action) — dimmed, no hover,
   *  no click. A menu row that looks clickable and does nothing is a lie. */
  | { kind: "info"; label: string }
  | { kind: "sep" };

export type NumberEntryRequest = {
  x: number;
  y: number;
  seed: number;
  min?: number;
  max?: number;
  onCommit: (v: number) => void;
};

/** Trim a trailing ".0" so integral values seed cleanly (native `format`). */
export function formatEntrySeed(value: number): string {
  if (Math.round(value) === value) return String(Math.round(value));
  return value.toFixed(2);
}

/** Clamp a popup's top-left so it stays inside the panel's webview. */
export function clampToViewport(
  x: number,
  y: number,
  w: number,
  h: number,
  viewW: number,
  viewH: number,
  margin = 4,
): { x: number; y: number } {
  // Prefer flipping to the other side of the cursor (native menu behaviour);
  // fall back to shifting when neither side fits.
  const cx = x + w + margin > viewW ? Math.max(margin, x - w) : x;
  const cy = y + h + margin > viewH ? Math.max(margin, y - h) : y;
  return {
    x: Math.min(Math.max(margin, cx), Math.max(margin, viewW - w - margin)),
    y: Math.min(Math.max(margin, cy), Math.max(margin, viewH - h - margin)),
  };
}

/**
 * Cursor-positioned popup. Closes on select, on any outside pointer-down, or
 * on Escape. Presentational — the provider owns the state.
 */
/**
 * Should a window `pointerdown` dismiss the open menu? Only when it landed OUTSIDE it.
 *
 * THE BUG THIS EXISTS TO PREVENT: the menu used to close on *any* window pointerdown. But
 * `pointerdown` fires on mouse-DOWN and `click` fires on mouse-UP — so pressing a menu item
 * unmounted the menu before its own click could land, and `onSelect` never ran. Every item
 * in every menu in the app opened, looked correct, and did nothing. (`NumberEntry` right
 * below never had the bug: it stops its own pointerdown. The menu just forgot to.)
 *
 * Kept as a pure function precisely because that failure is invisible to a type-checker and
 * to an SSR render test — only the event ORDER expresses it.
 */
export function shouldDismissOnPointerDown(menu: Node | null, target: Node | null): boolean {
  if (!menu || !target) return true; // nothing to protect
  return !menu.contains(target);
}

export function ContextMenu({
  items,
  x,
  y,
  onClose,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(clampToViewport(x, y, r.width, r.height, window.innerWidth, window.innerHeight));
  }, [x, y, items]);

  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!shouldDismissOnPointerDown(ref.current, e.target as Node | null)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Defer so the opening right-click doesn't immediately close it.
    const id = window.setTimeout(() => {
      window.addEventListener("pointerdown", close);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="ds-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((it, k) =>
        it.kind === "sep" ? (
          <div key={k} className="ds-menu-sep" />
        ) : it.kind === "info" ? (
          <div key={k} className="ds-menu-info" role="presentation">
            <span className="ds-menu-check" />
            {it.label}
          </div>
        ) : (
          <button
            key={k}
            className="ds-menu-item"
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              it.onSelect();
              onClose();
            }}
          >
            <span className="ds-menu-check">{it.checked ? "✓" : ""}</span>
            {it.swatch && (
              <span className="ds-menu-swatch" style={{ background: it.swatch }} />
            )}
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

/**
 * Typed numeric entry (native `NumberEntryPopover`, DraggableNumberBox.swift:917):
 * seeded from the current value, clamped to the control's range, Enter/Set
 * commits, Escape closes. Non-numeric input closes without writing.
 */
export function NumberEntry({
  req,
  onClose,
}: {
  req: NumberEntryRequest;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(() => formatEntrySeed(req.seed));
  const [pos, setPos] = useState({ x: req.x, y: req.y });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(
      clampToViewport(req.x, req.y, r.width, r.height, window.innerWidth, window.innerHeight),
    );
    el.querySelector("input")?.focus();
  }, [req.x, req.y]);

  // Clicking away abandons the edit (native popover dismiss). The popover's own
  // pointerdown is stopped below, so only OUTSIDE clicks reach this.
  useEffect(() => {
    const id = window.setTimeout(() => window.addEventListener("pointerdown", onClose), 0);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener("pointerdown", onClose);
    };
  }, [onClose]);

  const commit = () => {
    const v = Number(text.trim());
    if (text.trim() === "" || Number.isNaN(v)) {
      onClose();
      return;
    }
    const lo = req.min ?? -Infinity;
    const hi = req.max ?? Infinity;
    req.onCommit(Math.min(Math.max(v, lo), hi));
    onClose();
  };

  return (
    <div
      ref={ref}
      className="ds-numentry"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="ds-numentry-row">
        <input
          className="ds-numentry-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            else if (e.key === "Escape") onClose();
            e.stopPropagation(); // never leak into the ö/ä focus lane
          }}
        />
        <button className="ds-numentry-set" onClick={commit}>
          Set
        </button>
      </div>
      {req.min !== undefined && req.max !== undefined && (
        <div className="ds-numentry-range">
          {formatEntrySeed(req.min)} … {formatEntrySeed(req.max)}
        </div>
      )}
    </div>
  );
}

type MenuApi = {
  openMenu: (items: MenuItem[], x: number, y: number) => void;
  openNumberEntry: (req: NumberEntryRequest) => void;
  closeMenu: () => void;
};

// No-op default: a control rendered outside the provider (render-smoke tests)
// must not throw — it simply has no menu.
const MenuCtx = createContext<MenuApi>({
  openMenu: () => {},
  openNumberEntry: () => {},
  closeMenu: () => {},
});

export function useContextMenu(): MenuApi {
  return useContext(MenuCtx);
}

/**
 * App-root menu host. One menu and one entry popover exist at a time, rendered
 * at the top of the tree so no scrolled/transformed ancestor can clip them.
 */
export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<{ items: MenuItem[]; x: number; y: number } | null>(null);
  const [entry, setEntry] = useState<NumberEntryRequest | null>(null);

  const openMenu = useCallback((items: MenuItem[], x: number, y: number) => {
    if (!items.length) return;
    setEntry(null);
    setMenu({ items, x, y });
  }, []);
  const openNumberEntry = useCallback((req: NumberEntryRequest) => {
    setMenu(null);
    setEntry(req);
  }, []);
  const closeMenu = useCallback(() => {
    setMenu(null);
    setEntry(null);
  }, []);

  // Stable identity: the callbacks never change, so opening a menu must not
  // re-render every DragBox subscribed to this context (the grid runs hot).
  const api = useMemo<MenuApi>(
    () => ({ openMenu, openNumberEntry, closeMenu }),
    [openMenu, openNumberEntry, closeMenu],
  );

  return (
    <MenuCtx.Provider value={api}>
      {children}
      {menu && (
        <ContextMenu
          items={menu.items}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
      {entry && <NumberEntry req={entry} onClose={() => setEntry(null)} />}
    </MenuCtx.Provider>
  );
}
