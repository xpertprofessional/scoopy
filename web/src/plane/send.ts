/**
 * Fire-and-forget engine commands, safely.
 *
 * WHY THIS EXISTS. `void link.command(...)` looks harmless and is not: a
 * rejected promise with no handler becomes an `unhandledrejection`, and
 * `main.tsx` renders every one of those as a `<pre>` PREPENDED TO document.body.
 * A panel that issues a dozen commands against a host that answers none of them
 * therefore prepends a dozen blocks, pushes its own 100vh layout off the bottom
 * of the window, and looks catastrophically broken when the actual fault is one
 * missing method. That is exactly what the plane's first run-pass produced.
 *
 * So: nothing in the plane calls `command` without a handler. A refusal is
 * logged once, with the method that refused, and the UI carries on — which is
 * the honest behaviour, because the document is still true even when the engine
 * declined to follow it.
 */
import type { EngineLink } from '../engineLink.ts'

/** Methods already reported, so a control dragged for ten seconds against a
    host that cannot answer logs once rather than six hundred times. */
const reported = new Set<string>()

/**
 * WHO GETS TOLD (P3-U6). A console.error is invisible in the shipped app —
 * "no silent silence" (pd-merge §5) means a refusal must reach a surface the
 * user is looking at, and the plane's note line is that surface. Subscribers
 * get EVERY refusal (a note line is idempotent — the latest news simply
 * stands), while the console keeps its once-per-method damping.
 */
const refusalCbs = new Set<(method: string, message: string) => void>()

export function onRefusal(cb: (method: string, message: string) => void): () => void {
  refusalCbs.add(cb)
  return () => refusalCbs.delete(cb)
}

function report(method: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  refusalCbs.forEach((cb) => cb(method, message))
  if (reported.has(method)) return
  reported.add(method)
  console.error(`plane: ${method} refused —`, message)
}

export function send(link: EngineLink | null, method: string, params: unknown): void {
  if (!link) return
  void link.command(method as never, params).catch((err: unknown) => report(method, err))
}

/** The awaited form, for sequences whose ORDER matters (record start/stop).
    Returns null on refusal rather than throwing, so a caller can branch without
    a try/catch at every site. */
export async function ask<T = unknown>(
  link: EngineLink | null,
  method: string,
  params: unknown,
): Promise<T | null> {
  if (!link) return null
  try {
    return (await link.command(method as never, params)) as T
  } catch (err) {
    report(method, err)
    return null
  }
}

/** Test seam: forget what has been reported. */
export function resetSendReporting(): void {
  reported.clear()
}
