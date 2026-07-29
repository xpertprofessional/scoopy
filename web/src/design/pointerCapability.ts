// Pointer/host capability detection — the scoping mechanism every mobile rule
// hangs on. The CSS bundle is ONE global cascade shared with the mac WKWebView
// panels, and those webviews are narrow by design: a bare @media (max-width)
// would fire inside a mac panel. So responsive rules nest under
// `body.host-browser` and touch-size rules under `body.touch-capable`, and
// nothing else in the cascade can see them.
//
// JS callers use isCoarsePointer() for LAYOUT metrics (device class, stable)
// and e.pointerType === "touch" for PER-GESTURE behavior (hybrid-safe: a
// mouse plugged into an iPad behaves like a mouse).

export const HOST_BROWSER_CLASS = "host-browser";
export const TOUCH_CAPABLE_CLASS = "touch-capable";

let coarseQuery: MediaQueryList | null = null;

/** True when the primary pointer is coarse (finger). Cached query object;
 *  reads live so hybrid devices that flip (e.g. keyboard detached) stay true. */
export function isCoarsePointer(): boolean {
  // SSR-safe: the plane's deck tile renders GridPanel under the house
  // static-markup tests, where there is no window at all. No window means no
  // pointer, and "fine" is the desktop default the metrics tables assume.
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  if (!coarseQuery) coarseQuery = window.matchMedia("(pointer: coarse)");
  return coarseQuery.matches;
}

/** Stamp capability classes on <body> before first render. `hostBrowser` is
 *  the ?host=browser companion boot flag (main.tsx owns parsing it). The
 *  touch class re-stamps on media-query change (hybrid devices). */
export function installCapabilityClasses(hostBrowser: boolean): void {
  applyClasses(document.body, hostBrowser, isCoarsePointer());
  if (typeof window.matchMedia !== "function") return;
  coarseQuery ??= window.matchMedia("(pointer: coarse)");
  coarseQuery.addEventListener("change", (e) => {
    applyClasses(document.body, hostBrowser, e.matches);
  });
}

/** Pure core (unit-tested): toggles the two classes on the given element. */
export function applyClasses(el: Element, hostBrowser: boolean, coarse: boolean): void {
  el.classList.toggle(HOST_BROWSER_CLASS, hostBrowser);
  el.classList.toggle(TOUCH_CAPABLE_CLASS, coarse);
}
