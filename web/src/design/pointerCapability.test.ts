import { describe, expect, it } from "vitest";
import {
  applyClasses,
  HOST_BROWSER_CLASS,
  TOUCH_CAPABLE_CLASS,
} from "./pointerCapability.ts";

/**
 * The scoping contract: every mobile CSS rule in the bundle hangs off these two
 * body classes. The cascade is global across the mac WKWebView panels, so a
 * wrong stamp here would fire tablet layout inside a narrow mac panel — the
 * classes must track BOTH flags exactly, including removal on a hybrid flip.
 */
describe("capability class stamping", () => {
  // Minimal Element stand-in: classList.toggle(name, force) is all applyClasses uses.
  const el = () => {
    const set = new Set<string>();
    return {
      set,
      classList: {
        toggle: (name: string, force: boolean) => {
          if (force) set.add(name);
          else set.delete(name);
          return force;
        },
      },
    } as unknown as Element & { set: Set<string> };
  };

  it("stamps both classes for a coarse-pointer browser host", () => {
    const e = el();
    applyClasses(e, true, true);
    expect(e.set).toEqual(new Set([HOST_BROWSER_CLASS, TOUCH_CAPABLE_CLASS]));
  });

  it("stamps neither inside a mac WKWebView panel (fine pointer, no host flag)", () => {
    const e = el();
    applyClasses(e, false, false);
    expect(e.set.size).toBe(0);
  });

  it("browser host with a mouse gets host-browser only", () => {
    const e = el();
    applyClasses(e, true, false);
    expect(e.set).toEqual(new Set([HOST_BROWSER_CLASS]));
  });

  it("a hybrid flip re-stamp REMOVES touch-capable when the pointer turns fine", () => {
    const e = el();
    applyClasses(e, true, true);
    applyClasses(e, true, false);
    expect(e.set).toEqual(new Set([HOST_BROWSER_CLASS]));
  });
});
